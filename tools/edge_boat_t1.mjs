/* ボート：モデルの上乗せが「締切1分前」の市場に対しても残るか（2026-11-09）→ data/boat/edge_t1.json
   10/16 に、締切8分前に見つけた割安は締切までに市場が埋めることが分かった（lib/calib.mjs の drift）。
   締切1分前（cloud_odds の CO_LATE、odds_live.jsonl の kind:'T-1'）はほぼ確定の市場なので、
   ここに対してまだ足せる分だけが本当の得になる。T-1 と T-8 の両方があるレースで、同じ手続きを並べて比べる。
     A. 1着：市場の対数確率＋モデルの寄与（コース・実力・展示…のグループ別）を条件付きロジットで当てる。係数 1＝モデルのまま足せる、0＝織り込み済み
     B. 3連単：p ∝ p_モデル^a × p_T8^b × p_T1^c の尤度。T-1 があるときに a が 0 でなければ上乗せが残っている
     C. 実際に買ったら：合成確率 × T-1 のオッズで期待値を出し、閾値を超えた組を確定の払戻で精算（単勝・3連単）
   前半で当てはめ、後半で測る。前後を入れ替えたものも出す（標本が小さいので向きがそろうかを見る）。
   モデルは calib_boat と同じ作り（ex・段階モデル・index.train.json）。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/bt.mjs';
import { loadRaces } from './lib/bload.mjs';
import { raceFeatures, FEATS, NF } from './lib/bfeat.mjs';
import { utilities, raceProbs } from './lib/bpl.mjs';
import { marketOf } from './lib/calib.mjs';

const DB = readJSON('data/boat/index.train.json');
const ST = readJSON('data/boat/stadium.json');
const M = readJSON('data/boat/model.json');
const beta = Float64Array.from(M.ex.beta), TAU = M.ex.tau || [1, 1];

const GROUP = {
  cz: 'コース', czTop2: 'コース', tideC: 'コース', tideLvlC: 'コース', phFinalC: 'コース', phSemiC: 'コース',
  rIdx: '実力', rIdxC: '実力', natWin: '実力', nat2: '実力', gA1: '実力', gA2: '実力', gB1: '実力', rIdxXc: '実力', rIdxVsIn: '実力', in1Idx: '実力',
  rIdxJ: '当地', locWin: '当地', loc2: '当地',
  stFast: 'ST', stFastC: 'ST', setuST: 'ST', stXc: 'ST', stVsIn: 'ST', setuF: 'ST', setuF2: 'ST',
  motor2: 'モーター', motorIdx: 'モーター', boat2: 'モーター', mUp: 'モーター', mForm: 'モーター', tune: 'モーター', motorXc: 'モーター',
  form: '調子', formN: '調子', setuAvg: '調子', setuN: '調子', setuRuns: '調子', setuEx: '調子',
  ptRate: '得点', ptGap: '得点', ptRank: '得点', kyuNear: '得点', kyuBelow: '得点',
  windC: '水面', waveC: '水面', wDir: '水面', wSpd: '水面', wWave: '水面',
  exDev: '展示', exRank: '展示', exXc: '展示',
  dayIn1: '当日', dayOut: '当日', dayMak: '当日', todayRel: '当日', todaySt: '当日',
};
const GROUPS = ['コース', '実力', '当地', 'ST', 'モーター', '調子', '得点', '水面', '展示', '当日', 'その他'];
const gi = FEATS.map(f => GROUPS.indexOf(GROUP[f] || 'その他'));

/* ---- スナップショット ---- */
const T8 = new Map(), T1 = new Map();
for (const l of fs.readFileSync(path.join(ROOT, 'data/boat/odds_live.jsonl'), 'utf8').split('\n')) {
  if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
  const k = `${o.date}|${o.jcd}|${o.r}`;
  if (!(o.ex3 && Object.keys(o.ex3).length >= 100 && o.win)) continue;
  if (o.kind === 'T-8') T8.set(k, o); else if (o.kind === 'T-1') T1.set(k, o);
}
const keys = new Set([...T1.keys()].filter(k => T8.has(k)));
console.error(`T-1 ${T1.size}R／T-8 ${T8.size}R／両方 ${keys.size}R`);
const races = loadRaces({ from: M.meta.split, keys });
console.error(`結果と突き合わせ ${races.length}R`);

