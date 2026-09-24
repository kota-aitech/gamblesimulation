/* 馬場（含水率・クッション値）と結果から読み取る「その馬場で何が有利か」の索引。

   これまでの含水率の特徴量は「偏差 × 馬の性質」を1本の係数で効かせていたので、
   **効き方の形（湿ると前が有利／芝は逆）をモデルが自分で見つける**しかなく、係数は +0.02〜0.07 と小さかった。
   ここでは**実測から帯ごとの有利不利を先に作って**、それを馬に当てる。

     styleEdge … その帯で「前で運ぶ馬」がどれだけ3着内に来やすいか（脚質4分類ごとの対数オッズ差）
     gateEdge  … その帯での枠の得失（3着内シェア ÷ 出走シェア の対数）
     jWet      … 騎手のその帯での上振れ（本人の平常値を事前分布に置いて縮小）

   **先読みを避ける**：結果を日付順に流し、各レースについて「その日より前の結果だけ」で作る
   （lib/jfeat.mjs の buildAsOf と同じ約束）。出馬表（未来のレース）には最新の状態を使う。
   標本が少ない帯は上位（芝ダ全体）の値へ縮小するので、帯が細かくても暴れない。 */

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const logit = p => Math.log(clamp(p, 1e-4, 1 - 1e-4) / (1 - clamp(p, 1e-4, 1 - 1e-4)));
/* 縮小推定：標本 n・成功 w を、事前確率 p0 の方向へ k 件ぶん引き寄せた対数オッズ差 */
const shrunk = (w, n, p0, k) => logit((w + p0 * k) / (n + k)) - logit(p0);

/* 含水率の帯。jra_baba_stats.mjs / jra_build_races.mjs と同じ切り方にそろえる（画面の表と対応させるため） */
export const MBIN = {
  芝: [[0, 10, '〜10%（乾）'], [10, 12, '10〜12%'], [12, 14, '12〜14%'], [14, 16, '14〜16%'], [16, 999, '16%〜（湿）']],
  ダート: [[0, 4, '〜4%（乾）'], [4, 6, '4〜6%'], [6, 8, '6〜8%'], [8, 10, '8〜10%'], [10, 12, '10〜12%'], [12, 999, '12%〜（湿）']],
};
/* クッション値の帯（芝のみ。2020-09-11 から公表） */
export const CBIN = [[0, 8.5, '〜8.5（軟らかめ）'], [8.5, 9.5, '8.5〜9.5'], [9.5, 10.5, '9.5〜10.5'], [10.5, 99, '10.5〜（硬め）']];
const binOf = (tbl, v) => v == null ? null : (tbl.find(b => v >= b[0] && v < b[1]) || tbl.at(-1))[2];
export const surfOf = s => /芝/.test(s || '') ? '芝' : /ダ/.test(s || '') ? 'ダート' : null;
export const moistBinOf = (surface, moist) => { const surf = surfOf(surface); return surf && MBIN[surf] ? binOf(MBIN[surf], moist) : null; };
export const cushionBinOf = cushion => cushion == null ? null : binOf(CBIN, cushion);

/* 脚質4分類（jfeat.mjs の styleOf と同じ境目）。位置は「通過順 ÷ (頭数+1)」 */
export const STYLES = ['逃げ', '先行', '差し', '追込'];
export const styleOf = ep => ep == null ? null : ep <= 0.2 ? '逃げ' : ep <= 0.42 ? '先行' : ep <= 0.7 ? '差し' : '追込';
/* 4角（無ければ1角）の通過順を頭数で割った値。結果の pass は "4-4" や "(*6,10)" ではなく馬ごとの "3-3-2-2" 形式 */
const posOf = (pass, n) => {
  if (!pass || !n) return null;
  const xs = String(pass).split('-').map(x => Number(String(x).replace(/\D/g, ''))).filter(x => x > 0);
  if (!xs.length) return null;
  return clamp(xs.at(-1) / (n + 1), 0, 1);
};

