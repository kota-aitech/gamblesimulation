/* cards.jsonl + index.json → index.html に埋め込む番組・出走馬データ
   data/nankan/races.<track>.json  { days:{...}, real:{...} }
   脚質/能力/上がり/距離/道悪 は CLAUDE.md の判定ルールを実装したもの。
   さらに 騎手・調教師・馬主・コンビ指数・勝負掛け指数 を各馬に付ける。      */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { makeDerivers } from './lib/horse.mjs';
import { buildShikenIndex, buildFormIndex } from './lib/feat.mjs';

const DB = readJSON('data/nankan/index.json');
const NDAYS = Number(process.env.NK_RACE_DAYS || 3);   // 今日・明日・明後日
const WANT = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki,船橋:funabashi,浦和:urawa').split(',').map(s => s.split(':'));
/* 能力・調教試験。新馬・転入初戦の唯一の実走記録なので寸評に載せる */
let SK = null;
try {
  SK = buildShikenIndex(fs.readFileSync(path.join(ROOT, 'data/nankan/shiken.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l)));
} catch {}
/* ---- cards.jsonl を読み、場ごとに最新 N 開催日を組み立てる ---- */
const lines = fs.readFileSync(path.join(ROOT, 'data/nankan/cards.jsonl'), 'utf8').split('\n').filter(Boolean);
const cards = lines.map(l => JSON.parse(l));

/* 騎手の調子（そのレース時点の直近成績）*/
let FM = null;
try {
  const rd = fs.readFileSync(path.join(ROOT, 'data/nankan/results.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  FM = buildFormIndex(cards, rd);
} catch {}
const { derive, human, pedigree, memoOf, shikenOf, bodyOf, formOf } = makeDerivers(DB, SK, FM);

const meta = { builtAt: new Date().toISOString(), leading: DB.window, pop: DB.pop, fit: DB.fit };

for (const [jaName, key] of WANT) {
  const mine = cards.filter(c => c.track === jaName && c.horses.length >= 4);
  const all = [...new Set(mine.map(c => c.date))].sort();
  /* 出馬表に載せるのは「今日以降」だけ。終わったレースは結果ページに回す
     （build_results.mjs）。開催の谷間だと0日になるが、それが正しい状態。 */
  const today = process.env.NK_TODAY || new Date().toLocaleDateString('sv-SE');
  const dates = all.filter(d => d >= today).slice(0, NDAYS);
  const days = {}, real = {}, full = {};
  for (const date of dates) {
    const rs = mine.filter(c => c.date === date).sort((a, b) => a.R - b.R);
    const d = new Date(date + 'T00:00:00');
    const dk = `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]}) 第${Number(rs[0].raceId.slice(12, 14))}日`;
    days[dk] = rs.map(c => ({ r: c.R, time: c.time, dist: c.dist, n: c.horses.filter(h => !h.scratch).length, cls: c.cls,
      date: c.date, raceId: c.raceId, night: !!c.night }));
    for (const c of rs) {
      const hs = c.horses.filter(h => !h.scratch).map(h => {
        const d2 = derive(h, c.dist), hu = human(h, jaName), pd = pedigree(h, c.dist);
        return { no: h.no, name: h.name, gate: h.gate, style: d2.style, epos: d2.epos, ability: d2.ability,
          close: d2.close, stamina: d2.stamina, wet: d2.wet, ...hu, ...pd,
          shiken: shikenOf(h), body: bodyOf(h), jform: formOf(h, c.raceId),
          ...memoOf(h, d2, hu, pd, c.dist, c.raceId),
          // ここから先は出馬表ページ（race.html）だけで使う
          // rid（前走のレースID）は特徴量づくり用。ページには載せないので落とす
          _full: { horseId: h.horseId, sexAge: h.sexAge, kg: h.kg, dam: h.dam, farm: h.farm, f3: d2.f3,
            epR: d2.st.ratio, past: (h.past || []).map(({ rid, ...p }) => p) },
        };
      });
      full[`${dk}|${c.R}`] = hs.map(({ memo, ...h }) => ({ ...h, ...h._full, _full: undefined }));
      real[`${dk}|${c.R}`] = hs.map(({ _full, note, memo, brief, ...rest }) => ({
        ...rest,
        // index.html の右パネル用は【近走】と【人】だけの短い版
        memo: (note || []).filter(([k]) => k === '近走' || k === '人').map(([k, v]) => `【${k}】${v}`).join(''),
      }));
    }
    // 取消馬も出馬表には出す（頭数には数えない）
    for (const c of rs) {
      const sc = c.horses.filter(h => h.scratch);
      if (sc.length) full[`${dk}|${c.R}`].push(...sc.map(h => ({ no: h.no, name: h.name, gate: h.gate, scratch: true,
        jockey: h.jockey, jockeyBase: h.jockeyBase, trainer: h.trainer, trainerBase: h.trainerBase,
        owner: h.owner, farm: h.farm, sire: h.sire, dam: h.dam, damSire: h.damSire,
        sexAge: h.sexAge, kg: h.kg, horseId: h.horseId, past: h.past })));
    }
  }
  writeJSON(`data/nankan/races.${key}.json`, { track: jaName, meta, days, real });
  writeJSON(`data/nankan/entries.${key}.json`, { track: jaName, meta, days, entries: full });
  console.error(`${jaName}: ${dates.length ? dates.join(', ') : '今日以降の開催なし'} → ${Object.keys(real).length} レース`);
}
