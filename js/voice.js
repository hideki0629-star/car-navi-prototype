// 音声認識と読み上げ。端末標準の機能（Web Speech API / SpeechSynthesis）だけを使う。
//
// 聞き取りの開始は requestListen() の一か所だけで行い、二重に始めないようにする。
//   ・聞き取り中（start を呼んでから onend が来るまで）は、新しく始めない。
//   ・止めるときは abort し、onend が来るのを待ってから次の動作に移る。
//   ・聞き取りは一回ごとに新しく作り、前の回の知らせ（onend など）は無視する。
// 読み上げの間は聞き取りを止め、読み上げが終わってから再開する。
// aborted・audio-capture のときは、マイクの取得を一度解放し（abort して、その回を捨てる）、
// 少し待って1回だけ取り直す。続けて失敗したら onFatal で知らせる。
// 開始（start）は1回だけ。開始済みのときに呼ばれても無視する。
// 最初の聞き取りは、開始ボタンの操作の中で直接始める（iPhoneのSafariは、操作の外では
// マイクを使い始められないとみられるため。タイマーで後回しにすると聞き取りが一度も始まらなかった）。
// 聞き取りの知らせ（onstart・onaudiostart・onspeechstart・onresult・onerror・onend）は、回の番号つきで記録する。
// 画面が裏に回ったら聞き取りを止め、本当に裏に回っていた場合だけ、戻ったときに再開する。

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
    this.rec = null;         // 今の聞き取り（start してから onend まで。終われば null）
    this.recStarted = false; // onstart が来た
    this.selfAbort = false;  // こちらから止めた（そのときの aborted は無視する）
    this.errorRetried = false; // aborted・audio-capture の再開を1回使った
    this.timer = null;       // 次の開始の予定（常に一つだけ）
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
    this.startSession(); // タイマーを使わず、操作の中で直接始める
    if (!this.rec) this.resolveFirstStart(false);
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
    this.abortCurrent();
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
    return !!this.rec;
  }

  get speaking() {
    return this.speakCount > 0;
  }

  canListen() {
    return this.active && !this.speaking && !this.hidden && !!this.Recognition;
  }

  emitState() {
    this.onStateChange({ listening: this.listening && this.recStarted, speaking: this.speaking });
  }

  clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // 聞き取りを始める唯一の入口。delay 後に一回だけ始める（すでに予定があれば置き換える）
  requestListen(delay = this.t.restartMs) {
    this.clearTimer();
    if (!this.canListen()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startSession();
    }, delay);
  }

  startSession() {
    if (!this.canListen() || this.rec) return; // 聞き取り中なら始めない（終わったら onend から再開する）
    const rec = new this.Recognition();
    rec.lang = 'ja-JP';
    // iPhone・iPadのSafariでは continuous が不安定なため、一回ごとに終わらせて再開する
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let error = null;        // この回で最初に起きたエラー
    let releasing = false;   // エラーのあと、こちらからマイクを解放している
    let releaseTimer = null;
    let maxTimer = null;
    let startTimer = null;
    const id = ++this.seq;
    const log = (m) => this.onLog(`聞き取り#${id} ${m}`);

    // この回を終える（onend が来たとき、または来ないまま上限になったとき）
    const endSession = () => {
      if (rec !== this.rec) return;
      clearTimeout(releaseTimer);
      clearTimeout(maxTimer);
      clearTimeout(startTimer);
      if (!this.recStarted) this.resolveFirstStart(false);
      const wasSelfAbort = this.selfAbort;
      this.rec = null;
      this.recStarted = false;
      this.selfAbort = false;
      this.emitState();
      this.endWaiters.splice(0).forEach((resolve) => resolve());
      this.afterSession(wasSelfAbort ? null : error);
    };

    // マイクの取得を解放する：abort して、onend が来なくても上限でこの回を捨てる
    const release = () => {
      releasing = true;
      try { rec.abort(); } catch (e) { /* すでに止まっていれば onend を待つ */ }
      releaseTimer = setTimeout(() => {
        if (rec === this.rec) log('onend が来ないため、この回を打ち切り');
        endSession();
      }, this.t.abortWaitMs);
    };

    rec.onstart = () => {
      if (rec !== this.rec) return;
      log('onstart（聞き取り開始）');
      clearTimeout(startTimer);
      this.recStarted = true;
      this.emitState();
      this.resolveFirstStart(true);
    };
    rec.onaudiostart = () => {
      if (rec === this.rec) log('onaudiostart（マイクの音が入り始めた）');
    };
    rec.onspeechstart = () => {
      if (rec === this.rec) log('onspeechstart（声を検出）');
    };
    rec.onresult = (event) => {
      if (rec !== this.rec) return;
      const result = event.results[event.results.length - 1];
      if (!result) {
        log('onresult（結果が空）');
        return;
      }
      const text = result[0] ? result[0].transcript : '';
      log(`onresult（認識${result.isFinal ? '' : '・途中'}）: ${text}`);
      if (!result.isFinal) return;
      this.errorRetried = false;
      this.onResult(text);
    };
    rec.onerror = (event) => {
      if (rec !== this.rec) return;
      const e = event.error;
      if (e === 'aborted' && (this.selfAbort || releasing)) {
        log('onerror: aborted（こちらから止めたもの）');
        return;
      }
      if (e === 'no-speech') {
        log('onerror: no-speech（声が無かった）');
        return; // 黙っていただけ。ふつうに再開する
      }
      log(`onerror: ${e}`);
      if (!error) error = e; // 最初のエラーで次の動きを決める（後に続く aborted で上書きしない）
      if (RETRY_ONCE_ERRORS.includes(e) && !releasing && !this.selfAbort) {
        log('マイクを解放して、少し待って取り直します');
        release();
      }
    };
    rec.onend = () => {
      if (rec === this.rec) log('onend（聞き取り終了）');
      endSession();
    };

    this.rec = rec;
    this.selfAbort = false;
    try {
      log('start()');
      rec.start();
      // start() のあと onstart が来なければ、始まらなかったとみなして1回だけ取り直す
      startTimer = setTimeout(() => {
        if (rec !== this.rec || this.recStarted || releasing || this.selfAbort) return;
        log('onstart が来ません（聞き取りが始まりません）');
        if (!error) error = 'no-start';
        release();
      }, this.t.startTimeoutMs);
      // 終わりの知らせが来ないまま止まった場合に備え、長すぎる回は取り直す
      maxTimer = setTimeout(() => {
        if (rec !== this.rec || releasing || this.selfAbort) return;
        this.onLog('聞き取りが終わらないため、取り直します');
        release();
      }, this.t.sessionMaxMs);
    } catch (e) {
      // 「すでに始まっている」などで始められなかった。この回は無かったことにして、少し待って1回だけやり直す
      this.rec = null;
      log(`start() に失敗: ${e.message}`);
      this.afterSession('start-failed');
    }
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
        // 再開ボタンの押下は利用者の操作なので、その中でなら聞き取りを始められる見込み
        this.onFatal(error === 'no-start'
          ? '聞き取りが始まりません。停車してから、画面の再開ボタンを押してください。'
          : '聞き取りを再開できませんでした。停車してから、画面の再開ボタンを押してください。');
        return;
      }
      this.errorRetried = true;
      this.requestListen(this.t.errorRetryMs);
      return;
    }
    // ふつうに終わった（黙っていた・聞き取れた・network など）
    if (!error) this.errorRetried = false;
    this.requestListen(this.t.restartMs);
  }

  // 今の聞き取りを止め、止まるまで待つ（onend が来ない端末のため上限つき）
  abortCurrent() {
    this.clearTimer();
    if (!this.rec) return Promise.resolve();
    const rec = this.rec;
    const done = new Promise((resolve) => {
      this.endWaiters.push(resolve);
      setTimeout(() => {
        // onend が来ないまま上限になった。この回は終わったものとして扱う
        if (this.rec === rec) {
          this.rec = null;
          this.recStarted = false;
          this.selfAbort = false;
          this.emitState();
          this.endWaiters.splice(0).forEach((r) => r());
        }
        resolve();
      }, this.t.abortWaitMs);
    });
    this.selfAbort = true;
    try { rec.abort(); } catch (e) { /* すでに止まっていれば onend を待つ */ }
    return done;
  }

  // 画面が裏に回った・戻ったときに app.js から呼ぶ。戻ったら true を返す
  setVisible(visible) {
    if (!visible) {
      this.hidden = true;
      this.abortCurrent();
      return false;
    }
    if (!this.hidden) return false; // 裏に回っていないのに来た「表示」の知らせは無視する
    this.hidden = false;
    this.errorRetried = false;
    this.requestListen(this.t.restartMs);
    return true;
  }

  // 読み上げる。読み上げの間は聞き取りを止め、終わってから再開する。終わると解決する Promise を返す
  async speak(text) {
    this.onLog(`読み上げ: ${text}`);
    if (!this.synth) return;
    this.speakCount += 1;
    this.emitState();
    await this.abortCurrent(); // マイクを離してから話す（音声の取り合いを防ぐ）

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
    this.emitState();
    this.requestListen(this.t.restartMs);
  }
}
