// 端末内の音声 試作（画面側）。
//
// 「開始」を一度だけ押すと、音の再生とマイクが使えるようになり（iPhoneのSafariは画面に触れないと始められない）、
// 読み上げ → 聞き取り の順に準備して、あとは聞き取りがずっと続く。
//
// 聞き取り：sherpa-onnx（WebAssembly版）の VAD ＋ 音声認識。計算は asr-worker.js（Web Worker）で行う。
//   画面側はマイクの音を 16000 Hz にして約85ミリ秒ごとに Worker へ流し込み、途中の文字と最終の文字を表示する。
// 読み上げ：piper-plus（onnxruntime-web）と声のモデル「つくよみちゃん」。
//   声のモデルは公開ページに置かない（試験用。公開前に利用条件と商用利用の可否を Owner が相談する）。
//   配布元（Hugging Face の ayousanz/piper-plus-tsukuyomi-chan、版を固定）から自動で読み込み、端末のキャッシュに保存する。
//
// 外部への通信は、声のモデルのダウンロード（配布元の huggingface.co と *.hf.co）だけ。音声も文字も端末の外へは送らない。
// ページの Content-Security-Policy で、通信先を自分の公開ページと配布元に限っている。

const SAMPLE_RATE = 16000;
const RAW_AUDIO = new URLSearchParams(location.search).get('raw') === '1';
const FIXED_TEXT = '福岡駅まで案内します。';
const TTS_LENGTH_SCALE = 1.5; // 声のモデルの説明にある、自然な話す速さ（1.0 だと早口）
const RESUME_AFTER_PLAY_MS = 300; // 読み上げが終わってから聞き取りを再開するまで（自分の声の残りを聞き取らないため）

// 声のモデル（配布元の版を固定。読み込んだら SHA-256 を確かめる）
const VOICE_REVISION = '93c1fb6d67c29accc9ddf52326bb4582b1b52a3d';
const VOICE_BASE = `https://huggingface.co/ayousanz/piper-plus-tsukuyomi-chan/resolve/${VOICE_REVISION}/`;
const VOICE_FILES = {
  model: { name: 'tsukuyomi-chan-6lang-fp16.onnx', size: 39652717, sha256: '5289e9b6eaf21080803b7fe1c4dc85b5491d4c216121207a41df18dd5f68e5d7' },
  config: { name: 'config.json', size: 6901, sha256: '516058f405ec914140f34832a9d8bb5d8272ba62af9bc7ffb29349715a539780' },
};
const VOICE_CACHE = `speech-lab-tts-tsukuyomi-${VOICE_REVISION.slice(0, 7)}`;

const $ = (id) => document.getElementById(id);
const pageStart = performance.now();

// ---- 記録 ----
const logLines = [];
function clock(d = new Date()) {
  return d.toLocaleTimeString('ja-JP') + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function log(message, isError = false) {
  const line = `${clock()} ${isError ? '【エラー】' : ''}${message}`;
  logLines.unshift(line);
  const el = document.createElement('div');
  el.textContent = line;
  if (isError) el.className = 'ng';
  $('log').prepend(el);
  if (isError) console.error(message); else console.log(message);
}
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const sec = (ms) => `${(ms / 1000).toFixed(2)}秒`;
// エラーは全文を残す（種類・内容・スタック）
const errText = (e) => {
  if (!e) return String(e);
  const head = `${e.name || 'Error'}：${e.message || e}`;
  return e.stack ? `${head}\n${e.stack}` : head;
};

window.addEventListener('error', (e) => log(`${e.message}（${e.filename || ''}:${e.lineno || ''}:${e.colno || ''}）${e.error && e.error.stack ? '\n' + e.error.stack : ''}`, true));
window.addEventListener('unhandledrejection', (e) => log(errText(e.reason), true));

function simdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch (e) {
    return false;
  }
}
log(`ページを開きました：${navigator.userAgent}`);
log(`WebAssembly：${typeof WebAssembly === 'object' ? 'あり' : 'なし'}、SIMD：${simdSupported() ? 'あり' : 'なし（このページは動きません）'}、CPUの数：${navigator.hardwareConcurrency || '不明'}`);

// 前の版で声のモデルを保存していた場所は使わなくなったので消す（端末の容量を空けるため）
try {
  indexedDB.deleteDatabase('speech-lab');
} catch (e) { /* 使えなければ何もしない */ }

// ======================================================================
// 音（再生とマイクで一つの AudioContext を使う）
// ======================================================================

let ctx = null;
let mic = null; // { stream, source, processor }

function audioSessionText() {
  return navigator.audioSession ? navigator.audioSession.type : '（この端末では取得できない）';
}

