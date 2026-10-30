// 聞き取りと読み上げ（voice.js）の試験。端末の音声認識・読み上げは偽物に替える。
// 偽の音声認識は、iPhoneのSafariで見られた動きをまねる。
//   ・前の回が終わる前に次を始めると例外を出す（already started）。
//   ・requireGesture のとき、利用者の操作の外で作った部品は、onstart・onaudiostart は出しても
//     声を認識しない（4回目の試験で見られた症状）。
//   ・neverStart のとき、start() しても何の知らせも出さない。
// start()・abort() の呼び出しは env.calls に順番どおり残し、止める順序を確かめる。

import { Voice } from '../js/voice.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMING = { restartMs: 5, errorRetryMs: 40, abortWaitMs: 60, sessionMaxMs: 400, startTimeoutMs: 100, speakGuardMs: 300, speakPerCharMs: 0 };

function makeFakes() {
  const env = {
    instances: [], calls: [], active: null, overlaps: 0,
    silentAbort: false, requireGesture: false, inGesture: false, neverStart: false,
    spoken: [], micDuringSpeech: 0, synthSpeaking: false,
  };

  class FakeRecognition {
    constructor() {
      this.id = env.instances.length + 1;
      this.deaf = env.requireGesture && !env.inGesture; // 操作の外で作られた部品は声を認識しない
      this.state = 'idle';
      env.instances.push(this);
    }
    start() {
      env.calls.push({ op: 'start', id: this.id });
      if (this.state === 'running' || env.active) {
        env.overlaps += 1;
        throw new Error('Recognition is being started or already started');
      }
      if (env.synthSpeaking) env.micDuringSpeech += 1;
      this.state = 'running';
      env.active = this;
      if (env.neverStart) return; // 何の知らせも出さない
      setTimeout(() => {
        if (this.state !== 'running') return;
        this.onstart && this.onstart();
        this.onaudiostart && this.onaudiostart();
      }, 0);
    }
    abort() {
      env.calls.push({ op: 'abort', id: this.id });
      if (this.state !== 'running') return;
      if (env.silentAbort) {
        // iPhoneで起こりうる：マイクは離すが、onerror も onend も来ない
        this.state = 'idle';
        env.active = null;
        return;
      }
      // 止まるまでに少し時間がかかる（ブラウザはタイマーを4ミリ秒以上に切り上げることがあるため、それより長くする）
      setTimeout(() => this.finish('aborted'), 15);
    }
    // 試験から呼ぶ：この回を終わらせる（error を付けると、先に onerror を出す）
    finish(error) {
      if (this.state !== 'running') return;
      this.state = 'idle';
      env.active = null;
      if (error) this.onerror && this.onerror({ error });
      this.onend && this.onend();
    }
    // 試験から呼ぶ：エラーだけを出し、この回は終わらせない
    errorOnly(error) {
      this.onerror && this.onerror({ error });
    }
    // 試験から呼ぶ：話しかける。声を認識できない部品なら何も起きない
    say(text) {
      if (this.state !== 'running' || this.deaf) return;
      this.onspeechstart && this.onspeechstart();
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

  env.current = () => env.active;
  env.running = () => (env.active ? 1 : 0);
  env.ops = () => env.calls.map((c) => c.op);
  env.starts = () => env.calls.filter((c) => c.op === 'start').length;
  return { env, FakeRecognition, FakeUtterance, synth };
}

function makeVoice(fakes) {
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
  });
  return { voice, logs, fatal, heard };
}

// 開始ボタンの押下をまねる（この中で作った部品だけが声を認識する）
function tapStart(f, voice) {
  f.env.inGesture = true;
  const ready = voice.start();
  f.env.inGesture = false;
  return ready;
}