/* 1着の市場確率は3連単（120通り）から逆算する。ボートの単勝は売上が小さく、単勝オッズからの見立ては粗い
   （同じレースで logloss 1.219 対 1.146、本命が食い違うレース 24%）。欠けた艇があれば null */
const winMkt = ex3 => { const q = Array(6).fill(0); let s = 0; for (const [c, o] of Object.entries(ex3)) if (o > 0) { q[+c[0] - 1] += 1 / o; s += 1 / o; } return s && q.every(v => v > 0) ? q.map(v => v / s) : null; };

const rows = [];
for (const r of races) {
  const k = `${r.date}|${r.jcd}|${r.r}`, s8 = T8.get(k), s1 = T1.get(k);
  const [f1, f2, f3] = r.fin || []; if (!f3) continue;
  const X = raceFeatures(r, r.boats, DB, ST, { level: 'ex' });
  const U = utilities(X, beta);
  const PL = raceProbs(U, TAU, X.ctx, M.stage || null);
  const lanes = r.boats.map(b => b.lane);
  /* 1着：艇（lane 1..6 の並び）ごとのグループ寄与×τ1 と市場 */
  const G = Array.from({ length: 6 }, () => new Float64Array(GROUPS.length));
  r.boats.forEach((b, i) => { for (let j = 0; j < NF; j++) G[b.lane - 1][gi[j]] += TAU[0] * beta[j] * X[i][j]; });
  const w8 = winMkt(s8.ex3), w1 = winMkt(s1.ex3); if (!w8 || !w1) continue;
  /* 3連単 */
  const q8 = marketOf(s8.ex3), q1 = marketOf(s1.ex3); if (!q8 || !q1) continue;
  const ks = [], pm = [], p8 = [], p1 = [], o1 = [], o8 = [];
  for (const [a, b, c, p] of PL.tri) { const kk = `${lanes[a]}-${lanes[b]}-${lanes[c]}`; if (!q8[kk] || !q1[kk]) continue; ks.push(kk); pm.push(p); p8.push(q8[kk]); p1.push(q1[kk]); o1.push(s1.ex3[kk]); o8.push(s8.ex3[kk]); }
  const w = ks.indexOf(`${f1}-${f2}-${f3}`); if (w < 0) continue;
  const pay3 = (r.pay?.ex3 || []).find(x => x.c === `${f1}-${f2}-${f3}`)?.y || 0;
  const payW = (r.pay?.win || []).find(x => +x.c === f1)?.y || 0;
  rows.push({ date: r.date, win: f1 - 1, G, w8, w1, o1w: [1, 2, 3, 4, 5, 6].map(l => +s1.win[l] || 0), payW, ks, pm, p8, p1, o1, o8, w, pay3 });
}
rows.sort((a, b) => a.date.localeCompare(b.date));
console.error(`標本 ${rows.length}R（${rows[0]?.date}〜${rows.at(-1)?.date}）`);

