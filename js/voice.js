// 音声認識と読み上げ。端末標準の機能（Web Speech API / SpeechSynthesis）だけを使う。
//
// 聞き取りの部品（SpeechRecognition）は、開始ボタンの操作の中で一つだけ作り、以後は使い回す。
//   iPhoneのSafariでは、操作の外で新しく作った部品は、マイクの音は入っても（onaudiostart）
//   声を認識しないとみられる（4回目の試験）。1回目の試験で聞き取れたのは、部品を使い回していたため。
// 最初の聞き取りも、開始ボタンの操作の中で直接始める（タイマーで後回しにしない）。
//
// 聞き取りの開始は startSession() の一か所だけで行い、二重に始めないようにする。
//   ・聞き取り中（start を呼んでから onend が来るまで）は、新しく始めない。
//   ・止めるときは abort し、onend が来るのを待ってから次の動作に移る。
//   ・止める（abort）・始める（start）ときは、必ず理由を記録に残す。
// 読み上げの間は聞き取りを止め、読み上げが終わってから再開する。
// aborted・audio-capture のときは、マイクの取得を一度解放し、少し待って1回だけ取り直す。
// 続けて失敗したら onFatal で知らせる（再開ボタンの操作の中でなら、部品を作り直して始められる）。
// 開始（start）は1回だけ。開始済みのときに呼ばれても無視する。
// 画面が裏に回ったら聞き取りを止め、本当に裏に回っていた場合だけ、戻ったときに再開する。
// 聞き取りの知らせ（onstart・onaudiostart・onspeechstart・onresult・onerror・onend）は、回の番号つきで記録する。

const DEFAULT_TIMING = {
  restartMs: 300,       // ふつうに終わったあと、次を始めるまで
  errorRetryMs: 1000,   // aborted・audio-capture のあと、再開するまで
  abortWaitMs: 1000,    // 止めてから onend が来るのを待つ上限
  sessionMaxMs: 20000,  // 一回の聞き取りがこれより長く終わらなければ、取り直す
  startTimeoutMs: 5000, // start() のあと、これまでに onstart が来なければ「始まらない」とみなす
  speakGuardMs: 4000,   // 読み上げの終わりの知らせが来ないときの見積もり（基本）
  speakPerCharMs: 400,  // 同（1文字あたり）
};

const RETRY_ONCE_ERRORS = ['aborted', 'audio-capture'];
const FATAL_ERRORS = ['not-allowed', 'service-not-allowed'];

export function isSupported() {
  return { recognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition), synthesis: 'speechSynthesis' in window };
}

