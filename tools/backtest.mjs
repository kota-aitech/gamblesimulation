/* 予想の当て方ごとに、実際に買っていたらどうだったかを日別に集計する。

   比べる予想（predictor）
     sim    いまの3Dシミュレータ（monteCarlo）
     fund   条件付きロジット・第1段（オッズを使わない）
     blend  条件付きロジット・第2段（第1段と単勝人気を合成）
     pub    単勝人気だけ（ものさし）

   買い方
     BOX    上位 k 頭の総流し。1点100円
     value  組み合わせの確率が市場の値付けを上回るものだけ買う（期待値ベース）
            市場の値付けは単勝オッズから Harville で組み合わせ確率に直して使う。
            買うかどうかの判断は発走前に分かる情報だけ、精算は実際の配当。

   使い方: NK_BT_TRACKS=大井,川崎 NK_BT_FROM=2026-08-18 NK_BT_TO=2026-09-07 node tools/backtest.mjs
   出力: data/nankan/backtest.json                                            */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { makeFeaturizer, buildLapIndex, buildShikenIndex, buildFormIndex, FEATURES } from './lib/feat.mjs';
import { loadModel, condOf } from './lib/model.mjs';
import { predictRace } from './lib/nkstage.mjs';

const TRACKS = (process.env.NK_BT_TRACKS || '大井').split(',');
const KEY = { '大井': 'oi', '川崎': 'kawasaki', '船橋': 'funabashi', '浦和': 'urawa' };
const FROM = process.env.NK_BT_FROM || '2000-01-01';
const TO = process.env.NK_BT_TO || new Date().toISOString().slice(0, 10);
const TRIALS = Number(process.env.NK_BT_TRIALS || 800);
const SIZES = (process.env.NK_BT_SIZES || '3,4,5,6').split(',').map(Number);
const EDGE = Number(process.env.NK_BT_EDGE || 1.3);   // 市場の何倍の確率で買うか
const TAKEOUT = Number(process.env.NK_BT_TAKEOUT || 0.25);
const UNIT = 100;
const WANT = (process.env.NK_BT_MODELS || 'sim,fund,blend,joint,pub').split(',');

const DB = readJSON(process.env.NK_BT_DB || 'data/nankan/index.train.json');
const MODEL = fs.existsSync(path.join(ROOT, 'data/nankan/model.json')) ? readJSON('data/nankan/model.json') : null;
const featurize = makeFeaturizer(DB);
/* 取得ジョブが追記中でも壊れないよう、読めない行は捨てる */
const jl = f => fs.readFileSync(path.join(ROOT, 'data/nankan', f), 'utf8').split('\n')
  .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const cards = jl('cards.jsonl');
const resArr = jl('results.jsonl');
const LAP = buildLapIndex(resArr, cards);
/* 能力・調教試験（新馬・転入初戦の手がかり）*/
try { LAP.shiken = buildShikenIndex(jl('shiken.jsonl')); } catch { LAP.shiken = null; }
/* 騎手・調教師の「そのレース時点」の調子（過去の騎乗だけから作る）*/
LAP.form = buildFormIndex(cards, resArr);
const results = new Map(resArr.map(r => [r.raceId, r]));
const payouts = new Map(jl('payouts.jsonl').map(p => [p.raceId, p]));
const oddsMap = new Map((fs.existsSync(path.join(ROOT, 'data/nankan/odds.jsonl')) ? jl('odds.jsonl') : []).map(o => [o.raceId, o]));

/* ---- 確率 ---- */
const softmax = us => { const mx = Math.max(...us); const e = us.map(u => Math.exp(u - mx)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); };
function logitP(f) {
  if (!MODEL) return null;
  const { mean, sd, beta } = MODEL;
  return softmax(f.rows.map(h => FEATURES.reduce((s, k, i) => s + beta[i] * ((h.x[k] - mean[k]) / sd[k]), 0)));
}
function publicP(f, od) {
  if (!od) return null;
  const o = f.rows.map(h => (od.tan[h.no] || {}).odds);
  if (!o.every(x => x > 0)) return null;
  const inv = o.map(x => 1 / x), z = inv.reduce((a, b) => a + b, 0);
  return inv.map(x => x / z);
}
const blendP = (pf, pp) => (MODEL && MODEL.beta2 && pf && pp)
  ? softmax(pf.map((x, i) => MODEL.beta2[0] * Math.log(x) + MODEL.beta2[1] * Math.log(pp[i]))) : null;

/* Harville: 勝率から「1着→2着→3着」の並びの確率を出す */
function plProb(p, idxs) {
  let q = 1, rest = p.slice();
  for (const i of idxs) {
    const z = rest.reduce((a, b) => a + b, 0);
    if (z <= 0) return 0;
    q *= rest[i] / z;
    rest = rest.slice(); rest[i] = 0;
  }
  return q;
}
const permute2 = (p, a, b) => plProb(p, [a, b]) + plProb(p, [b, a]);
const permute3 = (p, a, b, c) => [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]].reduce((s, o) => s + plProb(p, o), 0);

