/* JRA の出馬表を取り込む → data/jra/cards.jsonl（1レース1行、raceId で差し替え）
     JRA_FROM / JRA_TO … YYYYMMDD（既定 今日〜3日後。土日の開催ぶん）
     JRA_SRC          … yahoo（既定）| netkeiba
   Yahoo の出馬表には前5走が無いので、results.jsonl から馬IDで前走を組み立てて past に入れる
   （netkeiba の馬柱と同じ形：日付・場・着順・レース名・芝ダ距離・タイム・馬場・頭数・馬番・人気・騎手・斤量・通過順・上がり・馬体重・勝ち馬・着差）。
   枠順は木〜金に確定するので、それより前は枠・馬番が空のことがある（取り直せば埋まる）。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, get, RACE, ymdOf, dateRange, upsertJsonl } from './lib/jra.mjs';
import { parseCalendar, parseRaceList, parseShutubaPast } from './lib/jrapage.mjs';
import { YAHOO, parseMonthly, parseList, parseDenma, toId10 } from './lib/yahoo.mjs';

const d0 = new Date(), d1 = new Date(); d1.setDate(d1.getDate() + 3);
/* JRA_SOON=<分> … 今日の、発走が SOON 分以内に迫ったレースだけをキャッシュを使わずに取る（refresh_jra が発走前の記録の直前に呼ぶ。
   全レースを取り直すと3日ぶんで約5分かかり、そのぶん記録が遅れる） */
const SOON = process.env.JRA_SOON ? Number(process.env.JRA_SOON) : null;
const FROM = SOON != null ? ymdOf(d0) : process.env.JRA_FROM || ymdOf(d0);
const TO = SOON != null ? ymdOf(d0) : process.env.JRA_TO || ymdOf(d1);
const minsTo = (date, hm) => (new Date(`${date}T${hm.padStart(5, '0')}:00`) - Date.now()) / 60000;
const SRC = process.env.JRA_SRC || 'yahoo';

/* 結果DBから馬ごとの履歴（新しい順）を引く */
const hist = new Map();
{
  const f = path.join(ROOT, 'data/jra/results.jsonl');
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l) continue;
    const r = JSON.parse(l);
    const win = r.entries.find(e => e.pos === 1);
    for (const e of r.entries) {
      if (!e.horseId || typeof e.pos !== 'number') continue;             // 取消・除外・中止は履歴に入れない
      (hist.get(e.horseId) || hist.set(e.horseId, []).get(e.horseId)).push({
        date: r.date, venue: r.venue, pos: e.pos, raceId: r.raceId, name: r.name, surface: r.surface, dist: r.dist, time: e.time, baba: r.baba,
        n: r.n, no: e.no, pop: e.pop, odds: e.odds, jockey: e.jockey, jockeyId: e.jockeyId, kin: e.kin, pass: e.pass, agari: e.agari, bw: e.bw, bwDiff: e.bwDiff,
        winner: win ? win.name : null, margin: e.pos === 1 ? null : e.margin, winTime: win ? win.time : null, laps: r.laps, pace: r.pace,
      });
    }
  }
  for (const a of hist.values()) a.sort((x, y) => y.date.localeCompare(x.date));
}
const pastOf = (horseId, before) => (hist.get(horseId) || []).filter(p => p.date < before).slice(0, 5);

const buf = [];
let n = 0;
if (SRC === 'yahoo') {
  const months = [...new Set([...dateRange(FROM, TO)].map(d => d.slice(0, 6)))];
  for (const ym of months) {
    const ks = parseMonthly(await get(`${YAHOO}/keiba/schedule/monthly?year=${+ym.slice(0, 4)}&month=${+ym.slice(4, 6)}`, { ttlDays: 0.5, referer: YAHOO + '/keiba/' }));
    for (const k of ks) {
      const list = parseList(await get(`${YAHOO}/keiba/race/list/${k}`, { ttlDays: SOON != null ? 0.5 : 0.02,   // SOON のときは発走時刻が分かれば足りるので一覧はキャッシュでよい（月の全開催ぶん取り直すと1分半かかる）
        referer: YAHOO + '/keiba/' }), k);
      if (!list.date) continue;
      const ymd = list.date.replace(/-/g, '');
      if (ymd < FROM || ymd > TO) continue;
      for (const r of list.races) {
        if (SOON != null && !(r.start && (m => m >= -3 && m <= SOON)(minsTo(list.date, r.start)))) continue;
        try {
          const card = parseDenma(await get(`${YAHOO}/keiba/race/denma/${toId10(r.raceId)}`, { ttlDays: SOON != null ? 0 : 0.02, referer: `${YAHOO}/keiba/race/list/${k}` }), r.raceId);
          if (!card.entries.length) continue;
          for (const e of card.entries) e.past = pastOf(e.horseId, list.date);
          buf.push({ ...card, date: list.date });
          n++;
        } catch (e) { console.error(`  ! ${r.raceId} ${e.message}`); }
      }
      console.error(`  ${list.date} ${list.venue} ${list.races.length}R`);
    }
  }
} else {
  const days = new Set();
  for (const ym of new Set([...dateRange(FROM, TO)].map(d => d.slice(0, 6)))) {
    const html = await get(`${RACE}/top/calendar.html?year=${+ym.slice(0, 4)}&month=${+ym.slice(4, 6)}`, { ttlDays: 1 });
    for (const d of parseCalendar(html)) if (d >= FROM && d <= TO) days.add(d);
  }
  for (const d of [...days].sort()) {
    const list = parseRaceList(await get(`${RACE}/top/race_list_sub.html?kaisai_date=${d}`, { ttlDays: 0.02 }));
    for (const r of list) {
      try {
        const card = parseShutubaPast(await get(`${RACE}/race/shutuba_past.html?race_id=${r.raceId}`, { ttlDays: 0.02 }), r.raceId);
        if (!card.entries.length) continue;
        buf.push({ ...card, date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` });
        n++;
      } catch (e) { console.error(`  ! ${r.raceId} ${e.message}`); }
    }
    console.error(`  ${d} ${list.length}R`);
  }
}
const total = upsertJsonl('data/jra/cards.jsonl', buf);
console.error(`完了: ${n}R 取得 -> data/jra/cards.jsonl（累計 ${total}R）`);
