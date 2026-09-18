/* 含水率・クッション値と結果の関係をまとめる → data/jra/baba_stats.json
   baba.jsonl（JRA公式の測定値。開催日ごと）と results.jsonl（1レース1行）を 日付＋場 で突き合わせる。
   測定は金曜午前と土日の早朝なので「その日の朝の馬場」。レース直前の値ではない点に注意。
   出すもの（芝・ダートを分けて、含水率の帯ごとに）
     馬場状態の内訳／1番人気の勝率・複勝率／勝ち馬の人気／三連単の平均配当と万馬券率
     勝ち馬の4角位置（0が先頭・1が最後方＝前で決まるか）／勝ち馬の上がり3F／勝ち時計の偏差（同じ場・距離の平均との差）
   さらに クッション値の帯（芝）、馬場状態ごとの含水率の分布、場ごとの平均も出す。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON } from './lib/jra.mjs';

const jl = f => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const baba = new Map(jl('data/jra/baba.jsonl').map(o => [`${o.date}|${o.venue}`, o]));
const results = jl('data/jra/results.jsonl');
console.error(`測定 ${baba.size} 日分 ／ 結果 ${results.length} レース`);

/* 含水率の帯。芝とダートで水準が違う（芝は 10〜15% が並、ダートは 4〜9% が並） */
const BIN = {
  芝: [[0, 10, '〜10%（乾）'], [10, 12, '10〜12%'], [12, 14, '12〜14%'], [14, 16, '14〜16%'], [16, 99, '16%〜（湿）']],
  ダート: [[0, 4, '〜4%（乾）'], [4, 6, '4〜6%'], [6, 8, '6〜8%'], [8, 10, '8〜10%'], [10, 12, '10〜12%'], [12, 99, '12%〜（湿）']],
};
const CBIN = [[0, 8.5, '〜8.5（軟らかめ）'], [8.5, 9.5, '8.5〜9.5'], [9.5, 10.5, '9.5〜10.5'], [10.5, 99, '10.5〜（硬め）']];
const binOf = (bins, v) => v == null ? null : (bins.find(b => v >= b[0] && v < b[1]) || bins.at(-1))[2];

/* 場×距離×馬場種別の平均勝ちタイム（勝ち時計の偏差を出すため） */
const secOf = t => { const m = String(t || '').match(/(?:(\d+):)?(\d+)\.(\d)/); return m ? (Number(m[1] || 0) * 60 + Number(m[2]) + Number(m[3]) / 10) : null; };
const base = new Map();
for (const r of results) {
  const w = r.entries.find(e => e.pos === 1), t = secOf(w?.time);
  if (!t) continue;
  const k = `${r.venue}|${r.surface}|${r.dist}`;
  const v = base.get(k) || base.set(k, { s: 0, n: 0 }).get(k); v.s += t; v.n++;
}
const baseOf = r => { const v = base.get(`${r.venue}|${r.surface}|${r.dist}`); return v && v.n >= 20 ? v.s / v.n : null; };

const mk = () => ({ races: 0, baba: {}, fav: 0, favWin: 0, favTop3: 0, winPop: [], tri: [], man: 0, triN: 0, pass4: [], agari: [], dev: [], bw: [] });
const push = (S, r) => {
  S.races++;
  S.baba[r.baba] = (S.baba[r.baba] || 0) + 1;
  const w = r.entries.find(e => e.pos === 1);
  const fav = r.entries.filter(e => e.pop).sort((a, b) => a.pop - b.pop)[0];
  if (fav && fav.pop === 1) { S.fav++; if (fav.pos === 1) S.favWin++; if (fav.pos >= 1 && fav.pos <= 3) S.favTop3++; }
  if (w?.pop) S.winPop.push(w.pop);
  const t3 = (r.pay?.santan || [])[0]?.yen ?? (r.pay?.santan || [])[0]?.y ?? null;
  if (t3) { S.tri.push(t3); S.triN++; if (t3 >= 10000) S.man++; }
  if (w?.pass && r.n > 1) { const p = String(w.pass).split('-').map(Number).filter(Number.isFinite); if (p.length) S.pass4.push((p.at(-1) - 1) / (r.n - 1)); }
  if (w?.agari) S.agari.push(w.agari);
  const tt = secOf(w?.time), b = baseOf(r);
  if (tt && b) S.dev.push(tt - b);
  if (w?.bw) S.bw.push(w.bw);
};
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const r2 = (v, d = 2) => v == null ? null : Number(v.toFixed(d));
const fin = S => ({
  races: S.races, baba: S.baba,
  favWin: S.fav ? r2(S.favWin / S.fav, 3) : null, favTop3: S.fav ? r2(S.favTop3 / S.fav, 3) : null, favN: S.fav,
  winPop: r2(avg(S.winPop), 2), triAvg: S.triN ? Math.round(avg(S.tri)) : null, manRate: S.triN ? r2(S.man / S.triN, 3) : null,
  pass4: r2(avg(S.pass4), 3), agari: r2(avg(S.agari), 2), timeDev: r2(avg(S.dev), 2), winBw: S.bw.length ? Math.round(avg(S.bw)) : null,
  triMed: S.triN ? Math.round(med(S.tri)) : null,          // 平均は1本の大穴で動くので中央値も出す
});

