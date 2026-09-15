/* K（成績）と B（番組表）を突き合わせて1レースぶんにまとめる。
   fit_boat / backtest_boat / build_boatdb が同じ組み立てを使うためにここに置く。

   ここでしか作れないものが2つある。どちらも「日付順に1度なめる」必要があるため。
     motorGen … モーターは場ごとに年1回入れ替わる。番号だけでは別個体が混ざるので
                「40日以上あいたら別世代」で切る（build_boatdb と同じ規則）
     mUp      … モーター2連率の直近の伸び。B の motor2 はその日時点の累計なので、
                同じモーターの少し前の値との差が「今節での上がり下がり」になる */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './bt.mjs';

const GAP_DAYS = 40;
const dayNo = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 86400000;

/* モーターの世代を日付順に振る。results / programs のどちらでも使う */
export function makeGen() {
  const seen = new Map();                       // 'jcd|no' -> {gen, last}
  return (jcd, no, date) => {
    if (!no) return 1;
    const k = jcd + '|' + no, t = dayNo(date), s = seen.get(k);
    const gen = s ? (t - s.last > GAP_DAYS ? s.gen + 1 : s.gen) : 1;
    seen.set(k, { gen, last: t });
    return gen;
  };
}

/* モーター2連率の直近の伸び。lookback 日以内でいちばん古い記録との差を返す */
export function makeTrend(lookback = 12) {
  const hist = new Map();                       // 'jcd|no|gen' -> [[day, v], ...] 直近だけ
  return (jcd, no, gen, date, v) => {
    if (no == null || v == null) return null;
    const k = `${jcd}|${no}|${gen}`, t = dayNo(date);
    let a = hist.get(k);
    if (!a) hist.set(k, a = []);
    while (a.length && t - a[0][0] > lookback) a.shift();
    const up = a.length ? v - a[0][1] : null;
    a.push([t, v]);
    if (a.length > 24) a.shift();
    return up;
  };
}

function* jsonl(rel, from, to) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) throw new Error(`${rel} がない。先に fetch_od2.mjs を回す`);
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (from && o.date < from) continue;
    if (to && o.date > to) continue;
    yield o;
  }
}

/* ---- 競走得点（節間の得点率）----
   公式サイトの出走表・開催情報ページには得点の表が無いので、番組表の「今節成績」（着順の並び。例 "2 163354"）から
   自前で計算する。得点は一般戦の表（1着10・2着8・3着6・4着4・5着2・6着1、F/L/S/K など事故は0）。
   G1・SG や準優の加点は入れていないが、同じ節の全員に同じ加点が乗るので節内の順位は変わらない。
   節内順位と準優進出ボーダー（出場42人前後なら18位、少人数の開催は12位）との差も出す。 */
const PT = { '1': 10, '2': 8, '3': 6, '4': 4, '5': 2, '6': 1 };
export function setuPoints(s) {
  let pt = 0, n = 0;
  for (const c of String(s || '')) { if (/[1-6]/.test(c)) { pt += PT[c]; n++; } else if (/[FLSK]/.test(c)) { n++; } }
  return { pt: n ? pt / n : null, n };
}
/* その日・その場の出走選手全員の得点率を並べ、各選手に順位とボーダー差を付ける */
function attachPoints(map) {
  const byDay = new Map();                       // date|jcd -> Map(toban -> {pt, n})
  for (const o of map.values()) {
    const k = `${o.date}|${o.jcd}`;
    let d = byDay.get(k); if (!d) byDay.set(k, d = new Map());
    for (const b of o.boats) { if (b.toban && !d.has(b.toban)) d.set(b.toban, setuPoints(b.setu)); }
  }
  const rankOf = new Map();
  for (const [k, d] of byDay) {
    const rs = [...d.entries()].filter(([, v]) => v.n > 0).sort((a, b) => b[1].pt - a[1].pt);
    const tot = d.size, adv = tot >= 36 ? 18 : 12;
    const border = rs[adv - 1] ? rs[adv - 1][1].pt : null;
    rs.forEach(([toban, v], i) => rankOf.set(`${k}|${toban}`, { ptRate: v.pt, ptN: v.n, ptRank: i + 1, ptTot: tot, ptGap: border != null ? v.pt - border : null }));
  }
  for (const o of map.values()) for (const b of o.boats) {
    const r = rankOf.get(`${o.date}|${o.jcd}|${b.toban}`);
    Object.assign(b, r || { ptRate: null, ptN: 0, ptRank: null, ptTot: null, ptGap: null });
  }
}

