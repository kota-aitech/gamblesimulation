/* 予想1件（preds.jsonl の1行、または同じ形）を成績1件（K または公式サイトの結果）で精算する。
   build_boat_results.mjs（日別・場別の回収率）と build_boat.mjs（節間の結果に添える的中）で共用。
   表示と検証で同じ計算を使うため、ここ以外に精算の式を書かない。買い方は backtest_boat.mjs と同じ（1点100円）。 */

export const BETS = ['◎単勝', '◎複勝', '◎○2連単', '◎○2連複', '3艇BOX3連複', '3艇BOX3連単', '4艇BOX3連複', '［基準］1号艇単勝', '［基準］1号艇複勝',
  /* 2連単・3連単の買い方（点数は名前のとおり。1点100円） */
  '2連単 ◎→○▲(2点)', '2連単 ◎○表裏(2点)', '2連単 ◎→○▲△(3点)',
  '3連単 ◎○▲(1点)', '3連単 ◎1着流し(6点)', '3連単 4艇BOX(24点)', '3連単 ◎○→▲△(4点)',
  /* AI の買い目（印ではなく確率上位の組。preds の ai を精算） */
  'AI 3連単 上位3点', 'AI 3連単 上位5点', 'AI 3連単 上位8点', 'AI 2連単 上位3点', 'AI 2連単 上位5点', 'AI 3連単 期待値1.0超'];

export const payOf = (k, kind, code) => { const h = (k.pay?.[kind] || []).find(x => x.c === code); return h ? h.y : 0; };
const sortKey = a => a.slice().sort((x, y) => x - y).join('-');
export const mk = () => ({ races: 0, hit1: 0, in3: 0, bets: Object.fromEntries(BETS.map(b => [b, { n: 0, hit: 0, bet: 0, ret: 0 }])) });
const add = (S, name, bet, ret, hit) => { const o = S.bets[name]; o.n++; o.bet += bet; o.ret += ret; o.hit += hit ? 1 : 0; };

/* 1〜3着の艇番。失格・F などで3着まで揃わなければ null */
export function finishOf(k) {
  const fin = [1, 2, 3].map(pos => (k.entries || []).find(e => Number(e.pos) === pos)?.lane);
  return fin.some(x => x == null) ? null : fin;
}

