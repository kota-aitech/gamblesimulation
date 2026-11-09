/* 競輪：確定の市場に対して、モデルのどのグループが上乗せとして残るか（2026-11-09）→ data/keirin/groupfit.json
   edge_keirin.mjs は締切8分前と確定の両方があるレース（約2,200R）だけだったので、ここでは検証期間（model.json の split 以降＝学習に使っていない）の
   確定オッズのある全レースで、1着 ~ log(確定の1着確率) + Σ w_g × グループ寄与 を当てる。時期で前後半に分け、入れ替えも出す。
   比べるもの：市場だけ／＋base 一括／＋joint 一括（本番。joint の mktLog は確定オッズ由来なので、ここでは市場の項を除いた寄与）／＋グループ別／＋脚質・地元だけ */
import { readJSON, writeJSON, eachLine } from './lib/kr.mjs';
import { FEATURES, NF, MKT, slim, buildAsOf, makeFeaturizer } from './lib/krfeat.mjs';
import { marketOf } from './lib/calib.mjs';

const M = readJSON('data/keirin/model.json');
const FROM = M.meta.split;
const beta = new Float64Array(NF), betaJ = new Float64Array(NF);
FEATURES.forEach((k, i) => { const j = M.meta.feats.indexOf(k); if (j >= 0) { beta[i] = M.base.beta[j]; if (M.joint) betaJ[i] = M.joint.beta[j]; } });
const T1 = M.base.tau[0], TJ = M.joint?.tau?.[0] ?? 1;

export const GROUP = {
  scoreRel: '得点', scoreRank: '得点', scoreTop: '得点', clsRel: '得点',
  winRate: '成績', q2: '成績', q3: '成績', finalShare: '成績', rIdx: '成績',
  sRate: '脚質', bRate: '脚質', jiriki: '脚質', sashiMark: '脚質', styleNige: '脚質', styleRyo: '脚質',
  formAvg: '近況', formLast: '近況', curMeet: '近況', venueFit: '当所', bankFit: '当所',
  single: 'ライン', lineHead: 'ライン', lineSecond: 'ライン', lineThird: 'ライン', lineSize: 'ライン', lineScore: 'ライン', headPower: 'ライン', secondBehindStrong: 'ライン',
  rivalHeads: 'ライン', nLines: 'ライン', bigLine: 'ライン', rPosFit: 'ライン', pairFit: 'ライン', initLead: 'ライン', initSecond: 'ライン', rLineFin: 'ライン',
  home: '地元', homeRegion: '地元', homeInLine: '地元', homeHead: '地元', homeX: '地元',
  tip: '記者', evalRel: '記者',
  venueHeadEdge: 'バンク', venueSecondEdge: 'バンク', bankJiri: 'バンク', rBankFit: 'バンク', venueStyleFit: 'バンク', straightX: 'バンク', cantX: 'バンク',
  dayHeadEdge: '当日', dayJiriki: '当日', windNige: '当日',
};
const GROUPS = ['得点', '成績', '脚質', '近況', '当所', 'ライン', '地元', '記者', 'バンク', '当日', 'その他'];
const gi = FEATURES.map(f => f === 'mktLog' ? -1 : GROUPS.indexOf(GROUP[f] || 'その他'));

