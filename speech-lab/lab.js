// 端末内の音声認識・読み上げの試作（画面側）。
//
// 聞き取り：sherpa-onnx（WebAssembly版）の VAD ＋ 音声認識。計算は asr-worker.js（Web Worker）で行う。
//   画面側はマイクの音を 16000 Hz にして少しずつ Worker へ流し込み、途中の文字と最終の文字を表示する。
// 読み上げ：piper-plus（onnxruntime-web）と声のモデル「つくよみちゃん」。
//   声のモデルは公開ページに置かない（試験用）。この端末に保存したファイルを選んでもらい、ブラウザ内（IndexedDB）に保存して使う。
//
// 外部のAPIやサービスは使わない。部品はすべてこのページと同じ場所から読み込む。
// 音声も文字も端末の外へは送らない（ページの Content-Security-Policy で、自分の公開ページ以外との通信を禁止している）。

const SAMPLE_RATE = 16000;
const LISTEN_TIMEOUT_MS = 15000; // 声が無いまま、これだけたったら聞き取りをやめる
const RAW_AUDIO = new URLSearchParams(location.search).get('raw') === '1';
const TTS_TEXT = '福岡駅まで案内します。';
const TTS_LENGTH_SCALE = 1.5; // 声のモデルの説明にある、自然な話す速さ（1.0 だと早口）

const $ = (id) => document.getElementById(id);
const pageStart = performance.now();

// ---- 記録 ----
const logLines = [];
function log(message, isError = false) {
  const now = new Date();
  const time = now.toLocaleTimeString('ja-JP') + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const line = `${time} ${isError ? '【エラー】' : ''}${message}`;
  logLines.unshift(line);
  const el = document.createElement('div');
  el.textContent = line;
  if (isError) el.className = 'ng';
  $('log').prepend(el);
  if (isError) console.error(message); else console.log(message);
}
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const sec = (ms) => `${(ms / 1000).toFixed(2)}秒`;
const errText = (e) => `${(e && e.name) || 'Error'}：${(e && e.message) || e}`;

window.addEventListener('error', (e) => log(`${e.message}（${e.filename || ''}:${e.lineno || ''}）`, true));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  log(`${(r && (r.stack || r.message)) || r}`, true);
});

function simdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch (e) {
    return false;
  }
}
log(`ページを開きました：${navigator.userAgent}`);
log(`WebAssembly：${typeof WebAssembly === 'object' ? 'あり' : 'なし'}、SIMD：${simdSupported() ? 'あり' : 'なし（このページは動きません）'}、CPUの数：${navigator.hardwareConcurrency || '不明'}`);

// iPhoneのSafari（16.4以降）は、音の使い方を指定できる。聞き取りは録音と再生、読み上げは再生（マナーモードでも鳴らすため）
function setAudioSession(type) {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== type) {
      navigator.audioSession.type = type;
      log(`音の使い方を「${type}」にしました`);
    }
  } catch (e) {
    log(`音の使い方を変えられません：${errText(e)}`);
  }
}

// ======================================================================
// 聞き取り
// ======================================================================

let worker = null;
let workerReady = null;  // 準備ができたら解決する Promise
let listening = false;
let listenTimer = null;
let partialShown = false;

function getWorker() {
  if (worker) return worker;
  worker = new Worker('asr-worker.js');
  worker.onerror = (e) => log(`聞き取りの処理を起動できません：${e.message || e}`, true);
  worker.onmessage = (e) => onWorkerMessage(e.data);
  return worker;
}

function setAsrStatus(text) {
  $('asr-status').textContent = text;
}

let readyResolve = null;
let readyReject = null;
function onWorkerMessage(msg) {
  if (msg.type === 'log') {
    log(msg.message, msg.error);
  } else if (msg.type === 'progress') {
    $('asr-progress').hidden = false;
    $('asr-progress').firstElementChild.style.width = `${(msg.loaded / msg.total * 100).toFixed(1)}%`;
    setAsrStatus(`モデルを読み込み中… ${mb(msg.loaded)} / ${mb(msg.total)}`);
  } else if (msg.type === 'ready') {
    $('asr-progress').hidden = true;
    readyResolve && readyResolve();
  } else if (msg.type === 'failed') {
    $('asr-progress').hidden = true;
    readyReject && readyReject(new Error(msg.message));
  } else if (msg.type === 'detected') {
    setAsrStatus('声を検出中…（話している途中の文字が出ます）');
    log('声を検出');
    clearTimeout(listenTimer);
  } else if (msg.type === 'partial') {
    partialShown = true;
    $('result').textContent = msg.text || '…';
    $('result').classList.add('partial');
    log(`途中の文字：「${msg.text}」（音 ${msg.audioSec.toFixed(2)}秒分を ${sec(msg.decodeMs)} で認識。次は ${msg.step.toFixed(2)}秒後）`);
  } else if (msg.type === 'final') {
    showFinal(msg);
  } else if (msg.type === 'stopped') {
    endListening(msg.reason);
  }
}

