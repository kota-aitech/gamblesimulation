/* ばんえいの条件付きロジット（Plackett–Luce）を当てはめる → data/banei/model.json
   JRA（jra_fit.mjs）と同じ作り：
     base  … オッズを使わない基礎モデル（lib/bnfeat.mjs の特徴量）＋ 着順の段階ごとの温度（lib/bpl.mjs）
     joint … 市場の対数確率（mktLog）を特徴量に入れて同時に当てはめる（オッズの出たレース用）
     BN_FIT_SPLIT … 学習と検証を切る日付（既定 20260401）
     BN_FIT_WARM  … 履歴の助走期間（既定 データ先頭から6か月）
     BN_FIT_EPOCH / BN_FIT_LR / BN_FIT_L2 / BN_FIT_DROP */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON } from './lib/bn.mjs';
import { FEATURES, NF, MKT, buildRaceIndex, buildHistory, buildAsOf, loadPed, raceFromResult, makeFeaturizer } from './lib/bnfeat.mjs';
import { utilities, plWin, fitTau } from './lib/bpl.mjs';

const SPLIT = process.env.BN_FIT_SPLIT || '20260401';
const EPOCH = Number(process.env.BN_FIT_EPOCH || 300), LR = Number(process.env.BN_FIT_LR || 0.08), L2 = Number(process.env.BN_FIT_L2 || 1e-3);
const DROP = new Set((process.env.BN_FIT_DROP || '').split(',').map(s => s.trim()).filter(Boolean));
const DROPI = [...DROP].map(k => FEATURES.indexOf(k)).filter(i => i >= 0);
let DB = {}; try { DB = JSON.parse(fs.readFileSync(path.join(ROOT, process.env.BN_FIT_DB || 'data/banei/index.json'), 'utf8')); } catch { }

console.error('結果を読む…');
const results = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/banei/results.jsonl'), 'utf8').split('\n')) if (l) results.push(JSON.parse(l));
results.sort((a, b) => a.raceId.localeCompare(b.raceId));
const first = results[0].date;
const WARM = process.env.BN_FIT_WARM || (() => { const d = new Date(`${first.slice(0, 4)}-${first.slice(4, 6)}-${first.slice(6, 8)}`); d.setMonth(d.getMonth() + 6); return d.toISOString().slice(0, 10).replace(/-/g, ''); })();
const cardsFile = path.join(ROOT, 'data/banei/cards.jsonl');
const PED = loadPed(fs.existsSync(cardsFile) ? fs.readFileSync(cardsFile, 'utf8') : '');
const RI = buildRaceIndex(results), H = buildHistory(results, RI), ASOF = buildAsOf(results, PED);
console.error(`  ${results.length}R（${first}〜${results.at(-1).date}）血統 ${PED.size} 頭`);
const featurize = makeFeaturizer(DB, RI, ASOF);
const data = [];
for (const r of results) {
  if (r.date < WARM) continue;
  const race = raceFromResult(r, H);
  if (race.order.some(i => i < 0)) continue;
  const f = featurize(race);
  if (!f) continue;
  data.push({ raceId: f.raceId, date: f.date, X: f.rows.map(x => x.x), order: race.order, mkt: f.mkt });
}
const tr = data.filter(d => d.date < SPLIT), te = data.filter(d => d.date >= SPLIT);
console.error(`  学習 ${tr.length}R（${WARM}〜${SPLIT}）／検証 ${te.length}R`);
if (tr.length < 100) { console.error('学習データが足りない'); process.exit(1); }

function gradOne(X, order, beta, g) {
  const u = utilities(X, beta);
  const live = new Set(X.map((_, i) => i));
  let ll = 0;
  for (const win of order) {
    const idx = [...live], m = Math.max(...idx.map(i => u[i]));
    const e = idx.map(i => Math.exp(u[i] - m)), s = e.reduce((a, b) => a + b, 0);
    ll += u[win] - m - Math.log(s);
    for (let k = 0; k < NF; k++) { let exp = 0; idx.forEach((i, j) => { exp += (e[j] / s) * X[i][k]; }); g[k] += X[win][k] - exp; }
    live.delete(win);
  }
  return ll;
}
function fit(rows, drop = new Set()) {
  const beta = new Float64Array(NF), m = new Float64Array(NF), v = new Float64Array(NF), g = new Float64Array(NF);
  for (let ep = 1; ep <= EPOCH; ep++) {
    g.fill(0); let ll = 0;
    for (const d of rows) ll += gradOne(d.X, d.order, beta, g);
    for (let k = 0; k < NF; k++) {
      if (drop.has(k)) { beta[k] = 0; continue; }
      g[k] = g[k] / rows.length - L2 * beta[k];
      m[k] = 0.9 * m[k] + 0.1 * g[k]; v[k] = 0.999 * v[k] + 0.001 * g[k] * g[k];
      beta[k] += LR * (m[k] / (1 - 0.9 ** ep)) / (Math.sqrt(v[k] / (1 - 0.999 ** ep)) + 1e-8);
    }
    if (ep % 50 === 0) console.error(`    ep${ep} 対数尤度/R ${(ll / rows.length).toFixed(4)}`);
  }
  return beta;
}
function evaluate(rows, beta, tau = [1, 1], popOnly = false) {
  let ll = 0, hit1 = 0, in3 = 0, n = 0;
  const cal = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const d of rows) {
    let p = popOnly ? d.mkt : plWin(utilities(d.X, beta), tau[0]);
    if (!p) continue;
    const w = d.order[0];
    ll -= Math.log(Math.max(1e-9, p[w]));
    const rank = p.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    if (rank[0] === w) hit1++; if (rank.slice(0, 3).includes(w)) in3++; n++;
    p.forEach((v, i) => { const b = cal[Math.min(9, Math.floor(v * 10))]; b.p += v; b.y += i === w ? 1 : 0; b.n++; });
  }
  return { logloss: +(ll / n).toFixed(4), hit1: +(hit1 / n).toFixed(4), in3: +(in3 / n).toFixed(4), n, cal: cal.map(b => b.n ? { p: +(b.p / b.n).toFixed(3), y: +(b.y / b.n).toFixed(3), n: b.n } : null) };
}
const coefs = beta => [...beta].map((v, i) => [FEATURES[i], +v.toFixed(3)]).filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
const hold = tr.slice(Math.floor(tr.length * 0.8));

