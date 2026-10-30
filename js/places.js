// 場所の検索。最初の試作は OpenStreetMap（無料・キー不要）を使う。
//   カテゴリー検索：Overpass API
//   名前の検索・住所の取得：Nominatim
// あとで Google Places API などへ差し替えるときは、このファイルの公開関数
// （searchCategory / searchName / fillAddress / reverse）の形を保ったまま中身を替える。
// 利用規約により、短い間に大量に問い合わせないこと（声の操作1回につき数回まで）。

import { distanceMeters } from './location.js';

// 無料の公開サーバーは混雑すると 502・504 などを返すため、失敗したら次のサーバーで試す
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const TIMEOUT_MS = 20000;

// カテゴリーごとの OpenStreetMap の条件と、「近く」で探す範囲（メートル）
const CATEGORY_QUERIES = {
  theme_park: { selectors: ['["tourism"="theme_park"]'], radius: 60000 },
  ramen: { selectors: ['["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"ramen"]', '["amenity"="restaurant"]["name"~"ラーメン|らーめん|拉麺"]'], radius: 10000 },
  convenience: { selectors: ['["shop"="convenience"]'], radius: 5000 },
  michi_no_eki: { selectors: ['["name"~"^道の駅"]'], radius: 60000 },
  onsen: { selectors: ['["amenity"="public_bath"]', '["leisure"="spa"]["name"~"温泉"]'], radius: 40000 },
  fuel: { selectors: ['["amenity"="fuel"]'], radius: 10000 },
  toilets: { selectors: ['["amenity"="toilets"]'], radius: 5000 },
  restaurant: { selectors: ['["amenity"="restaurant"]'], radius: 5000 },
  parking: { selectors: ['["amenity"="parking"]'], radius: 3000 },
};

async function fetchJson(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`検索サービスの応答が異常です（${res.status}）`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sortByDistance(places, position) {
  if (!position) return places;
  for (const p of places) p.distance = distanceMeters(position, p);
  return places.sort((a, b) => a.distance - b.distance);
}

function addressFromOsmTags(tags) {
  if (tags['addr:full']) return tags['addr:full'];
  return [tags['addr:province'], tags['addr:city'], tags['addr:suburb'], tags['addr:quarter'], tags['addr:neighbourhood']]
    .filter(Boolean).join('');
}

function addressFromNominatim(a) {
  if (!a) return '';
  return [a.province || a.state, a.city || a.town || a.village || a.county, a.city_district || a.suburb || a.quarter || a.neighbourhood]
    .filter(Boolean).join('');
}

// カテゴリーで探す。prefecture があればその県の中、無ければ position の近くを探す。
// 戻り値：[{ label, lat, lon, address, distance }]（近い順。位置が無ければ検索結果の順）
export async function searchCategory({ category, prefecture, position, fallbackLabel }) {
  const q = CATEGORY_QUERIES[category];
  if (!q) throw new Error(`未対応のカテゴリーです：${category}`);
  let scope;
  let head = '';
  if (prefecture) {
    head = `area["name"="${prefecture}"]["boundary"="administrative"]["admin_level"="4"]->.a;`;
    scope = '(area.a)';
  } else if (position) {
    scope = `(around:${q.radius},${position.lat},${position.lon})`;
  } else {
    throw new Error('県も現在地もわからないため探せません');
  }
  const body = q.selectors.map((s) => `nwr${s}${scope};`).join('');
  const query = `[out:json][timeout:25];${head}(${body});out center tags 300;`;
  let data;
  let lastError;
  for (const url of OVERPASS_URLS) {
    try {
      data = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!data) throw lastError;
  const seen = new Set();
  const places = [];
  for (const el of data.elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const tags = el.tags || {};
    const label = tags['name:ja'] || tags.name || fallbackLabel || '名前の無い場所';
    const key = `${label}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({ label, lat, lon, address: addressFromOsmTags(tags) });
  }
  return sortByDistance(places, position);
}

// 名前で探す（お気に入りの登録などに使う）
export async function searchName(query, position) {
  const params = new URLSearchParams({ format: 'jsonv2', q: query, countrycodes: 'jp', limit: '10', 'accept-language': 'ja', addressdetails: '1' });
  const data = await fetchJson(`${NOMINATIM_URL}/search?${params}`);
  const places = data.map((d) => ({
    label: d.name || d.display_name.split(',')[0],
    lat: Number(d.lat),
    lon: Number(d.lon),
    address: addressFromNominatim(d.address),
  }));
  return sortByDistance(places, position);
}

// 緯度・経度から住所を取る
export async function reverse(lat, lon) {
  const params = new URLSearchParams({ format: 'jsonv2', lat: String(lat), lon: String(lon), zoom: '16', 'accept-language': 'ja', addressdetails: '1' });
  const d = await fetchJson(`${NOMINATIM_URL}/reverse?${params}`);
  return addressFromNominatim(d.address);
}

// 住所が空なら、緯度・経度から補う（読み上げて確認するため）。失敗しても止めない
export async function fillAddress(place) {
  if (place.address) return place;
  try {
    place.address = await reverse(place.lat, place.lon);
  } catch (e) {
    place.address = '';
  }
  return place;
}
