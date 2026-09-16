/* 条件付きロジット（Plackett–Luce）を実データに当てはめる。依存ゼロ・Node標準のみ。

     U_i = β・x_i                     … 馬ごとの強さ（単位は対数オッズ）
     P(i が1着) = exp(U_i) / Σ_j exp(U_j)
     1〜3着の並びまで使う（Plackett–Luce）ので、勝ち馬だけより情報量が多い。

   第1段  オッズを使わない基礎モデル            → p_fund
   第2段  log p_fund と log p_public を合成      → p_final
          第2段の係数が「人気に何を足せているか」の答えになる。

   使い方: node tools/fit_model.mjs
   出力: data/nankan/model.json                                              */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { makeFeaturizer, buildLapIndex, buildShikenIndex, buildFormIndex, FEATURES } from './lib/feat.mjs';

const DBFILE = process.env.NK_FIT_DB || 'data/nankan/index.json';
const SPLIT = process.env.NK_FIT_SPLIT || '2026-06-01';   // これ以降を検証に回す
const L2 = Number(process.env.NK_FIT_L2 || 2.0);
const ITER = Number(process.env.NK_FIT_ITER || 4000);
const DO_STAGE2 = process.env.NK_FIT_STAGE2 !== '0';        // 第2段（out-of-fold の合成）。L2 のスイープでは 0 にして時間を省く
const DO_JOINT = process.env.NK_FIT_JOINT !== '0';          // joint（市場を特徴量に入れて同時に当てはめる）
const DO_STAGE = process.env.NK_FIT_STAGE !== '0';          // 2着・3着の段階モデル

/* 取得ジョブが追記中でも壊れないよう、読めない行は捨てる */
const jl = f => fs.readFileSync(path.join(ROOT, 'data/nankan', f), 'utf8').split('\n')
  .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const DB = readJSON(DBFILE);
const featurize = makeFeaturizer(DB);
const resArr = jl('results.jsonl');
const cardArr = jl('cards.jsonl');
const LAP = buildLapIndex(resArr, cardArr);
/* 能力・調教試験（新馬・転入初戦の手がかり）*/
try { LAP.shiken = buildShikenIndex(jl('shiken.jsonl')); } catch { LAP.shiken = null; }
/* 騎手・調教師の「そのレース時点」の調子（過去の騎乗だけから作る）*/
LAP.form = buildFormIndex(cardArr, resArr);
const results = new Map(resArr.map(r => [r.raceId, r]));
const oddsMap = new Map((fs.existsSync(path.join(ROOT, 'data/nankan/odds.jsonl')) ? jl('odds.jsonl') : []).map(o => [o.raceId, o]));

/* ---- 1. 学習データを組む ---- */
const races = [];
for (const card of cardArr) {
  const res = results.get(card.raceId);
  if (!res || res.order.length < 3) continue;
  const f = featurize(card, res.baba, null, LAP);
  if (!f) continue;
  const nos = new Set(f.rows.map(r => r.no));
  const order = res.order.filter(no => nos.has(no));
  if (order.length < 3) continue;
  f.order = order;
  const od = oddsMap.get(card.raceId);
  if (od) f.rows.forEach(r => { const t = od.tan[r.no]; r.odds = t && t.odds > 0 ? t.odds : null; r.pop = t ? t.pop : null; });
  races.push(f);
}
races.sort((a, b) => a.raceId.localeCompare(b.raceId));
const train = races.filter(r => r.date < SPLIT), test = races.filter(r => r.date >= SPLIT);
console.error(`学習 ${train.length} レース（${train[0]?.date}〜） / 検証 ${test.length} レース（${test[0]?.date}〜）`);
console.error(`オッズあり ${races.filter(r => r.rows.some(x => x.odds)).length} レース`);
if (train.length < Number(process.env.NK_FIT_MIN || 200)) { console.error('学習データが足りない。fetch_results.mjs を先に流すこと。'); process.exit(1); }

