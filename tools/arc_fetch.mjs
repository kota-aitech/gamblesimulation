/* 凱旋門賞（パリロンシャン）の材料を取る。1ページずつ間隔をあけ、data/cache/arc/ に残す。
     JRA の海外競馬特設（出馬表・各馬紹介・過去の結果・歴史・前売りオッズ・馬場の基本情報）
     Open-Meteo（ロンシャンの過去2週間の降水と、レース当日までの予報。API キー不要）
   直近のページ（オッズ・予報）は ARC_TTL_H 時間（既定 3）で取り直す。歴史・過去の結果は30日。
     node tools/arc_fetch.mjs
   出力は data/cache/arc/*.html / *.json。組み立ては tools/arc_build.mjs */
process.env.TZ = 'Asia/Tokyo';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data/cache/arc');
const YEAR = process.env.ARC_YEAR || '2026';
const RACE_DAY = process.env.ARC_DAY || '2026-10-04';
const WAIT = Number(process.env.ARC_WAIT || 1500);
const TTL_H = Number(process.env.ARC_TTL_H || 3);
fs.mkdirSync(DIR, { recursive: true });

const J = `https://www.jra.go.jp/keiba/overseas/race/${YEAR}arc/`;
/* 名前 → [URL, 取り直す間隔（時間）] */
const PAGES = {
  declaration: [`https://www.jra.go.jp/news/${YEAR}10/100204.html`, TTL_H],
  card: [`https://www.jra.go.jp/news/${YEAR}10/pdf/100204.pdf`, TTL_H],
  netkeiba: [`https://race.netkeiba.com/race/shutuba_past_9.html?race_id=${YEAR}C8010105`, TTL_H],
  form: [`https://race.netkeiba.com/race/shutuba_past.html?race_id=${YEAR}C8010105`, TTL_H],
  pedigree: [`https://race.netkeiba.com/race/shutuba.html?race_id=${YEAR}C8010105`, TTL_H],
  overseas: ['https://www.sportinglife.com/racing/news/ryan-moore-rides-benvenuto-cellini-in-arc-de-triomphe/234599', TTL_H],
  index: [`${J}index.html`, TTL_H],
  syutsuba: [`${J}syutsuba.html`, TTL_H],
  horse: [`${J}horse.html`, 24],
  expert: [`${J}expert.html`, 12],
  morning: [`${J}morning.html`, TTL_H],
  past: [`${J}past.html`, 720],
  history: [`${J}history.html`, 720],
  basic: [`${J}basic.html`, 720],
  kaiko: [`${J}kaiko.html`, 24],
  entries: [`${J}pdf/entries.pdf`, 12],
};
/* ロンシャン（Hippodrome de ParisLongchamp）48.858N 2.232E。過去14日の実績と、当日までの予報 */
const LAT = 48.858, LON = 2.232;
const meteo = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
  + `&daily=precipitation_sum,rain_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration,wind_speed_10m_max,precipitation_probability_max,relative_humidity_2m_mean`
  + `&hourly=precipitation,temperature_2m,relative_humidity_2m,wind_speed_10m,soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm`
  + `&timezone=Europe%2FParis&past_days=14&forecast_days=7`;
