/* ばんえい（帯広）の結果と出馬表を日付範囲で取り込む → data/banei/results.jsonl / cards.jsonl（1レース1行、raceId で差し替え）
     BN_FROM / BN_TO … YYYYMMDD（既定 直近30日〜今日）
     BN_KIND        … results | cards | both（既定 both）。cards は血統・馬主・当日の馬体重・前5走（馬場水分つき）の元
     BN_REFETCH=1   … 取得済みのレースも取り直す
   月別開催日程 → 各開催日の当日メニュー（馬場水分・頭数・取消）→ 各レースの成績／出馬表。1リクエスト2秒。
   開催日は 帯広ば の行だけを見る（他場は取らない）。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, get, freshTtl, ymdOf, urlOf, monthlyUrl, upsertJsonl, stats } from './lib/bn.mjs';
import { parseMonthly, parseRaceList, parseResult, parseCard } from './lib/bnpage.mjs';

const d0 = new Date(); d0.setDate(d0.getDate() - 30);
const FROM = process.env.BN_FROM || ymdOf(d0);
const TO = process.env.BN_TO || ymdOf(new Date());
const KIND = process.env.BN_KIND || 'both';
const TODAY = ymdOf(new Date());
const have = (rel) => {
  const s = new Set();
  const f = path.join(ROOT, rel);
  if (!process.env.BN_REFETCH && fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const m = l.match(/^\{"raceId":"(\d{10})"/); if (m) s.add(m[1]); }
  return s;
};
const haveR = have('data/banei/results.jsonl'), haveC = have('data/banei/cards.jsonl');
console.error(`${FROM}〜${TO}（${KIND}）取得済み 成績 ${haveR.size}R／出馬表 ${haveC.size}R は飛ばす`);
const blocked = () => { if (stats.blocked >= 6) { flushAll(); console.error('規制が解けないので中断。時間をおいて同じコマンドで再開する'); process.exit(2); } };

/* 開催日 */
const months = [];
for (let y = +FROM.slice(0, 4), m = +FROM.slice(4, 6); y * 100 + m <= +TO.slice(0, 6); m++) { if (m > 12) { m = 1; y++; } months.push([y, m]); }
const days = [];
for (const [y, m] of months) {
  const ym = `${y}${String(m).padStart(2, '0')}`;
  try { for (const d of parseMonthly(await get(monthlyUrl(y, m), { ttlDays: ym >= TODAY.slice(0, 6) ? 1 : 3650 }))) if (d >= FROM && d <= TO) days.push(d); }
  catch (e) { console.error(`  ! 月別 ${y}/${m} ${e.message}`); blocked(); }
}
console.error(`開催日 ${days.length}日`);

const bufR = [], bufC = [];
let nR = 0, nC = 0, bad = 0;
const flushAll = () => {
  if (bufR.length) { const t = upsertJsonl('data/banei/results.jsonl', bufR.splice(0)); console.error(`  … 成績 ${nR}R（累計 ${t}R）`); }
  if (bufC.length) { const t = upsertJsonl('data/banei/cards.jsonl', bufC.splice(0)); console.error(`  … 出馬表 ${nC}R（累計 ${t}R）`); }
};
for (const d of days) {
  let list;
  try { list = parseRaceList(await get(urlOf('RaceList', d), { ttlDays: freshTtl(d) }), d); }
  catch (e) { console.error(`  ! ${d} 当日メニュー ${e.message}`); blocked(); continue; }
  if (!list.races.length) continue;
  for (const rc of list.races) {
    const raceId = `${d}${String(rc.r).padStart(2, '0')}`;
    const listInfo = { start: rc.start, kind: rc.kind, listName: rc.name, weather: rc.weather, moist: rc.moist, n: rc.n, changes: list.changes.filter(c => c.r === rc.r) };
    if ((KIND === 'both' || KIND === 'results') && !haveR.has(raceId) && d <= TODAY) {
      try {
        const res = parseResult(await get(urlOf('RaceMarkTable', d, rc.r), { ttlDays: freshTtl(d) }), d, rc.r);
        if (res.entries.length) { bufR.push({ ...res, moist: res.moist ?? rc.moist, weather: res.weather ?? rc.weather, list: listInfo }); nR++; } else bad++;
      } catch (e) { bad++; console.error(`  ! 成績 ${raceId} ${e.message}`); blocked(); }
    }
    if ((KIND === 'both' || KIND === 'cards') && !haveC.has(raceId)) {
      try {
        const card = parseCard(await get(urlOf('DebaTable', d, rc.r), { ttlDays: freshTtl(d) }), d, rc.r);
        if (card.entries.length) { bufC.push({ ...card, moist: card.moist ?? rc.moist, weather: card.weather ?? rc.weather, list: listInfo }); nC++; } else bad++;
      } catch (e) { bad++; console.error(`  ! 出馬表 ${raceId} ${e.message}`); blocked(); }
    }
    if (bufR.length + bufC.length >= 100) flushAll();
  }
}
flushAll();
console.error(`完了: 成績 ${nR}R／出馬表 ${nC}R（空・失敗 ${bad}）`);