/* B（番組表）を読み、モーターの世代と2連率の伸び、節間の得点率を付けて返す */
export function loadPrograms({ from = '', to = '' } = {}) {
  const gen = makeGen(), trend = makeTrend();
  const map = new Map();
  for (const o of jsonl('data/boat/programs.jsonl', from, to)) {
    for (const b of o.boats) {
      b.motorGen = gen(o.jcd, b.motor, o.date);
      b.mUp = trend(o.jcd, b.motor, b.motorGen, o.date, b.motor2);
    }
    map.set(`${o.date}|${o.jcd}|${o.r}`, o);
  }
  attachPoints(map);
  return map;
}

/* ---- 「そのレースより前」だけから作る、時点つきの指標 ----
   index.json の指数は3年通算なので、絶好調・絶不調や「今節の機力」を捉えられない。
   ここは results.jsonl を日付順に1度なめながら、各レースについて
   「その日より前の情報だけ」で作る。作り方を間違えると先読みになるので、
   必ず「今のレースを足す前に読む」順序を守ること。
     form    … 直近90日の、コース基準からの上振れ（縮小あり）
     setuST  … 今節のここまでの平均ST
     setuEx  … 今節のここまでの展示タイムのレース内偏差（＋が速い）
     mForm   … そのモーターの直近45日の上振れ */
const FORM_DAYS = 90, MOTOR_DAYS = 45, SETU_GAP = 3;
const FORM_K = 25, MFORM_K = 20;
/* その日のここまで（同じ場の、番号が若いレース）の傾向。K=3 で縮小
     dayIn1   … 1コースの1着率の、場の基準からのズレ（＋＝今日はイン有利）
     dayOut   … 1着艇のコース番号の、期待値からのズレ（＋＝外が来ている）
     dayMak   … まくり・まくり差しの割合の、基準（0.3）からのズレ
     dayN     … その日のここまでのレース数
   選手の当日ここまで（同じ日の前のレース）
     todayRel … 相対着順−0.5（1着 +0.5 … 6着 −0.5）、todaySt … その ST、todayN … 走数 */
const DAY_K = 3, MAK_BASE = 0.30;
/* ---- 級別審査期間 ----
   前期 5/1〜10/31（翌年 1〜6月に適用）、後期 11/1〜4/30（7〜12月に適用）。
   勝率＝着順点の平均（1着10・2着8・3着6・4着4・5着2・6着1。準優 +1・優勝戦 +2 の概算。SG/G1 の加点は入れていない）。
   事故率＝事故点÷出走回数（F・L・失格・転覆などを 10 点、不良航法・待機違反を 7 点の概算）。
   級別の基準：A1 は勝率 6.20 以上かつ上位 20%、A2 は 5.40 以上かつ上位 40%、いずれも事故率 0.70 以下・出走 90／70 回以上。
   ボーダーは「基準値」と「その時点の分位点」の大きいほう。 */
export function periodOf(date) { const y = Number(date.slice(0, 4)), m = Number(date.slice(4, 6)); return m >= 5 && m <= 10 ? `${y}A` : m >= 11 ? `${y}B` : `${y - 1}B`; }
export function periodEnd(date) { const y = Number(date.slice(0, 4)), m = Number(date.slice(4, 6)); return m >= 5 && m <= 10 ? `${y}1031` : m >= 11 ? `${y + 1}0430` : `${y}0430`; }
export function periodStart(date) { const y = Number(date.slice(0, 4)), m = Number(date.slice(4, 6)); return m >= 5 && m <= 10 ? `${y}0501` : m >= 11 ? `${y}1101` : `${y - 1}1101`; }
const KPT = { 1: 10, 2: 8, 3: 6, 4: 4, 5: 2, 6: 1 };
export const KYU_MIN = { A1: 6.20, A2: 5.40, B1: 2.00 };
export const KYU_RUNS = { A1: 90, A2: 70, B1: 50 };