/* ---- 汎用の条件付きロジット（ニュートン法、L2 は弱く）。cand(x) → [{f:Float64Array, y:bool}] ---- */
function fitCL(data, D, l2 = 1e-3) {
  let b = new Float64Array(D);
  for (let it = 0; it < 40; it++) {
    const g = new Float64Array(D), H = Array.from({ length: D }, () => new Float64Array(D));
    for (const C of data) {
      let mx = -Infinity; const z = C.map(c => { let s = 0; for (let j = 0; j < D; j++) s += b[j] * c.f[j]; if (s > mx) mx = s; return s; });
      let Z = 0; const e = z.map(v => { const t = Math.exp(v - mx); Z += t; return t; });
      const E = new Float64Array(D);
      C.forEach((c, i) => { const p = e[i] / Z; for (let j = 0; j < D; j++) E[j] += p * c.f[j]; });
      C.forEach((c, i) => { const p = e[i] / Z; if (c.y) for (let j = 0; j < D; j++) g[j] += c.f[j]; for (let j = 0; j < D; j++) { g[j] -= c.y ? 0 : 0; const dj = c.f[j] - E[j]; for (let k = 0; k < D; k++) H[j][k] -= p * dj * (c.f[k] - E[k]); } });
      for (let j = 0; j < D; j++) g[j] -= E[j];
    }
    for (let j = 0; j < D; j++) { g[j] -= l2 * b[j]; H[j][j] -= l2; }
    const d = solve(H.map(r => Array.from(r)), Array.from(g).map(v => -v));
    let step = 0; for (let j = 0; j < D; j++) { b[j] += d[j]; step += Math.abs(d[j]); }
    if (step < 1e-7) {
      const se = inverseDiag(H.map(r => Array.from(r).map(v => -v)));
      return { b: Array.from(b), se };
    }
  }
  const H = hess(data, b, D, l2);
  return { b: Array.from(b), se: inverseDiag(H) };
}
function hess(data, b, D, l2) {
  const H = Array.from({ length: D }, () => Array(D).fill(0));
  for (const C of data) {
    let mx = -Infinity; const z = C.map(c => { let s = 0; for (let j = 0; j < D; j++) s += b[j] * c.f[j]; if (s > mx) mx = s; return s; });
    let Z = 0; const e = z.map(v => { const t = Math.exp(v - mx); Z += t; return t; });
    const E = new Float64Array(D); C.forEach((c, i) => { for (let j = 0; j < D; j++) E[j] += e[i] / Z * c.f[j]; });
    C.forEach((c, i) => { const p = e[i] / Z; for (let j = 0; j < D; j++) for (let k = 0; k < D; k++) H[j][k] += p * (c.f[j] - E[j]) * (c.f[k] - E[k]); });
  }
  for (let j = 0; j < D; j++) H[j][j] += l2;
  return H;
}
function solve(A, y) {
  const n = y.length; A = A.map((r, i) => [...r, y[i]]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    [A[i], A[p]] = [A[p], A[i]];
    for (let k = i + 1; k < n; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j]; }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let t = A[i][n]; for (let j = i + 1; j < n; j++) t -= A[i][j] * x[j]; x[i] = t / A[i][i]; }
  return x;
}
function inverseDiag(H) { const n = H.length; return Array.from({ length: n }, (_, i) => { const e = Array(n).fill(0); e[i] = 1; return Math.sqrt(Math.max(0, solve(H, e)[i])); }); }
function llCL(data, b) {
  let s = 0;
  for (const C of data) {
    let mx = -Infinity; const z = C.map(c => { let t = 0; for (let j = 0; j < b.length; j++) t += b[j] * c.f[j]; if (t > mx) mx = t; return t; });
    let Z = 0; for (const v of z) Z += Math.exp(v - mx);
    s -= z[C.findIndex(c => c.y)] - mx - Math.log(Z);
  }
  return s / data.length;
}
const L = v => Math.log(Math.max(v, 1e-7));

/* ---- A. 1着：市場（T-8 か T-1）＋グループ ---- */
const winData = (rs, which, groups) => rs.map(x => [0, 1, 2, 3, 4, 5].map(i => ({ f: Float64Array.from([L(x[which][i]), ...(groups ? x.G[i] : [])]), y: i === x.win })));
function partA(tr, te) {
  const out = {};
  for (const which of ['w8', 'w1']) {
    const base = fitCL(winData(tr, which, false), 1), full = fitCL(winData(tr, which, true), 1 + GROUPS.length);
    const sum = fitCL(tr.map(x => [0, 1, 2, 3, 4, 5].map(i => ({ f: Float64Array.from([L(x[which][i]), x.G[i].reduce((a, b) => a + b, 0)]), y: i === x.win }))), 2);
    const teSum = te.map(x => [0, 1, 2, 3, 4, 5].map(i => ({ f: Float64Array.from([L(x[which][i]), x.G[i].reduce((a, b) => a + b, 0)]), y: i === x.win })));
    out[which === 'w8' ? 'T-8' : 'T-1'] = {
      logloss: { market: +llCL(winData(te, which, false), [1]).toFixed(4), marketFit: +llCL(winData(te, which, false), base.b).toFixed(4), modelSum: +llCL(teSum, sum.b).toFixed(4), groups: +llCL(winData(te, which, true), full.b).toFixed(4) },
      modelSum: { market: +sum.b[0].toFixed(3), model: +sum.b[1].toFixed(3), se: +sum.se[1].toFixed(3) },
      coef: Object.fromEntries([['市場', 0], ...GROUPS.map((g, i) => [g, i + 1])].map(([g, i]) => [g, [+full.b[i].toFixed(3), +full.se[i].toFixed(3)]])),
    };
  }
  return out;
}

