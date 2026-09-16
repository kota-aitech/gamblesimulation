/* 終わったレースの「結果」を作る。出馬表からは今日以降しか出さないので、
   過去は必ずこちらに入る。予想印が当たったか、配当がいくらだったかまで残す。
   出力: data/nankan/results.<track>.json                                     */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { makeDerivers } from './lib/horse.mjs';
import { makeFeaturizer, buildLapIndex, buildShikenIndex, buildFormIndex, FEATURES } from './lib/feat.mjs';
import { betPlan, confOf } from './lib/bets.mjs';
import { predictRace } from './lib/nkstage.mjs';

const WANT = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki,船橋:funabashi,浦和:urawa').split(',').map(s => s.split(':'));
const NDAYS = Number(process.env.NK_RESULT_DAYS || 10);
const TODAY = process.env.NK_TODAY || new Date().toLocaleDateString('sv-SE');
const MAXPTS = Number(process.env.NK_BET_MAXPTS || 12);
const r3 = x => Math.round(x * 1000) / 1000;

const MODELFILE = fs.existsSync(path.join(ROOT, 'data/nankan/model.live.json'))
  ? 'data/nankan/model.live.json' : 'data/nankan/model.json';
const MDL = fs.existsSync(path.join(ROOT, MODELFILE)) ? readJSON(MODELFILE) : null;
const DB = readJSON('data/nankan/index.json');
const PICK = fs.existsSync(path.join(ROOT, 'data/nankan/racepick.json')) ? readJSON('data/nankan/racepick.json') : null;
const { derive } = makeDerivers(DB);
const featurize = makeFeaturizer(DB);