/* ---- 2. 標準化 ---- */
const mean = {}, sd = {};
for (const k of FEATURES) {
  const v = [];
  for (const r of train) for (const h of r.rows) v.push(h.x[k]);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const s = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
  mean[k] = m; sd[k] = s;
}
const vec = h => FEATURES.map(k => (h.x[k] - mean[k]) / sd[k]);
for (const r of races) r.rows.forEach(h => h.v = vec(h));

/* ---- 3. Plackett–Luce の対数尤度と勾配 ---- */
const D = FEATURES.length;
/* key: 行の特徴量ベクトルの名前（'v'＝基礎、'vj'＝市場つき）。次元は beta の長さで決まる */
function llGrad(rs, beta, l2, key = 'v') {
  const D = beta.length;
  let ll = 0;
  const g = new Float64Array(D);
  for (const r of rs) {
    const u = r.rows.map(h => { let s = 0; const x = h[key]; for (let k = 0; k < D; k++) s += beta[k] * x[k]; return s; });
    const idx = new Map(r.rows.map((h, i) => [h.no, i]));
    const alive = r.rows.map((_, i) => i);
    for (let step = 0; step < 3; step++) {
      const win = idx.get(r.order[step]);
      if (win == null) break;
      let mx = -Infinity;
      for (const i of alive) if (u[i] > mx) mx = u[i];
      let z = 0;
      const w = [];
      for (const i of alive) { const e = Math.exp(u[i] - mx); w.push(e); z += e; }
      ll += (u[win] - mx) - Math.log(z);
      // exp は1頭につき1回だけ。特徴量ごとに計算し直すと29倍遅くなる
      for (let a2 = 0; a2 < alive.length; a2++) {
        const p = w[a2] / z, vv = r.rows[alive[a2]][key];
        for (let k = 0; k < D; k++) g[k] -= p * vv[k];
      }
      for (let k = 0; k < D; k++) g[k] += r.rows[win][key][k];
      alive.splice(alive.indexOf(win), 1);
      if (alive.length < 2) break;
    }
  }
  for (let k = 0; k < D; k++) { ll -= l2 * beta[k] * beta[k] / 2; g[k] -= l2 * beta[k]; }
  return { ll, g };
}

/* Adam で最大化 */
function fit(rs, l2, iters, key = 'v', dim = D) {
  const beta = new Float64Array(dim);
  const m = new Float64Array(dim), v = new Float64Array(dim);
  const a = 0.05, b1 = 0.9, b2 = 0.999, eps = 1e-8;
  let last = -Infinity;
  for (let t = 1; t <= iters; t++) {
    const { ll, g } = llGrad(rs, beta, l2, key);
    for (let k = 0; k < dim; k++) {
      m[k] = b1 * m[k] + (1 - b1) * g[k];
      v[k] = b2 * v[k] + (1 - b2) * g[k] * g[k];
      beta[k] += a * (m[k] / (1 - b1 ** t)) / (Math.sqrt(v[k] / (1 - b2 ** t)) + eps);
    }
    if (t % 500 === 0) { console.error(`  iter ${t}  logL ${ll.toFixed(1)}`); if (ll - last < 1e-4) break; last = ll; }
  }
  return beta;
}
console.error('第1段（オッズなし）を当てはめ中…');
const beta = fit(train, L2, ITER);

/* ---- 4. 確率を出すユーティリティ ---- */
const softmax = us => { const mx = Math.max(...us); const e = us.map(u => Math.exp(u - mx)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); };
const pFund = r => softmax(r.rows.map(h => { let s = 0; for (let k = 0; k < D; k++) s += beta[k] * h.v[k]; return s; }));
/* 市場の確率＝単勝オッズの逆数を正規化（控除率を割り戻す） */
function pPublic(r) {
  if (!r.rows.every(h => h.odds)) return null;
  const inv = r.rows.map(h => 1 / h.odds);
  const z = inv.reduce((a, b) => a + b, 0);
  return inv.map(x => x / z);
}

