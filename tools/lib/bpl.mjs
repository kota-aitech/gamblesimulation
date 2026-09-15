/* Plackett–Luce の確率計算と、着順の段階ごとの温度（スケール）の較正。
   fit_boat / backtest_boat / build_boat / check_before が必ずここを通る（式を二重に持たない）。

   なぜ温度が要るか：
   1〜3着の並びを同時に当てはめると、1号艇のように「勝つか沈むか」の艇は2・3着の尤度で
   強さが引き下げられ、1着確率が一貫して低く出る（検証で 1コース 予測45%／実際54.5%、
   本命側は低く・穴側は高く）。そこで β は共通のまま、
     1着     … P(i) ∝ exp(τ1・U_i)
     2・3着  … P(j | 残り) ∝ exp(τ2・U_j)
   の τ1・τ2 を学習データの尤度で別々に決める。1次元の凹関数なので黄金分割で足りる。 */

export function utilities(X, beta) {
  const NF = beta.length;
  return X.map(x => { let s = 0; for (let k = 0; k < NF; k++) s += beta[k] * x[k]; return s; });
}

/* 1着の確率（温度 t） */
export function plWin(U, t = 1) {
  const m = Math.max(...U);
  const e = U.map(u => Math.exp(t * (u - m)));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / s);
}

/* 6艇120通りを厳密に足し上げる。tau=[τ1, τ2] */
export function plackettLuce(U, tau = [1, 1]) {
  const n = U.length, m = Math.max(...U);
  const e1 = U.map(u => Math.exp(tau[0] * (u - m))), S1 = e1.reduce((a, b) => a + b, 0);
  const e2 = U.map(u => Math.exp(tau[1] * (u - m))), S2 = e2.reduce((a, b) => a + b, 0);
  const p1 = e1.map(v => v / S1), p2 = Array(n).fill(0), p3 = Array(n).fill(0), tri = [];
  for (let a = 0; a < n; a++) {
    const pa = p1[a];
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      const pb = e2[b] / (S2 - e2[a]);
      p2[b] += pa * pb;
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue;
        const p = pa * pb * e2[c] / (S2 - e2[a] - e2[b]);
        p3[c] += p;
        tri.push([a, b, c, p]);
      }
    }
  }
  tri.sort((x, y) => y[3] - x[3]);
  return { p1, top2: p1.map((v, i) => v + p2[i]), top3: p1.map((v, i) => v + p2[i] + p3[i]), tri };
}

/* 2連単（1着→2着）の確率。[a, b, p] を確率の高い順に返す */
export function pairProbs(U, tau = [1, 1]) {
  const n = U.length, m = Math.max(...U);
  const e1 = U.map(u => Math.exp(tau[0] * (u - m))), S1 = e1.reduce((a, b) => a + b, 0);
  const e2 = U.map(u => Math.exp(tau[1] * (u - m))), S2 = e2.reduce((a, b) => a + b, 0);
  const out = [];
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (a !== b) out.push([a, b, (e1[a] / S1) * e2[b] / (S2 - e2[a])]);
  return out.sort((x, y) => y[2] - x[2]);
}

/* 温度の当てはめ。data: [{U, order}] */
function golden(f, lo, hi, iters = 40) {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi, c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}
export function fitTau(data) {
  const ll1 = t => { let s = 0; for (const { U, order } of data) { const p = plWin(U, t); s += Math.log(Math.max(1e-12, p[order[0]])); } return s; };
  const ll2 = t => {
    let s = 0;
    for (const { U, order } of data) {
      const live = new Set(U.map((_, i) => i)); live.delete(order[0]);
      for (const w of order.slice(1)) {
        const idx = [...live], m = Math.max(...idx.map(i => U[i]));
        const e = idx.map(i => Math.exp(t * (U[i] - m))), z = e.reduce((a, b) => a + b, 0);
        s += t * (U[w] - m) - Math.log(z);
        live.delete(w);
      }
    }
    return s;
  };
  const t1 = golden(ll1, 0.5, 3), t2 = golden(ll2, 0.3, 3);
  return [+t1.toFixed(3), +t2.toFixed(3)];
}

/* ---- 2着・3着の段階モデル ----
   1着は第1段のモデル（温度 τ1）、2着は「勝った艇との関係」で別に学習した条件付きロジット、3着も同様。
   1コースが逃げれば2着は2・3コースの差し、まくりが決まれば2着は外や残った内、という構造を
   PL の同じ式では表せないので分ける。特徴量（lib/bpl.mjs のここで一元管理。fit_boat_stage.mjs も同じ関数を使う）：
     2着候補 i（勝者 w）: cz2＝P(2着コース | 1着コース) の対数オッズ（学習データの表）、u＝第1段の強さ、
                        adjIn/adjOut＝勝者のすぐ内／外、stDiff・rDiff・exDiff＝勝者との差
     3着候補 i（1着 w・2着 s）: cz3＝P(3着コース | 1着コース)、u、adjW・adjS＝1着・2着に隣接、勝者との差 */
