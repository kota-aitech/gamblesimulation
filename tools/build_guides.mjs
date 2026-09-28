/* 競艇場ガイド（bbank.html）・競馬場ガイド（hbank.html）のデータ → data/boat/guide.json・data/guide_horse.json
   競輪場ガイド（keirin_build_venues.mjs）と同じ考え方：形は公式の公開情報、特徴は結果の実測、一言は同じ競技の場どうしの順位から自動で作る。
     ボート … data/boat/stadium.json（公式の場データ：水質・干満差・モーター・レコード・季節別・コース別）＋ data/boat/results.jsonl（3年ぶんの K）
     中央   … data/jra/course.json（JRA のコース紹介：直線・高低差・一周・発走距離・解説文）＋ data/jra/results.jsonl（5年ぶん）
     南関   … data/nankan/course.json（nankankeiba のコース情報）＋ trend.<場>.json（距離別の前残り・脚質・枠）＋ results.jsonl／payouts.jsonl
     ばんえい … data/banei/index.json（馬場水分の帯・馬番の得失）＋ results.jsonl
   GUIDE_ONLY=boat|horse で片方だけ作る */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = rel => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; } };
const wr = (rel, o) => { fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(o)); console.error(`-> ${rel} (${(fs.statSync(path.join(ROOT, rel)).size / 1024).toFixed(0)} KB)`); };
const r3 = v => v == null || !Number.isFinite(v) ? null : +v.toFixed(3);
const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pc = v => v == null ? '—' : (v * 100).toFixed(0) + '%';
async function eachLine(rel, fn) {
  const f = path.join(ROOT, rel); if (!fs.existsSync(f)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  for await (const l of rl) { if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; } fn(o); }
}
/* 順位を付けて、上位・下位 n に一言を足す */
function ranker(list) {
  const R = {};
  return {
    rank(key, get) { const xs = list.filter(o => get(o) != null).sort((a, b) => get(b) - get(a)); R[key] = xs.length; xs.forEach((o, i) => { (o.rank ||= {})[key] = i + 1; }); },
    top: (o, k, n) => o.rank?.[k] && o.rank[k] <= n, bottom: (o, k, n) => o.rank?.[k] && R[k] - o.rank[k] < n, R,
  };
}
const ONLY = process.env.GUIDE_ONLY || '';

