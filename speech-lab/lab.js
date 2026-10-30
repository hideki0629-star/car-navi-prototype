// 端末内の音声認識の試作。sherpa-onnx（WebAssembly版）の VAD（音声区間の検出）＋ 音声認識を使う。
// 外部のAPIやサービスは使わない。モデルも部品も、このページと同じ場所（sherpa/）から読み込む。
// 音声は AudioContext で取り込み、この端末の中だけで認識する。端末の外へは送らない。
//
// モデル（.data、約171 MB）は GitHub の1ファイル100 MBの上限を超えるため、分けて置いてある。
// ここで1つに戻して Module.getPreloadedPackage で sherpa-onnx に渡す。

'use strict';

const BASE = 'sherpa/';
const MAIN_SCRIPT = 'sherpa-onnx-wasm-main-vad-asr.js';
const CACHE_NAME = 'speech-lab-sherpa-onnx-1.12.0-ja-reazonspeech';
const SAMPLE_RATE = 16000;   // sherpa-onnx に渡す音の速さ
const MIN_SILENCE = 0.5;     // この長さ（秒）の無音で「話し終わり」とみなす
// VAD が切り出す区間は話し始めのすぐ前からで、そのまま認識すると言葉の頭を取りこぼす
// （試験：「福岡駅までナビして」が「また」「駅までナビして」になった）。前後に余白を足して認識する
const PAD_BEFORE = 0.8;
const PAD_AFTER = 0.3;
const MAX_RECORD_SEC = 60;   // 一回の聞き取りで手元に残す音の上限
const LISTEN_TIMEOUT_MS = 15000; // 声が無いまま、これだけたったら聞き取りをやめる
const RUNTIME_TIMEOUT_MS = 180000;
const RAW_AUDIO = new URLSearchParams(location.search).get('raw') === '1';

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

function setStatus(text) {
  $('status').textContent = text;
}

window.addEventListener('error', (e) => log(`${e.message}（${e.filename || ''}:${e.lineno || ''}）`, true));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  log(`${(r && (r.stack || r.message)) || r}`, true);
});

