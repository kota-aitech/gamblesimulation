/* 競輪：モデルの上乗せが締切8分前／確定の市場に対して残るか（2026-11-09）→ data/keirin/edge.json
   ボートの edge_boat_t1 と同じ手続き。競輪は締切1分前の記録が無いので、確定オッズ（レースページの最終値）を
   「ほぼ締切の市場」として使う。締切8分前のスナップショット（odds_live.jsonl、クラウド）と確定の両方があるレースだけ。
     A. 1着：市場（3連単から逆算した1着確率）＋モデルの寄与（得点・ライン・地元…のグループ別）の条件付きロジット
     B. 3連単：p ∝ p_モデル^a × p_T8^b × p_確定^c
     C. 実際に買ったら：モデル＋T-8 の合成確率 × T-8 のオッズで期待値、上位10組から閾値以上を確定の払戻で精算
   モデルは base（オッズを使わない第1段＋段階モデル）。検証期間（model.json の split 以降＝学習に使っていない）だけ。
   前半で当てはめ・後半で測る、と入れ替えの2通り。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON, eachLine } from './lib/kr.mjs';
import { FEATURES, NF, slim, buildAsOf, makeFeaturizer, stageCtx, combos } from './lib/krfeat.mjs';
import { utilities } from './lib/bpl.mjs';
import { marketOf } from './lib/calib.mjs';

const M = readJSON('data/keirin/model.json');
const FROM = M.meta.split;
/* KR_EDGE_LEVEL=joint で本番と同じ joint（市場の項は締切8分前のスナップショットから）。既定は base（市場を使わない） */
const LEVEL = process.env.KR_EDGE_LEVEL === 'joint' && M.joint ? 'joint' : 'base';
const beta = new Float64Array(NF);
FEATURES.forEach((k, i) => { const j = M.meta.feats.indexOf(k); if (j >= 0) beta[i] = M[LEVEL].beta[j]; });
const TAU = M[LEVEL].tau;
console.error(`モデル ${LEVEL}`);