/* ================= ボート ================= */
if (ONLY !== 'horse') {
  const ST = rd('data/boat/stadium.json') || {};
  const V = {};
  const KIM = ['逃げ', '差し', 'まくり', 'まくり差し', '抜き', '恵まれ'];
  await eachLine('data/boat/results.jsonl', r => {
    const v = (V[r.jcd] ||= { races: 0, c1: 0, c1n: 0, kim: [0, 0, 0, 0, 0, 0], wind: [], wave: [], stable: 0, rain: 0, ex3: [], man: 0, windC1: { calm: [0, 0], mid: [0, 0], strong: [0, 0] }, waveC1: { low: [0, 0], high: [0, 0] }, st: [] });
    v.races++;
    const w1 = r.entries.find(e => e.pos === '01'); const c1e = r.entries.find(e => e.course === 1);
    if (c1e) { v.c1n++; if (w1 && w1.course === 1) v.c1++; const b = r.wind == null ? null : r.wind <= 2 ? 'calm' : r.wind <= 4 ? 'mid' : 'strong'; if (b) { v.windC1[b][1]++; if (w1?.course === 1) v.windC1[b][0]++; } const wb = r.wave == null ? null : r.wave <= 3 ? 'low' : r.wave >= 6 ? 'high' : null; if (wb) { v.waveC1[wb][1]++; if (w1?.course === 1) v.waveC1[wb][0]++; } }
    const k = KIM.indexOf(r.kimari); if (k >= 0) v.kim[k]++;
    if (r.wind != null) v.wind.push(r.wind); if (r.wave != null) v.wave.push(r.wave);
    if (r.stable) v.stable++; if (/雨|雪/.test(r.weather || '')) v.rain++;
    const e3 = r.pay?.ex3?.[0]?.y; if (e3) { v.ex3.push(e3); if (e3 >= 10000) v.man++; }
    for (const e of r.entries) if (typeof e.st === 'number' && e.st >= 0 && e.st < 0.5) v.st.push(e.st);
  });
  const list = Object.entries(ST).map(([jcd, s]) => {
    const v = V[jcd];
    const kn = v ? v.kim.reduce((a, b) => a + b, 0) : 0;
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const seas = s.seasons ? Object.fromEntries(Object.entries(s.seasons).map(([k, x]) => [k, x.rank?.[0]?.[0] != null ? +(x.rank[0][0] / 100).toFixed(3) : null])) : null;
    return {
      jcd, name: s.name, pref: s.pref, area: s.area, water: s.water, tide: s.tide, motorType: s.motorType, record: s.record,
      official: { from: s.from, to: s.to, courseWin: s.rank ? s.rank.map(x => +(x[0] / 100).toFixed(3)) : null, take: s.take ? s.take.map((x, i) => +(x[i] / 100).toFixed(3)) : null, seasons: seas },
      races: v?.races || 0, c1: v && v.c1n ? r3(v.c1 / v.c1n) : null,
      kim: kn ? v.kim.map(c => r3(c / kn)) : null,
      wind: v ? { mean: r3(mean(v.wind)), p5: r3(v.wind.filter(x => x >= 5).length / (v.wind.length || 1)), max: v.wind.length ? Math.max(...v.wind) : null } : null,
      wave: v ? { mean: r3(mean(v.wave)), p5: r3(v.wave.filter(x => x >= 5).length / (v.wave.length || 1)), max: v.wave.length ? Math.max(...v.wave) : null } : null,
      windC1: v ? Object.fromEntries(Object.entries(v.windC1).map(([k, [a, b]]) => [k, b >= 50 ? { win: r3(a / b), n: b } : null])) : null,
      waveC1: v ? Object.fromEntries(Object.entries(v.waveC1).map(([k, [a, b]]) => [k, b >= 50 ? { win: r3(a / b), n: b } : null])) : null,
      stable: v ? r3(v.stable / v.races) : null, rain: v ? r3(v.rain / v.races) : null,
      ex3Med: v ? med(v.ex3) : null, man: v && v.ex3.length ? r3(v.man / v.ex3.length) : null, st: v ? r3(mean(v.st)) : null,
    };
  }).sort((a, b) => a.jcd.localeCompare(b.jcd));
  const K = ranker(list);
  K.rank('c1', o => o.c1); K.rank('wind', o => o.wind?.mean); K.rank('wave', o => o.wave?.mean); K.rank('ex3Med', o => o.ex3Med); K.rank('man', o => o.man);
  K.rank('makuri', o => o.kim ? o.kim[2] + o.kim[3] : null); K.rank('sashi', o => o.kim ? o.kim[1] : null); K.rank('stable', o => o.stable);
  K.rank('seasonGap', o => { const s = Object.values(o.official.seasons || {}).filter(v => v != null); return s.length >= 3 ? Math.max(...s) - Math.min(...s) : null; });
  const allC1 = list.reduce((a, o) => a + (o.c1 || 0) * o.races, 0) / list.reduce((a, o) => a + (o.c1 != null ? o.races : 0), 0);
  for (const o of list) {
    const t = [];
    if (K.top(o, 'c1', 5)) t.push(`イン（1コース）が強い（1着率 ${pc(o.c1)}、24場で ${o.rank.c1}位、全体 ${pc(allC1)}）`);
    if (K.bottom(o, 'c1', 5)) t.push(`インが弱い（1コースの1着率 ${pc(o.c1)}、全体 ${pc(allC1)}）`);
    if (K.top(o, 'makuri', 4)) t.push(`まくり・まくり差しが多い（${pc(o.kim[2] + o.kim[3])}）`);
    if (K.top(o, 'sashi', 4)) t.push(`差しが多い（${pc(o.kim[1])}）`);
    if (K.top(o, 'wind', 5)) t.push(`風が強い水面（平均 ${o.wind.mean.toFixed(1)}m、5m以上 ${pc(o.wind.p5)}、24場で ${o.rank.wind}位）`);
    else if (K.bottom(o, 'wind', 4)) t.push(`風が弱い水面（平均 ${o.wind.mean.toFixed(1)}m）`);
    if (K.top(o, 'wave', 5)) t.push(`波が立ちやすい（平均 ${o.wave.mean.toFixed(1)}cm、5cm以上 ${pc(o.wave.p5)}）`);
    if (o.water === '海水' && o.tide === 'あり') t.push('海水で干満差あり（潮の満ち引きで水位とうねりが変わる）');
    else if (o.water === '汽水') t.push(`汽水${o.tide === 'あり' ? '・干満差あり' : ''}（川の流れや潮の影響を受ける）`);
    else if (o.water === '淡水') t.push('淡水（うねりが少ない静水面）');
    if (o.windC1?.calm && o.windC1?.strong && o.windC1.calm.win - o.windC1.strong.win >= 0.06) t.push(`風が強い日はインが崩れる（1コース1着率 風2m以下 ${pc(o.windC1.calm.win)} → 5m以上 ${pc(o.windC1.strong.win)}、${o.windC1.strong.n}R）`);
    if (o.stable >= 0.03) t.push(`安定板の使用が多い（${pc(o.stable)}のレース）`);
    if (K.top(o, 'ex3Med', 5)) t.push(`荒れやすい（3連単の中央値 ${o.ex3Med.toLocaleString()}円・万舟 ${pc(o.man)}）`);
    else if (K.bottom(o, 'ex3Med', 5)) t.push(`堅い（3連単の中央値 ${o.ex3Med.toLocaleString()}円）`);
    if (K.top(o, 'seasonGap', 5)) { const s = Object.entries(o.official.seasons).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]); t.push(`季節でインの強さが変わる（1コース1着率 ${s[0][0]} ${pc(s[0][1])} ↔ ${s.at(-1)[0]} ${pc(s.at(-1)[1])}）`); }
    o.summary = t;
  }
  wr('data/boat/guide.json', { built: new Date().toISOString(), allC1: r3(allC1), ranks: K.R, venues: list });
  console.error(`ボート ${list.length}場：${list.slice(0, 3).map(o => `${o.name}「${o.summary.slice(0, 2).join('／')}」`).join(' ')}`);
}

