/* ばんえいの出馬表（cards.jsonl）にモデルを当てて banei.html に埋め込むデータを作る → data/banei/races.json / top.json
   JRA の jra_build_races.mjs と同じ作り。オッズが出ていれば joint、無ければ base。
     BN_TODAY … 基準日（既定 今日、YYYYMMDD）。これ以降の開催日だけ載せる
     BN_RECORD_PAST=1 … 過去日の出馬表からも予想を「再現」として記録する */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON, ymdOf } from './lib/bn.mjs';
import { FEATURES, NF, buildRaceIndex, buildHistory, buildAsOf, buildLaneIndex, loadPed, raceFromCard, makeFeaturizer } from './lib/bnfeat.mjs';
import { utilities } from './lib/bpl.mjs';
import { combosOf } from './lib/jbets.mjs';

const TODAY = process.env.BN_TODAY || ymdOf(new Date());
const DB = readJSON('data/banei/index.json');
const M = readJSON('data/banei/model.json');
let BT = null; try { BT = readJSON('data/banei/backtest.json'); } catch { }
const beta = new Float64Array(NF), tau = M.base.tau;
const betaJ = M.joint ? new Float64Array(NF) : null, tauJ = M.joint?.tau || tau;
{
  const missing = [];
  FEATURES.forEach((k, i) => { const j = M.meta.feats.indexOf(k); if (j < 0) missing.push(k); else { beta[i] = M.base.beta[j]; if (betaJ) betaJ[i] = M.joint.beta[j]; } });
  const extra = M.meta.feats.filter(k => !FEATURES.includes(k));
  if (extra.length) throw new Error(`model.json に bnfeat.mjs に無い特徴量がある（${extra.join(',')}）。banei_fit.mjs を回し直す`);
  if (missing.length) console.error(`  (モデルに無い特徴量は 0 で扱う: ${missing.join(',')}。banei_fit.mjs を回すと効く)`);
}
const round = (v, k = 3) => v == null || !Number.isFinite(v) ? null : Number(v.toFixed(k));
const sg = (v, k = 2) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(k)}`;

const results = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/banei/results.jsonl'), 'utf8').split('\n')) if (l) results.push(JSON.parse(l));
results.sort((a, b) => a.raceId.localeCompare(b.raceId));
const cardsText = fs.readFileSync(path.join(ROOT, 'data/banei/cards.jsonl'), 'utf8');
const PED = loadPed(cardsText);
const RI = buildRaceIndex(results), H = buildHistory(results, RI), ASOF = buildAsOf(results, PED), LANE = buildLaneIndex(results);
const featurize = makeFeaturizer(DB, RI, ASOF, LANE);

/* 発走が過ぎたレースの予想を記録（回収率の算出用）。後から作り直さない */
const PREDS = path.join(ROOT, 'data/banei/preds.jsonl');
const recorded = new Set();
if (fs.existsSync(PREDS)) for (const l of fs.readFileSync(PREDS, 'utf8').split('\n')) if (l) { try { recorded.add(JSON.parse(l).raceId); } catch { } }
const nowJ = new Date();
const RECORD_PAST = !!process.env.BN_RECORD_PAST;
function recordPred(race, date) {
  if (recorded.has(race.raceId)) return;
  const start = race.start ? new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${race.start.padStart(5, '0')}:00`) : null;
  const late = start ? (nowJ - start) / 60000 : null;
  if (!RECORD_PAST) { if (process.env.BN_TODAY || !start || late < -1) return; }
  else if (date >= TODAY) return;
  const top = race.horses.slice().sort((a, b) => b.p1 - a.p1);
  const pop1 = race.horses.find(h => h.pop === 1)?.no || null;
  fs.appendFileSync(PREDS, JSON.stringify({
    raceId: race.raceId, date, r: race.r, at: nowJ.toISOString(), late: RECORD_PAST ? 9999 : Math.round(late), level: race.level,
    top: top.map(h => h.no), p1: Object.fromEntries(top.map(h => [h.no, h.p1])), pop1,
    ai: { umaren3: race.umaren.slice(0, 3).map(x => x.k), sanpuku3: race.sanpuku.slice(0, 3).map(x => x.k), santan5: race.santan.slice(0, 5).map(x => x.k) },
  }) + '\n');
  recorded.add(race.raceId);
}