export function makeRolling(base) {
  const bz = (jcd, c) => base?.[jcd + '|' + c]?.win ?? [0, .55, .13, .13, .11, .06, .03][c] ?? 1 / 6;
  const expC = jcd => { let s = 0, t = 0; for (let c = 1; c <= 6; c++) { const p = bz(jcd, c); s += c * p; t += p; } return t ? s / t : 2.2; };
  const R = new Map(), MO = new Map(), SE = new Map(), DAY = new Map(), TD = new Map();
  const KY = new Map();                                   // toban -> { period, runs, pt, q2, q3, acc }
  const BORDER = new Map();                               // date -> { A1, A2, n }（その日の分位点。1日1回だけ計算）
  const borderOf = (date) => {
    if (BORDER.has(date)) return BORDER.get(date);
    const per = periodOf(date);
    const rates = [...KY.values()].filter(k => k.period === per && k.runs >= 20).map(k => k.pt / k.runs).sort((a, b) => b - a);
    const cut = q => rates.length >= 50 ? rates[Math.min(rates.length - 1, Math.floor(rates.length * q))] : 0;
    const b = { A1: Math.max(KYU_MIN.A1, cut(0.20)), A2: Math.max(KYU_MIN.A2, cut(0.40)), n: rates.length };
    BORDER.set(date, b);
    return b;
  };
  const kyuOf = (toban, date) => {
    const k = KY.get(toban);
    if (!k || k.period !== periodOf(date)) return { runs: 0, rate: null, q2: null, q3: null, acc: null };
    return { runs: k.runs, rate: k.pt / k.runs, q2: k.q2 / k.runs, q3: k.q3 / k.runs, acc: k.acc / k.runs };
  };
  const trim = (a, t, days) => { while (a.length && t - a[0][0] > days) a.shift(); };
  const resid = (a, k) => {
    if (!a.length) return { v: 0, n: 0 };
    let w = 0, e = 0;
    for (const [, win, p] of a) { w += win; e += p; }
    return { v: (w - e) / (a.length + k), n: a.length };
  };
  return {
    read(r, e) {
      const t = dayNo(r.date), p = bz(r.jcd, e.course || e.lane);
      const ra = R.get(e.toban) || [], mo = MO.get(`${r.jcd}|${e.motor}|${e.motorGen}`) || [];
      trim(ra, t, FORM_DAYS); trim(mo, t, MOTOR_DAYS);
      const se = SE.get(`${e.toban}|${r.jcd}`);
      const live = se && t - se.lastDay <= SETU_GAP ? se : null;
      const f = resid(ra, FORM_K), m = resid(mo, MFORM_K);
      /* その日のここまで（番号が若いレースだけ。順不同で流し込まれても先読みにならないよう r で切る） */
      const day = (DAY.get(`${r.date}|${r.jcd}`) || []).filter(x => r.r == null || x.r < r.r);
      let in1 = 0, outC = 0, mak = 0;
      for (const x of day) { in1 += x.win1 - x.p1; outC += x.winC - x.expC; mak += x.mak - MAK_BASE; }
      const dn = day.length + DAY_K;
      const td = (TD.get(`${e.toban}|${r.date}`) || []).filter(x => r.r == null || x.r < r.r);
      const tl = td.length ? td[td.length - 1] : null;
      return {
        form: f.v, formN: f.n, mForm: m.v, mFormN: m.n,
        setuST: live && live.stN ? live.stSum / live.stN : null,
        setuEx: live && live.exN ? live.exSum / live.exN : null,
        setuRuns: live ? live.n : 0,
        dayIn1: day.length ? in1 / dn : 0, dayOut: day.length ? outC / dn : 0, dayMak: day.length ? mak / dn : 0, dayN: day.length,
        todayRel: tl ? tl.rel : 0, todaySt: tl ? tl.st : null, todayN: td.length,
        kyu: { ...kyuOf(e.toban, r.date), border: borderOf(r.date), daysLeft: dayNo(periodEnd(r.date)) - t },
        _p: p,
      };
    },
    /* レースが終わったあとに1回。1着のコースと決まり手 */
    pushRace(r, winCourse, kimari) {
      if (!winCourse) return;
      const k = `${r.date}|${r.jcd}`;
      let a = DAY.get(k); if (!a) DAY.set(k, a = []);
      a.push({ r: r.r, win1: winCourse === 1 ? 1 : 0, p1: bz(r.jcd, 1), winC: winCourse, expC: expC(r.jcd), mak: /まくり/.test(kimari || '') ? 1 : 0 });
    },
    /* レースが終わったあとに足す。read より必ずあとに呼ぶ */
    push(r, e, p, exDev) {
      const t = dayNo(r.date), win = Number(e.pos) === 1 ? 1 : 0;
      /* 級別審査期間の着順点・事故点（欠場は数えない） */
      {
        const per = periodOf(r.date), pos = Number(e.pos), ptxt = String(e.pos ?? '');
        if (!/欠/.test(ptxt)) {
          let k = KY.get(e.toban);
          if (!k || k.period !== per) KY.set(e.toban, k = { period: per, runs: 0, pt: 0, q2: 0, q3: 0, acc: 0 });
          const cls = r.cls || '';
          const bonus = /優勝戦/.test(cls) && !/準優/.test(cls) ? 2 : /準優/.test(cls) ? 1 : 0;
          k.runs++;
          if (pos >= 1 && pos <= 6) { k.pt += KPT[pos] + bonus; if (pos <= 2) k.q2++; if (pos <= 3) k.q3++; }
          if (e.f || e.l) k.acc += 10; else if (!(pos >= 1 && pos <= 6)) k.acc += /不|待/.test(ptxt) ? 7 : 10;
        }
      }
      let ra = R.get(e.toban); if (!ra) R.set(e.toban, ra = []); ra.push([t, win, p]);
      const mk = `${r.jcd}|${e.motor}|${e.motorGen}`;
      let mo = MO.get(mk); if (!mo) MO.set(mk, mo = []); mo.push([t, win, p]);
      const sk = `${e.toban}|${r.jcd}`;
      let se = SE.get(sk);
      if (!se || t - se.lastDay > SETU_GAP) SE.set(sk, se = { n: 0, stSum: 0, stN: 0, exSum: 0, exN: 0, lastDay: t });
      se.n++; se.lastDay = t;
      if (e.st != null && !e.f) { se.stSum += e.st; se.stN++; }
      if (exDev != null) { se.exSum += exDev; se.exN++; }
      /* 当日の走り（同じ日の後のレース用） */
      const pos = Number(e.pos);
      if (pos >= 1 && pos <= 6) {
        const tk = `${e.toban}|${r.date}`;
        let td = TD.get(tk); if (!td) TD.set(tk, td = []);
        td.push({ r: r.r, rel: 0.5 - (pos - 1) / 5, st: e.st != null && !e.f ? e.st : null });
      }
    },
  };
}