/* ---- 4b. joint：市場（単勝オッズの対数確率、レース内で中心化）を特徴量の1つにして全部と同時に当てはめる ----
   第2段は「基礎モデル丸ごと」を市場と混ぜるので、市場に足せない部分まで一緒に潰れる。joint なら
   特徴量ごとに「市場の上に足せる分」だけが係数に残る（JRA と同じ作り）。オッズのあるレースだけで学習する */
let betaJ = null;
for (const r of races) {
  const pp = pPublic(r);
  const lg = pp ? pp.map(x => Math.log(Math.max(x, 1e-9))) : null;
  const mean = lg ? lg.reduce((a, b) => a + b, 0) / lg.length : 0;
  r.rows.forEach((h, i) => { h.mkt = lg ? lg[i] - mean : 0; h.vj = [...h.v, h.mkt]; });
}
if (DO_JOINT) {
  const trJ = train.filter(r => r.rows.every(h => h.odds));
  console.error(`joint（市場つき）を当てはめ中… ${trJ.length} レース`);
  betaJ = Array.from(fit(trJ, L2, ITER, 'vj', D + 1));
  console.error(`  市場の係数 ${betaJ[D].toFixed(3)}（残った特徴量：${FEATURES.map((k, i) => [k, betaJ[i]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v.toFixed(3)}`).join(' / ')}）`);
}
const pJoint = r => (betaJ && r.rows.every(h => h.odds)) ? softmax(r.rows.map(h => { let s = 0; for (let k = 0; k <= D; k++) s += betaJ[k] * h.vj[k]; return s; })) : null;

/* ---- 5. 第2段：基礎モデルと人気の合成 ----
   第2段を「第1段の学習に使ったレース」で当てはめると、第1段の過学習ぶんまで
   価値があるように見えてしまう。学習期間を時系列で3分割し、
   各ブロックを残り2ブロックで学習したモデルで予測した out-of-fold の確率を使う。  */
const softmaxU = (rows, b) => softmaxArr(rows.map(h => { let s = 0; for (let k = 0; k < b.length; k++) s += b[k] * h.v[k]; return s; }));
function softmaxArr(us) { const mx = Math.max(...us); const e = us.map(u => Math.exp(u - mx)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); }

function fitStage2(rows) {
  const D2 = 2;
  const b = new Float64Array(D2).fill(0.5);
  const m = new Float64Array(D2), v = new Float64Array(D2);
  for (let t = 1; t <= 3000; t++) {
    const g = new Float64Array(D2);
    for (const r of rows) {
      const u = r.rows.map(h => b[0] * h.v[0] + b[1] * h.v[1]);
      const idx = new Map(r.rows.map((h, i) => [h.no, i]));
      const alive = r.rows.map((_, i) => i);
      for (let step = 0; step < 3; step++) {
        const win = idx.get(r.order[step]); if (win == null) break;
        const mx = Math.max(...alive.map(i => u[i]));
        let z = 0; const w = [];
        for (const i of alive) { const e = Math.exp(u[i] - mx); w.push(e); z += e; }
        for (let a2 = 0; a2 < alive.length; a2++) {
          const p = w[a2] / z, vv = r.rows[alive[a2]].v;
          for (let k = 0; k < D2; k++) g[k] -= p * vv[k];
        }
        for (let k = 0; k < D2; k++) g[k] += r.rows[win].v[k];
        alive.splice(alive.indexOf(win), 1);
        if (alive.length < 2) break;
      }
    }
    for (let k = 0; k < D2; k++) {
      m[k] = 0.9 * m[k] + 0.1 * g[k]; v[k] = 0.999 * v[k] + 0.001 * g[k] * g[k];
      b[k] += 0.01 * (m[k] / (1 - 0.9 ** t)) / (Math.sqrt(v[k] / (1 - 0.999 ** t)) + 1e-8);
    }
  }
  return Array.from(b);
}

let beta2 = null;
if (DO_STAGE2) {
  const K = 3, n = train.length, oof = [];
  console.error(`第2段（人気との合成）を out-of-fold で当てはめ中… ${K}分割`);
  for (let f = 0; f < K; f++) {
    const lo = Math.floor(n * f / K), hi = Math.floor(n * (f + 1) / K);
    const tr = [...train.slice(0, lo), ...train.slice(hi)], va = train.slice(lo, hi);
    const bf = fit(tr, L2, Math.min(ITER, 1200));
    for (const r of va) {
      const pp = pPublic(r);
      if (!pp) continue;
      const pf = softmaxU(r.rows, bf);
      oof.push({ ...r, rows: r.rows.map((h, i) => ({ ...h, v: [Math.log(pf[i]), Math.log(pp[i])] })) });
    }
    console.error(`  fold ${f + 1}/${K}: 学習 ${tr.length} → 検証 ${va.length}`);
  }
  if (oof.length >= 200) {
    beta2 = fitStage2(oof);
    console.error(`  係数: 基礎モデル ${beta2[0].toFixed(3)} ／ 人気 ${beta2[1].toFixed(3)}（out-of-fold ${oof.length} レース）`);
  }
}

/* ---- 6. 評価 ---- */
function evaluate(rs, probFn, label) {
  let ll = 0, n = 0, top1 = 0, in3 = 0, cover = 0;
  for (const r of rs) {
    const p = probFn(r);
    if (!p) continue;
    n++;
    const wi = r.rows.findIndex(h => h.no === r.order[0]);
    ll += Math.log(Math.max(p[wi], 1e-9));
    const rank = p.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    if (rank[0] === wi) top1++;
    if (rank.slice(0, 3).includes(wi)) in3++;
    const t3 = r.order.slice(0, 3).map(no => r.rows.findIndex(h => h.no === no));
    if (t3.every(i => rank.slice(0, 3).includes(i))) cover++;
  }
  if (!n) { console.error(`${label.padEnd(22)} 対象レースなし`); return { label, races: 0 }; }
  const o = { label, races: n, logloss: +(-ll / n).toFixed(4), top1: +(top1 / n).toFixed(4),
    winnerInTop3: +(in3 / n).toFixed(4), top3Exact: +(cover / n).toFixed(4) };
  console.error(`${label.padEnd(22)} n=${String(n).padStart(4)}  logloss ${o.logloss.toFixed(3)}  1着的中 ${(o.top1 * 100).toFixed(1)}%  上位3頭に勝ち馬 ${(o.winnerInTop3 * 100).toFixed(1)}%  3頭独占 ${(o.top3Exact * 100).toFixed(1)}%`);
  return o;
}
const pFinal = r => {
  const pf = pFund(r), pp = pPublic(r);
  if (!beta2 || !pp) return null;
  return softmax(pf.map((x, i) => beta2[0] * Math.log(x) + beta2[1] * Math.log(pp[i])));
};
console.error('\n=== 検証データ（' + SPLIT + ' 以降）');
const metrics = {
  train: evaluate(train, pFund, '第1段 学習データ'),
  fund: evaluate(test, pFund, '第1段 オッズなし'),
  pub: evaluate(test.filter(pPublic), pPublic, '単勝人気だけ'),
  final: evaluate(test.filter(pPublic), pFinal, '第2段 合成'),
  joint: betaJ ? evaluate(test.filter(pPublic), pJoint, 'joint（市場つき）') : null,
};

/* ---- 6b. 2着・3着の段階モデル（ボートと同じ考え方）----
   PL は1着の強さを2着・3着にも同じ式で使う。実際は「勝った馬との関係」（強さの差・序盤位置の差・枠の近さ・人気の差）で
   2着の分布が変わるので、勝者 w を所与にした条件付きロジットを別に学習する。3着は 1・2着を所与に。
   U は基礎モデル（オッズなし）の値。市場の差（mkt）はオッズがあるときだけ入り、無ければ 0 */
const STAGE2F = ['uDiff', 'u', 'eposDiff', 'gateNear', 'mktDiff'];
const STAGE3F = ['uDiffW', 'uDiffS', 'u', 'eposDiff', 'gateNear', 'mktDiff'];
const uBase = r => r.rows.map(h => { let s = 0; for (let k = 0; k < D; k++) s += beta[k] * h.v[k]; return s; });
const st2x = (r, U, w, i) => [U[i] - U[w], U[i], r.rows[i].x.epos - r.rows[w].x.epos, Math.abs((r.rows[i].gate || 4) - (r.rows[w].gate || 4)) <= 1 ? 1 : 0, r.rows[i].mkt - r.rows[w].mkt];
const st3x = (r, U, w, s2, i) => [U[i] - U[w], U[i] - U[s2], U[i], r.rows[i].x.epos - r.rows[w].x.epos, Math.abs((r.rows[i].gate || 4) - (r.rows[w].gate || 4)) <= 1 ? 1 : 0, r.rows[i].mkt - r.rows[w].mkt];
function fitStage(rows, nf, label) {
  const b = new Float64Array(nf), m = new Float64Array(nf), v = new Float64Array(nf), g = new Float64Array(nf);
  for (let ep = 1; ep <= 400; ep++) {
    g.fill(0); let ll = 0;
    for (const { X, y } of rows) {
      const u = X.map(x => { let s = 0; for (let k = 0; k < nf; k++) s += b[k] * x[k]; return s; });
      const mx = Math.max(...u); const e = u.map(x => Math.exp(x - mx)); const z = e.reduce((a, c) => a + c, 0);
      ll += u[y] - mx - Math.log(z);
      for (let k = 0; k < nf; k++) { let ex = 0; for (let i = 0; i < X.length; i++) ex += (e[i] / z) * X[i][k]; g[k] += X[y][k] - ex; }
    }
    for (let k = 0; k < nf; k++) { g[k] = g[k] / rows.length - 1e-3 * b[k]; m[k] = 0.9 * m[k] + 0.1 * g[k]; v[k] = 0.999 * v[k] + 0.001 * g[k] * g[k]; b[k] += 0.05 * (m[k] / (1 - 0.9 ** ep)) / (Math.sqrt(v[k] / (1 - 0.999 ** ep)) + 1e-8); }
    if (ep % 100 === 0) console.error(`    ${label} ep${ep} 対数尤度/行 ${(ll / rows.length).toFixed(4)}`);
  }
  return Array.from(b);
}
let stage = null;
if (DO_STAGE) {
  console.error('2着・3着の段階モデルを当てはめ中…');
  const rows2 = [], rows3 = [];
  for (const r of train) {
    const U = uBase(r);
    const idx = new Map(r.rows.map((h, i) => [h.no, i]));
    const w = idx.get(r.order[0]), s2 = idx.get(r.order[1]), t3 = idx.get(r.order[2]);
    if (w == null || s2 == null || t3 == null) continue;
    const c2 = r.rows.map((_, i) => i).filter(i => i !== w);
    rows2.push({ X: c2.map(i => st2x(r, U, w, i)), y: c2.indexOf(s2) });
    const c3 = c2.filter(i => i !== s2);
    rows3.push({ X: c3.map(i => st3x(r, U, w, s2, i)), y: c3.indexOf(t3) });
  }
  const b2 = fitStage(rows2, STAGE2F.length, '2着'), b3 = fitStage(rows3, STAGE3F.length, '3着');
  console.error('  2着の係数: ' + STAGE2F.map((k, i) => `${k} ${b2[i].toFixed(3)}`).join(' / '));
  console.error('  3着の係数: ' + STAGE3F.map((k, i) => `${k} ${b3[i].toFixed(3)}`).join(' / '));
  stage = { t2: { feats: STAGE2F, beta: b2.map(v => +v.toFixed(4)) }, t3: { feats: STAGE3F, beta: b3.map(v => +v.toFixed(4)) } };

  /* 検証：真の1着を所与にした2着の logloss と、三連複「上位3頭」の的中（Harville と段階モデルで比べる。1着の確率は同じものを使う） */
  const dot = (b, x) => { let s = 0; for (let k = 0; k < b.length; k++) s += b[k] * x[k]; return s; };
  const soft = v => { const mx = Math.max(...v); const e = v.map(x => Math.exp(x - mx)); const z = e.reduce((a, c) => a + c, 0); return e.map(x => x / z); };
  function triProbs(r, p1, U, useStage) {
    const n = r.rows.length, tri = new Map();
    for (let w = 0; w < n; w++) {
      const c2 = r.rows.map((_, i) => i).filter(i => i !== w);
      let q2;
      if (useStage) q2 = soft(c2.map(i => dot(b2, st2x(r, U, w, i)))); else { const z = c2.reduce((a, i) => a + p1[i], 0); q2 = c2.map(i => p1[i] / z); }
      c2.forEach((s2, k) => {
        const c3 = c2.filter(i => i !== s2);
        let q3;
        if (useStage) q3 = soft(c3.map(i => dot(b3, st3x(r, U, w, s2, i)))); else { const z = c3.reduce((a, i) => a + p1[i], 0); q3 = c3.map(i => p1[i] / z); }
        c3.forEach((t3, j) => { const key = [w, s2, t3].sort((a, b) => a - b).join('-'); tri.set(key, (tri.get(key) || 0) + p1[w] * q2[k] * q3[j]); });
      });
    }
    return tri;
  }
  const ev = useStage => {
    let n = 0, ll2 = 0, hit3 = 0, hitTop3 = 0;
    for (const r of test) {
      /* 公平に比べる：1着の確率は両方とも「使う勝率」（joint → 第2段 → 基礎）。違いは2着・3着の出し方だけ */
      const p1 = pJoint(r) || pFinal(r) || pFund(r), U = uBase(r);
      const idx = new Map(r.rows.map((h, i) => [h.no, i]));
      const w = idx.get(r.order[0]), s2 = idx.get(r.order[1]), t3 = idx.get(r.order[2]);
      if (w == null || s2 == null || t3 == null) continue;
      n++;
      const c2 = r.rows.map((_, i) => i).filter(i => i !== w);
      const q2 = useStage ? soft(c2.map(i => dot(b2, st2x(r, U, w, i)))) : (() => { const z = c2.reduce((a, i) => a + p1[i], 0); return c2.map(i => p1[i] / z); })();
      ll2 -= Math.log(Math.max(1e-9, q2[c2.indexOf(s2)]));
      const tri = triProbs(r, p1, U, useStage);
      const best = [...tri].sort((a, b) => b[1] - a[1]);
      const truth = [w, s2, t3].sort((a, b) => a - b).join('-');
      if (best[0] && best[0][0] === truth) hit3++;
      if (best.slice(0, 3).some(x => x[0] === truth)) hitTop3++;
    }
    if (!n) return { n: 0, ll2: null, sanpuku1: null, sanpukuTop3: null };
    return { n, ll2: +(ll2 / n).toFixed(4), sanpuku1: +(hit3 / n).toFixed(4), sanpukuTop3: +(hitTop3 / n).toFixed(4) };
  };
  stage.test = { harville: ev(false), staged: ev(true) };
  for (const [k, o] of Object.entries(stage.test)) if (o.n) console.error(`  ${k === 'harville' ? 'Harville   ' : '段階モデル '}: 2着logloss ${o.ll2}／三連複 本線 ${(o.sanpuku1 * 100).toFixed(1)}%／上位3点 ${(o.sanpukuTop3 * 100).toFixed(1)}%（${o.n}R）`);
}

/* ---- 7. 係数を人が読める形で ---- */
const coefs = FEATURES.map((k, i) => ({ f: k, beta: +beta[i].toFixed(4), perSD: +beta[i].toFixed(4) }))
  .sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));
console.error('\n=== 効いている特徴量（標準化1つぶんの対数オッズ）');
coefs.slice(0, 14).forEach(c => console.error(`  ${c.f.padEnd(10)} ${c.beta >= 0 ? '+' : ''}${c.beta}`));

writeJSON(process.env.NK_FIT_OUT || 'data/nankan/model.json', {
  builtAt: new Date().toISOString(), db: DBFILE, split: SPLIT, l2: L2,
  features: FEATURES, mean, sd, beta: Array.from(beta), beta2, betaJ, stage, metrics, coefs,
  trainRaces: train.length, testRaces: test.length,
});
