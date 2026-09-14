/* ばんえい（帯広）の条件付きロジット用の特徴量。1レース＝1グループ、1頭＝1行。レース前に分かる情報だけで作る。
   南関・JRA（lib/feat.mjs / lib/jfeat.mjs）の項目を踏襲し、ばんえい固有のものを足す：
     積載重量（絶対値ではなくレース内の相対と、馬体重に対する比）
     馬場水分（含水率。時計は水分でまるごと変わるので、速度指数は「水分×クラスの基準」との差で作る。
              馬ごとの「重い馬場／軽い馬場での得意不得意」も持つ）
     馬体重（ばんえいは 800〜1,200kg。大きいほど有利だが、積載との比のほうが効く）
     馬番（コース別成績。直線200mの10コースで、砂の状態が違う）
   学習用のレースは results.jsonl から（raceFromResult）、予測用は cards.jsonl から（raceFromCard）。同じ形にしてから featurize する。 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const days = (a, b) => (Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8)) - Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8))) / 86400000;
const W = [1, .85, .7, .55, .45];
const logit = p => Math.log(p / (1 - p)), sig = l => 1 / (1 + Math.exp(-l));
const shrunk = (w, n, prior, k) => logit((w + k * prior) / (n + k)) - logit(prior);

/* ---- クラス ----
   2歳・3歳は D→C→B→A→オープン、3歳以上（4歳以上）は C2→C1→B4→B3→B2→B1→A2→A1→オープン。
   競走名の末尾（「…記念B-3」「C2-5」「B2-1混合」「…オープン別定」）から取る。年齢の区分は条件文から。 */
const LV_YOUNG = { D: 1, C: 2, B: 3, A: 4, OP: 5 }, LV_OLD = { C2: 1, C1: 2, B4: 3, B3: 4, B2: 5, B1: 6, A2: 7, A1: 8, OP: 9 };
export function classOf(name, cond) {
  const n = String(name || '').normalize('NFKC'), c = String(cond || '').normalize('NFKC');
  const grp = /2歳/.test(c) ? '2' : /3歳以上|4歳以上/.test(c) ? '4' : /3歳/.test(c) ? '3' : /2歳/.test(n) ? '2' : /3歳/.test(n) && !/以上/.test(n) ? '3' : '4';
  let key = null;
  if (/オープン|OP/.test(n)) key = 'OP';
  else { const m = n.match(/([ABCD])(\d?)(?:-\d+)?(?:混合)?\s*$/); if (m) key = m[1] + (m[2] || ''); }
  const tbl = grp === '4' ? LV_OLD : LV_YOUNG;
  const lvl = key && tbl[key] != null ? tbl[key] : null;
  return { grp, key, lvl, top: tbl.OP };
}
const posNum = p => (typeof p === 'number' ? p : null);

export const FEATURES = [
  'ability', 'clsAbility', 'lastPos', 'lastDiff', 'nRuns', 'winStreak', 'afterWin',
  'spdIdx', 'spdBest',                                   // 水分×クラスの基準時計との差（速いほど＋）
  'loadRel', 'loadChg', 'loadBw',                        // 積載：レース内の相対、前走からの増減、馬体重に対する比
  'bwLog', 'bwRel', 'bwDiff', 'bwDev', 'bwSwing',        // 馬体重
  'moistX', 'moistExp', 'moistChg',                      // 馬場水分：重い／軽い馬場の得意不得意×今日の水分、経験した水分、前走との差
  'gate', 'gateEdge',                                    // 馬番（コース）
  'jIdx', 'tIdx', 'cIdx', 'jForm', 'appr',               // 騎手・調教師・コンビ・騎手の調子・減量騎手
  'sIdx', 'bmsIdx', 'oIdx',                              // 血統・馬主（レース時点）
  'age', 'mare', 'gelding', 'restLog', 'layoff', 'classUp', 'downFirst', 'lastPop', 'lastOdds',
  'mktLog',                                              // 市場（joint のみ。base では 0 固定）
];
export const NF = FEATURES.length;
export const MKT = FEATURES.indexOf('mktLog');