/* ---- 買い目（BOX） ---- */
const pairs = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) o.push([a[i], a[j]]); return o; };
const ordPairs = a => { const o = []; for (const x of a) for (const y of a) if (x !== y) o.push([x, y]); return o; };
const triples = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) for (let k = j + 1; k < a.length; k++) o.push([a[i], a[j], a[k]]); return o; };
const ordTriples = a => { const o = []; for (const x of a) for (const y of a) for (const z of a) if (x !== y && y !== z && x !== z) o.push([x, y, z]); return o; };
const key = a => a.join('-');
const sortKey = a => a.slice().sort((x, y) => x - y).join('-');
function wakutanSet(sel, gateOf) {
  const gs = sel.map(gateOf), cnt = {};
  gs.forEach(g => cnt[g] = (cnt[g] || 0) + 1);
  const uniq = [...new Set(gs)], s = new Set();
  for (const a of uniq) for (const b of uniq) { if (a !== b) s.add(`${a}-${b}`); else if (cnt[a] >= 2) s.add(`${a}-${a}`); }
  return s;
}
const betsFor = (sel, gateOf) => ({
  umaren: new Set(pairs(sel).map(sortKey)),
  umatan: new Set(ordPairs(sel).map(key)),
  sanpuku: sel.length >= 3 ? new Set(triples(sel).map(sortKey)) : new Set(),
  santan: sel.length >= 3 ? new Set(ordTriples(sel).map(key)) : new Set(),
  wakutan: wakutanSet(sel, gateOf),
});
const norm = { umaren: sortKey, umatan: key, sanpuku: sortKey, santan: key, wakutan: key };
const TYPES = [['umaren', '馬連'], ['umatan', '馬単'], ['sanpuku', '三連複'], ['santan', '三連単'], ['wakutan', '枠単']];

const blank = () => ({ races: 0, points: 0, cost: 0, hits: 0, ret: 0 });
const bump = (acc, t, k, pts, hit, ret) => {
  const e = (acc[t] ||= {})[k] ||= blank();
  e.races++; e.points += pts; e.cost += pts * UNIT; if (hit) { e.hits++; e.ret += ret; }
};
const finish = acc => {
  for (const t of Object.keys(acc)) for (const k of Object.keys(acc[t])) {
    const e = acc[t][k];
    e.hitRate = e.races ? +(e.hits / e.races).toFixed(4) : 0;
    e.roi = e.cost ? +(e.ret / e.cost).toFixed(4) : 0;
    e.avgPoints = e.races ? +(e.points / e.races).toFixed(1) : 0;
  }
  return acc;
};
const payHit = (pay, t, set) => {
  let ret = 0, hit = false;
  for (const p of (pay.pay[t] || [])) {
    const kk = norm[t](p.c.split('-').map(Number));
    if (set.has(kk)) { hit = true; ret += p.yen; }
  }
  return { hit, ret };
};

const out = { builtAt: new Date().toISOString(), from: FROM, to: TO, trials: TRIALS, unit: UNIT,
  sizes: SIZES, models: WANT, edge: EDGE, takeout: TAKEOUT, model: MODEL ? { split: MODEL.split, metrics: MODEL.metrics, beta2: MODEL.beta2 } : null, tracks: {} };

