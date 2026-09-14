/* JRA（中央競馬）の取得共通。データ元は netkeiba のレースページ（無料・UTF-8）。
     レース一覧   race.netkeiba.com/top/race_list_sub.html?kaisai_date=YYYYMMDD
     開催日一覧   race.netkeiba.com/top/calendar.html?year=YYYY&month=M
     馬柱(前5走)  race.netkeiba.com/race/shutuba_past.html?race_id=…
     結果・払戻   race.netkeiba.com/race/result.html?race_id=…
     オッズ(JSON) race.netkeiba.com/api/api_get_jra_odds.html?race_id=…&type=1&action=init
   race_id は 12桁：年4＋場2＋回2＋日2＋R2（場は 01札幌 02函館 03福島 04新潟 05東京 06中山 07中京 08京都 09阪神 10小倉）。
   南関側（lib/nk.mjs）と同じ考え方：1リクエストずつ・間隔をあけて・ローカルキャッシュ。並列取得はしない。
   db.netkeiba.com のリーディングは空応答で取れないので使わない（指数は結果から自前で作る）。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CACHE = path.join(ROOT, 'data', 'cache', 'jra');
/* 1.2秒間隔で約4,000ページ取ったところで CloudFront が HTTP 400 を返すようになった（IP 単位の規制、
   UA を変えても同じ、トップページも 400）。既定は 3秒に落とし、400/403/429 が来たら
   10分休んでからやり直す（何度も叩くと解除が遅れる）。 */
const WAIT = Number(process.env.JRA_WAIT || 3000);
const BLOCK_WAIT = Number(process.env.JRA_BLOCK_WAIT || 600000);
/* ネットが切れている（移動中・スリープ明け）ときは、レースを飛ばさずに復帰まで待つ。
   60秒おきに試し、JRA_NET_MAX 分（既定 6時間）を超えたらあきらめる */
const NET_WAIT = Number(process.env.JRA_NET_WAIT || 60000);
const NET_MAX = Number(process.env.JRA_NET_MAX || 360) * 60000;
const isNetError = e => /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|aborted|TimeoutError/i.test(String(e && (e.cause?.code || e.cause?.message || e.name + ' ' + e.message)));
export const stats = { blocked: 0 };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;

export const VENUES = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京', '06': '中山', '07': '中京', '08': '京都', '09': '阪神', '10': '小倉',
};
export const RACE = 'https://race.netkeiba.com';

/* 開催前に取った空ページ・途中のページを長く抱えないための TTL（日）。直近4日は短く */
export const freshTtl = (ymd, longDays = 3650) => {
  const d = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const age = (Date.now() - new Date(d + 'T00:00:00').getTime()) / 86400000;
  return age < 4 ? 0.02 : longDays;
};

export async function get(url, { ttlDays = 3650, tries = 3, referer = RACE + '/', headers = {} } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 24);
  const f = path.join(CACHE, key + (url.includes('api_get') ? '.json' : '.html'));
  if (fs.existsSync(f)) {
    const age = (Date.now() - fs.statSync(f).mtimeMs) / 86400000;
    if (age < ttlDays) return fs.readFileSync(f, 'utf8');
  }
  const gap = Date.now() - last;
  if (gap < WAIT) await sleep(WAIT - gap);
  last = Date.now();
  let body = null;
  let offlineSince = 0;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja', Referer: referer, ...headers }, signal: AbortSignal.timeout(30000) });
      if ([400, 403, 429, 503].includes(res.status)) {
        stats.blocked++;
        console.error(`  ! HTTP ${res.status}（規制）。${BLOCK_WAIT / 60000}分休む（${a + 1}/${tries}）`);
        await sleep(BLOCK_WAIT);
        throw new Error('HTTP ' + res.status);
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      body = await res.text();
      if (body.length < 200 && !url.includes('api_get')) throw new Error('空ページ（規制の可能性）');
      break;
    } catch (e) {
      if (isNetError(e)) {
        /* 圏外・スリープ明け：試行回数に数えず、復帰するまで同じ URL を待つ */
        if (!offlineSince) { offlineSince = Date.now(); console.error(`  ! ネットに届かない（${(e.cause?.code || e.name)}）。復帰まで ${NET_WAIT / 1000}秒おきに待つ`); }
        if (Date.now() - offlineSince > NET_MAX) throw e;
        await sleep(NET_WAIT); a--; continue;
      }
      if (offlineSince) { console.error(`  ネット復帰（${Math.round((Date.now() - offlineSince) / 60000)}分）`); offlineSince = 0; }
      if (a === tries - 1) throw e;
      if (!/HTTP (400|403|429|503)/.test(e.message)) await sleep(3000 * (a + 1));
    }
  }
  if (offlineSince) console.error(`  ネット復帰（${Math.round((Date.now() - offlineSince) / 60000)}分）`);
  fs.writeFileSync(f, body);
  return body;
}

export const text = h => String(h ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export const num = s => { const v = String(s ?? '').replace(/[,円\s]/g, ''); return v === '' || isNaN(v) ? null : Number(v); };
export const ymdOf = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
export function* dateRange(from, to) {
  const d = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00`);
  const e = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00`);
  for (; d <= e; d.setDate(d.getDate() + 1)) yield ymdOf(d);
}
export function writeJSON(rel, obj) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1));
}
export function readJSON(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
/* jsonl を raceId で差し替え追記する */
export function upsertJsonl(rel, rows, keyOf = o => o.raceId) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const map = new Map();
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split('\n')) if (l) { try { const o = JSON.parse(l); map.set(keyOf(o), l); } catch { } }
  for (const o of rows) map.set(keyOf(o), JSON.stringify(o));
  const keys = [...map.keys()].sort();
  fs.writeFileSync(p, keys.map(k => map.get(k)).join('\n') + '\n');
  return map.size;
}
