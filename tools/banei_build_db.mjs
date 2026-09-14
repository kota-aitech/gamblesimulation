/* ばんえいの人的要因・血統・コース（馬番）・馬場水分・馬体重のデータベースを結果から作る → data/banei/index.json
   指数は南関・JRA と同じ「母平均に対する勝率の縮小ロジット」。表示（根拠の文言）と参照用。
   学習には lib/bnfeat.mjs の buildAsOf（レース時点）を使う。
     BN_DB_FROM / BN_DB_TO … 母集団の期間（YYYYMMDD）
     BN_DB_OUT … 出力先（既定 data/banei/index.json） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON } from './lib/bn.mjs';
import { classOf, loadPed } from './lib/bnfeat.mjs';

const FROM = process.env.BN_DB_FROM || '20000101', TO = process.env.BN_DB_TO || '29991231';
const OUT = process.env.BN_DB_OUT || 'data/banei/index.json';
const r3 = v => Math.round(v * 1000) / 1000;
const logit = p => Math.log(p / (1 - p));

const races = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/banei/results.jsonl'), 'utf8').split('\n')) {
  if (!l) continue; const r = JSON.parse(l);
  if (r.date < FROM || r.date > TO) continue;
  races.push(r);
}
races.sort((a, b) => a.raceId.localeCompare(b.raceId));
const cardsFile = path.join(ROOT, 'data/banei/cards.jsonl');
const PED = loadPed(fs.existsSync(cardsFile) ? fs.readFileSync(cardsFile, 'utf8') : '');
let runs = 0, wins = 0, p3 = 0;
for (const r of races) for (const e of r.entries) { if (typeof e.pos !== 'number') continue; runs++; if (e.pos === 1) wins++; if (e.pos <= 3) p3++; }
const P0 = wins / runs, P3 = p3 / runs;
console.error(`${races.length} レース（${races[0]?.date} 〜 ${races.at(-1)?.date}）${runs.toLocaleString()} 走。平均勝率 ${(P0 * 100).toFixed(1)}%／3着内率 ${(P3 * 100).toFixed(1)}%。血統 ${PED.size} 頭`);

const zero = () => ({ n: 0, w: 0, p3: 0 });
const bump = (m, k, e, extra) => { if (!k) return; let v = m.get(k); if (!v) m.set(k, v = { ...zero(), ...extra }); v.n++; if (e.pos === 1) v.w++; if (e.pos <= 3) v.p3++; return v; };
const J = new Map(), T = new Map(), C = new Map(), S = new Map(), B = new Map(), O = new Map(), H = new Map();
const G = new Map();                                   // 馬番
const MB = new Map();                                  // 水分ビン：勝ち時計・1人気の勝率・3連単配当
const BW = new Map();                                  // 馬体重帯
const LB = new Map();                                  // 積載/馬体重 の帯
const recent = new Date(); recent.setFullYear(recent.getFullYear() - 1);
const RECENT = `${recent.getFullYear()}${String(recent.getMonth() + 1).padStart(2, '0')}${String(recent.getDate()).padStart(2, '0')}`;
const moistBin = m => m == null ? null : m < 1 ? '〜0.9' : m < 1.5 ? '1.0〜1.4' : m < 2 ? '1.5〜1.9' : m < 2.5 ? '2.0〜2.4' : m < 3 ? '2.5〜2.9' : m < 4 ? '3.0〜3.9' : '4.0〜';
for (const r of races) {
  const n = r.entries.filter(e => typeof e.pos === 'number').length;
  const win = r.entries.find(e => e.pos === 1);
  const mb = moistBin(r.moist);
  if (mb) { let v = MB.get(mb); if (!v) MB.set(mb, v = { races: 0, time: 0, timeN: 0, fav: 0, favN: 0, santan: 0, santanN: 0, man: 0 }); v.races++; if (win?.time) { v.time += win.time; v.timeN++; } if (win?.pop) { v.favN++; if (win.pop === 1) v.fav++; } const st = r.pay?.santan?.[0]?.y; if (st) { v.santan += st; v.santanN++; if (st >= 10000) v.man++; } }
  for (const e of r.entries) {
    if (typeof e.pos !== 'number') continue;
    const j = bump(J, e.jockeyId, e, { name: (e.jockey || '').replace(/^[☆★▲△◇]/, '') });
    if (j && r.date >= RECENT) { j.n1 = (j.n1 || 0) + 1; if (e.pos === 1) j.w1 = (j.w1 || 0) + 1; }
    const t = bump(T, e.trainerId, e, { name: e.trainer });
    if (t && r.date >= RECENT) { t.n1 = (t.n1 || 0) + 1; if (e.pos === 1) t.w1 = (t.w1 || 0) + 1; }
    if (e.jockeyId && e.trainerId) bump(C, e.jockeyId + '|' + e.trainerId, e, {});
    const pd = PED.get(e.horseId) || {};
    bump(S, pd.sire, e, {}); bump(B, pd.damsire, e, {}); bump(O, pd.owner, e, {});
    const h = bump(H, e.horseId, e, { name: e.name }); if (h) h.last = r.date;
    if (e.no >= 1 && e.no <= 10 && n >= 8) bump(G, String(e.no), e, {});
    if (e.bw >= 600) bump(BW, String(Math.floor(e.bw / 50) * 50), e, {});
    if (e.bw >= 600 && e.load > 0) bump(LB, (Math.floor(e.load / e.bw * 20) / 20).toFixed(2), e, {});
  }
}
const shrunk = (w, n, prior, k) => logit((w + k * prior) / (n + k)) - logit(prior);
function actor(m, k = 50, min = 10) {
  const out = {};
  for (const [id, v] of m) {
    if (v.n < min) continue;
    out[id] = { name: v.name, n: v.n, w: v.w, p3: v.p3, win: r3(v.w / v.n), top3: r3(v.p3 / v.n), idx: r3(shrunk(v.w, v.n, P0, k)), idx3: r3(shrunk(v.p3, v.n, P3, k)) };
    if (v.n1) { out[id].n1 = v.n1; out[id].w1 = v.w1 || 0; out[id].hot = r3(shrunk(v.w1 || 0, v.n1, v.w / v.n, 20)); }
  }
  return out;
}
const jockey = actor(J), trainer = actor(T);
/* コンビは 騎手・調教師から期待される勝率からの上振れ */
const combo = {};
for (const [k, v] of C) {
  if (v.n < 10) continue;
  const [jid, tid] = k.split('|'); const ji = jockey[jid]?.idx ?? 0, ti = trainer[tid]?.idx ?? 0;
  const pExp = 1 / (1 + Math.exp(-(logit(P0) + 0.8 * ji + 0.6 * ti)));
  combo[k] = { n: v.n, w: v.w, cIdx: r3(logit((v.w + 40 * pExp) / (v.n + 40)) - logit(pExp)) };
}
const gateAll = [...G.values()].reduce((a, v) => ({ n: a.n + v.n, p3: a.p3 + v.p3, w: a.w + v.w }), { n: 0, p3: 0, w: 0 });
const gate = {};
for (const [no, v] of G) gate[no] = { n: v.n, w: v.w, p3: v.p3, win: r3(v.w / v.n), top3: r3(v.p3 / v.n), edge: r3((v.p3 / gateAll.p3) / (v.n / gateAll.n)) };
const band = m => Object.fromEntries([...m].sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => [k, { n: v.n, win: r3(v.w / v.n), top3: r3(v.p3 / v.n) }]));
const moist = Object.fromEntries([...MB].sort().map(([k, v]) => [k, { races: v.races, winTime: v.timeN ? r3(v.time / v.timeN) : null, favWin: v.favN ? r3(v.fav / v.favN) : null, santanAvg: v.santanN ? Math.round(v.santan / v.santanN) : null, man: v.santanN ? r3(v.man / v.santanN) : null }]));
const clsSet = {};
for (const r of races) { const c = classOf(r.name, r.cond); clsSet[`${c.grp}|${c.key}`] = (clsSet[`${c.grp}|${c.key}`] || 0) + 1; }

