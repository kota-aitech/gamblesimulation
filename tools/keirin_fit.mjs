/* 競輪の条件付きロジット（Plackett–Luce）を当てはめる → data/keirin/model.json
   ばんえい・JRA と同じ作り：
     base  … オッズを使わない基礎モデル（lib/krfeat.mjs の特徴量）＋ 着順の段階ごとの温度（lib/bpl.mjs）
     joint … 市場の対数確率（3連単オッズから逆算した1着確率、mktLog）を特徴量に入れて同時に当てはめる（オッズの出たレース用）
     stage … 2着・3着の段階モデル（1着との同ライン・番手・ワンツーなど。lib/krfeat.mjs の stage2X / stage3X）。base と joint で別に持つ
   環境変数
     KR_FIT_SPLIT … 学習と検証を切る日付（既定 データの末尾20%＝10〜90日）
     KR_FIT_WARM  … 履歴の助走期間（既定 データの先頭15%＝14〜60日。この間は自前の指標を積むだけ）
     KR_FIT_EPOCH / KR_FIT_LR / KR_FIT_L2 / KR_FIT_DROP / KR_FIT_OUT */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON, addDays } from './lib/kr.mjs';
import { FEATURES, NF, MKT, loadRaces, buildAsOf, makeFeaturizer, stageCtx, stage2X, stage3X, STAGE2, STAGE3, combos } from './lib/krfeat.mjs';
import { utilities, plWin, fitTau } from './lib/bpl.mjs';


const EPOCH = Number(process.env.KR_FIT_EPOCH || 250), LR = Number(process.env.KR_FIT_LR || 0.05), L2 = Number(process.env.KR_FIT_L2 || 1e-2);
const W23 = Number(process.env.KR_FIT_W23 ?? 0);   // 2026-09-28 の比較（検証428R）：1→joint 1.330、0.3→1.305、0→1.288（人気だけ 1.291）
const DROP = new Set((process.env.KR_FIT_DROP || '').split(',').map(s => s.trim()).filter(Boolean));
const DROPI = [...DROP].map(k => FEATURES.indexOf(k)).filter(i => i >= 0);