/* ---- レースの索引：基準時計（水分ビン×クラス）と、各レースの勝ち時計 ---- */
const moistBin = m => m == null ? null : m < 1 ? '0' : m < 1.5 ? '1' : m < 2 ? '1.5' : m < 2.5 ? '2' : m < 3 ? '2.5' : m < 4 ? '3' : '4';
export function buildRaceIndex(results) {
  const idx = new Map();
  const rows = [];
  for (const r of results) {
    const win = r.entries.find(e => e.pos === 1);
    const cl = classOf(r.name, r.cond);
    idx.set(r.raceId, { winTime: win ? win.time : null, moist: r.moist, cls: cl, n: r.entries.filter(e => posNum(e.pos) != null).length });
    if (win && win.time && r.moist != null) rows.push({ t: win.time, mb: moistBin(r.moist), ck: `${cl.grp}|${cl.lvl ?? 'x'}` });
  }
  /* 基準 = 水分ビンの平均 + クラスの補正（残差の平均、k=20 で縮小）を2回まわす */
  const mM = new Map(), cO = new Map();
  const meanBy = (key, val, k) => { const a = new Map(); for (const x of rows) { const v = a.get(key(x)) || [0, 0]; v[0] += val(x); v[1]++; a.set(key(x), v); } return new Map([...a].map(([kk, v]) => [kk, v[0] / (v[1] + k)])); };
  for (let it = 0; it < 2; it++) {
    for (const [k, v] of meanBy(x => x.mb, x => x.t - (cO.get(x.ck) || 0), 0)) mM.set(k, v);
    for (const [k, v] of meanBy(x => x.ck, x => x.t - (mM.get(x.mb) || 0), 20)) cO.set(k, v);
  }
  const stdTime = (moist, cls) => { const m = mM.get(moistBin(moist)); if (m == null) return null; return m + (cO.get(`${cls.grp}|${cls.lvl ?? 'x'}`) || 0); };
  /* 人気順位ごとの勝率（単勝オッズは古い成績ページに無いので、市場の見立ては人気順位から作る。k=10 で 1/頭数 に縮小） */
  const pr = Array.from({ length: 17 }, () => [0, 0]);
  for (const r of results) { const n = r.entries.filter(e => posNum(e.pos) != null).length; for (const e of r.entries) { if (!(e.pop >= 1) || posNum(e.pos) == null) continue; const k = Math.min(e.pop, 16); pr[k][0] += e.pos === 1 ? 1 : 0; pr[k][1]++; } void n; }
  const popRate = pr.map(([w, n], k) => k ? (w + 10 * 0.1) / (n + 10) : null);
  return { idx, stdTime, moistMean: Object.fromEntries(mM), clsOff: Object.fromEntries(cO), popRate };
}
/* 市場の確率：全頭の単勝オッズがあればその逆数、無ければ人気順位ごとの勝率。どちらも無ければ null */
export function marketProbs(live, RI) {
  if (live.every(h => h.odds > 0)) { const inv = live.map(h => 1 / h.odds), s = inv.reduce((a, b) => a + b, 0); return inv.map(v => v / s); }
  if (RI?.popRate && live.every(h => h.pop >= 1)) { const q = live.map(h => RI.popRate[Math.min(h.pop, 16)] || 0.02), s = q.reduce((a, b) => a + b, 0); return q.map(v => v / s); }
  return null;
}

