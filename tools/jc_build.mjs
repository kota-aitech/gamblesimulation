#!/usr/bin/env node
// ジャパンカップ特設ページのデータ → data/jc/jc.json → jc.html（JC マーカー）
//   出馬表と予想は data/jra/races.json（中央の本番のモデルそのまま。別式を作らない）
//   外国馬の資料は data/jc/foreign.json（jc_fetch）。過去の実測は data/jra/results.jsonl と horses.jsonl
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT, RACE_ID, DAY, YEAR, SOURCES, KANA_EN, readJSON, writeJSON } from './lib/jc.mjs';
import { inject } from './lib/embed.mjs';

const F = readJSON('data/jc/foreign.json'); if (!F) { console.error('data/jc/foreign.json が無い（先に jc_fetch）'); process.exit(1); }
const VIEWS = readJSON('data/jc/views.json', {});
const R = readJSON('data/jra/races.json');
let race = null; for (const d of R?.days || []) for (const v of d.venues || []) for (const r of v.races || []) if (r.raceId === RACE_ID) race = { ...r, date: d.date, venue: v.name || v.venue };
const prevOut = readJSON('data/jc/jc.json');
if (!race && prevOut?.race) race = prevOut.race;       // 出馬表が races.json から外れたあと（レース後）は最後の版を残す
if (!race) { console.error(`races.json に ${RACE_ID} が無い`); process.exit(1); }

/* ---------- 過去の結果を1回なめる ---------- */
const HORSE = new Map();
for (const l of fs.readFileSync(path.join(ROOT, 'data/jra/horses.jsonl'), 'utf8').split('\n')) { if (!l) continue; try { const h = JSON.parse(l); HORSE.set(h.horseId, h); } catch {} }
const foreign = F.horses;
const pedNames = new Set(); for (const h of foreign) for (const n of [h.sire, h.grandsire, h.damsire, KANA_EN[h.damsireKana], h.damsireKana, h.sireKana]) if (n) pedNames.add(n);
const ped = {}; for (const n of pedNames) ped[n] = { sire: mk(), damsire: mk() };
function mk() { return { turf: z(), long: z(), tokyo: z(), dirt: z(), winDist: [], horses: new Set(), g1: [] }; }
function z() { return { n: 0, w: 0, t3: 0 }; }
const add = (o, pos) => { o.n++; if (pos === 1) o.w++; if (pos <= 3) o.t3++; };
const base = { turf: z(), long: z() };
const jcPast = []; const bwBand = {}; const BANDS = [[0, 459, '〜459kg'], [460, 479, '460〜479kg'], [480, 499, '480〜499kg'], [500, 519, '500〜519kg'], [520, 999, '520kg〜']];
const isForeignId = id => /^\d{4}19\d{4}$/.test(id || '');
const rl = readline.createInterface({ input: fs.createReadStream(path.join(ROOT, 'data/jra/results.jsonl')) });
let from = '9999', to = '0000', nRaces = 0;
for await (const l of rl) {
  if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; }
  if (r.surface === '障' || /障害/.test(r.cond || '')) continue;
  nRaces++; if (r.date < from) from = r.date; if (r.date > to) to = r.date;
  const isJC = r.venue === '東京' && r.dist === 2400 && r.surface === '芝' && /^ジャパン(カップ|C)$/.test(r.name || '');
  const tokyo2400 = r.venue === '東京' && r.dist === 2400 && r.surface === '芝';
  const fin = (r.entries || []).filter(e => typeof e.pos === 'number');
  for (const e of fin) {
    if (r.surface === '芝') { add(base.turf, e.pos); if (r.dist >= 2200) add(base.long, e.pos); }
    const h = HORSE.get(e.horseId);
    if (h) for (const [role, nm] of [['sire', h.sire], ['damsire', h.damsire]]) {
      const p = ped[nm]?.[role]; if (!p) continue;
      p.horses.add(e.horseId);
      if (r.surface === '芝') { add(p.turf, e.pos); if (r.dist >= 2200) add(p.long, e.pos); if (r.venue === '東京') add(p.tokyo, e.pos); if (e.pos === 1) p.winDist.push(r.dist); }
      else add(p.dirt, e.pos);
      if (e.pos === 1 && r.grade === 'GI') p.g1.push(`${r.date.slice(0, 4)} ${r.name}（${e.name}）`);
    }
    if (tokyo2400 && e.bw) { const b = BANDS.find(b => e.bw >= b[0] && e.bw <= b[1])[2]; add(bwBand[b] ||= z(), e.pos); }
  }
  if (isJC) {
    const ag = fin.map(e => e.agari).filter(Boolean).sort((a, b) => a - b); const sec = t => { const m = String(t || '').match(/(\d):(\d\d)\.(\d)/); return m ? +m[1] * 60 + +m[2] + +m[3] / 10 : null; };
    const win = fin.find(e => e.pos === 1);
    jcPast.push({ year: +r.date.slice(0, 4), date: r.date, baba: r.baba, n: fin.length, time: win?.time, laps: r.laps || null,
      first1000: r.laps ? +(r.laps.slice(0, 5).reduce((a, b) => a + b, 0)).toFixed(1) : null,
      top3: fin.filter(e => e.pos <= 3).map(e => ({ pos: e.pos, name: e.name, sexAge: e.sexAge, pop: e.pop, agari: e.agari, agariRank: e.agari ? ag.indexOf(e.agari) + 1 : null, pass4: +(String(e.pass || '').split('-').pop()) || null, bw: e.bw, foreign: isForeignId(e.horseId) })),
      foreign: fin.filter(e => isForeignId(e.horseId)).map(e => ({ pos: e.pos, name: e.name, pop: e.pop, odds: e.odds, time: e.time, behind: win ? +(sec(e.time) - sec(win.time)).toFixed(1) : null, agari: e.agari, agariRank: e.agari ? ag.indexOf(e.agari) + 1 : null, pass4: +(String(e.pass || '').split('-').pop()) || null, trainer: e.trainer, jockey: e.jockey })) });
  }
}
jcPast.sort((a, b) => b.year - a.year);
const rate = o => ({ n: o.n, w: o.w, t3: o.t3, wr: o.n ? +(o.w / o.n).toFixed(3) : null, t3r: o.n ? +(o.t3 / o.n).toFixed(3) : null });
const pedOut = {};
for (const [n, v] of Object.entries(ped)) { pedOut[n] = {}; for (const role of ['sire', 'damsire']) { const p = v[role]; const wd = p.winDist.slice().sort((a, b) => a - b);
  pedOut[n][role] = { horses: p.horses.size, turf: rate(p.turf), long: rate(p.long), tokyo: rate(p.tokyo), dirt: rate(p.dirt), winDistMed: wd.length ? wd[wd.length >> 1] : null, g1: [...new Set(p.g1)].slice(-6) }; } }