// 「開始」の押下の中で呼ぶ。await より前に AudioContext と getUserMedia を呼ぶ
function startAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  ctx = new Ctx();
  const resumed = ctx.resume();
  // 無音を一瞬鳴らして、再生できる状態にしておく（iPhoneのSafariの決まり）
  const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
  const s = ctx.createBufferSource();
  s.buffer = silent;
  s.connect(ctx.destination);
  s.start();
  const processed = !RAW_AUDIO; // ?raw=1 で、ブラウザによる音の加工を切る（比べるため）
  const micPromise = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: processed, noiseSuppression: processed, autoGainControl: processed },
  });
  return { resumed, micPromise };
}

async function setupMic(micPromise) {
  const stream = await micPromise;
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = onMicAudio;
  source.connect(processor);
  processor.connect(ctx.destination); // つながっていないと onaudioprocess が来ない。出力は無音
  const track = stream.getAudioTracks()[0];
  const st = (track && track.getSettings) ? track.getSettings() : {};
  log(`マイクを使い始めました（音の速さ ${ctx.sampleRate} Hz、${(4096 / ctx.sampleRate * 1000).toFixed(0)} ミリ秒ごとに流し込む。音の加工：エコー除去=${st.echoCancellation}、雑音抑制=${st.noiseSuppression}、音量の自動調整=${st.autoGainControl}。音の使い方：${audioSessionText()}）`);
  mic = { stream, source, processor };
}

// 音を鳴らす。鳴らしている間は聞き取りを休む。開始と終了の時刻を記録に出す
let playing = false;
async function play(buffer, label) {
  if (ctx.state !== 'running') {
    log(`再生の準備：音の状態が「${ctx.state}」なので再開します`);
    await ctx.resume();
  }
  pauseListening();
  playing = true;
  try {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startedAt = new Date();
    await new Promise((resolve) => {
      src.onended = resolve;
      src.start();
      log(`${label} 開始：${clock(startedAt)}（音の長さ ${buffer.duration.toFixed(2)}秒、音の状態：${ctx.state}、音の使い方：${audioSessionText()}）。聞こえたか確かめてください`);
    });
    log(`${label} 終了：${clock()}（開始から ${sec(Date.now() - startedAt.getTime())}）`);
  } finally {
    playing = false;
    setTimeout(resumeListening, RESUME_AFTER_PLAY_MS);
  }
}

// 確認音（モデルを使わない。iPhone から音が出るかだけを確かめる）
function beepBuffer() {
  const dur = 0.5;
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.round(dur * rate), rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    const env = Math.min(1, t / 0.02, (dur - t) / 0.05); // 鳴り始めと終わりのぷつっという音を防ぐ
    d[i] = 0.4 * env * Math.sin(2 * Math.PI * 880 * t);
  }
  return buf;
}

// ======================================================================
// 聞き取り
// ======================================================================

let worker = null;
let asrReady = false;
let listening = false;
let readyResolve = null;
let readyReject = null;

function setAsrStatus(text) {
  $('asr-status').textContent = text;
}

function loadAsr() {
  return new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    worker = new Worker('asr-worker.js');
    worker.onerror = (e) => {
      log(`聞き取りの処理でエラー：${e.message || e}（${e.filename || ''}:${e.lineno || ''}）`, true);
      reject(new Error(e.message || '聞き取りの処理を起動できません'));
    };
    worker.onmessage = (e) => onWorkerMessage(e.data);
    worker.postMessage({ type: 'load' });
  });
}

function onWorkerMessage(msg) {
  if (msg.type === 'log') {
    log(msg.message, msg.error);
  } else if (msg.type === 'progress') {
    $('asr-progress').hidden = false;
    $('asr-progress').firstElementChild.style.width = `${(msg.loaded / msg.total * 100).toFixed(1)}%`;
    setAsrStatus(`聞き取りのモデルを読み込み中… ${mb(msg.loaded)} / ${mb(msg.total)}`);
  } else if (msg.type === 'ready') {
    $('asr-progress').hidden = true;
    readyResolve && readyResolve();
  } else if (msg.type === 'failed') {
    $('asr-progress').hidden = true;
    readyReject && readyReject(new Error(msg.message));
  } else if (msg.type === 'detected') {
    setAsrStatus('声を検出中…（話している途中の文字が出ます）');
    log('声を検出');
    $('result').classList.add('partial');
  } else if (msg.type === 'partial') {
    if (msg.text) $('result').textContent = msg.text;
    $('result').classList.add('partial');
    if (msg.firstTextMs !== null && msg.firstTextMs !== undefined) {
      log(`話し始めから最初の文字が出るまで：約 ${sec(msg.firstTextMs)}（途中の文字「${msg.text}」）`);
    }
    log(`途中の文字：「${msg.text}」（音 ${msg.audioSec.toFixed(2)}秒分を ${sec(msg.decodeMs)} で認識。次は ${msg.step.toFixed(2)}秒後）`);
  } else if (msg.type === 'final') {
    showFinal(msg);
  }
}

