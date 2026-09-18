/* 今日（と明日）の全場のレースに index.json の指数と model.json のロジットを当てて、
   boat.html に埋め込むデータ（data/boat/today.json）を作る。

   - 番組表は programs.jsonl（od2 の B）。当日の直前情報とオッズは live.<date>.json（fetch_live）
   - 予測は tools/lib/bfeat.mjs の特徴量 × model.json の係数。検証（backtest_boat）と同じ式
   - 直前情報が出ているレースは ex（進入確定・展示タイムあり）、それ以外は pre
   - 「そのレースより前」の調子・今節ST・展示は lib/bload.mjs の makeRolling に
     直近100日の結果を流し込んで作る（学習時と同じ作り方）
   - 1〜3着の並びの確率は Plackett–Luce を6艇120通りで厳密に足し上げる（モンテカルロ不要）

     BT_TODAY  … 基準日（既定 今日）
     BT_AHEAD  … 何日先まで載せるか（既定 1＝明日まで。番組表が出ていない日は飛ばす）
   出力: data/boat/today.json */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON, VENUES, VNAME, ymdOf } from './lib/bt.mjs';
import { FEATS, NF, raceFeatures } from './lib/bfeat.mjs';
import { loadPrograms, loadRaces, makeRolling, periodStart, periodEnd, KYU_RUNS } from './lib/bload.mjs';
import { kyuGapOf } from './lib/bfeat.mjs';
import { windCompass } from './lib/web.mjs';
import { raceProbs, packTri } from './lib/bpl.mjs';
import { settle, finishOf, payOf } from './lib/bsettle.mjs';
import { ORIGEX } from './lib/origex.mjs';

const TODAY = process.env.BT_TODAY || ymdOf(new Date());
const AHEAD = Number(process.env.BT_AHEAD ?? 1);
const DB = readJSON('data/boat/index.json');
const ST = readJSON('data/boat/stadium.json');
const M = readJSON(process.env.BT_MODEL || 'data/boat/model.json');   // 係数（検証用に差し替え可）
let BT = null;
try { BT = readJSON('data/boat/backtest.json'); } catch { console.error('  (backtest.json なし。実績の並記は省く)'); }
/* 潮位（気象庁の推算値。tools/fetch_tide.mjs）。無ければ潮の表示は出ない */
let TIDE = null;
try { TIDE = readJSON('data/boat/tide.json'); } catch { console.error('  (tide.json なし。潮の表示は省く。node tools/fetch_tide.mjs)'); }
function tideDayOf(jcd, date) {
  const st = TIDE?.station?.[jcd]; if (!st) return null;
  const d = TIDE.data?.[st.code]?.[date]; if (!d) return null;
  return { code: st.code, name: st.name, note: st.note || null, h: d.h, hi: d.hi, lo: d.lo };
}

const addDays = (ymd, n) => { const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00`); d.setDate(d.getDate() + n); return ymdOf(d); };
const dayNoOf = ymd => Math.round(new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`).getTime() / 86400000);
const round = (v, k = 3) => v == null || !Number.isFinite(v) ? null : Number(v.toFixed(k));

/* ---- 係数は「名前」で合わせる。model.json と bfeat.mjs の特徴量が食い違っていたら止める ---- */
function betaOf(level) {
  const feats = M.meta.feats, src = M[level]?.beta;
  if (!src) throw new Error(`model.json に ${level} が無い`);
  const b = new Float64Array(NF);
  const missing = [];
  FEATS.forEach((k, i) => { const j = feats.indexOf(k); if (j < 0) missing.push(k); else b[i] = src[j]; });
  const extra = feats.filter(k => !FEATS.includes(k));
  /* モデルにあって bfeat に無い＝並びがずれる恐れがあるので止める。
     bfeat にあってモデルに無い＝足したばかりの特徴量。0（効かせない）で動かし、fit_boat を回すと効く */
  if (extra.length) throw new Error(`model.json に bfeat.mjs に無い特徴量がある（${extra.join(',')}）。fit_boat.mjs を回し直す`);
  if (missing.length && level === 'pre') console.error(`  (モデルに無い特徴量は 0 で扱う: ${missing.join(',')}。fit_boat.mjs を回すと効く)`);
  return b;
}
const BETA = { pre: betaOf('pre'), ex: betaOf('ex') };
/* 着順の段階ごとの温度（fit_boat が学習データで決める。無ければ 1＝素の PL） */
const TAU = { pre: M.pre.tau || [1, 1], ex: M.ex.tau || [1, 1] };
if (!M.pre.tau) console.error('  (model.json に温度 tau が無い。fit_boat.mjs を回し直すと較正される)');

/* ---- 対象日 ---- */
const dates = [];
for (let i = 0; i <= AHEAD; i++) dates.push(addDays(TODAY, i));
const last = dates.at(-1);

/* ---- 番組表（直近100日ぶん。調子・今節の計算にも使う）---- */
console.error('番組表と直近の結果を読む…');
/* 級別審査期間（5/1〜 or 11/1〜）の勝率も時点指標で作るので、期の初日まで遡って流し込む */
const ROLL_FROM = [addDays(TODAY, -100), periodStart(TODAY)].sort()[0];
const P = loadPrograms({ from: ROLL_FROM, to: last });
const roll = makeRolling(DB.base);
const past = loadRaces({ from: ROLL_FROM, to: addDays(TODAY, -1), prog: P, base: DB.base, roll });
console.error(`  ${ROLL_FROM}〜 ${past.length}R を流し込んだ`);

/* index.json のモーター世代は全期間で振ってあるので、番号ごとに一番新しい世代を使う */
function motorGenOf(jcd, no) {
  const t = DB.motor?.[jcd]; if (!t || no == null) return 1;
  let best = null;
  for (const k of Object.keys(t)) {
    if (!k.startsWith(no + '#')) continue;
    if (!best || t[k].to > t[best].to) best = k;
  }
  return best ? Number(best.split('#')[1]) : 1;
}

/* ---- 係数×特徴量を「読める単位」にまとめる（根拠の表示用）---- */
const GROUP = {
  cz: 'コース', czTop2: 'コース',
  rIdx: '実力', rIdxC: '実力', rIdxJ: '当地', natWin: '実力', nat2: '実力', locWin: '当地', loc2: '当地', gA1: '実力', gA2: '実力', gB1: '実力',
  stFast: 'ST', stFastC: 'ST', setuST: 'ST',
  motor2: 'モーター', motorIdx: 'モーター', boat2: 'モーター', mUp: 'モーター', mForm: 'モーター', tune: 'モーター',
  form: '調子', formN: '調子', setuAvg: '調子', setuN: '調子', setuRuns: '調子', setuEx: '調子',
  windC: '水面', waveC: '水面', wDir: '水面', wSpd: '水面', wWave: '水面',
  exDev: '展示', exRank: '展示',
  age: 'その他', weight: 'その他', fRate: 'その他', makuri: 'その他', inGain: 'その他',
  dayIn1: '当日', dayOut: '当日', dayMak: '当日', todayRel: '当日', todaySt: '当日',
};
const GROUPS = ['コース', '実力', '当地', 'ST', 'モーター', '調子', '水面', '展示', '当日', 'その他'];
function contrib(x, beta) {
  const g = Object.fromEntries(GROUPS.map(k => [k, 0]));
  for (let i = 0; i < NF; i++) g[GROUP[FEATS[i]] || 'その他'] += beta[i] * x[i];
  for (const k of GROUPS) g[k] = round(g[k], 2);
  return g;
}