export async function voiceTests(check) {
  {
    // 4回目の試験の症状：読み上げのあとの聞き取りが、声を認識しなかった
    const f = makeFakes();
    f.env.requireGesture = true;
    const { voice, logs, heard } = makeVoice(f);
    const ready = tapStart(f, voice);
    check('音声：開始ボタンの処理の中で、その場で聞き取りを始める', f.env.starts(), 1);
    const ok = await ready;
    check('音声：開始は onstart を待ってから true で終わる', [ok, voice.recStarted], [true, true]);
    await voice.speak('開始しました。行き先を言ってください。');
    await wait(30);
    f.env.current().say('〇〇駅までナビして');
    await wait(30);
    check('音声：読み上げのあとの聞き取りでも、声を認識する', heard, ['〇〇駅までナビして']);
    check('音声：聞き取りの部品は、操作の中で作った一つを使い回す', [f.env.instances.length, f.env.instances[0].deaf], [1, false]);
    const kinds = ['start()', 'onstart', 'onaudiostart', 'onspeechstart', 'onresult（認識）: 〇〇駅までナビして', 'onend'];
    check('音声：知らせを回の番号つきで記録', kinds.map((k) => logs.some((l) => /^聞き取り#\d+ /.test(l) && l.includes(k))), kinds.map(() => true));
    voice.stop();
  }
  {
    // 止める順序：止めるのは「読み上げの前」の1回だけで、聞き取りの最中には止めない
    const f = makeFakes();
    const { voice, logs } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    await voice.speak('開始しました。行き先を言ってください。');
    await wait(30);
    f.env.current().say('〇〇駅までナビして');
    await wait(30);
    check('順序：start → 読み上げの前の abort → 再開の start → 次の回の start', f.env.ops(), ['start', 'abort', 'start', 'start']);
    const aborts = logs.filter((l) => l.includes('abort()'));
    check('順序：abort は読み上げの前の1回だけで、理由を記録', [aborts.length, aborts[0] && aborts[0].includes('abort()：読み上げの前（「開始しました')], [1, true]);
    const starts = logs.filter((l) => l.includes('start()：'));
    check('順序：start にも理由を記録', starts.map((l) => l.replace(/^聞き取り#\d+ start\(\)：/, '')), ['開始・再開ボタン', '読み上げのあとの再開', '前の回が終わったため']);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice, logs } = makeVoice(f);
    await tapStart(f, voice);
    await wait(300); // 上限（試験では400ミリ秒）より短い
    check('順序：聞き取りの最中は、何もしなければ止めない', [f.env.ops(), logs.some((l) => l.includes('abort()'))], [['start'], false]);
    voice.stop();
  }
  {
    // 読み上げが、エラーのあとのマイク解放と重なっても、abort を二重に呼ばない
    const f = makeFakes();
    const { voice, logs } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    f.env.current().errorOnly('audio-capture');
    const p = voice.speak('もう一度お願いします。');
    await p;
    check('順序：解放中の読み上げでは、abort を二重に呼ばない', [f.env.calls.filter((c) => c.op === 'abort').length, logs.some((l) => l.includes('すでに止めているため'))], [1, true]);
    voice.stop();
  }
  {
    // どこから止めても、記録に理由が残る
    const f = makeFakes();
    const { voice, logs } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    await voice.speak('一つ目');
    await wait(30);
    voice.setVisible(false);
    await wait(30);
    voice.setVisible(true);
    await wait(30);
    f.env.current().errorOnly('audio-capture');
    await wait(120);
    voice.stop();
    await wait(30);
    const reasons = logs.filter((l) => l.includes('abort()')).map((l) => l.replace(/^聞き取り#\d+ abort\(\)：/, '').replace(/（「.*$/, '').replace(/（.*$/, ''));
    check('理由：止めた場所がすべて記録される', reasons, ['読み上げの前', '画面が裏に回ったため', 'エラー', '停止ボタン']);
  }
  {
    const f = makeFakes();
    f.env.neverStart = true;
    const { voice, logs, fatal } = makeVoice(f);
    const ok = await tapStart(f, voice);
    check('音声：onstart が来なければ、開始は false で終わる', ok, false);
    await wait(300);
    check('音声：onstart が来ないときは記録して1回だけ取り直し、だめなら知らせる', [
      logs.filter((l) => l.includes('onstart が来ません')).length,
      f.env.starts(),
      fatal.length === 1 && fatal[0].includes('始まりません'),
    ], [2, 2, true]);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice, logs } = makeVoice(f);
    voice.start();
    voice.start();
    await wait(5);
    voice.start();
    await wait(20);
    check('音声：開始を何度呼んでも1回だけ', [f.env.starts(), f.env.running(), f.env.overlaps], [1, 1, 0]);
    check('音声：開始済みの呼び出しは記録して無視', logs.filter((l) => l.includes('開始済み')).length, 2);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice, logs, fatal } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    const first = f.env.current();
    first.errorOnly('audio-capture');
    await wait(30); // 解放（15ミリ秒）の後、取り直し（さらに40ミリ秒後）の前
    check('音声：audio-capture でマイクを解放する', [f.env.ops(), first.state, f.env.running()], [['start', 'abort'], 'idle', 0]);
    check('音声：解放のための aborted は「こちらから止めたもの」と記録', logs.filter((l) => l.includes('aborted') && !l.includes('こちらから止めたもの')), []);
    await wait(60);
    check('音声：解放のあと少し待って1回だけ取り直す（同じ部品で）', [f.env.running(), f.env.starts(), f.env.instances.length, fatal.length, f.env.overlaps], [1, 2, 1, 0, 0]);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice, fatal, logs } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    f.env.silentAbort = true;
    f.env.current().errorOnly('audio-capture');
    await wait(30);
    check('音声：終わりの知らせが来なくても、まだ取り直さない', f.env.starts(), 1);
    await wait(100);
    check('音声：終わりの知らせが来ないときも、上限のあと1回だけ取り直す', [f.env.running(), f.env.starts(), fatal.length, f.env.overlaps], [1, 2, 0, 0]);
    check('音声：打ち切ったときは部品を作り直したと記録', [f.env.instances.length, logs.some((l) => l.includes('部品を作り直す'))], [2, true]);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice, logs } = makeVoice(f);
    await tapStart(f, voice);
    await wait(450);
    check('音声：終わらない聞き取りは、理由を記録して取り直す', [f.env.running(), f.env.overlaps, logs.some((l) => l.includes('abort()：0秒たっても終わらないため') || l.includes('秒たっても終わらないため'))], [1, 0, true]);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice, heard } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    f.env.current().say('〇〇駅までナビして');
    await wait(30);
    check('音声：聞き取れたら次の回を一つだけ始める', [heard, f.env.running(), f.env.overlaps], [['〇〇駅までナビして'], 1, 0]);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    const p = voice.speak('〇〇駅まで案内します。よろしいですか。');
    await wait(1);
    check('音声：読み上げの前に聞き取りを止める', f.env.synthSpeaking, false);
    await p;
    await wait(30);
    check('音声：読み上げ中にマイクを使わない', f.env.micDuringSpeech, 0);
    check('音声：読み上げのあと聞き取りを一つだけ再開', [f.env.running(), f.env.overlaps], [1, 0]);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    // 読み上げが重なって呼ばれても、全部終わるまで聞き取りを始めない
    await Promise.all([voice.speak('一つ目'), voice.speak('二つ目')]);
    await wait(30);
    check('音声：読み上げが重なっても二重に始めない', [f.env.micDuringSpeech, f.env.overlaps, f.env.running()], [0, 0, 1]);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice, fatal, logs } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    f.env.current().finish('audio-capture');
    await wait(10);
    check('音声：audio-capture のあとは少し待つ', f.env.running(), 0);
    await wait(60);
    check('音声：audio-capture のあと1回だけ再開', [f.env.running(), fatal.length], [1, 0]);
    f.env.current().finish('audio-capture');
    await wait(80);
    check('音声：続けて失敗したら止めて知らせる', [f.env.running(), fatal.length], [0, 1]);
    check('音声：エラーは記録に残す', logs.filter((l) => l.includes('onerror: audio-capture')).length, 2);
  }
  {
    const f = makeFakes();
    const { voice, fatal } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    f.env.current().finish('aborted');
    await wait(80);
    check('音声：思いがけない aborted のあと1回だけ再開', [f.env.running(), fatal.length], [1, 0]);
    f.env.current().say('はい');
    await wait(20);
    f.env.current().finish('aborted');
    await wait(80);
    check('音声：聞き取れた後なら、再開の1回はもう一度使える', [f.env.running(), fatal.length], [1, 0]);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice, fatal } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    for (let i = 0; i < 5; i++) {
      f.env.current().finish('no-speech');
      await wait(20);
    }
    check('音声：黙っていても止まらずに聞き取りを続ける', [f.env.running(), fatal.length, f.env.overlaps], [1, 0, 0]);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    const before = f.env.starts();
    check('音声：裏に回っていないのに来た「表示」は無視', voice.setVisible(true), false);
    await wait(20);
    check('音声：無視したときは聞き取りをやり直さない', f.env.starts(), before);
    voice.setVisible(false);
    await wait(30);
    check('音声：裏に回ったら聞き取りを止める', f.env.running(), 0);
    check('音声：本当に戻ったときは true', voice.setVisible(true), true);
    voice.setVisible(true);
    await wait(30);
    check('音声：戻ったら一つだけ再開', [f.env.running(), f.env.overlaps], [1, 0]);
    voice.stop();
  }
  {
    const f = makeFakes();
    const { voice, fatal } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    f.env.current().finish('not-allowed');
    await wait(30);
    check('音声：マイクの許可が無いときは止めて知らせる', [f.env.running(), fatal.length], [0, 1]);
  }
  {
    const f = makeFakes();
    const { voice } = makeVoice(f);
    await tapStart(f, voice);
    await wait(20);
    voice.stop();
    await wait(40);
    check('音声：停止したら再開しない', f.env.running(), 0);
  }
}
