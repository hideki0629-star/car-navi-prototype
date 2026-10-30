// 言葉の解釈（commands.js）と会話の流れ（dialog.js）の試験。
// 地図・検索・位置・保存は偽の部品に置き換え、外部へは一切通信しない。

import { parse, extractFilters, parseChoice } from '../js/commands.js';
import { Conversation } from '../js/dialog.js';
import { canonicalName } from '../js/favorites.js';
import { googleAppUrl, googleWebUrl, appleUrl } from '../js/nav.js';

const results = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  results.push({ name, ok: a === e, detail: a === e ? '' : `\n    期待: ${e}\n    実際: ${a}` });
}

// ---- 言葉の解釈 ----

check('ナビ：基本', (({ type, destination, waypoints }) => ({ type, destination, waypoints }))(parse('佐賀駅までナビして')),
  { type: 'navigate', destination: '佐賀駅', waypoints: [] });
check('ナビ：経由地', (({ destination, waypoints }) => ({ destination, waypoints }))(parse('コンビニに寄って東京駅までナビして')),
  { destination: '東京駅', waypoints: ['コンビニ'] });
check('ナビ：経由地2つ', parse('実家に寄って職場を経由して自宅までナビして').waypoints, ['実家', '職場']);
check('ナビ：「案内して」', parse('自宅まで案内して').destination, '自宅');
check('ナビ：空白・句読点を無視', parse('佐賀駅 まで、ナビして。').destination, '佐賀駅');

check('絞り込み：県とカテゴリー', (({ prefecture, category, rest }) => ({ prefecture, category: category && category.key, rest }))(extractFilters('佐賀県のテーマパーク')),
  { prefecture: '佐賀県', category: 'theme_park', rest: '' });
check('絞り込み：県を省いた言い方', extractFilters('佐賀のラーメン屋').prefecture, '佐賀県');
check('絞り込み：「近く」', extractFilters('近くのコンビニ').near, true);
check('絞り込み：「一番近い」', extractFilters('一番近いガソリンスタンド').near, true);
check('絞り込み：県だけ', (({ prefecture, category }) => ({ prefecture, category }))(extractFilters('長崎県')), { prefecture: '長崎県', category: null });
check('絞り込み：場所の名前は残る', extractFilters('東京都の東京タワー').rest, '東京タワー');

check('選択：一番', parseChoice('一番'), 0);
check('選択：2番', parseChoice('2番'), 1);
check('選択：全角３番', parseChoice('３番'), 2);
check('選択：三つ目', parseChoice('三つ目'), 2);
check('選択：関係ない言葉', parseChoice('温泉'), null);

check('はい', parse('はい').type, 'yes');
check('お願いします', parse('お願いします').type, 'yes');
check('いいえ', parse('いいえ').type, 'no');
check('違う', parse('違う').type, 'no');
check('やめ', parse('やめ').type, 'cancel');
check('やめて', parse('やめて').type, 'cancel');
check('最初から', parse('最初から').type, 'restart');
check('もっと', parse('もっと').type, 'more');
check('「止めて」は取り消しにしない（第2段階で再生の停止に使う）', parse('止めて').type === 'cancel', false);

check('登録：ここ', (({ type, name, here }) => ({ type, name, here }))(parse('ここを実家に登録して')), { type: 'register', name: '実家', here: true });
check('登録：名前で', (({ name, here, query }) => ({ name, here, query }))(parse('市役所を職場として登録')), { name: '職場', here: false, query: '市役所' });
check('削除', (({ type, name }) => ({ type, name }))(parse('実家の登録を消して')), { type: 'delete', name: '実家' });

check('言い方のゆれ：家→自宅', canonicalName('家'), '自宅');
check('言い方のゆれ：会社→職場', canonicalName('会社'), '職場');

// ---- 地図アプリのURL ----

check('Googleアプリ：経由地つき', googleAppUrl({ text: '東京駅' }, [{ text: 'A' }]), 'comgooglemaps://?daddr=A+to:%E6%9D%B1%E4%BA%AC%E9%A7%85&directionsmode=driving');
check('GoogleURL：座標', googleWebUrl({ lat: 35.5, lon: 135.5 }, []).includes('destination=35.5%2C135.5'), true);
check('GoogleURL：経由地', googleWebUrl({ text: 'B' }, [{ text: 'A1' }, { text: 'A2' }]).includes('waypoints=A1%7CA2'), true);
check('Appleマップ：目的地', appleUrl({ text: '自宅' }), 'https://maps.apple.com/?daddr=%E8%87%AA%E5%AE%85&dirflg=d');

