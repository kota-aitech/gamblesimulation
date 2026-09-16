/* 南関の 2着・3着の段階モデル（fit_model.mjs の stage）から、馬連・三連複・馬単・三連単の確率を出す。
   1着の確率 p1 は「使うモデル」（基礎／第2段／joint）のもの、2着・3着の条件付き確率は基礎モデルの U と
   勝者との関係（強さの差・序盤位置の差・枠の近さ・市場の差）で決める。stage が無ければ Harville（p1 の再正規化）。
   式は fit_model.mjs の st2x / st3x と同じでなければならない（こちらを変えたら向こうも）。
   rows[i] = { x:{epos}, gate, mkt }（mkt はオッズが無ければ 0） */
const dot = (b, x) => { let s = 0; for (let k = 0; k < b.length; k++) s += b[k] * x[k]; return s; };
const soft = v => { const mx = Math.max(...v); const e = v.map(x => Math.exp(x - mx)); const z = e.reduce((a, c) => a + c, 0); return e.map(x => x / z); };
export const st2x = (rows, U, w, i) => [U[i] - U[w], U[i], (rows[i].x.epos ?? 0.5) - (rows[w].x.epos ?? 0.5), Math.abs((rows[i].gate || 4) - (rows[w].gate || 4)) <= 1 ? 1 : 0, (rows[i].mkt || 0) - (rows[w].mkt || 0)];
export const st3x = (rows, U, w, s, i) => [U[i] - U[w], U[i] - U[s], U[i], (rows[i].x.epos ?? 0.5) - (rows[w].x.epos ?? 0.5), Math.abs((rows[i].gate || 4) - (rows[w].gate || 4)) <= 1 ? 1 : 0, (rows[i].mkt || 0) - (rows[w].mkt || 0)];
const sk = a => a.slice().sort((x, y) => x - y).join('-');

/* 1〜3着の並びの確率をぜんぶ足し上げる（16頭で 3,360 通り）。
   戻り値：umaren（'i-j' 添字の昇順）・umatan（'i-j'）・sanpuku（'i-j-k' 昇順）・santan・top3（3着内確率）*/
export function raceCombos(p1, U, rows, stage) {
  const n = p1.length;
  const umaren = new Map(), umatan = new Map(), sanpuku = new Map(), santan = new Map(), top3 = new Array(n).fill(0);
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (let w = 0; w < n; w++) {
    if (p1[w] <= 0) continue;
    const c2 = []; for (let i = 0; i < n; i++) if (i !== w) c2.push(i);
    let q2;
    if (stage) q2 = soft(c2.map(i => dot(stage.t2.beta, st2x(rows, U, w, i))));
    else { const z = c2.reduce((a, i) => a + p1[i], 0) || 1; q2 = c2.map(i => p1[i] / z); }
    c2.forEach((s, k) => {
      const ps = p1[w] * q2[k];
      add(umatan, `${w}-${s}`, ps); add(umaren, sk([w, s]), ps);
      const c3 = c2.filter(i => i !== s);
      let q3;
      if (stage) q3 = soft(c3.map(i => dot(stage.t3.beta, st3x(rows, U, w, s, i))));
      else { const z = c3.reduce((a, i) => a + p1[i], 0) || 1; q3 = c3.map(i => p1[i] / z); }
      c3.forEach((t, j) => { const p = ps * q3[j]; add(santan, `${w}-${s}-${t}`, p); add(sanpuku, sk([w, s, t]), p); top3[t] += p; });
      top3[s] += ps;
    });
    top3[w] += p1[w];
  }
  return { umaren, umatan, sanpuku, santan, top3: top3.map(v => Math.min(1, v)) };
}
/* 基礎モデルの U と、市場の対数確率（レース内で中心化） */
export function baseU(MDL, f) {
  const { mean, sd, beta, features } = MDL;
  return f.rows.map(h => features.reduce((s, k, i) => s + beta[i] * ((h.x[k] - mean[k]) / sd[k]), 0));
}
export function mktOf(pp) {
  if (!pp) return null;
  const lg = pp.map(x => Math.log(Math.max(x, 1e-9)));
  const m = lg.reduce((a, b) => a + b, 0) / lg.length;
  return lg.map(x => x - m);
}
/* joint（市場つき）の勝率。betaJ が無い・オッズが無いときは null */
export function jointP(MDL, f, mkt) {
  if (!MDL.betaJ || !mkt) return null;
  const { mean, sd, betaJ, features } = MDL;
  const D = features.length;
  const u = f.rows.map((h, i) => features.reduce((s, k, j) => s + betaJ[j] * ((h.x[k] - mean[k]) / sd[k]), 0) + betaJ[D] * mkt[i]);
  return soft(u);
}

/* ---- 1レースぶんの予想をまとめて出す（build_marks / build_results / race_pick / backtest で共用。別式を作らない）----
   MDL: model.json、f: featurize の戻り値、tan: 単勝オッズの表（{馬番:{odds}}）か null、keepNos: 対象の馬番（取消・発売中止を除いた集合）
   戻り値: { nos, rows, U（基礎の強さ）, pFund, pm（市場）, p（使う勝率：joint → 第2段 → 基礎 の順）, src, combos } */
export function predictRace(MDL, f, tan = null, keepNos = null) {
  let rows = keepNos ? f.rows.filter(h => keepNos.includes(h.no)) : f.rows;
  if (rows.length < 2) return null;
  const U = baseU(MDL, { rows });
  const pFund = soft(U);
  let pm = null;
  if (tan) {
    const o = rows.map(h => (tan[h.no] || {}).odds);
    if (o.every(x => x > 0)) { const inv = o.map(x => 1 / x), z = inv.reduce((a, b) => a + b, 0); pm = inv.map(x => x / z); }
  }
  const mkt = mktOf(pm);
  rows = rows.map((h, i) => ({ ...h, mkt: mkt ? mkt[i] : 0 }));
  let p = pFund, src = 'base';
  if (pm && MDL.betaJ) { p = jointP(MDL, { rows }, mkt); src = 'joint'; }
  else if (pm && MDL.beta2) { p = soft(pFund.map((x, i) => MDL.beta2[0] * Math.log(Math.max(x, 1e-9)) + MDL.beta2[1] * Math.log(pm[i]))); src = 'blend'; }
  const combos = raceCombos(p, U, rows, MDL.stage || null);
  return { nos: rows.map(h => h.no), rows, U, pFund, pm, mkt, p, src, combos };
}