/* ---- 水面条件で、その場のどのコースが得か（読みのポイント用）---- */
function condNote(jcd, wind, wave, windDir) {
  const CD = DB.cond?.[jcd]; if (!CD || wind == null) return null;
  const spdB = wind <= 0 ? '0' : wind <= 2 ? '1-2' : wind <= 4 ? '3-4' : wind <= 6 ? '5-6' : '7+';
  const wavB = wave <= 2 ? '0-2' : wave <= 5 ? '3-5' : wave <= 9 ? '6-9' : '10+';
  const sh = [0, 0, 0, 0, 0, 0];
  const add = t => { if (t) for (let c = 1; c <= 6; c++) sh[c - 1] += t[c] ?? 0; };
  add(CD.spd?.[spdB]); add(CD.wav?.[wavB]);
  if (wind >= 3 && windDir && windDir !== '無風') add(CD.dir?.[windDir]);
  const best = sh.map((v, i) => [v, i + 1]).sort((a, b) => b[0] - a[0]);
  return { shift: sh.map(v => round(v, 2)), best: best[0], worst: best.at(-1) };
}

/* ---- 1レースぶん ---- */
const NAT1 = (() => { let w = 0, n = 0; for (const v of Object.values(DB.venues || {})) { const c = v.course?.[0]; if (c) { w += c.win * c.n; n += c.n; } } return n ? w / n : 0.55; })();