// ---- 端末の情報 ----
function simdSupported() {
  try {
    // wasm-feature-detect と同じ、SIMD 命令を含む最小の WebAssembly
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch (e) {
    return false;
  }
}
log(`ページを開きました：${navigator.userAgent}`);
log(`WebAssembly：${typeof WebAssembly === 'object' ? 'あり' : 'なし'}、SIMD：${simdSupported() ? 'あり' : 'なし（このページは動きません）'}、CPUの数：${navigator.hardwareConcurrency || '不明'}`);

// ---- ファイルの読み込み（キャッシュがあればそこから） ----
async function openCache() {
  try {
    if (!('caches' in window)) return null;
    return await caches.open(CACHE_NAME);
  } catch (e) {
    log(`キャッシュが使えません（毎回ダウンロードします）：${e.message}`);
    return null;
  }
}

// url の中身を target の offset から書き込む。読んだ量を onBytes に知らせる
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
    if (cache) {
      // 次からはダウンロードしないよう保存する。容量不足などで失敗しても続ける
      cache.put(url, response.clone()).catch((e) => log(`キャッシュへの保存に失敗：${url}：${e.message}`));
    }
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
  log(`${fromCache ? 'キャッシュから' : 'ダウンロード'}：${url.replace(BASE, '')} ${mb(size)}（${sec(ms)}${fromCache ? '' : `、${(size / 1e6 / (ms / 1000)).toFixed(1)} MB/秒`}）`);
  return fromCache;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} を読み込めません`));
    document.head.append(s);
  });
}

// ---- sherpa-onnx の準備 ----
let engine = null;   // { Module, vad, buffer, recognizer }
let loading = null;

async function loadEngine() {
  const started = performance.now();
  setStatus('モデルを読み込み中…');
  $('progress').hidden = false;
  const bar = $('progress').firstElementChild;

  const manifest = await (await fetch(BASE + 'manifest.json', { cache: 'no-store' })).json();
  const total = manifest.wasm.size + manifest.data.size;
  log(`ダウンロード量：合計 ${mb(total)}（本体 wasm ${mb(manifest.wasm.size)}、モデル ${mb(manifest.data.size)} を ${manifest.data.parts.length} つに分割）`);

  const cache = await openCache();
  let loaded = 0;
  const onBytes = (n) => {
    loaded += n;
    bar.style.width = `${(loaded / total * 100).toFixed(1)}%`;
    setStatus(`モデルを読み込み中… ${mb(loaded)} / ${mb(total)}`);
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
  log(`読み込み（ダウンロード）完了：${sec(downloaded - started)}`);

  setStatus('音声認識を準備中…（数十秒かかることがあります）');
  await loadScript(BASE + 'sherpa-onnx-asr.js');
  await loadScript(BASE + 'sherpa-onnx-vad.js');

  const runtimeReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebAssembly の初期化が終わりません')), RUNTIME_TIMEOUT_MS);
    let lastStatus = '';
    window.Module = {
      wasmBinary,
      locateFile: (path) => BASE + path,
      // モデルは読み込み済みのものを渡す（sherpa-onnx 側ではダウンロードしない）
      getPreloadedPackage: (name, size) => {
        if (size !== manifest.data.size) log(`モデルの大きさが想定と違います（${size} / ${manifest.data.size}）`, true);
        const buf = data.buffer;
        data = null; // 二重に持たないよう、こちらの参照を外す
        return buf;
      },
      setStatus: (s) => {
        if (s && s !== lastStatus) log(`sherpa-onnx の状態：${s}`);
        lastStatus = s;
      },
      print: (s) => console.log(s),
      printErr: (s) => log(`sherpa-onnx：${s}`, /error|fail|abort/i.test(s)),
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
  await loadScript(BASE + MAIN_SCRIPT);
  await runtimeReady;
  const runtime = performance.now();
  log(`WebAssembly の初期化：${sec(runtime - downloaded)}`);

  const Module = window.Module;
  const vad = createVad(Module, {
    sileroVad: { model: './silero_vad.onnx', threshold: 0.5, minSilenceDuration: MIN_SILENCE, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 512 },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 30,
  });
  const buffer = new CircularBuffer(30 * SAMPLE_RATE, Module);
  const vadReady = performance.now();
  log(`音声区間の検出（silero-vad）の準備：${sec(vadReady - runtime)}`);

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
  log(`音声認識モデル（reazonspeech）の準備：${sec(ready - vadReady)}`);
  log(`準備完了：開始から合計 ${sec(ready - started)}`);
  $('progress').hidden = true;
  return { Module, vad, buffer, recognizer };
}

// ---- マイク ----
let audio = null;    // { ctx, stream, source, processor }

async function ensureAudio() {
  if (audio) {
    if (audio.ctx.state !== 'running') await audio.ctx.resume();
    return audio;
  }
  // ボタンの押下の中で、await より前に作る（iPhoneのSafariは操作の外では音を扱えないため）
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const resumed = ctx.resume();
  // アドレスに ?raw=1 を付けると、ブラウザによる音の加工（エコー除去・雑音抑制・音量の自動調整）を切る（比べるため）
  const processed = !RAW_AUDIO;
  const streamPromise = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: processed, noiseSuppression: processed, autoGainControl: processed },
  });
  await resumed;
  const stream = await streamPromise;
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = onAudio;
  source.connect(processor);
  processor.connect(ctx.destination); // つながっていないと onaudioprocess が来ない。出力は無音
  const track = stream.getAudioTracks()[0];
  const st = (track && track.getSettings) ? track.getSettings() : {};
  log(`マイクを使い始めました（音の速さ ${ctx.sampleRate} Hz、${(4096 / ctx.sampleRate * 1000).toFixed(0)} ミリ秒ごとに受け取る。音の加工：エコー除去=${st.echoCancellation}、雑音抑制=${st.noiseSuppression}、音量の自動調整=${st.autoGainControl}）`);
  audio = { ctx, stream, source, processor };
  return audio;
}

// マイクの音（多くは 48000 Hz）を 16000 Hz に落とす
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

// ---- 聞き取り ----
let listening = false;
let detected = false;
let listenStarted = 0;
let listenTimer = null;
// VAD に渡した音を、渡した順にそのまま残す（VAD の区間の位置と同じ数え方になる）
const fed = new Float32Array(MAX_RECORD_SEC * SAMPLE_RATE);
let fedLength = 0;

function startListening() {
  const { vad, buffer } = engine;
  vad.reset();
  buffer.reset();
  fedLength = 0;
  detected = false;
  listening = true;
  listenStarted = performance.now();
  $('asr').textContent = '聞き取り中…（押すと止める）';
  $('asr').classList.add('listening');
  setStatus('話してください');
  log('聞き取りを始めました');
  clearTimeout(listenTimer);
  listenTimer = setTimeout(() => {
    if (listening && !detected) {
      stopListening(`${LISTEN_TIMEOUT_MS / 1000}秒間、声が検出されなかったため`);
      setStatus('声が聞き取れませんでした。もう一度押してください');
    }
  }, LISTEN_TIMEOUT_MS);
}

function stopListening(reason) {
  if (!listening) return;
  listening = false;
  clearTimeout(listenTimer);
  $('asr').textContent = '聞き取りの試験';
  $('asr').classList.remove('listening');
  log(`聞き取りを止めました（${reason}）`);
}

function onAudio(e) {
  if (!listening || !engine) return;
  const { vad, buffer, recognizer } = engine;
  const samples = downsample(new Float32Array(e.inputBuffer.getChannelData(0)), audio.ctx.sampleRate);
  buffer.push(samples);
  const win = vad.config.sileroVad.windowSize;
  while (buffer.size() > win) {
    const s = buffer.get(buffer.head(), win);
    vad.acceptWaveform(s);
    buffer.pop(win);
    if (fedLength + s.length > fed.length) {
      stopListening(`${MAX_RECORD_SEC}秒を超えたため`);
      setStatus('長すぎるため止めました。もう一度押してください');
      return;
    }
    fed.set(s, fedLength);
    fedLength += s.length;

    if (vad.isDetected() && !detected) {
      detected = true;
      setStatus('声を検出中…');
      log(`声を検出（聞き取り開始から ${sec(performance.now() - listenStarted)}）`);
    } else if (!vad.isDetected() && detected) {
      detected = false;
    }

    while (!vad.isEmpty()) {
      const segment = vad.front();
      vad.pop();
      const segmentAt = performance.now(); // 話し終わり（無音 MIN_SILENCE 秒）と判定された時
      const spoken = segment.samples.length / SAMPLE_RATE;
      setStatus('文字にしています…');
      // 区間の前後に余白を足す（後ろは「話し終わり」の判定待ちの間の音があるので足りる）
      const from = Math.max(0, segment.start - Math.round(PAD_BEFORE * SAMPLE_RATE));
      const to = Math.min(fedLength, segment.start + segment.samples.length + Math.round(PAD_AFTER * SAMPLE_RATE));
      const stream = recognizer.createStream();
      stream.acceptWaveform(SAMPLE_RATE, fed.slice(from, to));
      recognizer.decode(stream);
      const text = (recognizer.getResult(stream).text || '').trim();
      stream.free();
      const decodedAt = performance.now();
      showResult(text, spoken, decodedAt - segmentAt);
      if (text) {
        stopListening('認識できたため');
        setStatus('認識できました。もう一度試すときはボタンを押してください');
        return;
      }
      setStatus('言葉になりませんでした。続けて話してください');
    }
  }
}

function showResult(text, spokenSec, decodeMs) {
  const totalMs = MIN_SILENCE * 1000 + decodeMs;
  $('result').textContent = text || '（言葉になりませんでした）';
  $('metrics').textContent = '';
  const lines = [
    `話し終わってから文字になるまで：約 ${sec(totalMs)}`,
    `内訳：話し終わりの判定待ち（無音 ${MIN_SILENCE.toFixed(2)}秒）＋ 認識の計算 ${sec(decodeMs)}`,
    `話した長さ：${spokenSec.toFixed(2)}秒（認識の計算は話した長さの ${(decodeMs / 1000 / spokenSec).toFixed(2)} 倍）`,
  ];
  for (const l of lines) {
    const div = document.createElement('div');
    div.textContent = l;
    $('metrics').append(div);
  }
  log(`認識：「${text}」／ 話し終わり→文字 約 ${sec(totalMs)}（判定待ち ${MIN_SILENCE.toFixed(2)}秒 ＋ 計算 ${sec(decodeMs)}）／ 話した長さ ${spokenSec.toFixed(2)}秒`);
}

// ---- ボタン ----
$('asr').addEventListener('click', async () => {
  if (listening) {
    stopListening('ボタンが押されたため');
    setStatus('止めました');
    return;
  }
  if (loading) return; // 読み込み中の押下は無視する
  try {
    // マイクは押下の中で求める（await より前に AudioContext と getUserMedia を呼ぶ）
    const audioReady = ensureAudio();
    if (!engine) {
      loading = loadEngine();
      try {
        await audioReady;
        engine = await loading;
      } finally {
        loading = null;
      }
    } else {
      await audioReady;
    }
    await ensureAudio(); // 読み込みの間に止まっていれば再開する
    startListening();
  } catch (e) {
    $('progress').hidden = true;
    setStatus('失敗しました。記録を見てください');
    log(`${e.name || 'Error'}：${e.message}`, true);
    if (e.name === 'NotAllowedError') log('マイクの使用が許可されていません。設定でマイクを許可してください', true);
  }
});

$('copy').addEventListener('click', async () => {
  const text = logLines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log('記録をコピーしました');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    log('記録をコピーしました');
  }
});

log(`準備ができました（ページの読み込み ${sec(performance.now() - pageStart)}）。「聞き取りの試験」を押してください`);