const GROUP = {
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

const SNAP = new Map();
for (const l of fs.readFileSync(path.join(ROOT, 'data/keirin/odds_live.jsonl'), 'utf8').split('\n')) { if (!l) continue; try { const o = JSON.parse(l); if (o.odds?.e3) SNAP.set(o.raceId, o); } catch { } }
console.error(`締切8分前のスナップショット ${SNAP.size}R`);

const races = [];
eachLine('data/keirin/races.jsonl', l => {
  if (!/"result":\{/.test(l)) return;
  const d = (l.match(/"date":"(\d{8})"/) || [])[1];
  let r; try { r = JSON.parse(l); } catch { return; }
  if (!r.date || !r.riders?.length) return;
  const s = d >= FROM && SNAP.get(r.raceId);
  const fin = s && r.odds?.e3 ? r.odds.e3 : null;
  if (s) r.odds = s.odds;                       // 特徴量（市場は使わないが念のため）は実戦と同じ状態で
  const x = slim(r, s ? { pay: true, odds: true } : {});
  if (s && fin) { x.oddsFinal = fin; x.snap = true; }
  races.push(x);
});
races.sort((a, b) => a.date.localeCompare(b.date) || a.jcd.localeCompare(b.jcd) || a.r - b.r);
const ASOF = buildAsOf(races), featurize = makeFeaturizer(ASOF);

const clean = e3 => Object.fromEntries(Object.entries(e3 || {}).filter(([, o]) => o > 0 && o < 9999));
const rows = [];
for (const r of races) {
  if (!r.snap || !r.pay?.e3?.[0]) continue;
  const f = featurize(r); if (!f || !f.order || f.order.some(i => i < 0)) continue;
  const X = f.rows.map(x => x.x), U = utilities(X, beta), nos = f.rows.map(x => x.no);
  const C = combos(U, TAU, stageCtx(f), M[LEVEL].stage, nos);
  const e8 = clean(r.odds.e3), eF = clean(r.oddsFinal), q8 = marketOf(e8), qF = marketOf(eF); if (!q8 || !qF) continue;
  /* 1着：3連単から逆算 */
  const w8 = nos.map(() => 0), wF = nos.map(() => 0), idx = new Map(nos.map((n, i) => [String(n), i]));
  for (const [k, p] of Object.entries(q8)) { const i = idx.get(k.split('-')[0]); if (i != null) w8[i] += p; }
  for (const [k, p] of Object.entries(qF)) { const i = idx.get(k.split('-')[0]); if (i != null) wF[i] += p; }
  if (w8.some(v => !v) || wF.some(v => !v)) continue;
  const G = X.map(x => { const g = new Float64Array(GROUPS.length); for (let j = 0; j < NF; j++) if (gi[j] >= 0 && FEATURES[j] !== 'mktLog') g[gi[j]] += TAU[0] * beta[j] * x[j]; return g; });
  const win = r.pay.e3[0];
  const ks = [], pm = [], p8 = [], pF = [], o8 = [];
  for (const [k, p] of C.e3) { if (!q8[k] || !qF[k]) continue; ks.push(k); pm.push(p); p8.push(q8[k]); pF.push(qF[k]); o8.push(e8[k]); }
  const w = ks.indexOf(win.c); if (w < 0) continue;
  rows.push({ date: r.date, nos, win: f.order[0], G, w8, wF, ks, pm, p8, pF, o8, w, pay3: win.y, o8w: e8[win.c], oFw: eF[win.c] });
}
rows.sort((a, b) => a.date.localeCompare(b.date));
console.error(`標本 ${rows.length}R（${rows[0]?.date}〜${rows.at(-1)?.date}）`);

/* ---- 条件付きロジット（edge_boat_t1 と同じ） ---- */
function fitCL(data, D, l2 = 1e-3) {
  const b = new Float64Array(D);
  let H;
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
    const d = solve(H, Array.from(g)); let step = 0;
    for (let j = 0; j < D; j++) { b[j] += d[j]; step += Math.abs(d[j]); }
    if (step < 1e-7) break;
  }
  return { b: Array.from(b), se: Array.from({ length: D }, (_, i) => { const e = Array(D).fill(0); e[i] = 1; return Math.sqrt(Math.max(0, solve(H, e)[i])); }) };
}
function solve(A, y) {
  const n = y.length; A = A.map((r, i) => [...r, y[i]]);
  for (let i = 0; i < n; i++) { let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k; [A[i], A[p]] = [A[p], A[i]]; for (let k = i + 1; k < n; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j]; } }
  const x = Array(n).fill(0); for (let i = n - 1; i >= 0; i--) { let t = A[i][n]; for (let j = i + 1; j < n; j++) t -= A[i][j] * x[j]; x[i] = t / A[i][i]; } return x;
}
function llCL(data, b) {
  let s = 0;
  for (const C of data) { let mx = -Infinity; const z = C.map(c => { let t = 0; for (let j = 0; j < b.length; j++) t += b[j] * c.f[j]; if (t > mx) mx = t; return t; }); let Z = 0; for (const v of z) Z += Math.exp(v - mx); s -= z[C.findIndex(c => c.y)] - mx - Math.log(Z); }
  return s / data.length;
}
const L = v => Math.log(Math.max(v, 1e-7));
const sumG = g => g.reduce((a, b) => a + b, 0);