console.error('レースを読む…');
const races = loadRaces(fs.readFileSync(path.join(ROOT, 'data/keirin/races.jsonl'), 'utf8'), {}, l => /"result":\{/.test(l));
const first = races[0].date, last = races.at(-1).date;
/* 既定の期間はデータの範囲から決める（取り込みを遡っている間も当て直せるように）：
   助走＝先頭の15%（14〜60日。自前の時点指標を積むだけ）、検証＝末尾の20%（10〜90日） */
const span = Math.round((Date.parse(`${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}`) - Date.parse(`${first.slice(0, 4)}-${first.slice(4, 6)}-${first.slice(6, 8)}`)) / 86400000);
const WARM = process.env.KR_FIT_WARM || addDays(first, Math.min(60, Math.max(14, Math.round(span * 0.15))));
const SPLIT = process.env.KR_FIT_SPLIT || addDays(last, -Math.min(90, Math.max(10, Math.round(span * 0.2))));
const ASOF = buildAsOf(races);
const featurize = makeFeaturizer(ASOF);
console.error(`  ${races.length}R（${first}〜${races.at(-1).date}）`);
const data = [];
for (const r of races) {
  if (r.date < WARM) continue;
  const f = featurize(r);
  if (!f || !f.order || f.order.some(i => i < 0)) continue;
  data.push({ raceId: f.raceId, date: f.date, X: f.rows.map(x => x.x), order: f.order, mkt: f.mkt, ctx: stageCtx(f), girls: f.race.girls, top: r.mktE3?.[0]?.[0] || null, nos: f.rows.map(x => x.no) });
}
const tr = data.filter(d => d.date < SPLIT), te = data.filter(d => d.date >= SPLIT);
console.error(`  学習 ${tr.length}R（${WARM}〜${SPLIT}）／検証 ${te.length}R`);
if (tr.length < Number(process.env.KR_FIT_MIN || 300)) { console.error('学習データが足りない'); process.exit(1); }

function gradOne(X, order, beta, g) {
  const u = utilities(X, beta);
  const live = new Set(X.map((_, i) => i));
  let ll = 0;
  order.forEach((win, st) => {
    /* 2着・3着は段階モデルで別に扱うので、第1段は1着を重く当てはめる（W23 が2・3着の重み） */
    const w = st === 0 ? 1 : W23;
    const idx = [...live], m = Math.max(...idx.map(i => u[i]));
    const e = idx.map(i => Math.exp(u[i] - m)), s = e.reduce((a, b) => a + b, 0);
    ll += w * (u[win] - m - Math.log(s));
    if (w) for (let k = 0; k < NF; k++) { let exp = 0; idx.forEach((i, j) => { exp += (e[j] / s) * X[i][k]; }); g[k] += w * (X[win][k] - exp); }
    live.delete(win);
  });
  return ll;
}
function fit(rows, drop = new Set()) {
  const beta = new Float64Array(NF), m = new Float64Array(NF), v = new Float64Array(NF), g = new Float64Array(NF);
  if (!drop.has(MKT)) beta[MKT] = 1;   // joint は「人気そのもの」から始める（0 からだと 250 エポックで市場に追いつかない）
  for (let ep = 1; ep <= EPOCH; ep++) {
    g.fill(0); let ll = 0;
    for (const d of rows) ll += gradOne(d.X, d.order, beta, g);
    for (let k = 0; k < NF; k++) {
      if (drop.has(k)) { beta[k] = 0; continue; }
      g[k] = g[k] / rows.length - (k === MKT ? 0 : L2) * beta[k];   // 市場の項は縮めない（縮めると人気だけより悪くなる）
      m[k] = 0.9 * m[k] + 0.1 * g[k]; v[k] = 0.999 * v[k] + 0.001 * g[k] * g[k];
      beta[k] += LR * (m[k] / (1 - 0.9 ** ep)) / (Math.sqrt(v[k] / (1 - 0.999 ** ep)) + 1e-8);
    }
    if (ep % 50 === 0) console.error(`    ep${ep} 対数尤度/R ${(ll / rows.length).toFixed(4)}`);
  }
  return beta;
}
/* 段階モデル：勝者を所与に2着（n−1択）、1・2着を所与に3着（n−2択）の条件付きロジット */
function fitStage(rows, betaU, K, xOf) {
  const b = new Float64Array(K), m = new Float64Array(K), v = new Float64Array(K), g = new Float64Array(K);
  const items = rows.map(d => { const U = utilities(d.X, betaU); return xOf(d, U); }).filter(Boolean);
  for (let ep = 1; ep <= 150; ep++) {
    g.fill(0);
    for (const { X, y } of items) {
      const s = X.map(x => { let t = 0; for (let k = 0; k < K; k++) t += b[k] * x[k]; return t; }), mx = Math.max(...s);
      const e = s.map(t => Math.exp(t - mx)), z = e.reduce((a, c) => a + c, 0);
      for (let k = 0; k < K; k++) { let ex = 0; X.forEach((x, j) => { ex += e[j] / z * x[k]; }); g[k] += X[y][k] - ex; }
    }
    for (let k = 0; k < K; k++) { g[k] = g[k] / items.length - 1e-3 * b[k]; m[k] = 0.9 * m[k] + 0.1 * g[k]; v[k] = 0.999 * v[k] + 0.001 * g[k] * g[k]; b[k] += 0.05 * (m[k] / (1 - 0.9 ** ep)) / (Math.sqrt(v[k] / (1 - 0.999 ** ep)) + 1e-8); }
  }
  return [...b].map(x => +x.toFixed(4));
}
const x2 = (d, U) => { const [w, s] = d.order; const cand = d.X.map((_, i) => i).filter(i => i !== w); return { X: cand.map(i => stage2X(d.ctx, U, w, i)), y: cand.indexOf(s) }; };
const x3 = (d, U) => { const [w, s, t] = d.order; const cand = d.X.map((_, i) => i).filter(i => i !== w && i !== s); return { X: cand.map(i => stage3X(d.ctx, U, w, s, i)), y: cand.indexOf(t) }; };

function evaluate(rows, beta, tau, { mktOnly = false, stage = null } = {}) {
  let ll = 0, hit1 = 0, in3 = 0, n = 0, e3h1 = 0, e3h5 = 0, e3h10 = 0, q3h1 = 0, ll2 = 0, n2 = 0;
  const cal = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const d of rows) {
    const U = mktOnly ? d.mkt.map(q => Math.log(Math.max(1e-6, q))) : utilities(d.X, beta);
    const p = mktOnly ? d.mkt : plWin(U, tau[0]);
    const w = d.order[0];
    ll -= Math.log(Math.max(1e-9, p[w]));
    const rank = p.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    if (rank[0] === w) hit1++; if (rank.slice(0, 3).includes(w)) in3++; n++;
    p.forEach((v, i) => { const b = cal[Math.min(9, Math.floor(v * 10))]; b.p += v; b.y += i === w ? 1 : 0; b.n++; });
    if (!mktOnly) {
      const C = combos(U, tau, d.ctx, stage, d.nos);
      const key = d.order.map(i => d.nos[i]).join('-'), keyQ = d.order.map(i => d.nos[i]).sort((a, b) => a - b).join('-');
      const ks = C.e3.map(x => x[0]);
      if (ks[0] === key) e3h1++; if (ks.slice(0, 5).includes(key)) e3h5++; if (ks.slice(0, 10).includes(key)) e3h10++;
      if (C.q3[0][0] === keyQ) q3h1++;
      /* 2着の logloss（勝者を所与に） */
      const pw = C.e2.filter(x => +x[0].split('-')[0] === d.nos[w]); const zs = pw.reduce((a, x) => a + x[1], 0);
      const hit = pw.find(x => +x[0].split('-')[1] === d.nos[d.order[1]]); if (hit && zs > 0) { ll2 -= Math.log(hit[1] / zs); n2++; }
    } else if (d.top) { const key = d.order.map(i => d.nos[i]).join('-'); if (d.top === key) e3h1++; }
  }
  const r4 = v => +v.toFixed(4);
  return { logloss: r4(ll / n), hit1: r4(hit1 / n), in3: r4(in3 / n), n, e3top1: r4(e3h1 / n), e3top5: r4(e3h5 / n), e3top10: r4(e3h10 / n), q3top1: r4(q3h1 / n), ll2: n2 ? r4(ll2 / n2) : null,
    cal: cal.map(b => b.n ? { p: +(b.p / b.n).toFixed(3), y: +(b.y / b.n).toFixed(3), n: b.n } : null) };
}
const coefs = beta => [...beta].map((v, i) => [FEATURES[i], +v.toFixed(3)]).filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
const pct = v => (v * 100).toFixed(1) + '%';
const show = (name, e) => console.error(`  ${name}: logloss ${e.logloss}／1着的中 ${pct(e.hit1)}／上位3車に1着 ${pct(e.in3)}${e.e3top5 != null && e.ll2 != null ? `／3連単 本線 ${pct(e.e3top1)}・上位5点 ${pct(e.e3top5)}・10点 ${pct(e.e3top10)}／3連複本線 ${pct(e.q3top1)}／2着 logloss ${e.ll2}` : ''}`);
const hold = tr.slice(Math.floor(tr.length * 0.8));

