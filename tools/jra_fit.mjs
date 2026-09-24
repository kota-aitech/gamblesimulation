/* JRA の条件付きロジット（Plackett–Luce）を当てはめる → data/jra/model.json
   南関・ボートと同じ2段構成。
     第1段 … オッズを使わない基礎モデル（lib/jfeat.mjs の特徴量）＋ 着順の段階ごとの温度（lib/bpl.mjs）
     第2段 … log p_基礎 と log p_人気（単勝オッズ）の合成。第1項の係数が「市場に何を足せているか」
     joint  … 市場の対数確率（mktLog）を特徴量の1つとして他の全部と同時に当てはめる。
              第2段が「基礎モデル丸ごと」に重みを付けるのに対し、こちらは特徴量ごとに
              「市場の上に足せる分」だけが係数に残る。オッズが出たレースの予測はこちらを使う
     JRA_FIT_SPLIT … 学習と検証を切る日付（既定 2026-06-01）
     JRA_FIT_WARM  … 履歴の助走期間（既定 2024-03-01。それ以前のレースは前走が揃わないので学習に使わない）
     JRA_FIT_DB    … 指数（既定 data/jra/index.json。先読みを避けるなら index.train.json）
     JRA_FIT_OUT   … 書き出し先（既定 data/jra/model.json。切り分けで本番を上書きしたくないとき）
     JRA_FIT_EPOCH / JRA_FIT_LR / JRA_FIT_L2 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/jra.mjs';
import { FEATURES, NF, MKT, buildRaceIndex, buildHistory, buildAsOf, loadPed, raceFromResult, makeFeaturizer } from './lib/jfeat.mjs';
import { loadBaba } from './lib/jbaba.mjs';
import { buildBabaBias } from './lib/jbias.mjs';
import { utilities, plWin, plackettLuce, fitTau } from './lib/bpl.mjs';

const SPLIT = process.env.JRA_FIT_SPLIT || '2026-06-01';
const WARM = process.env.JRA_FIT_WARM || '2024-03-01';
const EPOCH = Number(process.env.JRA_FIT_EPOCH || 300), LR = Number(process.env.JRA_FIT_LR || 0.08), L2 = Number(process.env.JRA_FIT_L2 || 1e-3);
const DB = readJSON(process.env.JRA_FIT_DB || 'data/jra/index.json');
/* 切り分け用：JRA_FIT_DROP=カンマ区切りの特徴量名 で、その列を 0 にして当てはめる */
const DROP = new Set((process.env.JRA_FIT_DROP || '').split(',').map(s => s.trim()).filter(Boolean));
const DROPI = [...DROP].map(k => FEATURES.indexOf(k)).filter(i => i >= 0);

console.error('結果を読む…');
const results = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/jra/results.jsonl'), 'utf8').split('\n')) if (l) { const r = JSON.parse(l); if (r.surface !== '障') results.push(r); }
results.sort((a, b) => a.date.localeCompare(b.date) || a.raceId.localeCompare(b.raceId));
const PED = loadPed(fs.existsSync(path.join(ROOT, 'data/jra/horses.jsonl')) ? fs.readFileSync(path.join(ROOT, 'data/jra/horses.jsonl'), 'utf8') : '');
const RI = buildRaceIndex(results), H = buildHistory(results), ASOF = buildAsOf(results, PED);
console.error(`  血統・馬主 ${PED.size} 頭`);
const BABA_IDX = loadBaba();                       // 含水率・クッション値（場×芝ダで標準化して特徴量に効かせる）
const BIAS = buildBabaBias(results, BABA_IDX);     // 馬場の帯ごとの脚質・枠・騎手の得失（レース時点）
const featurize = makeFeaturizer(DB, RI, ASOF, BABA_IDX, BIAS);
const data = [];
for (const r of results) {
  if (r.date < WARM) continue;
  const race = raceFromResult(r, H);
  if (race.order.some(i => i < 0)) continue;
  const f = featurize(race);
  if (!f) continue;
  const X = f.rows.map(x => x.x);
  data.push({ raceId: f.raceId, date: f.date, X, order: race.order, odds: f.rows.map(x => x.odds) });
}
const tr = data.filter(d => d.date < SPLIT), te = data.filter(d => d.date >= SPLIT);
console.error(`  ${results.length} レース → 学習 ${tr.length}R（${WARM}〜${SPLIT}）／検証 ${te.length}R`);
if (tr.length < 200) { console.error('学習データが足りない（結果の取得が終わるまで待つ）'); process.exit(1); }

