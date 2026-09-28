/* 競輪場ガイド（kbank.html）のデータ → data/keirin/venues.json
   こたの依頼「各競輪場の特徴をまとめて：バンク情報、立地的に風が強い、ドーム など」。手で書かずに実測と公開情報から作る：
     形       … banks.json（Kドリームスの場のページ：周長・見なし直線・カント・幅員・「バンクの特徴」の文）
     天候     … races.jsonl の結果の「天候／風速」。**屋内（ドーム）は天候・風速の発表が無い**ので、
                30R 以上あって1件も記録が無い場を「屋内」と判定する（前橋・小倉がこれに当たる）
     決まり方 … 決まり手・ラインの位置別の1着率・ライン決着・人気1位の1着率・3連単の配当・地元の倍率（同じ得点順位の中での比較）
     風の効き … 全場まとめで、風速の帯ごとの決まり手の割合（風が強いと逃げが残りにくい、など）
   各項目に「全43場の中で何位か」を付け、一言の説明を自動で作る（場ごとの数字を文章に手で書かない＝CLAUDE.md の約束） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON, VENUES, regionOf } from './lib/kr.mjs';
import { loadRaces, raceOf, lineInfo, mktFor, BANKS, bankCls } from './lib/krfeat.mjs';

const races = loadRaces(fs.readFileSync(path.join(ROOT, 'data/keirin/races.jsonl'), 'utf8'), { pay: true }, l => /"result":\{/.test(l));
const r3 = v => v == null || !Number.isFinite(v) ? null : +v.toFixed(3);
const KIM = ['逃', '捲', '差', 'マ'];
const kimOf = k => KIM.findIndex(x => String(k || '').includes(x));
const slotName = ['先頭', '番手', '3番手以降', '単騎'];
const V = {}, WB = {}, ALL = { kim: [0, 0, 0, 0], slot: slotName.map(() => ({ n: 0, w: 0 })), l12: [0, 0], fav: [0, 0] };
const windBand = w => w == null ? null : w < 1 ? '〜0.9m' : w < 2 ? '1〜1.9m' : w < 3 ? '2〜2.9m' : '3m〜';
for (const r0 of races) {
  const r = raceOf(r0), L = lineInfo(r);
  const v = (V[r.venue] ||= { races: 0, wx: 0, wind: [], rain: 0, night: 0, midnight: 0, girls: 0, kim: [0, 0, 0, 0], slot: slotName.map(() => ({ n: 0, w: 0 })), l12: [0, 0], fav: [0, 0], e3: [], man: 0, home: {}, dates: new Set(), grades: {} });
  v.races++; v.dates.add(r.date); v.grades[r.grade || '?'] = (v.grades[r.grade || '?'] || 0) + 1;
  const res = r0.result;
  if (res.weather || res.wind != null) v.wx++;
  if (res.wind != null) v.wind.push(res.wind);
  if (/雨|雪/.test(res.weather || '')) v.rain++;
  if ((r.post || '') >= '17:00') v.night++;
  if ((r.post || '') >= '20:40' || (r.post || '') < '06:00') v.midnight++;
  if (r.girls) v.girls++;
  const ord = res.order, win = ord.find(o => o.pos === 1), sec = ord.find(o => o.pos === 2);
  const k = kimOf(win?.kimarite);
  if (k >= 0 && !r.girls) { v.kim[k]++; ALL.kim[k]++; const wb = windBand(res.wind); if (wb) { const x = (WB[wb] ||= { n: 0, kim: [0, 0, 0, 0], head: 0, hn: 0 }); x.n++; x.kim[k]++; } }
  const e3 = r0.pay?.e3?.[0]?.y; if (e3) { v.e3.push(e3); if (e3 >= 10000) v.man++; }
  const mk = mktFor(r, r.riders); if (mk && win) { const t = mk.p.indexOf(Math.max(...mk.p)); v.fav[1]++; ALL.fav[1]++; if (r.riders[t]?.no === win.no) { v.fav[0]++; ALL.fav[0]++; } }
  /* 地元：得点順位ごとに地元とそれ以外 */
  const sc = r.riders.map(h => h.score || 0);
  for (const h of r.riders) {
    const rank = Math.min(7, sc.filter(s => s > (h.score || 0)).length + 1), o = ord.find(x => x.no === h.no), w1 = o?.pos === 1 ? 1 : 0;
    const x = (v.home[rank] ||= { hn: 0, hw: 0, an: 0, aw: 0 }); if (h.pref === r.vpref) { x.hn++; x.hw += w1; } else { x.an++; x.aw += w1; }
  }
  if (r.girls || !L.known) continue;
  for (const h of r.riders) {
    const li = L.byNo.get(h.no); if (!li) continue;
    const s = li.size === 1 ? 3 : Math.min(li.pos, 2), w1 = ord.find(x => x.no === h.no)?.pos === 1 ? 1 : 0;
    v.slot[s].n++; v.slot[s].w += w1; ALL.slot[s].n++; ALL.slot[s].w += w1;
    if (s === 0 && w1) { const wb = windBand(res.wind); if (wb) WB[wb].head++; }
    if (s === 0) { const wb = windBand(res.wind); if (wb && WB[wb]) WB[wb].hn++; }
  }
  if (win && sec) { const a = L.byNo.get(win.no), b = L.byNo.get(sec.no); if (a && b) { v.l12[1]++; ALL.l12[1]++; if (a.li === b.li) { v.l12[0]++; ALL.l12[0]++; } } }
}
const share = a => { const n = a.reduce((x, y) => x + y, 0); return n ? a.map(c => r3(c / n)) : null; };
const allKim = share(ALL.kim), allSlot = ALL.slot.map(s => r3(s.w / s.n)), allL12 = r3(ALL.l12[0] / ALL.l12[1]), allFav = r3(ALL.fav[0] / ALL.fav[1]);
const out = {};
for (const [code, slug, name, pref] of VENUES) {
  const B = BANKS[name] || {}, v = V[name];
  const o = { code, slug, name, pref, region: regionOf(pref), bank: { len: B.len ?? null, cls: bankCls(B.len), straight: B.straight ?? null, cant: B.cant ?? null, cantStraight: B.cantStraight ?? null, width: B.width || null }, feature: B.feature || [] };
  if (v) {
    const ws = v.wind.slice().sort((a, b) => a - b);
    const indoor = v.races >= 30 && v.wx === 0;
    let hw = 0, ew = 0, hn = 0;
    for (const x of Object.values(v.home)) if (x.hn && x.an >= 10) { hn += x.hn; hw += x.hw; ew += x.hn * x.aw / x.an; }
    const e3 = v.e3.sort((a, b) => a - b);
    Object.assign(o, {
      races: v.races, days: v.dates.size, from: [...v.dates].sort()[0], to: [...v.dates].sort().at(-1), grades: v.grades,
      indoor, wind: ws.length ? { mean: r3(ws.reduce((a, b) => a + b, 0) / ws.length), max: ws.at(-1), p3: r3(ws.filter(w => w >= 3).length / ws.length), n: ws.length } : null,
      rain: v.wx ? r3(v.rain / v.races) : null, night: r3(v.night / v.races), midnight: r3(v.midnight / v.races), girls: r3(v.girls / v.races),
      kim: share(v.kim), kimN: v.kim.reduce((a, b) => a + b, 0),
      slot: v.slot.map((s, i) => ({ name: slotName[i], n: s.n, win: s.n ? r3(s.w / s.n) : null })),
      lineOneTwo: v.l12[1] ? r3(v.l12[0] / v.l12[1]) : null, fav: v.fav[1] ? r3(v.fav[0] / v.fav[1]) : null,
      e3Med: e3.length ? e3[Math.floor(e3.length / 2)] : null, man: e3.length ? r3(v.man / e3.length) : null,
      home: hn >= 20 ? { runs: hn, mult: ew ? +(hw / ew).toFixed(2) : null } : null,
    });
  }
  out[name] = o;
}
/* 全43場の中での順位（1＝いちばん大きい）と一言の説明 */
const rankBy = (get, desc = true) => { const xs = Object.values(out).filter(o => get(o) != null).sort((a, b) => desc ? get(b) - get(a) : get(a) - get(b)); xs.forEach((o, i) => { (o.rank ||= {})[get.name || ''] = i + 1; }); return xs.length; };
const R = {};
const defs = {
  straight: o => o.bank.straight, cant: o => o.bank.cant, wind: o => o.indoor ? null : o.wind?.mean,
  nige: o => o.kim && o.kimN >= 30 ? o.kim[0] : null, makuri: o => o.kim && o.kimN >= 30 ? o.kim[1] : null, sashi: o => o.kim && o.kimN >= 30 ? o.kim[2] + o.kim[3] : null,
  head: o => o.slot && o.slot[0].n >= 60 ? o.slot[0].win : null, lineOneTwo: o => o.races >= 30 ? o.lineOneTwo : null, e3Med: o => o.races >= 30 ? o.e3Med : null, fav: o => o.races >= 30 ? o.fav : null, home: o => o.home?.mult ?? null,
};
for (const [k, f] of Object.entries(defs)) { const xs = Object.values(out).filter(o => f(o) != null).sort((a, b) => f(b) - f(a)); R[k] = xs.length; xs.forEach((o, i) => { (o.rank ||= {})[k] = i + 1; }); }
const pc = v => (v * 100).toFixed(0) + '%';
for (const o of Object.values(out)) {
  const t = [], rk = o.rank || {};
  const top = (k, n = 8) => rk[k] && rk[k] <= n, bottom = (k, n = 8) => rk[k] && R[k] - rk[k] < n;
  if (o.indoor) t.push('屋内（ドーム）バンク。天候・風速の発表が無く、風と雨の影響を受けない');
  else if (o.wind) { if (top('wind', 6)) t.push(`風が強い場（平均 ${o.wind.mean.toFixed(2)}m、全${R.wind}場で ${rk.wind}位、最大 ${o.wind.max}m）`); else if (bottom('wind', 6)) t.push(`風が弱い場（平均 ${o.wind.mean.toFixed(2)}m）`); }
  if (o.bank.straight != null) { if (top('straight', 8)) t.push(`見なし直線が長い（${o.bank.straight}m、${rk.straight}位）＝差し・追込が届きやすい形`); else if (bottom('straight', 8)) t.push(`見なし直線が短い（${o.bank.straight}m、長い方から ${rk.straight}位）＝先行・捲りが残りやすい形`); }
  if (o.bank.cant != null) { if (top('cant', 8)) t.push(`カントがきつい（${o.bank.cant}°、${rk.cant}位）＝捲りのスピードが乗りやすい`); else if (bottom('cant', 6)) t.push(`カントが緩い（${o.bank.cant}°）`); }
  if (o.kim && o.kimN >= 30) {
    if (top('nige', 6)) t.push(`逃げの決まり手が多い（${pc(o.kim[0])}、全体 ${pc(allKim[0])}）`);
    if (top('makuri', 6)) t.push(`捲りが多い（${pc(o.kim[1])}、全体 ${pc(allKim[1])}）`);
    if (top('sashi', 6)) t.push(`差し・マークが多い（${pc(o.kim[2] + o.kim[3])}、全体 ${pc(allKim[2] + allKim[3])}）`);
  }
  if (o.slot && o.slot[0].n >= 60) { if (top('head', 6)) t.push(`ラインの先頭が勝ちやすい（1着率 ${pc(o.slot[0].win)}、全体 ${pc(allSlot[0])}）`); else if (bottom('head', 6)) t.push(`ラインの先頭が勝ちにくい（${pc(o.slot[0].win)}、全体 ${pc(allSlot[0])}）`); }
  if (o.races >= 30) {
    if (top('lineOneTwo', 6)) t.push(`ライン決着が多い（${pc(o.lineOneTwo)}、全体 ${pc(allL12)}）`);
    if (top('e3Med', 6)) t.push(`荒れやすい（3連単の中央値 ${o.e3Med.toLocaleString()}円・万車券 ${pc(o.man)}）`); else if (bottom('e3Med', 6)) t.push(`堅い（3連単の中央値 ${o.e3Med.toLocaleString()}円）`);
  }
  if (o.home && o.home.runs >= 40) { if (o.home.mult >= 1.8) t.push(`地元が強い（同じ得点順位の他の選手の ${o.home.mult}倍の1着率、${o.home.runs}走）`); else if (o.home.mult <= 1.0) t.push(`地元の上積みが見えない（${o.home.mult}倍、${o.home.runs}走）`); }
  if (o.night >= 0.5) t.push(o.midnight >= 0.3 ? 'ミッドナイト開催が多い' : 'ナイター開催が多い');
  if (!o.races) t.push('取り込み済みの期間に開催がない（データが入りしだい実測を出す）');
  o.summary = t;
}
const windEffect = Object.fromEntries(['〜0.9m', '1〜1.9m', '2〜2.9m', '3m〜'].filter(k => WB[k]).map(k => [k, { races: WB[k].n, kim: share(WB[k].kim), head: WB[k].hn ? r3(WB[k].head / WB[k].hn) : null }]));
writeJSON('data/keirin/venues.json', { built: new Date().toISOString(), from: races[0]?.date, to: races.at(-1)?.date, races: races.length, all: { kim: allKim, slot: allSlot, lineOneTwo: allL12, fav: allFav }, windEffect, ranks: R, venues: out });
console.error(`${Object.keys(out).length}場（実測あり ${Object.values(out).filter(o => o.races).length}、屋内 ${Object.values(out).filter(o => o.indoor).map(o => o.name).join('・')}）`);
console.error('風の効き（決まり手 逃/捲/差/マ・先頭の1着率）：' + Object.entries(windEffect).map(([k, x]) => `${k} ${x.races}R ${x.kim.map(pc).join('/')} 先頭${pc(x.head)}`).join('　'));