function buildRace(date, jcd, prog, live, venueWeather) {
  const key = `${jcd}|${prog.r}`;
  const lv = live?.races?.[key] || null;
  const before = lv?.before?.published ? lv.before : null;
  const orig = lv?.orig?.published ? lv.orig : null;           // 各場の独自サイトのオリジナル展示（一周・まわり足・直線）
  const stBy = new Map((before?.startEx || []).map(s => [s.lane, s]));
  const bfBy = new Map((before?.boats || []).map(b => [b.lane, b]));

  /* 気象：自分の直前情報 → 同じ場の最新の直前情報 → 不明 */
  let wx = null, wxSrc = null;
  if (before?.weather) { wx = before.weather; wxSrc = 'own'; }
  else if (venueWeather) { wx = venueWeather.weather; wxSrc = `${venueWeather.r}R`; }
  const windDir = wx ? windCompass(jcd, wx.windDir) : null;
  const raceW = { jcd, date, dist: prog.dist, wind: wx ? wx.wind : null, wave: wx ? wx.wave : null, windDir,
    cls: prog.cls || '', close: prog.close || lv?.close || null, fixed: /進入固定/.test(prog.cls || ''), stable: before?.stable || null };

  const boats = prog.boats.map(b => {
    const r = DB.racer?.[b.toban] || null;
    const bf = bfBy.get(b.lane), sx = stBy.get(b.lane);
    const course = sx?.course || null;
    const rolled = roll.read({ date, jcd, r: prog.r }, { toban: b.toban, course, lane: b.lane, motor: b.motor, motorGen: b.motorGen });
    const genIdx = motorGenOf(jcd, b.motor);
    const mi = DB.motor?.[jcd]?.[b.motor + '#' + genIdx] || null;
    return {
      ...b, ...rolled, _p: undefined,
      course, ex: bf?.ex ?? null, tilt: bf?.tilt ?? null, prop: bf?.prop ?? null, parts: bf?.parts || [], adjust: bf?.adjust ?? 0,
      exST: sx ? (sx.f ? -Math.abs(sx.st) : sx.st) : null, exF: !!sx?.f,
      oLap: orig?.boats?.[b.lane]?.lap ?? null, oTurn: orig?.boats?.[b.lane]?.turn ?? null, oStr: orig?.boats?.[b.lane]?.str ?? null,
      motorGenIdx: genIdx,
      racer: r ? {
        idx: r.idx, byC: r.byC?.[course || b.lane] ?? null, byJ: r.byJ?.[jcd] ?? null, st: r.st, stDev: r.stDev,
        fRate: r.fRate, kim: r.kim, inGain: r.inGain, tune: r.tune ?? null, tuneN: r.tuneN ?? 0, n: r.n, win: r.win, top2: r.top2,
      } : null,
      motorIdx: mi ? { idx: mi.idx, n: mi.n, win: mi.win } : null,
    };
  });
  for (const b of boats) delete b._p;

  const feat = level => raceFeatures(raceW, boats.map(b => ({ ...b, motorGen: b.motorGenIdx })), DB, ST, { level });
  const predict = level => {
    const X = feat(level), beta = BETA[level];
    const U = X.map(x => { let s = 0; for (let k = 0; k < NF; k++) s += beta[k] * x[k]; return s; });
    /* 2着・3着は段階モデル（model.json の stage。1着の決まり方で2着の分布を変える）。無ければ PL */
    const pl = raceProbs(U, TAU[level], X.ctx, M.stage || null);
    return { U: U.map(v => round(v)), tau: TAU[level], p1: pl.p1.map(v => round(v, 4)), top2: pl.top2.map(v => round(v, 4)), top3: pl.top3.map(v => round(v, 4)), tri: pl.tri, pairs: pl.pairs, tri120: packTri(pl.tri), c: X.map(x => contrib(x, beta)) };
  };
  const pre = predict('pre');
  const ex = before ? predict('ex') : null;
  const use = ex || pre, level = ex ? 'ex' : 'pre';
  /* 120通りの確率は使う段階のぶんだけ埋める（両方だと1レース1KB増える。もう片方の3D標本は Gumbel で足りる） */
  if (ex) delete pre.tri120;

  /* オッズ（締切前スナップショットがあればそれ、無ければ暫定）*/
  let odds = null;
  if (lv?.odds) {
    const ex3 = new Map(Object.entries(lv.odds.ex3 || {}));            // '1-2-3' → 倍率
    /* snap＝締切前スナップショット（発走直前の最終に近い値）、pre＝もっと前に取った暫定 */
    odds = { win: lv.odds.win, place: lv.odds.place, at: lv.odds.at, left: lv.odds.left, kind: lv.snapAt ? 'snap' : 'pre', ex3 };
  }
  const lanes = boats.map(b => b.lane);
  const tri = use.tri.slice(0, 12).map(([a, b, c, p]) => {
    const k = `${lanes[a]}-${lanes[b]}-${lanes[c]}`;
    const o = odds?.ex3.get(k) ?? null;
    return { k, p: round(p, 4), o, ev: o ? round(p * o, 2) : null };
  });
  /* 3連複（同じ3艇の並び6通りの和）上位 */
  const trioMap = new Map();
  for (const [a, b, c, p] of use.tri) { const k = [lanes[a], lanes[b], lanes[c]].sort().join('-'); trioMap.set(k, (trioMap.get(k) || 0) + p); }
  const trio = [...trioMap].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, p]) => ({ k, p: round(p, 4) }));

  const order = use.p1.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const marks = {}; ['◎', '○', '▲', '△', '△'].forEach((m, i) => { if (order[i] != null) marks[lanes[order[i]]] = m; });

  /* AI の買い目：印ではなく確率そのものから組む。締切時点のものを preds.jsonl に記録して回収率を精算する
       3連単 確率上位 3／5／8点、2連単 確率上位 3／5点、3連単 期待値1.0超（オッズがあるときだけ・最大6点） */
  const ex2 = use.pairs.slice(0, 8).map(([a, b, p]) => ({ k: `${lanes[a]}-${lanes[b]}`, p: round(p, 4) }));
  const ai = {
    tri3: tri.slice(0, 3).map(t => t.k), tri5: tri.slice(0, 5).map(t => t.k), tri8: tri.slice(0, 8).map(t => t.k),
    ex3: ex2.slice(0, 3).map(t => t.k), ex5: ex2.slice(0, 5).map(t => t.k),
    ev: odds ? tri.filter(t => t.ev != null && t.ev >= 1.0).slice(0, 6).map(t => ({ k: t.k, o: t.o, ev: t.ev })) : [],
    triCum: [3, 5, 8].map(n => round(tri.slice(0, n).reduce((a, t) => a + t.p, 0), 3)),   // 上位N点の合計確率
    ex2Cum: [3, 5].map(n => round(ex2.slice(0, n).reduce((a, t) => a + t.p, 0), 3)),
  };

  /* 読みのポイント */
  const V = DB.venues?.[jcd], c1 = V?.course?.[0];
  const pts = [];
  if (c1) pts.push(`${VNAME[jcd]}の1コース1着率は ${(c1.win * 100).toFixed(1)}%（全国 ${(NAT1 * 100).toFixed(1)}%）。1コースの逃げ率 ${(c1.kim[0] * 100).toFixed(0)}%、2コースは差し ${(V.course[1].kim[2] * 100).toFixed(0)}%／まくり ${(V.course[1].kim[1] * 100).toFixed(0)}%。`);
  if (before) {
    const ent = [...stBy.values()].sort((a, b) => a.course - b.course).map(s => s.lane).join('');
    const fast = boats.filter(b => b.ex != null).sort((a, b) => a.ex - b.ex)[0];
    pts.push(`スタート展示の進入 ${ent.split('').join(' ')}${ent !== '123456' ? '（枠なりではない）' : '（枠なり）'}。展示タイム最速は ${fast ? `${fast.lane} ${fast.name}（${fast.ex.toFixed(2)}秒）` : '—'}。`);
    if (orig) {
      const L = orig.labels;
      const best = k => boats.filter(b => b['o' + k[0].toUpperCase() + k.slice(1)] != null).sort((a, b) => a['o' + k[0].toUpperCase() + k.slice(1)] - b['o' + k[0].toUpperCase() + k.slice(1)])[0];
      const bl = best('lap'), bt = best('turn'), bs = L.str ? best('str') : null;
      pts.push(`${VNAME[jcd]}の独自計測：${L.lap}最速 ${bl ? `${bl.lane} ${bl.name}（${bl.oLap.toFixed(2)}）` : '—'}、${L.turn}最速 ${bt ? `${bt.lane} ${bt.name}（${bt.oTurn.toFixed(2)}）` : '—'}${bs ? `、${L.str}最速 ${bs.lane} ${bs.name}（${bs.oStr.toFixed(2)}）` : ''}。`);
    }
    const swapped = boats.filter(b => b.parts.length || b.prop);
    if (swapped.length) pts.push(`部品交換：${swapped.map(b => `${b.lane} ${b.name}（${[...b.parts, b.prop ? 'ペラ新' : ''].filter(Boolean).join('・')}）`).join('、')}。`);
  } else {
    const mz = boats.filter(b => (b.racer?.inGain ?? 0) >= 0.3 && b.lane >= 3);
    pts.push(`直前情報はまだ出ていない（番組表と気象だけの予測）。進入は枠なり前提${mz.length ? `。前づけ傾向：${mz.map(b => `${b.lane} ${b.name}`).join('、')}` : ''}。`);
  }
  const cn = wx ? condNote(jcd, wx.wind, wx.wave, windDir) : null;
  if (wx) {
    pts.push(`風 ${wx.wind}m${windDir && windDir !== '無風' ? `（${windDir}）` : ''}・波 ${wx.wave}cm${wxSrc !== 'own' ? `（同じ場の${wxSrc}の計測値）` : ''}${cn && Math.abs(cn.best[0]) >= 0.08 ? `：この条件の${VNAME[jcd]}では ${cn.best[1]}コースが得（${cn.best[0] >= 0 ? '+' : ''}${cn.best[0].toFixed(2)}）、${cn.worst[1]}コースが損（${cn.worst[0].toFixed(2)}）` : ''}。`);
  }
  const top = boats[order[0]], sec = boats[order[1]];
  const reason = b => Object.entries(use.c[boats.indexOf(b)]).filter(([k]) => k !== 'コース').sort((a, b2) => b2[1] - a[1]).slice(0, 2).filter(([, v]) => v > 0.05).map(([k, v]) => `${k} +${v.toFixed(2)}`).join('・');
  pts.push(`本命 <b>${top.lane} ${top.name}</b>（1着 ${(use.p1[order[0]] * 100).toFixed(1)}%${reason(top) ? `。強み：${reason(top)}` : ''}）、対抗 <b>${sec.lane} ${sec.name}</b>（${(use.p1[order[1]] * 100).toFixed(1)}%）。`);
  if (tri[0]) pts.push(`3連単の本線は ${tri[0].k}（${(tri[0].p * 100).toFixed(1)}%${tri[0].o ? `・${odds.kind === 'snap' ? '締切前' : '暫定'}オッズ ${tri[0].o}倍・期待値 ${tri[0].ev}` : ''}）。`);
  /* 節間の得点率：準優ボーダー付近の艇は勝負気配。初日は成績が無いので出さない */
  const near = boats.filter(b => b.ptGap != null && Math.abs(b.ptGap) <= 1.0).sort((a, b) => b.ptRate - a.ptRate);
  if (near.length) pts.push(`準優ボーダー争い：${near.map(b => `${b.lane} ${b.name}（得点率 ${b.ptRate.toFixed(2)}・${b.ptRank}位/${b.ptTot}人・ボーダー${b.ptGap >= 0 ? '+' : ''}${b.ptGap.toFixed(2)}）`).join('、')}。`);
  /* 級別ボーダー争い（審査期間の勝率がボーダー付近で、期末が近い） */
  for (const b of boats) {
    const kg = kyuGapOf(b.kyu, b.grade);
    if (!kg) { b.kyuInfo = b.kyu && b.kyu.runs ? { rate: round(b.kyu.rate, 2), runs: b.kyu.runs, label: null } : null; continue; }
    const soon = b.kyu.daysLeft <= 75;
    const needRuns = KYU_RUNS[kg.target.startsWith('A1') ? 'A1' : 'A2'];
    /* 札は本当に際どい選手だけ（勝率 0.15〜0.20 の幅＝残り40日で1着2〜3本ぶん） */
    let label = null;
    if (kg.gap < 0 && kg.gap >= -0.20) label = '昇格争い';
    else if (kg.gap >= 0 && kg.gap <= 0.15) label = kg.target.endsWith('維持') ? '降格危機' : '昇格圏';
    b.kyuInfo = { rate: round(b.kyu.rate, 2), runs: b.kyu.runs, q2: round(b.kyu.q2, 2), acc: round(b.kyu.acc, 2), daysLeft: b.kyu.daysLeft,
      target: kg.target, border: round(kg.border, 2), gap: round(kg.gap, 2), needRuns, label: soon || Math.abs(kg.gap) <= 0.1 ? label : null };
  }
  const kyuHot = boats.filter(b => b.kyuInfo?.label);
  if (kyuHot.length) pts.push(`級別ボーダー争い（期末 ${periodEnd(date).slice(4, 6)}/${periodEnd(date).slice(6, 8)}、残り${boats[0].kyu?.daysLeft ?? '—'}日）：${kyuHot.map(b => `${b.lane} ${b.name}（${b.kyuInfo.label}・${b.kyuInfo.target}まで${b.kyuInfo.gap >= 0 ? '+' : ''}${b.kyuInfo.gap.toFixed(2)}、勝率${b.kyuInfo.rate.toFixed(2)}／${b.kyuInfo.runs}走）`).join('、')}。勝率は着順点の概算（SG/G1 の加点は未反映）。`);
  const fs_ = boats.filter(b => (b.racer?.fRate ?? 0) >= 0.02);
  if (fs_.length) pts.push(`F率が高い：${fs_.map(b => `${b.lane} ${b.name}（${(b.racer.fRate * 100).toFixed(1)}%）`).join('、')}。スタートを控えると勢いが削がれる。`);

  const stripTri = o => { const { tri: _t, pairs: _p, ...rest } = o; return rest; };
  return {
    r: prog.r, cls: prog.cls, dist: prog.dist, close: prog.close || lv?.close || null, level,
    weather: wx ? { ...wx, windDir, src: wxSrc } : null,
    orig: orig ? { labels: orig.labels, at: orig.at, src: orig.src } : null,
    fixed: raceW.fixed || undefined, stable: raceW.stable || undefined,
    cond: cn ? cn.shift : null,                    // この条件でのコース別の得失（対数オッズ差）
    boats: boats.map(b => ({
      lane: b.lane, toban: b.toban, name: b.name, age: b.age, branch: b.branch, weight: b.weight, grade: b.grade,
      natWin: b.natWin, nat2: b.nat2, locWin: b.locWin, loc2: b.loc2, motor: b.motor, motor2: b.motor2, boat: b.boat, boat2: b.boat2, setu: b.setu,
      course: b.course, ex: b.ex, exST: b.exST, exF: b.exF, tilt: b.tilt, prop: b.prop, parts: b.parts, adjust: b.adjust,
      oLap: b.oLap, oTurn: b.oTurn, oStr: b.oStr,
      form: round(b.form), formN: b.formN, mForm: round(b.mForm), setuST: round(b.setuST), setuEx: round(b.setuEx), setuRuns: b.setuRuns, mUp: round(b.mUp, 1),
      ptRate: round(b.ptRate, 2), ptN: b.ptN, ptRank: b.ptRank, ptTot: b.ptTot, ptGap: round(b.ptGap, 2), shobu: b.shobu || null, kyu: b.kyuInfo || null,
      dayIn1: round(b.dayIn1, 3), dayOut: round(b.dayOut, 3), dayMak: round(b.dayMak, 3), dayN: b.dayN || 0, todayRel: round(b.todayRel, 2), todaySt: b.todaySt ?? null, todayN: b.todayN || 0,
      racer: b.racer, motorIdx: b.motorIdx,
    })),
    pre: stripTri(pre), ex: ex ? stripTri(ex) : null,
    marks, tri, trio, ex2: ex2.slice(0, 6), ai,
    odds: odds ? { win: odds.win, place: odds.place, at: odds.at, left: odds.left, kind: odds.kind } : null,
    points: pts,
  };
}

