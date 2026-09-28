/* 段位 S／A／B／C（南関の racepick と同じ考え方を全競技にそろえる）。
   期待値 ev … そのレースで「モデルの確率×オッズ」が最も高い買い目の値（1.00 が損得なし）。
              極端な低確率の組は推定がぶれて期待値が膨らむので除く（南関の lib/bets.mjs の LIMIT と同じ理由）
   段位       … 過去（検証期間）の期待値の分布で決めた閾値で付ける：上位1割 S／1/4 A／半分 B／残り C。
              その日の相対順位ではないので、S が1本も無い日も、たくさんある日もある
   閾値は各競技の data/<競技>/grade.json（検証スクリプトか、記録の積み上げが書く）。
   券種で期待値の水準が違う（3連単は2〜5、単勝は1前後）ので、閾値は競技ごと・券種ごとに持ち、競技をまたいで比べない。 */
import fs from 'node:fs';
import path from 'node:path';

export const LIM = { p: 0.01, o: 300, pWin: 0.03, oWin: 100 };
const r3 = v => v == null || !Number.isFinite(v) ? null : +v.toFixed(3);

/* 組の一覧 [{k, p, o}] から最良の買い目 */
export function bestCombo(list, kind) {
  let b = null;
  for (const t of list || []) {
    if (!(t.p >= LIM.p) || !(t.o > 0) || t.o > LIM.o || t.o >= 9999) continue;
    const ev = t.p * t.o;
    if (!b || ev > b.ev) b = { kind, k: t.k, p: r3(t.p), o: t.o, ev: r3(ev) };
  }
  return b;
}
/* 単勝（[{no, p, odds}]） */
export function bestWin(list) {
  let b = null;
  for (const h of list || []) {
    if (!(h.p >= LIM.pWin) || !(h.odds > 0) || h.odds > LIM.oWin) continue;
    const ev = h.p * h.odds;
    if (!b || ev > b.ev) b = { kind: '単勝', k: String(h.no), p: r3(h.p), o: h.odds, ev: r3(ev) };
  }
  return b;
}
/* 期待値の分布 → 閾値（南関の racepick.json と同じ名前：p10＝S の下限、p25＝A、p50＝B） */
export function thresholdsOf(evs) {
  const xs = evs.filter(Number.isFinite).sort((a, b) => b - a);
  if (!xs.length) return null;
  const q = f => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(xs.length * f) - 1))];
  return { p10: r3(q(0.10)), p25: r3(q(0.25)), p50: r3(q(0.50)), n: xs.length };
}
export const gradeOf = (ev, t) => ev == null || !t ? null : ev >= t.p10 ? 'S' : ev >= t.p25 ? 'A' : ev >= t.p50 ? 'B' : 'C';
export function readGrade(ROOT, sport) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, `data/${sport}/grade.json`), 'utf8')); } catch { return null; }
}
/* 段位ごとの精算の器（検証スクリプトが使う）。add(grade, name, bet, ret) → finish() */
export function gradeBook() {
  const G = {};
  return {
    add(g, name, bet, ret) { if (!g || !bet) return; const x = ((G[g] ||= { races: new Set(), bets: {} }).bets[name] ||= { n: 0, hit: 0, bet: 0, ret: 0 }); x.n++; x.bet += bet; x.ret += ret; x.hit += ret > 0 ? 1 : 0; },
    race(g, id) { if (g) (G[g] ||= { races: new Set(), bets: {} }).races.add(id); },
    finish() { return Object.fromEntries(['S', 'A', 'B', 'C'].filter(g => G[g]).map(g => [g, { races: G[g].races.size, bets: Object.fromEntries(Object.entries(G[g].bets).map(([k, x]) => [k, { n: x.n, hit: r3(x.hit / x.n), roi: r3(x.ret / x.bet), bet: x.bet, ret: x.ret }])) }])); },
  };
}
/* 実戦（締切前後に記録した予想）の段位ごとの精算。各競技の build_*_results が使う。
   p … 記録（grade または rank、bestK＝最良の買い目の組番）、payBest … その組の払戻（外れは 0）、box … 本命BOX の {bet, ret}（無ければ null） */
export function liveGradeBook() {
  const GB = gradeBook();
  return {
    add(p, id, payBest, boxName, box) {
      const g = p.grade || p.rank; if (!g) return;
      GB.race(g, id);
      if (p.bestK) GB.add(g, '最良の買い目1点', 100, payBest || 0);
      if (box && box.bet) GB.add(g, boxName, box.bet, box.ret);
    },
    finish: () => GB.finish(),
  };
}
