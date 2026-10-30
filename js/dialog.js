// 会話の流れ。一問一答で進め、案内・登録・削除はすべて読み上げて確認してから行う。
// 画面やブラウザの機能は、外から渡された部品（deps）を通してだけ使う。
// そのため試験ページでは、偽の部品を渡して流れだけを試せる。

import { parse } from './commands.js';
import { canonicalName, GOOGLE_LABELS } from './favorites.js';
import { distanceText } from './location.js';

const MAX_MISSES = 3;
const PAGE_SIZE = 3;

// 自宅・職場以外で、登録されていなければ案内できないと伝える名前
const LOCAL_ONLY_NAMES = ['実家'];

export class Conversation {
  // deps: { speak, openMap, places, favorites, location, settings, onStatus, log }
  constructor(deps) {
    this.d = deps;
    this.state = { name: 'ready' };
    this.busy = false;
    this.flow = 0; // 「やめ」で古い検索結果を捨てるための番号
  }

  setState(state) {
    this.state = { misses: 0, ...state };
    const status = {
      ready: '聞き取り中',
      confirmNav: '確認中',
      confirmPlace: '確認中',
      confirmRegister: '確認中',
      confirmDelete: '確認中',
      askPrefecture: '確認中',
      askCategory: '確認中',
      choose: '候補を選択中',
    }[state.name] || '聞き取り中';
    this.d.onStatus && this.d.onStatus(status);
  }

  async say(text) {
    await this.d.speak(text);
  }

  // 質問して、その答えを待つ状態にする
  async ask(state, prompt) {
    this.setState({ ...state, prompt });
    await this.say(prompt);
  }

  async toReady(message) {
    this.setState({ name: 'ready' });
    if (message) await this.say(message);
  }

  async handle(text) {
    const cmd = parse(text);
    if (cmd.type === 'empty') return;

    if (cmd.type === 'cancel') {
      this.flow += 1;
      this.busy = false;
      return this.toReady(this.state.name === 'ready' ? 'はい。' : 'やめました。');
    }
    if (cmd.type === 'restart') {
      this.flow += 1;
      this.busy = false;
      return this.toReady('最初からどうぞ。行き先を言ってください。');
    }
    if (this.busy) return; // 検索中の言葉は使わない（「やめ」「最初から」だけ受け付ける）

    // どの段階でも、新しい指示を言い直したらそちらを優先する
    if (cmd.type === 'navigate') return this.startNavigate(cmd);
    if (cmd.type === 'register') return this.startRegister(cmd);
    if (cmd.type === 'delete') return this.startDelete(cmd);

    const s = this.state;
    switch (s.name) {
      case 'confirmNav': return this.onConfirmNav(cmd);
      case 'confirmPlace': return this.onConfirmPlace(cmd);
      case 'confirmRegister': return this.onConfirmRegister(cmd);
      case 'confirmDelete': return this.onConfirmDelete(cmd);
      case 'askPrefecture': return this.onAskPrefecture(cmd);
      case 'askCategory': return this.onAskCategory(cmd);
      case 'choose': return this.onChoose(cmd);
      default:
        return this.say('行き先は、「何々までナビして」と言ってください。');
    }
  }

  // 答えがわからなかったとき。同じ質問をくり返し、続けてわからなければやめる
  async miss() {
    const s = this.state;
    s.misses = (s.misses || 0) + 1;
    if (s.misses >= MAX_MISSES) return this.toReady('うまく聞き取れなかったので、やめました。');
    await this.say(`すみません、もう一度お願いします。${s.prompt || ''}`);
  }

  stoppedOrWarn() {
    const stopped = this.d.location.isStopped(this.d.settings().stopSpeedKmh);
    // 速さがわからないとき（null）は受け付ける。実機で判断の確かさを確認する（試験記録 参照）
    return stopped !== false;
  }

  // ---- 目的地ナビ（3-1・3-1-2・3-2） ----