// ---- 会話の流れ ----

function makeWorld({ stopped = true, position = { lat: 35.5, lon: 135.5 }, homeMode = 'google', mapApp = 'google', categoryResults = null } = {}) {
  const world = { said: [], opened: [], favs: {}, searches: [], stopped, position };
  const favs = {
    get: (n) => world.favs[canonicalName(n)] || null,
    put: (n, p) => { world.favs[canonicalName(n)] = { ...p }; return true; },
    remove: (n) => { delete world.favs[canonicalName(n)]; return true; },
    all: () => world.favs,
  };
  const sample = (n) => Array.from({ length: n }, (_, i) => ({ label: `候補${i + 1}`, lat: 35 + i / 100, lon: 135, address: '', distance: 1000 * (i + 1) }));
  world.conv = new Conversation({
    speak: async (t) => { world.said.push(t); },
    openMap: (plan, app) => { world.opened.push({ plan, app }); },
    places: {
      searchCategory: async (q) => { world.searches.push(q); return categoryResults ? categoryResults : sample(5); },
      searchName: async () => sample(2),
      reverse: async () => 'テスト県テスト市一丁目',
      fillAddress: async (p) => { p.address = p.address || 'テスト県テスト市'; return p; },
    },
    favorites: favs,
    location: { isStopped: () => world.stopped, currentPosition: async () => world.position },
    settings: () => ({ homeMode, mapApp, stopSpeedKmh: 5 }),
  });
  world.say = async (t) => { await world.conv.handle(t); return world.said[world.said.length - 1]; };
  return world;
}

