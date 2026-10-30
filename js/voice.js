// 音声認識と読み上げ。端末標準の機能（Web Speech API / SpeechSynthesis）だけを使う。
// 読み上げ中は聞き取りを止め、自分の声を指示と取り違えないようにする。
// 聞き取りが止まったら自動で再開し、続けて失敗したら onFatal で知らせる。

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const MAX_RESTART_FAILURES = 5;
const RESTART_DELAY_MS = 300;

export function isSupported() {
  return { recognition: !!Recognition, synthesis: 'speechSynthesis' in window };
}

export class Voice {
  constructor({ onResult, onStateChange, onFatal, onLog }) {
    this.onResult = onResult;
    this.onStateChange = onStateChange || (() => {});
    this.onFatal = onFatal || (() => {});
    this.onLog = onLog || (() => {});
    this.active = false;      // 開始ボタンが押されてから停止まで true
    this.speaking = false;
    this.listening = false;
    this.failures = 0;
    this.restartTimer = null;
    this.rec = null;
    this.voice = null;
  }

  // 開始ボタンの押下（利用者の操作）の中で呼ぶ。Safariは最初の再生・認識に操作が必要なため
  start() {
    this.active = true;
    this.failures = 0;
    this.pickVoice();
    // 読み上げの許可を得るため、操作の中で一度だけ空の読み上げをする
    try {
      const u = new SpeechSynthesisUtterance('');
      window.speechSynthesis.speak(u);
    } catch (e) { /* 読み上げが無い端末では何もしない */ }
    this.createRecognition();
    this.listen();
  }

  stop() {
    this.active = false;
    clearTimeout(this.restartTimer);
    try { this.rec && this.rec.abort(); } catch (e) { /* 止まっていれば何もしない */ }
    try { window.speechSynthesis.cancel(); } catch (e) { /* 同上 */ }
    this.setListening(false);
  }

  pickVoice() {
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    this.voice = voices.find((v) => v.lang === 'ja-JP') || voices.find((v) => v.lang.startsWith('ja')) || null;
    if (!this.voice && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => this.pickVoice();
    }
  }

  createRecognition() {
    if (!Recognition) return;
    const rec = new Recognition();
    rec.lang = 'ja-JP';
    // iPhone・iPadのSafariでは continuous が不安定なため、一回ごとに終わらせて再開する
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      if (!result || !result.isFinal) return;
      const text = result[0].transcript;
      this.failures = 0;
      this.onLog(`認識: ${text}`);
      this.onResult(text);
    };
    rec.onerror = (event) => {
      this.onLog(`認識エラー: ${event.error}`);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // マイクの許可が無い。自動では直せないため止める
        this.active = false;
        this.onFatal('マイクが使えません。設定でマイクを許可してから、もう一度開始してください。');
      }
      // no-speech・aborted・network などは onend で再開する
    };
    rec.onend = () => {
      this.setListening(false);
      this.scheduleRestart();
    };
    this.rec = rec;
  }

  listen() {
    if (!this.active || this.speaking || this.listening || !this.rec) return;
    try {
      this.rec.start();
      this.setListening(true);
    } catch (e) {
      this.onLog(`認識の開始に失敗: ${e.message}`);
      this.failures += 1;
      if (this.failures >= MAX_RESTART_FAILURES) {
        this.active = false;
        this.onFatal('聞き取りを再開できませんでした。停車してから、画面の再開ボタンを押してください。');
        return;
      }
      this.scheduleRestart();
    }
  }

  scheduleRestart() {
    clearTimeout(this.restartTimer);
    if (!this.active || this.speaking) return;
    this.restartTimer = setTimeout(() => this.listen(), RESTART_DELAY_MS);
  }

  // ほかのアプリから戻ったときなど、止まっている可能性があるときに呼ぶ
  resume() {
    if (!this.active) return;
    try { this.rec && this.rec.abort(); } catch (e) { /* 止まっていれば何もしない */ }
    this.setListening(false);
    this.scheduleRestart();
  }

  setListening(value) {
    this.listening = value;
    this.onStateChange({ listening: this.listening, speaking: this.speaking });
  }

  // 読み上げる。終わったら聞き取りを再開する。読み上げが終わると解決する Promise を返す
  speak(text) {
    this.onLog(`読み上げ: ${text}`);
    return new Promise((resolve) => {
      if (!window.speechSynthesis) { resolve(); return; }
      clearTimeout(this.restartTimer);
      this.speaking = true;
      try { this.rec && this.rec.abort(); } catch (e) { /* 止まっていれば何もしない */ }
      this.setListening(false);

      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      if (this.voice) u.voice = this.voice;
      u.rate = 1.05;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.speaking = false;
        this.setListening(false);
        this.scheduleRestart();
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;
      // onend が来ない端末があるため、文字数から見積もった時間で打ち切る
      setTimeout(finish, 2000 + text.length * 250);
      window.speechSynthesis.speak(u);
    });
  }
}
