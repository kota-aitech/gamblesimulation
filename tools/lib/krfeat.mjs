/* 競輪の条件付きロジット用の特徴量。1レース＝1グループ、1選手＝1行。レース前に分かる情報だけで作る。
   出走表の数字（競走得点・直近4ヶ月の成績・前場所成績・当所・同走路）は Kドリームスのページが**そのレース時点の値**で
   残しているので、そのまま使っても先読みにならない。自前の結果から作るもの（選手の地元での上振れ・ラインでの位置別の成績・
   その日のバンクの傾向）は、南関・ばんえいと同じく「そのレースより前」だけで積む（buildAsOf / buildDayIndex）。

   競輪で「普通の予想ロジックにプラスアルファ」になるのは次の3つ。どれも単位は他と同じ対数オッズ差（係数で決まる）：
     ライン   … 並び予想（ページの「並び予想」）から、ラインの大きさ・その中の位置（先頭／番手／3番手以降／単騎）・
                先頭の自力の強さ（番手は先頭の先行力に乗る）・ラインの総合力・他のラインとの先行争い
     地元     … 選手の登録府県＝開催場の府県（「地元3割増し」）。地区が同じ（地区地元）も別に持つ。
                地元選手のいるラインは並びで優遇されやすいので「ラインに地元がいる」も持つ
     得点     … 競走得点はレース内の相対（平均との差・順位・最上位との差）で使う。絶対値は級で水準が違うので使わない
   学習（keirin_fit）も予測（keirin_build_races）も raceOf(r) で同じ形にしてから featurize する。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, venueByName, regionOf } from './kr.mjs';

/* 全43場のバンクの形（keirin_fetch_banks.mjs が作る banks.json）。学習・検証・予想で同じ表を使う */
export const BANKS = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data/keirin/banks.json'), 'utf8')); } catch { return {}; } })();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const logit = p => Math.log(p / (1 - p)), sig = l => 1 / (1 + Math.exp(-l));
const shrunk = (w, n, prior, k) => logit((w + k * prior) / (n + k)) - logit(prior);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
export const riderKey = h => `${h.name}|${h.term ?? ''}`;

/* 級班：S級S班 7／S1 6／S2 5／A1 4／A2 3／A3 2（チャレンジ）／L1（ガールズ）は別枠 */
export const CLS = { SS: 7, S1: 6, S2: 5, A1: 4, A2: 3, A3: 2, L1: 4 };
/* 記者の印（予想）。◎ 本命・○ 対抗・▲ 単穴・△ 連下・× 穴・注 注意 */
export const TIP = { '◎': 1, '○': 0.7, '▲': 0.5, '△': 0.3, '×': 0.25, '注': 0.2 };
/* レースの種類：決勝・準決勝・特選・予選・一般・選抜 など（勝ち上がりの段階） */
export const stageOf = kind => { const k = String(kind || ''); return /決勝/.test(k) && !/準決/.test(k) ? 'final' : /準決/.test(k) ? 'semi' : /特選|特秀|選抜|優秀|特別/.test(k) ? 'special' : /予選/.test(k) ? 'pre' : 'general'; };
export const isGirls = r => (r.riders || []).some(h => h.cls === 'L1') || /ガールズ/.test(`${r.kind || ''}${r.title || ''}`);

export const FEATURES = [
  /* 得点・級・直近4ヶ月 */
  'scoreRel', 'scoreRank', 'scoreTop', 'clsRel',
  'winRate', 'q2', 'q3', 'sRate', 'bRate', 'jiriki', 'sashiMark',
  'styleNige', 'styleRyo', 'gear', 'young', 'age',
  /* 近況（今場所・前場所・前々場所の着順）と当所・同走路 */
  'formAvg', 'formLast', 'curMeet', 'venueFit', 'bankFit', 'finalShare',
  /* ライン */
  'single', 'lineHead', 'lineSecond', 'lineThird', 'lineSize', 'lineScore',
  'headPower', 'secondBehindStrong', 'rivalHeads', 'nLines', 'bigLine',
  /* 地元 */
  'home', 'homeRegion', 'homeInLine', 'homeHead', 'homeX',
  /* 記者 */
  'tip', 'evalRel',
  /* 自前の結果から（レース時点）：選手の強さ・位置別の成績・当日と開催のバンク傾向・前のレースの風 */
  'rIdx', 'rPosFit', 'venueHeadEdge', 'venueSecondEdge', 'dayHeadEdge', 'dayJiriki', 'windNige',
  /* 連係実績（同じ2人が前後で並んだときに2人そろって3着内に来た割合）、バンク周長×自力 */
  'pairFit', 'bankJiri',
  /* 選手ごとの癖：番手・先頭のときのライン決着率、主導権（B・逃げの多いラインの先頭と番手）、バンク周長別の得手不得手 */
  'rLineFin', 'initLead', 'initSecond', 'rBankFit',
  /* バンクの特性：場ごとの決まり手の傾向×選手の型、見なし直線×差し・マーク、カント×捲り */
  'venueStyleFit', 'straightX', 'cantX',
  'mktLog',                                              // 市場（joint のみ。base では 0 固定）
];
export const NF = FEATURES.length;
export const MKT = FEATURES.indexOf('mktLog');

