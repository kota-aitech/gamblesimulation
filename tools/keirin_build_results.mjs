/* 競輪の日別・場別の的中率と回収率 → data/keirin/results.json（TOP の競輪面）。ばんえい・JRA と同じ。
   keirin_build_races が「締切の過ぎたレース」の予想を preds.jsonl に記録し、ここで races.jsonl の払戻と突き合わせる（1点100円、精算は lib/krsettle.mjs）。
     KR_REC_DAYS … 何日ぶんを載せるか（既定 60） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON } from './lib/kr.mjs';
import { BETS, settle } from './lib/krsettle.mjs';
import { liveGradeBook } from './lib/grade.mjs';
const LG = liveGradeBook();

const DAYS = Number(process.env.KR_REC_DAYS || 60);
const PREDS = path.join(ROOT, 'data/keirin/preds.jsonl');
if (!fs.existsSync(PREDS)) { console.error('preds.jsonl がまだ無い'); process.exit(0); }
const preds = new Map();
for (const l of fs.readFileSync(PREDS, 'utf8').split('\n')) if (l) { try { const o = JSON.parse(l); preds.set(o.raceId, o); } catch { } }
const dates = [...new Set([...preds.values()].map(o => o.date))].sort().slice(-DAYS);
const want = new Set(dates);
const K = new Map();
for (const line of fs.readFileSync(path.join(ROOT, 'data/keirin/races.jsonl'), 'utf8').split('\n')) {
  const m = line.match(/^\{"raceId":"(\d{16})","date":"(\d{8})"/);
  if (!m || !preds.has(m[1]) || !want.has(m[2]) || !/"result":\{/.test(line)) continue;
  const o = JSON.parse(line); K.set(o.raceId, { result: o.result, pay: o.pay, venue: o.venue });
}
const mk = () => ({ races: 0, hit1: 0, in3: 0, bets: Object.fromEntries(BETS.map(b => [b, { n: 0, hit: 0, bet: 0, ret: 0 }])) });
const merge = (A, S) => { A.races++; A.hit1 += S.hit1; A.in3 += S.in3; for (const [b, x] of Object.entries(S.bets)) { const o = A.bets[b]; if (!o) continue; o.n++; o.hit += x.hit; o.bet += x.bet; o.ret += x.ret; } };
const fin = S => ({ races: S.races, hit1: S.races ? +(S.hit1 / S.races).toFixed(3) : null, in3: S.races ? +(S.in3 / S.races).toFixed(3) : null,
  bets: Object.fromEntries(BETS.map(b => { const x = S.bets[b]; return [b, { n: x.n, hit: x.n ? +(x.hit / x.n).toFixed(3) : null, bet: x.bet, ret: x.ret, roi: x.bet ? +(x.ret / x.bet).toFixed(3) : null }]; })) });
const out = { built: new Date().toISOString(), bets: BETS, days: [], total: null, byVenue: {} };
const TOTAL = mk(), VEN = {};
let matched = 0, pending = 0;
for (const date of dates) {
  const DAY = mk(); let late = 0, joint = 0, repro = 0, cloud = 0;
  for (const p of preds.values()) {
    if (p.date !== date) continue;
    const k = K.get(p.raceId); if (!k) { pending++; continue; }
    const S = settle(p, k); if (!S) { pending++; continue; }
    matched++; merge(DAY, S); merge(TOTAL, S); const V = (VEN[k.venue] ||= mk()); merge(V, S); (V.days ||= new Set()).add(date);
    /* 段位ごと（実戦・再現は除く）：最良の3連単1点と、本命3車BOX 3連複 */
    if (p.late !== 9999) LG.add(p, p.raceId, p.bestK ? ((k.pay?.e3 || []).find(x => x.c === p.bestK)?.y || 0) : 0, '本命3車BOX 3連複', S.bets['3車BOX 3連複']);
    if (p.late === 9999) repro++; else if (p.oddsSrc === 'T-8') cloud++; else if (p.late > 60) late++; if (p.level === 'joint') joint++;
  }
  out.days.push({ date, late, repro, cloud, joint, ...fin(DAY) });
}
out.total = fin(TOTAL);
out.byGrade = LG.finish();   // 段位ごとの実戦の回収率（2026-09-28 以降に締切前に記録したレース）
/* 場別（TOP の「場別の成績」。他競技と同じ配列の形） */
out.byVenue = Object.entries(VEN).map(([k, v]) => ({ venue: k, days: v.days.size, ...fin(v) })).sort((a, b) => b.races - a.races);
out.note = '予想は締切10分前〜締切に記録したもの（late＝締切から60分以上あとに記録したレース数、repro＝記録の仕組みができる前のレースを後から学習に使っていないモデルで作り直した「再現」の数）。払戻は楽天Kドリームスの結果ページ。';
writeJSON('data/keirin/results.json', out);
const T = out.total;
console.error(`${dates.length}日 ${matched}R を精算（未確定 ${pending}R）。◎1着 ${T.hit1 != null ? (T.hit1 * 100).toFixed(1) : '—'}%／3車BOX3連複 回収 ${T.bets['3車BOX 3連複'].roi != null ? (T.bets['3車BOX 3連複'].roi * 100).toFixed(1) : '—'}%`);