const races = [];
eachLine('data/keirin/races.jsonl', l => {
  if (!/"result":\{/.test(l)) return;
  let r; try { r = JSON.parse(l); } catch { return; }
  if (!r.date || !r.riders?.length) return;
  races.push(slim(r, r.date >= FROM ? { odds: true } : {}));
});
races.sort((a, b) => a.date.localeCompare(b.date) || a.jcd.localeCompare(b.jcd) || a.r - b.r);
const featurize = makeFeaturizer(buildAsOf(races));

const rows = [];
for (const r of races) {
  if (r.date < FROM || !r.odds?.e3) continue;
  const f = featurize(r); if (!f || !f.order || f.order[0] == null || f.order[0] < 0) continue;
  const nos = f.rows.map(x => String(x.no)), idx = new Map(nos.map((n, i) => [n, i]));
  const q = marketOf(Object.fromEntries(Object.entries(r.odds.e3).filter(([, o]) => o > 0 && o < 9999))); if (!q) continue;
  const w = nos.map(() => 0); for (const [k, p] of Object.entries(q)) { const i = idx.get(k.split('-')[0]); if (i != null) w[i] += p; }
  if (w.some(v => !v)) continue;
  const G = [], uB = [], uJ = [];
  for (const x of f.rows) {
    const g = new Float64Array(GROUPS.length); let sb = 0, sj = 0;
    for (let j = 0; j < NF; j++) { if (j === MKT) continue; const c = T1 * beta[j] * x.x[j]; if (gi[j] >= 0) g[gi[j]] += c; sb += c; sj += TJ * betaJ[j] * x.x[j]; }
    G.push(g); uB.push(sb); uJ.push(sj);
  }
  rows.push({ date: r.date, win: f.order[0], w, G, uB, uJ });
}
console.error(`標本 ${rows.length}R（${rows[0].date}〜${rows.at(-1).date}）`);

function fitCL(data, D, l2 = 1e-3) {
  const b = new Float64Array(D); let H;
  for (let it = 0; it < 40; it++) {
    const g = new Float64Array(D); H = Array.from({ length: D }, () => Array(D).fill(0));
    for (const C of data) {
      let mx = -Infinity; const z = C.map(c => { let s = 0; for (let j = 0; j < D; j++) s += b[j] * c.f[j]; if (s > mx) mx = s; return s; });
      let Z = 0; const e = z.map(v => { const t = Math.exp(v - mx); Z += t; return t; });
      const E = new Float64Array(D); C.forEach((c, i) => { for (let j = 0; j < D; j++) E[j] += e[i] / Z * c.f[j]; });
      C.forEach((c, i) => { const p = e[i] / Z; if (c.y) for (let j = 0; j < D; j++) g[j] += c.f[j]; for (let j = 0; j < D; j++) for (let k = 0; k < D; k++) H[j][k] += p * (c.f[j] - E[j]) * (c.f[k] - E[k]); });
      for (let j = 0; j < D; j++) g[j] -= E[j];
    }
    for (let j = 0; j < D; j++) { g[j] -= l2 * b[j]; H[j][j] += l2; }
    const d = solve(H, Array.from(g)); let st = 0; for (let j = 0; j < D; j++) { b[j] += d[j]; st += Math.abs(d[j]); } if (st < 1e-7) break;
  }
  return { b: Array.from(b), se: Array.from({ length: D }, (_, i) => { const e = Array(D).fill(0); e[i] = 1; return Math.sqrt(Math.max(0, solve(H, e)[i])); }) };
}
function solve(A, y) { const n = y.length; A = A.map((r, i) => [...r, y[i]]); for (let i = 0; i < n; i++) { let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k; [A[i], A[p]] = [A[p], A[i]]; for (let k = i + 1; k < n; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j]; } } const x = Array(n).fill(0); for (let i = n - 1; i >= 0; i--) { let t = A[i][n]; for (let j = i + 1; j < n; j++) t -= A[i][j] * x[j]; x[i] = t / A[i][i]; } return x; }
function ll(data, b) { let s = 0; for (const C of data) { let mx = -Infinity; const z = C.map(c => { let t = 0; for (let j = 0; j < b.length; j++) t += b[j] * c.f[j]; if (t > mx) mx = t; return t; }); let Z = 0; for (const v of z) Z += Math.exp(v - mx); s -= z[C.findIndex(c => c.y)] - mx - Math.log(Z); } return s / data.length; }
const L = v => Math.log(Math.max(v, 1e-7));
const SEL = ['脚質', '地元'].map(g => GROUPS.indexOf(g));
const make = { 
  '市場だけ': x => i => [L(x.w[i])],
  '＋base一括': x => i => [L(x.w[i]), x.uB[i]],
  '＋joint一括': x => i => [L(x.w[i]), x.uJ[i]],
  '＋グループ別': x => i => [L(x.w[i]), ...x.G[i]],
  '＋脚質・地元': x => i => [L(x.w[i]), ...SEL.map(j => x.G[i][j])],
};
const dataOf = (rs, fn) => rs.map(x => { const F = fn(x); return x.G.map((_, i) => ({ f: Float64Array.from(F(i)), y: i === x.win })); });
const mid = rows[Math.floor(rows.length / 2)].date;
const H1 = rows.filter(x => x.date < mid), H2 = rows.filter(x => x.date >= mid);
console.error(`前半 ${H1.length}R（〜${mid}）／後半 ${H2.length}R`);
const out = { builtAt: new Date().toISOString(), n: rows.length, from: rows[0].date, to: rows.at(-1).date, split: mid, groups: GROUPS, res: {} };
for (const [nm, tr, te] of [['前半→後半', H1, H2], ['後半→前半', H2, H1], ['全部', rows, null]]) {
  const o = out.res[nm] = {};
  for (const [k, fn] of Object.entries(make)) {
    const D = fn(rows[0])(0).length, f = fitCL(dataOf(tr, fn), D);
    o[k] = { b: f.b.map(v => +v.toFixed(3)), se: f.se.map(v => +v.toFixed(3)), logloss: te ? +ll(dataOf(te, fn), f.b).toFixed(4) : null };
  }
  console.error(`\n== ${nm}`);
  for (const [k, v] of Object.entries(o)) console.error(`  ${k}: ${v.logloss ?? ''}  ${v.b.map((b, i) => `${b}±${v.se[i]}`).join(' ')}`);
}
writeJSON('data/keirin/groupfit.json', out);