export function buildBabaBias(results, BABA) {
  /* 帯ごとの集計。key は `${surf}|${帯}`、上位は `${surf}` */
  const mk = () => ({ n: 0, w: 0, style: new Map(), gate: new Map() });
  const acc = new Map(), top = new Map();
  const J = new Map();                                        // 騎手 -> { n, w, band: Map(帯 -> {n,w}) }
  const cell = (m, k) => { let v = m.get(k); if (!v) m.set(k, v = { n: 0, w: 0 }); return v; };
  const box = (m, k) => { let v = m.get(k); if (!v) m.set(k, v = mk()); return v; };

  /* いまの状態から「その帯の有利不利」を1つ作る。

     **馬場バイアスは場ごとに違う**（中山の芝の内、東京のダートの外…）ので、段階を踏んで縮小する。
       1段目 … 芝ダ全体（母集団）
       2段目 … 芝ダ × 帯（湿ると前、など競技ぜんたいの傾向）
       3段目 … 場 × 芝ダ × 帯（その場のクセ。標本が薄ければ2段目に寄る）
     各段は「ひとつ上の段の値」を事前分布に置いて縮小するので、場の標本が少なくても暴れない。 */
  const edgeOf = (key, kind, id, prior, k) => {
    const A = acc.get(key); if (!A) return null;
    const g = (kind === 'style' ? A.style : A.gate).get(id);
    if (!g || g.n < 40) return null;
    return { v: shrunk(g.w, g.n, prior, k), n: g.n, p: (g.w + prior * k) / (g.n + k) };
  };
  const view = (surf, venue, mbin, cbin, useVenue) => {
    const T = top.get(surf);
    if (!T || T.n < 400) return null;                          // 芝ダ全体の標本がまだ薄い（学習の最初のころ）
    const p0 = T.w / T.n;                                      // 3着内の基準（およそ 3/頭数）
    const out = { style: {}, gate: {}, n: 0 };
    /* 1つの区分（脚質 or 枠）について、全体 → 帯 → 場×帯 と降りていく */
    const chain = (kind, id) => {
      const G = (kind === 'style' ? T.style : T.gate).get(id);
      if (!G || G.n < 200) return null;
      const base = G.w / G.n;                                  // 1段目：芝ダ全体でのその区分の3着内率
      let p = base, sum = 0;
      const step = (key, k) => {
        const e = edgeOf(key, kind, id, p, k);
        if (!e) return;
        sum += e.v; p = e.p;                                   // 次の段はここを事前分布にする
      };
      step(`${surf}|M|${mbin}`, 400);                          // 2段目：芝ダ × 含水率の帯
      if (surf === '芝' && cbin) step(`${surf}|C|${cbin}`, 600);//        （芝はクッション値の帯も）
      if (useVenue) step(`${surf}|${venue}|M|${mbin}`, 250);   // 3段目：場 × 芝ダ × 帯
      return sum;
    };
    for (const s of STYLES) { const v = chain('style', s); if (v != null) out.style[s] = v; }
    for (let k = 1; k <= 8; k++) { const v = chain('gate', k); if (v != null) out.gate[k] = v; }
    for (const key of [`${surf}|M|${mbin}`, `${surf}|${venue}|M|${mbin}`]) { const A = acc.get(key); if (A) out.n += A.n; }
    out.p0 = p0;
    return out;
  };
  const jWet = (jockeyId, surf, mbin) => {
    const j = J.get(jockeyId);
    if (!j || j.n < 80) return 0;
    const b = j.band.get(`${surf}|${mbin}`);
    if (!b || b.n < 25) return 0;
    return clamp(shrunk(b.w, b.n, j.w / j.n, 60), -0.8, 0.8);   // 本人の平常値からのズレ
  };

  /* レースごとの状態を覚える（featurize はレース単位で呼ばれるため） */
  const snap = new Map();
  const babaOf = r => {
    const b = BABA && BABA.of ? BABA.of(r.date, r.venue, r.surface) : null;
    if (!b) return { mbin: null, cbin: null, moist: null, cushion: null };
    return { mbin: moistBinOf(r.surface, b.moist), cbin: cushionBinOf(b.cushion), moist: b.moist, cushion: b.cushion, dev: b.dev, cdev: b.cdev };
  };

  for (const r of results) {
    const surf = surfOf(r.surface);
    if (!surf) continue;
    const { mbin, cbin } = babaOf(r);
    /* まず読む（このレースより前の状態） */
    /* view … モデルの特徴量に使う（芝ダ×帯まで）。venueView … 画面に出す（場まで降りる）。
       **場まで降りた値をモデルに入れると当てはめが悪くなった**（検証 1,073R で base logloss 2.0915 → 2.0923）。
       場×帯のマスは標本が薄く、拾うのは雑音のほうが多い。読み物としては場ごとのほうが役に立つので、用途で分ける */
    snap.set(r.raceId, { surf, venue: r.venue, mbin, cbin,
      view: view(surf, r.venue, mbin, cbin, false),
      venueView: view(surf, r.venue, mbin, cbin, true),
      jockey: new Map(r.entries.filter(e => e.jockeyId).map(e => [e.jockeyId, jWet(e.jockeyId, surf, mbin)])) });
    /* それから足す */
    const T = box(top, surf);
    const A = mbin ? box(acc, `${surf}|M|${mbin}`) : null;
    const C = (surf === '芝' && cbin) ? box(acc, `${surf}|C|${cbin}`) : null;
    const V = mbin ? box(acc, `${surf}|${r.venue}|M|${mbin}`) : null;
    for (const e of r.entries) {
      if (typeof e.pos !== 'number') continue;
      const in3 = e.pos <= 3 ? 1 : 0;
      const st = styleOf(posOf(e.pass, r.n));
      const wk = Number(e.waku) || null;
      for (const X of [T, A, C, V]) {
        if (!X) continue;
        X.n++; X.w += in3;
        if (st) { const c = cell(X.style, st); c.n++; c.w += in3; }
        if (wk) { const c = cell(X.gate, wk); c.n++; c.w += in3; }
      }
      if (e.jockeyId && mbin) {
        let j = J.get(e.jockeyId); if (!j) J.set(e.jockeyId, j = { n: 0, w: 0, band: new Map() });
        j.n++; j.w += in3;
        const b = cell(j.band, `${surf}|${mbin}`); b.n++; b.w += in3;
      }
    }
  }
  /* 出馬表（まだ結果のないレース）は最新の状態を使う */
  const latest = race => {
    const surf = surfOf(race.surface);
    if (!surf) return null;
    const { mbin, cbin } = babaOf(race);
    return { surf, venue: race.venue, mbin, cbin,
      view: view(surf, race.venue, mbin, cbin, false),
      venueView: view(surf, race.venue, mbin, cbin, true),
      jockey: null, _mbin: mbin };
  };
  return {
    /* レース1件ぶんの馬場バイアス。学習時は記録した状態、未来のレースは最新 */
    of(race) { return snap.get(race.raceId) || latest(race); },
    /* 騎手のこの帯での上振れ（未来のレースは最新の状態から引く） */
    jockeyOf(state, jockeyId) {
      if (!state || !jockeyId) return 0;
      if (state.jockey) return state.jockey.get(jockeyId) || 0;
      return jWet(jockeyId, state.surf, state.mbin || state._mbin);
    },
    binOf: babaOf,
    size: snap.size,
  };
}
