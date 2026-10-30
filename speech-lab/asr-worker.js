// 聞き取りの計算を受け持つ Web Worker。sherpa-onnx（WebAssembly版）の VAD ＋ 音声認識を動かす。
// 画面側（lab.js）からマイクの音（16000 Hz）を少しずつ受け取り、話している途中から文字を返す。
//
// ストリーミングについて：日本語のストリーミング用モデルと、その WebAssembly 版は sherpa-onnx に無い
// （日本語は話し終わってから認識する方式のモデルだけ）。そこで、話している間は「話し始めから今まで」の
// 音を一定の間隔で認識し直して途中の文字を返し、話し終わったら区間全体を認識して最終の文字を返す。
// 計算を Worker に分けているので、計算中も画面側のマイクの取り込みは止まらない。
//
// 外部へは通信しない。部品もモデルも同じ場所（sherpa/）から読み込む。

'use strict';

const BASE = 'sherpa/';
const MAIN_SCRIPT = 'sherpa-onnx-wasm-main-vad-asr.js';
const CACHE_NAME = 'speech-lab-sherpa-onnx-1.12.0-ja-reazonspeech';
const SAMPLE_RATE = 16000;
const MIN_SILENCE = 0.5;     // この長さ（秒）の無音で「話し終わり」とみなす
const MIN_SPEECH = 0.25;     // VAD が声とみなすまでの長さ（秒）
// VAD の区間をそのまま認識すると言葉の頭を取りこぼす（「福岡駅までナビして」が「また」になった）ため、前後に余白を足す
const PAD_BEFORE = 0.8;
const PAD_AFTER = 0.3;
const PARTIAL_STEP = 0.4;    // 途中の文字を出す間隔（秒、音の長さで数える）。計算が遅ければ広げる
const MAX_RECORD_SEC = 60;  // 手元に残す音の上限（秒）
const RUNTIME_TIMEOUT_MS = 180000;

const post = (msg) => self.postMessage(msg);
const log = (message, error = false) => post({ type: 'log', message, error });
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const sec = (ms) => `${(ms / 1000).toFixed(2)}秒`;

self.addEventListener('error', (e) => log(`聞き取りの処理でエラー：${e.message}（${e.filename || ''}:${e.lineno || ''}）`, true));
self.addEventListener('unhandledrejection', (e) => log(`聞き取りの処理でエラー：${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`, true));

// ---- 読み込み ----
async function openCache() {
  try {
    if (!self.caches) return null;
    return await caches.open(CACHE_NAME);
  } catch (e) {
    log(`キャッシュが使えません（毎回ダウンロードします）：${e.message}`);
    return null;
  }
}