/* バンク周長の区分（前橋 335m は 333 に入れる） */
export const bankCls = len => len == null ? null : len <= 340 ? 333 : len >= 450 ? 500 : 400;
/* 決まり手（逃・捲・差・マ）→ 添字 */
const KIM = ['逃', '捲', '差', 'マ'];
const kimIdx = k => { const i = KIM.findIndex(x => String(k || '').includes(x)); return i; };
/* 着順（数字だけ）。落車・失格などは null */
const posNum = p => (typeof p === 'number' ? p : null);

/* ---- ラインの形：各選手について ライン番号・位置（0=先頭）・大きさ ---- */
export function lineInfo(race) {
  const byNo = new Map();
  const nos = race.riders.map(h => h.no);
  let lines = (race.line || []).map(l => l.filter(no => nos.includes(no))).filter(l => l.length);
  /* 並び予想に載っていない選手は単騎として足す（補充選手はコメントが取れていないことがある） */
  const inLine = new Set(lines.flat());
  for (const no of nos) if (!inLine.has(no)) lines.push([no]);
  lines.forEach((l, li) => l.forEach((no, pi) => byNo.set(no, { li, pos: pi, size: l.length, line: l })));
  return { lines, byNo, known: (race.line || []).length > 0 };
}

/* 市場の確率：3連単オッズ（全通り）から1着の確率を逆算する。競輪は単勝が無いレースが大半なので、いちばん票数の多い3連単を使う。
   無ければ 2車単。控除率は全組に同じなので正規化で消える */
export function marketProbs(race) {
  if (race.mkt !== undefined) return race.mkt;
  const nos = race.riders.map(h => h.no), p = new Map(nos.map(n => [n, 0]));
  const e3 = race.odds?.e3, e2 = race.odds?.e2;
  let src = null;
  if (e3 && Object.keys(e3).length >= nos.length * (nos.length - 1) * (nos.length - 2) * 0.6) {
    for (const [k, v] of Object.entries(e3)) { const f = +k.split('-')[0]; if (p.has(f) && v > 0 && v < 9999) p.set(f, p.get(f) + 1 / v); }
    src = 'e3';
  } else if (e2 && Object.keys(e2).length >= nos.length * (nos.length - 1) * 0.6) {
    for (const [k, v] of Object.entries(e2)) { const f = +k.split('-')[0]; if (p.has(f) && v > 0 && v < 9999) p.set(f, p.get(f) + 1 / v); }
    src = 'e2';
  }
  if (!src) return null;
  const s = [...p.values()].reduce((a, b) => a + b, 0);
  if (!(s > 0)) return null;
  /* 車番 → 確率（欠車があると配列の位置がずれるので辞書で持つ） */
  return { byNo: Object.fromEntries(nos.map(n => [n, +(p.get(n) / s).toFixed(5)])), src };
}
/* 出走する選手（riders の並び）に合わせた市場の1着確率。欠けていれば null */
export function mktFor(race, riders) {
  const m = marketProbs(race); if (!m) return null;
  const q = riders.map(h => m.byNo[h.no] || 0), s = q.reduce((a, b) => a + b, 0);
  if (!(s > 0) || q.some(v => v <= 0)) return null;
  return { p: q.map(v => v / s), src: m.src };
}

/* races.jsonl を読む。メモリを抑えるため、オッズは「市場の1着確率」と「人気上位の3連単」だけに畳み、使わない文章を落とす。
     keep.pay  … 払戻を残す（検証・日別成績）
     keep.odds … オッズを丸ごと残す（今日の出走表の期待値） */
export function slim(r, keep = {}) {
  r.mkt = marketProbs(r);
  if (!r.bank && BANKS[r.venue]?.len) r.bank = BANKS[r.venue].len;   // 同走路の表が無いページは場の表で補う
  if (r.odds?.e3) r.mktE3 = Object.entries(r.odds.e3).filter(([, v]) => v > 0 && v < 9999).sort((a, b) => a[1] - b[1]).slice(0, 10);
  if (!keep.odds) delete r.odds;
  if (!keep.pay) delete r.pay;
  if (!keep.text) { delete r.review; delete r.cond; delete r.reporter; for (const h of r.riders) delete h.comment; }
  return r;
}
export function loadRaces(text, keep = {}, filter) {
  const out = [];
  for (const l of text.split('\n')) { if (!l) continue; if (filter && !filter(l)) continue; let r; try { r = JSON.parse(l); } catch { continue; } if (!r.date || !r.riders?.length) continue; out.push(slim(r, keep)); }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.jcd.localeCompare(b.jcd) || a.r - b.r);
  return out;
}