const cards = [];
for (const l of cardsText.split('\n')) if (l) { const c = JSON.parse(l); if (c.date >= TODAY || RECORD_PAST) cards.push(c); }
cards.sort((a, b) => a.raceId.localeCompare(b.raceId));

const GROUP = {
  ability: '近走', clsAbility: '近走', lastPos: '近走', lastDiff: '近走', nRuns: '近走', winStreak: '近走', afterWin: '近走',
  spdIdx: '時計', spdBest: '時計', loadRel: '積載', loadChg: '積載', loadBw: '積載',
  bwLog: '馬体', bwRel: '馬体', bwDiff: '馬体', bwDev: '馬体', bwSwing: '馬体',
  moistX: '水分', moistExp: '水分', moistChg: '水分', gate: 'コース', gateEdge: 'コース',
  laneDay: '当日コース', laneMeet: '当日コース', outerDay: '当日コース', outerMeet: '当日コース', jMoist: '人', tForm: '人', loadTop: '積載', loadMoist: '積載', bwMoist: '馬体',
  jIdx: '人', tIdx: '人', cIdx: '人', jForm: '人', appr: '人', sIdx: '血統', bmsIdx: '血統', oIdx: '馬主',
  restLog: '間隔', layoff: '間隔', classUp: '適性', downFirst: '適性', lastPop: '人気', lastOdds: '人気', mktLog: '人気',
  age: 'その他', mare: 'その他', gelding: 'その他',
};
const GROUPS = ['近走', '時計', '積載', '馬体', '水分', 'コース', '当日コース', '人', '血統', '馬主', '適性', '間隔', '人気', 'その他'];
const contrib = (x, b) => { const g = Object.fromEntries(GROUPS.map(k => [k, 0])); for (let i = 0; i < NF; i++) g[GROUP[FEATURES[i]] || 'その他'] += b[i] * x[i]; return GROUPS.map(k => round(g[k], 2)); };
const moistWord = m => m == null ? '' : m < 1 ? '乾いて重い' : m < 2 ? 'やや重い' : m < 3 ? '軽め' : '水分が多く軽い';
const moistBand = m => m == null ? null : m < 1 ? '〜0.9' : m < 1.5 ? '1.0〜1.4' : m < 2 ? '1.5〜1.9' : m < 2.5 ? '2.0〜2.4' : m < 3 ? '2.5〜2.9' : m < 4 ? '3.0〜3.9' : '4.0〜';

