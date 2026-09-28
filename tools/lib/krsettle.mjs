/* 競輪の買い方の精算（1点100円）。keirin_backtest（検証）と keirin_build_results（日別成績）が必ずここを通す（式を二重に持たない）。
   p … 予想：{ top: [車番…確率順], ai: { e3, q3, e2, q2, wide, ev, line }, mkt: [車番…市場の1着確率順], mktE3: 人気1位の3連単 }
   k … 結果つきのレース：{ result.order, pay }
   払戻のキー：q2＝2車複、e2＝2車単、q3＝3連複、e3＝3連単、wide＝ワイド（組番は "a-b" / "a-b-c"。複系は小さい順に並べ直して照合） */
export const BETS = [
  '◎1着', '◎-○ 2車複', '◎→○ 2車単', '◎-○ ワイド', '3車BOX 3連複', '4車BOX 3連複', '◎1着 3連単6点', '◎→○▲ 2車単2点',
  'ライン 2車単 表裏2点', 'AI 3連単 上位3点', 'AI 3連単 上位5点', 'AI 3連単 上位10点', 'AI 3連複 上位3点', 'AI 2車単 上位3点', 'AI 2車複 上位3点', '期待値1.0超 3連単',
  '［基準］人気1位の3連単1点', '［基準］人気上位3車 3連複', '［基準］人気上位2車 2車複',
];
const sortKey = a => a.slice().map(Number).sort((x, y) => x - y).join('-');
/* 払戻の一覧（同着なら複数ある）から組番の払戻を引く。複系は並べ直して照合 */
const payOf = (k, kind, code, sorted) => { const list = k.pay?.[kind] || []; const h = list.find(x => (sorted ? sortKey(x.c.split('-')) : x.c) === code); return h ? h.y : 0; };
export function finishOf(k) {
  const o = k.result?.order || [];
  const f = [1, 2, 3].map(p => o.find(x => x.pos === p)?.no);
  return f.some(x => x == null) ? null : f;
}
export function settle(p, k) {
  const fin = finishOf(k); if (!fin || !k.pay) return null;
  const f1s = new Set((k.result.order || []).filter(o => o.pos === 1).map(o => o.no));
  const t = p.top, [t1, t2, t3, t4] = t;
  const out = {};
  const add = (name, bet, ret) => { out[name] = { bet, ret, hit: ret > 0 ? 1 : 0 }; };
  /* 買い目の集合を払戻の一覧で精算する（同着のときは当たりの組が複数ある） */
  const settleSet = (kind, codes, sorted) => codes.reduce((a, c) => a + payOf(k, kind, sorted ? sortKey(c.split('-')) : c, sorted), 0);
  const perm = (xs, n) => n === 1 ? xs.map(x => [x]) : xs.flatMap(x => perm(xs.filter(y => y !== x), n - 1).map(r => [x, ...r]));
  const comb = (xs, n) => n === 0 ? [[]] : xs.flatMap((x, i) => comb(xs.slice(i + 1), n - 1).map(r => [x, ...r]));
  out['◎1着'] = { bet: 0, ret: 0, hit: f1s.has(t1) ? 1 : 0 };
  add('◎-○ 2車複', 100, settleSet('q2', [`${t1}-${t2}`], true));
  add('◎→○ 2車単', 100, settleSet('e2', [`${t1}-${t2}`]));
  add('◎-○ ワイド', 100, settleSet('wide', [`${t1}-${t2}`], true));
  add('3車BOX 3連複', 100, settleSet('q3', comb(t.slice(0, 3), 3).map(x => x.join('-')), true));
  add('4車BOX 3連複', 400, settleSet('q3', comb(t.slice(0, 4), 3).map(x => x.join('-')), true));
  add('◎1着 3連単6点', 600, settleSet('e3', perm([t2, t3, t4], 2).map(([b, c]) => `${t1}-${b}-${c}`)));
  add('◎→○▲ 2車単2点', 200, settleSet('e2', [`${t1}-${t2}`, `${t1}-${t3}`]));
  const ai = p.ai || {};
  const aiBet = (name, keys, kind, sorted) => { if (!keys || !keys.length) return; add(name, 100 * keys.length, settleSet(kind, keys, sorted)); };
  if (ai.line?.e2) aiBet('ライン 2車単 表裏2点', ai.line.e2, 'e2');
  aiBet('AI 3連単 上位3点', ai.e3?.slice(0, 3), 'e3');
  aiBet('AI 3連単 上位5点', ai.e3?.slice(0, 5), 'e3');
  aiBet('AI 3連単 上位10点', ai.e3?.slice(0, 10), 'e3');
  aiBet('AI 3連複 上位3点', ai.q3?.slice(0, 3), 'q3', true);
  aiBet('AI 2車単 上位3点', ai.e2?.slice(0, 3), 'e2');
  aiBet('AI 2車複 上位3点', ai.q2?.slice(0, 3), 'q2', true);
  if (ai.ev?.length) aiBet('期待値1.0超 3連単', ai.ev, 'e3');
  if (p.mktE3) add('［基準］人気1位の3連単1点', 100, settleSet('e3', [p.mktE3]));
  if (p.mkt?.length >= 3) add('［基準］人気上位3車 3連複', 100, settleSet('q3', [p.mkt.slice(0, 3).join('-')], true));
  if (p.mkt?.length >= 2) add('［基準］人気上位2車 2車複', 100, settleSet('q2', [p.mkt.slice(0, 2).join('-')], true));
  return { fin, bets: out, hit1: f1s.has(t1) ? 1 : 0, in3: t.slice(0, 3).some(x => f1s.has(x)) ? 1 : 0 };
}
