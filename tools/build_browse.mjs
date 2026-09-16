/* index.json / trend.*.json を data.html 用の軽い形にたたむ。
   行は配列にして、騎手名・調教師名はインデックス参照にする（コンビが7,600行あるため）。
   出力: data/nankan/browse.json                                            */
import { readJSON, writeJSON } from './lib/nk.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/nk.mjs';

const DB = readJSON('data/nankan/index.json');
const TRACKS = ['浦和', '船橋', '大井', '川崎'];
const r2 = x => Math.round((x || 0) * 100) / 100;
const r3 = x => Math.round((x || 0) * 1000) / 1000;

/* 騎手・調教師 */
const jKeys = Object.keys(DB.jockey).sort((a, b) => DB.jockey[b].n - DB.jockey[a].n);
const tKeys = Object.keys(DB.trainer).sort((a, b) => DB.trainer[b].n - DB.trainer[a].n);
const jIdxOf = Object.fromEntries(jKeys.map((k, i) => [k, i]));
const tIdxOf = Object.fromEntries(tKeys.map((k, i) => [k, i]));
const actorRow = x => [x.name, x.base, x.n, x.w, x.p3, r3(x.idx), r3(x.idx3), r3(x.form), r3(x.hot ?? 0), x.n1 || 0,
  TRACKS.map(t => (x.byTrack && x.byTrack[t] != null ? r2(x.byTrack[t]) : null))];

const jockey = jKeys.map(k => actorRow(DB.jockey[k]));
const trainer = tKeys.map(k => actorRow(DB.trainer[k]));

/* コンビ */
const combo = Object.values(DB.combo)
  .filter(c => jIdxOf[c.j] != null && tIdxOf[c.t] != null)
  .sort((a, b) => b.n - a.n)
  .map(c => [jIdxOf[c.j], tIdxOf[c.t], c.n, c.w, c.p3, r3(c.cIdx), r3(c.pairIdx), r3(c.bond), r3(c.bondJ),
    TRACKS.map(t => (c.byTrack && c.byTrack[t] ? c.byTrack[t] : null))]);

/* 馬主 */
const owner = Object.values(DB.owner).sort((a, b) => b.n - a.n)
  .map(o => [o.name, o.horses, o.entries, o.n, o.w, o.p3, r3(o.oIdx), r3(o.oIdx3), r3(o.oAgg)]);

/* 種牡馬・母の父 */
const DISTS = (DB.sireDist || []).map(Number);
const pedRow = x => [x.name, x.n, x.w, x.horses, x.wHorses, r3(x.idx), r3(x.form), x.prize,
  TRACKS.map(t => (x.byTrack && x.byTrack[t] ? [x.byTrack[t].n, x.byTrack[t].w, r2(x.byTrack[t].idx)] : null)),
  DISTS.map(d => (x.byDist && x.byDist[d] ? [x.byDist[d].n, x.byDist[d].w, r2(x.byDist[d].idx)] : null))];
const sire = Object.values(DB.sire || {}).sort((a, b) => b.n - a.n).map(pedRow);
const bms = Object.values(DB.bms || {}).sort((a, b) => b.n - a.n).map(pedRow);

/* 場・距離別の傾向 */
const trend = {};
for (const k of ['oi', 'kawasaki', 'funabashi', 'urawa']) {
  const p = path.join(ROOT, `data/nankan/trend.${k}.json`);
  if (!fs.existsSync(p)) continue;
  const t = JSON.parse(fs.readFileSync(p, 'utf8'));
  trend[t.track] = { calib: t.calib, fallback: t.fallback, trendRef: t.trendRef, meet: t.meet };
}

const out = {
  builtAt: DB.builtAt, source: DB.source, window: DB.window, pop: DB.pop, fit: DB.fit,
  tracks: TRACKS, dists: DISTS,
  cols: {
    actor: ['名前', '所属', '出走', '1着', '3着内', '指数', '3着内指数', '直近1年の増減', '直近3ヶ月', '直近1年出走', '場別指数'],
    combo: ['騎手', '調教師', '出走', '1着', '3着内', 'コンビ上振れ', '総合', '厩舎主戦度', '騎手主戦度', '場別'],
    owner: ['馬主', '所有頭数', '出走登録', '集計走数', '1着', '3着内', '勝率指数', '3着内指数', '勝負傾向'],
    ped: ['種牡馬', '出走', '1着', '出走頭数', '勝馬頭数', '指数', '直近1年の増減', '収得賞金', '場別', '距離別'],
  },
  jockey, trainer, combo, owner, sire, bms, trend,
};
writeJSON('data/nankan/browse.json', out);
console.error(`騎手 ${jockey.length} / 調教師 ${trainer.length} / コンビ ${combo.length} / 馬主 ${owner.length} / 種牡馬 ${sire.length} / 母の父 ${bms.length}`);
console.error(`圧縮後 ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