writeJSON(OUT, {
  meta: { built: new Date().toISOString().slice(0, 10), from: races[0]?.date, to: races.at(-1)?.date, races: races.length, runs, P0: r3(P0), P3: r3(P3), ped: PED.size },
  jockey, trainer, combo, sire: actor(S, 60, 20), bms: actor(B, 60, 20), owner: actor(O, 40, 10),
  gate, moist, bw: band(BW), loadBw: band(LB), classes: clsSet,
  horse: Object.fromEntries([...H].filter(([, v]) => v.n >= 1).map(([k, v]) => [k, { name: v.name, n: v.n, w: v.w, p3: v.p3, last: v.last }])),
});
console.error(`  騎手 ${Object.keys(jockey).length}／調教師 ${Object.keys(trainer).length}／コンビ ${Object.keys(combo).length}／種牡馬 ${Object.keys(actor(S, 60, 20)).length}／馬 ${H.size}`);
console.error('  馬番別の得失（3着内シェア÷出走シェア）: ' + Object.entries(gate).map(([k, v]) => `${k}番 ${v.edge}`).join(' '));
console.error('  水分別: ' + Object.entries(moist).map(([k, v]) => `${k}% ${v.winTime}秒/1人気${v.favWin != null ? (v.favWin * 100).toFixed(0) : '-'}%`).join(' / '));
