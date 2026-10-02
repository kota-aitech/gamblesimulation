/* 競輪版の取得共通。データ元は楽天Kドリームス（keirin.kdreams.jp。サーバ描画・UTF-8・JavaScript 不要）。
     日付の一覧   /racecard/YYYY/MM/DD/                      … その日の全場・全レースの racedetail へのリンク
     レース詳細   /{場}/racedetail/{場2}{初日8}{日目2}00{R2}/  … 出走表（競走得点・府県/年齢/期別・級班・脚質・ギヤ・直近4ヶ月の S/B/逃捲差マ・勝率）、
                                                              選手コメント、今場所・前場所・前々場所の成績、年間勝利度数、同走路、当所5年、
                                                              **並び予想（ライン）**、記者の印と総評、オッズ（3連単・2車単・3連複・2車複・ワイド）、
                                                              結果（着順・着差・上り・決まり手・S/B・天候/風速）と払戻
   過去のページも「当時の値」で残っている（2023年の出走表の競走得点は当時のもの）ので、学習にそのまま使える。
   keirin.jp（JKA）は robots.txt で出走表を禁止しているので使わない。
   南関（nk.mjs）・ばんえい（bn.mjs）と同じく 単一スレッド・間隔あり・キャッシュ・ネット切断は待つ。
   1ページ約250KB あるので、キャッシュは gzip で持つ（data/cache/keirin/。.gitignore 済みの data/cache の下）。 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CACHE = path.join(ROOT, 'data', 'cache', 'keirin');
export const BASE = 'https://keirin.kdreams.jp';
const WAIT = Number(process.env.KR_WAIT || 1500);
const BLOCK_WAIT = Number(process.env.KR_BLOCK_WAIT || 600000);
const NET_WAIT = Number(process.env.KR_NET_WAIT || 60000);
const NET_MAX = Number(process.env.KR_NET_MAX || 360) * 60000;
export const stats = { blocked: 0, fetched: 0 };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isNetError = e => /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|aborted|TimeoutError/i.test(String(e && (e.cause?.code || e.cause?.message || e.name + ' ' + e.message)));
let last = 0;

/* 全43場。場コード（raceId の先頭2桁）・URL の名前・所在の府県・地区。
   府県は「地元」の判定（選手の登録府県＝開催場の府県）、地区はラインの組み方（同地区で連係する）に使う。
   地区は競輪の8地区（北日本・関東・南関東・中部・近畿・中国・四国・九州）。 */
