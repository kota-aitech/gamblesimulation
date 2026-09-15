/* 潮位表（気象庁の推算値）を取る → data/boat/tide.json
   干満差のある場（stadium.json の tide＝あり）について、いちばん近い気象庁の潮位観測点の
   年間ファイル（https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/{年}/{地点}.txt）を読む。
   1行＝1日：毎時潮位 24×3桁、年2 月2 日2 地点2、満潮 4回×(時分4桁+潮位3桁)、干潮 同。9999＝なし。
   推算値（天文潮）なので年に1回取れば足りる（12地点・12リクエスト。キャッシュ 200日）。
   潮位の単位は cm（観測基準面上）。場ごとの観測点は下の STATION。
   下関・若松は門司、鳴門は小松島、大村は長崎の値を「参考」として使う（同じ湾ではないので時刻が前後する）。
     BT_TIDE_YEAR … 年（既定 今年。12月は翌年ぶんも取る） */
import { get, readJSON, ROOT } from './lib/bt.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const STATION = {
  '03': { code: 'TK', name: '東京', note: null },
  '04': { code: 'TK', name: '東京', note: null },
  '06': { code: 'MI', name: '舞阪', note: null },
  '14': { code: 'KM', name: '小松島', note: '鳴門海峡とは時刻が前後する（参考値）' },
  '15': { code: 'TX', name: '多度津', note: null },
  '16': { code: 'UN', name: '宇野', note: null },
  '17': { code: 'Q8', name: '広島', note: null },
  '18': { code: 'QA', name: '徳山', note: null },
  '19': { code: 'MO', name: '門司', note: '下関の観測点が無いので関門海峡の門司（参考値）' },
  '20': { code: 'MO', name: '門司', note: '若松の観測点が無いので門司（参考値）' },
  '22': { code: 'QF', name: '博多', note: null },
  '24': { code: 'NS', name: '長崎', note: '大村湾の観測点が無いので長崎（湾内は干満差が小さく時刻もずれる。参考値）' },
};

const yearNow = new Date().getFullYear();
const years = [Number(process.env.BT_TIDE_YEAR || yearNow)];
if (!process.env.BT_TIDE_YEAR && new Date().getMonth() === 11) years.push(yearNow + 1);

function parseTxt(txt) {
  const days = {};
  for (const line of txt.split('\n')) {
    if (line.length < 80) continue;
    const h = []; for (let i = 0; i < 24; i++) h.push(Number(line.slice(i * 3, i * 3 + 3)));
    const yy = Number(line.slice(72, 74)), mm = Number(line.slice(74, 76)), dd = Number(line.slice(76, 78));
    const date = `${2000 + yy}${String(mm).padStart(2, '0')}${String(dd).padStart(2, '0')}`;
    const ev = (from) => { const a = []; for (let k = 0; k < 4; k++) { const s = line.slice(from + k * 7, from + k * 7 + 7); const t = s.slice(0, 4), lv = s.slice(4, 7); if (/9999/.test(t) || t.trim() === '') continue; const hh = Number(t.slice(0, 2)), mi = Number(t.slice(2, 4)); if (!Number.isFinite(hh) || !Number.isFinite(mi)) continue; a.push([hh * 60 + mi, Number(lv)]); } return a; };
    days[date] = { h, hi: ev(80), lo: ev(108) };
  }
  return days;
}

const codes = [...new Set(Object.values(STATION).map(s => s.code))];
const out = { built: new Date().toISOString(), years, unit: 'cm（観測基準面上・気象庁の推算値）', station: STATION, data: {} };
let prev = null;
try { prev = readJSON('data/boat/tide.json'); } catch { }
for (const code of codes) {
  out.data[code] = { ...(prev?.data?.[code] || {}) };
  for (const y of years) {
    const url = `https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/${y}/${code}.txt`;
    try {
      const txt = await get(url, { ttlDays: 200, tries: 2 });
      const d = parseTxt(txt);
      Object.assign(out.data[code], d);
      console.error(`  ${code} ${y}: ${Object.keys(d).length}日`);
    } catch (e) { console.error(`  ! ${code} ${y}: ${e.message}`); }
  }
}
/* 古い年は落とす（今年の前年まで） */
for (const code of codes) for (const k of Object.keys(out.data[code])) if (Number(k.slice(0, 4)) < yearNow - 1) delete out.data[code][k];
const p = path.join(ROOT, 'data/boat/tide.json');
fs.writeFileSync(p, JSON.stringify(out));
console.error(`-> data/boat/tide.json (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