function loadAsr() {
  if (!workerReady) {
    workerReady = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    workerReady.catch(() => { workerReady = null; }); // 失敗したら、次の押下でやり直す
    setAsrStatus('モデルを読み込み中…');
    getWorker().postMessage({ type: 'load' });
  }
  return workerReady;
}

// ---- マイク ----
let audio = null; // { ctx, stream, source, processor }

async function ensureMic() {
  if (audio) {
    if (audio.ctx.state !== 'running') await audio.ctx.resume();
    return audio;
  }
  setAudioSession('play-and-record');
  // ボタンの押下の中で、await より前に作る（iPhoneのSafariは操作の外では音を扱えないため）
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const resumed = ctx.resume();
  const processed = !RAW_AUDIO; // ?raw=1 で、ブラウザによる音の加工を切る（比べるため）
  const streamPromise = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: processed, noiseSuppression: processed, autoGainControl: processed },
  });
  await resumed;
  const stream = await streamPromise;
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = onMicAudio;
  source.connect(processor);
  processor.connect(ctx.destination); // つながっていないと onaudioprocess が来ない。出力は無音
  const track = stream.getAudioTracks()[0];
  const st = (track && track.getSettings) ? track.getSettings() : {};
  log(`マイクを使い始めました（音の速さ ${ctx.sampleRate} Hz、${(4096 / ctx.sampleRate * 1000).toFixed(0)} ミリ秒ごとに流し込む。音の加工：エコー除去=${st.echoCancellation}、雑音抑制=${st.noiseSuppression}、音量の自動調整=${st.autoGainControl}）`);
  audio = { ctx, stream, source, processor };
  return audio;
}