const jl = f => fs.readFileSync(path.join(ROOT, 'data/nankan', f), 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const cards = jl('cards.jsonl');
const resArr = jl('results.jsonl');
const LAP = buildLapIndex(resArr, cards);
/* 能力・調教試験（新馬・転入初戦の手がかり）*/
try { LAP.shiken = buildShikenIndex(jl('shiken.jsonl')); } catch { LAP.shiken = null; }
/* 騎手・調教師の「そのレース時点」の調子（過去の騎乗だけから作る）*/
LAP.form = buildFormIndex(cards, resArr);
const results = new Map(resArr.map(r => [r.raceId, r]));
const payouts = new Map(jl('payouts.jsonl').map(p => [p.raceId, p]));
const oddsMap = new Map();
for (const o of jl('odds.jsonl')) oddsMap.set(o.raceId, { src: '最終', tan: o.tan });
/* 暫定(odds_pre.json) → 締切前(T-n) の順に上書きするので、締切前があればそちらが残る */
try {
  const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/nankan/odds_pre.json'), 'utf8'));
  for (const o of Object.values(P)) oddsMap.set(o.raceId, { src: `暫定(発走${o.minsToPost}分前)`, tan: o.tan });
} catch {}
for (const o of jl('odds_live.jsonl')) if (o.tag !== 'final' && o.tag !== 'pre') oddsMap.set(o.raceId, { src: `締切前(発走${o.minsToPost}分前)`, tan: o.tan });

const softmax = us => { const mx = Math.max(...us); const e = us.map(u => Math.exp(u - mx)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); };
const gradeOf = ev => {
  const t = (PICK && PICK.thresholds && PICK.thresholds.evUmaren) || { p10: 1.35, p25: 1.21, p50: 1.08 };
  return ev >= t.p10 ? 'S' : ev >= t.p25 ? 'A' : ev >= t.p50 ? 'B' : 'C';
};
const MARKS = ['◎', '○', '▲', '△', '△', '☆'];
const JA_PAY = [['tan', '単勝'], ['fuku', '複勝'], ['umaren', '馬連'], ['wakutan', '枠単'],
  ['umatan', '馬単'], ['wide', 'ワイド'], ['sanpuku', '三連複'], ['santan', '三連単']];

for (const [jaName, key] of WANT) {
  /* 当日でも結果と払戻が取れていれば「終わったレース」として日別に入れる（夜に取り込んだ当日ぶん用） */
  const mine = cards.filter(c => c.track === jaName && c.date <= TODAY && results.has(c.raceId) && payouts.has(c.raceId));
  const dates = [...new Set(mine.map(c => c.date))].sort().slice(-NDAYS);
  const days = {}, races = {};
  for (const date of dates) {
    const rs = mine.filter(c => c.date === date).sort((a, b) => a.R - b.R);
    if (!rs.length) continue;
    const d = new Date(date + 'T00:00:00');
    const dk = `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]}) 第${Number(rs[0].raceId.slice(12, 14))}日`;
    days[dk] = [];
    for (const c of rs) {
      const res = results.get(c.raceId), pay = payouts.get(c.raceId), od = oddsMap.get(c.raceId);
      const live = c.horses.filter(h => !h.scratch);
      if (live.length < 2) continue;
      const f = featurize(c, res.baba, null, LAP);
      if (!f) continue;

      /* 当時と同じやり方で予想を再現する */
      let p = null, marketP = null, plan = null, grade = null, ev = null, combos = null;
      if (MDL) {
        const pr = predictRace(MDL, f, od ? od.tan : null, live.map(h => h.no));
        if (pr && pr.nos.length === live.length && live.every((h, i) => pr.nos[i] === h.no)) { p = pr.p; combos = pr.combos; marketP = pr.pm; }
      }
      if (p && marketP) {
        {
          plan = betPlan(p, marketP, live.map(h => h.no), MAXPTS, combos);
          ev = { umaren: plan.umaren.best, sanpuku: plan.sanpuku.best };
          grade = gradeOf(plan.umaren.best);
        }
      }
      const order = res.order;
      const posOf = no => { const i = order.indexOf(no); return i >= 0 ? i + 1 : null; };
      const rank = p ? p.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i) : [];
      const mark = {};
      rank.forEach((i, q) => { if (q < MARKS.length) mark[i] = MARKS[q]; });

      const horses = live.map((h, i) => {
        const d2 = derive(h, c.dist);
        return { no: h.no, gate: h.gate, name: h.name, style: d2.style,
          jockey: h.jockey, trainer: h.trainer,
          mark: mark[i] || '', win: p ? r3(p[i]) : null,
          odds: od && od.tan[h.no] ? od.tan[h.no].odds : null,
          pop: res.pops ? res.pops[h.no] || null : null,
          pos: posOf(h.no), last3f: res.last3f ? res.last3f[h.no] || null : null };
      }).sort((a, b) => (a.pos || 99) - (b.pos || 99) || a.no - b.no);

      /* 予想が当たったか */
      const top3 = order.slice(0, 3);
      const picked = rank.slice(0, 3).map(i => live[i].no);
      const hit = {
        win: picked[0] === order[0],
        winInTop3: picked.includes(order[0]),
        exact3: top3.every(n => picked.includes(n)),
      };
      /* 買い方ごとに、1点100円で買っていたらどうだったかを残す。
         ev  = 期待値1.0超だけ買う（市場と食い違う組を買う＝逆張りになる）
         box3/box4 = 予想上位3頭・4頭のBOX                                    */
      const sortKey = a => a.slice().sort((x, y) => x - y).join('-');
      const settle = (t, list) => {
        if (!list.length) return { pts: 0, cost: 0, ret: 0, hit: false, buy: [] };
        const set = new Set(list.map(sortKey));
        let ret = 0, ok = false;
        for (const q of (pay.pay[t] || [])) if (set.has(sortKey(q.c.split('-').map(Number)))) { ok = true; ret += q.yen; }
        return { pts: list.length, cost: list.length * 100, ret, hit: ok, buy: list.map(x => x.join('-')) };
      };
      const cmb2 = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) o.push([a[i], a[j]]); return o; };
      const cmb3 = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) for (let k = j + 1; k < a.length; k++) o.push([a[i], a[j], a[k]]); return o; };
      const betResult = {};
      if (plan) for (const t of ['umaren', 'sanpuku']) betResult[t] = settle(t, plan[t].buy.map(b => b.c));
      for (const k of [3, 4]) {
        const sel = rank.slice(0, k).map(i => live[i].no);
        if (sel.length < k) continue;
        betResult[`box${k}`] = { umaren: settle('umaren', cmb2(sel)), sanpuku: settle('sanpuku', cmb3(sel)) };
      }
      days[dk].push({ r: c.R, time: c.time, dist: c.dist, n: live.length, cls: c.cls, date: c.date,
        baba: res.baba, weather: res.weather, grade, ev, conf: p ? r3(confOf(p)) : null,
        oddsSrc: od ? od.src : null, hit, betResult,
        pay: Object.fromEntries(JA_PAY.map(([k]) => [k, (pay.pay[k] || []).map(q => ({ c: q.c, yen: q.yen, pop: q.pop }))])) });
      races[`${dk}|${c.R}`] = horses;
    }
    if (!days[dk].length) delete days[dk];
  }
  /* 実績のまとめ。画面に「この買い方は実際どうだったか」を必ず出すため。
     全期間ぶんと、日ごとの両方を持つ。 */
  const tally = {}, byDay = {};
  const bump2 = (acc, k, b) => { const e = acc[k] ||= { races: 0, cost: 0, ret: 0, hits: 0, pts: 0 };
    e.races++; e.cost += b.cost; e.ret += b.ret; e.pts += b.pts; if (b.hit) e.hits++; };
  let nR = 0, nWin = 0, nT3 = 0;
  for (const [dk, l] of Object.entries(days)) {
    const D = byDay[dk] ||= { date: l[0] ? l[0].date : '', races: 0, win: 0, top3: 0, tally: {}, oddsSrc: {} };
    for (const x of l) {
      nR++; D.races++;
      if (x.hit.win) { nWin++; D.win++; }
      if (x.hit.winInTop3) { nT3++; D.top3++; }
      const src = x.oddsSrc ? (x.oddsSrc.startsWith('締切前') ? '締切前' : x.oddsSrc.startsWith('暫定') ? '暫定' : '最終') : 'なし';
      D.oddsSrc[src] = (D.oddsSrc[src] || 0) + 1;
      const b = x.betResult || {};
      if (b.umaren) { bump2(tally, 'ev_umaren', b.umaren); bump2(D.tally, 'ev_umaren', b.umaren); }
      if (b.sanpuku) { bump2(tally, 'ev_sanpuku', b.sanpuku); bump2(D.tally, 'ev_sanpuku', b.sanpuku); }
      for (const k of [3, 4]) if (b[`box${k}`]) {
        bump2(tally, `box${k}_umaren`, b[`box${k}`].umaren); bump2(D.tally, `box${k}_umaren`, b[`box${k}`].umaren);
        bump2(tally, `box${k}_sanpuku`, b[`box${k}`].sanpuku); bump2(D.tally, `box${k}_sanpuku`, b[`box${k}`].sanpuku);
      }
    }
  }
  const fin2 = t => { for (const e of Object.values(t)) {
    e.roi = e.cost ? +(e.ret / e.cost).toFixed(4) : 0;
    e.hitRate = e.races ? +(e.hits / e.races).toFixed(4) : 0;
    e.avgPts = e.races ? +(e.pts / e.races).toFixed(1) : 0;
  } return t; };
  fin2(tally);
  for (const D of Object.values(byDay)) {
    fin2(D.tally);
    D.winRate = D.races ? +(D.win / D.races).toFixed(4) : 0;
    D.top3Rate = D.races ? +(D.top3 / D.races).toFixed(4) : 0;
  }
  const summary = { races: nR, winRate: nR ? +(nWin / nR).toFixed(4) : 0, winInTop3: nR ? +(nT3 / nR).toFixed(4) : 0, tally, byDay };
  const meta = { builtAt: new Date().toISOString(), model: MDL ? MODELFILE : null, payLabels: JA_PAY, summary };
  writeJSON(`data/nankan/results.${key}.json`, { track: jaName, meta, days, races });
  console.error(`${jaName}: ${Object.keys(days).length}日 ${nR}レース ／ ◎的中 ${(summary.winRate * 100).toFixed(0)}% ／ 上位3頭に勝ち馬 ${(summary.winInTop3 * 100).toFixed(0)}%`);
  console.error('  日別  R  ◎的中 上位3頭 三連複4頭BOX 馬連4頭BOX  オッズ');
  for (const [dk, D] of Object.entries(byDay)) {
    const f = k => { const e = D.tally[k]; return e ? `${(e.roi * 100).toFixed(0).padStart(4)}%/${(e.hitRate * 100).toFixed(0).padStart(2)}%` : '   —  '; };
    const src = Object.entries(D.oddsSrc).map(([k, v]) => `${k}${v}`).join(' ');
    console.error(`  ${dk.slice(0, 8).padEnd(9)} ${String(D.races).padStart(2)}  ${(D.winRate * 100).toFixed(0).padStart(4)}%  ${(D.top3Rate * 100).toFixed(0).padStart(4)}%     ${f('box4_sanpuku')}   ${f('box4_umaren')}  ${src}`);
  }
  for (const [k, e] of Object.entries(tally))
    console.error(`   ${k.padEnd(14)} 回収率 ${(e.roi * 100).toFixed(0).padStart(3)}%  的中 ${(e.hitRate * 100).toFixed(0).padStart(2)}%  平均${e.avgPts}点`);
}
