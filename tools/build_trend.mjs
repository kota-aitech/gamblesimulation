/* cards.jsonl の「前5走」レコード（＝実際に行われたレースの結果）を場・距離別に集計して
     - TREND_REF: 距離別の 脚質別3着内シェア / 内中外3着内シェア / 3角前方集団の3着内率（近1年・直近2ヶ月）
     - MEET:      直近の開催日ごとの 3角前方/後方の3着内回数と、3着内が多かった枠ベスト3
   を作る。どちらも従来は手打ちの参考値だった部分。
   出力: data/nankan/trend.<track>.json                                              */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON } from './lib/nk.mjs';

const WANT = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki,船橋:funabashi,浦和:urawa').split(',').map(s => s.split(':'));
const TODAY = process.env.NK_TODAY || new Date().toISOString().slice(0, 10);
const MEET_DAYS = Number(process.env.NK_MEET_DAYS || 14);
const r2 = x => Math.round(x * 1000) / 1000;
const ago = (d, days) => { const t = new Date(TODAY + 'T00:00:00'); t.setDate(t.getDate() - days); return d >= t.toISOString().slice(0, 10); };

/* 馬番 → 枠番（内側の枠から埋め、余りは外枠に1頭ずつ足す NAR/JRA の割り当て） */
function gateOf(no, n) {
  const base = Math.floor(n / 8), rem = n % 8, small = 8 - rem;
  const cut = small * base;                        // ここまでが base 頭の枠
  return no <= cut ? Math.ceil(no / Math.max(1, base)) : small + Math.ceil((no - cut) / (base + 1));
}
/* 3角（＝残り2コーナー地点）の通過順。コーナーが2つしかない短距離は1つ目を使う */
const c3of = c => c.length >= 3 ? c[c.length - 2] : c[0];
const styleOf = (c, field) => { const r = c[0] / (field + 1); return (r <= 0.22 || c[0] <= 2) ? 0 : r <= 0.45 ? 1 : r <= 0.72 ? 2 : 3; };

