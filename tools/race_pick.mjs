/* レースごとに「自信度」と「期待値」を出し、それで買うレースを絞ると回収率が上がるのかを検証する。
   上がらないなら、おすすめレースの機能は作っても意味がない。まずここを確かめる。

     conf   予想の堅さ。1 − 正規化エントロピー（0〜1、大きいほど堅い）
     pTop   1位の確率
     ev     単勝オッズから推定した市場価格に対する、モデルの買い目の期待値（1.0が損益トントン）
            馬連・三連複それぞれで、全組み合わせのうち最良のものと、EV>1 の点数

   使い方: NK_BT_TRACKS=大井,川崎 NK_BT_FROM=2026-06-01 NK_BT_TO=2026-09-07 node tools/race_pick.mjs
   出力: data/nankan/racepick.json                                            */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { makeFeaturizer, buildLapIndex, buildShikenIndex, buildFormIndex, FEATURES } from './lib/feat.mjs';
import { betPlan, confOf } from './lib/bets.mjs';
import { predictRace } from './lib/nkstage.mjs';

const TRACKS = (process.env.NK_BT_TRACKS || '大井,川崎').split(',');
const FROM = process.env.NK_BT_FROM || '2026-06-01';
const TO = process.env.NK_BT_TO || '2026-09-07';
const TAKEOUT = Number(process.env.NK_BT_TAKEOUT || 0.25);
const UNIT = 100;
const BOX = Number(process.env.NK_PICK_BOX || 4);

const DB = readJSON(process.env.NK_BT_DB || 'data/nankan/index.train.json');
const MODEL = readJSON('data/nankan/model.json');
const featurize = makeFeaturizer(DB);
const jl = f => fs.readFileSync(path.join(ROOT, 'data/nankan', f), 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const cards = jl('cards.jsonl'), resArr = jl('results.jsonl');
const LAP = buildLapIndex(resArr, cards);
/* 能力・調教試験（新馬・転入初戦の手がかり）*/
try { LAP.shiken = buildShikenIndex(jl('shiken.jsonl')); } catch { LAP.shiken = null; }
/* 騎手・調教師の「そのレース時点」の調子（過去の騎乗だけから作る）*/
LAP.form = buildFormIndex(cards, resArr);
const results = new Map(resArr.map(r => [r.raceId, r]));
const payouts = new Map(jl('payouts.jsonl').map(p => [p.raceId, p]));
const oddsMap = new Map(jl('odds.jsonl').map(o => [o.raceId, o]));

const softmax = us => { const mx = Math.max(...us); const e = us.map(u => Math.exp(u - mx)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); };
const plProb = (p, idxs) => { let q = 1, rest = p.slice(); for (const i of idxs) { const z = rest.reduce((a, b) => a + b, 0); if (z <= 0) return 0; q *= rest[i] / z; rest = rest.slice(); rest[i] = 0; } return q; };
const pair2 = (p, a, b) => plProb(p, [a, b]) + plProb(p, [b, a]);
const tri3 = (p, a, b, c) => [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]].reduce((s, o) => s + plProb(p, o), 0);
const sortKey = a => a.slice().sort((x, y) => x - y).join('-');
const pairs = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) o.push([a[i], a[j]]); return o; };
const triples = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) for (let k = j + 1; k < a.length; k++) o.push([a[i], a[j], a[k]]); return o; };

const rows = [];
for (const c of cards) {
  if (!TRACKS.includes(c.track) || c.date < FROM || c.date > TO) continue;
  const pay = payouts.get(c.raceId), res = results.get(c.raceId), od = oddsMap.get(c.raceId);
  if (!pay || !pay.order || pay.order.length < 3 || !od) continue;
  const f = featurize(c, res && res.baba, null, LAP);
  if (!f || f.rows.length < 5) continue;
  const nos = f.rows.map(h => h.no);
  const o = nos.map(n => (od.tan[n] || {}).odds);
  if (!o.every(x => x > 0)) continue;
  const pr = predictRace(MODEL, f, od.tan);
  if (!pr || !pr.pm) continue;
  const pm = pr.pm, p = pr.p, combos = pr.combos;

  const rank = p.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  const sel = rank.slice(0, BOX).map(i => nos[i]);

  /* 期待値：現実的に買える範囲に絞ってから最大値を取る（lib/bets.mjs） */
  const plan = betPlan(p, pm, nos, 999, combos);
  const ev = { umaren: { best: plan.umaren.best, n: plan.umaren.nPos, buy: plan.umaren.buy.map(b => b.c.join('-')) },
               sanpuku: { best: plan.sanpuku.best, n: plan.sanpuku.nPos, buy: plan.sanpuku.buy.map(b => b.c.join('-')) } };

  /* 実際の結果 */
  const hitOf = (type, set) => {
    let hit = false, ret = 0;
    for (const q of (pay.pay[type] || [])) if (set.has(sortKey(q.c.split('-').map(Number)))) { hit = true; ret += q.yen; }
    return { hit, ret };
  };
  const boxUmaren = new Set(pairs(sel).map(sortKey)), boxSan = new Set(triples(sel).map(sortKey));
  rows.push({
    raceId: c.raceId, date: c.date, track: c.track, R: c.R, dist: c.dist, n: nos.length, cls: c.cls,
    conf: +confOf(p).toFixed(4), pTop: +Math.max(...p).toFixed(4),
    evUmaren: +ev.umaren.best.toFixed(3), evSanpuku: +ev.sanpuku.best.toFixed(3),
    nPosUmaren: ev.umaren.n, nPosSanpuku: ev.sanpuku.n,
    pick: rank.slice(0, 6).map(i => nos[i]),
    box: { umaren: { pts: boxUmaren.size, ...hitOf('umaren', boxUmaren) }, sanpuku: { pts: boxSan.size, ...hitOf('sanpuku', boxSan) } },
    val: { umaren: { pts: ev.umaren.buy.length, ...hitOf('umaren', new Set(ev.umaren.buy)) },
           sanpuku: { pts: ev.sanpuku.buy.length, ...hitOf('sanpuku', new Set(ev.sanpuku.buy)) } },
    order: pay.order.slice(0, 3),
  });
}
console.error(`対象 ${rows.length} レース（${FROM}〜${TO}）`);

