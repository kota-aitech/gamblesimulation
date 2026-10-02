/* 競輪の集計 → data/keirin/index.json（keirin.html の「場とラインの実測」と読みのポイントの根拠）
     venues[場]  … レース数・バンク周長・ラインの位置別（先頭／番手／3番手以降／単騎）の1着率・決まり手の内訳・ライン決着率（1・2着が同じライン）・
                   人気1位（3連単オッズから逆算）の1着率・3連単の中央値と万車券率
     slots       … 全体のラインの位置別の 1着率・2連対率・3着内率（ラインの車数・何分戦かの別も）
     home        … **地元の実測**。同じレースの中で競走得点の順位が同じ選手どうしで比べ、地元（登録府県＝開催場の府県）の1着率・3着内率が
                   他の選手の何倍か（「地元3割増し」の検証）。グレード別・段階（予選／準決勝／決勝など）別も
     kimarite    … バンク周長（333／400／500）ごとの決まり手の内訳
   ガールズ（L級）はラインが無いので、ライン関係の集計から外す。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON, venueByName, ymdOf, addDays } from './lib/kr.mjs';
import { loadRaces, raceOf, lineInfo, stageOf, mktFor, buildAsOf } from './lib/krfeat.mjs';

const races = loadRaces('data/keirin/races.jsonl', { pay: true }, l => /"result":\{/.test(l));
console.error(`${races.length}R（${races[0]?.date}〜${races.at(-1)?.date}）`);
const r3 = v => v == null ? null : +v.toFixed(3);
const slotName = ['先頭', '番手', '3番手以降', '単騎'];
const V = {}, S = slotName.map(() => ({ n: 0, w: 0, q: 0, t: 0 })), SN = {}, KB = {};
const HM = {}; // key -> rank -> {hn, hw, ht, an, aw, at}
const addHome = (key, rank, home, pos) => { const g = (HM[key] ||= {}); const x = (g[rank] ||= { hn: 0, hw: 0, ht: 0, an: 0, aw: 0, at: 0 }); if (home) { x.hn++; x.hw += pos === 1; x.ht += pos <= 3; } else { x.an++; x.aw += pos === 1; x.at += pos <= 3; } };
let lineOneTwo = 0, lineN = 0;
for (const r0 of races) {
  const r = raceOf(r0), L = lineInfo(r);
  const vn = r.venue, v = (V[vn] ||= { races: 0, bank: r.bank, slot: slotName.map(() => ({ n: 0, w: 0 })), kim: {}, lineOneTwo: 0, lineN: 0, fav: { n: 0, w: 0 }, e3: [], man: 0, girls: 0, grades: {} });
  v.races++; if (r.bank) v.bank = r.bank; v.grades[r.grade || '?'] = (v.grades[r.grade || '?'] || 0) + 1;
  const ord = r.result.order, posOf = no => { const o = ord.find(x => x.no === no); return typeof o?.pos === 'number' ? o.pos : 99; };
  const win = ord.find(o => o.pos === 1), sec = ord.find(o => o.pos === 2);
  if (win?.kimarite) { v.kim[win.kimarite] = (v.kim[win.kimarite] || 0) + 1; const kb = (KB[r.bank || '?'] ||= {}); kb[win.kimarite] = (kb[win.kimarite] || 0) + 1; }
  const e3 = r0.pay?.e3?.[0]?.y; if (e3) { v.e3.push(e3); if (e3 >= 10000) v.man++; }
  const mk = mktFor(r, r.riders); if (mk && win) { const top = mk.p.indexOf(Math.max(...mk.p)); v.fav.n++; if (r.riders[top]?.no === win.no) v.fav.w++; }
  /* 地元：得点順位（1＝最上位）ごとに地元とそれ以外を比べる */
  const sc = r.riders.map(h => h.score || 0);
  for (const h of r.riders) {
    const rank = sc.filter(s => s > (h.score || 0)).length + 1, pos = posOf(h.no), home = h.pref === r.vpref;
    for (const key of ['all', `grade:${r.grade || '?'}`, `stage:${stageOf(r.kind)}`, r.girls ? 'girls' : 'men']) addHome(key, Math.min(rank, 7), home, pos);
  }
  if (r.girls) { v.girls++; continue; }
  if (!L.known) continue;
  const slot = li => li.size === 1 ? 3 : Math.min(li.pos, 2);
  const nl = L.lines.filter(l => l.length >= 2).length, key = `${nl}分戦${L.lines.some(l => l.length === 1) ? '＋単騎' : ''}`;
  for (const h of r.riders) {
    const li = L.byNo.get(h.no); if (!li) continue;
    const s = slot(li), pos = posOf(h.no);
    S[s].n++; S[s].w += pos === 1; S[s].q += pos <= 2; S[s].t += pos <= 3;
    v.slot[s].n++; v.slot[s].w += pos === 1;
    const sn = ((SN[key] ||= slotName.map(() => ({ n: 0, w: 0 }))))[s]; sn.n++; sn.w += pos === 1;
  }
  if (win && sec) { const a = L.byNo.get(win.no), b = L.byNo.get(sec.no); if (a && b) { lineN++; v.lineN++; if (a.li === b.li) { lineOneTwo++; v.lineOneTwo++; } } }
}
const homeOut = Object.fromEntries(Object.entries(HM).map(([k, g]) => {
  /* 期待＝同じ得点順位の「地元以外」の率 × 地元の出走数。倍率＝実際÷期待 */
  let hw = 0, ht = 0, ew = 0, et = 0, hn = 0;
  const byRank = {};
  for (const [rank, x] of Object.entries(g)) {
    if (!x.hn || x.an < 20) continue;
    hn += x.hn; hw += x.hw; ht += x.ht; ew += x.hn * x.aw / x.an; et += x.hn * x.at / x.an;
    byRank[rank] = { hn: x.hn, hWin: r3(x.hw / x.hn), aWin: r3(x.aw / x.an), hTop3: r3(x.ht / x.hn), aTop3: r3(x.at / x.an) };
  }
  return [k, { runs: hn, win: r3(hn ? hw / hn : null), expWin: r3(hn ? ew / hn : null), winMult: r3(ew ? hw / ew : null), top3Mult: r3(et ? ht / et : null), byRank }];
}));
const venues = Object.fromEntries(Object.entries(V).sort((a, b) => (venueByName[a[0]]?.code || '').localeCompare(venueByName[b[0]]?.code || '')).map(([k, v]) => {
  const e3 = v.e3.sort((a, b) => a - b);
  const kn = Object.values(v.kim).reduce((a, b) => a + b, 0);
  return [k, { races: v.races, bank: v.bank, girls: v.girls, grades: v.grades,
    slot: v.slot.map((s, i) => ({ name: slotName[i], n: s.n, win: r3(s.n ? s.w / s.n : null) })),
    kim: Object.fromEntries(Object.entries(v.kim).sort((a, b) => b[1] - a[1]).map(([kk, c]) => [kk, r3(c / kn)])),
    lineOneTwo: r3(v.lineN ? v.lineOneTwo / v.lineN : null), fav: r3(v.fav.n ? v.fav.w / v.fav.n : null), favN: v.fav.n,
    e3Med: e3.length ? e3[Math.floor(e3.length / 2)] : null, man: r3(e3.length ? v.man / e3.length : null) }];
}));
const out = {
  meta: { built: new Date().toISOString(), from: races[0]?.date, to: races.at(-1)?.date, races: races.length },
  slots: S.map((s, i) => ({ name: slotName[i], n: s.n, win: r3(s.w / s.n), q2: r3(s.q / s.n), top3: r3(s.t / s.n) })),
  slotsByLines: Object.fromEntries(Object.entries(SN).filter(([, a]) => a.reduce((x, y) => x + y.n, 0) >= 300).map(([k, a]) => [k, a.map((s, i) => ({ name: slotName[i], n: s.n, win: r3(s.n ? s.w / s.n : null) }))])),
  lineOneTwo: r3(lineN ? lineOneTwo / lineN : null),
  kimarite: Object.fromEntries(Object.entries(KB).map(([b, m]) => { const n = Object.values(m).reduce((a, c) => a + c, 0); return [b, { n, ...Object.fromEntries(Object.entries(m).sort((a, c) => c[1] - a[1]).map(([kk, c]) => [kk, r3(c / n)])) }]; })),
  home: homeOut, venues,
};
writeJSON('data/keirin/index.json', out);
const h = out.home.all;
console.error(`地元：${h.runs}走、1着率 ${(h.win * 100).toFixed(1)}%（同じ得点順位の他の選手なら ${(h.expWin * 100).toFixed(1)}%）→ ${h.winMult}倍、3着内は ${h.top3Mult}倍`);
console.error(`ライン：${out.slots.map(s => `${s.name} 1着${(s.win * 100).toFixed(1)}%`).join('／')}、ライン決着（1・2着が同じライン）${(out.lineOneTwo * 100).toFixed(1)}%`);

/* 予想生成（keirin_build_races、10分おき）用の積み上げ：「一昨日まで」の結果で作った時点指標を保存しておく。
   予想生成はこれを読み、昨日以降のレースだけを races.jsonl から足す（全期間を毎回読み直さない） */
{
  const upto = addDays(ymdOf(new Date()), -2);
  const A = buildAsOf(races.filter(r => r.date <= upto));
  writeJSON('data/keirin/asof.json', A.saveState(upto, addDays(upto, -8)));
}