/* 前5走レコードを馬×日で重複排除して集める */
const runs = [];
const seen = new Set();
for (const line of fs.readFileSync(path.join(ROOT, 'data/nankan/cards.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const c = JSON.parse(line);
  for (const h of c.horses) for (const p of h.past) {
    const k = h.horseId + '|' + p.date;
    if (seen.has(k) || !p.corners.length || !p.field) continue;
    seen.add(k);
    runs.push(p);
  }
}
console.error(`前走レコード ${runs.length} 件（${runs.reduce((a, p) => p.date < a ? p.date : a, '9999')} 〜 ${runs.reduce((a, p) => p.date > a ? p.date : a, '0')}）`);

function summarize(rs) {
  const style = [0, 0, 0, 0], gate = [0, 0, 0], gateAll = [0, 0, 0];
  let f3 = 0, b3 = 0, top = 0;
  for (const p of rs) {
    { const g = gateOf(p.no, p.field); gateAll[g <= 3 ? 0 : g <= 6 ? 1 : 2]++; }
    // 前方/後方の判定は nankankeiba「レース傾向」に合わせて「頭数の半分より前/後ろ」
    const c3 = c3of(p.corners), front = c3 < p.field / 2, back = c3 > p.field / 2;
    if (p.pos <= 3) {
      top++;
      style[styleOf(p.corners, p.field)]++;
      const g = gateOf(p.no, p.field);
      gate[g <= 3 ? 0 : g <= 6 ? 1 : 2]++;
      if (front) f3++; else if (back) b3++;
    }
  }
  if (!top) return null;
  const sN = style.reduce((a, b) => a + b, 0) || 1, gN = gate.reduce((a, b) => a + b, 0) || 1;
  const aN = gateAll.reduce((a, b) => a + b, 0) || 1;
  // front3 = 3着内のうち3角で前方1/3にいた馬の割合（手打ち参考値と同じ尺度）
  // fb     = 前方集団 対 後方集団 の3着内回数比（レース傾向ページと同じ尺度）
  return { n: rs.length, top, front3: r2(f3 / top), fb: r2(f3 / (f3 + b3 || 1)),
    style: style.map(v => r2(v / sN)), gate: gate.map(v => r2(v / gN)),
    // gateBase = その枠グループの出走シェア。3着内シェアと比べて初めて有利不利が言える
    gateBase: gateAll.map(v => r2(v / aN)) };
}

for (const [jaName, key] of WANT) {
  const mine = runs.filter(p => p.track === jaName);
  const yearR = mine.filter(p => ago(p.date, 365)), recR = mine.filter(p => ago(p.date, 62));
  const dists = [...new Set(mine.map(p => p.dist))].sort((a, b) => a - b);
  const trendRef = {}, fallbackY = summarize(yearR), fallbackR = summarize(recR) || fallbackY;
  for (const d of dists) {
    const y = summarize(yearR.filter(p => p.dist === d));
    if (!y || y.top < 60) continue;                       // 標本が薄い距離は全体値で代用させる
    trendRef[d] = { year: y, recent: summarize(recR.filter(p => p.dist === d)) || y };
  }
  /* 直近の開催日ごと */
  const byDay = {};
  for (const p of mine) {
    const c3 = c3of(p.corners);
    const e = byDay[p.date] ||= { d: p.date, front: 0, back: 0, gate: {} };
    if (p.pos <= 3) {
      if (c3 < p.field / 2) e.front++; else if (c3 > p.field / 2) e.back++;
      const g = gateOf(p.no, p.field);
      e.gate[g] = (e.gate[g] || 0) + 1;
    }
  }
  const days = Object.values(byDay).filter(x => x.front + x.back >= 8).sort((a, b) => a.d.localeCompare(b.d)).slice(-MEET_DAYS)
    .map(x => {
      const dt = new Date(x.d + 'T00:00:00');
      return { d: `${dt.getMonth() + 1}/${dt.getDate()}(${'日月火水木金土'[dt.getDay()]})`, front: x.front, back: x.back,
        best: Object.entries(x.gate).map(([g, c]) => [Number(g), c]).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3) };
    });
  /* MEET はレース傾向ページの実測（fetch_trend.mjs）を優先し、無ければ前走欄からの推計を使う */
  const mp = path.join(ROOT, `data/nankan/meet.${key}.json`);
  const meet = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8'))
    : { name: `${days[0]?.d}〜${days[days.length - 1]?.d} の${days.length}日（前走欄からの推計）`, days, estimated: true };
  /* 馬場バイアスのスライダーを自動算出するための基準値。
     中心＝この場のふつうの値、幅＝開催日ごとのばらつき（標準偏差）*/
  const fbs = meet.days.map(d => (d.front + d.back) ? d.front / (d.front + d.back) : null).filter(v => v != null);
  const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const sd = a => Math.sqrt(mean(a.map(v => (v - mean(a)) ** 2)));
  const gdOf = t => ((t.gate[1] / (t.gateBase[1] || 1) + t.gate[2] / (t.gateBase[2] || 1)) / 2 - t.gate[0] / (t.gateBase[0] || 1));
  const calib = {
    frontMid: r2(0.4 * fallbackY.front3 + 0.3 * fallbackR.front3 + 0.3 * mean(fbs)),
    meetMid: r2(mean(fbs)),
    frontSd: r2(Math.max(0.03, sd(fbs))),
    gateMid: r2(gdOf(fallbackY)),
    gateSd: r2(Math.max(0.05, sd(Object.values(trendRef).map(t => gdOf(t.year))))),
  };
  writeJSON(`data/nankan/trend.${key}.json`, { track: jaName, builtAt: new Date().toISOString(), source: 'nankankeiba.com 出馬表の前5走欄＋レース傾向', trendRef, fallback: { year: fallbackY, recent: fallbackR }, calib, meet });
  console.error(`  基準: 前残り中心 ${calib.frontMid}±${calib.frontSd} / 内外中心 ${calib.gateMid}±${calib.gateSd}`);
  console.error(`${jaName}: 距離 ${Object.keys(trendRef).join('/')}  近1年 ${yearR.length}走（3着内 ${fallbackY.top}）前方3着内率 ${(fallbackY.front3 * 100).toFixed(0)}%  開催日 ${days.length}`);
}