function shorten(text, n = 20) {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

export class Voice {
  // Recognition・synth・Utterance・timing は試験で偽物に替えるためのもの。ふだんは省略する
  constructor({ onResult, onStateChange, onFatal, onLog, Recognition, synth, Utterance, timing } = {}) {
    this.onResult = onResult;
    this.onStateChange = onStateChange || (() => {});
    this.onFatal = onFatal || (() => {});
    this.onLog = onLog || (() => {});
    this.Recognition = Recognition || window.SpeechRecognition || window.webkitSpeechRecognition;
    this.synth = synth || window.speechSynthesis;
    this.Utterance = Utterance || window.SpeechSynthesisUtterance;
    this.t = { ...DEFAULT_TIMING, ...timing };

    this.active = false;     // 開始ボタンが押されてから停止まで true
    this.speakCount = 0;     // 読み上げ中の数（重なって呼ばれても、全部終わるまで聞き取りを止めておく）
    this.hidden = false;     // 画面が裏に回っている
    this.rec = null;         // 聞き取りの部品（開始ボタンの操作の中で作り、使い回す）
    this.session = null;     // 今の聞き取りの回（start してから onend まで。終われば null）
    this.errorRetried = false; // aborted・audio-capture の再開を1回使った
    this.timer = null;       // 次の開始の予定（常に一つだけ）
    this.timerReason = '';
    this.endWaiters = [];    // 聞き取りが止まるのを待っている処理
    this.seq = 0;            // 聞き取りの回の番号（記録用）
    this.firstStart = null;  // start() が返す Promise を、最初の onstart で解決する
    this.voice = null;
  }

  // 開始ボタン・再開ボタンの押下（利用者の操作）の中で、await の前に呼ぶ。
  // 最初の聞き取りが始まったら（onstart）true、始まらなければ false で解決する
  start() {
    if (this.active) {
      this.onLog('開始：開始済みのため無視');
      return Promise.resolve(false);
    }
    this.active = true;
    this.errorRetried = false;
    this.pickVoice();
    // 読み上げの許可を得るため、操作の中で一度だけ空の読み上げをする
    try { this.synth && this.synth.speak(new this.Utterance('')); } catch (e) { /* 読み上げが無い端末では何もしない */ }
    const ready = new Promise((resolve) => {
      this.firstStart = resolve;
      setTimeout(() => this.resolveFirstStart(false), this.t.startTimeoutMs + 100);
    });
    this.clearTimer();
    if (!this.session) {
      // 部品は操作の中で作る。前の回が残っているとき（停止の直後など）は、その部品のまま終わるのを待つ
      this.rec = this.createRecognizer();
      this.onLog('聞き取りの部品を作成（開始・再開ボタンの操作の中）');
      this.startSession('開始・再開ボタン'); // タイマーを使わず、操作の中で直接始める
    }
    if (!this.session) this.resolveFirstStart(false);
    return ready;
  }

  resolveFirstStart(ok) {
    const resolve = this.firstStart;
    this.firstStart = null;
    if (resolve) resolve(ok);
  }

  stop() {
    this.active = false;
    this.clearTimer();
    this.stopSession('停止ボタン');
    try { this.synth && this.synth.cancel(); } catch (e) { /* 止まっていれば何もしない */ }
    this.emitState();
  }

  pickVoice() {
    if (!this.synth || !this.synth.getVoices) return;
    const voices = this.synth.getVoices();
    this.voice = voices.find((v) => v.lang === 'ja-JP') || voices.find((v) => v.lang.startsWith('ja')) || null;
    if (!this.voice) this.synth.onvoiceschanged = () => this.pickVoice();
  }

  get listening() {
    return !!this.session;
  }

  get recStarted() {
    return !!(this.session && this.session.started);
  }

  get speaking() {
    return this.speakCount > 0;
  }

  canListen() {
    return this.active && !this.speaking && !this.hidden && !!this.rec;
  }

  emitState() {
    this.onStateChange({ listening: this.recStarted, speaking: this.speaking });
  }

  clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // 聞き取りの開始を予約する。delay 後に一回だけ始める（すでに予定があれば置き換える）
  requestListen(delay, reason) {
    this.clearTimer();
    if (!this.canListen()) return;
    this.timerReason = reason;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startSession(this.timerReason);
    }, delay);
  }

  // 聞き取りの部品を作り、知らせを受ける処理をつなぐ。知らせは今の回（session）にだけ使う
  createRecognizer() {
    const rec = new this.Recognition();
    rec.lang = 'ja-JP';
    // iPhone・iPadのSafariでは continuous が不安定なため、一回ごとに終わらせて再開する
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    // 今の回を返す。前の回（打ち切った回など）の知らせなら、記録だけして null を返す
    const current = (name) => {
      const s = this.session;
      if (s && s.rec === rec) return s;
      this.onLog(`聞き取り（前の回）${name}：今の回ではないため無視`);
      return null;
    };

    rec.onstart = () => {
      const s = current('onstart');
      if (!s) return;
      s.log('onstart（聞き取り開始）');
      clearTimeout(s.startTimer);
      s.started = true;
      this.emitState();
      this.resolveFirstStart(true);
    };
    rec.onaudiostart = () => {
      const s = current('onaudiostart');
      if (s) s.log('onaudiostart（マイクの音が入り始めた）');
    };
    rec.onspeechstart = () => {
      const s = current('onspeechstart');
      if (s) s.log('onspeechstart（声を検出）');
    };
    rec.onresult = (event) => {
      const s = current('onresult');
      if (!s) return;
      const result = event.results[event.results.length - 1];
      if (!result) {
        s.log('onresult（結果が空）');
        return;
      }
      const text = result[0] ? result[0].transcript : '';
      s.log(`onresult（認識${result.isFinal ? '' : '・途中'}）: ${text}`);
      if (!result.isFinal) return;
      this.errorRetried = false;
      this.onResult(text);
    };
    rec.onerror = (event) => {
      const s = current(`onerror: ${event.error}`);
      if (!s) return;
      const e = event.error;
      if (e === 'aborted' && (s.selfAbort || s.releasing)) {
        s.log(`onerror: aborted（こちらから止めたもの：${s.abortReason}）`);
        return;
      }
      if (e === 'no-speech') {
        s.log('onerror: no-speech（声が無かった）');
        return; // 黙っていただけ。ふつうに再開する
      }
      s.log(`onerror: ${e}`);
      if (!s.error) s.error = e; // 最初のエラーで次の動きを決める（後に続く aborted で上書きしない）
      if (RETRY_ONCE_ERRORS.includes(e) && !s.releasing && !s.selfAbort) {
        this.release(s, `エラー（${e}）のため、マイクを解放して取り直す`);
      }
    };
    rec.onend = () => {
      const s = current('onend');
      if (!s) return;
      s.log('onend（聞き取り終了）');
      this.endSession(s);
    };
    return rec;
  }

  // 聞き取りを始める唯一の入口
  startSession(reason) {
    if (!this.canListen() || this.session) return; // 聞き取り中なら始めない（終わったら onend から再開する）
    const id = ++this.seq;
    const s = {
      id,
      rec: this.rec,
      started: false,
      error: null,       // この回で最初に起きたエラー
      selfAbort: false,  // こちらから止めた（そのときの aborted は無視する）
      releasing: false,  // エラーなどのあと、こちらからマイクを解放している
      abortReason: '',
      timers: [],
      startTimer: null,
      log: (m) => this.onLog(`聞き取り#${id} ${m}`),
    };
    this.session = s;
    try {
      s.log(`start()：${reason}`);
      s.rec.start();
    } catch (e) {
      // 「すでに始まっている」などで始められなかった。この回は無かったことにして、少し待って1回だけやり直す
      this.session = null;
      s.log(`start() に失敗: ${e.message}`);
      this.afterSession('start-failed');
      return;
    }
    // start() のあと onstart が来なければ、始まらなかったとみなして1回だけ取り直す
    s.startTimer = setTimeout(() => {
      if (this.session !== s || s.started || s.releasing || s.selfAbort) return;
      s.log('onstart が来ません（聞き取りが始まりません）');
      if (!s.error) s.error = 'no-start';
      this.release(s, 'onstart が来ないため');
    }, this.t.startTimeoutMs);
    // 終わりの知らせが来ないまま止まった場合に備え、長すぎる回は取り直す
    s.timers.push(setTimeout(() => {
      if (this.session !== s || s.releasing || s.selfAbort) return;
      this.release(s, `${Math.round(this.t.sessionMaxMs / 1000)}秒たっても終わらないため`);
    }, this.t.sessionMaxMs));
  }

  // この回を終える（onend が来たとき、または来ないまま上限になったとき）
  endSession(s, forced = false) {
    if (this.session !== s) return;
    clearTimeout(s.startTimer);
    s.timers.forEach(clearTimeout);
    if (!s.started) this.resolveFirstStart(false);
    this.session = null;
    if (forced) {
      // 部品が止まったか分からないため作り直す（操作の外で作るので、声を拾えない恐れがある。記録で確かめる）
      s.log('onend が来ないため、この回を打ち切り、聞き取りの部品を作り直す');
      this.rec = this.createRecognizer();
    }
    this.emitState();
    this.endWaiters.splice(0).forEach((resolve) => resolve());
    this.afterSession(s.selfAbort ? null : s.error);
  }

  // 聞き取りを止めて、終わりの知らせを待つ。onend が来なくても上限で打ち切る
  abortSession(s, reason) {
    s.abortReason = reason;
    s.log(`abort()：${reason}`);
    try { s.rec.abort(); } catch (e) { /* すでに止まっていれば onend を待つ */ }
    s.timers.push(setTimeout(() => this.endSession(s, true), this.t.abortWaitMs));
  }

  // エラーなどのあと、マイクの取得を解放する（終わったら afterSession で1回だけ取り直す）
  release(s, reason) {
    s.releasing = true;
    this.abortSession(s, reason);
  }

  // 聞き取りを止め、止まるまで待つ（読み上げの前・停止・画面が裏に回ったとき）
  stopSession(reason) {
    this.clearTimer();
    const s = this.session;
    if (!s) return Promise.resolve();
    const done = new Promise((resolve) => this.endWaiters.push(resolve));
    if (!s.selfAbort && !s.releasing) {
      s.selfAbort = true;
      this.abortSession(s, reason);
    } else {
      s.log(`abort()：${reason}（すでに止めているため、終わるのを待つだけ）`);
    }
    return done;
  }

  // 聞き取りの一回が終わったあと、次をどうするか決める
  afterSession(error) {
    if (!this.active) return;
    if (FATAL_ERRORS.includes(error)) {
      // マイクの許可が無い。自動では直せないため止める
      this.active = false;
      this.clearTimer();
      this.onFatal('マイクが使えません。設定でマイクを許可してから、もう一度開始してください。');
      return;
    }
    if (error && (RETRY_ONCE_ERRORS.includes(error) || error === 'start-failed' || error === 'no-start')) {
      if (this.errorRetried) {
        this.active = false;
        this.clearTimer();
        this.resolveFirstStart(false);
        // 再開ボタンの押下は利用者の操作なので、その中でなら部品を作り直して始められる見込み
        this.onFatal(error === 'no-start'
          ? '聞き取りが始まりません。停車してから、画面の再開ボタンを押してください。'
          : '聞き取りを再開できませんでした。停車してから、画面の再開ボタンを押してください。');
        return;
      }
      this.errorRetried = true;
      this.requestListen(this.t.errorRetryMs, `エラー（${error}）のあとの取り直し（1回だけ）`);
      return;
    }
    // ふつうに終わった（黙っていた・聞き取れた・こちらから止めた・network など）
    if (!error) this.errorRetried = false;
    this.requestListen(this.t.restartMs, '前の回が終わったため');
  }

  // 画面が裏に回った・戻ったときに app.js から呼ぶ。戻ったら true を返す
  setVisible(visible) {
    if (!visible) {
      if (this.hidden) return false;
      this.hidden = true;
      this.stopSession('画面が裏に回ったため');
      return false;
    }
    if (!this.hidden) return false; // 裏に回っていないのに来た「表示」の知らせは無視する
    this.hidden = false;
    this.errorRetried = false;
    this.requestListen(this.t.restartMs, '画面に戻ったため');
    return true;
  }

  // 読み上げる。読み上げの間は聞き取りを止め、終わってから再開する。終わると解決する Promise を返す
  async speak(text) {
    this.onLog(`読み上げ: ${text}`);
    if (!this.synth) return;
    this.speakCount += 1;
    this.emitState();
    await this.stopSession(`読み上げの前（「${shorten(text)}」）`); // マイクを離してから話す（音声の取り合いを防ぐ）

    await new Promise((resolve) => {
      try { this.synth.cancel(); } catch (e) { /* 何もしない */ }
      const u = new this.Utterance(text);
      u.lang = 'ja-JP';
      if (this.voice) u.voice = this.voice;
      u.rate = 1.05;
      let done = false;
      let guard = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve();
      };
      // 終わりの知らせが来ない端末のための見積もり。まだ話していれば待ち続ける
      const check = () => {
        if (this.synth.speaking) guard = setTimeout(check, 1000);
        else finish();
      };
      u.onend = finish;
      u.onerror = finish;
      guard = setTimeout(check, this.t.speakGuardMs + text.length * this.t.speakPerCharMs);
      this.synth.speak(u);
    });

    this.speakCount -= 1;
    this.onLog(`読み上げ終了: 「${shorten(text)}」`);
    this.emitState();
    this.requestListen(this.t.restartMs, '読み上げのあとの再開');
  }
}