export const VENUES = [
  ['11', 'hakodate', '函館', '北海道'], ['12', 'aomori', '青森', '青森'], ['13', 'iwakitaira', 'いわき平', '福島'],
  ['21', 'yahiko', '弥彦', '新潟'], ['22', 'maebashi', '前橋', '群馬'], ['23', 'toride', '取手', '茨城'], ['24', 'utsunomiya', '宇都宮', '栃木'],
  ['25', 'omiya', '大宮', '埼玉'], ['26', 'seibuen', '西武園', '埼玉'], ['27', 'keiokaku', '京王閣', '東京'], ['28', 'tachikawa', '立川', '東京'],
  ['31', 'matsudo', '松戸', '千葉'], ['32', 'chiba', '千葉', '千葉'], ['34', 'kawasaki', '川崎', '神奈川'], ['35', 'hiratsuka', '平塚', '神奈川'],
  ['36', 'odawara', '小田原', '神奈川'], ['37', 'ito', '伊東', '静岡'], ['38', 'shizuoka', '静岡', '静岡'],
  ['42', 'nagoya', '名古屋', '愛知'], ['43', 'gifu', '岐阜', '岐阜'], ['44', 'ogaki', '大垣', '岐阜'], ['45', 'toyohashi', '豊橋', '愛知'],
  ['46', 'toyama', '富山', '富山'], ['47', 'matsusaka', '松阪', '三重'], ['48', 'yokkaichi', '四日市', '三重'],
  ['51', 'fukui', '福井', '福井'], ['53', 'nara', '奈良', '奈良'], ['54', 'mukomachi', '向日町', '京都'], ['55', 'wakayama', '和歌山', '和歌山'], ['56', 'kishiwada', '岸和田', '大阪'],
  ['61', 'tamano', '玉野', '岡山'], ['62', 'hiroshima', '広島', '広島'], ['63', 'hofu', '防府', '山口'],
  ['71', 'takamatsu', '高松', '香川'], ['73', 'komatsushima', '小松島', '徳島'], ['74', 'kochi', '高知', '高知'], ['75', 'matsuyama', '松山', '愛媛'],
  ['81', 'kokura', '小倉', '福岡'], ['83', 'kurume', '久留米', '福岡'], ['84', 'takeo', '武雄', '佐賀'], ['85', 'sasebo', '佐世保', '長崎'],
  ['86', 'beppu', '別府', '大分'], ['87', 'kumamoto', '熊本', '熊本'],
];
export const REGION = {
  北日本: ['北海道', '青森', '岩手', '宮城', '秋田', '山形', '福島'],
  関東: ['茨城', '栃木', '群馬', '埼玉', '東京', '新潟', '長野'],
  南関東: ['千葉', '神奈川', '静岡', '山梨'],
  中部: ['愛知', '岐阜', '三重', '富山', '石川'],
  近畿: ['福井', '滋賀', '京都', '奈良', '和歌山', '大阪', '兵庫'],
  中国: ['岡山', '広島', '山口', '鳥取', '島根'],
  四国: ['香川', '徳島', '愛媛', '高知'],
  九州: ['福岡', '佐賀', '長崎', '大分', '熊本', '宮崎', '鹿児島', '沖縄'],
};
export const regionOf = pref => { for (const [r, ps] of Object.entries(REGION)) if (ps.includes(pref)) return r; return null; };
export const venueByCode = Object.fromEntries(VENUES.map(([c, slug, name, pref]) => [c, { code: c, slug, name, pref, region: regionOf(pref) }]));
export const venueBySlug = Object.fromEntries(VENUES.map(([c, slug, name, pref]) => [slug, { code: c, slug, name, pref, region: regionOf(pref) }]));
export const venueByName = Object.fromEntries(VENUES.map(([c, slug, name, pref]) => [name, { code: c, slug, name, pref, region: regionOf(pref) }]));

/* 開催前・開催中に取った空ページを長く抱えない（CLAUDE.md 要件6）。直近4日は短く */
export const freshTtl = (ymd, longDays = 3650) => {
  const age = (Date.now() - new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00`).getTime()) / 86400000;
  return age < -0.5 ? 0.02 : age < 4 ? 0.02 : longDays;
};
export const ymdOf = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
export const dayUrl = ymd => `${BASE}/racecard/${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}/`;
export const raceUrl = (slug, raceId) => `${BASE}/${slug}/racedetail/${raceId}/`;

/* 長い取り込み（KR_YIELD=1）は、反映係（refresh_keirin）が動いている間は通信を止めて待つ。
   Kドリームスを同時に2本で叩かない（CLAUDE.md 要件6）ための譲り合い。反映係は開始時に PAUSE を置き、終わったら消す。
   PAUSE が30分より古ければ（反映係が落ちて消し忘れた）無視する */
export const PAUSE = path.join(ROOT, 'data', 'keirin', '.pause');
async function yieldToRefresh() {
  if (!process.env.KR_YIELD) return;
  let said = false;
  while (fs.existsSync(PAUSE) && Date.now() - fs.statSync(PAUSE).mtimeMs < 30 * 60000) {
    if (!said) { console.error('  （反映係が動作中なので待つ）'); said = true; }
    await sleep(5000);
  }
}
export async function get(url, { ttlDays = 3650, tries = 3 } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 24);
  const f = path.join(CACHE, key + '.html.gz');
  if (fs.existsSync(f)) {
    const age = (Date.now() - fs.statSync(f).mtimeMs) / 86400000;
    if (age < ttlDays) return zlib.gunzipSync(fs.readFileSync(f)).toString('utf8');
  }
  await yieldToRefresh();
  const gap = Date.now() - last;
  if (gap < WAIT) await sleep(WAIT - gap);
  last = Date.now();
  let body = null, offlineSince = 0;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja', Referer: BASE + '/' }, signal: AbortSignal.timeout(40000) });
      if ([403, 429, 503].includes(res.status)) {
        stats.blocked++;
        console.error(`  ! HTTP ${res.status}（規制）。${BLOCK_WAIT / 60000}分休む（${a + 1}/${tries}）`);
        await sleep(BLOCK_WAIT);
        throw new Error('HTTP ' + res.status);
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      body = await res.text();
      if (body.length < 2000) throw new Error('空ページ');
      stats.blocked = 0;
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
  stats.fetched++;
  fs.writeFileSync(f, zlib.gzipSync(body));
  return body;
}

export const text = h => String(h ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export const num = s => { const v = String(s ?? '').replace(/[,円\s]/g, ''); return v === '' || isNaN(v) ? null : Number(v); };
export const zen = s => String(s || '').replace(/[０-９Ａ-Ｚａ-ｚ－／]/g, c => c === '－' ? '-' : c === '／' ? '/' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
export function* dateRange(from, to, step = 1) {
  const d = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00`);
  const end = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00`);
  if (step > 0) for (; d <= end; d.setDate(d.getDate() + 1)) yield ymdOf(d);
  else for (; end >= d; end.setDate(end.getDate() - 1)) yield ymdOf(end);
}
export const addDays = (ymd, n) => { const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00`); d.setDate(d.getDate() + n); return ymdOf(d); };
export function writeJSON(rel, obj) {
  const f = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
  console.error(`-> ${rel} (${(fs.statSync(f).size / 1024).toFixed(0)} KB)`);
}
/* 大きな jsonl を1行ずつ読む（同期）。races.jsonl は遡りの取り込みで 1GB を超え、readFileSync(…,'utf8') が
   Node の文字列の上限（約512MB）を超えて ERR_STRING_TOO_LONG で落ちた（2026-10-01〜02、競輪の反映と遡りが止まった）。
   **races.jsonl は必ずこれで読む。** fn(line) が false を返したら打ち切る。絶対パスも相対パスも受ける */
