/* ばんえいの買い方ごとの的中率・回収率 → data/banei/backtest.json（JRA の jra_backtest.mjs と同じ作り）
     BN_BT_FROM / BN_BT_TO … 検証期間（既定は model.json の検証期間）
     BN_BT_LEVEL … base | joint（既定 joint があれば joint） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/bn.mjs';
import { FEATURES, NF, buildRaceIndex, buildHistory, buildAsOf, buildLaneIndex, loadPed, raceFromResult, makeFeaturizer } from './lib/bnfeat.mjs';
import { utilities } from './lib/bpl.mjs';
import { combosOf } from './lib/jbets.mjs';

const M = readJSON('data/banei/model.json');
let DB = {}; try { DB = readJSON('data/banei/index.json'); } catch { }
const FROM = process.env.BN_BT_FROM || M.meta.split, TO = process.env.BN_BT_TO || '99999999';
const LEVEL = process.env.BN_BT_LEVEL || (M.joint ? 'joint' : 'base');
const tau = M.base.tau, tauJ = M.joint?.tau || tau;
const beta = new Float64Array(NF), betaJ = new Float64Array(NF);
{
  const F = M.meta.feats;
  FEATURES.forEach((k, i) => { const j = F.indexOf(k); if (j >= 0) { beta[i] = M.base.beta[j]; if (M.joint) betaJ[i] = M.joint.beta[j]; } });
  const extra = F.filter(k => !FEATURES.includes(k)); if (extra.length) throw new Error(`model.json に bnfeat.mjs に無い特徴量がある（${extra.join(',')}）`);
}
const results = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/banei/results.jsonl'), 'utf8').split('\n')) if (l) results.push(JSON.parse(l));
results.sort((a, b) => a.raceId.localeCompare(b.raceId));
const cardsFile = path.join(ROOT, 'data/banei/cards.jsonl');
const PED = loadPed(fs.existsSync(cardsFile) ? fs.readFileSync(cardsFile, 'utf8') : '');
const RI = buildRaceIndex(results), H = buildHistory(results, RI), ASOF = buildAsOf(results, PED), LANE = buildLaneIndex(results);
const featurize = makeFeaturizer(DB, RI, ASOF, LANE);

const payOf = (r, kind, code) => { const h = (r.pay?.[kind] || []).find(x => x.c === code); return h ? h.y : 0; };
const sortKey = a => a.slice().sort((x, y) => x - y).join('-');
const P = {};
const add = (name, bet, ret, hit) => { const o = P[name] ||= { bet: 0, ret: 0, hit: 0, races: 0 }; o.bet += bet; o.ret += ret; o.hit += hit ? 1 : 0; o.races++; };
const byMonth = {}, byMoist = {};
let nR = 0, hit1 = 0, in3 = 0;
for (const r of results) {
  if (r.date < FROM || r.date > TO) continue;
  const race = raceFromResult(r, H);
  if (race.order.some(i => i < 0)) continue;
  const f = featurize(race);
  if (!f) continue;
  let Um = utilities(f.rows.map(x => x.x), beta), tauR = tau;
  if (LEVEL === 'joint' && M.joint && f.mkt) { Um = utilities(f.rows.map(x => x.x), betaJ); tauR = tauJ; }
  const lanes = f.rows.map(x => x.no);
  const C = combosOf(Um, tauR, lanes);
  const ord = C.p1.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(x => lanes[x[1]]);
  const [f1, f2, f3] = race.order.map(i => race.horses[i].no);
  const e2k = `${f1}-${f2}`, q2 = sortKey([f1, f2]), s3 = sortKey([f1, f2, f3]), e3k = `${f1}-${f2}-${f3}`;
  nR++; if (ord[0] === f1) hit1++; if (ord.slice(0, 3).includes(f1)) in3++;
  const [t1, t2, t3, t4] = ord;
  add('◎単勝', 100, t1 === f1 ? payOf(r, 'win', String(t1)) : 0, t1 === f1);
  const plc = (r.pay?.place || []).find(x => x.c === String(t1)); add('◎複勝', 100, plc ? plc.y : 0, !!plc);
  add('◎○馬連', 100, sortKey([t1, t2]) === q2 ? payOf(r, 'umaren', q2) : 0, sortKey([t1, t2]) === q2);
  add('◎○馬単', 100, e2k === `${t1}-${t2}` ? payOf(r, 'umatan', e2k) : 0, e2k === `${t1}-${t2}`);
  for (const k of [3, 4, 5]) {
    const box = ord.slice(0, k);
    const hitQ = box.includes(f1) && box.includes(f2), hitS = hitQ && box.includes(f3);
    add(`${k}頭BOX馬連`, 100 * k * (k - 1) / 2, hitQ ? payOf(r, 'umaren', q2) : 0, hitQ);
    add(`${k}頭BOX三連複`, 100 * k * (k - 1) * (k - 2) / 6, hitS ? payOf(r, 'sanpuku', s3) : 0, hitS);
  }
  const h3 = t1 === f1 && [t2, t3, t4].includes(f2); add('◎→○▲△ 馬単3点', 300, h3 ? payOf(r, 'umatan', e2k) : 0, h3);
  const h6 = h3 && [t2, t3, t4].includes(f3); add('◎1着 三連単6点', 600, h6 ? payOf(r, 'santan', e3k) : 0, h6);
  for (const n of [3, 5, 8]) { const ks = C.santan.slice(0, n).map(x => x[0]); const h = ks.includes(e3k); add(`AI 三連単 上位${n}点`, 100 * n, h ? payOf(r, 'santan', e3k) : 0, h); }
  for (const n of [3, 5]) { const ks = C.umaren.slice(0, n).map(x => x[0]); const h = ks.includes(q2); add(`AI 馬連 上位${n}点`, 100 * n, h ? payOf(r, 'umaren', q2) : 0, h); }
  for (const n of [3, 5]) { const ks = C.sanpuku.slice(0, n).map(x => x[0]); const h = ks.includes(s3); add(`AI 三連複 上位${n}点`, 100 * n, h ? payOf(r, 'sanpuku', s3) : 0, h); }
  const pop1 = f.rows.slice().sort((a, b) => (a.pop || 99) - (b.pop || 99))[0];
  if (pop1?.pop === 1) add('［基準］1番人気の単勝', 100, pop1.no === f1 ? payOf(r, 'win', String(f1)) : 0, pop1.no === f1);
  const mo = byMonth[r.date.slice(0, 6)] ||= { races: 0, hit1: 0, in3: 0, win: { bet: 0, ret: 0 } };
  mo.races++; if (ord[0] === f1) mo.hit1++; if (ord.slice(0, 3).includes(f1)) mo.in3++; mo.win.bet += 100; mo.win.ret += t1 === f1 ? payOf(r, 'win', String(t1)) : 0;
  /* 馬場水分の帯ごと */
  const mb = r.moist == null ? '不明' : r.moist < 1 ? '〜0.9' : r.moist < 2 ? '1.0〜1.9' : r.moist < 3 ? '2.0〜2.9' : '3.0〜';
  const mm = byMoist[mb] ||= { races: 0, hit1: 0, in3: 0, win: { bet: 0, ret: 0 } };
  mm.races++; if (ord[0] === f1) mm.hit1++; if (ord.slice(0, 3).includes(f1)) mm.in3++; mm.win.bet += 100; mm.win.ret += t1 === f1 ? payOf(r, 'win', String(t1)) : 0;
}
const table = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, { races: v.races, hit: +(100 * v.hit / v.races).toFixed(1), roi: +(100 * v.ret / v.bet).toFixed(1), bet: v.bet, ret: v.ret }]));
const out = { meta: { level: LEVEL, from: FROM, to: TO, races: nR, hit1: +(hit1 / nR).toFixed(4), in3: +(in3 / nR).toFixed(4), note: LEVEL !== 'base' ? '単勝オッズは結果ページの確定値。締切前の値ではないので実戦よりやや有利' : '' }, table, byMonth, byMoist };
writeJSON('data/banei/backtest.json', out);
console.error(`検証 ${nR}R（${LEVEL}）1着的中 ${(100 * hit1 / nR).toFixed(1)}%／上位3頭に勝ち馬 ${(100 * in3 / nR).toFixed(1)}%`);
for (const [k, v] of Object.entries(table)) console.error(`  ${k.padEnd(16)} 的中 ${String(v.hit).padStart(5)}%  回収 ${String(v.roi).padStart(6)}%`);
