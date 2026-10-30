// お気に入りの場所。ブラウザ内にだけ保存する。
// 形：{ 名前: { label, address, lat, lon, savedAt } }

import { load, save } from './storage.js';

const KEY = 'favorites';

// Googleマップ側の登録（自宅・職場）をそのまま使えるかもしれない名前。
// 3-2：まず言葉をそのまま渡して試し、使えなければ声で登録する。
export const GOOGLE_LABELS = { '自宅': '自宅', '家': '自宅', 'うち': '自宅', '職場': '職場', '会社': '職場' };

// 言い方のゆれをそろえる（「家」「うち」は「自宅」、「会社」は「職場」として扱う）
export function canonicalName(name) {
  return GOOGLE_LABELS[name] || name;
}

export function all() {
  return load(KEY, {});
}

export function get(name) {
  return all()[canonicalName(name)] || null;
}

export function put(name, place) {
  const list = all();
  list[canonicalName(name)] = {
    label: place.label,
    address: place.address || '',
    lat: place.lat,
    lon: place.lon,
    savedAt: new Date().toISOString(),
  };
  return save(KEY, list);
}

export function remove(name) {
  const list = all();
  const key = canonicalName(name);
  if (!list[key]) return false;
  delete list[key];
  return save(KEY, list);
}
