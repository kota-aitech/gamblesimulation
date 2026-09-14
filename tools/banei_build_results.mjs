/* ばんえいの日別の的中率と回収率 → data/banei/results.json（TOP のばんえい面）。JRA の jra_build_results.mjs と同じ。
   banei_build_races が「発走が過ぎたレース」の予想を preds.jsonl に記録し、ここで results.jsonl の払戻と突き合わせる（1点100円）。
     BN_REC_DAYS … 何日ぶんを載せるか（既定 60） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON } from './lib/bn.mjs';

const DAYS = Number(process.env.BN_REC_DAYS || 60);
const PREDS = path.join(ROOT, 'data/banei/preds.jsonl');
if (!fs.existsSync(PREDS)) { console.error('preds.jsonl がまだ無い'); process.exit(0); }
const preds = new Map();
for (const l of fs.readFileSync(PREDS, 'utf8').split('\n')) if (l) { try { const o = JSON.parse(l); preds.set(o.raceId, o); } catch { } }
const dates = [...new Set([...preds.values()].map(o => o.date))].sort().slice(-DAYS);
const want = new Set(dates);
const K = new Map();
for (const line of fs.readFileSync(path.join(ROOT, 'data/banei/results.jsonl'), 'utf8').split('\n')) {
  const m = line.match(/^\{"raceId":"(\d{10})"/);
  if (!m || !want.has(m[1].slice(0, 8))) continue;
  const o = JSON.parse(line); K.set(o.raceId, o);
}
const payOf = (k, kind, code) => { const h = (k.pay?.[kind] || []).find(x => x.c === code); return h ? h.y : 0; };
const sortKey = a => a.slice().sort((x, y) => x - y).join('-');
const BETS = ['◎単勝', '◎複勝', '◎○馬連', '◎○馬単', '3頭BOX馬連', '3頭BOX三連複', '4頭BOX馬連', '4頭BOX三連複', '5頭BOX三連複',
  '◎→○▲△ 馬単3点', '◎1着 三連単6点', 'AI 馬連 上位3点', 'AI 三連複 上位3点', 'AI 三連単 上位5点', '［基準］1番人気の単勝'];
const mk = () => ({ races: 0, hit1: 0, in3: 0, bets: Object.fromEntries(BETS.map(b => [b, { n: 0, hit: 0, bet: 0, ret: 0 }])) });
const add = (S, name, bet, ret, hit) => { const o = S.bets[name]; o.n++; o.bet += bet; o.ret += ret; o.hit += hit ? 1 : 0; };
function settle(p, k) {
  const fin = [1, 2, 3].map(pos => k.entries.find(e => e.pos === pos)?.no);
  if (fin.some(x => x == null)) return null;
  const [f1, f2, f3] = fin, t = p.top;
  const S = mk(); S.races = 1; S.hit1 = t[0] === f1 ? 1 : 0; S.in3 = t.slice(0, 3).includes(f1) ? 1 : 0;
  const e2k = `${f1}-${f2}`, q2 = sortKey([f1, f2]), s3 = sortKey([f1, f2, f3]), e3k = `${f1}-${f2}-${f3}`;
  const [t1, t2, t3, t4] = t;
  add(S, '◎単勝', 100, t1 === f1 ? payOf(k, 'win', String(t1)) : 0, t1 === f1);
  const plc = (k.pay?.place || []).find(x => x.c === String(t1)); add(S, '◎複勝', 100, plc ? plc.y : 0, !!plc);
  add(S, '◎○馬連', 100, sortKey([t1, t2]) === q2 ? payOf(k, 'umaren', q2) : 0, sortKey([t1, t2]) === q2);
  add(S, '◎○馬単', 100, e2k === `${t1}-${t2}` ? payOf(k, 'umatan', e2k) : 0, e2k === `${t1}-${t2}`);
  for (const n of [3, 4, 5]) {
    const box = t.slice(0, n), hq = box.includes(f1) && box.includes(f2), hs = hq && box.includes(f3);
    if (n < 5) add(S, `${n}頭BOX馬連`, 100 * n * (n - 1) / 2, hq ? payOf(k, 'umaren', q2) : 0, hq);
    add(S, `${n}頭BOX三連複`, 100 * n * (n - 1) * (n - 2) / 6, hs ? payOf(k, 'sanpuku', s3) : 0, hs);
  }
  const h3 = t1 === f1 && [t2, t3, t4].includes(f2); add(S, '◎→○▲△ 馬単3点', 300, h3 ? payOf(k, 'umatan', e2k) : 0, h3);
  const h6 = h3 && [t2, t3, t4].includes(f3); add(S, '◎1着 三連単6点', 600, h6 ? payOf(k, 'santan', e3k) : 0, h6);
  const ai = p.ai || {};
  const aiBet = (name, keys, kind, code) => { if (!keys || !keys.length) return; const h = keys.includes(code); add(S, name, 100 * keys.length, h ? payOf(k, kind, code) : 0, h); };
  aiBet('AI 馬連 上位3点', ai.umaren3, 'umaren', q2); aiBet('AI 三連複 上位3点', ai.sanpuku3, 'sanpuku', s3); aiBet('AI 三連単 上位5点', ai.santan5, 'santan', e3k);
  if (p.pop1) add(S, '［基準］1番人気の単勝', 100, p.pop1 === f1 ? payOf(k, 'win', String(f1)) : 0, p.pop1 === f1);
  return S;
}
const merge = (A, B) => { A.races += B.races; A.hit1 += B.hit1; A.in3 += B.in3; for (const b of BETS) { const x = A.bets[b], y = B.bets[b]; x.n += y.n; x.hit += y.hit; x.bet += y.bet; x.ret += y.ret; } };
const fin = S => ({ races: S.races, hit1: S.races ? +(S.hit1 / S.races).toFixed(3) : null, in3: S.races ? +(S.in3 / S.races).toFixed(3) : null,
  bets: Object.fromEntries(BETS.map(b => { const x = S.bets[b]; return [b, { n: x.n, hit: x.n ? +(x.hit / x.n).toFixed(3) : null, bet: x.bet, ret: x.ret, roi: x.bet ? +(x.ret / x.bet).toFixed(3) : null }]; })) });
const out = { built: new Date().toISOString(), bets: BETS, days: [], total: null };
const TOTAL = mk(); let matched = 0, pending = 0;
for (const date of dates) {
  const DAY = mk(); let late = 0, joint = 0;
  for (const p of preds.values()) {
    if (p.date !== date) continue;
    const k = K.get(p.raceId); if (!k) { pending++; continue; }
    const S = settle(p, k); if (!S) { pending++; continue; }
    matched++; merge(DAY, S); merge(TOTAL, S); if (p.late > 60) late++; if (p.level === 'joint') joint++;
  }
  out.days.push({ date, late, joint, ...fin(DAY) });
}
out.total = fin(TOTAL);
out.note = '予想は発走後に記録したもの（late＝発走から60分以上あとに記録したレース数。再現＝後から同じ入力で作り直したもの）。払戻は地方競馬情報サイトの成績ページ。';
writeJSON('data/banei/results.json', out);
const T = out.total;
console.error(`${dates.length}日 ${matched}R を精算（未確定 ${pending}R）。◎的中 ${T.hit1 != null ? (T.hit1 * 100).toFixed(1) : '—'}%／◎単勝 回収 ${T.bets['◎単勝'].roi != null ? (T.bets['◎単勝'].roi * 100).toFixed(1) : '—'}%`);
