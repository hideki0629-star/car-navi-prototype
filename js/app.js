// 全体をつなぐ。画面の表示、開始ボタン、設定画面（停車中だけ）を受け持つ。
// 会話の流れは dialog.js、音声は voice.js に任せる。

import { Voice, isSupported } from './voice.js';
import { Conversation } from './dialog.js';
import * as favorites from './favorites.js';
import * as places from './places.js';
import * as location from './location.js';
import { openMap } from './nav.js';
import { getSettings, setSetting } from './settings.js';

const $ = (id) => document.getElementById(id);
const logLines = [];

function log(text) {
  const time = new Date().toLocaleTimeString('ja-JP');
  logLines.unshift(`${time} ${text}`);
  logLines.length = Math.min(logLines.length, 200);
  if (!$('settings').hidden) $('log').textContent = logLines.join('\n');
}

function setStatus(text) {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = text === '案内開始' ? 'go' : (text === '聞き取り中' ? '' : 'confirm');
}

const voice = new Voice({
  onResult: (text) => {
    $('heard').textContent = text;
    conversation.handle(text).catch((e) => log(`処理の失敗: ${e.message}`));
  },
  onStateChange: ({ listening }) => $('mic').classList.toggle('on', listening),
  onFatal: (message) => {
    $('resume').hidden = false;
    setStatus('停止中');
    speak(message);
  },
  onLog: log,
});

function speak(text) {
  $('reply').textContent = text;
  return voice.speak(text);
}

const conversation = new Conversation({
  speak,
  openMap,
  places,
  favorites,
  location,
  settings: getSettings,
  onStatus: setStatus,
  log,
});

// ---- 画面のロックを防ぐ（対応していない端末では何もしない） ----
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    log(`画面ロック防止の失敗: ${e.message}`);
  }
}

// ---- 開始・停止 ----
$('start').addEventListener('click', async () => {
  $('start').hidden = true;
  $('main').hidden = false;
  location.startWatching();
  keepAwake();
  const support = isSupported();
  if (!support.recognition) {
    setStatus('音声認識なし');
    $('reply').textContent = 'このブラウザは音声認識に対応していません。設定の「文字で試す」で動作を確かめられます。';
    return;
  }
  voice.start();
  setStatus('聞き取り中');
  await speak('開始しました。行き先を言ってください。');
});

$('resume').addEventListener('click', () => {
  $('resume').hidden = true;
  voice.start();
  setStatus('聞き取り中');
  speak('聞き取りを再開しました。');
});

$('stop').addEventListener('click', () => {
  voice.stop();
  setStatus('停止中');
  $('resume').hidden = false;
});

// 地図アプリなどから戻ったとき：聞き取りと画面ロック防止をやり直す
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  log('画面に戻りました');
  voice.resume();
  if (!$('main').hidden) keepAwake();
});

// ---- 設定（停車中だけ） ----
function settingsAllowed() {
  return location.isStopped(getSettings().stopSpeedKmh) !== false;
}

function renderSettings() {
  const s = getSettings();
  for (const name of ['mapApp', 'homeMode']) {
    for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === s[name];
  }
  const list = $('fav-list');
  list.textContent = '';
  const entries = Object.entries(favorites.all());
  if (!entries.length) {
    const li = document.createElement('li');
    li.textContent = 'まだありません。声で「ここを実家に登録して」と言うと登録できます。';
    list.append(li);
  }
  for (const [name, fav] of entries) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = name;
    const addr = document.createElement('span');
    addr.className = 'addr';
    addr.textContent = fav.address || `${fav.lat.toFixed(5)}, ${fav.lon.toFixed(5)}`;
    text.append(addr);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'small';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      if (!settingsAllowed()) return closeSettings('走行中は操作できません。');
      if (window.confirm(`${name}を削除しますか？`)) {
        favorites.remove(name);
        renderSettings();
      }
    });
    li.append(text, del);
    list.append(li);
  }
  $('log').textContent = logLines.join('\n');
}

let settingsWatch = null;
function closeSettings(message) {
  $('settings').hidden = true;
  clearInterval(settingsWatch);
  if (message) speak(message);
}

$('open-settings').addEventListener('click', () => {
  if (!settingsAllowed()) {
    speak('走行中は設定を開けません。停車してから開いてください。');
    return;
  }
  renderSettings();
  $('settings').hidden = false;
  // 開いている間に走り出したら閉じる
  settingsWatch = setInterval(() => {
    if (!settingsAllowed()) closeSettings('走り出したので、設定を閉じました。');
  }, 2000);
});
$('close-settings').addEventListener('click', () => closeSettings());

for (const input of document.querySelectorAll('#settings input[type="radio"]')) {
  input.addEventListener('change', () => {
    if (!settingsAllowed()) return closeSettings('走行中は操作できません。');
    setSetting(input.name, input.value);
    log(`設定変更: ${input.name} = ${input.value}`);
  });
}

$('type-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('type-input').value.trim();
  if (!text) return;
  $('type-input').value = '';
  $('heard').textContent = text;
  log(`文字入力: ${text}`);
  conversation.handle(text).then(renderSettings).catch((e) => log(`処理の失敗: ${e.message}`));
});
