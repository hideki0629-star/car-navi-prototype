// 設定。停車中だけ画面から変えられる（画面側の制御は app.js）。

import { load, save } from './storage.js';

const KEY = 'settings';

const DEFAULTS = {
  // 地図アプリ：'google'（Googleマップ優先、開けなければAppleマップ）／'apple'（Appleマップのみ）
  mapApp: 'google',
  // 自宅・職場が未登録のとき：'google'（言葉をそのままGoogleマップに渡す）／'ask'（登録を促す）
  homeMode: 'google',
  // 停車中とみなす速さ（km/h 未満）
  stopSpeedKmh: 5,
};

export function getSettings() {
  return { ...DEFAULTS, ...load(KEY, {}) };
}

export function setSetting(name, value) {
  const s = getSettings();
  s[name] = value;
  save(KEY, s);
  return s;
}
