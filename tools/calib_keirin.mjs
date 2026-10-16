/* 競輪の3連単の確率を、3連単オッズ（全通り）と合成して較正する → data/keirin/calib.json（ボートの calib_boat と同じ。式は lib/calib.mjs）
   モデルの確率は keirin_backtest と同じ作り（joint・段階モデル。model.json の検証期間＝学習に使っていないレース）。
   当てはめ … 検証期間のうち締切前スナップショットの無いレース（オッズは結果ページの確定値）
   検証     … 締切8分前のスナップショット（odds_live.jsonl、クラウド）があるレース。オッズはスナップショットに差し替える（実戦と同じ）
   本番の a・b は全部（確定＋スナップショット）で当て直した値。閾値はスナップショットのレースの合成期待値の分布 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON, eachLine } from './lib/kr.mjs';
import { FEATURES, NF, slim, buildAsOf, makeFeaturizer, stageCtx, combos } from './lib/krfeat.mjs';
import { utilities } from './lib/bpl.mjs';
import { sampleOf, fitMix, logloss, mixProbs, marketOf, fitDrift, adjOdds, driftRows, gradeCheck } from './lib/calib.mjs';
import { bestCombo, bestComboCal, thresholdsOf, gradeOf } from './lib/grade.mjs';

const M = readJSON('data/keirin/model.json');
const FROM = M.meta.split;
const beta = new Float64Array(NF), betaJ = new Float64Array(NF);
FEATURES.forEach((k, i) => { const j = M.meta.feats.indexOf(k); if (j >= 0) { beta[i] = M.base.beta[j]; if (M.joint) betaJ[i] = M.joint.beta[j]; } });

const SNAP = new Map();
for (const l of fs.readFileSync(path.join(ROOT, 'data/keirin/odds_live.jsonl'), 'utf8').split('\n')) { if (!l) continue; try { const o = JSON.parse(l); if (o.odds?.e3) SNAP.set(o.raceId, o); } catch { } }
const races = [];
eachLine('data/keirin/races.jsonl', l => {
  if (!/"result":\{/.test(l)) return;
  const d = (l.match(/"date":"(\d{8})"/) || [])[1];
  let r; try { r = JSON.parse(l); } catch { return; }
  if (!r.date || !r.riders?.length) return;
  const inTest = d >= FROM, s = inTest && SNAP.get(r.raceId);
  if (s) { r.odds = s.odds; r.snap = true; }
  const x = slim(r, inTest ? { pay: true, odds: true } : {}); x.snap = !!s;
  races.push(x);
});
races.sort((a, b) => a.date.localeCompare(b.date) || a.jcd.localeCompare(b.jcd) || a.r - b.r);
const ASOF = buildAsOf(races), featurize = makeFeaturizer(ASOF);

const rows = [];
for (const r of races) {
  if (r.date < FROM || !r.pay || !r.odds?.e3) continue;
  const f = featurize(r); if (!f || !f.order || f.order.some(i => i < 0)) continue;
  let U = utilities(f.rows.map(x => x.x), beta), tau = M.base.tau, stage = M.base.stage;
  if (M.joint && f.mkt) { U = utilities(f.rows.map(x => x.x), betaJ); tau = M.joint.tau; stage = M.joint.stage; }
  const nos = f.rows.map(x => x.no);
  const C = combos(U, tau, stageCtx(f), stage, nos);
  const q = marketOf(Object.fromEntries(Object.entries(r.odds.e3).filter(([, o]) => o > 0 && o < 9999))); if (!q) continue;
  const win = r.pay.e3?.[0]; if (!win) continue;
  const keys = [], pm = [], pq = [], od = [];
  for (const [k, p] of C.e3) { if (!q[k]) continue; keys.push(k); pm.push(p); pq.push(q[k]); od.push(r.odds.e3[k]); }
  const w = keys.indexOf(win.c); if (w < 0) continue;
  rows.push({ date: r.date, snap: r.snap, keys, pm, pq, od, w, pay: win.y, S: sampleOf(pm, pq, w) });
}
const tr = rows.filter(x => !x.snap), te = rows.filter(x => x.snap);
console.error(`当てはめ（確定オッズ）${tr.length}R ${tr[0]?.date}〜${tr.at(-1)?.date}／検証（締切8分前）${te.length}R`);
const fit = fitMix(tr.map(x => x.S));
const ll = (S, a, b) => +logloss(S, a, b).toFixed(4), teS = te.map(x => x.S);
const evalLL = { model: ll(teS, 1, 0), market: ll(teS, 0, 1), mix: ll(teS, fit.a, fit.b) };
console.error(`a=${fit.a.toFixed(3)} b=${fit.b.toFixed(3)}  検証の logloss：モデル ${evalLL.model}／市場 ${evalLL.market}／合成 ${evalLL.mix}`);

/* 段位の検証：確定オッズのレースで閾値を決め、締切8分前のスナップショットのレースで精算（calib_boat と同じ2通り）。
   オッズの動き（drift）は締切8分前と確定の両方があるスナップショットのレースでしか測れないので、
   スナップショットを前後半に分け、前半で drift を当てて後半で精算する */