export function eachLine(file, fn) {
  const f = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(f)) return;
  const fd = fs.openSync(f, 'r'), buf = Buffer.alloc(16 << 20), dec = new StringDecoder('utf8');
  let rest = '', n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const parts = (rest + dec.write(buf.subarray(0, n))).split('\n');
      rest = parts.pop();
      for (const l of parts) if (l && fn(l) === false) return;
    }
    rest += dec.end();
    if (rest) fn(rest);
  } finally { fs.closeSync(fd); }
}
export function readJSON(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
/* jsonl に差し替え追記（同じ raceId は新しいもので置き換える）。全行数を返す。
   ファイルは1年で数百MBになるので、**新しい raceId だけなら追記で済ませる**（全体の読み直しは差し替えがあるときだけ）。
   行の並びは保証しない（読む側 loadRaces が日付順に並べ直す） */
const idCache = new Map();
function idsOf(f) {
  if (idCache.has(f)) return idCache.get(f);
  const s = new Set();
  eachLine(f, l => { const m = l.match(/^\{"raceId":"(\d+)"/); if (m) s.add(m[1]); });
  idCache.set(f, s); return s;
}
export function upsertJsonl(rel, rows, keyOf = o => o.raceId) {
  const f = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const ids = idsOf(f);
  const fresh = rows.filter(o => !ids.has(keyOf(o))), repl = rows.filter(o => ids.has(keyOf(o)));
  if (repl.length) {
    const rep = new Map(repl.map(o => [keyOf(o), JSON.stringify(o)]));
    const tmp = f + '.tmp', out = fs.openSync(tmp, 'w');
    eachLine(f, l => { const m = l.match(/^\{"raceId":"(\d+)"/); fs.writeSync(out, (m && rep.has(m[1]) ? rep.get(m[1]) : l) + '\n'); });
    fs.closeSync(out); fs.renameSync(tmp, f);
  }
  if (fresh.length) fs.appendFileSync(f, fresh.map(o => JSON.stringify(o)).join('\n') + '\n');
  for (const o of fresh) ids.add(keyOf(o));
  return ids.size;
}
export function readJsonl(rel, filter) {
  const f = path.join(ROOT, rel), out = [];
  if (!fs.existsSync(f)) return out;
  eachLine(f, l => { if (filter && !filter(l)) return; try { out.push(JSON.parse(l)); } catch { } });
  return out;
}
