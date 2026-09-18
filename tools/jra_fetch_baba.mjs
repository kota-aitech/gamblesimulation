/* JRA 公式「過去の含水率・クッション値」を取り込む → data/jra/baba.jsonl（1開催日1行）

   出どころ: https://www.jra.go.jp/keiba/baba/archive/{年}.html に、開催ごとの PDF が並ぶ
             （例 /keiba/baba/archive/2026pdf/nakayama03.pdf ＝ 2026年 第3回中山）。
   PDF は lib/jrapdf.mjs（Node の zlib だけ）で表に起こす。数値は素のテキスト、日本語は Identity-H の CID。
   含水率は 2018-07-27 から、クッション値は 2020-09-11 から公表。1年あたり26前後の PDF なので
   全部で 200 ほど。過去年は変わらないので長いキャッシュ、今年だけ短いキャッシュで取り直す。

   注記：測定は原則 金曜午前・土日の早朝。レース直前の値ではないので「その日の朝の馬場」として使う。
     JRA_BABA_FROM / JRA_BABA_TO … 取り込む年（既定 2018〜今年）
     JRA_WAIT … 取得間隔(ms、既定 3000)                                                      */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './lib/jra.mjs';
import { pdfRows } from './lib/jrapdf.mjs';

const BASE = 'https://www.jra.go.jp';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const WAIT = Number(process.env.JRA_WAIT || 3000);
const NOW = new Date();
const Y0 = Number(process.env.JRA_BABA_FROM || 2018), Y1 = Number(process.env.JRA_BABA_TO || NOW.getFullYear());
const CACHE = path.join(ROOT, 'data', 'cache', 'jra', 'baba');
const OUT = path.join(ROOT, 'data', 'jra', 'baba.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;

/* 場のローマ字（PDF のファイル名）→ 日本語 */
const VEN = { sapporo: '札幌', hakodate: '函館', fukushima: '福島', niigata: '新潟', tokyo: '東京', nakayama: '中山', chukyo: '中京', kyoto: '京都', hanshin: '阪神', kokura: '小倉' };

async function get(url, { ttlDays = 3650, binary = false } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex').slice(0, 24) + (binary ? '.pdf' : '.html'));
  if (fs.existsSync(f) && (Date.now() - fs.statSync(f).mtimeMs) / 86400000 < ttlDays) return fs.readFileSync(f);
  const gap = Date.now() - last; if (gap < WAIT) await sleep(WAIT - gap);
  last = Date.now();
  for (let a = 0; ; a++) {
    try {
      /* JRA は Referer と Accept が無いと「Forbidden」ページ（200）を返す */
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja', Accept: binary ? 'application/pdf,*/*' : 'text/html,application/xhtml+xml', Referer: BASE + '/keiba/baba/' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const b = Buffer.from(await res.arrayBuffer());
      if (!binary && /Forbidden/.test(b.toString('latin1').slice(0, 400))) throw new Error('Forbidden ページ');
      if (binary && b.slice(0, 4).toString() !== '%PDF') throw new Error('PDF ではない');
      fs.writeFileSync(f, b);
      return b;
    } catch (e) {
      if (a >= 2) throw e;
      await sleep(4000 * (a + 1));
    }
  }
}

/* 1つの PDF → 開催日ごとの行。列は x の並びで決める（クッション値の無い 2018〜2020前半は列が1つ少ない） */
function parseBaba(buf, venue, kai, year) {
  const rows = pdfRows(buf);
  const out = [];
  /* 数値セルの x をまとめて、左から [クッション, 芝ゴール前, 芝4コーナー, ダートゴール前, ダート4コーナー] に割り当てる */
  const nums = [];
  for (const r of rows) for (const c of r.cells) if (/^\d+(\.\d+)?$/.test(c.t) && !/^\d{1,2}:\d{2}$/.test(c.t)) nums.push(c.x);
  const cols = [];
  for (const x of nums.sort((a, b) => a - b)) { const g = cols.find(g => Math.abs(g.x - x) <= 22); if (g) { g.n++; g.x = (g.x * (g.n - 1) + x) / g.n; } else cols.push({ x, n: 1 }); }
  const centers = cols.filter(g => g.n >= 3).map(g => g.x).sort((a, b) => a - b);
  const labels = centers.length >= 5 ? ['cushion', 'turfGoal', 'turfCorner', 'dirtGoal', 'dirtCorner'] : ['turfGoal', 'turfCorner', 'dirtGoal', 'dirtCorner'];
  const colOf = x => { let bi = -1, bd = 1e9; centers.forEach((c, i) => { const d = Math.abs(c - x); if (d < bd) { bd = d; bi = i; } }); return bd <= 40 ? labels[bi] : null; };
  for (const r of rows) {
    const date = r.cells.find(c => /^\d{1,2}月\s*\d{1,2}日$/.test(c.t.replace(/\s/g, '').replace(/月/, '月')));
    if (!date) continue;
    const md = date.t.replace(/\s+/g, '').match(/(\d{1,2})月(\d{1,2})日/); if (!md) continue;
    const rec = { date: `${year}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`, venue, kai, nichi: null, dow: null, course: null, cushion: null, turfGoal: null, turfCorner: null, dirtGoal: null, dirtCorner: null, cushionAt: null, moistAt: null };
    const times = [];
    for (const c of r.cells) {
      const t = c.t.replace(/\s+/g, '');
      if (c === date) continue;
      if (/^第\d+日$/.test(t)) { rec.nichi = Number(t.replace(/\D/g, '')); continue; }
      if (/曜日$/.test(t)) { rec.dow = t.replace('曜日', ''); continue; }
      if (/^[A-Z]$/.test(t)) { rec.course = t; continue; }
      if (/^\d{1,2}:\d{2}$/.test(t)) { times.push(t); continue; }
      if (/^\d+(\.\d+)?$/.test(t)) { const k = colOf(c.x); if (k) rec[k] = Number(t); continue; }
    }
    if (labels[0] === 'cushion') { rec.cushionAt = times[0] || null; rec.moistAt = times[1] || null; }
    else rec.moistAt = times[0] || null;
    if (rec.turfGoal == null && rec.dirtGoal == null && rec.cushion == null) continue;
    out.push(rec);
  }
  return out;
}

/* 2018〜2019 の古い形式：1開催週が1ブロックで、列が曜日（金・土・日）。
     2019年3月22日から24日の含水率
     場所 | 金曜日 | 土曜日 | 日曜日
     芝コース含水率 | ゴール前 | 11.6 | 10.1 | 9.9
     （パーセント）| ４コーナー | 11.0 | 11.1 | 11.1
     ダートコース含水率 | ゴール前 | 3.4 | 2.8 | 2.3
     （パーセント）| ４コーナー | 3.3 | 5.3 | 2.6                              */
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
function parseBabaOld(buf, venue, kai, year) {
  const rows = pdfRows(buf);
  const out = new Map();
  let days = null;                                    // 今のブロックの [{date, dow}]
  for (const r of rows) {
    const line = r.cells.map(c => c.t).join(' ').replace(/\s+/g, '');
    /* 日付の書き方は年で違う：「3月22日から24日」「（2022年4月22日～24日）」 */
    const dm = line.match(/(\d{4})?年?(\d{1,2})月(\d{1,2})日\s*(?:から|[～〜~-])\s*(?:(\d{1,2})月)?(\d{1,2})日/);
    if (dm) {
      const y0 = Number(dm[1] || year), m0 = Number(dm[2]), d0 = Number(dm[3]);
      const m1 = Number(dm[4] || dm[2]), d1 = Number(dm[5]);
      const y1 = m1 < m0 ? y0 + 1 : y0;
      const from = new Date(Date.UTC(y0, m0 - 1, d0)), to = new Date(Date.UTC(y1, m1 - 1, d1));
      days = [];
      for (let t = from.getTime(); t <= to.getTime() && days.length < 8; t += 86400000) {
        const d = new Date(t);
        days.push({ date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`, dow: DOW[d.getUTCDay()] });
      }
      continue;
    }
    if (!days) continue;
    /* 曜日の見出し行が来たら、その並びに合う日付だけを残す */
    const dows = r.cells.map(c => c.t.replace(/\s+/g, '')).filter(t => /^[日月火水木金土]曜日$/.test(t)).map(t => t[0]);
    if (dows.length >= 2) { days = dows.map(w => days.find(d => d.dow === w)).filter(Boolean); continue; }
    /* 値の行：ラベル（芝／ダート＋ゴール前／4コーナー）と、日付の数だけ並ぶ数値 */
    const nums = r.cells.filter(c => /^\d+(\.\d+)?$/.test(c.t.replace(/\s+/g, '')));
    if (!nums.length) continue;
    const isDirt = /ダート/.test(line), isTurf = /芝/.test(line);
    const isCorner = /コーナー/.test(line), isGoal = /ゴール前/.test(line);
    /* クッション値の行（2021〜2024 は含水率の表の上に別の行で載る） */
    if (/クッション値/.test(line)) {
      nums.slice(0, days.length).forEach((c, i) => {
        const d = days[i]; if (!d) return;
        const rec = out.get(d.date) || out.set(d.date, { date: d.date, venue, kai, nichi: null, dow: d.dow, course: null, cushion: null, turfGoal: null, turfCorner: null, dirtGoal: null, dirtCorner: null, cushionAt: null, moistAt: null }).get(d.date);
        rec.cushion = Number(c.t.replace(/\s+/g, ''));
      });
      continue;
    }
    if (!(isGoal || isCorner)) continue;
    /* ラベルの列（芝／ダート）は1つ前の行に書かれていることがあるので、直前の種別を覚えておく */
    if (isTurf) parseBabaOld._surf = '芝'; else if (isDirt) parseBabaOld._surf = 'ダート';
    const surf = isTurf ? '芝' : isDirt ? 'ダート' : parseBabaOld._surf;
    if (!surf) continue;
    const key = surf === '芝' ? (isCorner ? 'turfCorner' : 'turfGoal') : (isCorner ? 'dirtCorner' : 'dirtGoal');
    nums.slice(0, days.length).forEach((c, i) => {
      const d = days[i]; if (!d) return;
      const rec = out.get(d.date) || out.set(d.date, { date: d.date, venue, kai, nichi: null, dow: d.dow, course: null, cushion: null, turfGoal: null, turfCorner: null, dirtGoal: null, dirtCorner: null, cushionAt: null, moistAt: null }).get(d.date);
      rec[key] = Number(c.t.replace(/\s+/g, ''));
    });
  }
  return [...out.values()].filter(o => o.turfGoal != null || o.dirtGoal != null || o.cushion != null);
}

/* 当日ぶん：開催中の馬場情報ページ（/keiba/baba/index.html, index2.html, index3.html）。
   アーカイブ（PDF）は開催終了後の翌木曜に更新されるので、今日の値はこちらでしか取れない。
   含水率は HTML に入っている（turf_line / dirt_line）。クッション値は JS で後から入るので取れない。 */
function parseLive(html) {
  const s = html.replace(/\r/g, '');
  const ven = (s.match(/馬場情報（(.+?)競馬場）/) || [])[1];
  const d = s.match(/（(\d{4})年(\d{1,2})月(\d{1,2})日（.曜）/);
  if (!ven || !d) return null;
  const kd = s.match(/第(\d+)回.+?競馬第(\d+)日/);
  const val = (id) => {
    const m = s.match(new RegExp(`id="${id}"[\\s\\S]{0,400}?class="gm">\\s*([\\d.]+)\\s*<[\\s\\S]{0,200}?class="c4">\\s*([\\d.]+)\\s*<`));
    return m ? [Number(m[1]), Number(m[2])] : [null, null];
  };
  const [tg, tc] = val('turf_line'), [dg, dc] = val('dirt_line');
  if (tg == null && dg == null) return null;
  return { date: `${d[1]}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}`, venue: ven, kai: kd ? Number(kd[1]) : null, nichi: kd ? Number(kd[2]) : null,
    dow: null, course: null, cushion: null, turfGoal: tg, turfCorner: tc, dirtGoal: dg, dirtCorner: dc, cushionAt: null, moistAt: null, live: true };
}

const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l) { try { const o = JSON.parse(l); done.add(`${o.date}|${o.venue}`); } catch { } }
const rows = [];
let nPdf = 0;
for (let y = Y0; y <= Y1; y++) {
  let html;
  try { html = (await get(`${BASE}/keiba/baba/archive/${y}.html`, { ttlDays: y === NOW.getFullYear() ? 0.2 : 3650 })).toString('latin1'); }
  catch (e) { console.error(`  ! ${y}年の一覧: ${e.message}`); continue; }
  const links = [...new Set([...html.matchAll(new RegExp(`/keiba/baba/archive/${y}pdf/([a-z]+)(\\d\\d)\\.pdf`, 'g'))].map(m => m[0]))];
  console.error(`${y}年: ${links.length} 開催`);
  for (const href of links) {
    const m = href.match(/\/(\w+?)(\d\d)\.pdf$/);
    const venue = VEN[m[1]]; if (!venue) { console.error(`  ? 知らない場 ${m[1]}`); continue; }
    const kai = Number(m[2]);
    try {
      const buf = await get(BASE + href, { binary: true, ttlDays: y === NOW.getFullYear() ? 3 : 3650 });
      let got = parseBaba(buf, venue, kai, y);
      if (!got.length) got = parseBabaOld(buf, venue, kai, y);   // 2018〜2019 の古い形式
      rows.push(...got); nPdf++;
      if (!got.length) console.error(`  ! ${y} ${venue}${kai} 行が取れない`);
    } catch (e) { console.error(`  ! ${y} ${venue}${kai}: ${e.message}`); }
  }
}
/* 開催中の当日ぶん（JRA_BABA_LIVE=0 で止められる） */
if (process.env.JRA_BABA_LIVE !== '0') {
  for (const p of ['index.html', 'index2.html', 'index3.html']) {
    try {
      const html = (await get(`${BASE}/keiba/baba/${p}`, { ttlDays: 0.02 })).toString('latin1');
      const utf = Buffer.from(html, 'latin1');
      const txt = new TextDecoder('shift_jis').decode(utf);
      const r = parseLive(txt);
      /* 開催が終わった場のページが残っていることがあるので、直近2日ぶんだけ受ける */
      const fresh = r && (Date.now() - Date.parse(r.date + 'T00:00:00')) / 86400000 <= 2;
      if (r && fresh) { rows.push(r); console.error(`  当日 ${r.date} ${r.venue}（芝 ${r.turfGoal ?? '—'} / ダート ${r.dirtGoal ?? '—'}）`); }
    } catch (e) { if (!/HTTP 404/.test(e.message)) console.error(`  ! 当日 ${p}: ${e.message}`); }
  }
}

/* 同じ日・同じ場が重複したら後勝ち（年をまたぐ開催の取り直し用）。アーカイブ（PDF）は当日ぶんより確かなので、
   live の行は既にアーカイブがあるときは上書きしない */
const byKey = new Map();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l) { try { const o = JSON.parse(l); byKey.set(`${o.date}|${o.venue}`, o); } catch { } }
for (const r of rows) { const k = `${r.date}|${r.venue}`; const cur = byKey.get(k); if (r.live && cur && !cur.live) continue; byKey.set(k, r); }
const all = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.venue.localeCompare(b.venue));
fs.writeFileSync(OUT, all.map(o => JSON.stringify(o)).join('\n') + '\n');
const withC = all.filter(o => o.cushion != null).length, withM = all.filter(o => o.turfGoal != null || o.dirtGoal != null).length;
console.error(`完了: PDF ${nPdf} 件 → ${all.length} 日（含水率 ${withM}・クッション値 ${withC}）-> data/jra/baba.jsonl`);
