/* nankankeiba「レース傾向」を開催日ごとに取得して data/nankan/meet.<track>.json に落とす。
   ここで取れるのは各日の
     - 3着内回数ベスト3枠
     - 1〜3着馬の3角位置（前方集団 / 後方集団の頭数）… 「頭数の半分より前/後ろ」で判定
   これまで手入力していた MEET_OI / MEET_KW の中身そのもの。
   対象の開催日は cards.jsonl の raceId から拾う。                                  */
import fs from 'node:fs';
import path from 'node:path';
import { get, text, num, ROOT, writeJSON } from './lib/nk.mjs';

const BASE = 'https://www.nankankeiba.com';
const WANT = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki,船橋:funabashi,浦和:urawa').split(',').map(s => s.split(':'));
const JO = { '浦和': '18', '船橋': '19', '大井': '20', '川崎': '21' };
const NDAYS = Number(process.env.NK_MEET_DAYS || 14);
const TODAY = process.env.NK_TODAY || new Date().toISOString().slice(0, 10);

/* cards.jsonl から 開催日 → raceId 先頭14桁 を集める */
const meets = {};
for (const line of fs.readFileSync(path.join(ROOT, 'data/nankan/cards.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const c = JSON.parse(line);
  (meets[c.track] ||= {})[c.date] = c.raceId.slice(0, 14);
}

/* 1ページに開催の全日ぶんのブロックが順に入っている。日目(1始まり)で選ぶ */
function parseDay(html, nichi) {
  const t = text(html.replace(/<[^>]+>/g, '|')).replace(/\s+/g, ' ');
  const blocks = t.split('枠番傾向').slice(1);
  const b = blocks[nichi - 1];
  if (!b || /表示するレース傾向がありません/.test(b.slice(0, 200))) return null;
  const head = b.slice(0, 700);
  const fb = /前方集団[|\s：:]*([\d]+)頭[|\s]*後方集団[|\s：:]*([\d]+)頭/.exec(head);
  const best = [];
  for (const m of head.slice(0, 200).matchAll(/\|\s*([1-8])\s*\|\s*(\d+)回/g))
    if (best.length < 3 && !best.some(x => x[0] === Number(m[1]))) best.push([Number(m[1]), Number(m[2])]);
  const asof = (/(\d+レース終了時|全レース終了)/.exec(t.slice(0, t.indexOf('枠番傾向'))) || [])[1] || '';
  if (!fb && !best.length) return null;
  return { front: fb ? num(fb[1]) : 0, back: fb ? num(fb[2]) : 0, best, asof };
}

for (const [jaName, key] of WANT) {
  const dates = Object.keys(meets[jaName] || {}).sort().filter(d => d <= TODAY).slice(-NDAYS);
  const days = [];
  for (const date of dates) {
    const id = meets[jaName][date];
    // 開催ごとに1ページ。日目でブロックを選ぶのでキャッシュが効く
    const url = `${BASE}/race_trend/${date.slice(0, 4)}${id.slice(8, 14)}.do`;
    let r = null;
    try { r = parseDay(await get(url, { ttlDays: date >= TODAY.slice(0, 8) ? 0.05 : 365 }), Number(id.slice(12, 14))); }
    catch (e) { console.error(`  ! ${date} ${e.message}`); }
    if (!r) { console.error(`  - ${date} 傾向なし`); continue; }
    const dt = new Date(date + 'T00:00:00');
    days.push({ d: `${dt.getMonth() + 1}/${dt.getDate()}(${'日月火水木金土'[dt.getDay()]})`, date, ...r,
      ...(/全レース/.test(r.asof) ? {} : r.asof ? { partial: r.asof } : {}) });
  }
  const kai = days.length ? meets[jaName][days[days.length - 1].date].slice(10, 12).replace(/^0/, '') : '';
  writeJSON(`data/nankan/meet.${key}.json`, {
    track: jaName, source: 'nankankeiba.com レース傾向（3着内回数ベスト3枠 / 1〜3着馬の3角位置）',
    name: `${days[0]?.d}〜${days[days.length - 1]?.d} の${days.length}日`,
    days: days.map(({ date, asof, ...x }) => x),
  });
  console.error(`${jaName}: ${days.length}日  ${days.map(d => `${d.d} ${d.front}/${d.back}`).join('  ')}`);
}