const out = { built: new Date().toISOString(), days: baba.size, note: '含水率・クッション値は JRA 公式の測定値（金曜は午前、土日は早朝）。レース直前の値ではない。', bySurface: {}, byCushion: {}, babaMoist: {}, byVenue: {}, meta: {} };
let matched = 0, unmatched = 0;
const perRace = [];
for (const r of results) {
  const b = baba.get(`${r.date}|${r.venue}`);
  if (!b) { unmatched++; continue; }
  const surf = r.surface === '芝' ? '芝' : r.surface === 'ダ' || r.surface === 'ダート' ? 'ダート' : null;
  if (!surf) continue;
  const g = surf === '芝' ? b.turfGoal : b.dirtGoal, c = surf === '芝' ? b.turfCorner : b.dirtCorner;
  const moist = g != null && c != null ? (g + c) / 2 : g ?? c;
  if (moist == null) continue;
  matched++;
  perRace.push({ r, surf, moist, cushion: b.cushion });
}
console.error(`突き合わせ ${matched} レース（測定の無い日 ${unmatched}）`);
for (const surf of ['芝', 'ダート']) {
  const bins = {};
  for (const [, , label] of BIN[surf]) bins[label] = mk();
  for (const x of perRace) { if (x.surf !== surf) continue; const k = binOf(BIN[surf], x.moist); if (k) push(bins[k], x.r); }
  out.bySurface[surf] = Object.fromEntries(Object.entries(bins).filter(([, S]) => S.races).map(([k, S]) => [k, fin(S)]));
  /* 馬場状態ごとの含水率の分布 */
  const bm = {};
  for (const x of perRace) { if (x.surf !== surf) continue; const k = x.r.baba || '?'; (bm[k] || (bm[k] = [])).push(x.moist); }
  out.babaMoist[surf] = Object.fromEntries(Object.entries(bm).map(([k, a]) => [k, { n: a.length, avg: r2(avg(a)), min: r2(Math.min(...a)), max: r2(Math.max(...a)) }]));
  /* 場ごとの平均含水率 */
  const bv = {};
  for (const x of perRace) { if (x.surf !== surf) continue; (bv[x.r.venue] || (bv[x.r.venue] = [])).push(x.moist); }
  out.byVenue[surf] = Object.fromEntries(Object.entries(bv).sort().map(([k, a]) => [k, { n: a.length, avg: r2(avg(a)) }]));
}
/* クッション値（芝のみ。2020-09 から） */
{
  const bins = {}; for (const [, , label] of CBIN) bins[label] = mk();
  for (const x of perRace) { if (x.surf !== '芝' || x.cushion == null) continue; const k = binOf(CBIN, x.cushion); if (k) push(bins[k], x.r); }
  out.byCushion = Object.fromEntries(Object.entries(bins).filter(([, S]) => S.races).map(([k, S]) => [k, fin(S)]));
}
out.meta = { races: matched, from: perRace[0]?.r.date, to: perRace.at(-1)?.r.date };
writeJSON('data/jra/baba_stats.json', out);
const line = (t, o) => console.error(`  ${t.padEnd(14)} ${String(o.races).padStart(5)}R  1番人気 ${o.favWin != null ? (o.favWin * 100).toFixed(1) : '—'}%  勝ち馬の4角 ${o.pass4}  上がり ${o.agari}  時計差 ${o.timeDev}  三連単 中央 ${o.triMed}・万馬券 ${o.manRate != null ? (o.manRate * 100).toFixed(0) : '—'}%`);
for (const surf of ['芝', 'ダート']) { console.error(`\n== ${surf}（含水率）`); for (const [k, o] of Object.entries(out.bySurface[surf])) line(k, o); }
console.error('\n== 芝（クッション値）'); for (const [k, o] of Object.entries(out.byCushion)) line(k, o);