/* ---- 当日の結果（od2 の K は開催中に途中まで公開される）から、場ごとの「本日の傾向」を出す ---- */
const TODAY_RES = new Map();                      // 'date|jcd' -> [{r, c1, tri}]
/* 節間の結果（過去日）も同じ表から引くので、今日の7日前から読む（6日開催＋余裕） */
const LOG_FROM = addDays(TODAY, -7);
{
  const f = path.join(ROOT, 'data/boat/results.jsonl');
  const tag = []; for (let d = LOG_FROM; d <= last; d = addDays(d, 1)) tag.push(`"date":"${d}"`);
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line || !tag.some(t => line.includes(t))) continue;
    const k = JSON.parse(line);
    const w = k.entries.find(e => Number(e.pos) === 1);
    if (!w) continue;
    const tri = k.pay?.ex3?.[0]?.y ?? null;        // K の ex3 が3連単（tri は3連複）
    (TODAY_RES.get(`${k.date}|${k.jcd}`) || TODAY_RES.set(`${k.date}|${k.jcd}`, []).get(`${k.date}|${k.jcd}`)).push({ r: k.r, c1: w.course === 1, tri, src: 'K', k });
  }
}
/* 公式サイトのレース結果ページ（fetch_live が締切6分後から拾う）。K より早いので、K に無いレースだけ足す */
function addLiveResults(date, live) {
  let n = 0;
  for (const lv of Object.values(live?.races || {})) {
    const rr = lv.result; if (!rr?.done) continue;
    const key = `${date}|${lv.jcd}`;
    const a = TODAY_RES.get(key) || TODAY_RES.set(key, []).get(key);
    if (a.some(x => x.r === lv.r)) continue;
    /* 公式サイトの組番は 2連複・3連複・拡連複が「1=4=6」なので、K と同じ「1-4-6」に直す（精算の突き合わせ用） */
    const pay = Object.fromEntries(Object.entries(rr.pay || {}).map(([kind, rows]) => [kind, rows.map(x => ({ ...x, c: String(x.c).replace(/=/g, '-') }))]));
    const k = { date, jcd: lv.jcd, r: lv.r, kimari: rr.kimari, entries: rr.entries.map(e => ({ pos: e.pos, lane: e.lane, toban: e.toban, course: e.course, st: e.st, f: e.f })), pay };
    a.push({ r: lv.r, c1: rr.winCourse === 1, tri: rr.pay?.ex3?.[0]?.y ?? null, src: 'web', k }); n++;
  }
  return n;
}
/* その日の終わったレースを時点つきの指標（lib/bload.mjs の makeRolling）に流し込む。
   read() は「番号が若いレースだけ」を見るので、先に全部足しておいて構わない */
function pushTodayResults(date) {
  let n = 0;
  for (const [key, list] of TODAY_RES) {
    if (!key.startsWith(date + '|')) continue;
    const jcd = key.split('|')[1];
    for (const x of list.sort((a, b) => a.r - b.r)) {
      const k = x.k, prog = P.get(`${date}|${jcd}|${k.r}`);
      if (!k || !prog) continue;
      const byLane = new Map(prog.boats.map(b => [b.lane, b]));
      let winC = null;
      for (const e of k.entries) {
        const b = byLane.get(e.lane); if (!b || !b.toban) continue;
        const course = e.course || e.lane;
        const p = DB.base?.[`${jcd}|${course}`]?.win ?? 1 / 6;
        roll.push({ date, jcd, r: k.r, cls: prog.cls || k.cls || '' }, { toban: b.toban, motor: b.motor, motorGen: b.motorGen, pos: e.pos, st: e.st, f: e.f, course }, p, null);
        if (Number(e.pos) === 1) winC = course;
      }
      roll.pushRace({ date, jcd, r: k.r }, winC, k.kimari); n++;
    }
  }
  return n;
}
/* 傾向。結果が3レース以上あれば実測（1コース勝率・3連単平均配当・万舟率）、無ければ予想の本命勝率の平均 */
function trendOf(date, jcd, races, baseC1) {
  const res = (TODAY_RES.get(`${date}|${jcd}`) || []).sort((a, b) => a.r - b.r);
  const fav = races.map(r => Math.max(...(r.ex || r.pre).p1));
  const expect = fav.reduce((a, b) => a + b, 0) / (fav.length || 1);
  const out = { n: res.length, expect: round(expect, 3), baseC1: round(baseC1, 3) };
  if (res.length >= 3) {
    const c1 = res.filter(x => x.c1).length, tris = res.map(x => x.tri).filter(v => v != null);
    const avgTri = tris.length ? tris.reduce((a, b) => a + b, 0) / tris.length : null;
    const man = tris.length ? tris.filter(v => v >= 10000).length / tris.length : 0;
    const c1Rate = c1 / res.length;
    const score = (c1Rate < 0.42 ? 1 : 0) + (avgTri != null && avgTri > 8000 ? 1 : 0) + (man >= 0.3 ? 1 : 0);
    const label = score >= 2 ? '荒れ気味' : (c1Rate >= 0.65 && (avgTri == null || avgTri < 5000)) ? '堅め' : 'ふつう';
    Object.assign(out, { src: 'result', c1, c1Rate: round(c1Rate, 3), avgTri: avgTri != null ? Math.round(avgTri) : null, man: round(man, 2), label });
    out.text = `本日${res.length}R消化：1コース${c1}勝（${(c1Rate * 100).toFixed(0)}%・ふだん${(baseC1 * 100).toFixed(0)}%）${avgTri != null ? `・3連単平均 ${Math.round(avgTri).toLocaleString()}円・万舟${(man * 100).toFixed(0)}%` : ''} → ${label}`;
  } else {
    const label = expect >= 0.6 ? '堅め' : expect <= 0.47 ? '荒れ含み' : 'ふつう';
    Object.assign(out, { src: 'model', label });
    out.text = `${res.length ? `本日${res.length}R消化（判定には3R必要）。` : ''}予想の本命勝率の平均 ${(expect * 100).toFixed(0)}% → ${label}`;
  }
  return out;
}
/* 開催の時間帯。1Rの締切で分ける（モーニング≒8:30〜、日中≒10:30〜、ナイター≒15:00〜） */
function bandOf(firstClose) {
  const t = firstClose ? Number(firstClose.split(':')[0]) * 60 + Number(firstClose.split(':')[1]) : 12 * 60;
  return t < 10 * 60 + 30 ? 'morning' : t >= 14 * 60 + 30 ? 'night' : 'day';
}