function downsample(input, fromRate) {
  if (fromRate === SAMPLE_RATE) return input;
  const ratio = fromRate / SAMPLE_RATE;
  const out = new Float32Array(Math.round(input.length / ratio));
  let pos = 0;
  for (let i = 0; i < out.length; i++) {
    const next = Math.round((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (; pos < next && pos < input.length; pos++) {
      sum += input[pos];
      count++;
    }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

// マイクの音を少しずつ Worker へ流し込む（約85ミリ秒ごと）
function onMicAudio(e) {
  if (!listening) return;
  const samples = downsample(new Float32Array(e.inputBuffer.getChannelData(0)), audio.ctx.sampleRate);
  worker.postMessage({ type: 'audio', samples, capturedAt: Date.now() }, [samples.buffer]);
}

function beginListening() {
  listening = true;
  partialShown = false;
  $('result').textContent = '―';
  $('result').classList.remove('partial');
  $('metrics').textContent = '';
  $('asr').textContent = '聞き取り中…（押すと止める）';
  $('asr').classList.add('listening');
  setAsrStatus('話してください');
  worker.postMessage({ type: 'start' });
  log('聞き取りを始めました');
  clearTimeout(listenTimer);
  listenTimer = setTimeout(() => {
    if (listening) {
      worker.postMessage({ type: 'stop', reason: `${LISTEN_TIMEOUT_MS / 1000}秒間、声が検出されなかったため` });
      setAsrStatus('声が聞き取れませんでした。もう一度押してください');
    }
  }, LISTEN_TIMEOUT_MS);
}

function endListening(reason) {
  if (!listening) return;
  listening = false;
  clearTimeout(listenTimer);
  $('asr').textContent = '聞き取りの試験';
  $('asr').classList.remove('listening');
  log(`聞き取りを止めました（${reason}）`);
}

function showFinal(m) {
  if (!m.text) {
    log(`最終の文字：言葉になりませんでした（話した長さ ${m.spokenSec.toFixed(2)}秒）。続けて聞き取ります`);
    setAsrStatus('言葉になりませんでした。続けて話してください');
    return;
  }
  $('result').textContent = m.text;
  $('result').classList.remove('partial');
  $('metrics').textContent = '';
  const lines = [
    `話し終わってから最終の文字が確定するまで：約 ${sec(m.totalMs)}`,
    `内訳：話し終わりの判定待ち（無音 0.50秒）＋ 処理の待ち ${sec(m.waitMs)} ＋ 最終の認識の計算 ${sec(m.decodeMs)}`,
    `途中の文字：${m.partials}回${m.firstPartialMs !== null && m.firstPartialMs !== undefined ? `（声を検出してから最初の途中の文字まで ${sec(m.firstPartialMs)}）` : '（出る前に話し終わりました）'}`,
    `話した長さ：${m.spokenSec.toFixed(2)}秒`,
  ];
  for (const l of lines) {
    const div = document.createElement('div');
    div.textContent = l;
    $('metrics').append(div);
  }
  setAsrStatus('最終の文字が確定しました。もう一度試すときはボタンを押してください');
  log(`最終の文字：「${m.text}」／ 話し終わり→確定 約 ${sec(m.totalMs)}（判定待ち 0.50秒 ＋ 待ち ${sec(m.waitMs)} ＋ 計算 ${sec(m.decodeMs)}）／ 途中の文字 ${m.partials}回 ／ 話した長さ ${m.spokenSec.toFixed(2)}秒`);
}

let asrBusy = false;
$('asr').addEventListener('click', async () => {
  if (listening) {
    worker.postMessage({ type: 'stop', reason: 'ボタンが押されたため' });
    setAsrStatus('止めました');
    return;
  }
  if (asrBusy) return; // 読み込み中の押下は無視する
  asrBusy = true;
  try {
    // マイクは押下の中で求める（await より前に AudioContext と getUserMedia を呼ぶ）
    const micReady = ensureMic();
    const started = performance.now();
    const ready = loadAsr();
    await micReady;
    await ready;
    if (performance.now() - started > 1000) log(`聞き取り：読み込みと準備にかかった時間 ${sec(performance.now() - started)}`);
    await ensureMic(); // 読み込みの間に止まっていれば再開する
    beginListening();
  } catch (e) {
    $('asr-progress').hidden = true;
    setAsrStatus('失敗しました。記録を見てください');
    log(errText(e), true);
    if (e && e.name === 'NotAllowedError') log('マイクの使用が許可されていません。設定でマイクを許可してください', true);
  } finally {
    asrBusy = false;
  }
});

// ======================================================================
// 読み上げ
// ======================================================================

// 声のモデルは、この端末のブラウザ内（IndexedDB）にだけ保存する
const DB_NAME = 'speech-lab';
const STORE = 'files';
const MODEL_KEY = 'tts-model';
const CONFIG_KEY = 'tts-config';

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req && req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
const idbGet = (key) => idb('readonly', (s) => s.get(key));
const idbPut = (key, value) => idb('readwrite', (s) => s.put(value, key));

async function showModelState() {
  try {
    const [model, config] = await Promise.all([idbGet(MODEL_KEY), idbGet(CONFIG_KEY)]);
    if (model && config) {
      $('tts-model-state').textContent = `声のモデル：保存済み（${model.name}、${mb(model.size)}／${config.name}）`;
      return true;
    }
    $('tts-model-state').textContent = '声のモデル：まだありません。下の「声のモデルを選ぶ」で2つのファイルを選んでください';
  } catch (e) {
    $('tts-model-state').textContent = `声のモデル：保存場所が使えません（${errText(e)}）`;
  }
  return false;
}
showModelState();

$('tts-files').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  const model = files.find((f) => /\.onnx$/i.test(f.name));
  const config = files.find((f) => /\.json$/i.test(f.name));
  if (!model || !config) {
    log('声のモデルは、.onnx のファイルと .json のファイル（config.json）の2つを一緒に選んでください', true);
    return;
  }
  try {
    const started = performance.now();
    JSON.parse(await config.text()); // 設定ファイルの中身を確かめる
    await idbPut(MODEL_KEY, model);
    await idbPut(CONFIG_KEY, config);
    log(`声のモデルを保存しました：${model.name}（${mb(model.size)}）、${config.name}（${(config.size / 1000).toFixed(1)} KB）。${sec(performance.now() - started)}`);
    tts = null; // 次の読み上げで読み込み直す
    showModelState();
  } catch (err) {
    log(`声のモデルを保存できません：${errText(err)}`, true);
  }
});

// piper-plus は声のモデルを「http(s) のアドレス」で受け取る。そのアドレスへの読み込みだけを、
// ブラウザ内に保存したファイルにつなぎかえる（外部へは出ない）。部品の大きなファイルの読み込みは記録に出す
const LOCAL_MODEL_URL = new URL('local-tts-model/tsukuyomi.onnx', location.href).href;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
  if (url === LOCAL_MODEL_URL || url === LOCAL_MODEL_URL + '.json') {
    const blob = await idbGet(url === LOCAL_MODEL_URL ? MODEL_KEY : CONFIG_KEY);
    if (!blob) return new Response('', { status: 404, statusText: '声のモデルがありません' });
    log(`読み上げ：声のモデルを端末内から読み込み：${blob.name}（${mb(blob.size)}）`);
    return new Response(blob, { status: 200, headers: { 'Content-Type': url === LOCAL_MODEL_URL ? 'application/octet-stream' : 'application/json' } });
  }
  const res = await originalFetch(input, init);
  if (/\.wasm(\?|$)/.test(url) && res.ok) {
    const started = performance.now();
    const buf = await res.arrayBuffer();
    log(`読み上げ：ダウンロード：${url.replace(/^.*\/speech-lab\//, '')} ${mb(buf.byteLength)}（${sec(performance.now() - started)}）`);
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  return res;
};

let tts = null;       // PiperPlus のインスタンス
let ttsBusy = false;
let playCtx = null;   // 読み上げの再生に使う AudioContext（押下の中で作る）

function setTtsStatus(text) {
  $('tts-status').textContent = text;
}

async function loadTts() {
  const started = performance.now();
  setTtsStatus('読み上げの部品を読み込み中…');
  const ort = await import('./vendor/onnxruntime-web/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = new URL('vendor/onnxruntime-web/', location.href).href;
  ort.env.wasm.numThreads = 1; // 公開ページは複数スレッドを使えない設定（crossOriginIsolated でない）
  const ortLoaded = performance.now();
  log(`読み上げ：onnxruntime-web の読み込み ${sec(ortLoaded - started)}`);
  const { PiperPlus } = await import('./vendor/piper-plus/src/index.js');
  log(`読み上げ：piper-plus の読み込み ${sec(performance.now() - ortLoaded)}`);
  setTtsStatus('声のモデルと日本語の辞書を準備中…（初回は 約75 MB を読み込みます）');
  const initStarted = performance.now();
  const instance = await PiperPlus.initialize({
    model: LOCAL_MODEL_URL,
    ort,
    wasmG2pUrl: new URL('vendor/piper-plus/dist/rust-wasm/piper_plus_wasm.js', location.href).href,
    onProgress: ({ stage, message }) => log(`読み上げ：準備（${stage}）：${message}`),
  });
  log(`読み上げ：声のモデルと日本語の辞書の準備 ${sec(performance.now() - initStarted)}（合計 ${sec(performance.now() - started)}）`);
  return instance;
}

$('tts').addEventListener('click', async () => {
  if (ttsBusy) return;
  ttsBusy = true;
  $('tts').disabled = true;
  try {
    if (!listening) setAudioSession('playback'); // マナーモードでも鳴るように（聞き取り中は変えない）
    // 再生用の AudioContext は、押下の中で作って動かしておく（iPhoneは操作の外では音を出し始められないため）
    if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)();
    const resumed = playCtx.resume();
    await resumed;
    if (!(await showModelState())) throw new Error('声のモデルがまだありません。「声のモデルを選ぶ」で2つのファイルを選んでください');
    if (!tts) tts = await loadTts();

    setTtsStatus('声を作っています…');
    const synthStarted = performance.now();
    const result = await tts.synthesize(TTS_TEXT, { language: 'ja', lengthScale: TTS_LENGTH_SCALE });
    const synthMs = performance.now() - synthStarted;
    // 作った音が無音でないかを数字で確かめる（音が聞こえないとき、声が作れていないのか、再生されていないのかを見分ける）
    let peak = 0;
    let sum = 0;
    for (const v of result.samples) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, result.samples.length));
    log(`読み上げ：声を作りました「${TTS_TEXT}」（${sec(synthMs)}、音の長さ ${result.duration.toFixed(2)}秒、${result.sampleRate} Hz、音の大きさ 最大 ${peak.toFixed(2)}・平均 ${rms.toFixed(3)}${peak < 0.01 ? '：ほぼ無音です' : ''}）`);

    if (playCtx.state !== 'running') await playCtx.resume();
    const buffer = playCtx.createBuffer(1, result.samples.length, result.sampleRate);
    buffer.copyToChannel(result.samples, 0);
    const src = playCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(playCtx.destination);
    await new Promise((resolve) => {
      src.onended = resolve;
      src.start();
      log(`読み上げ開始：音を出し始めました（再生の状態：${playCtx.state}、音の長さ ${result.duration.toFixed(2)}秒）。聞こえたか確かめてください`);
      setTtsStatus('読み上げ中…');
    });
    log('読み上げ終了：音を出し終わりました');
    setTtsStatus('読み上げが終わりました。もう一度試すときはボタンを押してください');
  } catch (e) {
    setTtsStatus('失敗しました。記録を見てください');
    log(`読み上げ：${errText(e)}`, true);
  } finally {
    ttsBusy = false;
    $('tts').disabled = false;
  }
});

// ---- 記録のコピー ----
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

log(`準備ができました（ページの読み込み ${sec(performance.now() - pageStart)}）`);
