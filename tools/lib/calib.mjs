/* 組（3連単など）の確率を市場と合成して較正する（2026-10-16）。ボート・競輪で共用。
   実戦の記録で、段位 S の「最良の買い目1点」がボート198R・競輪169Rで1本も当たらなかった。
   モデルは100倍を超える組の確率を2倍以上に見積もっており、期待値（確率×オッズ）が高い組ほどこのずれが大きい
   ＝ 期待値で選ぶと「当たらない大穴」ばかりが選ばれる。そこで
     p(組) ∝ p_モデル^a × p_市場^b      （p_市場 は オッズの逆数をその券種の全組で正規化したもの）
   の a・b を、締切前（またはそれに近い）オッズのあるレースで実際の着順の尤度を最大にして決める。
   南関の第2段（`0.192 × log(基礎) + 0.709 × log(人気)`）と同じ考え方を、組の確率でやるもの。
   a が 0 に近ければ「モデルは市場に何も足せていない」、b が 1 より大きければ市場の大穴は実際よりさらに来ない（大穴の買われすぎ）。 */

/* 1レースぶんの標本：lm/lq は各組の log 確率（同じ並び）、w は当たった組の位置 */
export function sampleOf(pm, pq, w) {
  const n = pm.length, lm = new Float64Array(n), lq = new Float64Array(n);
  for (let i = 0; i < n; i++) { lm[i] = Math.log(Math.max(pm[i], 1e-7)); lq[i] = Math.log(Math.max(pq[i], 1e-7)); }
  return { lm, lq, w };
}

/* 尤度・勾配・ヘッセ行列（2変数）。Σ が要るだけなので組の数が違うレースが混ざってよい */
function stats(S, a, b) {
  let ll = 0, ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
  for (const s of S) {
    const n = s.lm.length; let mx = -Infinity;
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) { z[i] = a * s.lm[i] + b * s.lq[i]; if (z[i] > mx) mx = z[i]; }
    let Z = 0, Em = 0, Eq = 0, Emm = 0, Emq = 0, Eqq = 0;
    for (let i = 0; i < n; i++) { const e = Math.exp(z[i] - mx); Z += e; Em += e * s.lm[i]; Eq += e * s.lq[i]; Emm += e * s.lm[i] ** 2; Emq += e * s.lm[i] * s.lq[i]; Eqq += e * s.lq[i] ** 2; }
    Em /= Z; Eq /= Z; Emm /= Z; Emq /= Z; Eqq /= Z;
    ll += z[s.w] - mx - Math.log(Z);
    ga += s.lm[s.w] - Em; gb += s.lq[s.w] - Eq;
    haa -= Emm - Em * Em; hab -= Emq - Em * Eq; hbb -= Eqq - Eq * Eq;
  }
  return { ll, ga, gb, haa, hab, hbb };
}

/* ニュートン法で a・b を求める（凹なので数回で収まる） */
export function fitMix(S, { a = 0.3, b = 0.7 } = {}) {
  for (let it = 0; it < 50; it++) {
    const t = stats(S, a, b), det = t.haa * t.hbb - t.hab * t.hab;
    if (!(det > 0)) break;
    const da = -(t.hbb * t.ga - t.hab * t.gb) / det, db = -(-t.hab * t.ga + t.haa * t.gb) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-6) break;
  }
  return { a, b };
}

/* 平均 logloss（当たった組の −log p）。a=1,b=0 ならモデルだけ、a=0,b=1 なら市場だけ */
export const logloss = (S, a, b) => -stats(S, a, b).ll / S.length;

/* 合成した確率（並びは pm・pq と同じ）。pq が無い（オッズ前）なら pm をそのまま返す */
export function mixProbs(pm, pq, mix) {
  if (!pq || !mix) return pm;
  const n = pm.length, z = new Float64Array(n); let mx = -Infinity, Z = 0;
  for (let i = 0; i < n; i++) { z[i] = mix.a * Math.log(Math.max(pm[i], 1e-7)) + mix.b * Math.log(Math.max(pq[i], 1e-7)); if (z[i] > mx) mx = z[i]; }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { out[i] = Math.exp(z[i] - mx); Z += out[i]; }
  for (let i = 0; i < n; i++) out[i] /= Z;
  return out;
}