function onMicAudio(e) {
  if (!listening || !worker) return;
  const input = e.inputBuffer.getChannelData(0);
  const ratio = ctx.sampleRate / SAMPLE_RATE;
  let samples;
  if (ratio === 1) {
    samples = new Float32Array(input);
  } else {
    samples = new Float32Array(Math.round(input.length / ratio));
    let pos = 0;
    for (let i = 0; i < samples.length; i++) {
      const next = Math.round((i + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (; pos < next && pos < input.length; pos++) {
        sum += input[pos];
        count++;
      }
      samples[i] = count ? sum / count : 0;
    }
  }
  worker.postMessage({ type: 'audio', samples, capturedAt: Date.now() }, [samples.buffer]);
}

function resumeListening() {
  if (!asrReady || playing || listening) return;
  listening = true;
  worker.postMessage({ type: 'resume' });
  setAsrStatus('聞き取り中…話してください');
}

function pauseListening() {
  if (!listening) return;
  listening = false;
  worker.postMessage({ type: 'pause' });
  setAsrStatus('読み上げ中のため、聞き取りを休んでいます');
}

let lastHeard = '';
function showFinal(m) {
  setAsrStatus('聞き取り中…話してください');
  if (!m.text) {
    log(`最終の文字：言葉になりませんでした（話した長さ ${m.spokenSec.toFixed(2)}秒）`);
    return;
  }
  lastHeard = m.text;
  $('result').textContent = m.text;
  $('result').classList.remove('partial');
  $('metrics').textContent = '';
  const first = m.firstTextMs !== null && m.firstTextMs !== undefined ? `約 ${sec(m.firstTextMs)}${m.firstTextFromFinal ? '（途中の文字が出る前に話し終わったため、最終の文字で数えた）' : ''}` : '不明';
  const lines = [
    `話し始めから最初の文字が出るまで：${first}`,
    `話し終わってから最終の文字が確定するまで：約 ${sec(m.totalMs)}`,
    `内訳：話し終わりの判定待ち（無音 0.50秒）＋ 処理の待ち ${sec(m.waitMs)} ＋ 最終の認識の計算 ${sec(m.decodeMs)}`,
    `途中の文字：${m.partials}回、話した長さ：${m.spokenSec.toFixed(2)}秒`,
  ];
  for (const l of lines) {
    const div = document.createElement('div');
    div.textContent = l;
    $('metrics').append(div);
  }
  if (m.firstTextFromFinal) log(`話し始めから最初の文字が出るまで：${first}`);
  log(`最終の文字：「${m.text}」／ 話し終わり→確定 約 ${sec(m.totalMs)}（判定待ち 0.50秒 ＋ 待ち ${sec(m.waitMs)} ＋ 計算 ${sec(m.decodeMs)}）／ 途中の文字 ${m.partials}回 ／ 話した長さ ${m.spokenSec.toFixed(2)}秒`);
  $('tts-heard').disabled = !ttsReady;
}

// ======================================================================
// 読み上げ
// ======================================================================

let tts = null;
let ttsReady = false;
const voiceBlobs = {}; // 読み込んだ声のモデル（ページの中だけで持つ）

function setTtsStatus(text) {
  $('tts-status').textContent = text;
}

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 声のモデルを配布元から読み込む（2回目からは端末のキャッシュから）。大きさと SHA-256 を確かめる
async function loadVoiceFile(key, onBytes) {
  const f = VOICE_FILES[key];
  const url = VOICE_BASE + f.name;
  const started = performance.now();
  let cache = null;
  try {
    cache = await caches.open(VOICE_CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const blob = await hit.blob();
      if (blob.size === f.size) {
        onBytes(f.size);
        log(`読み上げ：キャッシュから：${f.name} ${mb(f.size)}（${sec(performance.now() - started)}）`);
        return blob;
      }
    }
  } catch (e) {
    log(`読み上げ：キャッシュが使えません（毎回ダウンロードします）：${errText(e)}`);
  }
  const res = await originalFetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`声のモデル ${f.name} を配布元から読み込めません（${res.status} ${res.statusText}）`);
  const data = new Uint8Array(f.size);
  const reader = res.body.getReader();
  let pos = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (pos + value.length > f.size) throw new Error(`声のモデル ${f.name} の大きさが想定と違います`);
    data.set(value, pos);
    pos += value.length;
    onBytes(value.length);
  }
  if (pos !== f.size) throw new Error(`声のモデル ${f.name} の大きさが想定と違います（${pos} / ${f.size} バイト）`);
  const ms = performance.now() - started;
  const hash = await sha256Hex(data);
  if (hash !== f.sha256) throw new Error(`声のモデル ${f.name} の中身が想定と違います（SHA-256 ${hash}）`);
  log(`読み上げ：ダウンロード（配布元から）：${f.name} ${mb(f.size)}（${sec(ms)}、${(f.size / 1e6 / (ms / 1000)).toFixed(1)} MB/秒。SHA-256 一致）`);
  const blob = new Blob([data], { type: key === 'model' ? 'application/octet-stream' : 'application/json' });
  if (cache) cache.put(url, new Response(blob)).catch((e) => log(`読み上げ：キャッシュへの保存に失敗：${errText(e)}`));
  return blob;
}

