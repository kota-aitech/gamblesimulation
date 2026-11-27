#!/usr/bin/env node
// ジャパンカップ当日の馬場の見立て → data/jc/weather.json（jc_build がページに載せる）
//   予報：Open-Meteo（気象庁 MSM／ECMWF／GFS の3モデル。キー不要）を1時間キャッシュ
//   過去：Open-Meteo の再解析（ERA5）の毎時の降水量 × data/jra/results.jsonl の東京・芝の馬場状態 × baba.jsonl の含水率・クッション値
//   「前日に雨が上がった日に、東京の芝は当日どこまで戻ったか」を数えるだけ。予測モデルではない
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT, DAY, readJSON, writeJSON } from './lib/jc.mjs';

const LAT = 35.6627, LON = 139.4847;                    // 東京競馬場（府中）
const START_H = 15.67;                                  // 発走 15:40
const MODELS = [['jma_seamless', '気象庁'], ['ecmwf_ifs025', 'ECMWF'], ['gfs_seamless', 'GFS']];
const CACHE = path.join(ROOT, 'data/cache/jc');
fs.mkdirSync(CACHE, { recursive: true });
const addDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const PREV = addDay(DAY, -1);

async function cached(name, url, ttlMin) {
  const f = path.join(CACHE, name);
  try { if (Date.now() - fs.statSync(f).mtimeMs < ttlMin * 6e4) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 無ければ取る */ }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json(); if (!j.hourly?.time?.length) throw new Error('中身が無い');
    fs.writeFileSync(f + '.tmp', JSON.stringify(j)); fs.renameSync(f + '.tmp', f); return j;
  } catch (e) {
    console.error(`  ! ${name}: ${e.message}`);
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }      // 古くても前の版を使う
  }
}

/* ---------- 予報 ---------- */
const fc = await cached('forecast.json', `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=precipitation,temperature_2m,wind_speed_10m,cloud_cover&timezone=Asia%2FTokyo&start_date=${addDay(DAY, -2)}&end_date=${DAY}&models=${MODELS.map(m => m[0]).join(',')}`, 60);
let forecast = null;
if (fc) {
  const h = fc.hourly, T = h.time;
  const models = MODELS.map(([k, name]) => {
    const p = h['precipitation_' + k] || []; if (!p.some(x => x != null)) return null;
    const win = T.map((t, i) => ({ t, p: p[i] || 0 })).filter(x => x.t >= addDay(DAY, -2) + 'T18:00' && x.t <= DAY + 'T16:00');
    const rainy = win.filter(x => x.p >= 0.3);
    const end = rainy.at(-1)?.t || null;                 // 最後に 0.3mm 以上降る時刻
    const sumOf = f => +win.filter(f).reduce((a, x) => a + x.p, 0).toFixed(1);
    return { key: k, name, total: sumOf(() => true), prevDay: sumOf(x => x.t.startsWith(PREV)), raceDay: sumOf(x => x.t.startsWith(DAY)),
      start: rainy[0]?.t || null, end, dryHours: end ? +((Date.parse(DAY + 'T00:00:00Z') + START_H * 36e5 - Date.parse(end + ':00Z') - 36e5) / 36e5).toFixed(0) : null };
  }).filter(Boolean);
  const k0 = MODELS.map(m => m[0]).find(k => (h['temperature_2m_' + k] || []).some(x => x != null));
  const at = (t, f) => { const i = T.indexOf(t); return i < 0 ? null : h[f + '_' + k0]?.[i] ?? null; };
  const hours = T.map((t, i) => ({ t, p: MODELS.map(([k]) => h['precipitation_' + k]?.[i] ?? null) })).filter(x => x.t >= PREV + 'T00:00' && x.t <= DAY + 'T16:00');
  forecast = { models, hours, modelNames: MODELS.map(m => m[1]),
    sat: { temp: at(PREV + 'T14:00', 'temperature_2m'), cloud: at(PREV + 'T14:00', 'cloud_cover'), wind: at(PREV + 'T14:00', 'wind_speed_10m') },
    race: { temp: at(DAY + 'T15:00', 'temperature_2m'), cloud: at(DAY + 'T15:00', 'cloud_cover'), wind: at(DAY + 'T15:00', 'wind_speed_10m') },
    fetchedAt: new Date(fs.statSync(path.join(CACHE, 'forecast.json')).mtimeMs).toISOString() };
}

