/* 払戻金一覧（/repay/{開催日14桁}.do）を取り込む。1日1リクエストで
   全レースの 単勝・複勝・枠複・普通馬複(馬連)・枠単・馬単・ワイド・三連複・三連単 が取れる。
   三連単の組番がそのまま 1〜3着の馬番なので、着順もここから復元できる。
   使い方: NK_BT_TRACKS=大井 NK_BT_FROM=2026-08-31 NK_BT_TO=2026-09-04 node tools/fetch_payouts.mjs
   出力: data/nankan/payouts.jsonl（1レース1行・追記）                          */
import fs from 'node:fs';
import path from 'node:path';
import { get, ROOT } from './lib/nk.mjs';

/* 開催前に取得した空ページを1年キャッシュしてしまうと、後から結果・払戻・オッズが
   永久に取れなくなる。直近の日付は短い TTL にして取り直せるようにする。 */
const freshTtl = (date, longDays = 365) => {
  const age = (Date.now() - new Date(date + 'T00:00:00').getTime()) / 86400000;
  return age < 4 ? 0.02 : longDays;
};

const BASE = 'https://www.nankankeiba.com';
const OUT = path.join(ROOT, 'data', 'nankan', 'payouts.jsonl');
const TRACKS = (process.env.NK_BT_TRACKS || '大井,川崎,船橋,浦和').split(',');
const FROM = process.env.NK_BT_FROM || '2000-01-01';
const TO = process.env.NK_BT_TO || new Date().toISOString().slice(0, 10);

const KEYS = [['単勝', 'tan'], ['複勝', 'fuku'], ['枠複', 'wakuren'], ['普通馬複', 'umaren'],
  ['枠単', 'wakutan'], ['馬単', 'umatan'], ['ワイド', 'wide'], ['三連複', 'sanpuku'], ['三連単', 'santan'], ['備考', null]];

function flat(html) {
  let t = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '|').replace(/&nbsp;/g, ' ');
  return t.replace(/\s+/g, ' ').replace(/(\|\s*)+/g, '|');
}
const n = x => { const v = String(x).replace(/,/g, ''); return /^\d+$/.test(v) ? Number(v) : null; };

/* 「組番|金額|人気」の3つ組を拾う。「-」は不成立 */
function triples(seg) {
  const p = seg.split('|').map(x => x.trim()).filter(x => x !== '');
  const out = [];
  for (let i = 0; i + 2 < p.length; i += 3) {
    if (p[i] === '-' || !/^[\d\-]+$/.test(p[i])) continue;
    const amt = n(p[i + 1]);
    if (amt == null) continue;
    out.push({ c: p[i], yen: amt, pop: n(p[i + 2]) });
  }
  return out;
}

function parseDay(html) {
  const t = flat(html);
  const races = [];
  for (const m of t.matchAll(/(\d+)R\|競走成績\|組番\|金額\|人気\|([\s\S]*?)(?=\d+R\|競走成績\|組番|$)/g)) {
    const R = Number(m[1]);
    let body = m[2];
    const cut = body.indexOf('|備考');
    if (cut >= 0) body = body.slice(0, cut);
    const pay = {};
    for (let i = 0; i < KEYS.length - 1; i++) {
      const [ja, key] = KEYS[i];
      const s = body.indexOf('|' + ja + '|') >= 0 ? body.indexOf('|' + ja + '|') + ja.length + 2 : (body.startsWith(ja + '|') ? ja.length + 1 : -1);
      if (s < 0) { pay[key] = []; continue; }
      let e = body.length;
      for (let j = i + 1; j < KEYS.length; j++) {
        const k = body.indexOf('|' + KEYS[j][0] + '|', s);
        if (k >= 0) { e = k; break; }
      }
      pay[key] = triples(body.slice(s, e));
    }
    /* 着順は三連単の組番から。無ければ馬単＋三連複で補う */
    let order = null;
    if (pay.santan[0]) order = pay.santan[0].c.split('-').map(Number);
    else if (pay.umatan[0] && pay.sanpuku[0]) {
      const t2 = pay.umatan[0].c.split('-').map(Number);
      const set = pay.sanpuku[0].c.split('-').map(Number);
      const third = set.find(x => !t2.includes(x));
      order = third ? [...t2, third] : null;
    }
    races.push({ R, pay, order });
  }
  return races;
}

/* 対象の開催日を cards.jsonl から拾う */
const days = new Map();
for (const line of fs.readFileSync(path.join(ROOT, 'data/nankan/cards.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const c = JSON.parse(line);
  if (!TRACKS.includes(c.track) || c.date < FROM || c.date > TO) continue;
  days.set(c.raceId.slice(0, 14), { date: c.date, track: c.track });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l) try { done.add(JSON.parse(l).raceId); } catch {}

let added = 0;
for (const [dayId, meta] of [...days].sort()) {
  /* 開催前（当日の1R より前）は払戻ページが 404 を返す。落とさずに次の日へ（以前は refresh が夜中に8分おきに「失敗」を出していた） */
  let html;
  try { html = await get(`${BASE}/repay/${dayId}.do`, { ttlDays: freshTtl(meta.date) }); }
  catch (e) { console.error(`  ! ${meta.date} ${meta.track} 払戻ページ ${e.message}（開催前ならまだ無い）`); continue; }
  const rs = parseDay(html);
  if (!rs.length) { console.error(`  ! ${meta.date} ${meta.track} 払戻が読めない`); continue; }
  for (const r of rs) {
    const raceId = dayId + String(r.R).padStart(2, '0');
    if (done.has(raceId)) continue;
    fs.appendFileSync(OUT, JSON.stringify({ raceId, date: meta.date, track: meta.track, ...r }) + '\n');
    done.add(raceId); added++;
  }
  console.error(`${meta.date} ${meta.track} ${rs.length}R（着順あり ${rs.filter(x => x.order).length}）`);
}
console.error(`完了: ${added} レース追加、合計 ${done.size}`);