/* ---- Plackett–Luce（1〜3着）を Adam で ---- */
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
/* drop に入れた列は係数を 0 に固定する（列そのものは残すので base と joint で同じ行列を使える） */
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
    if (ep % 25 === 0) console.error(`    ep${ep} 対数尤度/R ${(ll / rows.length).toFixed(4)}`);
  }
  return beta;
}
function evaluate(rows, beta, tau = [1, 1], mix = null) {
  let ll = 0, hit1 = 0, in3 = 0, n = 0;
  const cal = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const d of rows) {
    let p = plWin(utilities(d.X, beta), tau[0]);
    if (mix) p = mixProbs(p, d.odds, mix);
    const w = d.order[0];
    ll -= Math.log(Math.max(1e-9, p[w]));
    const rank = p.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    if (rank[0] === w) hit1++; if (rank.slice(0, 3).includes(w)) in3++; n++;
    p.forEach((v, i) => { const b = cal[Math.min(9, Math.floor(v * 10))]; b.p += v; b.y += i === w ? 1 : 0; b.n++; });
  }
  return { logloss: +(ll / n).toFixed(4), hit1: +(hit1 / n).toFixed(4), in3: +(in3 / n).toFixed(4), n, cal: cal.map(b => b.n ? { p: +(b.p / b.n).toFixed(3), y: +(b.y / b.n).toFixed(3), n: b.n } : null) };
}
/* 人気（単勝オッズ）から市場の勝率。控除を除いて正規化 */
const popProbs = odds => { const inv = odds.map(o => (o > 0 ? 1 / o : 0)); const s = inv.reduce((a, b) => a + b, 0); return s > 0 ? inv.map(v => v / s) : null; };
function mixProbs(p, odds, mix) {
  const q = popProbs(odds); if (!q) return p;
  const u = p.map((v, i) => mix.a * Math.log(Math.max(v, 1e-6)) + mix.b * Math.log(Math.max(q[i], 1e-6)));
  const m = Math.max(...u), e = u.map(v => Math.exp(v - m)), s = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / s);
}
/* 第2段：a·log p + b·log q を1着の尤度で当てはめる（2次元のグリッド） */
function fitMix(rows, beta, tau) {
  const packed = rows.map(d => ({ p: plWin(utilities(d.X, beta), tau[0]), q: popProbs(d.odds), w: d.order[0] })).filter(x => x.q);
  let best = { a: 1, b: 0, v: -Infinity };
  for (let a = 0; a <= 1.2; a += 0.05) for (let b = 0; b <= 1.2; b += 0.05) {
    let s = 0;
    for (const x of packed) { const u = x.p.map((v, i) => a * Math.log(Math.max(v, 1e-6)) + b * Math.log(Math.max(x.q[i], 1e-6))); const m = Math.max(...u); const e = u.map(v => Math.exp(v - m)); s += u[x.w] - m - Math.log(e.reduce((c, d) => c + d, 0)); }
    if (s > best.v) best = { a: +a.toFixed(2), b: +b.toFixed(2), v: s };
  }
  return { a: best.a, b: best.b, n: packed.length };
}