/* ---- 「そのレース時点」の人的要因・血統（結果を日付順に流し、その日より前だけで作る）---- */
export function buildAsOf(results, ped = new Map()) {
  const J = new Map(), T = new Map(), C = new Map(), S = new Map(), B = new Map(), O = new Map();
  let runs = 0, wins = 0;
  const snap = new Map();
  const get = (m, k) => { let v = m.get(k); if (!v) m.set(k, v = { n: 0, w: 0, q: [], qw: 0 }); return v; };
  const P0 = () => (wins + 0.1 * 100) / (runs + 100);
  const pedOf = e => ped.get(e.horseId) || {};
  const hf = e => {
    const p0 = P0(), L0 = logit(p0);
    const j = J.get(e.jockeyId), t = T.get(e.trainerId), c = C.get(e.jockeyId + '|' + e.trainerId);
    const jIdx = j ? shrunk(j.w, j.n, p0, 50) : 0, tIdx = t ? shrunk(t.w, t.n, p0, 50) : 0;
    const own = sig(L0 + jIdx), cExp = sig(L0 + 0.8 * jIdx + 0.6 * tIdx);
    const pd = pedOf(e);
    const s = pd.sire ? S.get(pd.sire) : null, b = pd.damsire ? B.get(pd.damsire) : null, o = pd.owner ? O.get(pd.owner) : null;
    return {
      jIdx, tIdx, cIdx: c ? shrunk(c.w, c.n, cExp, 40) : 0,
      jForm: j && j.q.length >= 10 ? shrunk(j.qw, j.q.length, own, 40) : 0,
      sIdx: s ? shrunk(s.w, s.n, p0, 60) : 0, bmsIdx: b ? shrunk(b.w, b.n, p0, 60) : 0, oIdx: o ? shrunk(o.w, o.n, p0, 40) : 0,
      jN: j ? j.n : 0, tN: t ? t.n : 0, cN: c ? c.n : 0, sN: s ? s.n : 0, bN: b ? b.n : 0, oN: o ? o.n : 0,
      sire: pd.sire || null, damsire: pd.damsire || null, owner: pd.owner || null,
    };
  };
  for (const r of results) {
    for (const e of r.entries) if (e.horseId) snap.set(`${r.raceId}|${e.horseId}`, hf(e));
    for (const e of r.entries) {
      if (posNum(e.pos) == null) continue;
      const win = e.pos === 1 ? 1 : 0; runs++; wins += win;
      if (e.jockeyId) { const j = get(J, e.jockeyId); j.n++; j.w += win; j.q.push(win); j.qw += win; if (j.q.length > 60) j.qw -= j.q.shift(); }
      if (e.trainerId) { const t = get(T, e.trainerId); t.n++; t.w += win; }
      if (e.jockeyId && e.trainerId) { const c = get(C, e.jockeyId + '|' + e.trainerId); c.n++; c.w += win; }
      const pd = pedOf(e);
      if (pd.sire) { const s = get(S, pd.sire); s.n++; s.w += win; }
      if (pd.damsire) { const b = get(B, pd.damsire); b.n++; b.w += win; }
      if (pd.owner) { const o = get(O, pd.owner); o.n++; o.w += win; }
    }
  }
  return { of(raceId, e) { return snap.get(`${raceId}|${e.horseId}`) || hf(e); }, latest(e) { return hf(e); }, P0: P0() };
}
/* cards.jsonl → horseId -> {sire, dam, damsire, owner, color, birth}（出馬表は全頭の血統を持つ） */
export function loadPed(cardsText) {
  const m = new Map();
  for (const l of String(cardsText || '').split('\n')) {
    if (!l) continue;
    let c; try { c = JSON.parse(l); } catch { continue; }
    for (const e of c.entries || []) if (e.horseId && (e.sire || e.owner)) m.set(e.horseId, { sire: e.sire || null, dam: e.dam || null, damsire: e.damsire || null, owner: e.owner || null, color: e.color || null, birth: e.birth || null });
  }
  return m;
}

/* ---- 馬ごとの履歴（新しい順）---- */
export function buildHistory(results, RI) {
  const H = new Map();
  for (const r of results) {
    const cl = classOf(r.name, r.cond);
    const win = r.entries.find(e => e.pos === 1);
    for (const e of r.entries) {
      if (!e.horseId || posNum(e.pos) == null) continue;
      (H.get(e.horseId) || H.set(e.horseId, []).get(e.horseId)).push({
        date: r.date, raceId: r.raceId, moist: r.moist, cls: cl, n: r.entries.filter(x => posNum(x.pos) != null).length, name: r.name,
        pos: e.pos, pop: e.pop, odds: e.odds, load: e.load, bw: e.bw, bwDiff: e.bwDiff, time: e.time, no: e.no,
        diff: e.time != null && win?.time != null ? e.time - win.time : null, jockey: e.jockey, jockeyId: e.jockeyId,
      });
    }
  }
  for (const a of H.values()) a.sort((x, y) => y.date.localeCompare(x.date) || y.raceId.localeCompare(x.raceId));
  void RI;
  return H;
}
export const pastOf = (H, horseId, before, k = 5) => (H.get(horseId) || []).filter(p => p.date < before).slice(0, k);