/* ---------- 外国馬ごとの集計 ---------- */
const wOf = no => F.weights?.rows.find(w => w.no === no) || null;
const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const jcTimes = jcPast.filter(j => j.baba === '良' && j.time).map(j => j.time);
const outF = foreign.map(h => {
  const card = race.horses.find(x => x.name === h.name) || {};
  const flat = (h.runs || []).filter(r => r.surface !== '障');
  const turf = flat.filter(r => r.surface === '芝');
  const cnt = rs => ({ n: rs.length, w: rs.filter(r => r.pos === 1).length, t3: rs.filter(r => r.pos <= 3).length });
  const d24 = turf.filter(r => r.dist >= 2350 && r.dist <= 2450);
  const best = d24.filter(r => r.baba === '良').map(r => ({ ...r, sec: +r.time[0] * 60 + +r.time.slice(2) })).sort((a, b) => a.sec - b.sec)[0];
  const last = flat[0];
  const my = {
    turf: cnt(turf), good: cnt(turf.filter(r => r.baba === '良')), soft: cnt(turf.filter(r => r.baba && r.baba !== '良')),
    left: cnt(turf.filter(r => r.turn === '左')), right: cnt(turf.filter(r => r.turn === '右')), d2400: cnt(d24),
    g1: cnt(turf.filter(r => r.grade === '1')), big: cnt(turf.filter(r => r.n >= 14)),
    countries: [...new Set(flat.map(r => r.country))], away: cnt(flat.filter(r => r.country && r.country !== flat[flat.length - 1]?.country)),
    japan: flat.filter(r => r.country === '日').map(r => ({ date: r.date, name: r.name, pos: r.pos, time: r.time, n: r.n, bw: r.bw })),
    best2400: best ? { time: best.time, venue: best.venue, date: best.date, name: best.name, pos: best.pos } : null,
    last: last ? { date: last.date, name: last.name, venue: last.venue, pos: last.pos, n: last.n, dist: last.dist, baba: last.baba, days: dayDiff(last.date, DAY) } : null,
    season: cnt(flat.filter(r => r.date.startsWith(String(YEAR)))),
    bwPast: flat.filter(r => r.bw).map(r => ({ date: r.date, bw: r.bw, pos: r.pos })),
  };
  const w = wOf(card.no);
  const tr = F.training.map(t => ({ date: t.date, cond: t.cond, url: t.url, ...(t.horses.find(x => x.name === h.name) || {}) })).filter(t => t.menu || t.comment);
  const pk = n => n && pedOut[n] ? { name: n, ...pedOut[n] } : (n ? { name: n } : null);
  const { runs, ...rest } = h;
  return { ...rest, runs: (runs || []).map(r => ({ ...r, name: r.name.replace(/ステー$/, 'ステークス') })), no: card.no ?? null, waku: card.waku ?? null, kin: card.kin ?? null, cardJockey: card.jockey ?? null, odds: card.odds ?? null, pop: card.pop ?? null, p1: card.p1 ?? null, top3: card.top3 ?? null, mark: card.mark || '',
    bwNow: w ? { bw: w.bw, day: w.day, place: w.place } : null, my, training: tr,
    ped: { sire: pk(h.sire), grandsire: pk(h.grandsire), damsire: pk(KANA_EN[h.damsireKana] || h.damsire) }, view: VIEWS[h.en] || null };
});

