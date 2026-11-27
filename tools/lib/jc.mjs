// ジャパンカップ特設ページ専用。取得（低頻度・キャッシュ）と文字起こし。他の競技と混ぜない。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const YEAR = +(process.env.JC_YEAR || 2026);
export const DAY = process.env.JC_DAY || '2026-11-29';
export const RACE_ID = process.env.JC_RACE_ID || '202605050812';   // 年4 場2 回2 日2 R2（data/jra/races.json の raceId）
export const JRA = 'https://www.jra.go.jp';
export const SOURCES = {
  foreign: `${JRA}/news/gaikokuba/${YEAR}/jc.html`,          // 外国馬プロフィール（各馬 jc01.html〜）と調教状況の一覧
  g1: `${JRA}/keiba/g1/jc.html`,
  horse: `${JRA}/keiba/g1/jc/horse.html`,                    // 出走馬情報
  data: `${JRA}/keiba/g1/jc/data.html`,                      // データ分析
  course: `${JRA}/facilities/race/tokyo/course/`,
};
const CACHE = path.join(ROOT, 'data/cache/jc');
const WAIT = +(process.env.JC_WAIT || 2500);
let last = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// ttlMin 分より新しいキャッシュがあればそれを返す。JRA は Referer と Accept が無いと 200 で Forbidden のページを返す
export async function get(url, ttlMin = 60, { referer = SOURCES.g1 } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + '.bin');
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < ttlMin * 60000) return decode(fs.readFileSync(f));
  const w = last + WAIT - Date.now(); if (w > 0) await sleep(w);
  last = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) research-client', Accept: 'text/html,application/json,*/*', Referer: referer }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const s = decode(buf);
  if (/<title>\s*(403|Forbidden)/i.test(s) || buf.length < 500) throw new Error(`拒否または空のページ ${url}`);
  fs.writeFileSync(f, buf);
  return s;
}
export function decode(buf) {
  const cs = buf.toString('latin1').slice(0, 3000).match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
  return new TextDecoder(/shift|sjis/i.test(cs) ? 'shift_jis' : /euc/i.test(cs) ? 'euc-jp' : 'utf-8').decode(buf);
}
export const ent = s => s.replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : +n))
  .replace(/&(nbsp|amp|lt|gt|quot|apos);/g, (_, n) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n]));
export const clean = (s = '') => ent(s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/[\s　]+/g, ' ').trim();
// 本文（id="contents" 以降）だけを残す
export function body(s) {
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const i = s.search(/id="contents"/); if (i > 0) s = s.slice(i);
  const j = s.search(/id="pagetop"|class="pagetop|JRAからのお知らせ/); if (j > 0) s = s.slice(0, j);
  return s;
}
// rowspan / colspan を展開して表を読む
export function tables(s) {
  return [...s.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(t => {
    const rows = [], spans = [];
    for (const tr of t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = []; let col = 0;
      const skip = () => { while (spans[col]?.left > 0) { row[col] = spans[col].value; spans[col].left--; col++; } };
      for (const td of tr[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
        skip(); const value = clean(td[2]); const r = +(td[1].match(/rowspan=["']?(\d+)/)?.[1] || 1), c = +(td[1].match(/colspan=["']?(\d+)/)?.[1] || 1);
        for (let k = 0; k < c; k++) { row[col] = value; if (r > 1) spans[col] = { left: r - 1, value }; col++; }
      }
      skip(); if (row.length) rows.push(row);
    }
    return rows;
  });
}
// 段落ごとの文字（見出し・p・li・dt・dd を1行に）
export function lines(s) {
  return ent(s.replace(/<(br|\/tr|\/p|\/div|\/li|\/h\d|\/dt|\/dd|\/caption)[^>]*>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ').replace(/<[^>]+>/g, ''))
    .split('\n').map(l => l.replace(/[ \t　]+/g, ' ').trim()).filter(Boolean);
}
export const readJSON = (f, d = null) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return d; } };
export function writeJSON(f, o) { const p = path.join(ROOT, f); fs.mkdirSync(path.dirname(p), { recursive: true }); const t = p + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, p); }
// PDF などのバイナリ。キャッシュしたファイルのパスを返す
export async function getFile(url, ttlMin = 60 * 24, { referer = SOURCES.foreign } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + path.extname(new URL(url).pathname));
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < ttlMin * 60000) return f;
  const w = last + WAIT - Date.now(); if (w > 0) await sleep(w);
  last = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) research-client', Accept: '*/*', Referer: referer }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 4).toString() !== '%PDF') throw new Error(`PDF ではない ${url}`);
  fs.writeFileSync(f, buf);
  return f;
}
// 父・父の父の英字表記（JRA の資料はカタカナ、手元の血統データ horses.jsonl は英字なので、突き合わせ用の読み替えだけ持つ）
export const KANA_EN = { ガリレオ: 'Galileo', ドバウィ: 'Dubawi', ケープクロス: 'Cape Cross', インザウィングス: 'In The Wings', マスタークラフツマン: 'Mastercraftsman',
  ダンシリ: 'Dansili', シンダー: 'Sinndar', シャマーダル: 'Shamardal', アライオン: 'Areion' };