const winData = (rs, which, mode) => rs.map(x => x.G.map((g, i) => ({ f: Float64Array.from([L(x[which][i]), ...(mode === 'groups' ? g : mode === 'sum' ? [sumG(g)] : [])]), y: i === x.win })));
function partA(tr, te) {
  const out = {};
  for (const [name, which] of [['T-8', 'w8'], ['確定', 'wF']]) {
    const base = fitCL(winData(tr, which, 'none'), 1), sum = fitCL(winData(tr, which, 'sum'), 2), full = fitCL(winData(tr, which, 'groups'), 1 + GROUPS.length);
    out[name] = {
      logloss: { market: +llCL(winData(te, which, 'none'), [1]).toFixed(4), marketFit: +llCL(winData(te, which, 'none'), base.b).toFixed(4), modelSum: +llCL(winData(te, which, 'sum'), sum.b).toFixed(4), groups: +llCL(winData(te, which, 'groups'), full.b).toFixed(4) },
      modelSum: { market: +sum.b[0].toFixed(3), model: +sum.b[1].toFixed(3), se: +sum.se[1].toFixed(3) },
      coef: Object.fromEntries([['市場', 0], ...GROUPS.map((g, i) => [g, i + 1])].map(([g, i]) => [g, [+full.b[i].toFixed(3), +full.se[i].toFixed(3)]])),
    };
  }
  return out;
}
const triData = (rs, use) => rs.map(x => x.ks.map((_, i) => ({ f: Float64Array.from(use.map(u => L(x[u][i]))), y: i === x.w })));
function partB(tr, te) {
  const name = { pm: 'モデル', p8: 'T-8', pF: '確定' };
  const out = { raw: { model: +llCL(triData(te, ['pm']), [1]).toFixed(4), 'T-8': +llCL(triData(te, ['p8']), [1]).toFixed(4), '確定': +llCL(triData(te, ['pF']), [1]).toFixed(4) } };
  for (const use of [['p8'], ['pF'], ['pm', 'p8'], ['pm', 'pF'], ['pm', 'p8', 'pF']]) {
    const f = fitCL(triData(tr, use), use.length);
    out[use.map(u => name[u]).join('＋')] = { coef: Object.fromEntries(use.map((u, i) => [name[u], [+f.b[i].toFixed(3), +f.se[i].toFixed(3)]])), logloss: +llCL(triData(te, use), f.b).toFixed(4) };
  }
  return out;
}
function partC(tr, te) {
  const ft = fitCL(triData(tr, ['pm', 'p8']), 2).b, res = {};
  for (const th of [1.0, 1.1, 1.2, 1.3]) {
    let n = 0, ret = 0, hit = 0, ev = 0, races = 0;
    for (const x of te) {
      const z = x.ks.map((_, i) => ft[0] * L(x.pm[i]) + ft[1] * L(x.p8[i])); const mx = Math.max(...z); const e = z.map(v => Math.exp(v - mx)); const Z = e.reduce((a, b) => a + b, 0);
      const top = x.ks.map((k, i) => ({ i, p: e[i] / Z, o: x.o8[i] })).sort((a, b) => b.p - a.p).slice(0, 10).filter(c => c.p >= 0.01 && c.o <= 300 && c.p * c.o >= th);
      if (top.length) races++;
      for (const c of top) { n++; ev += c.p * c.o; if (c.i === x.w) { hit++; ret += x.pay3; } }
    }
    res[th] = { races, n, hit, roi: n ? +(ret / n / 100).toFixed(3) : null, expRoi: n ? +(ev / n).toFixed(3) : null };
  }
  let bn = 0, bret = 0; for (const x of te) { let bi = 0; for (let i = 1; i < x.p8.length; i++) if (x.p8[i] > x.p8[bi]) bi = i; bn++; if (bi === x.w) bret += x.pay3; }
  return { coef: ft.map(v => +v.toFixed(3)), byThreshold: res, base: { name: 'T-8の1番人気の3連単', n: bn, roi: +(bret / bn / 100).toFixed(3) } };
}

/* D. 3連単＝市場 × exp(w1·r_1着 + w2·r_2着 + w3·r_3着)。r はモデルの選手ごとの寄与（市場の項を除く）。
   モデルの3連単の分布を丸ごと混ぜると2・3着の部分が薄めてしまうので、選手の上乗せだけで市場を傾ける */
