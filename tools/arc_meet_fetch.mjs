/* 凱旋門賞の週末のパリロンシャン全レース（出馬表・前走・結果・払戻）と、馬場の物差しにする過去のロンシャン開催を取る。
   取得元は PMU（フランスの公式の馬券主催者）の公開 JSON。キー不要・UTF-8。
     /rest/client/1/programme/{DDMMYYYY}                         … その日の全開催（レース・距離・コース・ペネトロメーター・勝ち時計・着順）
     /rest/client/1/programme/{DDMMYYYY}/R{n}/C{n}/participants   … 出走馬（ゲート・斤量・騎手・調教師・血統・近走の記号・オッズ・着順・レース後のコメント）
     …/performances-detaillees/pretty                             … 前走の詳細（場・距離・馬場・勝ち時計・頭数・着順・着差・騎手）
     …/rapports-definitifs                                        … 確定払戻
   1件ずつ ARC_WAIT ms（既定 1200）あける。キャッシュは data/cache/arc/pmu/。
   **開催前・開催中に取ったページは短い TTL**（結果が出る前の空の中身を抱えない。CLAUDE.md 要件6）。
     node tools/arc_meet_fetch.mjs            週末ぶん＋過去のロンシャン（初回だけ数百ページ）
     ARC_HIST=0 node tools/arc_meet_fetch.mjs 週末ぶんだけ */
process.env.TZ = 'Asia/Tokyo';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data/cache/arc/pmu');
const API = 'https://online.turfinfo.api.pmu.fr/rest/client/1/programme/';
const RACE_DAY = process.env.ARC_DAY || '2026-10-04';
const WAIT = Number(process.env.ARC_WAIT || 1200);
const HIST_FROM = process.env.ARC_HIST_FROM || '2025-04-01';
fs.mkdirSync(path.join(DIR, 'hist'), { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toLocaleString('ja-JP', { hour12: false });
const ddmmyyyy = ymd => ymd.slice(8, 10) + ymd.slice(5, 7) + ymd.slice(0, 4);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const parisToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
/* 直近（パリの今日から前後2日）は短く取り直す。それより前は変わらない */
const recent = ymd => ymd >= addDays(parisToday, -2);

let last = 0, nGet = 0;
async function getJSON(url, file, ttlMin) {
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < ttlMin * 60000) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const wait = last + WAIT - Date.now(); if (wait > 0) await sleep(wait);
  last = Date.now(); nGet++;
  for (let t = 0; t < 3; t++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) nankan-sim/1.0', Accept: 'application/json' } });
      if (res.status === 204 || res.status === 404) { fs.writeFileSync(file, 'null'); return null; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const txt = await res.text(); const j = JSON.parse(txt);
      fs.writeFileSync(file + '.tmp', txt); fs.renameSync(file + '.tmp', file);
      return j;
    } catch (e) {
      console.error(`${stamp()} ! ${path.basename(file)} ${e.cause?.code || e.message}`);
      await sleep(5000 * (t + 1));
    }
  }
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}
/* その日のプログラムからロンシャン（LON）の開催だけを残す（1日400KB→数十KB。賭式の一覧と条件文は落とす） */
const lonOf = prog => {
  const r = prog?.programme?.reunions?.find(r => r.hippodrome?.code === 'LON');
  if (!r) return null;
  return { date: prog.programme.date, meteo: r.meteo || null, num: r.numOfficiel, courses: r.courses.map(c => { const o = { ...c }; delete o.paris; delete o.cagnottes; delete o.poolIds; return o; }) };
};

/* 1) 週末：凱旋門賞の当日と、その前2日にロンシャンの開催があればそれも */
const meetDays = [];
for (const d of [addDays(RACE_DAY, -2), addDays(RACE_DAY, -1), RACE_DAY]) {
  const ttl = recent(d) ? 10 : 60 * 24 * 30;
  const prog = await getJSON(API + ddmmyyyy(d), path.join(DIR, `prog.${d}.json`), ttl);
  const lon = lonOf(prog);
  if (!lon) { console.error(`${stamp()} ${d} ロンシャンの開催なし`); continue; }
  fs.writeFileSync(path.join(DIR, `lon.${d}.json`), JSON.stringify(lon));
  meetDays.push(d);
  for (const c of lon.courses) {
    const base = `${API}${ddmmyyyy(d)}/R${lon.num}/C${c.numOrdre}`;
    const done = !!c.arriveeDefinitive;
    const key = `${d}.C${c.numOrdre}`;
    /* 出走馬：確定後は長く、確定前は15分（オッズ・取消が動く） */
    await getJSON(`${base}/participants`, path.join(DIR, `part.${key}.json`), done ? 60 * 24 * 30 : 15);
    await getJSON(`${base}/performances-detaillees/pretty`, path.join(DIR, `perf.${key}.json`), done ? 60 * 24 * 30 : 60 * 6);
    if (c.rapportsDefinitifsDisponibles) await getJSON(`${base}/rapports-definitifs`, path.join(DIR, `pay.${key}.json`), 60 * 24 * 30);
  }
  console.error(`${stamp()} ${d} ロンシャン ${lon.courses.length}R（確定 ${lon.courses.filter(c => c.arriveeDefinitive).length}R）`);
}
fs.writeFileSync(path.join(DIR, 'meet_days.json'), JSON.stringify(meetDays));

/* 2) 過去のロンシャン開催（勝ち時計 × ペネトロメーターの物差し）。ロンシャンは4月〜10月だけ開催。
      1日1リクエストで、開催が無い日は null を覚える（過去は変わらない） */
if (process.env.ARC_HIST !== '0') {
  let n = 0;
  for (let d = HIST_FROM; d < meetDays[0] || d < addDays(RACE_DAY, -2); d = addDays(d, 1)) {
    const m = +d.slice(5, 7); if (m < 4 || m > 10) continue;
    const f = path.join(DIR, 'hist', `${d}.json`);
    if (fs.existsSync(f) && !recent(d)) continue;
    const tmp = path.join(DIR, 'hist', `.prog.${d}.json`);
    try { fs.unlinkSync(tmp); } catch { }
    const prog = await getJSON(API + ddmmyyyy(d), tmp, 0);
    try { fs.unlinkSync(tmp); } catch { }
    /* 取れなかった日は覚えない（次の周回で取り直す）。返ってきた中身の日付も確かめる */
    if (!prog && prog !== null) continue;
    if (prog && new Date(prog.programme.date + 7200000).toISOString().slice(0, 10) !== d) { console.error(`${stamp()} ! ${d} 日付が合わない`); continue; }
    const lon = lonOf(prog);
    fs.writeFileSync(f, JSON.stringify(lon));
    if (lon) n++;
  }
  if (n) console.error(`${stamp()} 過去のロンシャン ${n}開催を追加`);
}
console.error(`${stamp()} 取得 ${nGet}件`);