/* ---------- 出馬表（18頭） ---------- */
const fkey = new Map(outF.map(h => [h.name, h]));
const card = race.horses.map(h => { const f = fkey.get(h.name); const w = wOf(h.no);
  return { no: h.no, waku: h.waku, name: h.name, sexAge: h.sexAge || f?.sexAge || null, kin: h.kin, jockey: h.jockey, trainer: h.trainer, stable: h.stable, sire: h.sire || f?.sire || null, damsire: h.damsire || f?.damsire || null,
    odds: h.odds, pop: h.pop, mark: h.mark || '', p1: h.p1, top3: h.top3, style: h.style || null, foreign: f ? f.key : null, country: f?.country || null,
    bw: w?.bw ?? null, bwPrev: w?.prev ?? null, bwNote: w?.prevNote ?? null, bwGood: h.bwGood ?? null, nPast: (h.past || []).length,
    last: h.past?.[0] ? { date: h.past[0].date, venue: h.past[0].venue, name: h.past[0].name, pos: h.past[0].pos, pop: h.past[0].pop } : (f?.my.last ? { date: f.my.last.date, venue: f.my.last.venue, name: f.my.last.name, pos: f.my.last.pos, pop: null } : null),
    note: (h.note || []).slice(0, 2) };
});
const nPred = card.filter(c => c.foreign).map(c => race.horses.find(h => h.no === c.no)).filter(h => !(h.past || []).length).length;
const out = { year: YEAR, day: DAY, raceId: RACE_ID, sources: { ...SOURCES, weights: F.weights?.url || null },
  race: { name: race.name, grade: race.grade, date: race.date, start: race.start, surface: race.surface, dist: race.dist, turn: race.turn, cond: race.cond, n: race.n, weather: race.weather, baba: race.baba, level: race.level, oddsSrc: race.oddsSrc, gates: race.gates,
    box3: race.box3, box4: race.box4, umaren: race.umaren, sanpuku: race.sanpuku, points: race.points, conf: race.conf, rank: race.rank, horses: race.horses },
  card, foreignNoPast: nPred, foreign: outF, jcPast, bwBand: BANDS.map(b => ({ band: b[2], ...rate(bwBand[b[2]] || z()) })), base: { turf: rate(base.turf), long: rate(base.long) },
  data: { from, to, races: nRaces, horses: HORSE.size }, jcTimes, fetchedAt: F.fetchedAt };
// 予想の元データ（race.horses の past など）はページでは使わないので落とす
out.race.horses = undefined;
const same = prevOut && JSON.stringify({ ...prevOut, builtAt: 0 }) === JSON.stringify({ ...out, builtAt: 0 });
if (!same) writeJSON('data/jc/jc.json', { builtAt: new Date().toISOString(), ...out });
const cur = same ? prevOut : { builtAt: new Date().toISOString(), ...out };
if (fs.existsSync(path.join(ROOT, 'jc.html'))) { try { inject('jc.html', 'JC', 'JC', cur); } catch (e) { console.error('  ! jc.html: ' + e.message); process.exitCode = 1; } }
console.log(`-> data/jc/jc.json ${same ? '（変化なし）' : ''} 出走${card.length}頭／外国馬${outF.length}頭／過去のJC ${jcPast.length}回`);