async function flows() {
  {
    const w = makeWorld();
    const q = await w.say('佐賀駅までナビして');
    check('流れ：確認してから案内', [q, w.opened.length], ['佐賀駅まで案内します。よろしいですか。', 0]);
    await w.say('はい');
    check('流れ：「はい」で地図を開く', w.opened.map((o) => o.plan.destination), [{ text: '佐賀駅' }]);
  }
  {
    const w = makeWorld();
    await w.say('佐賀駅までナビして');
    const a = await w.say('いいえ');
    check('流れ：「いいえ」なら開かない', [a, w.opened.length], ['もう一度、行き先を言ってください。', 0]);
  }
  {
    const w = makeWorld();
    await w.say('佐賀駅までナビして');
    await w.say('えーと');
    await w.say('うーん');
    const a = await w.say('ふむ');
    check('流れ：3回わからなければやめる', [a, w.conv.state.name, w.opened.length], ['うまく聞き取れなかったので、やめました。', 'ready', 0]);
  }
  {
    const w = makeWorld();
    const q = await w.say('自宅までナビして');
    check('流れ：自宅はGoogleの登録を試す', q, 'Googleマップに登録された自宅まで案内します。よろしいですか。');
  }
  {
    const w = makeWorld({ homeMode: 'ask' });
    const q = await w.say('自宅までナビして');
    check('流れ：自宅が未登録なら登録を案内', q.startsWith('自宅はまだ登録されていません'), true);
  }
  {
    const w = makeWorld();
    const q = await w.say('ラーメン屋までナビして');
    check('流れ：県が無ければ一問だけ聞き返す', q, 'どの県で探しますか。近くでよければ、「近く」と言ってください。');
    const list = await w.say('佐賀県');
    check('流れ：3件まで読む', list, '5件見つかりました。近い順に3件読みます。1番、候補1、1.0キロ。2番、候補2、2.0キロ。3番、候補3、3.0キロ。番号で選んでください。ほかの候補は、「もっと」と言ってください。');
    check('流れ：検索の条件', (({ category, prefecture }) => ({ category, prefecture }))(w.searches[0]), { category: 'ramen', prefecture: '佐賀県' });
    const more = await w.say('もっと');
    // 選ぶのは常に「一番・二番・三番」なので、次のページも1番から読む
    check('流れ：「もっと」で次の候補', more, '1番、候補4、4.0キロ。2番、候補5、5.0キロ。番号で選んでください。');
    // 2ページ目では「一番」がそのページの1件目（候補4）になる
    const c = await w.say('一番');
    check('流れ：選んだ場所の名前と所在地を確認', c, '候補4、テスト県テスト市。ここまで案内しますか。');
    await w.say('はい');
    check('流れ：選んだ場所の座標で案内', w.opened[0].plan.destination, { lat: 35.03, lon: 135, label: '候補4' });
  }
  {
    const w = makeWorld();
    const q = await w.say('佐賀県までナビして');
    check('流れ：県だけなら種類を聞き返す', q, 'どんな種類の場所ですか。例えば、道の駅、温泉、ラーメン屋です。');
    await w.say('温泉');
    check('流れ：県と種類で探す', (({ category, prefecture }) => ({ category, prefecture }))(w.searches[0]), { category: 'onsen', prefecture: '佐賀県' });
  }
  {
    const w = makeWorld();
    await w.say('近くのコンビニまでナビして');
    await w.say('長崎県の');
    check('流れ：候補を聞いた後で県を言い足して探し直す', w.searches.map((s) => s.prefecture || null), [null, '長崎県']);
  }
  {
    const w = makeWorld();
    await w.say('近くのコンビニまでナビして');
    const a = await w.say('やめ');
    check('流れ：「やめ」でいつでも戻る', [a, w.conv.state.name], ['やめました。', 'ready']);
  }
  {
    const w = makeWorld({ categoryResults: [] });
    const a = await w.say('近くの道の駅までナビして');
    check('流れ：見つからないとき', a, '近くの道の駅は見つかりませんでした。県や種類を変えて、もう一度言ってください。');
  }
  {
    const w = makeWorld();
    const q = await w.say('ここを実家に登録して');
    check('流れ：登録前に場所を読み上げて確認', q, '現在地、テスト県テスト市一丁目を、実家として登録します。この場所でいいですか。');
    const a = await w.say('はい');
    check('流れ：登録の保存', [a, !!w.favs['実家']], ['実家を登録しました。「実家までナビして」で案内できます。', true]);
    const n = await w.say('実家までナビして');
    check('流れ：登録した場所へ案内', n, '実家、テスト県テスト市一丁目まで案内します。よろしいですか。');
    await w.say('はい');
    check('流れ：登録した座標を渡す', w.opened[0].plan.destination, { lat: 35.5, lon: 135.5, label: '実家' });
  }
  {
    const w = makeWorld();
    await w.say('ここを家に登録して');
    await w.say('はい');
    const q = await w.say('自宅までナビして');
    check('流れ：自宅を声で登録したら、その場所を使う', q, '自宅、テスト県テスト市一丁目まで案内します。よろしいですか。');
  }
  {
    const w = makeWorld();
    const q = await w.say('佐賀城を職場に登録して');
    check('流れ：名前で登録（候補が複数なら選ぶ）', q.startsWith('2件見つかりました。'), true);
    const c = await w.say('二番');
    check('流れ：選んだ候補を確認', c, '候補2、テスト県テスト市を、職場として登録します。この場所でいいですか。');
  }
  {
    const w = makeWorld({ stopped: false });
    const a = await w.say('ここを実家に登録して');
    check('流れ：走行中は登録しない', [a, Object.keys(w.favs).length], ['安全のため、登録は停車中にしてください。', 0]);
  }
  {
    const w = makeWorld();
    await w.say('ここを実家に登録して');
    w.stopped = false;
    const a = await w.say('はい');
    check('流れ：確認中に走り出したら登録しない', [a, Object.keys(w.favs).length], ['走行中のため、登録をやめました。停車中にもう一度言ってください。', 0]);
  }
  {
    const w = makeWorld();
    w.favs['実家'] = { label: '現在地', lat: 1, lon: 2, address: 'どこか' };
    const q = await w.say('実家の登録を消して');
    check('流れ：削除の確認', q, '実家の登録を削除します。よろしいですか。');
    await w.say('はい');
    check('流れ：削除', Object.keys(w.favs), []);
  }
  {
    const w = makeWorld();
    const q = await w.say('実家に寄って佐賀駅までナビして');
    check('流れ：未登録の経由地は言葉のまま', q, '実家に寄って、佐賀駅まで案内します。よろしいですか。');
  }
  {
    const w = makeWorld({ mapApp: 'apple' });
    await w.say('コンビニに寄って佐賀駅までナビして');
    await w.say('はい');
    check('流れ：Appleマップでは経由地を渡せないと伝える', w.said.includes('Appleマップには経由地を渡せないため、目的地だけで案内します。'), true);
  }
}

await flows();

const failed = results.filter((r) => !r.ok);
document.getElementById('summary').textContent = `${results.length}件中 ${results.length - failed.length}件 合格、${failed.length}件 不合格`;
document.getElementById('summary').className = failed.length ? 'fail' : 'pass';
document.getElementById('out').innerHTML = results
  .map((r) => `<span class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '合格' : '不合格'}</span> ${r.name}${r.detail.replace(/</g, '&lt;')}`)
  .join('\n');
document.title = failed.length ? `不合格 ${failed.length}` : '全件合格';