/* ---- 学習・予測の共通の形 ---- */
export function raceOf(r) {
  const V = venueByName[r.venue] || {};
  /* 欠車（結果に載らない選手）は落とす。結果がまだ無いときは出走表のまま */
  const ran = r.result ? new Set(r.result.order.map(o => o.no)) : null;
  const riders = r.riders.filter(h => !ran || ran.has(h.no));
  const order = r.result ? [1, 2, 3].map(k => { const o = r.result.order.find(x => x.pos === k); return o ? riders.findIndex(h => h.no === o.no) : -1; }) : null;
  return { ...r, riders, order, vpref: V.pref || null, vregion: V.region || regionOf(V.pref) || null, stage: stageOf(r.kind), girls: isGirls(r) };
}

/* ---- 自前の結果から「そのレース時点」の指標を積む ----
   rIdx      … 選手の勝率の縮小ロジット（k=40）。出走表の勝率（直近4ヶ月）より長い期間の平常の強さ
   rPos      … 選手のライン内の位置別（先頭・番手・3番手以降・単騎）の3着内率の上振れ（本人の平常値を事前分布に置く）
   rHome     … 選手の地元での3着内率の上振れ（表示用。「地元で走る選手か」）
   venuePos  … 場ごとに、ラインの位置別の1着率（バンクの癖：先行が残る場か、番手・差しが届く場か）
   day/meet  … その日・その開催の、ここまでのレースで「先頭が勝った割合」「自力（逃・捲）で決まった割合」、直前のレースの風速 */