for (const track of TRACKS) {
  const M = loadModel(KEY[track] || 'oi');
  const mine = cards.filter(c => c.track === track && c.date >= FROM && c.date <= TO && payouts.has(c.raceId));
  const byDay = {}, agg = {}, detail = [];
  const valueAgg = {};
  for (const m of WANT) { agg[m] = {}; valueAgg[m] = {}; }

  for (const c of mine.sort((a, b) => a.raceId.localeCompare(b.raceId))) {
    const pay = payouts.get(c.raceId), res = results.get(c.raceId), od = oddsMap.get(c.raceId);
    if (!pay || !pay.order || pay.order.length < 3) continue;
    const f = featurize(c, res && res.baba, null, LAP);
    if (!f) continue;
    const gateOf = no => (f.rows.find(h => h.no === no) || {}).gate || 0;
    const nos = f.rows.map(h => h.no);

    /* 各予想の勝率ベクトル */
    const P = {};
    if (WANT.includes('sim')) {
      const horses = f.rows.map(h => ({ no: h.no, gate: h.gate, ...h.d, ...h.hu, ...h.pd }));
      const mc = M.monteCarlo({ dist: c.dist, horses }, condOf(M, c.dist, res && res.baba, res && res.weather), TRIALS);
      P.sim = mc.win;
    }
    const pf = logitP(f), pp = publicP(f, od);
    if (WANT.includes('fund')) P.fund = pf;
    if (WANT.includes('pub')) P.pub = pp;
    if (WANT.includes('blend')) P.blend = blendP(pf, pp);
    /* joint（市場つき）と、段階モデルの組の確率（期待値ベースの買い目で使う） */
    const PR = MODEL ? predictRace(MODEL, f, od ? od.tan : null) : null;
    if (WANT.includes('joint') && PR && PR.src === 'joint') P.joint = PR.p;
    const CB = PR ? PR.combos : null;

    const dayAcc = (byDay[c.date] ||= { date: c.date, races: 0, model: {}, pop: {} });
    dayAcc.races++;

    for (const m of WANT) {
      const p = P[m];
      if (!p) continue;
      const rank = p.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => nos[i]);
      for (const k of SIZES) {
        if (nos.length < k) continue;
        const bets = betsFor(rank.slice(0, k), gateOf);
        for (const [t] of TYPES) {
          const { hit, ret } = payHit(pay, t, bets[t]);
          bump(agg[m], t, k, bets[t].size, hit, ret);
          if (m === 'sim') bump(dayAcc.model, t, k, bets[t].size, hit, ret);
          if (m === 'pub') bump(dayAcc.pop, t, k, bets[t].size, hit, ret);
          (dayAcc[m] ||= {}) && bump(dayAcc[m], t, k, bets[t].size, hit, ret);
        }
      }
      /* 期待値ベース：馬連と三連複だけ（点数が現実的なので） */
      if (pp) {
        for (const [t, need] of [['umaren', 2], ['sanpuku', 3]]) {
          const combos = need === 2 ? pairs(nos.map((_, i) => i)) : triples(nos.map((_, i) => i));
          const buy = new Set();
          for (const cb of combos) {
            /* 段階モデルの組の確率は joint（＝predictRace の勝率）のときだけ。他のモデルは自分の勝率から Harville */
            const q = (CB && m === 'joint') ? ((need === 2 ? CB.umaren : CB.sanpuku).get(sortKey(cb)) || 0) : (need === 2 ? permute2(p, cb[0], cb[1]) : permute3(p, cb[0], cb[1], cb[2]));
            const qm = need === 2 ? permute2(pp, cb[0], cb[1]) : permute3(pp, cb[0], cb[1], cb[2]);
            if (qm > 0 && q / qm >= EDGE && q * (1 - TAKEOUT) / qm >= 1) buy.add(sortKey(cb.map(i => nos[i])));
          }
          // 買い目ゼロのレースも「見送った1レース」として数える
          if (!buy.size) { bump(valueAgg[m], t, 'v', 0, false, 0); continue; }
          const { hit, ret } = payHit(pay, t, buy);
          bump(valueAgg[m], t, 'v', buy.size, hit, ret);
        }
      }
    }
    const best = P.joint || P.blend || P.fund || P.sim;
    if (best) detail.push({ date: c.date, R: c.R, dist: c.dist, n: nos.length, baba: res ? res.baba : '',
      pick: best.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).slice(0, 6).map(([, i]) => nos[i]),
      popPick: pp ? pp.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).slice(0, 6).map(([, i]) => nos[i]) : [],
      order: pay.order, santan: pay.pay.santan[0] ? pay.pay.santan[0].yen : null });
  }
  for (const d of Object.values(byDay)) { finish(d.model); finish(d.pop); for (const m of WANT) if (d[m]) finish(d[m]); }
  for (const m of WANT) { finish(agg[m]); finish(valueAgg[m]); }
  out.tracks[track] = { track, days: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
    total: agg.sim || agg.fund || {}, popTotal: agg.pub || {}, byModel: agg, value: valueAgg,
    races: detail.length, detail };

  console.error(`\n=== ${track}  ${FROM}〜${TO}  ${detail.length}レース（1点${UNIT}円）`);
  const LB = { sim: 'シミュ', fund: 'ロジット', blend: '合成', joint: 'joint', pub: '人気' };
  for (const [t, ja] of TYPES) {
    console.error(`-- ${ja}`);
    for (const k of SIZES) {
      const line = WANT.map(m => {
        const e = agg[m][t] && agg[m][t][k];
        return e ? `${LB[m]} ${(e.roi * 100).toFixed(0).padStart(3)}%/${(e.hitRate * 100).toFixed(0).padStart(2)}%` : `${LB[m]} —`;
      }).join('  ');
      console.error(`   ${k}頭BOX  ${line}`);
    }
  }
  console.error('-- 期待値ベース（市場の' + EDGE + '倍以上の確率のものだけ）');
  for (const t of ['umaren', 'sanpuku']) {
    const line = WANT.map(m => {
      const e = valueAgg[m][t] && valueAgg[m][t].v;
      return e ? `${LB[m]} ${(e.roi * 100).toFixed(0)}%/${e.hits}的中/${e.points}点` : `${LB[m]} —`;
    }).join('  ');
    console.error(`   ${t === 'umaren' ? '馬連' : '三連複'}  ${line}`);
  }
}
writeJSON('data/nankan/backtest.json', out);