  async startNavigate({ destination, waypoints, filters }) {
    this.flow += 1;
    const wps = waypoints.map((w) => this.resolveSimple(w));
    const name = canonicalName(destination);
    const fav = this.d.favorites.get(name);

    if (fav) {
      const place = { lat: fav.lat, lon: fav.lon, label: name };
      return this.confirmNav({ destination: place, waypoints: wps, spokenDest: `${name}、${fav.address || fav.label}` });
    }
    if (GOOGLE_LABELS[destination]) {
      if (this.d.settings().homeMode === 'google') {
        return this.confirmNav({ destination: { text: name }, waypoints: wps, spokenDest: `Googleマップに登録された${name}` });
      }
      return this.toReady(`${name}はまだ登録されていません。停車中に「ここを${name}に登録して」と言うと登録できます。`);
    }
    if (LOCAL_ONLY_NAMES.includes(destination)) {
      return this.toReady(`${destination}はまだ登録されていません。停車中に「ここを${destination}に登録して」と言うと登録できます。`);
    }

    const f = filters;
    if (f.category) {
      return this.searchOrAsk({ purpose: 'nav', category: f.category, prefecture: f.prefecture, near: f.near, waypoints: wps });
    }
    if (f.prefecture && !f.rest) {
      return this.ask({ name: 'askCategory', purpose: 'nav', prefecture: f.prefecture, waypoints: wps },
        'どんな種類の場所ですか。例えば、道の駅、温泉、ラーメン屋です。');
    }
    const text = f.prefecture ? `${f.prefecture} ${f.rest}` : destination;
    return this.confirmNav({ destination: { text }, waypoints: wps, spokenDest: f.prefecture ? `${f.prefecture}の${f.rest}` : destination });
  }

  // 経由地：お気に入りなら座標、それ以外は言葉のまま渡す
  resolveSimple(text) {
    const fav = this.d.favorites.get(text);
    if (fav) return { lat: fav.lat, lon: fav.lon, label: canonicalName(text) };
    if (GOOGLE_LABELS[text] && this.d.settings().homeMode === 'google') return { text: canonicalName(text), label: canonicalName(text) };
    return { text, label: text };
  }

  async confirmNav({ destination, waypoints, spokenDest }) {
    const via = waypoints.length ? `${waypoints.map((w) => w.label).join('、')}に寄って、` : '';
    await this.ask({ name: 'confirmNav', plan: { destination, waypoints } }, `${via}${spokenDest}まで案内します。よろしいですか。`);
  }

  async onConfirmNav(cmd) {
    if (cmd.type === 'yes') return this.startGuidance(this.state.plan);
    if (cmd.type === 'no') return this.toReady('もう一度、行き先を言ってください。');
    return this.miss();
  }

  async startGuidance(plan) {
    const mapApp = this.d.settings().mapApp;
    this.setState({ name: 'ready' });
    this.d.onStatus && this.d.onStatus('案内開始');
    if (mapApp === 'apple' && plan.waypoints.length) {
      await this.say('Appleマップには経由地を渡せないため、目的地だけで案内します。');
    }
    await this.say('案内を始めます。地図アプリを開きます。');
    this.d.openMap(plan, mapApp, {
      onFallback: ({ droppedWaypoints }) =>
        this.say(`Googleマップを開けなかったので、Appleマップで開きます。${droppedWaypoints ? '経由地は渡せないため、目的地だけで案内します。' : ''}`),
    });
  }

  // ---- 絞り込み検索（3-1-2） ----

  async searchOrAsk(q) {
    if (!q.prefecture && !q.near) {
      return this.ask({ name: 'askPrefecture', ...q }, 'どの県で探しますか。近くでよければ、「近く」と言ってください。');
    }
    return this.runCategorySearch(q);
  }

  async onAskPrefecture(cmd) {
    const f = cmd.filters;
    if (cmd.type === 'free' && (f.prefecture || f.near)) {
      return this.runCategorySearch({ ...this.state, prefecture: f.prefecture, near: !f.prefecture && f.near, category: f.category || this.state.category });
    }
    return this.miss();
  }