/* ================= 競馬 ================= */
if (ONLY !== 'boat') {
  const out = { built: new Date().toISOString(), jra: [], nankan: [], banei: null };
  /* ---- 中央：場×芝ダ ---- */
  const JC = rd('data/jra/course.json')?.venues || {};
  const J = {};
  await eachLine('data/jra/results.jsonl', r => {
    if (r.surface === '障' || !r.entries?.length) return;
    const sf = r.surface === '芝' ? 'turf' : 'dirt';
    const v = ((J[r.venue] ||= {})[sf] ||= { races: 0, fav: [0, 0], front: 0, back: 0, wn: 0, inner: [0, 0], outer: [0, 0], heavy: 0, e3: [], man: 0, agari: [] });
    v.races++;
    const ok = r.entries.filter(e => typeof e.pos === 'number'); const n = ok.length; if (!n) return;
    const w = ok.find(e => e.pos === 1);
    const fav = ok.find(e => e.pop === 1); if (fav) { v.fav[1]++; if (fav.pos === 1) v.fav[0]++; }
    if (w?.pass) { const c = String(w.pass).split('-').map(Number).filter(x => x > 0); const p = c.at(-1); if (p) { v.wn++; if (p / n <= 0.25 || p <= 2) v.front++; else if (p / n > 0.5) v.back++; } }
    if (w?.agari) v.agari.push(w.agari);
    for (const e of ok) { if (e.waku <= 2) { v.inner[1]++; if (e.pos <= 3) v.inner[0]++; } else if (e.waku >= 7) { v.outer[1]++; if (e.pos <= 3) v.outer[0]++; } }
    if (/重|不良/.test(r.baba || '')) v.heavy++;
    const e3 = r.pay?.santan?.[0]?.y; if (e3) { v.e3.push(e3); if (e3 >= 100000) v.man++; }
  });
  for (const [name, c] of Object.entries(JC)) {
    const o = { name, code: c.code, turn: c.turn, notes: c.notes || [], src: c.src };
    for (const sf of ['turf', 'dirt']) {
      const g = c[sf] || {}, v = J[name]?.[sf];
      o[sf] = { len: g.len ?? null, straight: g.straight || null, height: g.height || null, width: g.width || null, dists: g.dists || [],
        races: v?.races || 0, fav: v?.fav[1] ? r3(v.fav[0] / v.fav[1]) : null, front: v?.wn ? r3(v.front / v.wn) : null, back: v?.wn ? r3(v.back / v.wn) : null,
        gateEdge: v && v.inner[1] && v.outer[1] ? r3(v.inner[0] / v.inner[1] - v.outer[0] / v.outer[1]) : null, heavy: v ? r3(v.heavy / v.races) : null,
        e3Med: v ? med(v.e3) : null, man: v?.e3.length ? r3(v.man / v.e3.length) : null, agari: v ? r3(med(v.agari)) : null };
    }
    out.jra.push(o);
  }
  out.jra.sort((a, b) => a.code.localeCompare(b.code));
  for (const sf of ['turf', 'dirt']) {
    const L = out.jra.map(o => ({ o, v: o[sf] })); const K = ranker(L.map(x => x.v));
    K.rank('straight', v => v.straight?.[1]); K.rank('height', v => v.height?.[1]); K.rank('front', v => v.races >= 100 ? v.front : null); K.rank('back', v => v.races >= 100 ? v.back : null);
    K.rank('fav', v => v.races >= 100 ? v.fav : null); K.rank('e3Med', v => v.races >= 100 ? v.e3Med : null); K.rank('gateEdge', v => v.races >= 100 ? v.gateEdge : null);
    const lab = sf === 'turf' ? '芝' : 'ダート';
    for (const { v } of L) {
      const t = [];
      if (K.top(v, 'straight', 3)) t.push(`${lab}の直線が長い（${v.straight[1]}m、10場で ${v.rank.straight}位）`); else if (K.bottom(v, 'straight', 3)) t.push(`${lab}の直線が短い（${v.straight[1]}m）`);
      if (K.top(v, 'height', 3)) t.push(`${lab}の高低差が大きい（${v.height[1]}m）`); else if (v.height && v.height[1] <= 1.0) t.push(`${lab}はほぼ平坦（高低差 ${v.height[1]}m）`);
      if (K.top(v, 'front', 3)) t.push(`${lab}は逃げ・先行が勝ちやすい（勝ち馬の4角が前1/4 ${pc(v.front)}）`);
      if (K.top(v, 'back', 3)) t.push(`${lab}は差し・追込が届く（勝ち馬の4角が後ろ半分 ${pc(v.back)}）`);
      if (K.top(v, 'gateEdge', 2)) t.push(`${lab}は内枠有利（1-2枠と7-8枠の3着内率の差 ${(v.gateEdge * 100).toFixed(1)}pt）`); else if (K.bottom(v, 'gateEdge', 2)) t.push(v.gateEdge < 0 ? `${lab}は外枠の方が3着内に来ている（7-8枠が1-2枠より ${(-v.gateEdge * 100).toFixed(1)}pt 上）` : `${lab}は内外の差が小さい（${(v.gateEdge * 100).toFixed(1)}pt）`);
      if (K.top(v, 'fav', 2)) t.push(`${lab}は1番人気が強い（1着率 ${pc(v.fav)}）`); else if (K.bottom(v, 'fav', 2)) t.push(`${lab}は1番人気が勝ちにくい（${pc(v.fav)}）`);
      if (K.top(v, 'e3Med', 2)) t.push(`${lab}は荒れやすい（3連単の中央値 ${v.e3Med.toLocaleString()}円）`);
      v.summary = t;
    }
  }
  /* ---- 南関 ---- */
  const NC = rd('data/nankan/course.json')?.tracks || {};
  const N = {};
  await eachLine('data/nankan/results.jsonl', r => {
    const v = (N[r.track] ||= { races: 0, fav: [0, 0], heavy: 0, rain: 0, agari3: [], ten3: [] });
    v.races++;
    const favNo = Object.entries(r.pops || {}).find(([, p]) => p === 1)?.[0];
    if (favNo) { v.fav[1]++; if (String(r.order?.[0]) === favNo) v.fav[0]++; }
    if (/重|不良/.test(r.baba || '')) v.heavy++; if (/雨|雪/.test(r.weather || '')) v.rain++;
    if (r.agari3) v.agari3.push(r.agari3); if (r.ten3) v.ten3.push(r.ten3);
  });
  const NP = {};
  await eachLine('data/nankan/payouts.jsonl', p => { const y = p.pay?.sanrentan?.[0]?.yen ?? p.pay?.santan?.[0]?.yen; if (!y) return; const v = (NP[p.track] ||= { e3: [], man: 0 }); v.e3.push(y); if (y >= 100000) v.man++; });
  for (const [key, c] of Object.entries(NC)) {
    const T = rd(`data/nankan/trend.${key}.json`); const v = N[c.name], p = NP[c.name];
    const byDist = T?.trendRef ? Object.fromEntries(Object.entries(T.trendRef).map(([d, x]) => { const y = x.year || x; return [d, { n: y.n, front3: y.front3, style: y.style, gateEdge: y.gate && y.gateBase ? y.gate.map((g, i) => r3(g / y.gateBase[i])) : null }]; })) : {};
    const ds = Object.values(byDist).filter(x => x.n >= 200), wsum = ds.reduce((a, x) => a + x.n, 0);
    const front3 = wsum ? ds.reduce((a, x) => a + x.front3 * x.n, 0) / wsum : null;
    const style = wsum ? [0, 1, 2, 3].map(i => r3(ds.reduce((a, x) => a + (x.style?.[i] || 0) * x.n, 0) / wsum)) : null;
    const gate = wsum ? [0, 1, 2].map(i => r3(ds.reduce((a, x) => a + (x.gateEdge?.[i] || 1) * x.n, 0) / wsum)) : null;
    out.nankan.push({ key, name: c.name, code: c.code, courses: c.courses, straight: c.straight, straights: c.nar?.straight || [], height: c.nar?.height || null, narIntro: c.nar?.intro || null, notes: c.notes, records: c.records, src: c.src,
      races: v?.races || 0, fav: v?.fav[1] ? r3(v.fav[0] / v.fav[1]) : null, heavy: v ? r3(v.heavy / v.races) : null, rain: v ? r3(v.rain / v.races) : null,
      agari3: v ? r3(med(v.agari3)) : null, ten3: v ? r3(med(v.ten3)) : null, e3Med: p ? med(p.e3) : null, man: p?.e3.length ? r3(p.man / p.e3.length) : null,
      front3: r3(front3), style, gate, byDist });
  }
  out.nankan.sort((a, b) => a.code.localeCompare(b.code));
  { const K = ranker(out.nankan); K.rank('front3', o => o.front3); K.rank('fav', o => o.fav); K.rank('e3Med', o => o.e3Med); K.rank('inner', o => o.gate ? o.gate[0] - o.gate[2] : null); K.rank('len', o => Math.max(...(o.courses || []).map(c => c.len || 0))); K.rank('straight', o => o.straight);
    for (const o of out.nankan) {
      const t = [], c = o.courses || [];
      if (c.length) t.push(`${c[0].turn}・一周 ${[...new Set(c.map(x => x.len))].join('／')}m${o.straight ? `・直線 ${o.straight}m（ゴールまで）` : ''}${o.height ? `・高低差 ${o.height}` : ''}${c.length > 1 ? `（${c.map(x => `${x.inout || '本'}${x.turn !== c[0].turn ? x.turn : ''}`).join('・')}コース）` : ''}`);
      if (K.top(o, 'straight', 1)) t.push(`直線が4場でいちばん長い（${o.straight}m）`); else if (K.bottom(o, 'straight', 1)) t.push(`直線が4場でいちばん短い（${o.straight}m）＝前が止まりにくい`);
      if (K.top(o, 'front3', 1)) t.push(`前が残りやすい（3着内のうち3角で前方にいた割合 ${pc(o.front3)}、4場で1位）`); else if (K.bottom(o, 'front3', 1)) t.push(`4場の中では差しが届く（前方の割合 ${pc(o.front3)}）`);
      if (o.gate) { const d = o.gate[0] - o.gate[2]; if (d >= 0.06) t.push(`内枠有利（3着内シェア÷出走シェア 内 ${o.gate[0]}／外 ${o.gate[2]}）`); else if (d <= -0.06) t.push(`外枠が不利にならない（内 ${o.gate[0]}／外 ${o.gate[2]}）`); }
      if (K.top(o, 'fav', 1)) t.push(`1番人気が強い（1着率 ${pc(o.fav)}）`); else if (K.bottom(o, 'fav', 1)) t.push(`1番人気が勝ちにくい（${pc(o.fav)}）`);
      if (K.top(o, 'e3Med', 1)) t.push(`荒れやすい（3連単の中央値 ${o.e3Med?.toLocaleString()}円）`); else if (K.bottom(o, 'e3Med', 1)) t.push(`堅い（3連単の中央値 ${o.e3Med?.toLocaleString()}円）`);
      o.summary = t;
    } }
  /* ---- ばんえい ---- */
  const BI = rd('data/banei/index.json');
  if (BI) {
    let races = 0, fav = [0, 0]; const e3 = [];
    await eachLine('data/banei/results.jsonl', r => { races++; const f = r.entries?.find(e => e.pop === 1); if (f) { fav[1]++; if (f.pos === 1) fav[0]++; } const y = r.pay?.santan?.[0]?.y; if (y) e3.push(y); });
    const G = BI.gate || {}, M = BI.moist || {};
    const best = Object.entries(G).filter(([, v]) => v.n >= 200).sort((a, b) => b[1].edge - a[1].edge);
    const mk = Object.entries(M).filter(([, v]) => v.races >= 50);
    const t = ['直線200m・障害2つ（第2障害が勝負どころ）を、重いソリを曳いて走る。時計は馬場水分で丸ごと変わる'];
    if (best.length >= 2) t.push(`馬番の得失：${best[0][0]}番が良く（${best[0][1].edge.toFixed(2)}）、${best.at(-1)[0]}番が悪い（${best.at(-1)[1].edge.toFixed(2)}）`);
    if (mk.length >= 2) { const dry = mk[0], wet = mk.at(-1); t.push(`馬場水分 ${dry[0]}% では1番人気の1着率 ${pc(dry[1].favWin)}・勝ち時計 ${dry[1].winTime?.toFixed(1)}秒、${wet[0]}% では ${pc(wet[1].favWin)}・${wet[1].winTime?.toFixed(1)}秒（水分が多いほど速く、荒れやすい）`); }
    const BC = rd('data/banei/course.json');
    if (BC) t.unshift(`${BC.turn || '直線コース'}・全長 ${BC.total || '200m'}・幅員 ${BC.width || '—'}・${BC.height || ''}（公式）`);
    out.banei = { name: '帯広', course: BC ? { total: BC.total, width: BC.width, height: BC.height, intro: BC.intro, src: BC.src } : null, races, fav: fav[1] ? r3(fav[0] / fav[1]) : null, e3Med: med(e3), gate: G, moist: M, summary: t, from: BI.meta?.from, to: BI.meta?.to };
  }
  wr('data/guide_horse.json', out);
  console.error(`競馬：中央 ${out.jra.length}場・南関 ${out.nankan.length}場・ばんえい ${out.banei ? 1 : 0}`);
  for (const o of out.jra.slice(0, 3)) console.error(`  ${o.name} 芝「${o.turf.summary.join('／')}」 ダ「${o.dirt.summary.join('／')}」`);
  for (const o of out.nankan) console.error(`  ${o.name}「${o.summary.join('／')}」`);
}
