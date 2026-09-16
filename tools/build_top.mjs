/* TOPページ（top.html）用の要約を作る。全レースの段位・期待値・自信度・おすすめ買い目を
   1ファイルにまとめる。entries.*.json は1MBあるので、TOP用は軽い抜粋にする。
   出力: data/nankan/top.json                                                */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';

const TRACKS = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki,船橋:funabashi,浦和:urawa').split(',').map(s => s.split(':')[1]);
const PICK = fs.existsSync(path.join(ROOT, 'data/nankan/racepick.json')) ? readJSON('data/nankan/racepick.json') : null;
const BT = fs.existsSync(path.join(ROOT, 'data/nankan/backtest.json')) ? readJSON('data/nankan/backtest.json') : null;
const MDL = fs.existsSync(path.join(ROOT, 'data/nankan/model.json')) ? readJSON('data/nankan/model.json') : null;

const out = { builtAt: new Date().toISOString(), tracks: {}, meta: null,
  thresholds: PICK ? PICK.thresholds : null,
  validation: null };

for (const key of TRACKS) {
  const p = path.join(ROOT, `data/nankan/entries.${key}.json`);
  if (!fs.existsSync(p)) continue;
  const d = readJSON(`data/nankan/entries.${key}.json`);
  out.meta = d.meta;
  const days = {};
  for (const [dk, list] of Object.entries(d.days)) {
    days[dk] = list.map(r => {
      const hs = (d.entries[`${dk}|${r.r}`] || []).filter(h => !h.scratch);
      const top = hs.slice().sort((a, b) => (b.win || 0) - (a.win || 0)).slice(0, 4)
        .map(h => ({ no: h.no, gate: h.gate, name: h.name, mark: h.mark, win: h.win, top3: h.top3,
          style: h.style, jockey: h.jockey, odds: h.pubOdds || null }));
      /* 展開予想（3角の平均位置順）。TOP では馬番と枠だけの軽い形で持つ */
      const flow = hs.filter(h => h.c3 != null).sort((a, b) => a.c3 - b.c3)
        .map(h => [h.no, h.gate, +h.c3.toFixed(1), h.mark || '']);
      return { r: r.r, time: r.time, dist: r.dist, n: r.n, cls: r.cls, date: r.date,
        grade: r.grade || null, conf: r.conf ?? null, pTop: r.pTop ?? null,
        ev: r.ev || null, nPos: r.nPos || null, pace: r.pace || null,
        oddsSrc: r.oddsSrc || null, oddsAt: r.oddsAt || null, oddsUpd: r.oddsUpd || null,
        bets: r.bets ? { umaren: (r.bets.umaren || []).slice(0, 6), sanpuku: (r.bets.sanpuku || []).slice(0, 6) } : null,
        box: r.box || null,
        flow,
        top };
    });
  }
  out.tracks[key] = { track: d.track, days };
}

/* 検証の要約（TOPに「どれくらい当てになるか」を正直に出すため） */
if (MDL && MDL.metrics) {
  out.validation = {
    split: MDL.split, trainRaces: MDL.trainRaces, testRaces: MDL.testRaces,
    fund: MDL.metrics.fund, pub: MDL.metrics.pub, final: MDL.metrics.final,
  };
}
/* 実績（results.*.json の集計）。おすすめの根拠として画面に出す */
out.record = {};
for (const key of TRACKS) {
  const rp = path.join(ROOT, `data/nankan/results.${key}.json`);
  if (!fs.existsSync(rp)) continue;
  const R = readJSON(`data/nankan/results.${key}.json`);
  if (R.meta && R.meta.summary) out.record[R.track] = R.meta.summary;
}
if (BT && BT.tracks) {
  const t = {};
  for (const [name, d] of Object.entries(BT.tracks)) {
    const b = d.byModel && d.byModel.blend;
    if (!b) continue;
    t[name] = { races: d.races,
      umaren4: b.umaren && b.umaren[4] ? { roi: b.umaren[4].roi, hit: b.umaren[4].hitRate } : null,
      sanpuku4: b.sanpuku && b.sanpuku[4] ? { roi: b.sanpuku[4].roi, hit: b.sanpuku[4].hitRate } : null };
  }
  out.backtest = t;
}
writeJSON('data/nankan/top.json', out);
const n = Object.values(out.tracks).reduce((a, t) => a + Object.values(t.days).reduce((x, l) => x + l.length, 0), 0);
const g = {};
for (const t of Object.values(out.tracks)) for (const l of Object.values(t.days)) for (const r of l) g[r.grade || '—'] = (g[r.grade || '—'] || 0) + 1;
console.error(`${n} レース／段位 ${JSON.stringify(g)}`);