const days = new Map();
let nR = 0, nJ = 0;
for (const c of cards) {
  const race = raceFromCard(c, H);
  const f = featurize(race);
  if (!f) continue;
  const hasOdds = !!f.mkt;
  let Um = utilities(f.rows.map(x => x.x), beta), level = 'base', tauR = tau, bUse = beta;
  if (hasOdds && betaJ) { Um = utilities(f.rows.map(x => x.x), betaJ); tauR = tauJ; level = 'joint'; bUse = betaJ; nJ++; }
  const lanes = f.rows.map(x => x.no);
  const C = combosOf(Um, tauR, lanes);
  const order = C.p1.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const marks = {}; ['◎', '○', '▲', '△', '△', '☆'].forEach((m, i) => { if (order[i] != null) marks[order[i]] = m; });
  const loads = f.rows.map((x, i) => race.horses[i].load).filter(v => v > 0), loadAvg = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : null;
  const horses = f.rows.map((x, i) => {
    const e = c.entries.find(en => en.no === x.no) || {}, h = race.horses[i], d = x.d, hf = x.hf || {};
    const past = (h.past || []).slice(0, 5).map(p => ({ date: p.date, pos: p.pos, name: p.name, cls: p.cls?.key || null, moist: p.moist, n: p.n, no: p.no, load: p.load, bw: p.bw, bwDiff: p.bwDiff, time: p.time, diff: p.diff, pop: p.pop, jockey: p.jockey, raceId: p.raceId }));
    const p0 = past[0];
    const note = [];
    note.push(p0 ? `前走 ${p0.pop ? p0.pop + '人気' : ''}${p0.pos}着（水分${p0.moist ?? '?'}・積載${p0.load ?? '?'}kg${p0.diff != null && p0.pos > 1 ? `・勝ち馬と${p0.diff.toFixed(1)}秒差` : ''}）／近${past.length}走 ${past.map(p => p.pos).join('-')}` : 'ばんえいの前走なし');
    if (e.load) note.push(`積載 ${e.load}kg${loadAvg ? `（レース平均比 ${sg(e.load - loadAvg, 0)}kg` : '（'}${p0?.load ? `・前走比 ${sg(e.load - p0.load, 0)}kg` : ''}${e.bw ? `・馬体重比 ${(e.load / e.bw * 100).toFixed(0)}%` : ''}）`);
    if (e.bw || d.bwPast) note.push(`馬体 今回 ${e.bw ? `${e.bw}kg（${e.bwDiff > 0 ? '+' : ''}${e.bwDiff ?? '±0'}）` : '未発表'}${d.bwPast ? `／普段 ${Math.round(d.bwPast)}kg（${d.bwMin}〜${d.bwMax}）` : ''}`);
    if (d.moistFitN) note.push(`馬場水分 ${d.moistFit >= 0.15 ? '軽い馬場（水分多め）で走る' : d.moistFit <= -0.15 ? '重い馬場（水分少なめ）で走る' : '水分による差は小さい'}（水分2.0以上と1.2以下の相対着順の差 ${sg(d.moistFit, 2)}）${d.moistExp != null ? `・経験した水分の平均 ${d.moistExp.toFixed(1)}` : ''}`);
    const j = DB.jockey?.[e.jockeyId], t = DB.trainer?.[e.trainerId], cb = DB.combo?.[`${e.jockeyId}|${e.trainerId}`];
    note.push(`${(e.apprentice || '') + (e.jockey || '')}${j ? `（指数 ${sg(j.idx)}${j.hot != null ? `・直近1年 ${sg(j.hot)}` : ''}）` : '（指数なし）'}×${e.trainer || ''}${t ? `（${sg(t.idx)}）` : ''}${cb ? `／コンビ${cb.n}走 ${sg(cb.cIdx)}` : ''}`);
    if (e.sire || e.owner) note.push(`血統 ${e.sire || '—'}${hf.sN ? `（産駒 ${hf.sN}走・${sg(hf.sIdx)}）` : ''}／母父 ${e.damsire || '—'}${hf.bN ? `（${sg(hf.bmsIdx)}）` : ''}／馬主 ${e.owner || '—'}${hf.oN ? `（${hf.oN}走・${sg(hf.oIdx)}）` : ''}`);
    /* 開催中のコース傾向（こたの実感：同じ馬番が続けて来る・外が来る開催は続く）。数字は「3着内の回数 − 期待」の縮小値 */
    if (f.lane) { const ld = x.x[FEATURES.indexOf('laneDay')], lm = x.x[FEATURES.indexOf('laneMeet')]; if (f.lane.dayRaces || f.lane.meetRaces) note.push(`${x.no}番コースの開催中の傾向：今日ここまで ${f.lane.dayRaces}R で ${ld >= 0.2 ? '好走が続いている' : ld <= -0.2 ? '来ていない' : 'ふつう'}（${sg(ld, 2)}）／この開催 ${f.lane.meetRaces}R で ${sg(lm, 2)}`); }
    const g = DB.gate?.[x.no];
    if (g) note.push(`${x.no}番コース：3着内シェア÷出走シェア ${g.edge.toFixed(2)}（${g.n}走・勝率 ${(g.win * 100).toFixed(1)}%）`);
    return {
      no: x.no, waku: x.waku, name: x.name, horseId: x.horseId, sexAge: e.sexAge, color: e.color, load: e.load, apprentice: e.apprentice || null,
      jockey: e.jockey, jockeyId: e.jockeyId, trainer: e.trainer, trainerId: e.trainerId, sire: e.sire, dam: e.dam, damsire: e.damsire, owner: e.owner,
      bw: e.bw, bwDiff: e.bwDiff, odds: e.odds, pop: e.pop, rec: e.recAll || null,
      mark: marks[i] || '', p1: round(C.p1[i], 4), top2: round(C.top2[i], 3), top3: round(C.top3[i], 3), U: round(Um[i], 2),
      bwPast: d.bwPast != null ? Math.round(d.bwPast) : null, bwMin: d.bwMin, bwMax: d.bwMax, moistFit: round(d.moistFit, 2), moistFitN: d.moistFitN,
      c: contrib(x.x, bUse), note, past,
    };
  });
  const box = k => order.slice(0, k).map(i => lanes[i]).sort((a, b) => a - b);
  const top = i => horses[order[i]];
  const nn = h => `${h.no} ${h.name}`;
  const pts = [];
  pts.push(`本命 ${nn(top(0))}（1着 ${(C.p1[order[0]] * 100).toFixed(1)}%）、対抗 ${nn(top(1))}（${(C.p1[order[1]] * 100).toFixed(1)}%）、単穴 ${nn(top(2))}。`);
  const mb = moistBand(c.moist), mi = mb ? DB.moist?.[mb] : null;
  if (c.moist != null) pts.push(`馬場水分 ${c.moist}%（${moistWord(c.moist)}）${mi ? `。同じ水分帯の過去 ${mi.races}レースでは 1番人気の勝率 ${mi.favWin != null ? (mi.favWin * 100).toFixed(0) : '—'}%・3連単の平均配当 ${mi.santanAvg != null ? mi.santanAvg.toLocaleString() + '円' : '—'}・万馬券率 ${mi.man != null ? (mi.man * 100).toFixed(0) : '—'}%${mi.winTime ? `・勝ち時計の平均 ${mi.winTime.toFixed(1)}秒` : ''}` : ''}。`);
  const fitW = horses.filter(h => h.moistFitN >= 2 && ((c.moist >= 2 && h.moistFit >= 0.15) || (c.moist <= 1.2 && h.moistFit <= -0.15))).map(nn);
  if (fitW.length) pts.push(`今日の馬場水分に合う馬：${fitW.join('、')}。`);
  const fitB = horses.filter(h => h.moistFitN >= 2 && ((c.moist >= 2 && h.moistFit <= -0.15) || (c.moist <= 1.2 && h.moistFit >= 0.15))).map(nn);
  if (fitB.length) pts.push(`今日の水分は不得手：${fitB.join('、')}。`);
  if (loadAvg) {
    const heavy = horses.filter(h => h.load && h.load - loadAvg >= 15).map(h => `${nn(h)}（${h.load}kg）`), light = horses.filter(h => h.load && loadAvg - h.load >= 15).map(h => `${nn(h)}（${h.load}kg）`);
    if (heavy.length) pts.push(`積載が重い：${heavy.join('、')}（レース平均 ${Math.round(loadAvg)}kg）。`);
    if (light.length) pts.push(`積載が軽い：${light.join('、')}。`);
  }
  const big = horses.filter(h => h.bw >= 1100).map(h => `${nn(h)}（${h.bw}kg）`);
  if (big.length) pts.push(`1,100kg 超の大型馬：${big.join('、')}。`);
  /* 当日・開催のコース傾向（先読みなし：このレースより前の結果だけ） */
  if (f.lane && (f.lane.dayRaces >= 2 || f.lane.meetRaces >= 6)) {
    const od = f.lane.outerDay, om = f.lane.outerMeet;
    const word = v => v >= 0.15 ? '外（8〜10番）が来ている' : v <= -0.15 ? '内（1〜3番）が来ている' : '内外の差は小さい';
    const hot = horses.map(h => [h, h.c ? 0 : 0]).map(([h]) => [h, f.rows.find(x => x.no === h.no)?.x[FEATURES.indexOf('laneMeet')] ?? 0]).filter(([, v]) => v >= 0.2).sort((a, b) => b[1] - a[1]).slice(0, 3);
    pts.push(`開催中のコース傾向：${f.lane.dayRaces ? `本日ここまで ${f.lane.dayRaces}R は ${word(od)}（外−内 ${sg(od, 2)}）` : '本日はこれが最初の材料'}。この開催（${f.lane.meetDates.length ? f.lane.meetDates.map(d => `${+d.slice(4, 6)}/${+d.slice(6, 8)}`).join('・') + '〜' : ''}${f.lane.meetRaces}R）は ${word(om)}${hot.length ? `。好走が続く馬番：${hot.map(([h, v]) => `${h.no}番（${sg(v, 2)}）`).join('、')}` : ''}。`);
  }
  const G = DB.gate || {}; const gs = Object.entries(G).filter(([, v]) => v.n >= 300);
  if (gs.length) { const best = gs.slice().sort((a, b) => b[1].edge - a[1].edge); pts.push(`コース（馬番）の得失：${gs.map(([k, v]) => `${k}番 ${v.edge.toFixed(2)}`).join(' ')}（1.00 が損得なし。良いのは ${best[0][0]}番、悪いのは ${best.at(-1)[0]}番）。`); }
  pts.push(`馬連の本線 ${C.umaren[0][0]}（${(C.umaren[0][1] * 100).toFixed(1)}%）、三連複 ${C.sanpuku[0][0]}（${(C.sanpuku[0][1] * 100).toFixed(1)}%）。`);
  const race1 = {
    raceId: c.raceId, r: c.r, name: c.name, kind: c.list?.kind || null, start: c.start || c.list?.start, dist: c.dist || 200, cond: c.cond, cls: race.cls, weather: c.weather, moist: c.moist, n: horses.length, level, gates: true,
    changes: (c.list?.changes || []).filter(x => x.kind),
    horses, box3: box(3), box4: box(4), box5: box(5),
    umaren: C.umaren.slice(0, 6).map(([k, p]) => ({ k, p: round(p, 4) })), umatan: C.umatan.slice(0, 5).map(([k, p]) => ({ k, p: round(p, 4) })),
    sanpuku: C.sanpuku.slice(0, 6).map(([k, p]) => ({ k, p: round(p, 4) })), santan: C.santan.slice(0, 8).map(([k, p]) => ({ k, p: round(p, 4) })), wide: C.wide.slice(0, 5).map(([k, p]) => ({ k, p: round(p, 4) })),
    conf: round(1 - (-C.p1.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0)) / Math.log(C.p1.length), 3),
    points: pts,
  };
  recordPred(race1, c.date);
  if (c.date < TODAY) continue;
  (days.get(c.date) || days.set(c.date, []).get(c.date)).push(race1);
  nR++;
}
const out = {
  meta: {
    built: new Date().toISOString(), today: TODAY, groups: GROUPS,
    model: { built: M.meta.built, split: M.meta.split, train: M.meta.train, test: M.meta.test, base: M.base.test, joint: M.joint?.test || null, jointCoef: M.joint?.coef?.slice(0, 12) || null, popOnly: M.popOnly },
    index: { from: DB.meta.from, to: DB.meta.to, races: DB.meta.races, runs: DB.meta.runs, moist: DB.moist, gate: DB.gate, bw: DB.bw },
    backtest: BT ? { level: BT.meta.level, from: BT.meta.from, to: BT.meta.to, races: BT.meta.races, table: BT.table, note: BT.meta.note, byMoist: BT.byMoist } : null,
  },
  days: [...days].map(([date, races]) => ({ date, races: races.sort((a, b) => a.r - b.r) })),
};
writeJSON('data/banei/races.json', out);
const top = {
  builtAt: out.meta.built, today: TODAY, model: out.meta.model, backtest: out.meta.backtest,
  days: out.days.map(d => ({ date: d.date, races: d.races.map(r => {
    const t = r.horses.slice().sort((a, b) => b.p1 - a.p1).slice(0, 3);
    return { r: r.r, name: r.name, kind: r.kind, start: r.start, moist: r.moist, n: r.n, level: r.level, conf: r.conf,
      top: t.map(h => ({ no: h.no, waku: h.waku, name: h.name, p: round(h.p1, 3), odds: h.odds, jockey: h.jockey, load: h.load, bw: h.bw })),
      box3: r.box3, umaren: r.umaren[0], sanpuku: r.sanpuku[0] };
  }) })),
};
writeJSON('data/banei/top.json', top);
console.error(`${TODAY} 以降 ${nR}R（joint＝オッズあり ${nJ}R）`);
for (const d of out.days) console.error(`  ${d.date} 帯広 ${d.races.length}R`);