const pickOf = (mix, drift) => x => {
  const p = mixProbs(x.pm, x.pq, mix);
  const list = x.keys.map((k, i) => ({ k, i, p: p[i], o: x.od[i], oa: adjOdds(x.od[i], p[i], x.pq[i], drift) }));
  const b = drift ? bestComboCal(list, '3連単') : bestCombo(list, '3連単'); if (!b) return null;
  const t = list.find(t => t.k === b.k); return { ...b, i: t.i, p: t.p, o: t.o, oa: t.oa };
};
const teA = te.slice(0, Math.floor(te.length / 2)), teB = te.slice(Math.floor(te.length / 2));
const driftTr = fitDrift(driftRows(teA, fit));
console.error(`オッズの動き（スナップショット前半 ${teA.length}R）：log(確定/T-8) = ${driftTr[0]} + ${driftTr[1]}·log(合成/市場) + ${driftTr[2]}·log(オッズ)`);
/* 閾値は「確定オッズのレース＋スナップショット前半」。確定オッズのレースに drift を当てるのは近似（確定オッズなので本来は動かない） */
const before = gradeCheck(tr.concat(teA), teB, pickOf(fit, null), thresholdsOf, gradeOf), after = gradeCheck(tr.concat(teA), teB, pickOf(fit, driftTr), thresholdsOf, gradeOf);
for (const [name, t] of [['期待値そのまま', before], ['オッズの動きを織り込み・上位10組', after]]) for (const g of ['S', 'A', 'B', 'C']) { const o = t.grades[g]; if (o) console.error(`  ${name} ${g}: ${o.n}R 的中${o.hit}（見込み${o.expHit}）回収${(o.roi * 100).toFixed(0)}%（見込み${(o.expRoi * 100).toFixed(0)}±${(o.sd * 100).toFixed(0)}%）`); }

const all = fitMix(rows.map(x => x.S), fit);
const drift = fitDrift(driftRows(te, all));
const thr = thresholdsOf((te.length >= 300 ? te : rows).map(x => pickOf(all, drift)(x)?.ev).filter(v => v != null));
writeJSON('data/keirin/calib.json', {
  builtAt: new Date().toISOString(), kind: '3連単', n: rows.length, from: rows[0].date, to: rows.at(-1).date,
  a: +all.a.toFixed(4), b: +all.b.toFixed(4), drift, topN: 10, thresholds: thr, thrSrc: te.length >= 300 ? 'snapshot' : 'all',
  check: { train: tr.length, test: te.length, a: +fit.a.toFixed(4), b: +fit.b.toFixed(4), drift: driftTr, logloss: evalLL, before, after },
  note: 'p(組) ∝ p_モデル^a × p_市場^b（p_市場＝3連単オッズの逆数を全通りで正規化）。期待値は p × 見込みの確定オッズ（drift、締切8分前のスナップショットで当てはめ）、最良の買い目は合成確率の上位 topN 組から。check は確定オッズのレースで当てはめ、締切8分前のスナップショットのレースで測った値',
});
console.error(`全部 a=${all.a.toFixed(3)} b=${all.b.toFixed(3)} drift=${drift} 閾値 ${JSON.stringify(thr)} → data/keirin/calib.json`);