/* ---- 締切が過ぎたレースの予想を記録する（回収率の算出用。build_boat_results.mjs が読む）----
   モデルはオッズを使わないので、記録が締切の少し後になっても予想の中身は変わらない。
   ただし「いつ記録したか」（late＝締切から何分後か）は残す。BT_TODAY で過去日を再現したときは記録しない */
const PREDS = path.join(ROOT, 'data/boat/preds.jsonl');
const recorded = new Map();                                  // key -> 記録済みの行（ai の後付け用）
if (fs.existsSync(PREDS)) for (const l of fs.readFileSync(PREDS, 'utf8').split('\n')) if (l) { try { const o = JSON.parse(l); recorded.set(`${o.date}|${o.jcd}|${o.r}`, o); } catch { } }
let predsDirty = false;
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
function recordPred(date, jcd, race) {
  if (process.env.BT_TODAY || date !== ymdOf(new Date()) || !race.close) return;
  const key = `${date}|${jcd}|${race.r}`;
  const old = recorded.get(key);
  if (old) {
    /* AI の買い目を追加する前に記録した行には、同じ入力から作った買い目を後付けする
       （モデルはオッズを使わず、期待値組のオッズも live.json に残っているので中身は同じ） */
    if (!old.ai && race.ai) { old.ai = race.ai; predsDirty = true; }
    return;
  }
  const [h, m] = race.close.split(':').map(Number), late = nowMin() - (h * 60 + m);
  if (late < -1) return;                                     // まだ締切前
  const P = race.ex || race.pre;
  const order = P.p1.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(x => race.boats[x[1]].lane);
  const rec = {
    date, jcd, r: race.r, at: new Date().toISOString(), late, level: race.level, oddsKind: race.odds?.kind || null,
    top: order, p1: Object.fromEntries(race.boats.map((b, i) => [b.lane, P.p1[i]])),
    tri1: race.tri[0]?.k || null, tri1p: race.tri[0]?.p ?? null, tri1o: race.tri[0]?.o ?? null,
    win1o: race.odds?.win?.[order[0]] ?? null,
    ai: race.ai,                                            // AI の買い目（締切時点）
  };
  fs.appendFileSync(PREDS, JSON.stringify(rec) + '\n');
  recorded.set(key, rec);
}
process.on('exit', () => { if (predsDirty) fs.writeFileSync(PREDS, [...recorded.values()].map(o => JSON.stringify(o)).join('\n') + '\n'); });
/* 前回までに集計した成績（build_boat_results.mjs の出力）を場のブロックに添える */
let REC = null;
try { REC = readJSON('data/boat/results.json'); } catch { }

/* ---- 節間の結果 ----
   その開催（節）の初日から date までの、終わったレースの結果と「そのとき記録した予想」を1行ずつ。
   節の日程は live.<date>.json の meet（開催情報ページ）、無ければ番組表の「第n日」から遡る。
   過去日の結果は K（od2）、まだ K に無ければ公式サイトの結果（live.<date>.json）。
   予想は preds.jsonl の記録（締切時点で書いたもの。後から作り直さない）。
   的中と払戻は lib/bsettle.mjs（日別の成績と同じ式）。1レース 200 バイト前後に抑える */