/* オッズの辞書（組 → 倍率）から市場の確率（組 → 確率）。0・欠けは除く */
export function marketOf(odds) {
  let s = 0; const q = {};
  for (const [k, o] of Object.entries(odds || {})) if (o > 0) { q[k] = 1 / o; s += 1 / o; }
  if (!s) return null;
  for (const k in q) q[k] /= s;
  return q;
}

/* 締切8分前 → 確定のオッズの動き（2026-10-16）。
   払戻は確定オッズで決まるが、期待値は締切8分前のオッズで出している。当たった組について両者を比べると、
   **合成の確率が市場より高い組ほど確定までにオッズが下がる**（ボート：合成/市場が 1.28 以上の組は 0.76 倍、0.87 未満は 1.04 倍）。
   締切までに売れる情報（遅い買い）がモデルと同じ向きを向いていて、見つけた割安を市場が自分で埋めてしまう。
   そこで log(確定/T-8) = c + d1·log(p合成/p市場) + d2·log(T-8オッズ) を当たった組で当てはめ、期待値はこの「見込みの確定オッズ」で出す。
   rows … [{p, q, o, pay}]（当たった組の合成確率・市場確率・T-8オッズ・払戻(100円あたり)）。戻り値 [c, d1, d2] */
export function fitDrift(rows) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const x of rows) {
    if (!(x.pay > 0 && x.o > 0 && x.p > 0 && x.q > 0)) continue;
    const r = [1, Math.log(x.p / x.q), Math.log(x.o)], y = Math.log(x.pay / 100 / x.o);
    for (let i = 0; i < 3; i++) { b[i] += r[i] * y; for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; }
  }
  for (let i = 0; i < 3; i++) for (let k = i + 1; k < 3; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j < 3; j++) A[k][j] -= f * A[i][j]; b[k] -= f * b[i]; }
  const c = [0, 0, 0];
  for (let i = 2; i >= 0; i--) { let t = b[i]; for (let j = i + 1; j < 3; j++) t -= A[i][j] * c[j]; c[i] = t / A[i][i]; }
  return c.map(v => +v.toFixed(4));
}
/* 見込みの確定オッズ（drift が無ければそのまま） */
export const adjOdds = (o, p, q, drift) => !drift || !(o > 0) || !(p > 0) || !(q > 0) ? o : o * Math.exp(drift[0] + drift[1] * Math.log(p / q) + drift[2] * Math.log(o));

/* 標本の行 {keys, pm, pq, od, w, pay} から、当たった組の {p, q, o, pay}（fitDrift 用） */
export const driftRows = (rows, mix) => rows.filter(x => x.pay > 0).map(x => { const p = mixProbs(x.pm, x.pq, mix); return { p: p[x.w], q: x.pq[x.w], o: x.od[x.w], pay: x.pay }; });

/* 段位の検証（calib_boat / calib_keirin の共用）。pick(x) → {k, i(組の位置), ev} を tr の分布で S/A/B/C に分け、te で精算する。
   expHit＝確率で見込んだ的中数、expRoi＝ev の平均（見込みの回収率）、z＝(実際−見込みの払戻)/ばらつき */
export function gradeCheck(tr, te, pick, thresholdsOf, gradeOf) {
  const T = thresholdsOf(tr.map(x => pick(x)?.ev).filter(v => v != null)), G = {};
  for (const x of te) {
    const b = pick(x); if (!b) continue;
    const g = gradeOf(b.ev, T), hit = b.i === x.w, o = G[g] ||= { n: 0, hit: 0, ret: 0, ev: 0, exp: 0, vr: 0 };
    o.n++; o.hit += hit; o.ret += hit ? x.pay : 0; o.ev += b.ev; o.exp += b.p; o.vr += b.p * (b.oa ?? b.o) ** 2 - b.ev ** 2;
  }
  const out = {};
  for (const g of ['S', 'A', 'B', 'C']) if (G[g]) { const o = G[g]; out[g] = { n: o.n, hit: o.hit, expHit: +o.exp.toFixed(1), roi: +(o.ret / o.n / 100).toFixed(3), expRoi: +(o.ev / o.n).toFixed(3), sd: +(Math.sqrt(Math.max(0, o.vr)) / o.n).toFixed(3) }; }
  return { thresholds: T, grades: out };
}