export function buildAsOf(races, init = null) {
  /* init … saveState() で保存した「ある日まで」の積み上げ。予想生成（10分おき）で全期間を読み直さないために使う */
  const R = new Map(init?.R || []), VP = new Map(init?.VP || []), DAY = new Map(init?.DAY || []), PR = new Map(init?.PR || []);
  /* 決まり手の数：場ごと（VK）・バンク周長ごと（BK）・全体（KA）。場の傾向はバンク周長の傾向へ、周長の傾向は全体へ縮める */
  const VK = new Map(init?.VK || []), BK = new Map(init?.BK || []);
  const KA = init?.KA || [0, 0, 0, 0];
  let runs = init?.runs || 0, wins = init?.wins || 0, top3 = init?.top3 || 0;
  const posBase = init?.posBase || [0, 0, 0, 0].map(() => ({ n: 0, w: 0, t: 0 }));
  const snap = new Map();
  const g = (m, k, f) => { let v = m.get(k); if (!v) m.set(k, v = f()); return v; };
  const slot = li => li.size === 1 ? 3 : Math.min(li.pos, 2);
  const riderSnap = (key, s, home, bc) => {
    const x = R.get(key), p0 = runs ? wins / runs : 0.14, q0 = runs ? top3 / runs : 0.43;
    /* バンク周長別の3着内の上振れ（本人の平常値を事前分布に）。ライン決着：先頭／番手のとき、先頭と番手がそろって2着内（どちらが1着でも） */
    const bx = bc && x?.bc?.[bc];
    const lf = s <= 1 ? x?.lf?.[s] : null, lfAll = x?.lf ? { n: x.lf[0].n + x.lf[1].n, c: x.lf[0].c + x.lf[1].c } : null;
    const LF0 = 0.22;
    const lineFin = lf && lf.n >= 3 ? (lf.c + LF0 * 6) / (lf.n + 6) - LF0 : lfAll && lfAll.n >= 3 ? ((lfAll.c + LF0 * 6) / (lfAll.n + 6) - LF0) * 0.5 : 0;
    const idx = x ? shrunk(x.w, x.n, p0, 40) : 0;
    const own = sig(logit(q0) + (x ? shrunk(x.t, x.n, q0, 40) : 0));
    const ps = x?.pos[s];
    const pf = ps && ps.n >= 3 ? shrunk(ps.t, ps.n, own, 15) : 0;
    const hm = x?.home;
    const hf = hm && hm.n >= 3 ? shrunk(hm.t, hm.n, own, 15) : 0;
    const bf = bx && bx.n >= 4 ? shrunk(bx.t, bx.n, own, 12) : 0;
    return { rIdx: idx, rPosFit: pf, rHome: hf, rN: x ? x.n : 0, rHomeN: hm ? hm.n : 0, rPosN: ps ? ps.n : 0, home,
      rBankFit: bf, rBankN: bx ? bx.n : 0, rBankT: bx ? bx.t : 0, rLineFin: lineFin, rLineFinN: lf ? lf.n : 0, rLineFinC: lf ? lf.c : 0,
      rKim: x?.kim || null, rB: x ? { n: x.n, b: x.b || 0 } : null };
  };
  const venueSnap = jcd => {
    const v = VP.get(jcd);
    const edge = s => { const b = posBase[s]; const p0 = b.n ? b.w / b.n : 0.14; const x = v?.[s]; return x && x.n >= 20 ? shrunk(x.w, x.n, p0, 60) : 0; };
    return { head: edge(0), second: edge(1), n: v ? v[0].n : 0 };
  };
  /* 場の決まり手の割合（場→周長→全体の順に縮める）と、全体の割合 */
  const kimSnap = (jcd, bc) => {
    const ka = KA.reduce((a, b) => a + b, 0) || 1, base = KA.map(c => c / ka);
    const b = BK.get(bc) || [0, 0, 0, 0], bn = b.reduce((a, c) => a + c, 0);
    const bs = base.map((q, i) => (b[i] + q * 40) / (bn + 40));
    const v = VK.get(jcd) || [0, 0, 0, 0], vn = v.reduce((a, c) => a + c, 0);
    return { share: bs.map((q, i) => (v[i] + q * 30) / (vn + 30)), base, n: vn, raw: v };
  };
  const daySnap = (key, meetKeys) => {
    const d = DAY.get(key) || { n: 0, head: 0, jiri: 0, wind: null };
    const m = { n: d.n, head: d.head, jiri: d.jiri };
    for (const k of meetKeys) { const x = DAY.get(k); if (x) { m.n += x.n; m.head += x.head; m.jiri += x.jiri; } }
    return { dRaw: { n: d.n, head: d.head, jiri: d.jiri }, mRaw: m, dN: d.n, dHead: d.n ? (d.head + 0.45 * 3) / (d.n + 3) - 0.45 : 0, dJiri: d.n ? (d.jiri + 0.45 * 3) / (d.n + 3) - 0.45 : 0,
      mN: m.n, mHead: m.n ? (m.head + 0.45 * 6) / (m.n + 6) - 0.45 : 0, mJiri: m.n ? (m.jiri + 0.45 * 6) / (m.n + 6) - 0.45 : 0, wind: d.wind };
  };
  /* 連係：ラインで前後に並んだ2人（前の選手のキー>後ろの選手のキー）。そろって3着内に来た割合を 0.25 に向けて縮小（k=4） */
  const pairKey = (r, L, no) => { const li = L.byNo.get(no); if (!li || li.size < 2) return null; const a = li.pos === 0 ? li.line[0] : li.line[li.pos - 1], b = li.pos === 0 ? li.line[1] : no; const ha = r.riders.find(h => h.no === a), hb = r.riders.find(h => h.no === b); return ha && hb ? `${riderKey(ha)}>${riderKey(hb)}` : null; };
  const pairSnap = k => { const x = k ? PR.get(k) : null; return x ? { pairFit: (x.c + 0.25 * 4) / (x.n + 4) - 0.25, pairN: x.n, pairC: x.c } : { pairFit: 0, pairN: 0, pairC: 0 }; };
  const meetKeysOf = (r) => { const out = []; for (let k = 1; k < r.day; k++) out.push(`${r.jcd}|${r.start8}|${k}`); return out; };
  const sorted = races.slice().sort((a, b) => a.date.localeCompare(b.date) || a.jcd.localeCompare(b.jcd) || a.r - b.r);
  for (const r0 of sorted) {
    const r = raceOf(r0), L = lineInfo(r);
    const dk = `${r.jcd}|${r.start8}|${r.day}`;
    snap.set(r.raceId, {
      riders: new Map(r.riders.map(h => [h.no, { ...riderSnap(riderKey(h), slot(L.byNo.get(h.no)), h.pref === r.vpref, bankCls(r.bank)), ...(L.known && !r.girls ? pairSnap(pairKey(r, L, h.no)) : {}) }])),
      venue: venueSnap(r.jcd), day: daySnap(dk, meetKeysOf(r)), kim: kimSnap(r.jcd, bankCls(r.bank)),
    });
    if (!r.result) continue;
    const winNo = r.result.order.find(o => o.pos === 1)?.no;
    for (const h of r.riders) {
      const o = r.result.order.find(x => x.no === h.no); const p = posNum(o?.pos); if (p == null) continue;
      const w = p === 1 ? 1 : 0, t = p <= 3 ? 1 : 0, s = slot(L.byNo.get(h.no));
      runs++; wins += w; top3 += t;
      const x = g(R, riderKey(h), () => ({ n: 0, w: 0, t: 0, pos: [0, 0, 0, 0].map(() => ({ n: 0, t: 0 })), home: { n: 0, t: 0 } }));
      x.n++; x.w += w; x.t += t; x.pos[s].n++; x.pos[s].t += t;
      /* バンク周長別・B（バックを取った）・勝ったときの決まり手 */
      const bc = bankCls(r.bank); if (bc) { x.bc ||= {}; const y = (x.bc[bc] ||= { n: 0, t: 0 }); y.n++; y.t += t; }
      if (/B/.test(o?.sb || '')) x.b = (x.b || 0) + 1;
      if (w && kimIdx(o?.kimarite) >= 0) { x.kim ||= [0, 0, 0, 0]; x.kim[kimIdx(o.kimarite)]++; }
      /* ライン決着：先頭か番手のとき、先頭と番手がそろって2着内 */
      const liH = L.byNo.get(h.no);
      if (L.known && !r.girls && liH && liH.size >= 2 && liH.pos <= 1) {
        const pa = posNum(r.result.order.find(q => q.no === liH.line[0])?.pos), pb = posNum(r.result.order.find(q => q.no === liH.line[1])?.pos);
        x.lf ||= [{ n: 0, c: 0 }, { n: 0, c: 0 }]; x.lf[liH.pos].n++; if (pa != null && pb != null && pa <= 2 && pb <= 2) x.lf[liH.pos].c++;
      }
      if (h.pref === r.vpref) { x.home.n++; x.home.t += t; }
      if (L.known && !r.girls) {
        posBase[s].n++; posBase[s].w += w;
        const v = g(VP, r.jcd, () => [0, 0, 0, 0].map(() => ({ n: 0, w: 0 }))); v[s].n++; v[s].w += w;
      }
    }
    if (L.known && !r.girls) {
      const top3set = new Set(r.result.order.filter(o => typeof o.pos === 'number' && o.pos <= 3).map(o => o.no));
      for (const l of L.lines) for (let i = 1; i < l.length; i++) {
        const ha = r.riders.find(h => h.no === l[i - 1]), hb = r.riders.find(h => h.no === l[i]); if (!ha || !hb) continue;
        const x = g(PR, `${riderKey(ha)}>${riderKey(hb)}`, () => ({ n: 0, c: 0 })); x.n++; if (top3set.has(ha.no) && top3set.has(hb.no)) x.c++;
      }
    }
    { const km = kimIdx(r.result.order.find(o => o.pos === 1)?.kimarite); const bc = bankCls(r.bank);
      if (km >= 0 && !r.girls) { KA[km]++; g(VK, r.jcd, () => [0, 0, 0, 0])[km]++; if (bc) g(BK, bc, () => [0, 0, 0, 0])[km]++; } }
    if (winNo != null && L.known && !r.girls) {
      const d = g(DAY, dk, () => ({ n: 0, head: 0, jiri: 0, wind: null }));
      const li = L.byNo.get(winNo); const km = r.result.order.find(o => o.pos === 1)?.kimarite || '';
      d.n++; d.head += li && li.pos === 0 ? 1 : 0; d.jiri += /逃|捲/.test(km) ? 1 : 0;
    }
    if (r.result.wind != null) g(DAY, dk, () => ({ n: 0, head: 0, jiri: 0, wind: null })).wind = r.result.wind;
  }
  return {
    of(raceId) { return snap.get(raceId) || null; },
    /* 予測用（結果の無いレース）：その時点までの最新の状態 */
    latest(r0) {
      const r = raceOf(r0), L = lineInfo(r);
      return { riders: new Map(r.riders.map(h => [h.no, { ...riderSnap(riderKey(h), slot(L.byNo.get(h.no)), h.pref === r.vpref, bankCls(r.bank)), ...(L.known && !r.girls ? pairSnap(pairKey(r, L, h.no)) : {}) }])),
        venue: venueSnap(r.jcd), day: daySnap(`${r.jcd}|${r.start8}|${r.day}`, meetKeysOf(r)), kim: kimSnap(r.jcd, bankCls(r.bank)) };
    },
    base: () => ({ runs, win: runs ? wins / runs : null, top3: runs ? top3 / runs : null, pos: posBase.map(b => ({ n: b.n, win: b.n ? +(b.w / b.n).toFixed(4) : null })) }),
    /* 積み上げを書き出す。DAY は直近の開催（初日が keepFrom 以降）だけ残す */
    saveState(upto, keepFrom) { return { upto, R: [...R], VP: [...VP], PR: [...PR].filter(([, v]) => v.n >= 1), VK: [...VK], BK: [...BK], KA, DAY: [...DAY].filter(([k]) => k.split('|')[1] >= keepFrom), runs, wins, top3, posBase }; },
  };
}