// piper-plus は声のモデルを「http(s) のアドレス」で受け取る。仮のアドレスへの読み込みを、読み込み済みのモデルにつなぎかえる。
// 部品の大きなファイル（.wasm）の読み込みは、大きさと時間を記録に出す
const LOCAL_MODEL_URL = new URL('local-tts-model/tsukuyomi.onnx', location.href).href;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
  if (url === LOCAL_MODEL_URL) return new Response(voiceBlobs.model, { status: 200 });
  if (url === LOCAL_MODEL_URL + '.json') return new Response(voiceBlobs.config, { status: 200, headers: { 'Content-Type': 'application/json' } });
  const started = performance.now();
  const res = await originalFetch(input, init);
  if (/\.wasm(\?|$)/.test(url) && res.ok) {
    const buf = await res.arrayBuffer();
    log(`読み上げ：ダウンロード：${url.replace(/^.*\/speech-lab\//, '')} ${mb(buf.byteLength)}（${sec(performance.now() - started)}）`);
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  return res;
};

async function loadTts() {
  const started = performance.now();
  setTtsStatus('読み上げの準備中…');
  // 1. 声のモデル（配布元から）
  const total = VOICE_FILES.model.size + VOICE_FILES.config.size;
  log(`読み上げ：声のモデルのダウンロード量 ${mb(total)}（配布元：Hugging Face ayousanz/piper-plus-tsukuyomi-chan、版 ${VOICE_REVISION.slice(0, 7)}）`);
  let loaded = 0;
  const onBytes = (n) => {
    loaded += n;
    $('tts-progress').hidden = false;
    $('tts-progress').firstElementChild.style.width = `${(loaded / total * 100).toFixed(1)}%`;
    setTtsStatus(`声のモデルを読み込み中… ${mb(loaded)} / ${mb(total)}`);
  };
  voiceBlobs.config = await loadVoiceFile('config', onBytes);
  voiceBlobs.model = await loadVoiceFile('model', onBytes);
  $('tts-progress').hidden = true;
  const voiceLoaded = performance.now();
  log(`読み上げ：声のモデルの読み込み ${sec(voiceLoaded - started)}`);

  // 2. 部品（このページから。初回 約75 MB）
  setTtsStatus('読み上げの部品（日本語の辞書など 約75 MB）を準備中…');
  const ort = await import('./vendor/onnxruntime-web/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = new URL('vendor/onnxruntime-web/', location.href).href;
  ort.env.wasm.numThreads = 1; // 公開ページは複数スレッドを使えない設定（crossOriginIsolated でない）
  const { PiperPlus } = await import('./vendor/piper-plus/src/index.js');
  const initStarted = performance.now();
  const instance = await PiperPlus.initialize({
    model: LOCAL_MODEL_URL,
    ort,
    wasmG2pUrl: new URL('vendor/piper-plus/dist/rust-wasm/piper_plus_wasm.js', location.href).href,
    onProgress: ({ stage, message }) => log(`読み上げ：準備（${stage}）：${message}`),
  });
  log(`読み上げ：部品と声のモデルの準備 ${sec(performance.now() - initStarted)}（読み上げの準備 合計 ${sec(performance.now() - started)}）`);
  return instance;
}

let ttsBusy = false;
async function speak(text, label) {
  if (ttsBusy) return;
  if (!ttsReady) {
    log(`${label}：読み上げの準備がまだ終わっていません`, true);
    return;
  }
  ttsBusy = true;
  setButtons();
  try {
    setTtsStatus(`声を作っています…「${text}」`);
    const synthStarted = performance.now();
    const result = await tts.synthesize(text, { language: 'ja', lengthScale: TTS_LENGTH_SCALE });
    const synthMs = performance.now() - synthStarted;
    // 作った音が無音でないかを数字で確かめる（聞こえないとき、声が作れていないのか、再生されていないのかを見分ける）
    let peak = 0;
    let sum = 0;
    for (const v of result.samples) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, result.samples.length));
    log(`${label}：声を作りました「${text}」（${sec(synthMs)}、音の長さ ${result.duration.toFixed(2)}秒、${result.sampleRate} Hz、音の大きさ 最大 ${peak.toFixed(2)}・平均 ${rms.toFixed(3)}${peak < 0.01 ? '：ほぼ無音です' : ''}）`);
    const buffer = ctx.createBuffer(1, result.samples.length, result.sampleRate);
    buffer.copyToChannel(result.samples, 0);
    setTtsStatus(`読み上げ中…「${text}」`);
    await play(buffer, `${label} 読み上げ`);
    setTtsStatus('読み上げが終わりました');
  } catch (e) {
    setTtsStatus('読み上げに失敗しました。記録を見てください');
    log(`${label}：${errText(e)}`, true);
  } finally {
    ttsBusy = false;
    setButtons();
  }
}

