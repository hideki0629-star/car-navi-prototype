// 聞き取りと読み上げ（voice.js）の試験。端末の音声認識・読み上げは偽物に替える。
// 偽の音声認識は iPhoneのSafariと同じく、前の回が終わる前に次を始めると例外を出す。

import { Voice } from '../js/voice.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMING = { restartMs: 5, errorRetryMs: 40, abortWaitMs: 60, speakGuardMs: 300, speakPerCharMs: 0 };

function makeFakes() {
  const env = { sessions: [], running: 0, overlaps: 0, spoken: [], micDuringSpeech: 0, synthSpeaking: false };

  class FakeRecognition {
    constructor() {
      this.state = 'new';
      env.sessions.push(this);
    }
    start() {
      if (this.state !== 'new' || env.running > 0) {
        env.overlaps += 1;
        throw new Error('Recognition is being started or already started');
      }
      if (env.synthSpeaking) env.micDuringSpeech += 1;
      this.state = 'running';
      env.running += 1;
      setTimeout(() => this.onstart && this.onstart(), 0);
    }
    abort() {
      if (this.state !== 'running') return;
      setTimeout(() => this.finish('aborted'), 2);
    }
    // 試験から呼ぶ：この回を終わらせる（error を付けると、先に onerror を出す）
    finish(error) {
      if (this.state !== 'running') return;
      this.state = 'ended';
      env.running -= 1;
      if (error) this.onerror && this.onerror({ error });
      this.onend && this.onend();
    }
    say(text) {
      this.onresult && this.onresult({ results: [Object.assign([{ transcript: text }], { isFinal: true })] });
      this.finish();
    }
  }

  class FakeUtterance {
    constructor(text) { this.text = text; }
  }

  const synth = {
    get speaking() { return env.synthSpeaking; },
    getVoices: () => [],
    cancel() {},
    speak(u) {
      if (!u.text) return;
      env.spoken.push(u.text);
      env.synthSpeaking = true;
      setTimeout(() => {
        env.synthSpeaking = false;
        u.onend && u.onend();
      }, 20);
    },
  };

  env.current = () => env.sessions.filter((s) => s.state === 'running').pop() || null;
  return { env, FakeRecognition, FakeUtterance, synth };
}

function makeVoice(fakes, extra = {}) {
  const logs = [];
  const fatal = [];
  const heard = [];
  const voice = new Voice({
    onResult: (t) => heard.push(t),
    onFatal: (m) => fatal.push(m),
    onLog: (l) => logs.push(l),
    Recognition: fakes.FakeRecognition,
    synth: fakes.synth,
    Utterance: fakes.FakeUtterance,
    timing: TIMING,
    ...extra,
  });
  return { voice, logs, fatal, heard };
}

export async function voiceTests(check) {
  {
    const f = makeFakes();
    const { voice, heard } = makeVoice(f);
    voice.start();
    await wait(20);
    check('音声：開始で聞き取りが一つだけ始まる', [f.env.sessions.length, f.env.running], [1, 1]);
    f.env.current().say('〇〇駅までナビして');
    await wait(30);
    check('音声：聞き取れたら次の回を一つだけ始める', [heard, f.env.running, f.env.overlaps], [['〇〇駅までナビして'], 1, 0]);
  }
  {
    const f = makeFakes();
    const { voice, logs } = makeVoice(f);
    voice.start();
    await wait(20);
    const p = voice.speak('〇〇駅まで案内します。よろしいですか。');
    await wait(1);
    check('音声：読み上げの前に聞き取りを止める', f.env.synthSpeaking, false);
    await p;
    await wait(30);
    check('音声：読み上げ中にマイクを使わない', f.env.micDuringSpeech, 0);
    check('音声：読み上げのあと聞き取りを一つだけ再開', [f.env.running, f.env.overlaps], [1, 0]);
    check('音声：こちらから止めたときの aborted は記録しない', logs.filter((l) => l.includes('aborted')), []);
  }
  {
    const f = makeFakes();
    const { voice } = makeVoice(f);
    voice.start();
    await wait(20);
    // 読み上げが重なって呼ばれても、全部終わるまで聞き取りを始めない
    const a = voice.speak('一つ目');
    const b = voice.speak('二つ目');
    await Promise.all([a, b]);
    await wait(30);
    check('音声：読み上げが重なっても二重に始めない', [f.env.micDuringSpeech, f.env.overlaps, f.env.running], [0, 0, 1]);
  }
  {
    const f = makeFakes();
    const { voice, fatal, logs } = makeVoice(f);
    voice.start();
    await wait(20);
    f.env.current().finish('audio-capture');
    await wait(10);
    check('音声：audio-capture のあとは少し待つ', f.env.running, 0);
    await wait(60);
    check('音声：audio-capture のあと1回だけ再開', [f.env.running, fatal.length], [1, 0]);
    f.env.current().finish('audio-capture');
    await wait(80);
    check('音声：続けて失敗したら止めて知らせる', [f.env.running, fatal.length], [0, 1]);
    check('音声：エラーは記録に残す', logs.filter((l) => l.includes('audio-capture')).length, 2);
  }
  {
    const f = makeFakes();
    const { voice, fatal } = makeVoice(f);
    voice.start();
    await wait(20);
    f.env.current().finish('aborted');
    await wait(80);
    check('音声：思いがけない aborted のあと1回だけ再開', [f.env.running, fatal.length], [1, 0]);
    f.env.current().say('はい');
    await wait(20);
    f.env.current().finish('aborted');
    await wait(80);
    check('音声：聞き取れた後なら、再開の1回はもう一度使える', [f.env.running, fatal.length], [1, 0]);
  }
  {
    const f = makeFakes();
    const { voice, fatal } = makeVoice(f);
    voice.start();
    await wait(20);
    for (let i = 0; i < 5; i++) {
      f.env.current().finish('no-speech');
      await wait(20);
    }
    check('音声：黙っていても止まらずに聞き取りを続ける', [f.env.running, fatal.length, f.env.overlaps], [1, 0, 0]);
  }
  {
    const f = makeFakes();
    const { voice } = makeVoice(f);
    voice.start();
    await wait(20);
    const before = f.env.sessions.length;
    check('音声：裏に回っていないのに来た「表示」は無視', voice.setVisible(true), false);
    await wait(20);
    check('音声：無視したときは聞き取りをやり直さない', f.env.sessions.length, before);
    voice.setVisible(false);
    await wait(30);
    check('音声：裏に回ったら聞き取りを止める', f.env.running, 0);
    check('音声：本当に戻ったときは true', voice.setVisible(true), true);
    voice.setVisible(true);
    await wait(30);
    check('音声：戻ったら一つだけ再開', [f.env.running, f.env.overlaps], [1, 0]);
  }
  {
    const f = makeFakes();
    const { voice, fatal } = makeVoice(f);
    voice.start();
    await wait(20);
    f.env.current().finish('not-allowed');
    await wait(30);
    check('音声：マイクの許可が無いときは止めて知らせる', [f.env.running, fatal.length], [0, 1]);
  }
  {
    const f = makeFakes();
    const { voice } = makeVoice(f);
    voice.start();
    await wait(20);
    voice.stop();
    await wait(40);
    check('音声：停止したら再開しない', f.env.running, 0);
  }
}
