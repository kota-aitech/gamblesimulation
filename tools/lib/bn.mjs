/* ばんえい（帯広）版の取得共通。データ元は地方競馬情報サイト keiba.go.jp（NAR 公式・UTF-8・JavaScript 不要）。
     当日メニュー   /KeibaWeb/TodayRaceInfo/RaceList?k_raceDate=YYYY%2FMM%2FDD&k_babaCode=3
     出馬表         /KeibaWeb/TodayRaceInfo/DebaTable?k_raceDate=…&k_raceNo=R&k_babaCode=3   （馬体重・オッズ・前5走・血統・馬主）
     競走成績       /KeibaWeb/TodayRaceInfo/RaceMarkTable?k_raceDate=…&k_raceNo=R&k_babaCode=3（着順・積載重量・馬体重・タイム・払戻）
     月別開催日程   /KeibaWeb/MonthlyConveneInfo/MonthlyConveneInfoTop?k_year=YYYY&k_month=M （帯広ば の行に日付のリンク）
   馬場水分（含水率）は当日メニューと各レースの見出しに「馬場：0.9」の形で出る。
   南関（nk.mjs）・JRA（jra.mjs）と同じく 単一スレッド・間隔あり・キャッシュ・ネット切断は待つ。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CACHE = path.join(ROOT, 'data', 'cache', 'banei');
export const BASE = 'https://www.keiba.go.jp/KeibaWeb';
export const BABA = process.env.BN_BABA || '3';               // 3＝帯広（ばんえい）
const WAIT = Number(process.env.BN_WAIT || 2000);
const BLOCK_WAIT = Number(process.env.BN_BLOCK_WAIT || 600000);
const NET_WAIT = Number(process.env.BN_NET_WAIT || 60000);
const NET_MAX = Number(process.env.BN_NET_MAX || 360) * 60000;
export const stats = { blocked: 0 };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isNetError = e => /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|aborted|TimeoutError/i.test(String(e && (e.cause?.code || e.cause?.message || e.name + ' ' + e.message)));
let last = 0;

/* 開催前・開催中に取った空ページを長く抱えない。直近4日は短く */
export const freshTtl = (ymd, longDays = 3650) => {
  const age = (Date.now() - new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00`).getTime()) / 86400000;
  return age < 4 ? 0.02 : longDays;
};
export const ymdOf = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
export const dateParam = ymd => `${ymd.slice(0, 4)}%2F${ymd.slice(4, 6)}%2F${ymd.slice(6, 8)}`;
export const urlOf = (page, ymd, r) => `${BASE}/TodayRaceInfo/${page}?k_raceDate=${dateParam(ymd)}${r ? `&k_raceNo=${r}` : ''}&k_babaCode=${BABA}`;
export const monthlyUrl = (y, m) => `${BASE}/MonthlyConveneInfo/MonthlyConveneInfoTop?k_year=${y}&k_month=${m}`;

export async function get(url, { ttlDays = 3650, tries = 3 } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 24);
  const f = path.join(CACHE, key + '.html');
  if (fs.existsSync(f)) {
    const age = (Date.now() - fs.statSync(f).mtimeMs) / 86400000;
    if (age < ttlDays) return fs.readFileSync(f, 'utf8');
  }
  const gap = Date.now() - last;
  if (gap < WAIT) await sleep(WAIT - gap);
  last = Date.now();
  let body = null, offlineSince = 0;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja', Referer: BASE + '/TodayRaceInfo/RaceList' }, signal: AbortSignal.timeout(30000) });
      if ([403, 429, 503].includes(res.status)) {
        stats.blocked++;
        console.error(`  ! HTTP ${res.status}（規制）。${BLOCK_WAIT / 60000}分休む（${a + 1}/${tries}）`);
        await sleep(BLOCK_WAIT);
        throw new Error('HTTP ' + res.status);
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      body = await res.text();
      if (body.length < 500) throw new Error('空ページ');
      break;
    } catch (e) {
      if (isNetError(e)) {
        if (!offlineSince) { offlineSince = Date.now(); console.error(`  ! ネットに届かない（${e.cause?.code || e.name}）。復帰まで ${NET_WAIT / 1000}秒おきに待つ`); }
        if (Date.now() - offlineSince > NET_MAX) throw e;
        await sleep(NET_WAIT); a--; continue;
      }
      if (offlineSince) { console.error(`  ネット復帰（${Math.round((Date.now() - offlineSince) / 60000)}分）`); offlineSince = 0; }
      if (a === tries - 1) throw e;
      if (!/HTTP (403|429|503)/.test(e.message)) await sleep(3000 * (a + 1));
    }
  }
  if (offlineSince) console.error(`  ネット復帰（${Math.round((Date.now() - offlineSince) / 60000)}分）`);
  fs.writeFileSync(f, body);
  return body;
}

export const text = h => String(h ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export const num = s => { const v = String(s ?? '').replace(/[,円\s]/g, ''); return v === '' || isNaN(v) ? null : Number(v); };
export const zen = s => String(s || '').replace(/[０-９Ａ-Ｚａ-ｚ－]/g, c => c === '－' ? '-' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
export function* dateRange(from, to) {
  const d = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00`);
  const end = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00`);
  for (; d <= end; d.setDate(d.getDate() + 1)) yield ymdOf(d);
}
export function writeJSON(rel, obj) {
  const f = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
  console.error(`-> ${rel} (${(fs.statSync(f).size / 1024).toFixed(0)} KB)`);
}
export function readJSON(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
/* jsonl に差し替え追記（同じ raceId は新しいもので置き換える）。全行数を返す */
export function upsertJsonl(rel, rows, keyOf = o => o.raceId) {
  const f = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const map = new Map();
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l) continue; try { const o = JSON.parse(l); map.set(keyOf(o), l); } catch { } }
  for (const o of rows) map.set(keyOf(o), JSON.stringify(o));
  const keys = [...map.keys()].sort();
  fs.writeFileSync(f, keys.map(k => map.get(k)).join('\n') + '\n');
  return keys.length;
}
