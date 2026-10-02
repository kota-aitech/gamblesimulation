/* 競輪のレース詳細を日付範囲で取り込む → data/keirin/races.jsonl（1レース1行、raceId で差し替え）
     KR_FROM / KR_TO … YYYYMMDD（既定 直近7日〜2日後）
     KR_ORDER=desc   … 新しい日から遡って取る（長い取り込みの途中でも直近のデータが先に揃う）
     KR_REFETCH=1    … 取得済みのレースも取り直す（当日の出走表・オッズの更新用）
     KR_ONLY=<slug,…> … 場を絞る
   日付の一覧（1リクエスト）→ 各レース詳細（1リクエスト）。1.5秒間隔。
   結果の入ったレースは二度と取らない。結果の無いレース（今日以降・開催中）は KR_REFETCH が無ければ
   「前回の取得から KR_STALE 分（既定30）」たっていれば取り直す。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, get, freshTtl, ymdOf, addDays, dayUrl, raceUrl, upsertJsonl, stats, dateRange, eachLine } from './lib/kr.mjs';
import { parseDay, parseRace } from './lib/krpage.mjs';

const TODAY = ymdOf(new Date());
const FROM = process.env.KR_FROM || addDays(TODAY, -7);
const TO = process.env.KR_TO || addDays(TODAY, 2);
const DESC = process.env.KR_ORDER === 'desc';
const ONLY = process.env.KR_ONLY ? new Set(process.env.KR_ONLY.split(',')) : null;
const STALE = Number(process.env.KR_STALE || 30);
const REL = 'data/keirin/races.jsonl';

/* 取得済み：結果ありの raceId と、結果なしの raceId → 取得時刻・締切時刻 */
const done = new Set(), pending = new Map(), closeOf = new Map();
{
  const f = path.join(ROOT, REL);
  eachLine(f, l => {
    const m = l.match(/^\{"raceId":"(\d{16})"/); if (!m) return;
    if (/"result":\{/.test(l)) done.add(m[1]);
    else { pending.set(m[1], Number((l.match(/"fetchedAt":(\d+)/) || [])[1] || 0)); const c = l.match(/"date":"(\d{8})"[\s\S]*?"close":"(\d{1,2}:\d{2})"/); if (c) closeOf.set(m[1], new Date(`${c[1].slice(0, 4)}-${c[1].slice(4, 6)}-${c[1].slice(6, 8)}T${c[2].padStart(5, '0')}:00`).getTime()); }
  });
}
console.error(`${FROM}〜${TO}${DESC ? '（新しい順）' : ''} 取得済み 結果あり ${done.size}R／結果なし ${pending.size}R`);
const buf = [];
let nNew = 0, nBad = 0;
const flush = () => { if (!buf.length) return; const t = upsertJsonl(REL, buf.splice(0)); console.error(`  … ${nNew}R（累計 ${t}R・取得 ${stats.fetched}ページ）`); };
const stop = () => { flush(); console.error('規制が解けないので中断。時間をおいて同じコマンドで再開する'); process.exit(2); };
/* 長い取り込みは KR_YIELD=1 で回す：反映係が動いている間は通信を止めて待ち（lib/kr.mjs）、反映係にはこの印（.backfill）で自分がいることを知らせる */
const BACKFILL = path.join(ROOT, 'data/keirin/.backfill');
if (process.env.KR_YIELD) { fs.writeFileSync(BACKFILL, String(process.pid)); process.on('exit', () => { try { fs.unlinkSync(BACKFILL); } catch { } }); }
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });

for (const d of dateRange(FROM, TO, DESC ? -1 : 1)) {
  let list;
  try { list = parseDay(await get(dayUrl(d), { ttlDays: freshTtl(d) })); }
  catch (e) { console.error(`  ! ${d} 一覧 ${e.message}`); if (stats.blocked >= 3) stop(); continue; }
  const races = list.filter(x => !ONLY || ONLY.has(x.slug));
  let got = 0;
  for (const { slug, raceId } of races) {
    if (done.has(raceId) && !process.env.KR_REFETCH) continue;
    /* 結果の無いレースは STALE 分おき。ただし締切の12分前〜締切は4分おき（締切前のオッズを拾う）、締切後〜発走30分後は結果待ちで8分おき */
    if (pending.has(raceId) && !process.env.KR_REFETCH) {
      const age = Date.now() - pending.get(raceId), c = closeOf.get(raceId), toClose = c ? (c - Date.now()) / 60000 : null;
      const every = toClose != null && toClose <= 12 && toClose >= -1 ? 4 : toClose != null && toClose < -1 && toClose > -40 ? 8 : STALE;
      if (age < every * 60000) continue;
    }
    try {
      const html = await get(raceUrl(slug, raceId), { ttlDays: freshTtl(d) });
      const r = parseRace(html, slug, raceId);
      if (!r.riders.length) { nBad++; continue; }
      r.date ||= d; r.fetchedAt = Date.now();
      buf.push(r); nNew++; got++;
      if (r.result) done.add(raceId);
    } catch (e) { nBad++; console.error(`  ! ${raceId} ${e.message}`); if (stats.blocked >= 3) stop(); }
    if (buf.length >= 200) flush();
  }
  if (got) console.error(`${d} ${races.length}R 中 ${got}R`);
}
flush();
console.error(`完了: ${nNew}R（空・失敗 ${nBad}）取得 ${stats.fetched}ページ`);