/* ---------- 過去：雨上がりの東京の芝 ---------- */
const eraTo = addDay(new Date().toISOString().slice(0, 10), -6);       // 再解析は5日ほど遅れる
const era = await cached('era5.json', `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}&start_date=2021-01-01&end_date=${eraTo}&hourly=precipitation&timezone=Asia%2FTokyo`, 60 * 24 * 30);
let past = null;
if (era && fs.existsSync(path.join(ROOT, 'data/jra/results.jsonl'))) {
  const P = new Map(era.hourly.time.map((t, i) => [t, era.hourly.precipitation[i] || 0]));
  const eraEnd = era.hourly.time.at(-1).slice(0, 10);
  const hr = (d, h) => P.get(new Date(Date.parse(d + 'T00:00:00Z') + h * 36e5).toISOString().slice(0, 13) + ':00') || 0;
  const sum = (d, h0, h1) => { let s = 0; for (let h = h0; h < h1; h++) s += hr(d, h); return s; };
  const sec = t => { const m = /^(\d):(\d\d\.\d)$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
  const days = new Map(), races = [];
  for await (const l of readline.createInterface({ input: fs.createReadStream(path.join(ROOT, 'data/jra/results.jsonl')) })) {
    if (!l.includes('"東京"')) continue; const r = JSON.parse(l); if (r.venue !== '東京' || r.surface !== '芝') continue;
    if (!days.has(r.date)) days.set(r.date, []); days.get(r.date).push({ r: r.r, baba: r.baba });
    const w = (r.entries || []).find(x => x.pos === 1), t = sec(w?.time); if (!t) continue;
    const ag = r.entries.map(x => x.agari).filter(Boolean).sort((a, b) => a - b);
    const cls = /未勝利|新馬/.test(r.name) ? 'm' : /勝クラス/.test(r.name + (r.cond || '')) ? 'c' : 'o';
    races.push({ d: r.date, k: r.dist + cls, t, ag: ag[0], p4: w.pass ? +w.pass.split('-').pop() / r.n : null, baba: r.baba });
  }
  const BB = new Map(); for (const l of fs.readFileSync(path.join(ROOT, 'data/jra/baba.jsonl'), 'utf8').split('\n')) { if (!l) continue; const b = JSON.parse(l); if (b.venue === '東京') BB.set(b.date, b); }
  const rows = [];
  for (const [d, rs] of [...days].sort()) {
    if (d > eraEnd) continue; rs.sort((a, b) => a.r - b.r);
    const amt = sum(d, -30, 0), today = sum(d, 0, 16);          // 前々日18時〜前日24時／当日0〜16時
    let end = null; for (let h = -1; h >= -30; h--) if (hr(d, h) >= 0.3) { end = h; break; }       // 当日0時から数えて何時間前まで降っていたか
    const seq = rs.map(x => x.baba), b = BB.get(d) || {};
    rows.push({ date: d, amt: +amt.toFixed(1), today: +today.toFixed(1), endHour: end == null ? null : 24 + end, d3: sum(d, -72, 16), first: seq[0], last: seq.at(-1), nNotGood: seq.filter(x => x !== '良').length, n: seq.length, moist: b.turfGoal ?? null, cushion: b.cushion ?? null });
  }
  // 区分：前日の正午までに上がった／前日の午後〜夜まで降った（どちらも 10mm 以上・当日は降らず）
  const wetDays = rows.filter(x => x.amt >= 10 && x.today < 0.5 && x.endHour != null);
  const grp = (name, f) => { const a = wetDays.filter(f); return { name, days: a.length, goodAll: a.filter(x => x.nNotGood === 0).length, recover: a.filter(x => x.nNotGood > 0 && x.last === '良').length, stay: a.filter(x => x.last !== '良').length,
    list: a.map(({ d3, ...x }) => x) }; };
  const groups = [grp('am', x => x.endHour <= 12), grp('pm', x => x.endHour > 12)];
  // 雨上がりの「良」は乾いた「良」と時計が違うか（同じ距離・同じクラス帯の良の平均との差）
  const by = {}; for (const r of races) if (r.baba === '良') (by[r.k] ??= []).push(r);
  const base = {}; for (const k in by) if (by[k].length >= 8) base[k] = { t: by[k].reduce((a, x) => a + x.t, 0) / by[k].length, ag: by[k].reduce((a, x) => a + x.ag, 0) / by[k].length };
  const kind = new Map(rows.map(x => [x.date, x.today >= 0.5 ? null : x.d3 < 1 ? 'dry' : x.amt >= 10 ? 'wet' : null]));
  const cmp = {};
  for (const r of races) { const c = kind.get(r.d), b = base[r.k]; if (!c || !b || r.baba !== '良') continue; const a = cmp[c] ??= { n: 0, dt: 0, dag: 0, p4: 0, np: 0, days: new Set() };
    a.n++; a.days.add(r.d); a.dt += r.t - b.t; a.dag += r.ag - b.ag; if (r.p4 != null) { a.p4 += r.p4; a.np++; } }
  const fin = a => a ? { days: a.days.size, n: a.n, dt: +(a.dt / a.n).toFixed(2), dag: +(a.dag / a.n).toFixed(2), p4: +(a.p4 / a.np).toFixed(3) } : null;
  const avg = (a, f) => { const v = a.map(f).filter(x => x != null); return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : null; };
  const dry = rows.filter(x => kind.get(x.date) === 'dry'), wet = rows.filter(x => kind.get(x.date) === 'wet' && x.nNotGood === 0);
  past = { from: rows[0]?.date, to: rows.at(-1)?.date, days: rows.length, groups,
    good: { dry: { ...fin(cmp.dry), moist: avg(dry, x => x.moist), cushion: avg(dry, x => x.cushion) }, wet: { ...fin(cmp.wet), moist: avg(wet, x => x.moist), cushion: avg(wet, x => x.cushion) } } };
}

/* ---------- 今週の実測（出たら載せる） ---------- */
const actual = {};
try {
  for (const l of fs.readFileSync(path.join(ROOT, 'data/jra/baba.jsonl'), 'utf8').split('\n')) { if (!l.includes('"東京"')) continue; const b = JSON.parse(l);
    if (b.venue === '東京' && b.date >= addDay(DAY, -2) && b.date <= DAY) actual[b.date] = { moist: b.turfGoal ?? null, cushion: b.cushion ?? null }; }
} catch { /* まだ無い */ }

if (!forecast && !past) { console.error('予報も過去も取れないので、前の weather.json を残す'); process.exit(2); }
const prev = readJSON('data/jc/weather.json');
const out = { place: '東京競馬場（府中市）', day: DAY, prevDay: PREV, forecast: forecast || prev?.forecast || null, past: past || prev?.past || null, actual,
  sources: { forecast: 'https://open-meteo.com/en/docs', era5: 'https://open-meteo.com/en/docs/historical-weather-api' } };
if (prev && JSON.stringify({ ...prev, builtAt: 0 }) === JSON.stringify({ builtAt: 0, ...out })) { console.log('変化なし'); process.exit(0); }
writeJSON('data/jc/weather.json', { builtAt: new Date().toISOString(), ...out });
const m = out.forecast?.models?.[0];
console.log(`-> data/jc/weather.json 予報 ${m ? `${m.name} ${m.total}mm・${m.end || '降らない'}まで` : 'なし'}／過去 ${out.past ? out.past.groups.map(g => `${g.name}:${g.days}日`).join(' ') : 'なし'}`);