  async onAskCategory(cmd) {
    const f = cmd.filters;
    if (cmd.type === 'free' && f.category) {
      return this.runCategorySearch({ ...this.state, category: f.category, prefecture: f.prefecture || this.state.prefecture });
    }
    return this.miss();
  }

  async runCategorySearch({ purpose, category, prefecture, near, waypoints }) {
    const flow = ++this.flow;
    this.busy = true;
    this.d.onStatus && this.d.onStatus('検索中');
    const where = prefecture ? `${prefecture}の` : '近くの';
    await this.say(`${where}${category.label}を探しています。`);
    let list;
    let position;
    try {
      position = await this.d.location.currentPosition();
      if (!prefecture && !position) {
        this.busy = false;
        if (flow !== this.flow) return;
        return this.ask({ name: 'askPrefecture', purpose, category, waypoints }, '現在地がわからないため、県を言ってください。');
      }
      list = await this.d.places.searchCategory({ category: category.key, prefecture, position, fallbackLabel: category.label });
    } catch (e) {
      this.busy = false;
      if (flow !== this.flow) return;
      this.d.log && this.d.log(`検索の失敗: ${e.message}`);
      return this.toReady('検索できませんでした。通信の状態を確かめて、もう一度言ってください。');
    }
    this.busy = false;
    if (flow !== this.flow) return; // 途中で「やめ」と言われた
    if (!list.length) {
      return this.toReady(`${where}${category.label}は見つかりませんでした。県や種類を変えて、もう一度言ってください。`);
    }
    this.setState({ name: 'choose', purpose, list, offset: 0, sorted: !!position, category, prefecture, waypoints });
    return this.readCandidates();
  }

  async readCandidates() {
    const s = this.state;
    const page = s.list.slice(s.offset, s.offset + PAGE_SIZE);
    const head = s.offset === 0
      ? `${s.list.length}件見つかりました。${s.sorted ? '近い順に' : ''}${page.length}件読みます。`
      : '';
    const items = page.map((p, i) => `${i + 1}番、${p.label}${p.distance !== undefined ? `、${distanceText(p.distance)}` : ''}。`).join('');
    const hasMore = s.offset + PAGE_SIZE < s.list.length;
    const tail = `番号で選んでください。${hasMore ? 'ほかの候補は、「もっと」と言ってください。' : ''}`;
    s.prompt = tail;
    s.misses = 0;
    await this.say(head + items + tail);
  }

  async onChoose(cmd) {
    const s = this.state;
    if (cmd.type === 'choose') {
      const place = s.list[s.offset + cmd.index];
      if (!place) return this.say(`その番号の候補はありません。${s.prompt}`);
      return this.choosePlace(place);
    }
    if (cmd.type === 'more') {
      if (s.offset + PAGE_SIZE >= s.list.length) return this.say('これ以上の候補はありません。番号で選んでください。');
      s.offset += PAGE_SIZE;
      return this.readCandidates();
    }
    // 自分から言い足した絞り込み（「佐賀県の」「温泉で」）で探し直す
    if (cmd.type === 'free' && s.purpose === 'nav' && s.category && (cmd.filters.prefecture || cmd.filters.category)) {
      return this.runCategorySearch({
        purpose: s.purpose,
        category: cmd.filters.category || s.category,
        prefecture: cmd.filters.prefecture || s.prefecture,
        near: !(cmd.filters.prefecture || s.prefecture),
        waypoints: s.waypoints,
      });
    }
    return this.miss();
  }

  async choosePlace(place) {
    const s = this.state;
    const flow = ++this.flow;
    this.busy = true;
    await this.d.places.fillAddress(place);
    this.busy = false;
    if (flow !== this.flow) return;
    if (s.purpose === 'register') return this.confirmRegister(s.favName, place);
    const where = place.address ? `、${place.address}` : '';
    await this.ask({ name: 'confirmPlace', place, waypoints: s.waypoints }, `${place.label}${where}。ここまで案内しますか。`);
  }