export function settle(p, k) {
  const fin = finishOf(k);
  if (!fin) return null;
  const [f1, f2, f3] = fin, t = p.top;
  const S = mk();
  S.races = 1; S.hit1 = t[0] === f1 ? 1 : 0; S.in3 = t.slice(0, 3).includes(f1) ? 1 : 0;
  add(S, '◎単勝', 100, t[0] === f1 ? payOf(k, 'win', String(t[0])) : 0, t[0] === f1);
  add(S, '◎複勝', 100, [f1, f2].includes(t[0]) ? payOf(k, 'place', String(t[0])) : 0, [f1, f2].includes(t[0]));
  add(S, '◎○2連単', 100, t[0] === f1 && t[1] === f2 ? payOf(k, 'ex2', `${t[0]}-${t[1]}`) : 0, t[0] === f1 && t[1] === f2);
  const q = sortKey([t[0], t[1]]), fq = sortKey([f1, f2]);
  add(S, '◎○2連複', 100, q === fq ? payOf(k, 'qn', q) : 0, q === fq);
  const b3 = sortKey(t.slice(0, 3)), f3k = sortKey([f1, f2, f3]);
  add(S, '3艇BOX3連複', 100, b3 === f3k ? payOf(k, 'tri', b3) : 0, b3 === f3k);
  add(S, '3艇BOX3連単', 600, b3 === f3k ? payOf(k, 'ex3', `${f1}-${f2}-${f3}`) : 0, b3 === f3k);
  const b4 = t.slice(0, 4), hit4 = [f1, f2, f3].every(x => b4.includes(x));
  add(S, '4艇BOX3連複', 400, hit4 ? payOf(k, 'tri', f3k) : 0, hit4);
  add(S, '［基準］1号艇単勝', 100, f1 === 1 ? payOf(k, 'win', '1') : 0, f1 === 1);
  add(S, '［基準］1号艇複勝', 100, [f1, f2].includes(1) ? payOf(k, 'place', '1') : 0, [f1, f2].includes(1));
  /* 2連単・3連単。的中したら その組の払戻、外れなら 0。点数ぶんの投資 */
  const ex2 = payOf(k, 'ex2', `${f1}-${f2}`), ex3 = payOf(k, 'ex3', `${f1}-${f2}-${f3}`);
  const hitEx2 = pairs => pairs.some(([a, b]) => a === f1 && b === f2);
  const hitEx3 = tris => tris.some(([a, b, c]) => a === f1 && b === f2 && c === f3);
  const [t1, t2, t3, t4] = t;
  let P = [[t1, t2], [t1, t3]]; add(S, '2連単 ◎→○▲(2点)', 200, hitEx2(P) ? ex2 : 0, hitEx2(P));
  P = [[t1, t2], [t2, t1]]; add(S, '2連単 ◎○表裏(2点)', 200, hitEx2(P) ? ex2 : 0, hitEx2(P));
  P = [[t1, t2], [t1, t3], [t1, t4]]; add(S, '2連単 ◎→○▲△(3点)', 300, hitEx2(P) ? ex2 : 0, hitEx2(P));
  let T = [[t1, t2, t3]]; add(S, '3連単 ◎○▲(1点)', 100, hitEx3(T) ? ex3 : 0, hitEx3(T));
  T = []; for (const a of [t2, t3, t4]) for (const b of [t2, t3, t4]) if (a !== b) T.push([t1, a, b]);
  add(S, '3連単 ◎1着流し(6点)', 600, hitEx3(T) ? ex3 : 0, hitEx3(T));
  T = []; for (const a of b4) for (const b of b4) for (const c of b4) if (a !== b && b !== c && a !== c) T.push([a, b, c]);
  add(S, '3連単 4艇BOX(24点)', 2400, hitEx3(T) ? ex3 : 0, hitEx3(T));
  T = [[t1, t2, t3], [t1, t2, t4], [t2, t1, t3], [t2, t1, t4]];
  add(S, '3連単 ◎○→▲△(4点)', 400, hitEx3(T) ? ex3 : 0, hitEx3(T));
  /* AI の買い目。買い目が無いレース（期待値1.0超が0点）は投資も無し＝集計に入れない */
  if (p.ai) {
    const w3 = `${f1}-${f2}-${f3}`, w2 = `${f1}-${f2}`;
    const aiBet = (name, keys, kind) => { if (!keys || !keys.length) return; const hit = keys.includes(kind === 'ex3' ? w3 : w2); add(S, name, 100 * keys.length, hit ? (kind === 'ex3' ? ex3 : ex2) : 0, hit); };
    aiBet('AI 3連単 上位3点', p.ai.tri3, 'ex3'); aiBet('AI 3連単 上位5点', p.ai.tri5, 'ex3'); aiBet('AI 3連単 上位8点', p.ai.tri8, 'ex3');
    aiBet('AI 2連単 上位3点', p.ai.ex3, 'ex2'); aiBet('AI 2連単 上位5点', p.ai.ex5, 'ex2');
    aiBet('AI 3連単 期待値1.0超', (p.ai.ev || []).map(x => x.k), 'ex3');
  }
  return S;
}
export const merge = (A, B) => { A.races += B.races; A.hit1 += B.hit1; A.in3 += B.in3; for (const b of BETS) { const x = A.bets[b], y = B.bets[b]; x.n += y.n; x.hit += y.hit; x.bet += y.bet; x.ret += y.ret; } };
export const fin = S => ({
  races: S.races, hit1: S.races ? +(S.hit1 / S.races).toFixed(3) : null, in3: S.races ? +(S.in3 / S.races).toFixed(3) : null,
  bets: Object.fromEntries(BETS.map(b => { const x = S.bets[b]; return [b, { n: x.n, hit: x.n ? +(x.hit / x.n).toFixed(3) : null, bet: x.bet, ret: x.ret, roi: x.bet ? +(x.ret / x.bet).toFixed(3) : null }]; })),
});