/* ---- B. 3連単：p ∝ pm^a × p8^b × p1^c ---- */
const triData = (rs, use) => rs.map(x => x.ks.map((_, i) => ({ f: Float64Array.from(use.map(u => L(x[u][i]))), y: i === x.w })));
function partB(tr, te) {
  const sets = { 'T-8のみ': ['p8'], 'T-1のみ': ['p1'], 'モデル＋T-8': ['pm', 'p8'], 'モデル＋T-1': ['pm', 'p1'], 'モデル＋T-8＋T-1': ['pm', 'p8', 'p1'] };
  const out = { raw: { model: +llCL(triData(te, ['pm']), [1]).toFixed(4), 'T-8': +llCL(triData(te, ['p8']), [1]).toFixed(4), 'T-1': +llCL(triData(te, ['p1']), [1]).toFixed(4) } };
  for (const [name, use] of Object.entries(sets)) {
    const f = fitCL(triData(tr, use), use.length);
    out[name] = { coef: Object.fromEntries(use.map((u, i) => [{ pm: 'モデル', p8: 'T-8', p1: 'T-1' }[u], [+f.b[i].toFixed(3), +f.se[i].toFixed(3)]])), logloss: +llCL(triData(te, use), f.b).toFixed(4) };
  }
  return out;
}

/* ---- C. 実際に買ったら（T-1 のオッズで期待値、確定の払戻で精算）---- */
function partC(tr, te) {
  /* 単勝：p ∝ q1^b0 × exp(b1·モデル寄与の和) */
  const sumF = x => [0, 1, 2, 3, 4, 5].map(i => ({ f: Float64Array.from([L(x.w1[i]), x.G[i].reduce((a, b) => a + b, 0)]), y: i === x.win }));
  const fw = fitCL(tr.map(sumF), 2).b;
  const winRes = {};
  for (const th of [1.0, 1.1, 1.2, 1.3]) {
    let n = 0, ret = 0, hit = 0, ev = 0;
    for (const x of te) {
      const C = sumF(x); const z = C.map(c => fw[0] * c.f[0] + fw[1] * c.f[1]); const mx = Math.max(...z); const e = z.map(v => Math.exp(v - mx)); const Z = e.reduce((a, b) => a + b, 0);
      for (let i = 0; i < 6; i++) { const p = e[i] / Z, o = x.o1w[i]; if (!(o > 0) || o > 100 || p < 0.03) continue; if (p * o < th) continue; n++; ev += p * o; if (i === x.win) { hit++; ret += x.payW; } }
    }
    winRes[th] = { n, hit, roi: n ? +(ret / n / 100).toFixed(3) : null, expRoi: n ? +(ev / n).toFixed(3) : null };
  }
  { let n = 0, ret = 0; for (const x of te) { let bi = -1; for (let i = 0; i < 6; i++) if (x.o1w[i] > 0 && (bi < 0 || x.o1w[i] < x.o1w[bi])) bi = i; if (bi < 0) continue; n++; if (bi === x.win) ret += x.payW; } winRes.base = { name: 'T-1の単勝1番人気', n, roi: +(ret / n / 100).toFixed(3) }; }
  /* 3連単：モデル＋T-1 の合成、上位10組から p×T-1オッズ ≥ 閾値 */
  const ft = fitCL(triData(tr, ['pm', 'p1']), 2).b;
  const triRes = {};
  for (const th of [1.0, 1.1, 1.2, 1.3]) {
    let n = 0, ret = 0, hit = 0, ev = 0, races = 0;
    for (const x of te) {
      const z = x.ks.map((_, i) => ft[0] * L(x.pm[i]) + ft[1] * L(x.p1[i])); const mx = Math.max(...z); const e = z.map(v => Math.exp(v - mx)); const Z = e.reduce((a, b) => a + b, 0);
      const top = x.ks.map((k, i) => ({ i, p: e[i] / Z, o: x.o1[i] })).sort((a, b) => b.p - a.p).slice(0, 10).filter(c => c.p >= 0.01 && c.o <= 300 && c.p * c.o >= th);
      if (top.length) races++;
      for (const c of top) { n++; ev += c.p * c.o; if (c.i === x.w) { hit++; ret += x.pay3; } }
    }
    triRes[th] = { races, n, hit, roi: n ? +(ret / n / 100).toFixed(3) : null, expRoi: n ? +(ev / n).toFixed(3) : null };
  }
  /* 基準：市場（T-1）だけの上位1組を毎レース */
  let bn = 0, bret = 0; for (const x of te) { let bi = 0; for (let i = 1; i < x.p1.length; i++) if (x.p1[i] > x.p1[bi]) bi = i; bn++; if (bi === x.w) bret += x.pay3; }
  return { win: { coef: fw.map(v => +v.toFixed(3)), byThreshold: winRes }, tri: { coef: ft.map(v => +v.toFixed(3)), byThreshold: triRes }, base: { name: 'T-1の1番人気の3連単', n: bn, roi: +(bret / bn / 100).toFixed(3) } };
}