console.error('base（市場なし）を当てはめる…');
const beta = fit(tr, new Set([...DROPI, MKT]));
const tau = fitTau(hold.map(d => ({ U: utilities(d.X, beta), order: d.order })));
const stage = { t2: fitStage(tr, beta, STAGE2.length, x2), t3: fitStage(tr, beta, STAGE3.length, x3) };
const evPL = evaluate(te, beta, tau), ev = evaluate(te, beta, tau, { stage });
show('base（PL）', evPL); show('base（段階）', ev);
console.error(`  温度 τ1 ${tau[0]}／τ2 ${tau[1]}　2着 ${STAGE2.map((k, i) => `${k} ${stage.t2[i]}`).join(' ')}　3着 ${STAGE3.map((k, i) => `${k} ${stage.t3[i]}`).join(' ')}`);
console.error('  係数: ' + coefs(beta).slice(0, 20).map(([k, v]) => `${k} ${v}`).join(' / '));
console.error('  較正（予測→実際）: ' + ev.cal.filter(Boolean).map(b => `${(b.p * 100).toFixed(0)}→${(b.y * 100).toFixed(0)}`).join(' '));
const trO = tr.filter(d => d.mkt), teO = te.filter(d => d.mkt);
const mktOnly = teO.length ? evaluate(teO, null, [1, 1], { mktOnly: true }) : null;
const baseO = teO.length ? evaluate(teO, beta, tau, { stage }) : null;
if (mktOnly) { show(`人気だけ（3連単オッズから逆算、同じ ${teO.length}R）`, mktOnly); console.error(`    （人気1位の3連単の的中 ${pct(mktOnly.e3top1)}）`); show('  同じレースの base', baseO); }
let joint = null;
if (!process.env.KR_FIT_NOJOINT && trO.length >= Number(process.env.KR_FIT_MIN || 300) && teO.length >= 50) {
  console.error('joint（市場＋全特徴量）を当てはめる…');
  const bj = fit(trO, new Set(DROPI));
  const tj = fitTau(trO.slice(Math.floor(trO.length * 0.8)).map(d => ({ U: utilities(d.X, bj), order: d.order })));
  const sj = { t2: fitStage(trO, bj, STAGE2.length, x2), t3: fitStage(trO, bj, STAGE3.length, x3) };
  const ej = evaluate(teO, bj, tj, { stage: sj });
  show('joint', ej);
  console.error('  係数: ' + coefs(bj).slice(0, 20).map(([k, v]) => `${k} ${v}`).join(' / '));
  joint = { beta: [...bj].map(v => +v.toFixed(4)), tau: tj, stage: sj, test: ej, coef: coefs(bj), train: trO.length };
}
/* 地元の効き（「地元3割増し」の実測）：検証期間の地元選手について、base（home を含む）の予測と実際の1着率、home 係数を勝率の倍率に直した値 */
const hi = FEATURES.indexOf('home');
const homeMult = +Math.exp(beta[hi]).toFixed(3);
writeJSON(process.env.KR_FIT_OUT || 'data/keirin/model.json', {
  meta: { built: new Date().toISOString().slice(0, 10), split: SPLIT, warm: WARM, feats: FEATURES, stage2: STAGE2, stage3: STAGE3, train: tr.length, test: te.length, from: data[0]?.date, to: data.at(-1)?.date, drop: [...DROP], l2: L2 },
  base: { beta: [...beta].map(v => +v.toFixed(4)), tau, stage, test: ev, testPL: evPL, coef: coefs(beta) }, mktOnly, baseSame: baseO, oddsTest: teO.length, joint, homeMult,
});