/* ---- 学習用：結果 → レース ---- */
export function raceFromResult(r, H) {
  const horses = r.entries.filter(e => posNum(e.pos) != null && e.horseId).map(e => ({
    no: e.no, waku: e.waku, horseId: e.horseId, name: e.name, sexAge: e.sexAge, load: e.load, jockey: e.jockey, jockeyId: e.jockeyId, trainerId: e.trainerId,
    bw: e.bw, bwDiff: e.bwDiff, odds: e.odds, pop: e.pop, past: pastOf(H, e.horseId, r.date), _pos: e.pos,
  }));
  return { raceId: r.raceId, date: r.date, moist: r.moist, weather: r.weather, cls: classOf(r.name, r.cond), name: r.name, horses,
    order: [1, 2, 3].map(p => horses.findIndex(h => h._pos === p)) };
}
/* ---- 予測用：出馬表 → レース（前5走は results から。無ければ出馬表の前5走） ---- */
export function raceFromCard(c, H) {
  const horses = c.entries.filter(e => e.horseId && !e.scratch).map(e => ({
    no: e.no, waku: e.waku, horseId: e.horseId, name: e.name, sexAge: e.sexAge, load: e.load, jockey: (e.apprentice || '') + e.jockey, jockeyId: e.jockeyId, trainerId: e.trainerId,
    bw: e.bw, bwDiff: e.bwDiff, odds: e.odds, pop: e.pop, sire: e.sire, damsire: e.damsire, owner: e.owner,
    past: (() => { const h = pastOf(H, e.horseId, c.date); if (h.length) return h; return (e.past || []).map(p => ({ ...p, cls: classOf(p.name, ''), diff: p.pos === 1 ? 0 : p.diff })); })(),
  }));
  return { raceId: c.raceId, date: c.date, moist: c.moist, weather: c.weather, cls: classOf(c.name, c.cond), name: c.name, horses };
}

/* ---- 1頭の推定値 ---- */
function derive(h, race, RI) {
  const past = h.past || [];
  let abS = 0, abW = 0, clS = 0, spS = 0, spW = 0, spBest = null, mE = 0, mW = 0;
  const wet = [0, 0], dry = [0, 0], bws = [];
  past.forEach((p, i) => {
    const w = W[i] ?? 0.4;
    const rel = p.n > 1 ? 1 - (p.pos - 1) / (p.n - 1) : 0.5;
    abS += rel * w; abW += w;
    const pc = p.cls || {}, rc = race.cls || {};
    const clsDiff = pc.grp === rc.grp && pc.lvl != null && rc.lvl != null ? (pc.lvl - rc.lvl) / (rc.top || 9) * 4 : 0;
    clS += (rel - 0.5 + 0.15 * clsDiff) * w;
    if (p.time && p.moist != null && RI?.stdTime) {
      const std = RI.stdTime(p.moist, pc.lvl != null ? pc : rc);
      if (std) { const v = clamp(Math.log(std / p.time) * 10, -3, 3); spS += v * w; spW += w; if (spBest == null || v > spBest) spBest = v; }
    }
    if (p.moist != null) {
      mE += p.moist * w; mW += w;
      if (p.moist >= 2) { wet[0] += rel; wet[1]++; } else if (p.moist <= 1.2) { dry[0] += rel; dry[1]++; }
    }
    if (p.bw >= 600 && p.bw <= 1400) bws.push(p.bw);
  });
  const ability = abW ? abS / abW : 0.45;
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  return {
    ability, clsAbility: abW ? clS / abW : 0,
    spdIdx: spW ? spS / spW : 0, spdBest: spBest ?? 0,
    moistFit: wet[1] && dry[1] ? wet[0] / wet[1] - dry[0] / dry[1] : 0, moistFitN: Math.min(wet[1], dry[1]),
    moistExp: mW ? mE / mW : null,
    bwPast: mean(bws), bwMin: bws.length ? Math.min(...bws) : null, bwMax: bws.length ? Math.max(...bws) : null,
  };
}