async function fetchInto(url, size, target, offset, cache, onBytes) {
  const started = performance.now();
  let response = null;
  let fromCache = false;
  if (cache) {
    try {
      response = await cache.match(url);
      fromCache = !!response;
    } catch (e) {
      response = null;
    }
  }
  if (!response) {
    response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${url} を読み込めません（${response.status}）`);
    if (cache) cache.put(url, response.clone()).catch((e) => log(`キャッシュへの保存に失敗：${url}：${e.message}`));
  }
  const reader = response.body.getReader();
  let pos = offset;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (pos + value.length > offset + size) throw new Error(`${url} の大きさが想定と違います`);
    target.set(value, pos);
    pos += value.length;
    onBytes(value.length);
  }
  if (pos - offset !== size) throw new Error(`${url} の大きさが想定と違います（${pos - offset} / ${size} バイト）`);
  const ms = performance.now() - started;
  log(`聞き取り：${fromCache ? 'キャッシュから' : 'ダウンロード'}：${url.replace(BASE, '')} ${mb(size)}（${sec(ms)}${fromCache ? '' : `、${(size / 1e6 / (ms / 1000)).toFixed(1)} MB/秒`}）`);
}

let engine = null; // { vad, buffer, recognizer }

async function load() {
  const started = performance.now();
  const manifest = await (await fetch(BASE + 'manifest.json', { cache: 'no-store' })).json();
  const total = manifest.wasm.size + manifest.data.size;
  log(`聞き取り：ダウンロード量 合計 ${mb(total)}（本体 wasm ${mb(manifest.wasm.size)}、モデル ${mb(manifest.data.size)} を ${manifest.data.parts.length} つに分割）`);
  const cache = await openCache();
  let loaded = 0;
  const onBytes = (n) => {
    loaded += n;
    post({ type: 'progress', loaded, total });
  };
  const wasmBinary = new Uint8Array(manifest.wasm.size);
  await fetchInto(BASE + manifest.wasm.file, manifest.wasm.size, wasmBinary, 0, cache, onBytes);
  let data = new Uint8Array(manifest.data.size);
  let offset = 0;
  for (const part of manifest.data.parts) {
    await fetchInto(BASE + part.file, part.size, data, offset, cache, onBytes);
    offset += part.size;
  }
  const downloaded = performance.now();
  log(`聞き取り：ダウンロード完了 ${sec(downloaded - started)}`);

  importScripts(BASE + 'sherpa-onnx-asr.js', BASE + 'sherpa-onnx-vad.js');
  const runtimeReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebAssembly の初期化が終わりません')), RUNTIME_TIMEOUT_MS);
    let lastStatus = '';
    self.Module = {
      wasmBinary,
      locateFile: (path) => BASE + path,
      // モデルは読み込み済みのものを渡す（sherpa-onnx 側ではダウンロードしない）
      getPreloadedPackage: (name, size) => {
        if (size !== manifest.data.size) log(`聞き取り：モデルの大きさが想定と違います（${size} / ${manifest.data.size}）`, true);
        const buf = data.buffer;
        data = null; // 二重に持たないよう、こちらの参照を外す
        return buf;
      },
      setStatus: (s) => {
        if (s && s !== lastStatus) log(`聞き取り：sherpa-onnx の状態：${s}`);
        lastStatus = s;
      },
      print: () => {},
      printErr: (s) => log(`聞き取り：sherpa-onnx：${s}`, /error|fail|abort/i.test(s)),
      onAbort: (what) => {
        clearTimeout(timer);
        reject(new Error(`sherpa-onnx が止まりました：${what}`));
      },
      onRuntimeInitialized: () => {
        clearTimeout(timer);
        resolve();
      },
    };
  });
  importScripts(BASE + MAIN_SCRIPT);
  await runtimeReady;
  const runtime = performance.now();
  log(`聞き取り：WebAssembly の初期化 ${sec(runtime - downloaded)}`);

  const Module = self.Module;
  const vad = createVad(Module, {
    sileroVad: { model: './silero_vad.onnx', threshold: 0.5, minSilenceDuration: MIN_SILENCE, minSpeechDuration: MIN_SPEECH, maxSpeechDuration: 20, windowSize: 512 },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 30,
  });
  const buffer = new CircularBuffer(30 * SAMPLE_RATE, Module);
  const vadReady = performance.now();
  log(`聞き取り：音声区間の検出（silero-vad）の準備 ${sec(vadReady - runtime)}`);
  const recognizer = new OfflineRecognizer({
    modelConfig: {
      debug: 0,
      numThreads: 1,
      tokens: './tokens.txt',
      transducer: { encoder: './transducer-encoder.onnx', decoder: './transducer-decoder.onnx', joiner: './transducer-joiner.onnx' },
      modelType: 'transducer',
    },
  }, Module);
  const ready = performance.now();
  log(`聞き取り：音声認識モデル（reazonspeech）の準備 ${sec(ready - vadReady)}`);
  log(`聞き取り：準備完了 合計 ${sec(ready - started)}`);
  engine = { vad, buffer, recognizer };
}

// ---- 聞き取り ----
// 開始のあとは聞き続ける。一つの話が終わるたびに最終の文字を返し、次の話を待つ。
// 読み上げの間は画面側から pause が来る（自分の声を聞き取らないため）。resume で、状態を消してから再開する。
let listening = false;
// VAD に渡した音を、渡した順に残す。位置は VAD と同じく「聞き取り開始からの通し番号」で数え、
// fed[0] が通し番号 fedBase にあたる。話していない間に古い音を捨てて、長く聞き続けられるようにする
const fed = new Float32Array(MAX_RECORD_SEC * SAMPLE_RATE);
let fedBase = 0;
let fedLength = 0;
const KEEP_SEC = 2;          // 古い音を捨てるとき、直前の何秒を残すか（話し始めの余白に使う）
const COMPACT_SEC = 20;      // これだけたまったら古い音を捨てる
// 話している間の状態 { onset, speechStartWall, lastPartialEnd, step, partials, firstTextMs }
let speech = null;

const fedEnd = () => fedBase + fedLength; // 今まで渡した音の通し番号の終わり

function decode(from, to) {
  const { recognizer } = engine;
  const started = performance.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform(SAMPLE_RATE, fed.slice(Math.max(0, from - fedBase), Math.max(0, to - fedBase)));
  recognizer.decode(stream);
  const text = (recognizer.getResult(stream).text || '').trim();
  stream.free();
  return { text, ms: performance.now() - started };
}

function resetListening() {
  engine.vad.reset();
  engine.buffer.reset();
  fedBase = 0;
  fedLength = 0;
  speech = null;
}

function compactIfNeeded() {
  if (speech || fedLength < COMPACT_SEC * SAMPLE_RATE) return;
  const keep = KEEP_SEC * SAMPLE_RATE;
  fed.copyWithin(0, fedLength - keep, fedLength);
  fedBase += fedLength - keep;
  fedLength = keep;
}

// capturedAt：この音を画面側が受け取った時刻（Date.now()）
function onAudio(samples, capturedAt) {
  if (!listening || !engine) return;
  const { vad, buffer } = engine;
  buffer.push(samples);
  const win = vad.config.sileroVad.windowSize;
  while (buffer.size() > win) {
    const s = buffer.get(buffer.head(), win);
    vad.acceptWaveform(s);
    buffer.pop(win);
    if (fedLength + s.length > fed.length) {
      // 一つの話が長すぎる（VAD は20秒で区切るので、ふつうは来ない）。状態を消してやり直す
      log(`聞き取り：一つの話が${MAX_RECORD_SEC}秒を超えたため、やり直します`);
      resetListening();
      return;
    }
    fed.set(s, fedLength);
    fedLength += s.length;

    if (vad.isDetected() && !speech) {
      // 声を検出した。VAD が声とみなすまでの分だけ、話し始めは少し前にある
      const lead = MIN_SPEECH + win / SAMPLE_RATE;
      const onset = Math.max(fedBase, fedEnd() - Math.round((lead + 0.1) * SAMPLE_RATE));
      speech = { onset, speechStartWall: capturedAt - lead * 1000, lastPartialEnd: fedEnd(), step: PARTIAL_STEP, partials: 0, firstTextMs: null };
      post({ type: 'detected' });
    }

    while (!vad.isEmpty()) {
      const segment = vad.front();
      vad.pop();
      const spokenSec = segment.samples.length / SAMPLE_RATE;
      const from = Math.max(fedBase, segment.start - Math.round(PAD_BEFORE * SAMPLE_RATE));
      const to = Math.min(fedEnd(), segment.start + segment.samples.length + Math.round(PAD_AFTER * SAMPLE_RATE));
      const r = decode(from, to);
      // 話し終わり ≒ この音を受け取った時刻 − 無音の判定待ち。そこから最終の文字が出るまで
      const sinceCapture = Date.now() - capturedAt;
      const info = speech || {};
      let firstTextMs = info.firstTextMs;
      let firstTextFromFinal = false;
      if ((firstTextMs === null || firstTextMs === undefined) && r.text && info.speechStartWall) {
        firstTextMs = Date.now() - info.speechStartWall; // 途中の文字が出る前に話し終わった
        firstTextFromFinal = true;
      }
      post({
        type: 'final',
        text: r.text,
        decodeMs: r.ms,
        waitMs: Math.max(0, sinceCapture - r.ms),
        totalMs: MIN_SILENCE * 1000 + sinceCapture,
        spokenSec,
        partials: info.partials || 0,
        firstTextMs: firstTextMs === undefined ? null : firstTextMs,
        firstTextFromFinal,
      });
      speech = null; // 次の話を待つ
    }
  }

  // 話している途中：前回から一定の長さの音が増えたら、話し始めから今までを認識し直して途中の文字を返す
  if (speech && fedEnd() - speech.lastPartialEnd >= speech.step * SAMPLE_RATE) {
    const from = Math.max(fedBase, speech.onset - Math.round(PAD_BEFORE * SAMPLE_RATE));
    const r = decode(from, fedEnd());
    speech.lastPartialEnd = fedEnd();
    speech.partials += 1;
    let firstTextMs = null;
    if (r.text && speech.firstTextMs === null) {
      speech.firstTextMs = Date.now() - speech.speechStartWall;
      firstTextMs = speech.firstTextMs;
    }
    // 計算が音の増え方に追いつかないときは、間隔を広げる（遅れがたまらないように）
    speech.step = Math.max(PARTIAL_STEP, (r.ms / 1000) * 1.5);
    post({ type: 'partial', text: r.text, decodeMs: r.ms, audioSec: (fedEnd() - from) / SAMPLE_RATE, step: speech.step, firstTextMs });
  }
  compactIfNeeded();
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      if (!engine) await load();
      post({ type: 'ready' });
    } else if (msg.type === 'resume') {
      resetListening();
      listening = true;
    } else if (msg.type === 'pause') {
      listening = false;
      speech = null;
    } else if (msg.type === 'audio') {
      onAudio(msg.samples, msg.capturedAt);
    }
  } catch (err) {
    log(`聞き取り：${err.name || 'Error'}：${err.message}\n${err.stack || ''}`, true);
    if (msg.type === 'load') post({ type: 'failed', message: err.message });
  }
};
