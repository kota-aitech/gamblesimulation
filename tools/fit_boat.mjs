/* 条件付きロジット（Plackett–Luce）で 1〜3着の並びを当てはめる。Node 標準のみ。
       U_i = β・x_i,   P(i が1着) = exp(U_i) / Σ_j exp(U_j)
   南関側と同じ2段構成。
     第1段 … オッズを使わない基礎モデル
     第2段 … log p_基礎 と log p_人気（オッズ）を合成。第1項の係数が
              「市場に何を足せているか」の答え。0 に近ければ自前情報に価値がない
   pre（番組表だけ）と ex（直前情報あり）の2レベルを同時に出す。
     BT_FIT_SPLIT … 学習と検証を切る日付（既定 20260601）
   出力: data/boat/model.json */
import { readJSON, writeJSON } from './lib/bt.mjs';
import { loadRaces } from './lib/bload.mjs';
import { FEATS, NF, raceFeatures } from './lib/bfeat.mjs';
import { utilities, plWin, fitTau } from './lib/bpl.mjs';

const SPLIT = process.env.BT_FIT_SPLIT || '20260601';
/* BT_FIT_BETA=<model.json> を渡すと β はそこから読み、Adam を回さずに温度と検証だけやり直す
   （β を変えずに較正だけ足すとき用。全体で数分） */
const REUSE = process.env.BT_FIT_BETA ? readJSON(process.env.BT_FIT_BETA) : null;
const EPOCH = Number(process.env.BT_FIT_EPOCH || 60);
const L2 = Number(process.env.BT_FIT_L2 || 2e-4);
const LR = Number(process.env.BT_FIT_LR || 0.05);
const DB = readJSON(process.env.BT_FIT_DB || 'data/boat/index.json');
/* 切り分け用。BT_FIT_DROP に特徴量名をカンマ区切りで書くと、その列を 0 にして当てはめる。
   「足した特徴量が本当に効いているか」は、外して同じ手続きで比べないと分からない。 */
const DROP = new Set((process.env.BT_FIT_DROP || '').split(',').map(s => s.trim()).filter(Boolean));
const LEVELS = (process.env.BT_FIT_LEVELS || 'pre,ex').split(',').map(s => s.trim()).filter(Boolean);
/* 早期終了：学習データの末尾 ES 割（日付順）を切り出して、5エポックごとの logloss が最良の β を採る。
   「10エポック時点のほうが収束後より良い」ことがあったので、学習に寄りすぎるのを止める。BT_FIT_ES=0 で無効 */
const ES = process.env.BT_FIT_ES === '0' ? 0 : Number(process.env.BT_FIT_ES || 0.15);
const ST = readJSON('data/boat/stadium.json');

/* ---- レースを組み立てる（lib/bload.mjs が K と B を突き合わせ、
   モーターの世代と2連率の伸びを付ける）---- */
console.error('データを読む…');
let races = loadRaces({ base: DB.base });
console.error(`  ${races.length} レース（${races[0].date} 〜 ${races.at(-1).date}）`);

let tr = races.filter(r => r.date < SPLIT), te = races.filter(r => r.date >= SPLIT);
console.error(`  学習 ${tr.length}R（〜${SPLIT}）／検証 ${te.length}R`);
const META = { train: tr.length, test: te.length, from: races[0].date, to: races.at(-1).date };

/* ---- Plackett–Luce ---- */
const DROPI = [...DROP].map(k => FEATS.indexOf(k)).filter(i => i >= 0);
/* メモリ：この Mac は RAM 8GB。レースのオブジェクト（16万×6艇）を持ったままだとスワップに落ちて数倍遅くなるので、
   先に全レベルぶんを Float32 の行列に詰めてから元の配列を捨てる（1レベル 250MB ほど） */
