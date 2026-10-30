// ブラウザ内の保存（localStorage）。外部サーバーへは送らない。
// プライベートブラウズなどで保存できない場合も、アプリが止まらないようにする。

const PREFIX = 'carnavi.v0.1.';

export function load(key, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function save(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}