/* --- 絞り込みが効くかを見る --- */
function report(label, key, kind) {
  const sorted = rows.slice().sort((a, b) => b[key] - a[key]);
  console.error(`\n■ ${label} の高い順に絞ったときの ${kind === 'box' ? BOX + '頭BOX' : '期待値ベース'} 回収率`);
  console.error('  絞込     R数   馬連            三連複');
  for (const frac of [0.1, 0.25, 0.5, 1.0]) {
    const take = sorted.slice(0, Math.max(1, Math.round(sorted.length * frac)));
    const line = ['umaren', 'sanpuku'].map(t => {
      let cost = 0, ret = 0, hits = 0;
      for (const r of take) { const b = r[kind][t]; cost += b.pts * UNIT; if (b.hit) { hits++; ret += b.ret; } }
      return cost ? `${(ret / cost * 100).toFixed(0).padStart(3)}%/的中${(hits / take.length * 100).toFixed(0).padStart(2)}%/${(cost / take.length).toFixed(0)}円` : '—';
    });
    console.error(`  上位${String(frac * 100).padStart(3)}%  ${String(take.length).padStart(4)}   ${line[0].padEnd(16)}${line[1]}`);
  }
}
report('自信度 conf', 'conf', 'box');
report('期待値 evUmaren', 'evUmaren', 'box');
report('期待値 evUmaren', 'evUmaren', 'val');
report('期待値 evSanpuku', 'evSanpuku', 'val');

/* 段位の閾値。おすすめレースの S/A/B/C はここで決める */
const q = (key, frac) => { const v = rows.map(r => r[key]).sort((a, b) => b - a); return v[Math.max(0, Math.round(v.length * frac) - 1)]; };
const thresholds = {
  conf: { p10: q('conf', .10), p25: q('conf', .25), p50: q('conf', .50) },
  evUmaren: { p10: q('evUmaren', .10), p25: q('evUmaren', .25), p50: q('evUmaren', .50) },
  evSanpuku: { p10: q('evSanpuku', .10), p25: q('evSanpuku', .25), p50: q('evSanpuku', .50) },
};
console.error('\n■ 段位の閾値', JSON.stringify(thresholds));
writeJSON('data/nankan/racepick.json', { builtAt: new Date().toISOString(), from: FROM, to: TO,
  box: BOX, takeout: TAKEOUT, thresholds, races: rows });

/* --- 前半で閾値を決めて後半で試す（同じデータで閾値を選ぶと甘く出るため） --- */
const byDate = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
const cut = Math.floor(byDate.length / 2);
const A = byDate.slice(0, cut), B = byDate.slice(cut);
console.error(`\n■ 前半 ${A.length}R（${A[0].date}〜${A[A.length-1].date}）で閾値を決め、後半 ${B.length}R（${B[0].date}〜${B[B.length-1].date}）で試す`);
const roi = (rs, kind, t) => {
  let cost = 0, ret = 0, hits = 0;
  for (const r of rs) { const b = r[kind][t]; cost += b.pts * UNIT; if (b.hit) { hits++; ret += b.ret; } }
  return { n: rs.length, cost, ret, hits, roi: cost ? ret / cost : 0, hitRate: rs.length ? hits / rs.length : 0 };
};
for (const key of ['conf', 'evUmaren', 'evSanpuku']) {
  for (const frac of [0.1, 0.25]) {
    const th = A.slice().sort((a, b) => b[key] - a[key])[Math.max(0, Math.round(A.length * frac) - 1)][key];
    const pick = B.filter(r => r[key] >= th);
    const line = ['umaren', 'sanpuku'].map(t => {
      const e = roi(pick, 'box', t);
      const all = roi(B, 'box', t);
      return `${t === 'umaren' ? '馬連' : '三連複'} ${(e.roi * 100).toFixed(0)}%（全体 ${(all.roi * 100).toFixed(0)}%）`;
    }).join('  ');
    console.error(`  ${key.padEnd(10)} 上位${String(frac * 100).padStart(3)}% 相当（閾値 ${th.toFixed(3)}）→ 後半 ${String(pick.length).padStart(3)}R  ${line}`);
  }
}