const tiltData = (rs, mk, k) => rs.map(x => { const ix = new Map(x.nos.map((n, i) => [String(n), i])), r = x.G.map(sumG); return x.ks.map((key, i) => { const [a, b, c] = key.split('-').map(n => r[ix.get(n)] || 0); return { f: Float64Array.from([L(x[mk][i]), a, b, c].slice(0, 1 + k)), y: i === x.w }; }); });
function partD(tr, te) {
  const out = {};
  for (const [nm, mk] of [['T-8', 'p8'], ['確定', 'pF']]) for (const k of [0, 1, 3]) {
    const f = fitCL(tiltData(tr, mk, k), 1 + k);
    out[`${nm}${k ? `＋1〜${k}着の傾き` : ''}`] = { coef: f.b.map((v, i) => [+v.toFixed(3), +f.se[i].toFixed(3)]), logloss: +llCL(tiltData(te, mk, k), f.b).toFixed(4) };
  }
  /* 買い：T-8 × 1着の傾き（前半で当てた重み）、上位10組から p×T-8オッズ ≥ 閾値。確定の払戻で精算 */
  const fb = fitCL(tiltData(tr, 'p8', 1), 2).b, buy = {};
  for (const th of [1.0, 1.1, 1.2, 1.3]) {
    let n = 0, ret = 0, hit = 0, ev = 0;
    for (const x of te) {
      const ix = new Map(x.nos.map((n, i) => [String(n), i])), r = x.G.map(sumG);
      const z = x.ks.map((key, i) => fb[0] * L(x.p8[i]) + fb[1] * (r[ix.get(key.split('-')[0])] || 0)); const mx = Math.max(...z); const e = z.map(v => Math.exp(v - mx)); const Z = e.reduce((a, b) => a + b, 0);
      for (const c of x.ks.map((k, i) => ({ i, p: e[i] / Z, o: x.o8[i] })).sort((a, b) => b.p - a.p).slice(0, 10).filter(c => c.p >= 0.01 && c.o <= 300 && c.p * c.o >= th)) { n++; ev += c.p * c.o; if (c.i === x.w) { hit++; ret += x.pay3; } }
    }
    buy[th] = { n, hit, roi: n ? +(ret / n / 100).toFixed(3) : null, expRoi: n ? +(ev / n).toFixed(3) : null };
  }
  out.buy = buy;
  return out;
}

const mid = rows[Math.floor(rows.length / 2)].date;
const H1 = rows.filter(x => x.date < mid), H2 = rows.filter(x => x.date >= mid);
console.error(`前半 ${H1.length}R（〜${mid}）／後半 ${H2.length}R`);
const res = {};
for (const [name, tr, te] of [['前半→後半', H1, H2], ['後半→前半', H2, H1]]) {
  res[name] = { A: partA(tr, te), B: partB(tr, te), C: partC(tr, te), D: partD(tr, te) };
  console.error(`\n== ${name}`);
  for (const [k, v] of Object.entries(res[name].A)) {
    console.error(`[1着 ${k}] logloss 市場 ${v.logloss.market}／市場(較正) ${v.logloss.marketFit}／＋モデル一括 ${v.logloss.modelSum}／＋グループ別 ${v.logloss.groups}   一括の係数 ${v.modelSum.model}±${v.modelSum.se}`);
    console.error('   ' + Object.entries(v.coef).map(([g, [b, s]]) => `${g} ${b}±${s}`).join('  '));
  }
  const B = res[name].B;
  console.error(`[3連単] raw: モデル ${B.raw.model}／T-8 ${B.raw['T-8']}／確定 ${B.raw['確定']}`);
  for (const [k, v] of Object.entries(B)) if (k !== 'raw') console.error(`   ${k}: ${v.logloss}  ${Object.entries(v.coef).map(([g, [b, s]]) => `${g} ${b}±${s}`).join(' ')}`);
  for (const [k, v] of Object.entries(res[name].D)) console.error(`[傾き] ${k}: ${k === 'buy' ? JSON.stringify(v) : v.logloss + '  ' + v.coef.map(([b, s]) => b + '±' + s).join(' ')}`);
  console.error(`[買い] 3連単 ${JSON.stringify(res[name].C.byThreshold)}  基準 ${res[name].C.base.name} ${res[name].C.base.roi}`);
}
const v = rows.filter(x => x.o8w > 0 && x.oFw > 0).map(x => Math.log(x.oFw / x.o8w)).sort((a, b) => a - b);
const drift = { n: v.length, median: +Math.exp(v[v.length >> 1]).toFixed(3), mean: +Math.exp(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) };
console.error(`\nオッズの動き（当たった組、確定/T-8）${JSON.stringify(drift)}`);
writeJSON(LEVEL === 'joint' ? 'data/keirin/edge.joint.json' : 'data/keirin/edge.json', { level: LEVEL, builtAt: new Date().toISOString(), n: rows.length, from: rows[0].date, to: rows.at(-1).date, split: mid, groups: GROUPS, drift, res });