function setButtons() {
  $('beep').disabled = !ctx;
  $('tts-fixed').disabled = !ttsReady || ttsBusy;
  $('tts-heard').disabled = !ttsReady || ttsBusy || !lastHeard;
}

// ======================================================================
// ボタン
// ======================================================================

let started = false;
$('start').addEventListener('click', async () => {
  if (started) return;
  started = true;
  $('start').hidden = true;
  $('main').hidden = false;
  log(`開始：${clock()}。音の使い方：${audioSessionText()}`);
  let micPromise;
  try {
    const a = startAudio(); // 押下の中で、await より前に呼ぶ
    micPromise = a.micPromise;
    micPromise.catch(() => {}); // 失敗は下で記録する
    await a.resumed;
    log(`再生の準備ができました（音の状態：${ctx.state}、音の速さ ${ctx.sampleRate} Hz）`);
  } catch (e) {
    log(`再生の準備に失敗：${errText(e)}`, true);
  }
  setButtons();

  try {
    await setupMic(micPromise);
  } catch (e) {
    log(`マイクを使えません：${errText(e)}`, true);
    if (e && e.name === 'NotAllowedError') log('マイクの使用が許可されていません。設定でマイクを許可してください', true);
    setAsrStatus('マイクを使えません（読み上げの試験はできます）');
  }

  // 今日いちばん確かめたいのは「音が出るか」なので、読み上げを先に準備する
  try {
    tts = await loadTts();
    ttsReady = true;
    setTtsStatus('読み上げの準備ができました。ボタンを押してください');
    log('読み上げの準備ができました（読み上げのボタンが押せます）');
  } catch (e) {
    $('tts-progress').hidden = true;
    setTtsStatus('読み上げの準備に失敗しました。記録を見てください');
    log(`読み上げの準備：${errText(e)}`, true);
  }
  setButtons();

  if (!mic) return;
  try {
    setAsrStatus('聞き取りのモデルを読み込み中…');
    const asrStarted = performance.now();
    await loadAsr();
    asrReady = true;
    log(`聞き取り：読み込みと準備にかかった時間 ${sec(performance.now() - asrStarted)}`);
    if (ctx.state !== 'running') await ctx.resume();
    resumeListening();
    log('聞き取りを始めました（このあとはずっと聞き取ります）');
  } catch (e) {
    $('asr-progress').hidden = true;
    setAsrStatus('聞き取りの準備に失敗しました。記録を見てください');
    log(`聞き取りの準備：${errText(e)}`, true);
  }
});

$('beep').addEventListener('click', async () => {
  try {
    await play(beepBuffer(), '確認音');
  } catch (e) {
    log(`確認音：${errText(e)}`, true);
  }
});

$('tts-fixed').addEventListener('click', () => speak(FIXED_TEXT, '固定文'));
$('tts-heard').addEventListener('click', () => {
  const text = lastHeard || $('result').textContent.trim();
  if (!text || text === '―') {
    log('聞き取った文字がまだありません', true);
    return;
  }
  speak(text, '聞き取った文字');
});

$('copy').addEventListener('click', async () => {
  const text = logLines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  log('記録をコピーしました');
});

log(`準備ができました（ページの読み込み ${sec(performance.now() - pageStart)}）。「開始」を押してください`);