const LIVE_CACHE = new Map();
const liveOf = d => { if (!LIVE_CACHE.has(d)) { let o = null; try { o = readJSON(`data/boat/live.${d}.json`); } catch { } LIVE_CACHE.set(d, o); } return LIVE_CACHE.get(d); };
function meetDatesOf(date, jcd, live, rs) {
  const m = live?.meet?.[jcd];
  if (m?.dates?.length) return m.dates.filter(d => d <= date);
  /* 番組表の「第n日」で遡る：同じ場・同じ節名で日が1つずつ小さくなる限り */
  const out = [date];
  let d = date, n = Number((rs[0]?.day || '').replace(/[^０-９0-9]/g, '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))) || 1;
  for (let i = 0; i < 7 && n > 1; i++) {
    d = addDays(d, -1);
    const p = P.get(`${d}|${jcd}|1`);
    if (!p || p.title !== rs[0].title) break;
    out.unshift(d); n--;
  }
  return out;
}
function meetLog(date, jcd, live, rs) {
  const mdates = meetDatesOf(date, jcd, live, rs);
  const days = [];
  for (const d of mdates) {
    if (d < LOG_FROM) continue;
    const lv = d === date ? live : liveOf(d);
    if (d !== date) addLiveResults(d, lv);             // 過去日で K がまだ無いレースは公式サイトの結果で補う
    const kList = TODAY_RES.get(`${d}|${jcd}`) || [];
    const byR = new Map(kList.map(x => [x.r, x.k]));
    const rows = [];
    const progs = [...P.values()].filter(o => o.date === d && o.jcd === jcd).sort((a, b) => a.r - b.r);
    for (const p of progs) {
      const k = byR.get(p.r);
      const pred = recorded.get(`${d}|${jcd}|${p.r}`) || null;
      const row = { r: p.r, cls: p.cls, close: p.close || null };
      if (pred) {
        row.top = pred.top.slice(0, 4); row.lv = pred.level;
        row.p1 = round(pred.p1?.[pred.top[0]], 3);
        row.ai3 = pred.ai?.tri3 || null;
      }
      if (k) {
        const fin = finishOf(k);
        const w = k.entries.find(e => Number(e.pos) === 1);
        row.fin = fin; row.kim = k.kimari || null; row.c1 = w?.course ?? null;
        row.st = k.entries.filter(e => Number(e.pos) >= 1).sort((a, b) => Number(a.pos) - Number(b.pos)).map(e => e.lane);   // 全着順（失格は末尾に落ちる）
        const dq = k.entries.filter(e => e.pos == null || Number(e.pos) < 1).map(e => e.lane); if (dq.length) row.dq = dq;
        row.pay = { win: payOf(k, 'win', String(fin ? fin[0] : '')), ex2: fin ? payOf(k, 'ex2', `${fin[0]}-${fin[1]}`) : 0,
          tri: fin ? payOf(k, 'tri', fin.slice().sort().join('-')) : 0, ex3: fin ? payOf(k, 'ex3', fin.join('-')) : 0,
          pop3: (k.pay?.ex3 || [])[0]?.pop ?? null };
        if (pred && fin) {
          const S = settle(pred, k);
          if (S) {
            const b = S.bets, h = n => b[n].hit ? 1 : 0, ret = n => b[n].ret;
            row.hit = { w: h('◎単勝'), p: h('◎複勝'), q: h('◎○2連単'), b3: h('3艇BOX3連複'), t3: h('3連単 ◎○▲(1点)'), a3: b['AI 3連単 上位3点'].n ? h('AI 3連単 上位3点') : null, in3: S.in3 };
            row.ret = { w: ret('◎単勝'), p: ret('◎複勝'), q: ret('◎○2連単'), b3: ret('3艇BOX3連複'), a3: ret('AI 3連単 上位3点') };
          }
        }
        row.src = (kList.find(x => x.r === p.r) || {}).src || null;
      }
      rows.push(row);
    }
    /* 日の集計（◎的中／◎単勝・3艇BOX3連複・AI上位3点 の投資と払戻） */
    const done = rows.filter(r => r.hit);
    const sum = key => done.reduce((a, r) => a + (r.ret?.[key] || 0), 0);
    const cnt = key => done.reduce((a, r) => a + (r.hit?.[key] || 0), 0);
    const nA3 = done.filter(r => r.hit.a3 != null).length;
    days.push({
      date: d, dayIdx: mdates.indexOf(d) + 1, n: rows.length, done: rows.filter(r => r.fin).length, pred: done.length,
      c1: rows.filter(r => r.c1 === 1).length, res: rows.filter(r => r.fin).length,
      sum: done.length ? { hit1: cnt('w'), in3: cnt('in3'), p: cnt('p'), b3: cnt('b3'), a3: cnt('a3'), retW: sum('w'), retP: sum('p'), retB3: sum('b3'), retA3: sum('a3'), betA3: nA3 * 300 } : null,
      rows,
    });
  }
  return { dates: mdates, days };
}

/* ---- モーター一覧（場データのタブ用）----
   その節に使われている全モーターを、番組表の「モーター2連率」（今期＝入れ替え後の累計）と 3年の実測指数（同じ番号・同じ世代）、
   節間の成績（K の着順をモーター番号で集計）、割り当て（日ごとに誰が乗ったか）で並べる。エース機＝2連率の上位 */
function motorList(date, jcd, mdates) {
  const byNo = new Map();
  const names = new Map();                        // toban -> name
  const days = mdates.filter(d => d >= LOG_FROM);
  for (const d of days) {
    const di = mdates.indexOf(d) + 1;
    const progs = [...P.values()].filter(o => o.date === d && o.jcd === jcd);
    const res = new Map((TODAY_RES.get(`${d}|${jcd}`) || []).map(x => [x.r, x.k]));
    for (const p of progs) for (const b of p.boats) {
      if (b.motor == null) continue;
      let m = byNo.get(b.motor); if (!m) byNo.set(b.motor, m = { no: b.motor, m2: null, boat: null, b2: null, runs: [] });
      if (d >= (m._d || '')) { m.m2 = b.motor2 ?? m.m2; m.boat = b.boat ?? m.boat; m.b2 = b.boat2 ?? m.b2; m._d = d; }
      if (b.toban) names.set(b.toban, b.name);
      const k = res.get(p.r);
      const e = k?.entries?.find(x => x.lane === b.lane);
      const pos = e ? (Number(e.pos) >= 1 ? Number(e.pos) : 0) : null;   // 0＝失格など、null＝未確定
      m.runs.push([di, p.r, b.lane, b.toban || null, pos, e?.course ?? null]);
    }
  }
  const out = [];
  for (const m of byNo.values()) {
    const gen = motorGenOf(jcd, m.no);
    const mi = DB.motor?.[jcd]?.[m.no + '#' + gen] || null;
    const done = m.runs.filter(r => r[4] != null && r[4] > 0);
    const w1 = done.filter(r => r[4] === 1).length, w2 = done.filter(r => r[4] <= 2).length, w3 = done.filter(r => r[4] <= 3).length;
    const today = m.runs.filter(r => r[0] === mdates.indexOf(date) + 1);
    out.push({ no: m.no, m2: m.m2, boat: m.boat, b2: m.b2, idx: mi ? round(mi.idx, 2) : null, n: mi?.n ?? null, win: mi ? round(mi.win, 3) : null,
      meet: { runs: done.length, w1, w2, w3 }, runs: m.runs, today: today.map(r => [r[1], r[2], r[3]]) });
  }
  out.sort((a, b) => (b.m2 ?? -1) - (a.m2 ?? -1) || (b.idx ?? -9) - (a.idx ?? -9));
  out.forEach((m, i) => m.rank = i + 1);
  return { motors: out, names: Object.fromEntries(names) };
}

/* ---- 日ごと・場ごとに組む ---- */
/* built は「データの時点」にする（現在時刻にすると、中身が同じでも today.json が毎回変わって
   refresh_boat が空のコミットを積み続ける） */
const dataAt = (() => {
  let t = fs.statSync(path.join(ROOT, 'data/boat/programs.jsonl')).mtime.toISOString();
  for (const d of dates) { try { const a = readJSON(`data/boat/live.${d}.json`).at; if (a && a > t) t = a; } catch { } }
  return t;
})();
const out = {
  meta: {
    built: dataAt, today: TODAY,
    model: { built: M.meta.built, split: M.meta.split, train: M.meta.train, test: M.meta.test, pre: M.pre.test, ex: M.ex.test, courseOnly: M.courseOnly, stage: M.stage?.test || null },
    index: { from: DB.meta.from, to: DB.meta.to, races: DB.meta.races, racers: Object.keys(DB.racer || {}).length },
    backtest: BT ? { level: BT.meta.level, from: BT.meta.from, to: BT.meta.to, races: BT.meta.races, table: BT.table } : null,
    nat1: round(NAT1, 4),
  },
  days: [],
};
for (const date of dates) {
  const progs = [...P.values()].filter(o => o.date === date);
  if (!progs.length) { console.error(`  ${date}: 番組表なし`); continue; }
  let live = null;
  try { live = readJSON(`data/boat/live.${date}.json`); } catch { }
  const nWeb = addLiveResults(date, live), nPushed = pushTodayResults(date);
  if (nPushed) console.error(`  ${date}: 当日の結果 ${nPushed}R（うち公式サイトから ${nWeb}R）を時点指標に反映`);
  const byV = new Map();
  for (const o of progs) (byV.get(o.jcd) || byV.set(o.jcd, []).get(o.jcd)).push(o);
  const venues = [];
  for (const jcd of [...byV.keys()].sort()) {
    const rs = byV.get(jcd).sort((a, b) => a.r - b.r);
    /* 同じ場の「最新の直前情報の気象」を、まだ直前情報が出ていないレースの推定に使う */
    let latestWx = null;
    const races = rs.map(p => {
      const lv = live?.races?.[`${jcd}|${p.r}`];
      const race = buildRace(date, jcd, p, live, latestWx);
      if (lv?.before?.published && lv.before.weather) latestWx = { r: p.r, weather: lv.before.weather };
      recordPred(date, jcd, race);
      return race;
    });
    const recV = REC?.days?.find(d => d.date === date)?.venues?.find(v => v.jcd === jcd) || null;
    const LOG = meetLog(date, jcd, live, rs);
    /* 当日の終わったレースには結果を添える（予想の下に着順と的中を出す） */
    const todayRows = LOG.days.find(x => x.date === date)?.rows || [];
    for (const race of races) { const row = todayRows.find(x => x.r === race.r); if (row?.fin) race.result = { fin: row.fin, st: row.st, kim: row.kim, c1: row.c1, pay: row.pay, hit: row.hit || null, ret: row.ret || null, top: row.top || null }; }
    const V = DB.venues?.[jcd] || {}, S = ST[jcd] || {};
    const vinfo = VENUES.find(v => v.jcd === jcd) || {};
    const closes0 = live?.closes?.[jcd] || rs.map(p => p.close);
    /* 勝ち上がり条件と勝負駆け（節の日数は live の開催情報、無ければ番組表の「第n日」だけ） */
    const meet = live?.meet?.[jcd] || null;
    const dayIdx = meet?.dayIdx || Number((rs[0].day || '').replace(/[^０-９0-9]/g, '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))) || null;
    const days = meet?.days || null;
    const hasSemi = rs.some(p => /準優/.test(p.cls || '')), hasFinal = rs.some(p => /優勝戦/.test(p.cls || '') && !/準優/.test(p.cls || ''));
    /* 準優勝戦は最終日の前日（4日間なら3日目、6日間なら5日目）。予選最終日はその前日 */
    const lastPrelim = days && dayIdx && days >= 4 ? dayIdx === days - 2 : false;
    const afterPrelim = hasSemi || hasFinal || (days && dayIdx ? dayIdx > days - 2 : false);
    const adv = rs.reduce((s, p) => s + p.boats.length, 0) >= 36 ? 18 : 12;
    /* 選手ごとの残り走数（この日）と、ボーダー到達に必要な平均点。
       予選最終日より前は「残りの予選日 × 1日の走数」も残り走数に足す（今日中に届く必要はない） */
    const restOf = new Map();
    for (const p of rs) for (const b of p.boats) if (b.toban) (restOf.get(b.toban) || restOf.set(b.toban, []).get(b.toban)).push(p.r);
    const prelimDaysLeft = days && dayIdx ? Math.max(0, days - 2 - dayIdx) : 0;
    for (const race of races) {
      const p = rs.find(x => x.r === race.r);
      const cls = p?.cls || '';
      /* 準優・優勝戦がある日（＝予選が終わった日）の残りのレースは、名前が何であれ勝ち上がりに関係ない一般戦 */
      const phase = /優勝戦/.test(cls) && !/準優/.test(cls) ? '優勝戦' : /準優/.test(cls) ? '準優勝戦' : afterPrelim ? '一般' : '予選';
      let text = '';
      if (phase === '優勝戦') text = '優勝戦。';
      else if (phase === '準優勝戦') text = '準優勝戦：上位2着までが優勝戦へ（開催によっては1着のみ）。';
      else if (phase === '一般') text = hasFinal && !hasSemi ? '一般戦（優勝戦に進めなかった選手同士。勝ち上がりなし）。' : '一般戦（準優・優勝戦に進めなかった選手同士。勝ち上がりなし）。';
      else if (lastPrelim) text = `予選最終日（${dayIdx}日目／${days}日間）。この日の結果で得点率上位${adv}人が準優勝戦へ。`;
      else if (days && dayIdx) text = `予選（${dayIdx}日目／${days}日間、準優進出は上位${adv}人）。`;
      race.stage = { phase, dayIdx, days, lastPrelim, adv, text };
      if (phase === '予選' && dayIdx && dayIdx >= 2) {
        const border = p.boats.map(b => b.ptGap != null && b.ptRate != null ? b.ptRate - b.ptGap : null).find(v => v != null);
        for (const b of race.boats) {
          const pb = p.boats.find(x => x.lane === b.lane);
          if (!pb || pb.ptRate == null || border == null) continue;
          const today = restOf.get(pb.toban) || [];
          const remain = today.filter(r => r >= race.r).length + today.length * prelimDaysLeft;   // この走を含む残りの予選走数
          const S0 = pb.ptRate * pb.ptN;
          const need = remain ? (border * (pb.ptN + remain) - S0) / remain : null;     // 残りの平均で何点要るか
          const worst = (S0 + remain * 1) / (pb.ptN + remain) - border;                  // 全部6着でもボーダーに届くか
          /* 10-8-6-4-2-1 点なので、平均 6 点超＝2着以上が必要、4〜6 点＝3着前後が必要 */
          let label = null;
          if (need != null) label = worst >= 0 ? '当確圏' : need > 10 ? '厳しい' : need > 6 ? '勝負駆け' : need > 4 ? '要好走' : null;
          b.shobu = { remain, need: need != null ? round(need, 1) : null, worst: round(worst, 2), label, lastPrelim };
        }
      }
    }
    /* 読みのポイントに勝ち上がり条件と勝負駆けを足す */
    for (const race of races) {
      if (race.stage?.text) race.points.unshift(race.stage.text);
      const sb = race.boats.filter(b => b.shobu?.label && b.shobu.label !== '当確圏');
      if (sb.length) race.points.push(`勝負駆け：${sb.map(b => `${b.lane} ${b.name}（${b.shobu.label}・残り${b.shobu.remain}走で平均${b.shobu.need}点${b.shobu.need > 8 ? '＝ほぼ1着' : b.shobu.need > 6 ? '＝2着以上' : ''}）`).join('、')}。`);
      const safe = race.boats.filter(b => b.shobu?.label === '当確圏');
      if (safe.length && race.stage?.lastPrelim) race.points.push(`準優進出が濃厚：${safe.map(b => `${b.lane} ${b.name}`).join('、')}（全部6着でもボーダー以上）。`);
      /* その日のここまでの傾向（時点指標 dayIn1 …）。3R 以上たまってから */
      const b0 = race.boats[0];
      if (b0 && b0.dayN >= 3) {
        const base1 = V.course?.[0]?.win ?? NAT1;
        const res = (TODAY_RES.get(`${date}|${jcd}`) || []).filter(x => x.r < race.r);
        const c1 = res.filter(x => x.c1).length, mak = res.filter(x => /まくり/.test(x.k?.kimari || '')).length;
        const inTxt = b0.dayIn1 >= 0.06 ? 'イン有利' : b0.dayIn1 <= -0.06 ? 'インが弱い' : 'ふだん並み';
        const outTxt = b0.dayOut >= 0.25 ? '・外のコースが来ている' : b0.dayOut <= -0.25 ? '・内で決まっている' : '';
        race.points.push(`本日ここまで${res.length}R：1コース${c1}勝（${(c1 / res.length * 100).toFixed(0)}%・ふだん${(base1 * 100).toFixed(0)}%）・まくり系${mak}本 → ${inTxt}${outTxt}。${BETA.ex[FEATS.indexOf('dayIn1')] ? 'この傾向は予測にも入れてある（根拠の「当日」）。' : '（予測への反映は次のモデル更新から）'}`);
      }
      const ran = race.boats.filter(b => b.todayN > 0);
      if (ran.length) race.points.push(`本日すでに走った艇：${ran.map(b => `${b.lane} ${b.name}（${Math.round((0.5 - b.todayRel) * 5 + 1)}着${b.todaySt != null ? `・ST${b.todaySt.toFixed(2)}` : ''}）`).join('、')}。`);
    }
    venues.push({
      jcd, name: VNAME[jcd], pref: vinfo.pref || V.pref || '', area: vinfo.area || V.area || '',
      title: rs[0].title, day: rs[0].day,
      band: bandOf(closes0?.[0]),
      meet: { days, dayIdx, lastPrelim, hasSemi, hasFinal, adv, dates: LOG.dates },
      log: LOG,                                         // 節間の結果（結果・予想・的中）
      motors: motorList(date, jcd, LOG.dates),          // モーター一覧（今期2連率・3年指数・節間成績・割り当て）
      trend: trendOf(date, jcd, races, V.course?.[0]?.win ?? NAT1),
      rec: recV ? { races: recV.races, hit1: recV.hit1, in3: recV.in3, bets: recV.bets } : null,   // 本日ここまでの成績
      course: (V.course || []).map(c => ({ n: c.n, win: round(c.win, 4), top2: round(c.top2, 4), top3: round(c.top3, 4), st: c.st, kim: c.kim })),
      take: S.take || null, water: S.water || null, tide: S.tide || null, motorType: S.motorType || null,
      tideDay: tideDayOf(jcd, date),                     // その日の潮位（毎時・満潮・干潮）。干満差のある場だけ
      origSrc: ORIGEX[jcd] ? { host: ORIGEX[jcd].host, labels: ORIGEX[jcd].labels } : null,   // 独自展示データが取れる場か
      closes: live?.closes?.[jcd] || rs.map(p => p.close),
      exCount: races.filter(r => r.level === 'ex').length,
      races,
    });
  }
  out.days.push({ date, venues });
  console.error(`  ${date}: ${venues.length}場 ${venues.reduce((a, v) => a + v.races.length, 0)}R（直前情報あり ${venues.reduce((a, v) => a + v.exCount, 0)}R）`);
}
/* ---- TOP（top.html）用のたたんだ版。1レースあたり数百バイトに抑える ---- */
const PICK = ['◎単勝', '◎複勝', '本命3艇BOX 3連複', '◎○の2連単1点', '［基準］1号艇の単勝', '［基準］1号艇の複勝', '［基準］123の3連複'];
const top = {
  builtAt: out.meta.built, today: TODAY, nat1: out.meta.nat1,
  model: out.meta.model ? { hit1: out.meta.model.ex?.hit1, in3: out.meta.model.ex?.in3, courseOnly: out.meta.model.courseOnly?.hit1, test: out.meta.model.test } : null,
  backtest: BT ? { races: BT.meta.races, from: BT.meta.from, to: BT.meta.to, byVenue: BT.byVenue || null, table: Object.fromEntries(PICK.filter(k => BT.table[k]).map(k => [k, { hit: BT.table[k].hit, roi: BT.table[k].roi }])) } : null,
  days: out.days.map(d => ({
    date: d.date,
    venues: d.venues.map(v => ({
      jcd: v.jcd, name: v.name, title: v.title, day: v.day, exCount: v.exCount, win1: v.course?.[0]?.win ?? null,
      band: v.band, trend: { label: v.trend.label, text: v.trend.text, src: v.trend.src }, rec: v.rec, meet: v.meet,
      log: v.log ? v.log.days.map(({ rows: _r, ...d }) => d) : null,
      tideDay: v.tideDay ? { name: v.tideDay.name, hi: v.tideDay.hi, lo: v.tideDay.lo } : null,
      races: v.races.map(r => {
        const P = r.ex || r.pre;
        const ord = P.p1.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).slice(0, 3);
        return {
          r: r.r, close: r.close, cls: r.cls, level: r.level, oddsKind: r.odds?.kind || null,
          phase: r.stage?.phase || null, lastPrelim: !!r.stage?.lastPrelim, shobu: r.boats.filter(b => b.shobu?.label === '勝負駆け').map(b => b.lane),
          top: ord.map(([p, i]) => ({ lane: r.boats[i].lane, name: r.boats[i].name, grade: r.boats[i].grade, p: round(p, 3), o: r.odds?.win?.[r.boats[i].lane] ?? null })),
          tri: r.tri[0] ? { k: r.tri[0].k, p: r.tri[0].p, o: r.tri[0].o, ev: r.tri[0].ev } : null,
          box3: ord.map(([, i]) => r.boats[i].lane).sort().join('-'),
          ai: { tri3: r.ai.tri3, ex3: r.ai.ex3, cum3: r.ai.triCum[0], ev: r.ai.ev.map(x => x.k) },
        };
      }),
    })),
  })),
};
writeJSON('data/boat/top.json', top);
console.error(`-> data/boat/top.json (${(fs.statSync(path.join(ROOT, 'data/boat/top.json')).size / 1024).toFixed(0)} KB)`);

/* ---- boat.html 埋め込み用に軽くする ----
   艇は「列名＋配列」にしてキー名の繰り返しを消し、使わない項目を落とし、桁を丸める。
   boat.html は読み込み時に boatCols を使って元のオブジェクトに戻す（unpackBoats）。
   1日ぶんで 3MB → 1MB 台。蓄積するのは data/ 側であって、ページは常に今日・明日だけ */
const BOAT_COLS = ['lane', 'toban', 'name', 'age', 'branch', 'weight', 'grade', 'natWin', 'nat2', 'locWin', 'loc2', 'motor', 'motor2', 'boat', 'boat2', 'setu',
  'course', 'ex', 'exST', 'exF', 'oLap', 'oTurn', 'oStr', 'tilt', 'prop', 'parts', 'adjust', 'form', 'formN', 'mForm', 'setuST', 'setuEx', 'setuRuns', 'mUp',
  'ptRate', 'ptN', 'ptRank', 'ptTot', 'ptGap', 'shobu', 'kyu',
  'r_idx', 'r_byC', 'r_byJ', 'r_st', 'r_stDev', 'r_fRate', 'r_inGain', 'r_tune', 'r_n', 'm_idx', 'm_n'];
const r2 = v => v == null ? null : Number(v.toFixed(2)), r3 = v => v == null ? null : Number(v.toFixed(3));
const packPred = P => P && ({ U: P.U.map(r2), tau: P.tau, p1: P.p1.map(r3), top2: P.top2.map(r3), top3: P.top3.map(r3), tri120: P.tri120, c: P.c.map(g => GROUPS.map(k => g[k] || 0)) });
out.boatCols = BOAT_COLS;
out.kyuDaysLeft = Object.fromEntries(out.days.map(d => [d.date, dayNoOf(periodEnd(d.date)) - dayNoOf(d.date)]));   // 期末までの日数（日ごと）
out.groups = GROUPS;
for (const d of out.days) for (const v of d.venues) for (const r of v.races) {
  r.boats = r.boats.map(b => {
    const flat = { ...b, r_idx: b.racer?.idx ?? null, r_byC: b.racer?.byC ?? null, r_byJ: b.racer?.byJ ?? null, r_st: b.racer?.st ?? null, r_stDev: b.racer?.stDev ?? null,
      r_fRate: b.racer?.fRate ?? null, r_inGain: b.racer?.inGain ?? null, r_tune: b.racer?.tune ?? null, r_n: b.racer?.n ?? null, m_idx: b.motorIdx?.idx ?? null, m_n: b.motorIdx?.n ?? null };
    /* 級別は配列にたたむ（[勝率, 走数, 2連対, 事故率, 目標, ボーダー, 差, 札]。boat.html の unpackBoats が戻す） */
    if (flat.kyu) { const k = flat.kyu; flat.kyu = [k.rate, k.runs, k.q2 ?? null, k.acc ?? null, k.target || null, k.border ?? null, k.gap ?? null, k.label || null]; }
    return BOAT_COLS.map(k => { const v = flat[k]; return v === undefined ? null : (Array.isArray(v) && !v.length ? 0 : v); });
  });
  r.pre = packPred(r.pre); r.ex = packPred(r.ex);
  r.tri = r.tri.map(t => ({ k: t.k, p: r3(t.p), o: t.o, ev: t.ev }));
  r.trio = r.trio.map(t => ({ k: t.k, p: r3(t.p) }));
  r.ex2 = r.ex2.map(t => ({ k: t.k, p: r3(t.p) }));
  if (r.cond) r.cond = r.cond.map(r2);
}
writeJSON('data/boat/today.json', out);
console.error(`-> data/boat/today.json (${(fs.statSync(path.join(ROOT, 'data/boat/today.json')).size / 1024).toFixed(0)} KB)`);
