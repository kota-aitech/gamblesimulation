/* JRA の買い方ごとの的中率・回収率 → data/jra/backtest.json
   予想は jra_fit.mjs の model.json（第1段＋温度、オッズがあれば第2段）、払戻は results.jsonl の pay。
     JRA_BT_FROM / JRA_BT_TO … 検証期間（既定は model.json の検証期間）
     JRA_BT_LEVEL … base | mix | joint（既定 joint があれば joint、無ければ mix。results の単勝オッズは確定値なので実戦よりやや有利に出る）
   1点100円。買い方は南関・ボートと同じ考え方：本命BOX（3〜5頭）、◎の単複、◎○の馬連・馬単、AIの確率上位N点。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/jra.mjs';
import { NF, buildRaceIndex, buildHistory, buildAsOf, loadPed, raceFromResult, makeFeaturizer } from './lib/jfeat.mjs';
import { loadBaba } from './lib/jbaba.mjs';
import { buildBabaBias } from './lib/jbias.mjs';
import { utilities } from './lib/bpl.mjs';
import { combosOf } from './lib/jbets.mjs';

const M = readJSON('data/jra/model.json');
const DB = readJSON(M.meta.db || 'data/jra/index.json');
const FROM = process.env.JRA_BT_FROM || M.meta.split, TO = process.env.JRA_BT_TO || '9999-12-31';
const LEVEL = process.env.JRA_BT_LEVEL || (M.joint ? 'joint' : 'mix');
const tau = M.base.tau, mix = M.mix;
const beta = new Float64Array(NF), betaJ = new Float64Array(NF), tauJ = M.joint?.tau || tau;
{
  const F = M.meta.feats, { FEATURES } = await import('./lib/jfeat.mjs');
  FEATURES.forEach((k, i) => { const j = F.indexOf(k); if (j >= 0) { beta[i] = M.base.beta[j]; if (M.joint) betaJ[i] = M.joint.beta[j]; } });
  const extra = F.filter(k => !FEATURES.includes(k)); if (extra.length) throw new Error(`model.json に jfeat.mjs に無い特徴量がある（${extra.join(',')}）`);
}

const results = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/jra/results.jsonl'), 'utf8').split('\n')) if (l) { const r = JSON.parse(l); if (r.surface !== '障') results.push(r); }
results.sort((a, b) => a.date.localeCompare(b.date));
const PED = loadPed(fs.existsSync(path.join(ROOT, 'data/jra/horses.jsonl')) ? fs.readFileSync(path.join(ROOT, 'data/jra/horses.jsonl'), 'utf8') : '');
const RI = buildRaceIndex(results), H = buildHistory(results), ASOF = buildAsOf(results, PED);
console.error(`  血統・馬主 ${PED.size} 頭`);
const BABA_IDX = loadBaba();                       // 含水率・クッション値（場×芝ダで標準化して特徴量に効かせる）
const BIAS = buildBabaBias(results, BABA_IDX);     // 馬場の帯ごとの脚質・枠・騎手の得失（レース時点）
const featurize = makeFeaturizer(DB, RI, ASOF, BABA_IDX, BIAS);

const payOf = (r, kind, code) => { const h = (r.pay?.[kind] || []).find(x => x.c === code); return h ? h.y : 0; };
const sortKey = a => a.slice().sort((x, y) => x - y).join('-');
const P = {};
const add = (name, bet, ret, hit) => { const o = P[name] ||= { bet: 0, ret: 0, hit: 0, races: 0 }; o.bet += bet; o.ret += ret; o.hit += hit ? 1 : 0; o.races++; };
const byMonth = {}, byVenue = {};
let nR = 0, hit1 = 0, in3 = 0;
for (const r of results) {
  if (r.date < FROM || r.date > TO) continue;
  const race = raceFromResult(r, H);
  if (race.order.some(i => i < 0)) continue;
  const f = featurize(race);
  if (!f) continue;
  const U = utilities(f.rows.map(x => x.x), beta);
  let Um = U, tauR = tau;
  if (LEVEL === 'joint' && M.joint && f.rows.every(x => x.odds > 0)) { Um = utilities(f.rows.map(x => x.x), betaJ); tauR = tauJ; }
  else if (LEVEL === 'mix' && mix && f.rows.every(x => x.odds > 0)) {
    /* 第2段：a·τ1·U + b·log q を「1着の効用」に。2着以降は同じ比率で扱う */
    const inv = f.rows.map(x => 1 / x.odds), s = inv.reduce((a, b) => a + b, 0);
    Um = U.map((u, i) => (mix.a * tau[0] * u + mix.b * Math.log(inv[i] / s)) / tau[0]);
  }
  const lanes = f.rows.map(x => x.no);
  const C = combosOf(Um, tauR, lanes);
  const ord = C.p1.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(x => lanes[x[1]]);
  const [f1, f2, f3] = race.order.map(i => race.horses[i].no);
  const w1 = f1, e2k = `${f1}-${f2}`, q2 = sortKey([f1, f2]), s3 = sortKey([f1, f2, f3]), e3k = `${f1}-${f2}-${f3}`;
  nR++; if (ord[0] === w1) hit1++; if (ord.slice(0, 3).includes(w1)) in3++;
  const [t1, t2, t3, t4, t5] = ord;
  add('◎単勝', 100, t1 === w1 ? payOf(r, 'win', String(t1)) : 0, t1 === w1);
  const plc = (r.pay?.place || []).find(x => x.c === String(t1)); add('◎複勝', 100, plc ? plc.y : 0, !!plc);
  add('◎○馬連', 100, sortKey([t1, t2]) === q2 ? payOf(r, 'umaren', q2) : 0, sortKey([t1, t2]) === q2);
  add('◎○馬単', 100, e2k === `${t1}-${t2}` ? payOf(r, 'umatan', e2k) : 0, e2k === `${t1}-${t2}`);
  for (const k of [3, 4, 5]) {
    const box = ord.slice(0, k);
    const hitQ = box.includes(f1) && box.includes(f2), hitS = hitQ && box.includes(f3);
    add(`${k}頭BOX馬連`, 100 * k * (k - 1) / 2, hitQ ? payOf(r, 'umaren', q2) : 0, hitQ);
    add(`${k}頭BOX三連複`, 100 * k * (k - 1) * (k - 2) / 6, hitS ? payOf(r, 'sanpuku', s3) : 0, hitS);
  }
  add('◎→○▲△ 馬単3点', 300, t1 === f1 && [t2, t3, t4].includes(f2) ? payOf(r, 'umatan', e2k) : 0, t1 === f1 && [t2, t3, t4].includes(f2));
  add('◎1着 三連単6点', 600, t1 === f1 && [t2, t3, t4].includes(f2) && [t2, t3, t4].includes(f3) ? payOf(r, 'santan', e3k) : 0, t1 === f1 && [t2, t3, t4].includes(f2) && [t2, t3, t4].includes(f3));
  for (const n of [3, 5, 8]) { const ks = C.santan.slice(0, n).map(x => x[0]); const h = ks.includes(e3k); add(`AI 三連単 上位${n}点`, 100 * n, h ? payOf(r, 'santan', e3k) : 0, h); }
  for (const n of [3, 5]) { const ks = C.umaren.slice(0, n).map(x => x[0]); const h = ks.includes(q2); add(`AI 馬連 上位${n}点`, 100 * n, h ? payOf(r, 'umaren', q2) : 0, h); }
  for (const n of [3, 5]) { const ks = C.sanpuku.slice(0, n).map(x => x[0]); const h = ks.includes(s3); add(`AI 三連複 上位${n}点`, 100 * n, h ? payOf(r, 'sanpuku', s3) : 0, h); }
  /* 基準：単勝1番人気 */
  const pop1 = f.rows.slice().sort((a, b) => (a.pop || 99) - (b.pop || 99))[0];
  if (pop1?.pop === 1) { add('［基準］1番人気の単勝', 100, pop1.no === w1 ? payOf(r, 'win', String(w1)) : 0, pop1.no === w1); }
  /* 場別（画面の「場別の成績」用。◎単勝と本命4頭BOX三連複） */
  {
    const v = byVenue[r.venue] ||= { races: 0, hit1: 0, in3: 0, win: { bet: 0, ret: 0, hit: 0 }, box4: { bet: 0, ret: 0, hit: 0 }, box3: { bet: 0, ret: 0, hit: 0 } };
    v.races++; if (ord[0] === w1) v.hit1++; if (ord.slice(0, 3).includes(w1)) v.in3++;
    const wh = t1 === w1;
    v.win.bet += 100; v.win.ret += wh ? payOf(r, 'win', String(t1)) : 0; v.win.hit += wh ? 1 : 0;
    const b4v = ord.slice(0, 4), h4v = b4v.includes(f1) && b4v.includes(f2) && b4v.includes(f3);
    v.box4.bet += 400; v.box4.ret += h4v ? payOf(r, 'sanpuku', s3) : 0; v.box4.hit += h4v ? 1 : 0;
    const b3v = ord.slice(0, 3), h3v = b3v.includes(f1) && b3v.includes(f2) && b3v.includes(f3);
    v.box3.bet += 100; v.box3.ret += h3v ? payOf(r, 'sanpuku', s3) : 0; v.box3.hit += h3v ? 1 : 0;
  }
  const mo = byMonth[r.date.slice(0, 7)] ||= { races: 0, hit1: 0, in3: 0, win: { bet: 0, ret: 0 }, box4: { bet: 0, ret: 0 } };
  mo.races++; if (ord[0] === w1) mo.hit1++; if (ord.slice(0, 3).includes(w1)) mo.in3++;
  mo.win.bet += 100; mo.win.ret += t1 === w1 ? payOf(r, 'win', String(t1)) : 0;
  const b4 = ord.slice(0, 4), h4 = b4.includes(f1) && b4.includes(f2) && b4.includes(f3); mo.box4.bet += 400; mo.box4.ret += h4 ? payOf(r, 'sanpuku', s3) : 0;
}
const table = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, { races: v.races, hit: +(100 * v.hit / v.races).toFixed(1), roi: +(100 * v.ret / v.bet).toFixed(1), bet: v.bet, ret: v.ret }]));
const out = { meta: { level: LEVEL, from: FROM, to: TO, races: nR, hit1: +(hit1 / nR).toFixed(4), in3: +(in3 / nR).toFixed(4), note: LEVEL !== 'base' ? '単勝オッズは結果ページの確定値。締切前の値ではないので実戦よりやや有利' : '' }, table, byVenue: Object.fromEntries(Object.entries(byVenue).map(([k, v]) => [k, { races: v.races, hit1: +(100 * v.hit1 / v.races).toFixed(1), in3: +(100 * v.in3 / v.races).toFixed(1), winRoi: +(100 * v.win.ret / v.win.bet).toFixed(1), winHit: +(100 * v.win.hit / v.races).toFixed(1), box4Roi: +(100 * v.box4.ret / v.box4.bet).toFixed(1), box4Hit: +(100 * v.box4.hit / v.races).toFixed(1), box3Roi: +(100 * v.box3.ret / v.box3.bet).toFixed(1), box3Hit: +(100 * v.box3.hit / v.races).toFixed(1) }])), byMonth };
writeJSON('data/jra/backtest.json', out);
console.error(`検証 ${nR}R（${LEVEL}）1着的中 ${(100 * hit1 / nR).toFixed(1)}%／上位3頭に勝ち馬 ${(100 * in3 / nR).toFixed(1)}%`);
for (const [k, v] of Object.entries(table)) console.error(`  ${k.padEnd(16)} 的中 ${String(v.hit).padStart(5)}%  回収 ${String(v.roi).padStart(6)}%`);
console.error('-> data/jra/backtest.json');