console.error('第1段（base：市場なし）を当てはめる…');
const beta = fit(tr, new Set([...DROPI, MKT]));
const raw = evaluate(te, beta);
/* 温度は学習データの末尾2割（β の当てはめに寄っていない部分）で決める。
   学習全体で決めると β の過学習ぶんまで鋭くなり、検証で強気に出た */
const hold = tr.slice(Math.floor(tr.length * 0.8));
const tau = fitTau(hold.map(d => ({ U: utilities(d.X, beta), order: d.order })));
const ev = evaluate(te, beta, tau);
console.error(`  温度 τ1 ${tau[0]}／τ2 ${tau[1]}（較正前 logloss ${raw.logloss}）`);
console.error(`  第1段: logloss ${ev.logloss}／1着的中 ${(ev.hit1 * 100).toFixed(1)}%／上位3頭に勝ち馬 ${(ev.in3 * 100).toFixed(1)}%`);
console.error('  係数（絶対値の大きい順）: ' + [...beta].map((v, i) => [FEATURES[i], v]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 14).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' / '));
console.error('  較正（予測→実際）: ' + ev.cal.filter(Boolean).map(b => `${(b.p * 100).toFixed(0)}→${(b.y * 100).toFixed(0)}`).join(' '));
/* 人気だけ・第2段 */
const popOnly = evaluate(te, new Float64Array(NF), [1, 1], { a: 0, b: 1 });
const mix = fitMix(tr, beta, tau);
const ev2 = evaluate(te, beta, tau, mix);
console.error(`  人気だけ: logloss ${popOnly.logloss}／1着的中 ${(popOnly.hit1 * 100).toFixed(1)}%／上位3頭 ${(popOnly.in3 * 100).toFixed(1)}%`);
console.error(`  第2段（${mix.a}×log基礎 + ${mix.b}×log人気）: logloss ${ev2.logloss}／1着的中 ${(ev2.hit1 * 100).toFixed(1)}%／上位3頭 ${(ev2.in3 * 100).toFixed(1)}%`);

/* joint：市場の対数確率を特徴量として同時に当てはめる。温度は同じく学習末尾2割 */
let joint = null;
if (!process.env.JRA_FIT_NOJOINT) {
  console.error('joint（市場＋全特徴量）を当てはめる…');
  const bj = fit(tr, new Set(DROPI));
  const tj = fitTau(hold.map(d => ({ U: utilities(d.X, bj), order: d.order })));
  const ej = evaluate(te, bj, tj);
  const coef = [...bj].map((v, i) => [FEATURES[i], +v.toFixed(3)]).filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  console.error(`  joint: logloss ${ej.logloss}／1着的中 ${(ej.hit1 * 100).toFixed(1)}%／上位3頭 ${(ej.in3 * 100).toFixed(1)}%（温度 τ1 ${tj[0]}／τ2 ${tj[1]}）`);
  console.error('  joint の係数（絶対値順）: ' + coef.slice(0, 16).map(([k, v]) => `${k} ${v}`).join(' / '));
  console.error('  較正（予測→実際）: ' + ej.cal.filter(Boolean).map(b => `${(b.p * 100).toFixed(0)}→${(b.y * 100).toFixed(0)}`).join(' '));
  joint = { beta: [...bj].map(v => +v.toFixed(4)), tau: tj, test: ej, coef };
}

writeJSON(process.env.JRA_FIT_OUT || 'data/jra/model.json', {
  meta: { built: new Date().toISOString().slice(0, 10), split: SPLIT, warm: WARM, feats: FEATURES, train: tr.length, test: te.length, from: data[0]?.date, to: data.at(-1)?.date, db: process.env.JRA_FIT_DB || 'data/jra/index.json' },
  base: { beta: [...beta].map(v => +v.toFixed(4)), tau, test: ev, testRaw: { logloss: raw.logloss, hit1: raw.hit1, in3: raw.in3 } },
  mix: { ...mix, test: ev2 }, popOnly, joint,
});
console.error('-> ' + (process.env.JRA_FIT_OUT || 'data/jra/model.json'));
