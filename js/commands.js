// 話した言葉を、アプリへの指示に変える。
// 画面やブラウザの機能には触らない（試験ページから単体で試せるようにするため）。

export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

// カテゴリー。words は聞き取りで出てきそうな言い方、key は検索側（places.js）で使う名前。
export const CATEGORIES = [
  { key: 'theme_park', label: 'テーマパーク', words: ['テーマパーク', '遊園地'] },
  { key: 'ramen', label: 'ラーメン屋', words: ['ラーメン屋', 'ラーメン店', 'ラーメン'] },
  { key: 'convenience', label: 'コンビニ', words: ['コンビニエンスストア', 'コンビニ'] },
  { key: 'michi_no_eki', label: '道の駅', words: ['道の駅'] },
  { key: 'onsen', label: '温泉', words: ['温泉', '日帰り温泉', '銭湯'] },
  { key: 'fuel', label: 'ガソリンスタンド', words: ['ガソリンスタンド', 'ガソスタ', '給油所'] },
  { key: 'toilets', label: 'トイレ', words: ['トイレ', 'お手洗い'] },
  { key: 'restaurant', label: 'レストラン', words: ['レストラン', '食堂', 'ご飯屋', 'ファミレス'] },
  { key: 'parking', label: '駐車場', words: ['駐車場', 'パーキング'] },
];

// 「近く」で探すことを表す言い方
const NEAR_WORDS = ['一番近い', 'いちばん近い', '近く', '近い', 'ちかく', 'この辺', 'このへん', '近所', '現在地', '周辺', 'ここから近い'];

// 文字のゆれをそろえる（全角英数→半角、空白と句読点を取る）
export function normalize(text) {
  return String(text || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　、。,.!?！？]/g, '')
    .trim();
}

// 県とカテゴリーと「近く」を言葉から取り出す。残りの言葉は rest に入れる。
export function extractFilters(text) {
  let rest = normalize(text);
  let prefecture = null;
  let category = null;
  let near = false;

  for (const p of PREFECTURES) {
    if (rest.includes(p)) {
      prefecture = p;
      rest = rest.replace(p, '');
      break;
    }
  }
  if (!prefecture) {
    // 「佐賀の」のように県を省いた言い方。誤検出を避けるため「の」が続くときだけ拾う
    for (const p of PREFECTURES) {
      const short = p.replace(/(都|府|県)$/, '');
      if (short !== p && rest.includes(short + 'の')) {
        prefecture = p;
        rest = rest.replace(short + 'の', '');
        break;
      }
    }
  }

  outer: for (const c of CATEGORIES) {
    for (const w of c.words) {
      if (rest.includes(w)) {
        category = c;
        rest = rest.replace(w, '');
        break outer;
      }
    }
  }

  for (const w of NEAR_WORDS) {
    if (rest.includes(w)) {
      near = true;
      rest = rest.replace(w, '');
      break;
    }
  }

  // 「の」「で」「にある」など、つなぎの言葉だけが残った場合は空にする
  rest = rest.replace(/^(の|で|にある)+/, '').replace(/(の|で|にある)+$/, '');
  return { prefecture, category, near, rest };
}

// 「一番」「2番」「三つ目」などを 0 始まりの番号にする。わからなければ null。
export function parseChoice(text) {
  const t = normalize(text);
  const table = [
    [/(一|1|いち|最初)(番|ばん|つ目|個目|の)/, 0],
    [/^(一|1|いち)$/, 0],
    [/(二|2|に)(番|ばん|つ目|個目)/, 1],
    [/^(二|2)$/, 1],
    [/(三|3|さん)(番|ばん|つ目|個目)/, 2],
    [/^(三|3)$/, 2],
  ];
  for (const [re, n] of table) {
    if (re.test(t)) return n;
  }
  return null;
}

const YES_RE = /^(はい|うん|ええ|お願い|おねがい|お願いします|ok|okay|オーケー|オッケー|そう|そうです|そうだね|いいよ|いいです|大丈夫|だいじょうぶ|よろしく|それで|それでいい|合ってる|あってる|正解|イエス|yes)/i;
const NO_RE = /^(いいえ|いや|違う|ちがう|違います|ちがいます|だめ|ダメ|ノー|no|間違い|まちがい)/i;
// 「止めて」は再生の停止（第2段階）に使うため、取り消しには含めない
const CANCEL_RE = /(やめ|キャンセル|中止|もういい)/;
const RESTART_RE = /(最初から|はじめから|初めから|やり直し|やりなおし)/;
const MORE_RE = /(もっと|ほかの|他の|次の候補|つぎの候補|次の3件|続き)/;

// 案内の指示：「〇〇までナビして」「〇〇に寄って△△までナビして」
const NAV_RE = /^(.+?)(まで|に|へ)(ナビして|ナビ|案内して|案内|連れてって|連れて行って|行って|いって|行きたい)(ください|ちょうだい)?$/;
const WAYPOINT_SPLIT_RE = /(に寄って|によって|に寄ってから|を経由して|経由で|経由して)/;

// 登録の指示：「ここを実家に登録して」「〇〇を職場として登録」
const REGISTER_RE = /^(.+?)を(.+?)(に|として)(登録|保存)(して|する|しといて)?(ください)?$/;
// 削除の指示：「実家の登録を消して」「実家を削除して」
const DELETE_RE = /^(.+?)(の登録|の場所)?を(消して|削除して|削除|消去して|取り消して)(ください)?$/;

const HERE_WORDS = ['ここ', '今いる場所', 'いまいる場所', '現在地', 'この場所'];

// 一つの発話を指示に変える。どの段階でも同じ解釈をし、段階ごとの扱いは app.js が決める。
export function parse(text) {
  const raw = String(text || '');
  const t = normalize(raw);
  if (!t) return { type: 'empty', raw };

  if (RESTART_RE.test(t)) return { type: 'restart', raw };
  if (CANCEL_RE.test(t) && t.length <= 8) return { type: 'cancel', raw };

  const reg = t.match(REGISTER_RE);
  if (reg) {
    const target = reg[1];
    const name = reg[2];
    return {
      type: 'register',
      name,
      here: HERE_WORDS.includes(target),
      query: HERE_WORDS.includes(target) ? null : target,
      raw,
    };
  }

  const del = t.match(DELETE_RE);
  if (del && !CANCEL_RE.test(del[1])) {
    return { type: 'delete', name: del[1], raw };
  }

  const nav = t.match(NAV_RE);
  if (nav) {
    const body = nav[1];
    const parts = body.split(WAYPOINT_SPLIT_RE).filter((s, i) => i % 2 === 0 && s);
    const destination = parts.pop();
    const waypoints = parts;
    return { type: 'navigate', destination, waypoints, filters: extractFilters(destination), raw };
  }

  const choice = parseChoice(t);
  if (choice !== null) return { type: 'choose', index: choice, raw };
  if (MORE_RE.test(t)) return { type: 'more', raw };
  if (NO_RE.test(t)) return { type: 'no', raw };
  if (YES_RE.test(t)) return { type: 'yes', raw };

  // どれにも当てはまらない言葉。聞き返しへの答え（県名、カテゴリー、場所の名前）として使われる
  return { type: 'free', text: t, filters: extractFilters(t), raw };
}
