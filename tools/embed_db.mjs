/* data/nankan/races.*.json を sim.html の NKDB マーカーの間に埋め込む。
   1ファイル・依存ゼロを保つための最後の工程。実行後は node --check で構文確認すること。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON } from './lib/nk.mjs';
import { inject } from './lib/embed.mjs';
import { raceExtras } from './lib/nkresults.mjs';

/* ボートレース版（boat.html）。tools/build_boat.mjs の today.json を NKBOAT に埋める。
   NK_EMBED_ONLY=boat なら南関側は触らずこれだけ行う（refresh_boat.mjs が使う） */
function embedBoat() {
  try { inject('boat.html', 'NKBOAT', 'NKBOAT', readJSON('data/boat/today.json')); }
  catch (e) { console.error('  (boat.html はスキップ: ' + e.message + ')'); }
  /* TOP のボート面。南関の NKTOP とは別のマーカーなので、どちらの refresh が先に書いても壊れない */
  try { inject('top.html', 'NKBOATTOP', 'NKBT2', readJSON('data/boat/top.json')); }
  catch (e) { console.error('  (top.html のボート面はスキップ: ' + e.message + ')'); }
  try { inject('top.html', 'NKBOATREC', 'NKBR2', readJSON('data/boat/results.json')); }
  catch (e) { console.error('  (top.html のボート成績はスキップ: ' + e.message + ')'); }
}
/* JRA 版（jra.html）。tools/jra_build_races.mjs の races.json を NKJRA に埋める */
function embedJra() {
  try { inject('jra.html', 'NKJRA', 'NKJRA', readJSON('data/jra/races.json')); }
  catch (e) { console.error('  (jra.html はスキップ: ' + e.message + ')'); }
  try { inject('top.html', 'NKJRATOP', 'NKJT', readJSON('data/jra/top.json')); }
  catch (e) { console.error('  (top.html の中央競馬面はスキップ: ' + e.message + ')'); }
  try { inject('top.html', 'NKJRAREC', 'NKJR2', readJSON('data/jra/results.json')); }
  catch (e) { console.error('  (top.html の中央競馬の成績はスキップ: ' + e.message + ')'); }
}
/* ばんえい版（banei.html）。tools/banei_build_races.mjs の races.json を NKBANEI に埋める */
function embedBanei() {
  try { inject('banei.html', 'NKBANEI', 'NKBANEI', readJSON('data/banei/races.json')); }
  catch (e) { console.error('  (banei.html はスキップ: ' + e.message + ')'); }
  try { inject('top.html', 'NKBANEITOP', 'NKBNT', readJSON('data/banei/top.json')); }
  catch (e) { console.error('  (top.html のばんえい面はスキップ: ' + e.message + ')'); }
  try { inject('top.html', 'NKBANEIREC', 'NKBNR', readJSON('data/banei/results.json')); }
  catch (e) { console.error('  (top.html のばんえい成績はスキップ: ' + e.message + ')'); }
}
if (process.env.NK_EMBED_ONLY === 'boat') { embedBoat(); process.exit(0); }
if (process.env.NK_EMBED_ONLY === 'jra') { embedJra(); process.exit(0); }
if (process.env.NK_EMBED_ONLY === 'banei') { embedBanei(); process.exit(0); }

const TRACKS = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki,船橋:funabashi,浦和:urawa').split(',').map(s => s.split(':')[1]);
const out = {};
for (const k of TRACKS) {
  const d = readJSON(`data/nankan/races.${k}.json`);
  out[k] = { days: d.days, real: d.real };
  try { const t = readJSON(`data/nankan/trend.${k}.json`); out[k].trend = { trendRef: t.trendRef, fallback: t.fallback, calib: t.calib, meet: t.meet }; }
  catch { console.error(`  (trend.${k}.json なし。傾向は既定値になる)`); }
  out.meta = d.meta;
}
const idx = readJSON('data/nankan/index.json');
out.meta = {
  ...out.meta,
  pop: idx.pop, fit: idx.fit, window: idx.window,
  counts: { jockey: Object.keys(idx.jockey).length, trainer: Object.keys(idx.trainer).length, combo: Object.keys(idx.combo).length, owner: Object.keys(idx.owner).length },
};

inject('sim.html', 'NKDB', 'NKDATA', out);

/* 出馬表ページ（race.html）: 前5走まで入った詳しい方 */
try {
  const ent = { meta: out.meta };
  for (const k of TRACKS) {
    const d = readJSON(`data/nankan/entries.${k}.json`);
    ent[k] = { track: d.track, days: d.days, entries: d.entries };
  }
  Object.assign(ent, raceExtras(TRACKS));          // 日別の集計と開催ごとの結果（build_marks と同じ）
  inject('race.html', 'NKRACE', 'NKR', ent);
} catch (e) { console.error('  (race.html はスキップ: ' + e.message + ')'); }

try { inject('data.html', 'NKBROWSE', 'NKB', readJSON('data/nankan/browse.json')); }
catch (e) { console.error('  (data.html はスキップ: ' + e.message + ')'); }
try { inject('marks.html', 'NKMR', 'NKMR', readJSON('data/nankan/marksrec.json')); }
catch (e) { console.error('  (marks.html はスキップ: ' + e.message + ')'); }
try { inject('top.html', 'NKTOP', 'NKT', readJSON('data/nankan/top.json')); }
catch (e) { console.error('  (top.html はスキップ: ' + e.message + ')'); }
try {
  const bt = readJSON('data/nankan/backtest.json');
  // レース明細は全部載せると重い。集計はそのまま、明細は直近ぶんだけ埋め込む
  const N = Number(process.env.NK_BT_DETAIL || 80);
  for (const t of Object.values(bt.tracks || {})) {
    if (t.detail) { t.detailAll = t.detail.length; t.detail = t.detail.slice(-N); }
    // 日別テーブルが使うのは model/pop だけ。予想手法ごとの日別は重いので落とす
    for (const d of t.days || []) for (const k of Object.keys(d)) if (!['date', 'races', 'model', 'pop'].includes(k)) delete d[k];
  }
  inject('data.html', 'NKBT', 'NKBT', bt);
} catch (e) { console.error('  (バックテストはスキップ: ' + e.message + ')'); }
embedBoat();
embedJra();
embedBanei();
