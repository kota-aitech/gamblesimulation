/* 2着・3着の段階モデルの当てはめ → model.json の stage に書く。
   第1段の β は model.json（または BT_STAGE_MODEL）から読み、ex レベル（進入コースが確定）で学習する。
   検証は「2連単・3連単の的中率」と「上位N点に本線が入る率」を PL（温度つき）と比べる。 */
import { readJSON, writeJSON } from './lib/bt.mjs';
import { FEATS, NF, raceFeatures } from './lib/bfeat.mjs';
import { loadRaces } from './lib/bload.mjs';
import { utilities, plackettLuce, pairProbs, stagedPL, stagedPairs, stage2X, stage3X, STAGE2, STAGE3 } from './lib/bpl.mjs';

const MP = process.env.BT_STAGE_MODEL || 'data/boat/model.json';
const M = readJSON(MP);
const DB = readJSON(process.env.BT_FIT_DB || 'data/boat/index.train.json');
const ST = readJSON('data/boat/stadium.json');
const SPLIT = process.env.BT_FIT_SPLIT || M.meta.split || '20260601';
const EPOCH = Number(process.env.BT_FIT_EPOCH || 60), L2 = Number(process.env.BT_FIT_L2 || 1e-4), LR = 0.05;
const beta = new Float64Array(NF);
FEATS.forEach((k, i) => { const j = M.meta.feats.indexOf(k); beta[i] = j >= 0 ? M.ex.beta[j] : 0; });
const tau = M.ex.tau || [1, 1];

console.error('データを読む…');
let races = loadRaces({ base: DB.base });
/* 表：P(2着コース | 1着コース)、P(3着コース | 1着コース)（学習データ、加算1で平滑化） */
const T2 = Array.from({ length: 6 }, () => Array(6).fill(1)), T3 = Array.from({ length: 6 }, () => Array(6).fill(1));
/* メモリ（RAM 8GB）：レースごとに U と ctx だけ残して元のオブジェクトを捨てる */
const trd = [], ted = [];
for (let ri = 0; ri < races.length; ri++) {
  const r = races[ri];
  if (r.date < SPLIT) { const c = i => r.boats[i].course || r.boats[i].lane; const [w, s, t] = r.order; T2[c(w) - 1][c(s) - 1]++; T3[c(w) - 1][c(t) - 1]++; }
  const X = raceFeatures(r, r.boats, DB, ST, { level: 'ex' });
  (r.date < SPLIT ? trd : ted).push({ U: utilities(X, beta), ctx: X.ctx, order: r.order });
  races[ri] = null;
}
races = null; if (globalThis.gc) globalThis.gc();
const tr = trd, te = ted;
console.error(`  学習 ${tr.length}R／検証 ${te.length}R`);
const norm = T => T.map(row => { const s = row.reduce((a, b) => a + b, 0); return row.map(v => v / s); });
const P2 = norm(T2), P3 = norm(T3);
console.error('  1コースが勝ったときの2着コース: ' + P2[0].map((v, i) => `${i + 1}c ${(v * 100).toFixed(0)}%`).join(' '));
const dot = (b, x) => { let s = 0; for (let k = 0; k < b.length; k++) s += b[k] * x[k]; return s; };
function fitStage(rows, nf, label) {
  /* rows: [{X:[cands][nf], y}] */
  const b = new Float64Array(nf), m = new Float64Array(nf), v = new Float64Array(nf), g = new Float64Array(nf);
  for (let ep = 1; ep <= EPOCH; ep++) {
    g.fill(0); let ll = 0;
    for (const { X, y } of rows) {
      const u = X.map(x => dot(b, x)); const mx = Math.max(...u); const e = u.map(x => Math.exp(x - mx)); const s = e.reduce((a, c) => a + c, 0);
      ll += u[y] - mx - Math.log(s);
      for (let k = 0; k < nf; k++) { let ex = 0; for (let i = 0; i < X.length; i++) ex += (e[i] / s) * X[i][k]; g[k] += X[y][k] - ex; }
    }
    for (let k = 0; k < nf; k++) { g[k] = g[k] / rows.length - L2 * b[k]; m[k] = 0.9 * m[k] + 0.1 * g[k]; v[k] = 0.999 * v[k] + 0.001 * g[k] * g[k]; b[k] += LR * (m[k] / (1 - 0.9 ** ep)) / (Math.sqrt(v[k] / (1 - 0.999 ** ep)) + 1e-8); }
    if (ep % 20 === 0) console.error(`    ${label} ep${ep} 対数尤度/行 ${(ll / rows.length).toFixed(4)}`);
  }
  return [...b];
}
const rows2 = trd.map(d => { const w = d.order[0]; const cand = [0, 1, 2, 3, 4, 5].filter(i => i !== w); return { X: cand.map(i => stage2X(d.ctx, d.U, w, i, P2)), y: cand.indexOf(d.order[1]) }; });
const rows3 = trd.map(d => { const [w, s] = d.order; const cand = [0, 1, 2, 3, 4, 5].filter(i => i !== w && i !== s); return { X: cand.map(i => stage3X(d.ctx, d.U, w, s, i, P3)), y: cand.indexOf(d.order[2]) }; });
console.error('2着の段階を当てはめる…'); const b2 = fitStage(rows2, STAGE2.length, '2着');
console.error('3着の段階を当てはめる…'); const b3 = fitStage(rows3, STAGE3.length, '3着');
console.error('  2着の係数: ' + STAGE2.map((k, i) => `${k} ${b2[i].toFixed(3)}`).join(' / '));
console.error('  3着の係数: ' + STAGE3.map((k, i) => `${k} ${b3[i].toFixed(3)}`).join(' / '));
const stage = { t2: { feats: STAGE2, beta: b2.map(v => +v.toFixed(4)), table: P2.map(r => r.map(v => +v.toFixed(4))) }, t3: { feats: STAGE3, beta: b3.map(v => +v.toFixed(4)), table: P3.map(r => r.map(v => +v.toFixed(4))) } };