console.error('base（市場なし）を当てはめる…');
const beta = fit(tr, new Set([...DROPI, MKT]));
const tau = fitTau(hold.map(d => ({ U: utilities(d.X, beta), order: d.order })));
const ev = evaluate(te, beta, tau);
console.error(`  base: logloss ${ev.logloss}／1着的中 ${(ev.hit1 * 100).toFixed(1)}%／上位3頭 ${(ev.in3 * 100).toFixed(1)}%（温度 τ1 ${tau[0]}／τ2 ${tau[1]}）`);
console.error('  係数: ' + coefs(beta).slice(0, 16).map(([k, v]) => `${k} ${v}`).join(' / '));
console.error('  較正（予測→実際）: ' + ev.cal.filter(Boolean).map(b => `${(b.p * 100).toFixed(0)}→${(b.y * 100).toFixed(0)}`).join(' '));
/* 市場の見立て：単勝オッズは古い成績ページに無いので、人気順位ごとの勝率（lib/bnfeat.mjs の marketProbs）で代用する。
   それも無いレース（人気の欠け）は市場との比較と joint から外す */
const hasOdds = d => !!d.mkt;
const trO = tr.filter(hasOdds), teO = te.filter(hasOdds);
console.error(`  市場の見立てあり: 学習 ${trO.length}R／検証 ${teO.length}R`);
const popOnly = teO.length ? evaluate(teO, beta, tau, true) : null;
const baseO = teO.length ? evaluate(teO, beta, tau) : null;
if (popOnly) console.error(`  人気だけ: logloss ${popOnly.logloss}／1着的中 ${(popOnly.hit1 * 100).toFixed(1)}%／上位3頭 ${(popOnly.in3 * 100).toFixed(1)}%（同じ ${teO.length}R で base は ${baseO.logloss}／${(baseO.hit1 * 100).toFixed(1)}%／${(baseO.in3 * 100).toFixed(1)}%）`);
let joint = null;
if (!process.env.BN_FIT_NOJOINT && trO.length >= 200 && teO.length >= 30) {
  console.error('joint（市場＋全特徴量。オッズのあるレースだけ）を当てはめる…');
  const bj = fit(trO, new Set(DROPI));
  const holdO = trO.slice(Math.floor(trO.length * 0.8));
  const tj = fitTau(holdO.map(d => ({ U: utilities(d.X, bj), order: d.order })));
  const ej = evaluate(teO, bj, tj);
  console.error(`  joint: logloss ${ej.logloss}／1着的中 ${(ej.hit1 * 100).toFixed(1)}%／上位3頭 ${(ej.in3 * 100).toFixed(1)}%（温度 τ1 ${tj[0]}／τ2 ${tj[1]}）`);
  console.error('  係数: ' + coefs(bj).slice(0, 16).map(([k, v]) => `${k} ${v}`).join(' / '));
  joint = { beta: [...bj].map(v => +v.toFixed(4)), tau: tj, test: ej, coef: coefs(bj), train: trO.length, baseSame: baseO };
}
writeJSON(process.env.BN_FIT_OUT || 'data/banei/model.json', {
  meta: { built: new Date().toISOString().slice(0, 10), split: SPLIT, warm: WARM, feats: FEATURES, train: tr.length, test: te.length, from: data[0]?.date, to: data.at(-1)?.date, drop: [...DROP] },
  base: { beta: [...beta].map(v => +v.toFixed(4)), tau, test: ev, coef: coefs(beta) }, popOnly, oddsTest: teO.length, joint,
});
