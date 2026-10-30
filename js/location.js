// 現在地と、停車中かどうかの判断。
// 端末が速さを返さないときは、続けて取った2点の距離と時間から見積もる。

const STALE_MS = 30000; // これより古い位置は使わない

let last = null;      // { lat, lon, accuracy, time, speed }  speed は m/s または null
let watchId = null;

export function startWatching() {
  if (!('geolocation' in navigator) || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const now = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, time: pos.timestamp, speed: null };
      if (typeof pos.coords.speed === 'number' && pos.coords.speed >= 0) {
        now.speed = pos.coords.speed;
      } else if (last && now.time > last.time) {
        now.speed = distanceMeters(last, now) / ((now.time - last.time) / 1000);
      }
      last = now;
    },
    () => { /* 位置が取れないときは last を古いままにし、判断を「不明」にする */ },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
}

// 今の位置を一度だけ取る。取れなければ null
export function currentPosition() {
  if (last && Date.now() - last.time < STALE_MS) return Promise.resolve(last);
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, time: pos.timestamp, speed: null }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    );
  });
}

// 停車中なら true、走行中なら false、わからなければ null
export function isStopped(limitKmh) {
  if (!last || Date.now() - last.time > STALE_MS || last.speed === null) return null;
  return last.speed * 3.6 < limitKmh;
}

export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 読み上げ用の距離（「800メートル」「2.3キロ」）
export function distanceText(meters) {
  if (meters < 1000) return `${Math.round(meters / 100) * 100 || 100}メートル`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1)}キロ`;
  return `${Math.round(meters / 1000)}キロ`;
}