  async onConfirmPlace(cmd) {
    const s = this.state;
    if (cmd.type === 'yes') {
      return this.startGuidance({ destination: { lat: s.place.lat, lon: s.place.lon, label: s.place.label }, waypoints: s.waypoints });
    }
    if (cmd.type === 'no') return this.toReady('もう一度、行き先を言ってください。');
    return this.miss();
  }

  // ---- お気に入りの登録・削除（3-2） ----

  async startRegister({ name, here, query }) {
    this.flow += 1;
    const favName = canonicalName(name);
    if (!this.stoppedOrWarn()) return this.toReady('安全のため、登録は停車中にしてください。');

    const flow = this.flow;
    this.busy = true;
    try {
      const position = await this.d.location.currentPosition();
      if (here) {
        if (!position) {
          this.busy = false;
          return this.toReady('現在地がわかりませんでした。位置情報の許可を確かめてください。');
        }
        let address = '';
        try { address = await this.d.places.reverse(position.lat, position.lon); } catch (e) { /* 住所なしで確認する */ }
        this.busy = false;
        if (flow !== this.flow) return;
        return this.confirmRegister(favName, { label: '現在地', lat: position.lat, lon: position.lon, address });
      }
      this.d.onStatus && this.d.onStatus('検索中');
      const list = await this.d.places.searchName(query, position);
      this.busy = false;
      if (flow !== this.flow) return;
      if (!list.length) return this.toReady(`${query}は見つかりませんでした。`);
      if (list.length === 1) {
        this.setState({ name: 'choose', purpose: 'register', favName, list, offset: 0 });
        return this.choosePlace(list[0]);
      }
      this.setState({ name: 'choose', purpose: 'register', favName, list, offset: 0, sorted: !!position });
      return this.readCandidates();
    } catch (e) {
      this.busy = false;
      if (flow !== this.flow) return;
      this.d.log && this.d.log(`登録の検索の失敗: ${e.message}`);
      return this.toReady('検索できませんでした。通信の状態を確かめて、もう一度言ってください。');
    }
  }

  async confirmRegister(favName, place) {
    const overwrite = !!this.d.favorites.get(favName);
    const where = place.address ? `、${place.address}` : '';
    const note = overwrite ? `いまの${favName}の登録は上書きされます。` : '';
    await this.ask({ name: 'confirmRegister', favName, place },
      `${place.label}${where}を、${favName}として登録します。${note}この場所でいいですか。`);
  }

  async onConfirmRegister(cmd) {
    const s = this.state;
    if (cmd.type === 'yes') {
      if (!this.stoppedOrWarn()) return this.toReady('走行中のため、登録をやめました。停車中にもう一度言ってください。');
      const ok = this.d.favorites.put(s.favName, s.place);
      if (!ok) return this.toReady('保存できませんでした。プライベートブラウズでないか確かめてください。');
      return this.toReady(`${s.favName}を登録しました。「${s.favName}までナビして」で案内できます。`);
    }
    if (cmd.type === 'no') return this.toReady('登録をやめました。');
    return this.miss();
  }

  async startDelete({ name }) {
    this.flow += 1;
    const favName = canonicalName(name);
    if (!this.stoppedOrWarn()) return this.toReady('安全のため、削除は停車中にしてください。');
    if (!this.d.favorites.get(favName)) return this.toReady(`${favName}は登録されていません。`);
    await this.ask({ name: 'confirmDelete', favName }, `${favName}の登録を削除します。よろしいですか。`);
  }

  async onConfirmDelete(cmd) {
    const s = this.state;
    if (cmd.type === 'yes') {
      if (!this.stoppedOrWarn()) return this.toReady('走行中のため、削除をやめました。');
      this.d.favorites.remove(s.favName);
      return this.toReady(`${s.favName}の登録を削除しました。`);
    }
    if (cmd.type === 'no') return this.toReady('削除をやめました。');
    return this.miss();
  }
}
