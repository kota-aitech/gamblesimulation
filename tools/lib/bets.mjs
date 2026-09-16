/* 買い目と期待値。build_marks（表示用）と race_pick（検証用）で必ず同じ計算を使う。

   市場の組み合わせ価格は単勝オッズから Harville で推定する。ただし Harville は
   極端な低確率の組み合わせで分母が潰れ、想定配当が数十万倍という数字を出す。
   そのまま最大値を取ると「買えない買い目」で期待値が決まってしまうので、
   モデル確率の下限と想定配当の上限で現実的な範囲に絞る。                   */
export const TAKEOUT = 0.25;
export const LIMIT = {
  umaren:  { minQ: 0.02, maxOdds: 300 },   // 1/50 以上、300倍以下
  sanpuku: { minQ: 0.01, maxOdds: 500 },   // 1/100 以上、500倍以下
};

const plProb = (p, idxs) => {
  let q = 1, rest = p.slice();
  for (const i of idxs) { const z = rest.reduce((a, b) => a + b, 0); if (z <= 0) return 0; q *= rest[i] / z; rest = rest.slice(); rest[i] = 0; }
  return q;
};
export const pair2 = (p, a, b) => plProb(p, [a, b]) + plProb(p, [b, a]);
export const tri3 = (p, a, b, c) => [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]].reduce((s, o) => s + plProb(p, o), 0);
const combos2 = n => { const o = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) o.push([i, j]); return o; };
const combos3 = n => { const o = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) o.push([i, j, k]); return o; };

/* p: モデルの勝率ベクトル, pm: 市場の勝率ベクトル, nos: 馬番, combos: lib/nkstage.mjs の raceCombos（段階モデルの組の確率。無ければ Harville） */
export function betPlan(p, pm, nos, maxPts = 12, combos = null) {
  if (!pm) return null;
  const out = {};
  for (const [key, need] of [['umaren', 2], ['sanpuku', 3]]) {
    const lim = LIMIT[key];
    const cbs = need === 2 ? combos2(p.length) : combos3(p.length);
    const list = [];
    for (const cb of cbs) {
      const ck = cb.slice().sort((a, b) => a - b).join('-');
      const q = combos ? ((need === 2 ? combos.umaren : combos.sanpuku).get(ck) || 0) : (need === 2 ? pair2(p, cb[0], cb[1]) : tri3(p, cb[0], cb[1], cb[2]));
      const qm = need === 2 ? pair2(pm, cb[0], cb[1]) : tri3(pm, cb[0], cb[1], cb[2]);
      if (qm <= 0 || q < lim.minQ) continue;
      const odds = (1 - TAKEOUT) / qm;
      if (!(odds > 1) || odds > lim.maxOdds) continue;
      list.push({ c: cb.map(i => nos[i]).sort((a, b) => a - b), p: +q.toFixed(4),
        odds: +odds.toFixed(1), ev: +(q * odds).toFixed(2) });
    }
    list.sort((a, b) => b.ev - a.ev);
    out[key] = { best: list[0] ? list[0].ev : 0, nPos: list.filter(x => x.ev >= 1).length,
      buy: list.filter(x => x.ev >= 1).slice(0, maxPts), all: list };
  }
  return out;
}
export const confOf = p => {
  const ent = -p.reduce((a, x) => a + (x > 0 ? x * Math.log(x) : 0), 0) / Math.log(Math.max(2, p.length));
  return 1 - ent;
};
