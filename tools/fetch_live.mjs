/* 当日ぶんの直前情報とオッズを取る。過去の蓄積は od2（公式ダウンロード）側の担当で、
   ここは「発走の30分前にしか出ない情報」だけを拾う。
     直前情報 … 展示タイム・チルト・部品交換・調整重量・スタート展示（進入とST）・水面気象
     オッズ   … 単勝/複勝（oddstf）と3連単120通り（odds3t）
   叩きすぎると 200 のまま「システムエラー」ページが返るので、必ず間隔をあけて少しずつ。
     BT_DATE      … 対象日（既定 今日）
     BT_LEAD      … 締切の何分前からオッズを取るか（既定 8）
     BT_LIVE_MAX  … 1周回で取るレース数の上限（既定 12）
     BT_LIVE_ONCE … 1周回で終了（既定。空にすると締切まで見張り続ける）
   出力: data/boat/live.<date>.json（直前情報・最新オッズ）と odds_live.jsonl（締切前の記録） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, get, freshTtl, VNAME, ymdOf } from './lib/bt.mjs';
import { parseBefore, parseOddsTF, parseOdds3T, parseRaceIndex } from './lib/web.mjs';

const DATE = process.env.BT_DATE || ymdOf(new Date());
const LEAD = Number(process.env.BT_LEAD || 8);
const MAX = Number(process.env.BT_LIVE_MAX || 12);
const OUT = path.join(ROOT, 'data', 'boat');
const LIVE = path.join(OUT, `live.${DATE}.json`);
const JL = path.join(OUT, 'odds_live.jsonl');
const LOCK = path.join(OUT, '.live.lock');
fs.mkdirSync(OUT, { recursive: true });

/* 多重起動を防ぐ（南関側で、重なった結果サイトを叩きすぎて止まった） */
if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 10 * 60000) {
  console.error('前の周回がまだ動いている。何もしない'); process.exit(0);
}
fs.writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch { } });

const B = 'https://www.boatrace.jp/owpc/pc/race/';
const state = fs.existsSync(LIVE) ? JSON.parse(fs.readFileSync(LIVE, 'utf8')) : { date: DATE, races: {} };

/* 開催場は「本日のレース」から拾う */
const idx = await get(`${B}index?hd=${DATE}`, { ttlDays: freshTtl(DATE, 30) });
const jcds = [...new Set([...idx.matchAll(/jcd=(\d\d)/g)].map(m => m[1]))].sort();
console.error(`${DATE} 開催 ${jcds.length}場: ${jcds.map(j => VNAME[j]).join(' ')}`);

/* 締切予定時刻は番組表（B ファイル）にもあるが、当日ぶんは Web の1枚目テーブルが確実 */
const now = new Date();
const minsTo = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = new Date(now); t.setHours(h, m, 0, 0);
  return (t - now) / 60000;
};

const todo = [];
for (const jcd of jcds) {
  /* 節の日数と今日が何日目か（開催情報ページ。1日1回で足りる） */
  if (!state.meet?.[jcd]) {
    try {
      const mi = parseRaceIndex(await get(`${B}raceindex?jcd=${jcd}&hd=${DATE}`, { ttlDays: 0.5 }), DATE);
      if (mi) ((state.meet ||= {})[jcd] = mi);
    } catch (e) { console.error(`  ! ${VNAME[jcd]} 開催情報が取れない: ${e.message}`); }
  }
  let closes = state.closes?.[jcd];
  if (!closes) {
    try {
      const html = await get(`${B}oddstf?rno=1&jcd=${jcd}&hd=${DATE}`, { ttlDays: freshTtl(DATE, 1) });
      closes = [...html.matchAll(/<td[^>]*>(\d{1,2}:\d{2})<\/td>/g)].map(m => m[1]).slice(0, 12);
    } catch (e) { console.error(`  ! ${VNAME[jcd]} 締切時刻が取れない: ${e.message}`); continue; }
    if (closes.length === 12) ((state.closes ||= {})[jcd] = closes);
  }
  closes.forEach((c, i) => {
    const left = minsTo(c);
    if (left < -2) return;                         // 締切済み
    todo.push({ jcd, r: i + 1, close: c, left });
  });
}
todo.sort((a, b) => a.left - b.left);
console.error(`  未締切 ${todo.length}R`);

let n = 0;
for (const t of todo) {
  if (n >= MAX) break;
  const key = `${t.jcd}|${t.r}`;
  const st = (state.races[key] ||= { jcd: t.jcd, venue: VNAME[t.jcd], r: t.r, close: t.close });
  const q = `rno=${t.r}&jcd=${t.jcd}&hd=${DATE}`;

  /* 直前情報は締切の約30分前に出る。出るまでは取りに行かない */
  if (!st.before?.published && t.left < 32) {
    try {
      const b = parseBefore(await get(`${B}beforeinfo?${q}`, { ttlDays: 0.002 }));
      st.before = b; n++;
      if (b.published) console.error(`  直前 ${VNAME[t.jcd]}${t.r}R 展示 ${b.boats.map(x => x.ex ?? '-').join('/')} 風${b.weather.wind}m 波${b.weather.wave}cm`);
    } catch (e) { console.error(`  ! 直前 ${VNAME[t.jcd]}${t.r}R ${e.message}`); }
  }

  /* オッズは締切 LEAD 分前に「締切前スナップショット」として残す。
     それ以外の時間帯も、まだ取っていなければ暫定として1回だけ取る */
  const snap = t.left <= LEAD && !st.snapAt;
  const first = !st.odds;
  if (snap || first) {
    try {
      const tf = parseOddsTF(await get(`${B}oddstf?${q}`, { ttlDays: 0.002 }));
      const t3 = parseOdds3T(await get(`${B}odds3t?${q}`, { ttlDays: 0.002 }));
      st.odds = { win: tf.win, place: tf.place, ex3: t3, at: new Date().toISOString(), left: Math.round(t.left) };
      n += 2;
      if (snap) {
        st.snapAt = st.odds.at;
        fs.appendFileSync(JL, JSON.stringify({ date: DATE, jcd: t.jcd, r: t.r, kind: 'T-' + LEAD, ...st.odds }) + '\n');
        console.error(`  締切${LEAD}分前 ${VNAME[t.jcd]}${t.r}R 単勝 ${Object.values(tf.win).join('/')}`);
      }
    } catch (e) { console.error(`  ! オッズ ${VNAME[t.jcd]}${t.r}R ${e.message}`); }
  }
}
state.at = new Date().toISOString();
fs.writeFileSync(LIVE, JSON.stringify(state));
console.error(`  ${n} ページ取得 -> data/boat/live.${DATE}.json (${(fs.statSync(LIVE).size / 1024).toFixed(0)} KB)`);