export const STAGE2 = ['cz2', 'u', 'adjIn', 'adjOut', 'stDiff', 'rDiff', 'exDiff'];
export const STAGE3 = ['cz3', 'u', 'adjW', 'adjS', 'stDiff', 'rDiff', 'exDiff'];
const lg = p => Math.log(Math.max(1e-4, p) / Math.max(1e-4, 1 - p));
export function stage2X(ctx, U, w, i, T2) {
  const cw = ctx[w].c, ci = ctx[i].c;
  return [lg(T2[cw - 1][ci - 1]) - lg(1 / 5), U[i], ci === cw - 1 ? 1 : 0, ci === cw + 1 ? 1 : 0, ctx[i].st - ctx[w].st, ctx[i].r - ctx[w].r, ctx[i].ex - ctx[w].ex];
}
export function stage3X(ctx, U, w, s, i, T3) {
  const cw = ctx[w].c, cs = ctx[s].c, ci = ctx[i].c;
  return [lg(T3[cw - 1][ci - 1]) - lg(1 / 4), U[i], Math.abs(ci - cw) === 1 ? 1 : 0, Math.abs(ci - cs) === 1 ? 1 : 0, ctx[i].st - ctx[w].st, ctx[i].r - ctx[w].r, ctx[i].ex - ctx[w].ex];
}
const dot = (b, x) => { let s = 0; for (let k = 0; k < b.length; k++) s += b[k] * x[k]; return s; };
const softmax = v => { const m = Math.max(...v); const e = v.map(x => Math.exp(x - m)); const s = e.reduce((a, b) => a + b, 0); return e.map(x => x / s); };
/* 段階モデルで6艇120通り。M = model.stage（{t2:{beta,table}, t3:{beta,table}}）。無ければ plackettLuce と同じ形を返す */
export function stagedPL(U, tau1, ctx, M) {
  const n = U.length;
  const p1 = plWin(U, tau1);
  const p2 = Array(n).fill(0), p3 = Array(n).fill(0), tri = [];
  for (let w = 0; w < n; w++) {
    const cand = [...Array(n).keys()].filter(i => i !== w);
    const q2 = softmax(cand.map(i => dot(M.t2.beta, stage2X(ctx, U, w, i, M.t2.table))));
    cand.forEach((s, k) => {
      const ps = p1[w] * q2[k];
      p2[s] += ps;
      const c3 = cand.filter(i => i !== s);
      const q3 = softmax(c3.map(i => dot(M.t3.beta, stage3X(ctx, U, w, s, i, M.t3.table))));
      c3.forEach((t, j) => { const p = ps * q3[j]; p3[t] += p; tri.push([w, s, t, p]); });
    });
  }
  tri.sort((x, y) => y[3] - x[3]);
  return { p1, top2: p1.map((v, i) => v + p2[i]), top3: p1.map((v, i) => v + p2[i] + p3[i]), tri };
}
export function stagedPairs(tri, n = 6) {
  const m = new Map();
  for (const [a, b, , p] of tri) { const k = a * n + b; m.set(k, (m.get(k) || 0) + p); }
  return [...m].map(([k, p]) => [Math.floor(k / n), k % n, p]).sort((x, y) => y[2] - x[2]);
}

/* 共通の入口：model.stage があれば段階モデル、無ければ PL（温度つき）。戻り値の形は同じ（pairs も付ける） */
export function raceProbs(U, tau, ctx, stage) {
  if (stage && ctx) { const R = stagedPL(U, tau[0], ctx, stage); R.pairs = stagedPairs(R.tri, U.length); return R; }
  const R = plackettLuce(U, tau); R.pairs = pairProbs(U, tau); return R;
}
/* 6艇120通りを「a→b→c の辞書順」で並べた確率（千分率の整数）。boat.html の3D再生がここから標本を引く */
export function packTri(tri, n = 6) {
  const m = new Map(tri.map(([a, b, c, p]) => [a * 36 + b * 6 + c, p]));
  const out = [];
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) { if (b === a) continue; for (let c = 0; c < n; c++) { if (c === a || c === b) continue; out.push(Math.round((m.get(a * 36 + b * 6 + c) || 0) * 1000)); } }
  return out;
}