export function makeFeaturizer(DB, RI, ASOF) {
  if (!ASOF) throw new Error('makeFeaturizer には buildAsOf(results) の戻り値が要る');
  const GATE = (DB && DB.gate) || {};
  return function featurize(race) {
    const live = race.horses;
    if (live.length < 4) return null;
    const loads = live.map(h => h.load).filter(v => v > 0), loadAvg = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : 600;
    const bws = live.map(h => h.bw).filter(v => v > 0), bwAvg = bws.length ? bws.reduce((a, b) => a + b, 0) / bws.length : 950;
    const lbs = live.filter(h => h.load > 0 && h.bw > 0).map(h => h.load / h.bw), lbAvg = lbs.length ? lbs.reduce((a, b) => a + b, 0) / lbs.length : 0.62;
    const moist = race.moist ?? 1.5;
    const mkt = marketProbs(live, RI);
    const lq = mkt ? mkt.map(q => Math.log(q)) : null;
    const lqm = lq ? lq.reduce((a, b) => a + b, 0) / lq.length : 0;
    const ds = live.map(h => derive(h, race, RI));
    const rows = live.map((h, hi) => {
      const d = ds[hi], hf = ASOF.of(race.raceId, h);
      const p0 = h.past && h.past[0];
      const rest = p0 ? Math.max(1, days(race.date, p0.date)) : 120;
      const age = Number((h.sexAge || '').replace(/\D/g, '')) || 4;
      let streak = 0; for (const p of (h.past || [])) { if (p.pos === 1) streak++; else break; }
      const rc = race.cls || {}, pc = p0?.cls || {};
      const clsDiff = p0 && pc.grp === rc.grp && pc.lvl != null && rc.lvl != null ? rc.lvl - pc.lvl : 0;
      const g = GATE[h.no];
      const x = {
        ability: d.ability, clsAbility: d.clsAbility,
        lastPos: p0 && p0.n > 1 ? 1 - (p0.pos - 1) / (p0.n - 1) : 0.5,
        lastDiff: p0 && p0.diff != null ? -clamp(p0.diff, 0, 60) / 20 : 0,
        nRuns: Math.min((h.past || []).length, 5) / 5,
        winStreak: Math.min(streak, 3) / 3, afterWin: p0 && p0.pos === 1 && clsDiff === 0 ? 1 : 0,
        spdIdx: d.spdIdx, spdBest: d.spdBest,
        loadRel: h.load ? (h.load - loadAvg) / 10 : 0,
        loadChg: h.load && p0?.load ? clamp((h.load - p0.load) / 10, -5, 5) : 0,
        loadBw: h.load && h.bw ? (h.load / h.bw - lbAvg) * 10 : 0,
        bwLog: h.bw ? Math.log(h.bw / 1000) * 5 : 0, bwRel: h.bw ? clamp((h.bw - bwAvg) / 50, -3, 3) : 0,
        bwDiff: (h.bwDiff || 0) / 10, bwDev: h.bw && d.bwPast ? clamp((h.bw - d.bwPast) / 20, -3, 3) : 0,
        bwSwing: h.bwDiff == null ? 0 : Math.min(Math.abs(h.bwDiff), 40) / 20,
        moistX: d.moistFitN ? d.moistFit * clamp((moist - 1.5) / 1.5, -1.5, 1.5) * 2 : 0,
        moistExp: d.moistExp != null ? clamp((moist - d.moistExp) / 1.5, -2, 2) : 0,
        moistChg: p0 && p0.moist != null ? clamp((moist - p0.moist) / 1.5, -2, 2) : 0,
        gate: h.no ? (h.no - 5.5) / 4.5 : 0, gateEdge: g && g.n >= 200 ? clamp(g.edge - 1, -0.5, 0.5) * 2 : 0,
        jIdx: hf.jIdx, tIdx: hf.tIdx, cIdx: hf.cIdx, jForm: hf.jForm, appr: /[☆★▲△◇]/.test(h.jockey || '') ? 1 : 0,
        sIdx: hf.sIdx * Math.max(0, 1 - (h.past || []).length / 4), bmsIdx: hf.bmsIdx * Math.max(0, 1 - (h.past || []).length / 4), oIdx: hf.oIdx,
        age: (age - 5) / 3, mare: /牝/.test(h.sexAge || '') ? 1 : 0, gelding: /セ/.test(h.sexAge || '') ? 1 : 0,
        restLog: Math.log(rest) - 2.7, layoff: rest >= 60 ? 1 : 0,
        classUp: clsDiff, downFirst: clsDiff < 0 ? 1 : 0,
        lastPop: p0 && p0.n && p0.pop ? Math.log(p0.pop / p0.n) : 0, lastOdds: p0 && p0.odds ? clamp(Math.log(p0.odds / 8), -2.5, 2.5) : 0,
        mktLog: lq ? lq[hi] - lqm : 0,
      };
      const v = new Float64Array(NF);
      FEATURES.forEach((k, i) => { v[i] = Number.isFinite(x[k]) ? x[k] : 0; });
      return { no: h.no, waku: h.waku, name: h.name, horseId: h.horseId, x: v, d, hf, odds: h.odds, pop: h.pop };
    });
    return { raceId: race.raceId, date: race.date, moist: race.moist, cls: race.cls, n: live.length, rows, order: race.order, mkt, mktSrc: mkt ? (live.every(h => h.odds > 0) ? 'odds' : 'pop') : null };
  };
}