/* K と B を突き合わせる。6艇そろって1〜3着が確定しているレースだけ返す。
   base（index.json の base）を渡すと、時点つきの指標も一緒に作る。
   roll を渡すと、その makeRolling() に結果を流し込む（build_boat が「今日のレース」を
   読むために、昨日までの結果を食わせた状態を受け取る用途）。 */
export function loadRaces({ from = '', to = '', prog = null, base = null, roll = null, keys = null } = {}) {
  /* keys（'date|jcd|r' の Set）を渡すと、返すのはその中のレースだけ。
     時点つきの指標は全レースを流さないと合わないので、読み込み自体は省かない */
  const P = prog || loadPrograms({ from, to });
  roll = roll || makeRolling(base);
  const out = [];
  for (const k of jsonl('data/boat/results.jsonl', from, to)) {
    const b = P.get(`${k.date}|${k.jcd}|${k.r}`);
    if (!b) continue;
    const byLane = new Map(b.boats.map(x => [x.lane, x]));
    const boats = k.entries.map(e => ({ ...byLane.get(e.lane), ...e, lane: e.lane }));
    if (boats.length !== 6 || boats.some(x => x.toban == null || x.natWin == null)) continue;
    const fin = [1, 2, 3].map(p => boats.findIndex(x => Number(x.pos) === p));
    /* 時点つきの指標は「このレースを足す前」に読む */
    const exs = boats.map(b => b.ex).filter(v => v != null);
    const exMean = exs.length ? exs.reduce((a, b) => a + b, 0) / exs.length : null;
    for (const b of boats) Object.assign(b, roll.read(k, b));
    const keep = fin.every(i => i >= 0);
    for (const b of boats) roll.push(k, b, b._p, exMean != null && b.ex != null ? exMean - b.ex : null);
    const w = boats.find(x => Number(x.pos) === 1);
    roll.pushRace(k, w ? w.course : null, k.kimari);
    for (const b of boats) delete b._p;
    if (!keep) continue;
    if (keys && !keys.has(`${k.date}|${k.jcd}|${k.r}`)) continue;
    out.push({ ...k, cls: k.cls || b.cls || '', close: b.close || null, fixed: /進入固定/.test(b.cls || k.cls || ''), boats, order: fin, fin: fin.map(i => boats[i].lane) });
  }
  return out;
}