function pack(rs, level) {
  return rs.map(r => {
    const X = raceFeatures(r, r.boats, DB, ST, { level });
    if (DROPI.length) for (const x of X) for (const i of DROPI) x[i] = 0;
    return { X: X.map(x => Float32Array.from(x)), order: r.order };
  });
}
/* レースを1つずつ全レベルの行列にしてから、そのレースのオブジェクトを捨てる（ピークを抑える） */
const PACKED = Object.fromEntries(LEVELS.map(l => [l, { tr: [], te: [] }]));
for (const r of races) {
  const dst = r.date < SPLIT ? 'tr' : 'te';
  for (const level of LEVELS) {
    const X = raceFeatures(r, r.boats, DB, ST, { level });
    if (DROPI.length) for (const x of X) for (const i of DROPI) x[i] = 0;
    PACKED[level][dst].push({ X: X.map(x => Float32Array.from(x)), order: r.order });
  }
  r.boats = null;
}
races = tr = te = null;
console.error(`  行列を作った（${LEVELS.join('/')}）`);
/* 1〜3着の並びの対数尤度と勾配 */
function gradOne(X, order, beta, g) {
  const n = X.length;
  const u = X.map(x => { let s = 0; for (let k = 0; k < NF; k++) s += beta[k] * x[k]; return s; });
  const live = new Set(X.map((_, i) => i));
  let ll = 0;
  for (const win of order) {
    const idx = [...live];
    const m = Math.max(...idx.map(i => u[i]));
    const e = idx.map(i => Math.exp(u[i] - m));
    const s = e.reduce((a, b) => a + b, 0);
    ll += u[win] - m - Math.log(s);
    for (let k = 0; k < NF; k++) {
      let exp = 0;
      idx.forEach((i, j) => { exp += (e[j] / s) * X[i][k]; });
      g[k] += X[win][k] - exp;
    }
    live.delete(win);
  }
  void n;
  return ll;
}
function fit(data, label, val = null) {
  const beta = new Float64Array(NF);
  let best = null, bestLL = Infinity, bestEp = 0;
  const m = new Float64Array(NF), v = new Float64Array(NF);
  const g = new Float64Array(NF);
  for (let ep = 1; ep <= EPOCH; ep++) {
    g.fill(0);
    let ll = 0;
    for (const d of data) ll += gradOne(d.X, d.order, beta, g);
    for (let k = 0; k < NF; k++) g[k] = g[k] / data.length - L2 * beta[k];
    for (let k = 0; k < NF; k++) {
      m[k] = 0.9 * m[k] + 0.1 * g[k];
      v[k] = 0.999 * v[k] + 0.001 * g[k] * g[k];
      const mh = m[k] / (1 - Math.pow(0.9, ep)), vh = v[k] / (1 - Math.pow(0.999, ep));
      beta[k] += LR * mh / (Math.sqrt(vh) + 1e-8);
    }
    if (val && ep % 5 === 0) {
      const v = evaluate(val, beta).logloss;
      if (v < bestLL) { bestLL = v; bestEp = ep; best = Float64Array.from(beta); }
      if (ep % 20 === 0) console.error(`    ${label} ep${ep} 対数尤度/R ${(ll / data.length).toFixed(4)}　検証用 logloss ${v.toFixed(4)}（最良 ep${bestEp} ${bestLL.toFixed(4)}）`);
    } else if (ep % 20 === 0) console.error(`    ${label} ep${ep} 対数尤度/R ${(ll / data.length).toFixed(4)}`);
  }
  if (best) { console.error(`    ${label}: 早期終了 → ep${bestEp} の β を採用（検証用 logloss ${bestLL.toFixed(4)}）`); return best; }
  return beta;
}
function evaluate(data, beta, tau = [1, 1]) {
  let ll = 0, hit1 = 0, in3 = 0, n = 0;
  const cal = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const d of data) {
    const p = plWin(utilities(d.X, beta), tau[0]);
    const w = d.order[0];
    ll -= Math.log(Math.max(1e-9, p[w]));
    const rank = p.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    if (rank[0] === w) hit1++;
    if (rank.slice(0, 3).includes(w)) in3++;
    n++;
    p.forEach((v, i) => { const b = cal[Math.min(9, Math.floor(v * 10))]; b.p += v; b.y += i === w ? 1 : 0; b.n++; });
  }
  return { logloss: ll / n, hit1: hit1 / n, in3: in3 / n, n, cal: cal.map(b => b.n ? { p: +(b.p / b.n).toFixed(3), y: +(b.y / b.n).toFixed(3), n: b.n } : null) };
}

const out = { meta: { es: ES, l2: L2, epoch: EPOCH, drop: [...DROP], built: new Date().toISOString().slice(0, 10), split: SPLIT, feats: FEATS, train: META.train, test: META.test, from: META.from, to: META.to } };
for (const level of LEVELS) {
  console.error(`第1段（${level}）を当てはめる…`);
  const { tr: trd, te: ted } = PACKED[level];
  let beta;
  if (REUSE) {
    const feats = REUSE.meta.feats, src = REUSE[level].beta;
    beta = new Float64Array(NF);
    FEATS.forEach((k, i) => { const j = feats.indexOf(k); if (j < 0) throw new Error(`${process.env.BT_FIT_BETA} に ${k} が無い`); beta[i] = src[j]; });
    console.error(`  β は ${process.env.BT_FIT_BETA} を再利用`);
  } else if (ES > 0) {
    const cut = Math.floor(trd.length * (1 - ES));                 // 学習は日付順なので末尾が新しい
    beta = fit(trd.slice(0, cut), level, trd.slice(cut));
  } else beta = fit(trd, level);
  /* 着順の段階ごとの温度（lib/bpl.mjs）。学習データで決め、検証は温度つきで測る */
  const raw = evaluate(ted, beta);
  const tau = fitTau(trd.map(d => ({ U: utilities(d.X, beta), order: d.order })));
  const ev = evaluate(ted, beta, tau);
  out[level] = { beta: [...beta].map(v => +v.toFixed(4)), tau, test: ev, testRaw: { logloss: raw.logloss, hit1: raw.hit1, in3: raw.in3, cal: raw.cal } };
  console.error(`  ${level}: 温度 τ1 ${tau[0]}／τ2 ${tau[1]}（較正前 logloss ${raw.logloss.toFixed(3)}）`);
  console.error(`  ${level}: logloss ${ev.logloss.toFixed(3)}／1着的中 ${(ev.hit1 * 100).toFixed(1)}%／上位3艇に勝ち艇 ${(ev.in3 * 100).toFixed(1)}%`);
  console.error('  較正（予測→実際）: ' + ev.cal.filter(Boolean).map(b => `${(b.p * 100).toFixed(0)}→${(b.y * 100).toFixed(0)}`).join(' '));
  console.error('  係数（絶対値の大きい順）: ' + [...beta].map((v, i) => [FEATS[i], v]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' / '));
}
/* 参考：進入コースだけ（＝枠なり前提の基準）でどこまで当たるか */
if (LEVELS.includes('ex')) {
  const ted = PACKED.ex.te;
  const b = new Float64Array(NF); b[FEATS.indexOf('cz')] = 1;
  out.courseOnly = evaluate(ted, b);
  console.error(`  コースだけ: logloss ${out.courseOnly.logloss.toFixed(3)}／1着的中 ${(out.courseOnly.hit1 * 100).toFixed(1)}%／上位3艇 ${(out.courseOnly.in3 * 100).toFixed(1)}%`);
}
writeJSON(process.env.BT_FIT_OUT || 'data/boat/model.json', out);