/* 近況：今場所・前場所・前々場所の着順（新しい順）。相対着順（1着=1、最下位=0。9車立てを基準に 1−(着−1)/8） */
function formOf(h) {
  const runs = [];
  for (const m of [h.cur, h.prev1, h.prev2]) if (m) for (const x of m.runs.slice().reverse()) runs.push(x);
  const rel = runs.map(x => typeof x.pos === 'number' ? 1 - (x.pos - 1) / 8 : 0.1);
  const W = [1, .85, .72, .6, .5, .42, .35, .3, .25];
  let s = 0, w = 0; rel.forEach((v, i) => { const k = W[i] ?? 0.2; s += v * k; w += k; });
  const cur = (h.cur?.runs || []).map(x => typeof x.pos === 'number' ? 1 - (x.pos - 1) / 8 : 0.1);
  return { avg: w ? s / w : 0.45, last: rel.length ? rel[0] : 0.45, cur: cur.length ? mean(cur) : null, n: rel.length };
}
const rateOf = a => { if (!a || a.length < 4) return null; const n = a.reduce((x, y) => x + (y || 0), 0); return n ? { n, w: a[0] || 0, t: (a[0] || 0) + (a[1] || 0) + (a[2] || 0) } : null; };

export function makeFeaturizer(ASOF) {
  return function featurize(r0, { live = false } = {}) {
    const race = raceOf(r0);
    const H = race.riders;
    if (H.length < 5) return null;
    const L = lineInfo(race);
    const A = live ? ASOF.latest(r0) : (ASOF.of(race.raceId) || ASOF.latest(r0));
    const scores = H.map(h => h.score || 0), sAvg = mean(scores.filter(v => v > 0)) || 80;
    const sTop = Math.max(...scores);
    const sRank = H.map(h => H.filter(x => (x.score || 0) > (h.score || 0)).length);
    const clsV = H.map(h => CLS[h.cls] ?? 4), cAvg = mean(clsV);
    const mk = mktFor(race, H);
    const lq = mk ? mk.p.map(q => Math.log(Math.max(1e-6, q))) : null, lqm = lq ? mean(lq) : 0;
    const tot = h => (h.w1 || 0) + (h.w2 || 0) + (h.w3 || 0) + (h.wx || 0);
    const jiri = h => { const t = (h.nige || 0) + (h.makuri || 0) + (h.sashi || 0) + (h.mark || 0); return t ? ((h.nige || 0) + (h.makuri || 0)) / t : (h.style === '逃' ? 0.7 : h.style === '両' ? 0.4 : 0.1); };
    const nigeR = h => { const n = tot(h); return n ? (h.nige || 0) / n : (h.style === '逃' ? 0.3 : 0); };
    const evals = H.map(h => h.eval).filter(v => v != null), eAvg = evals.length ? mean(evals) : null;
    /* ライン単位：先頭の自力の強さ・ラインの得点平均・地元の有無 */
    const lineStat = L.lines.map(l => {
      const hs = l.map(no => H.find(h => h.no === no)).filter(Boolean);
      const head = hs[0];
      return { size: hs.length, head, headPower: head ? jiri(head) * 0.6 + nigeR(head) * 1.2 + ((head.score || sAvg) - sAvg) / 10 : 0,
        score: mean(hs.map(h => h.score || sAvg)) - sAvg, home: hs.some(h => h.pref === race.vpref), homeHead: head && head.pref === race.vpref };
    });
    const heads = lineStat.filter(s => s.size >= 1 && s.head && jiri(s.head) >= 0.35);
    /* 主導権：各ラインの先頭の「B（バック）の比率・逃げの比率・自力の比率」で、どのラインが前を取りそうかを決める。
       いちばん高いラインの先頭と番手に付ける（2番手のラインとの差が大きいほど強く） */
    const initOf = h => { const n = tot(h); return (n ? (h.B || 0) / n : 0) * 1.5 + nigeR(h) + jiri(h) * 0.3; };
    const inits = lineStat.map((st, li) => ({ li, v: st.head && (st.size >= 2 || jiri(st.head) >= 0.5) ? initOf(st.head) : -1 })).sort((a, b) => b.v - a.v);
    const initTop = inits[0]?.v > 0 ? inits[0].li : -1, initGap = inits.length >= 2 ? clamp(inits[0].v - Math.max(0, inits[1].v), 0, 1.5) : 0.5;
    const BK = BANKS[race.venue] || {};
    const straightZ = BK.straight ? clamp((BK.straight - 55) / 8, -2.5, 2) : 0, cantZ = BK.cant ? clamp((BK.cant - 31.5) / 3, -2.5, 2) : 0;
    const K = A?.kim || null;
    const nLines = L.lines.filter(l => l.length >= 2).length + (L.lines.some(l => l.length === 1) ? 0.5 : 0);
    const knownLine = L.known && !race.girls;
    const V = A?.venue || { head: 0, second: 0 }, D = A?.day || { dHead: 0, dJiri: 0, mHead: 0, mJiri: 0, wind: null };
    const rows = H.map((h, i) => {
      const li = L.byNo.get(h.no), ls = lineStat[li.li];
      const f = formOf(h);
      const n4 = tot(h);
      const vr = rateOf(h.venueRec), br = rateOf(h.bankRec);
      const fr = h.year ? (() => { const y = h.year; const fin = (y.final || []).reduce((a, b) => a + (b || 0), 0), all = ['final', 'special', 'semi', 'pre'].reduce((a, k) => a + (y[k] || []).reduce((x, z) => x + (z || 0), 0), 0); return all ? fin / all : 0; })() : 0;
      const baseQ3 = (h.q3 ?? 30) / 100;
      const home = h.pref && race.vpref && h.pref === race.vpref ? 1 : 0;
      const homeReg = !home && h.region && race.vregion && h.region === race.vregion ? 1 : 0;
      const as = A?.riders?.get(h.no) || {};
      const head = knownLine ? ls.head : null;
      const isHead = knownLine && li.pos === 0 && li.size >= 2 ? 1 : 0, isSecond = knownLine && li.pos === 1 ? 1 : 0, isThird = knownLine && li.pos >= 2 ? 1 : 0;
      const single = knownLine && li.size === 1 ? 1 : 0;
      const x = {
        scoreRel: ((h.score || sAvg) - sAvg) / 3, scoreRank: 1 - sRank[i] / (H.length - 1), scoreTop: ((h.score || sAvg) - sTop) / 3,
        clsRel: (clsV[i] - cAvg),
        winRate: (h.winRate ?? 10) / 100, q2: (h.q2 ?? 20) / 100, q3: baseQ3,
        sRate: n4 ? (h.S || 0) / n4 : 0, bRate: n4 ? (h.B || 0) / n4 : 0,
        jiriki: jiri(h), sashiMark: n4 ? ((h.sashi || 0) + (h.mark || 0)) / n4 : 0,
        styleNige: h.style === '逃' ? 1 : 0, styleRyo: h.style === '両' ? 1 : 0,
        gear: h.gear ? (h.gear - 3.9) * 5 : 0, young: h.term && H.length ? clamp((h.term - mean(H.map(x => x.term || 100))) / 10, -3, 3) : 0,
        age: h.age ? (h.age - 35) / 10 : 0,
        formAvg: f.avg - 0.5, formLast: f.last - 0.5, curMeet: f.cur != null ? f.cur - 0.5 : 0,
        venueFit: vr && vr.n >= 4 ? shrunk(vr.t, vr.n, baseQ3, 10) : 0,
        bankFit: br && br.n >= 6 ? shrunk(br.t, br.n, baseQ3, 15) : 0,
        finalShare: fr,
        single, lineHead: isHead, lineSecond: isSecond, lineThird: isThird,
        lineSize: knownLine ? (li.size - 2) : 0, lineScore: knownLine ? ls.score / 3 : 0,
        headPower: knownLine && head ? ls.headPower : 0,
        secondBehindStrong: isSecond && head ? ls.headPower : 0,
        rivalHeads: knownLine ? heads.filter(s => s !== ls).length - 1.5 : 0,
        nLines: knownLine ? (nLines - 3) * (isHead ? 1 : isSecond ? -0.5 : 0) : 0,
        bigLine: knownLine && li.size >= 3 && li.pos <= 1 ? 1 : 0,
        home, homeRegion: homeReg, homeInLine: knownLine && ls.home && !home ? 1 : 0, homeHead: knownLine && ls.homeHead && isSecond ? 1 : 0,
        homeX: home * (race.stage === 'final' || race.stage === 'semi' ? 1 : 0),
        tip: TIP[h.tip] || 0, evalRel: h.eval != null && eAvg != null ? (eAvg - h.eval) : 0,
        rIdx: as.rIdx || 0, rPosFit: as.rPosFit || 0,
        venueHeadEdge: knownLine ? (isHead ? V.head : single ? 0 : isSecond ? V.second : 0) : 0,
        venueSecondEdge: knownLine ? V.second * isSecond : 0,
        dayHeadEdge: knownLine ? ((D.dN >= 2 ? D.dHead : 0) + (D.mN >= 6 ? D.mHead : 0) * 0.5) * (isHead ? 1 : isSecond ? -0.5 : 0) : 0,
        dayJiriki: ((D.dN >= 2 ? D.dJiri : 0) + (D.mN >= 6 ? D.mJiri : 0) * 0.5) * (jiri(h) - 0.4),
        windNige: D.wind != null ? clamp(D.wind - 3, -3, 5) * nigeR(h) : 0,
        pairFit: knownLine ? (as.pairFit || 0) * Math.min(1, (as.pairN || 0) / 3) * 4 : 0,
        bankJiri: (bankCls(race.bank) === 333 ? 1 : bankCls(race.bank) === 500 ? -1 : 0) * (jiri(h) - 0.4),
        rLineFin: knownLine && li.size >= 2 && li.pos <= 1 ? (as.rLineFin || 0) * 4 : 0,
        initLead: knownLine && li.li === initTop && li.pos === 0 ? 0.5 + initGap : 0,
        initSecond: knownLine && li.li === initTop && li.pos === 1 ? 0.5 + initGap : 0,
        rBankFit: as.rBankFit || 0,
        venueStyleFit: K && K.n >= 10 ? (() => { const ks = [h.nige || 0, h.makuri || 0, h.sashi || 0, h.mark || 0], kn = ks.reduce((a, b) => a + b, 0); if (!kn) return 0; return ks.reduce((a, c, j) => a + (c / kn) * (K.share[j] - K.base[j]), 0) * 10; })() : 0,
        straightX: straightZ * ((n4 ? ((h.sashi || 0) + (h.mark || 0)) / n4 : 0) - (n4 ? (h.nige || 0) / n4 : 0)),
        cantX: cantZ * (n4 ? (h.makuri || 0) / n4 : 0) * 3,
        mktLog: lq ? lq[i] - lqm : 0,
      };
      const v = new Float64Array(NF);
      FEATURES.forEach((k, j) => { v[j] = Number.isFinite(x[k]) ? x[k] : 0; });
      return { no: h.no, x: v, li, h, as, home, homeReg, f };
    });
    return { raceId: race.raceId, date: race.date, n: H.length, rows, order: race.order, mkt: mk ? mk.p : null, mktSrc: mk ? mk.src : null, lines: L.lines, known: L.known, race, day: D, venue: V,
      kim: K, bank: BK, initLine: initTop >= 0 ? L.lines[initTop] : null, initGap };
  };
}

