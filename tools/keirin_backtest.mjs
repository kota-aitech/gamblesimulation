/* 競輪の買い方ごとの的中率・回収率 → data/keirin/backtest.json（ばんえい・JRA と同じ作り）
     KR_BT_FROM / KR_BT_TO … 検証期間（既定は model.json の検証期間）
     KR_BT_LEVEL … base | joint（既定 joint があれば joint。オッズの無いレースは base）
   精算は lib/krsettle.mjs（日別成績と同じ式）。オッズは結果ページの確定値なので、期待値の買い方は実戦よりやや有利に出る。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/kr.mjs';
import { FEATURES, NF, slim, buildAsOf, makeFeaturizer, stageCtx, combos, lineInfo } from './lib/krfeat.mjs';
import { utilities } from './lib/bpl.mjs';
import { BETS, settle } from './lib/krsettle.mjs';

const M = readJSON('data/keirin/model.json');
const FROM = process.env.KR_BT_FROM || M.meta.split, TO = process.env.KR_BT_TO || '99999999';
const LEVEL = process.env.KR_BT_LEVEL || (M.joint ? 'joint' : 'base');
const beta = new Float64Array(NF), betaJ = new Float64Array(NF);
FEATURES.forEach((k, i) => { const j = M.meta.feats.indexOf(k); if (j >= 0) { beta[i] = M.base.beta[j]; if (M.joint) betaJ[i] = M.joint.beta[j]; } });
const races = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/keirin/races.jsonl'), 'utf8').split('\n')) {
  if (!l || !/"result":\{/.test(l)) continue;
  const d = (l.match(/"date":"(\d{8})"/) || [])[1];
  let r; try { r = JSON.parse(l); } catch { continue; }
  if (!r.date || !r.riders?.length) continue;
  const inTest = d >= FROM && d <= TO;
  races.push(slim(r, inTest ? { pay: true, odds: true } : {}));
}
races.sort((a, b) => a.date.localeCompare(b.date) || a.jcd.localeCompare(b.jcd) || a.r - b.r);
const ASOF = buildAsOf(races), featurize = makeFeaturizer(ASOF);
const T = Object.fromEntries(BETS.map(b => [b, { races: 0, bet: 0, ret: 0, hit: 0 }]));
const byMonth = {}, byGrade = {}, byVenue = {};
const VB = ['◎-○ 2車複', '◎→○ 2車単', '3車BOX 3連複', '4車BOX 3連複', 'ライン 2車単 表裏2点', 'AI 3連単 上位5点', 'AI 2車単 上位3点', 'AI 3連複 上位3点'];
let nR = 0, hit1 = 0, in3 = 0, lastDate = null;
for (const r of races) {
  if (r.date < FROM || r.date > TO || !r.pay) continue;
  const f = featurize(r); if (!f || !f.order || f.order.some(i => i < 0)) continue;
  let U = utilities(f.rows.map(x => x.x), beta), tau = M.base.tau, stage = M.base.stage;
  if (LEVEL === 'joint' && M.joint && f.mkt) { U = utilities(f.rows.map(x => x.x), betaJ); tau = M.joint.tau; stage = M.joint.stage; }
  const nos = f.rows.map(x => x.no);
  const C = combos(U, tau, stageCtx(f), stage, nos);
  const top = C.p1.map((p, i) => [p, nos[i]]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const ev = r.odds?.e3 ? C.e3.slice(0, 60).filter(([k, p]) => { const o = r.odds.e3[k]; return o && o < 9999 && p >= 0.01 && o <= 300 && p * o >= 1; }).sort((a, b) => b[1] * r.odds.e3[b[0]] - a[1] * r.odds.e3[a[0]]).slice(0, 6).map(x => x[0]) : [];
  let line = null;
  if (f.known && !f.race.girls) { const w = f.rows[nos.indexOf(top[0])].li; if (w.size >= 2) { const L0 = f.lines[w.li]; const mate = w.pos === 0 ? L0[1] : L0[w.pos - 1]; line = { e2: [`${top[0]}-${mate}`, `${mate}-${top[0]}`] }; } }
  const mkt = f.mkt ? f.mkt.map((q, i) => [q, nos[i]]).sort((a, b) => b[0] - a[0]).map(x => x[1]) : null;
  const S = settle({ top, ai: { e3: C.e3.slice(0, 10).map(x => x[0]), q3: C.q3.slice(0, 3).map(x => x[0]), e2: C.e2.slice(0, 3).map(x => x[0]), q2: C.q2.slice(0, 3).map(x => x[0]), ev, line }, mkt, mktE3: r.mktE3?.[0]?.[0] || null }, r);
  if (!S) continue;
  nR++; hit1 += S.hit1; in3 += S.in3; if (!lastDate || r.date > lastDate) lastDate = r.date;
  for (const [b, x] of Object.entries(S.bets)) { const t = T[b]; t.races++; t.bet += x.bet; t.ret += x.ret; t.hit += x.hit; }
  /* 月・グレード・場ごと：◎1着と、主な買い方の回収率（TOP の「場別の成績」の右端＝検証の同型） */
  for (const [key, G] of [[r.date.slice(0, 6), byMonth], [r.grade || '?', byGrade], [r.venue, byVenue]]) {
    const g = G[key] ||= { races: 0, hit1: 0, bets: {} };
    g.races++; g.hit1 += S.hit1;
    for (const b of VB) { const x = S.bets[b]; if (!x || !x.bet) continue; const y = (g.bets[b] ||= { bet: 0, ret: 0 }); y.bet += x.bet; y.ret += x.ret; }
  }
}
const table = Object.fromEntries(Object.entries(T).filter(([, v]) => v.races).map(([k, v]) => [k, { races: v.races, hit: +(100 * v.hit / v.races).toFixed(1), roi: v.bet ? +(100 * v.ret / v.bet).toFixed(1) : null, bet: v.bet, ret: v.ret }]));
const fin = G => Object.fromEntries(Object.entries(G).map(([k, g]) => [k, { races: g.races, hit1: +(g.hit1 / g.races).toFixed(3), ...Object.fromEntries(Object.entries(g.bets).map(([b, y]) => [b, +(y.ret / y.bet).toFixed(3)])) }]));
writeJSON('data/keirin/backtest.json', { meta: { level: LEVEL, from: FROM, to: TO === '99999999' ? lastDate : TO, races: nR, hit1: +(hit1 / nR).toFixed(4), in3: +(in3 / nR).toFixed(4), note: '3連単オッズは結果ページの確定値（締切前の値ではない）なので、joint と期待値の買い方は実戦よりやや有利' }, table, byMonth: fin(byMonth), byGrade: fin(byGrade), byVenue: fin(byVenue) });
console.error(`検証 ${nR}R（${LEVEL}）◎1着 ${(100 * hit1 / nR).toFixed(1)}%／上位3車に1着 ${(100 * in3 / nR).toFixed(1)}%`);
for (const [k, v] of Object.entries(table)) if (v.bet) console.error(`  ${k.padEnd(18)} 的中 ${String(v.hit).padStart(5)}%  回収 ${String(v.roi).padStart(6)}%`);