/* 検証：PL（温度つき）と段階モデルで、2連単・3連単の本線的中と上位N点の的中、2着・3着の logloss */
function evalAll(data, useStage) {
  const S = { n: 0, ll2: 0, ll3: 0, ex2: 0, ex3: 0, top3: 0, top5: 0, top8: 0, ex2top3: 0, tri1: 0 };
  for (const d of data) {
    const [w, s, t] = d.order;
    const R = useStage ? stagedPL(d.U, tau[0], d.ctx, stage) : plackettLuce(d.U, tau);
    const pairs = useStage ? stagedPairs(R.tri) : pairProbs(d.U, tau);
    const key = `${w}-${s}-${t}`;
    const ranked = R.tri.map(x => `${x[0]}-${x[1]}-${x[2]}`);
    const idx = ranked.indexOf(key);
    S.n++; if (idx === 0) S.ex3++; if (idx < 3) S.top3++; if (idx < 5) S.top5++; if (idx < 8) S.top8++;
    const pk = pairs.map(x => `${x[0]}-${x[1]}`); const pi = pk.indexOf(`${w}-${s}`); if (pi === 0) S.ex2++; if (pi < 3) S.ex2top3++;
    /* 真の1着を所与にした2着の確率と、真の1・2着を所与にした3着の確率 */
    const p2 = R.tri.filter(x => x[0] === w).reduce((a, x) => a + (x[1] === s ? x[3] : 0), 0) / Math.max(1e-9, R.p1[w]);
    const p3 = R.tri.filter(x => x[0] === w && x[1] === s).reduce((a, x) => a + (x[2] === t ? x[3] : 0), 0) / Math.max(1e-9, R.tri.filter(x => x[0] === w && x[1] === s).reduce((a, x) => a + x[3], 0));
    S.ll2 -= Math.log(Math.max(1e-9, p2)); S.ll3 -= Math.log(Math.max(1e-9, p3));
  }
  return { n: S.n, ll2: +(S.ll2 / S.n).toFixed(4), ll3: +(S.ll3 / S.n).toFixed(4), ex2: +(S.ex2 / S.n).toFixed(4), ex2top3: +(S.ex2top3 / S.n).toFixed(4), ex3: +(S.ex3 / S.n).toFixed(4), top3: +(S.top3 / S.n).toFixed(4), top5: +(S.top5 / S.n).toFixed(4), top8: +(S.top8 / S.n).toFixed(4) };
}
const base = evalAll(ted, false), st = evalAll(ted, true);
const fmt = o => `2着logloss ${o.ll2}／3着logloss ${o.ll3}／2連単本線 ${(o.ex2 * 100).toFixed(1)}%（上位3点 ${(o.ex2top3 * 100).toFixed(1)}%）／3連単本線 ${(o.ex3 * 100).toFixed(1)}%・上位3点 ${(o.top3 * 100).toFixed(1)}%・5点 ${(o.top5 * 100).toFixed(1)}%・8点 ${(o.top8 * 100).toFixed(1)}%`;
console.error(`  PL（温度つき）: ${fmt(base)}`);
console.error(`  段階モデル    : ${fmt(st)}`);
stage.test = { pl: base, staged: st, split: SPLIT, train: trd.length };
M.stage = stage;
writeJSON(process.env.BT_STAGE_OUT || MP, M);