PAGES.meteo = [meteo, TTL_H];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toLocaleString('ja-JP', { hour12: false });
const only = process.argv.slice(2);
let first = true;
for (const [name, [url, ttlH]] of Object.entries(PAGES)) {
  if (only.length && !only.includes(name)) continue;
  const ext = url.endsWith('.pdf') ? 'pdf' : name === 'meteo' ? 'json' : 'html';
  const file = path.join(DIR, `${name}.${ext}`);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < ttlH * 3600e3 && fs.statSync(file).size > 500) continue;
  if (!first) await sleep(WAIT); first = false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) nankan-sim/1.0', 'Accept': '*/*', 'Referer': J } });
    if (!res.ok) { console.error(`${stamp()} ! ${name} HTTP ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) { console.error(`${stamp()} ! ${name} 中身が小さい（${buf.length}B）`); continue; }
    if (ext === 'json') JSON.parse(buf.toString());
    fs.writeFileSync(file + '.tmp', buf);
    fs.renameSync(file + '.tmp', file);
    console.error(`${stamp()} ${name} ${(buf.length / 1024).toFixed(0)}KB`);
  } catch (e) { console.error(`${stamp()} ! ${name} ${e.cause?.code || e.message}`); }
}
/* Wikipedia（英語）の年ごとの凱旋門賞のページ：全着順・ゲート・年齢・調教国。過去分は一度取れば変わらない */
const UA = { 'User-Agent': 'nankan-sim/1.0 (research; low-rate)' };
const WP_FROM = Number(process.env.ARC_WP_FROM || 1995);
async function cached(file, url, ttlH, headers = UA) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0 && Date.now() - fs.statSync(file).mtimeMs < ttlH * 3600e3) return;
  await sleep(WAIT);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(45000), headers });
    if (!res.ok) { console.error(`${stamp()} ! ${path.basename(file)} HTTP ${res.status}`); return; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('empty response');
    if (file.endsWith('.json')) JSON.parse(buf.toString());
    fs.writeFileSync(file + '.tmp', buf);
    fs.renameSync(file + '.tmp', file);
    console.error(`${stamp()} ${path.basename(file)}`);
  } catch (e) { console.error(`${stamp()} ! ${path.basename(file)} ${e.cause?.code || e.message}`); }
}
if (!only.length || only.includes('wp')) {
  for (let y = WP_FROM; y < Number(YEAR); y++)
    await cached(path.join(DIR, `wp${y}.txt`), `https://en.wikipedia.org/w/index.php?title=${y}_Prix_de_l%27Arc_de_Triomphe&action=raw`, 24 * 365);
}
/* Wikidata：歴代の勝ち馬（年ごとの項目の winner）と父・父の父・父の父の父・母の父。抜けている年は馬名で引く */
const sparql = q => `https://query.wikidata.org/sparql?query=${encodeURIComponent(q)}`;
const LBL = 'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }';
if (!only.length || only.includes('wd')) {
  await cached(path.join(DIR, 'wd_winners.csv'), sparql(`SELECT ?evLabel ?hLabel ?sLabel ?ssLabel ?sssLabel ?bmsLabel WHERE { ?ev wdt:P3450 wd:Q422296 . ?ev wdt:P1346 ?h . OPTIONAL { ?h wdt:P22 ?s . OPTIONAL { ?s wdt:P22 ?ss . OPTIONAL { ?ss wdt:P22 ?sss } } } OPTIONAL { ?h wdt:P25 ?d . ?d wdt:P22 ?bms } ${LBL} }`), 24 * 30, { ...UA, Accept: 'text/csv' });
  /* 名前で引く分（勝ち馬の抜け・今年の出走馬・その父）。arc_build が data/cache/arc/wd_names.txt に名前を書く */
  const nf = path.join(DIR, 'wd_names.txt');
  if (fs.existsSync(nf)) {
    const names = fs.readFileSync(nf, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
    const vals = names.map(n => `"${n.replace(/"/g, '')}"@en`).join(' ');
    await cached(path.join(DIR, 'wd_names.csv'), sparql(`SELECT ?n ?h ?born ?sLabel ?ssLabel ?sssLabel ?bmsLabel WHERE { VALUES ?n { ${vals} } ?h rdfs:label ?n . ?h wdt:P22 ?s . OPTIONAL { ?h wdt:P569 ?born } OPTIONAL { ?s wdt:P22 ?ss . OPTIONAL { ?ss wdt:P22 ?sss } } OPTIONAL { ?h wdt:P25 ?d . ?d wdt:P22 ?bms } ${LBL} }`), 24 * 7, { ...UA, Accept: 'text/csv' });
  }
}
/* 過去の凱旋門賞の週のロンシャンの天気（ERA5 再解析。降水・蒸発散・土壌水分）。馬場の硬度（ペネトロメーター）との関係を測る */
if (!only.length || only.includes('era5')) {
  const F = 1972, T = Number(YEAR) - 1;
  await cached(path.join(DIR, 'era5.json'), `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}&start_date=${F}-09-01&end_date=${T}-10-12`
    + `&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max&timezone=Europe%2FParis`, 24 * 365);
}
console.error(`${stamp()} 対象日 ${RACE_DAY}`);