/* ---- 2着・3着の段階モデル（競輪は「ライン決着」があるので1着の決まり方で2着の分布が大きく変わる） ----
   2着候補 i（1着 w）：同じライン・w のすぐ後ろ（番手）・w のすぐ前（w が番手から差したときの先頭＝「ワンツー」）・強さ U・得点差
   3着候補 i（1着 w・2着 s）：w か s と同じライン・s のすぐ後ろ・強さ U
   lib/bpl.mjs と同じく、ここを学習（keirin_fit）と予測（keirin_build_races）で共用する */
/* mateFin … 1着と同じラインで隣り合う候補について、2人（先頭と番手）の「ライン決着率」の上振れの平均。
   「この選手が番手のときはラインで決まりやすい」を2着の予測に効かせる */
export const STAGE2 = ['u', 'sameLine', 'behindW', 'aheadW', 'single', 'scoreDiff', 'mateFin'];
export const STAGE3 = ['u', 'sameW', 'sameS', 'behindS', 'single', 'scoreDiff'];
export function stageCtx(f) {
  const known = f.known && !f.race?.girls;
  return f.rows.map(r => ({ li: known ? r.li.li : -1 - r.no, pos: r.li.pos, size: r.li.size, score: r.h.score || 0, lf: known && r.li.size >= 2 && r.li.pos <= 1 ? (r.as?.rLineFin || 0) : 0 }));
}
export function stage2X(ctx, U, w, i) {
  const a = ctx[w], b = ctx[i], same = a.li === b.li ? 1 : 0, adj = same && Math.abs(b.pos - a.pos) === 1 && Math.min(a.pos, b.pos) === 0;
  return [U[i], same, same && b.pos === a.pos + 1 ? 1 : 0, same && b.pos === a.pos - 1 ? 1 : 0, b.size === 1 ? 1 : 0, (b.score - a.score) / 3, adj ? (a.lf + b.lf) * 4 : 0];
}
export function stage3X(ctx, U, w, s, i) {
  const a = ctx[w], c = ctx[s], b = ctx[i];
  return [U[i], a.li === b.li ? 1 : 0, c.li === b.li ? 1 : 0, c.li === b.li && b.pos === c.pos + 1 ? 1 : 0, b.size === 1 ? 1 : 0, (b.score - a.score) / 3];
}
const dot = (b, x) => { let s = 0; for (let k = 0; k < b.length; k++) s += b[k] * x[k]; return s; };
const softmax = v => { const m = Math.max(...v); const e = v.map(x => Math.exp(x - m)); const s = e.reduce((a, b) => a + b, 0); return e.map(x => x / s); };
/* 全通りの確率。stage が無ければ温度つき PL。戻り値：p1/top2/top3 と、3連単・3連複・2車単・2車複・ワイドの組（車番の文字列キー） */
export function combos(U, tau, ctx, stage, nos) {
  const n = U.length, m = Math.max(...U);
  const e1 = U.map(u => Math.exp(tau[0] * (u - m))), S1 = e1.reduce((a, b) => a + b, 0), p1 = e1.map(v => v / S1);
  const e2 = U.map(u => Math.exp(tau[1] * (u - m))), S2 = e2.reduce((a, b) => a + b, 0);
  const top2 = Array(n).fill(0), top3 = Array(n).fill(0);
  const e3 = new Map(), q3 = new Map(), ex2 = new Map(), q2 = new Map(), wide = new Map();
  const add = (mp, k, p) => mp.set(k, (mp.get(k) || 0) + p);
  for (let a = 0; a < n; a++) {
    const cand = [...Array(n).keys()].filter(i => i !== a);
    const q2s = stage ? softmax(cand.map(i => dot(stage.t2, stage2X(ctx, U, a, i)))) : cand.map(i => e2[i] / (S2 - e2[a]));
    cand.forEach((b, bi) => {
      const pb = p1[a] * q2s[bi];
      top2[b] += pb;
      add(ex2, `${nos[a]}-${nos[b]}`, pb); add(q2, [nos[a], nos[b]].sort((x, y) => x - y).join('-'), pb);
      const c3 = cand.filter(i => i !== b);
      const q3s = stage ? softmax(c3.map(i => dot(stage.t3, stage3X(ctx, U, a, b, i)))) : c3.map(i => e2[i] / (S2 - e2[a] - e2[b]));
      c3.forEach((c, ci) => {
        const p = pb * q3s[ci];
        top3[c] += p;
        add(e3, `${nos[a]}-${nos[b]}-${nos[c]}`, p);
        add(q3, [nos[a], nos[b], nos[c]].sort((x, y) => x - y).join('-'), p);
        const k2 = (x, y) => [nos[x], nos[y]].sort((u, v) => u - v).join('-');
        add(wide, k2(a, b), p); add(wide, k2(a, c), p); add(wide, k2(b, c), p);
      });
    });
  }
  const sorted = mp => [...mp].sort((x, y) => y[1] - x[1]);
  return { p1, top2: p1.map((v, i) => v + top2[i]), top3: p1.map((v, i) => v + top2[i] + top3[i]), e3: sorted(e3), q3: sorted(q3), e2: sorted(ex2), q2: sorted(q2), wide: sorted(wide) };
}
