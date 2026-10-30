// 地図アプリへの受け渡し。Googleマップを優先し、開けなければAppleマップを使う。
// 行き先は { text } （言葉のまま渡す）か { lat, lon, label }（座標で渡す）。

const FALLBACK_MS = 3000; // この時間たってもこの画面が表示されたままなら、開けなかったとみなす

function placeParam(p) {
  return p.lat !== undefined ? `${p.lat},${p.lon}` : p.text;
}

// Googleマップのアプリ（URLスキーム）。経由地は「A+to:B」の形で並べる（実機で要確認）
export function googleAppUrl(destination, waypoints) {
  const daddr = [...waypoints, destination].map((p) => encodeURIComponent(placeParam(p))).join('+to:');
  return `comgooglemaps://?daddr=${daddr}&directionsmode=driving`;
}

// GoogleマップのURL（Maps URLs）。アプリが入っていれば渡される場合があり、無ければウェブで開く
export function googleWebUrl(destination, waypoints) {
  const params = new URLSearchParams({ api: '1', destination: placeParam(destination), travelmode: 'driving', dir_action: 'navigate' });
  if (waypoints.length) params.set('waypoints', waypoints.map(placeParam).join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}

// Appleマップ。経由地には対応しない（目的地だけを渡す）
export function appleUrl(destination) {
  const params = new URLSearchParams({ daddr: placeParam(destination), dirflg: 'd' });
  return `https://maps.apple.com/?${params}`;
}

// 地図アプリを開く。mapApp は 'google' / 'google-web' / 'apple'。
// onFallback は、Googleマップが開けずAppleマップに切り替える直前に呼ばれる。
export function openMap({ destination, waypoints = [] }, mapApp, { onFallback } = {}) {
  if (mapApp === 'apple') {
    window.location.href = appleUrl(destination);
    return { app: 'apple', droppedWaypoints: waypoints.length > 0 };
  }
  if (mapApp === 'google-web') {
    window.location.href = googleWebUrl(destination, waypoints);
    return { app: 'google-web', droppedWaypoints: false };
  }

  let handedOff = false;
  const onHide = () => {
    if (document.visibilityState === 'hidden') handedOff = true;
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onHide);
    if (handedOff) return;
    // 切り替えを読み上げ終わってから開く（onFallback が Promise を返せば待つ）
    Promise.resolve(onFallback && onFallback({ droppedWaypoints: waypoints.length > 0 }))
      .then(() => { window.location.href = appleUrl(destination); });
  }, FALLBACK_MS);
  window.location.href = googleAppUrl(destination, waypoints);
  return { app: 'google', droppedWaypoints: false };
}