/* ---- T-1 → 確定 のオッズの動き（当たった組）---- */
function drift(rs) {
  const out = {};
  for (const [name, col] of [['T-8→確定', 'o8'], ['T-1→確定', 'o1']]) {
    const v = rs.filter(x => x.pay3 > 0).map(x => Math.log(x.pay3 / 100 / x[col][x.w]));
    v.sort((a, b) => a - b);
    out[name] = { n: v.length, median: +Math.exp(v[v.length >> 1]).toFixed(3), mean: +Math.exp(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) };
  }
  return out;
}

const mid = rows[Math.floor(rows.length / 2)].date;
const H1 = rows.filter(x => x.date < mid), H2 = rows.filter(x => x.date >= mid);
console.error(`前半 ${H1.length}R（〜${mid}）／後半 ${H2.length}R`);
const res = {};
for (const [name, tr, te] of [['前半→後半', H1, H2], ['後半→前半', H2, H1]]) {
  res[name] = { A: partA(tr, te), B: partB(tr, te), C: partC(tr, te) };
  console.error(`\n== ${name}`);
  for (const [k, v] of Object.entries(res[name].A)) {
    console.error(`[1着 ${k}] logloss 市場 ${v.logloss.market}／市場(較正) ${v.logloss.marketFit}／＋モデル一括 ${v.logloss.modelSum}／＋グループ別 ${v.logloss.groups}   一括の係数 ${v.modelSum.model}±${v.modelSum.se}`);
    console.error('   ' + Object.entries(v.coef).map(([g, [b, s]]) => `${g} ${b}±${s}`).join('  '));
  }
  const B = res[name].B;
  console.error(`[3連単] raw: モデル ${B.raw.model}／T-8 ${B.raw['T-8']}／T-1 ${B.raw['T-1']}`);
  for (const [k, v] of Object.entries(B)) if (k !== 'raw') console.error(`   ${k}: ${v.logloss}  ${Object.entries(v.coef).map(([g, [b, s]]) => `${g} ${b}±${s}`).join(' ')}`);
  const C = res[name].C;
  console.error(`[買い] 単勝 ${JSON.stringify(C.win.byThreshold)}`);
  console.error(`       3連単 ${JSON.stringify(C.tri.byThreshold)}  基準 ${C.base.name} ${C.base.roi}`);
}
const dr = drift(rows);
console.error(`\nオッズの動き（当たった組、確定/スナップショット）${JSON.stringify(dr)}`);
writeJSON('data/boat/edge_t1.json', { builtAt: new Date().toISOString(), n: rows.length, from: rows[0].date, to: rows.at(-1).date, split: mid, groups: GROUPS, drift: dr, res });
