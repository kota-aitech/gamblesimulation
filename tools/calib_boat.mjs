/* ボートの3連単の確率を、締切8分前の3連単オッズ（120通り）と合成して較正する → data/boat/calib.json
   式と理由は lib/calib.mjs。標本は odds_live.jsonl の T-8 スナップショットがあり、K（results.jsonl）に結果のあるレース。
   モデルの確率は backtest_boat と同じ作り（ex・段階モデル・index.train.json＝検証期間の結果を含まない指数）。
   前半で a・b を決め、後半で「モデルだけ／市場だけ／合成」の logloss と、段位（最良の買い目1点）の実際の当たり方を比べる。
     BT_CAL_SPLIT … 前半と後半を切る日（既定 標本の2/3の位置）
   本番の a・b は全標本で当て直した値を書く（後半の検証値も一緒に残す） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/bt.mjs';
import { loadRaces } from './lib/bload.mjs';
import { raceFeatures } from './lib/bfeat.mjs';
import { utilities, raceProbs } from './lib/bpl.mjs';
import { sampleOf, fitMix, logloss, mixProbs, marketOf, fitDrift, adjOdds, driftRows, gradeCheck } from './lib/calib.mjs';
import { bestCombo, bestComboCal, thresholdsOf, gradeOf } from './lib/grade.mjs';

const DB = readJSON('data/boat/index.train.json');
const ST = readJSON('data/boat/stadium.json');
const M = readJSON('data/boat/model.json');
const beta = Float64Array.from(M.ex.beta), TAU = M.ex.tau || [1, 1];

const SNAP = new Map();
for (const l of fs.readFileSync(path.join(ROOT, 'data/boat/odds_live.jsonl'), 'utf8').split('\n')) {
  if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
  if (o.kind === 'T-8' && o.ex3 && Object.keys(o.ex3).length >= 100) SNAP.set(`${o.date}|${o.jcd}|${o.r}`, o);
}
const dates = [...SNAP.keys()].map(k => k.slice(0, 8)).sort();
console.error(`T-8 スナップショット ${SNAP.size}R（${dates[0]}〜${dates.at(-1)}）`);
const races = loadRaces({ from: M.meta.split, keys: new Set(SNAP.keys()) });
console.error(`結果と突き合わせ ${races.length}R`);

const rows = [];
for (const r of races) {
  const s = SNAP.get(`${r.date}|${r.jcd}|${r.r}`);
  const [f1, f2, f3] = r.fin || []; if (!f3) continue;
  const X = raceFeatures(r, r.boats, DB, ST, { level: 'ex' });
  const PL = raceProbs(utilities(X, beta), TAU, X.ctx, M.stage || null);
  const lanes = r.boats.map(b => b.lane);
  const q = marketOf(s.ex3); if (!q) continue;
  const keys = [], pm = [], pq = [], od = [];
  for (const [a, b, c, p] of PL.tri) { const k = `${lanes[a]}-${lanes[b]}-${lanes[c]}`; if (!q[k]) continue; keys.push(k); pm.push(p); pq.push(q[k]); od.push(s.ex3[k]); }
  const w = keys.indexOf(`${f1}-${f2}-${f3}`); if (w < 0) continue;      // 欠場などで当たり組のオッズが無い
  const pay = (r.pay?.ex3 || []).find(x => x.c === `${f1}-${f2}-${f3}`)?.y || 0;
  rows.push({ date: r.date, keys, pm, pq, od, w, pay, S: sampleOf(pm, pq, w) });
}
rows.sort((a, b) => a.date.localeCompare(b.date));
const SPLIT = process.env.BT_CAL_SPLIT || rows[Math.floor(rows.length * 2 / 3)].date;
const tr = rows.filter(x => x.date < SPLIT), te = rows.filter(x => x.date >= SPLIT);
console.error(`前半 ${tr.length}R（〜${SPLIT}）／後半 ${te.length}R`);

const fit = fitMix(tr.map(x => x.S));
const ll = (S, a, b) => +logloss(S, a, b).toFixed(4);
const teS = te.map(x => x.S);
const evalLL = { model: ll(teS, 1, 0), market: ll(teS, 0, 1), mix: ll(teS, fit.a, fit.b) };
console.error(`a=${fit.a.toFixed(3)} b=${fit.b.toFixed(3)}  後半の logloss：モデル ${evalLL.model}／市場 ${evalLL.market}／合成 ${evalLL.mix}`);

/* 段位の検証（後半で精算）。
   before … 合成した確率のまま、全組から p×オッズ（締切8分前）最大の1点（2026-10-16 朝の作り）
   after  … 合成した確率の上位10組から、p×見込みの確定オッズ（fitDrift）最大の1点（2026-10-16 夕〜） */
const pickOf = (mix, drift) => x => {
  const p = mixProbs(x.pm, x.pq, mix);
  const list = x.keys.map((k, i) => ({ k, i, p: p[i], o: x.od[i], oa: adjOdds(x.od[i], p[i], x.pq[i], drift) }));
  const b = drift ? bestComboCal(list, '3連単') : bestCombo(list, '3連単'); if (!b) return null;
  const t = list.find(t => t.k === b.k); return { ...b, i: t.i, p: t.p, o: t.o, oa: t.oa };
};
const driftTr = fitDrift(driftRows(tr, fit));
console.error(`オッズの動き（前半）：log(確定/T-8) = ${driftTr[0]} + ${driftTr[1]}·log(合成/市場) + ${driftTr[2]}·log(オッズ)`);
const before = gradeCheck(tr, te, pickOf(fit, null), thresholdsOf, gradeOf), after = gradeCheck(tr, te, pickOf(fit, driftTr), thresholdsOf, gradeOf);
console.error('段位（後半、最良の買い目1点。見込みは確率と期待値から）');
for (const [name, t] of [['期待値そのまま', before], ['オッズの動きを織り込み・上位10組', after]]) for (const g of ['S', 'A', 'B', 'C']) { const o = t.grades[g]; if (o) console.error(`  ${name} ${g}: ${o.n}R 的中${o.hit}（見込み${o.expHit}）回収${(o.roi * 100).toFixed(0)}%（見込み${(o.expRoi * 100).toFixed(0)}±${(o.sd * 100).toFixed(0)}%）`); }

/* 本番は全標本で当て直す。閾値も全標本の合成EVの分布 */
const all = fitMix(rows.map(x => x.S), fit);
const drift = fitDrift(driftRows(rows, all));
const thrAll = thresholdsOf(rows.map(x => pickOf(all, drift)(x)?.ev).filter(v => v != null));
const out = {
  builtAt: new Date().toISOString(), kind: '3連単', n: rows.length, from: rows[0].date, to: rows.at(-1).date,
  a: +all.a.toFixed(4), b: +all.b.toFixed(4), drift, topN: 10, thresholds: thrAll,
  check: { split: SPLIT, train: tr.length, test: te.length, a: +fit.a.toFixed(4), b: +fit.b.toFixed(4), drift: driftTr, logloss: evalLL, before, after },
  note: 'p(組) ∝ p_モデル^a × p_市場^b（p_市場＝締切8分前の3連単オッズの逆数を120通りで正規化）。期待値は p × 見込みの確定オッズ（T-8 × exp(drift[0] + drift[1]·log(p/p_市場) + drift[2]·log(T-8))）、最良の買い目は合成確率の上位 topN 組から。check は前半で当てはめて後半で測った値',
};
writeJSON('data/boat/calib.json', out);
console.error(`全標本 a=${out.a} b=${out.b} drift=${drift} 閾値 ${JSON.stringify(thrAll)} → data/boat/calib.json`);
