/* 全競技まとめ（picks.html）のデータを作る。各競技の生成物（top.json / races.json / today.json）から、
   これから締切のレースを1本の表にそろえる。どの競技の反映係が embed_db を回しても、ここで作り直して埋める。
   各レースについて：
     期待値 ev … モデルの確率×オッズが最も高い買い目の値（1.00 が損得なし）。券種は競技で違う：
                 南関＝馬連・三連複（lib/bets.mjs の既存の計算）、ボート・競輪＝3連単、中央・ばんえい＝単勝。
                 極端な低確率の組で決まらないよう、確率1%未満（単勝は3%未満）・オッズ300倍超（単勝は100倍超）は除く
     自信度 conf … 各競技の自信度（1−正規化エントロピー。1着の確率が1頭・1艇・1車に集まっているほど大きい）。本命の1着確率は fav.p
     段位 grade … 各競技の予想生成が付けた段位をそのまま使う（南関と同じ作り：過去の分布で決めた閾値。lib/grade.mjs）。
                 南関＝racepick.json、競輪・中央・ばんえい＝検証期間の確定オッズ（data/<競技>/grade.json）、ボート＝締切時の記録の積み上げ。
                 券種で期待値の水準が違うので閾値は競技ごと。付いていない競技だけ、その日の相対順位で代用する */
import fs from 'node:fs';
import path from 'node:path';
import { readGrade } from './grade.mjs';

const LIM = { p: 0.01, o: 300, pWin: 0.03, oWin: 100 };
const r3 = v => v == null || !Number.isFinite(v) ? null : +v.toFixed(3);
const ymd = s => String(s || '').replace(/-/g, '');
const load = (ROOT, rel) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; } };
const minus = (hm, m) => { if (!hm) return null; const [h, mm] = hm.split(':').map(Number); const t = h * 60 + mm - m; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

export function buildPicks(ROOT) {
  const rows = [], sports = {};
  /* 南関（締切は発走の1分前） */
  const NK = load(ROOT, 'data/nankan/top.json');
  if (NK) {
    for (const [key, t] of Object.entries(NK.tracks || {})) for (const [dayKey, list] of Object.entries(t.days || {})) for (const r of list) {
      const ev = r.ev ? Math.max(r.ev.umaren ?? 0, r.ev.sanpuku ?? 0) : null;
      const bu = r.bets?.umaren?.[0], bs = r.bets?.sanpuku?.[0];
      const best = r.ev ? ((r.ev.sanpuku ?? 0) > (r.ev.umaren ?? 0) ? (bs && { kind: '三連複', k: bs.c.join('-'), p: bs.p, o: bs.odds, ev: bs.ev }) : (bu && { kind: '馬連', k: bu.c.join('-'), p: bu.p, o: bu.odds, ev: bu.ev })) : null;
      const f = r.top?.[0];
      rows.push({ sport: 'nankan', venue: t.track, r: r.r, date: ymd(r.date), close: minus(r.time, 1), post: r.time, cls: r.cls, n: r.n,
        grade: r.grade || null, ev: r3(ev), best, conf: r3(r.conf ?? null), fav: f ? { no: f.no, name: f.name, p: r3(f.win) } : null,
        market: /締切前|最終|暫定/.test(r.oddsSrc || '') ? r.oddsSrc : r.oddsSrc || null, url: `race.html?track=${key}&day=${encodeURIComponent(dayKey)}&r=${r.r}` });
    }
    sports.nankan = { label: '南関東競馬', gradeBy: '検証で決めた馬連の期待値の閾値（上位1割 S／1/4 A／半分 B）', bt: NK.backtest || null };
  }
  /* 単勝で期待値（中央・ばんえい） */
  const winBest = top => { let b = null; for (const h of top || []) { if (!(h.p >= LIM.pWin) || !(h.odds > 0) || h.odds > LIM.oWin) continue; const ev = h.p * h.odds; if (!b || ev > b.ev) b = { kind: '単勝', k: String(h.no), p: h.p, o: h.odds, ev: r3(ev) }; } return b; };
  const JR = load(ROOT, 'data/jra/top.json');
  if (JR) {
    for (const d of JR.days || []) for (const v of d.venues || []) for (const r of v.races || []) {
      const best = r.best || winBest(r.top), f = r.top?.[0];
      rows.push({ sport: 'jra', grade: r.rank || null, venue: v.venue, r: r.r, date: ymd(d.date), close: r.start, post: r.start, cls: [r.grade, r.cls].filter(Boolean).join(' ') || r.name, n: r.n,
        ev: best?.ev ?? null, best, conf: r3(r.conf ?? null), fav: f ? { no: f.no, name: f.name, p: r3(f.p) } : null, market: r.level === 'mix' || r.level === 'joint' ? '単勝オッズ' : null,
        url: `jra.html?date=${d.date}&venue=${encodeURIComponent(v.venue)}&r=${r.r}` });
    }
    sports.jra = { label: '中央競馬', gradeBy: '単勝の期待値の相対順位', bt: JR.backtest?.table ? { '◎単勝': JR.backtest.table['◎単勝'], '3頭BOX三連複': JR.backtest.table['3頭BOX三連複'] } : null };
  }
  const BN = load(ROOT, 'data/banei/top.json');
  if (BN) {
    for (const d of BN.days || []) for (const r of d.races || []) {
      const best = r.best || winBest(r.top), f = r.top?.[0];
      rows.push({ sport: 'banei', grade: r.rank || null, venue: '帯広', r: r.r, date: ymd(d.date), close: r.start, post: r.start, cls: r.name, n: r.n,
        ev: best?.ev ?? null, best, conf: r3(r.conf ?? null), fav: f ? { no: f.no, name: f.name, p: r3(f.p) } : null, market: r.level === 'joint' ? '単勝オッズ' : null,
        url: `banei.html?date=${d.date}&r=${r.r}` });
    }
    sports.banei = { label: 'ばんえい', gradeBy: '単勝の期待値の相対順位', bt: BN.backtest?.table ? { '◎単勝': BN.backtest.table['◎単勝'], '3頭BOX三連複': BN.backtest.table['3頭BOX三連複'] } : null };
  }
  /* ボート：3連単の全組（today.json の tri）から */
  const BT = load(ROOT, 'data/boat/today.json'), BTT = load(ROOT, 'data/boat/top.json');
  if (BT) {
    const topOf = new Map();
    for (const d of BTT?.days || []) for (const v of d.venues || []) for (const r of v.races || []) topOf.set(`${d.date}|${v.jcd}|${r.r}`, r);
    for (const d of BT.days || []) for (const v of d.venues || []) for (const r of v.races || []) {
      let best = r.best || null;
      if (!best) for (const t of r.tri || []) { if (!(t.p >= LIM.p) || !(t.o > 0) || t.o > LIM.o) continue; const ev = t.p * t.o; if (!best || ev > best.ev) best = { kind: '3連単', k: t.k, p: t.p, o: t.o, ev: r3(ev) }; }
      const tp = topOf.get(`${d.date}|${v.jcd}|${r.r}`), f = tp?.top?.[0];
      rows.push({ sport: 'boat', grade: r.grade || null, venue: v.name, r: r.r, date: ymd(d.date), close: r.close, post: r.close, cls: r.cls || '', n: 6,
        ev: best?.ev ?? null, best, conf: r3(r.conf ?? null), fav: f ? { no: f.lane, name: f.name, p: r3(f.p) } : null, market: !best ? null : r.odds?.kind === 'snap' ? '締切前オッズ' : '暫定オッズ',   // 3連単のオッズが無いと期待値を計算できない（オッズ前と同じ扱い）
        res: r.result?.order ? r.result.order.slice(0, 3) : null, url: `boat.html?date=${d.date}&jcd=${v.jcd}&r=${r.r}` });
    }
    sports.boat = { label: 'ボートレース', gradeBy: '3連単の期待値の相対順位', bt: BTT?.backtest?.table ? { '◎単勝': BTT.backtest.table['◎単勝'], '3艇BOX3連複': BTT.backtest.table['3艇BOX3連複'] } : null };
  }
  /* 競輪：3連単（races.json の e3 と ev） */
  const KR = load(ROOT, 'data/keirin/races.json');
  if (KR) {
    for (const d of KR.days || []) for (const v of d.venues || []) for (const r of v.races || []) {
      let best = r.best || null;
      if (!best) for (const t of [...(r.e3 || []), ...(r.ev || [])]) { if (!(t.p >= LIM.p) || !(t.o > 0) || t.o > LIM.o) continue; const ev = t.p * t.o; if (!best || ev > best.ev) best = { kind: '3連単', k: t.k, p: t.p, o: t.o, ev: r3(ev) }; }
      const f = r.riders.slice().sort((a, b) => b.p1 - a.p1)[0];
      rows.push({ sport: 'keirin', grade: r.grade || null, venue: v.venue, r: r.r, date: d.date, close: r.close, post: r.post, cls: r.kind, n: r.n,
        ev: best?.ev ?? null, best, conf: r3(r.conf ?? null), fav: f ? { no: f.no, name: f.name, p: r3(f.p1) } : null, market: r.level === 'joint' ? (r.oddsConfirmed ? '確定オッズ' : '3連単オッズ') : null,
        res: r.result ? r.result.order.map(o => o[1]) : null, url: `keirin.html?date=${d.date}&v=${v.slug}&r=${r.r}` });
    }
    sports.keirin = { label: '競輪', gradeBy: '3連単の期待値の相対順位', bt: KR.meta?.backtest?.table ? { '3車BOX 3連複': KR.meta.backtest.table['3車BOX 3連複'], 'AI 2車単 上位3点': KR.meta.backtest.table['AI 2車単 上位3点'] } : null };
  }
  /* 各競技の閾値（画面の説明用）。段位が1本も付いていない競技だけ、その日の相対順位で代用する */
  for (const sp of Object.keys(sports)) {
    if (sp === 'nankan') { sports[sp].thresholds = NK.thresholds?.evUmaren ? { S: NK.thresholds.evUmaren.p10, A: NK.thresholds.evUmaren.p25, B: NK.thresholds.evUmaren.p50 } : null; continue; }
    const G = readGrade(ROOT, sp);
    if (G?.thresholds && (rows.some(r => r.sport === sp && r.grade) || !rows.some(r => r.sport === sp))) {   // レースが無い日も閾値は出す
      sports[sp].thresholds = { S: G.thresholds.p10, A: G.thresholds.p25, B: G.thresholds.p50, n: G.thresholds.n };
      sports[sp].gradeBy = G.src === 'backtest' ? `検証期間（${G.from}〜）の確定オッズでの${G.kind}の期待値の分布` : G.src === 'rolling' ? `直近14日の締切時点の${G.kind}の期待値の分布` : `${G.kind}の期待値の分布（記録が貯まるまでの暫定）`;
      sports[sp].byGrade = G.byGrade || null;
      continue;
    }
    sports[sp].gradeBy += '（その日の相対順位で代用）';
    const xs = rows.filter(r => r.sport === sp && r.ev != null).map(r => r.ev).sort((a, b) => b - a);
    const q = f => xs.length ? xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(xs.length * f) - 1))] : Infinity;
    const t10 = q(0.10), t25 = q(0.25), t50 = q(0.50);
    sports[sp].thresholds = { S: t10, A: t25, B: t50, n: xs.length };
    for (const r of rows) if (r.sport === sp) r.grade = r.ev == null ? null : r.ev >= t10 ? 'S' : r.ev >= t25 ? 'A' : r.ev >= t50 ? 'B' : 'C';
  }
  rows.sort((a, b) => (a.date + (a.close || '')).localeCompare(b.date + (b.close || '')));
  /* 実戦の段位ごとの回収率：各競技の日別成績（締切前後に記録した予想を払戻で精算）の byGrade。形は {段位: {races, bets: {買い方: {n, hit, roi, bet, ret}}}} */
  const actual = {};
  for (const [sp, rel] of [['boat', 'data/boat/results.json'], ['keirin', 'data/keirin/results.json'], ['jra', 'data/jra/results.json'], ['banei', 'data/banei/results.json']]) { const R = load(ROOT, rel); if (R?.byGrade && Object.keys(R.byGrade).length) actual[sp] = R.byGrade; }
  { /* 南関：results.<場>.json の summary.byGrade（当時の入力で予想を再現したもの。締切前オッズで予想した数 pre を添える）を4場ぶん足す */
    const acc = {};
    for (const key of ['oi', 'kawasaki', 'funabashi', 'urawa']) {
      const R = load(ROOT, `data/nankan/results.${key}.json`); const B = R?.meta?.summary?.byGrade; if (!B) continue;
      for (const [g, G] of Object.entries(B)) {
        const A = acc[g] ||= { races: 0, pre: 0, bets: {} }; A.races += G.races; A.pre += G.pre || 0;
        for (const [k, name] of [['box4_sanpuku', '本命4頭BOX 三連複'], ['ev_umaren', '期待値1.0超の馬連']]) { const e = G.tally?.[k]; if (!e) continue; const x = A.bets[name] ||= { n: 0, hits: 0, bet: 0, ret: 0 }; x.n += e.races; x.hits += e.hits; x.bet += e.cost; x.ret += e.ret; }
      }
    }
    for (const A of Object.values(acc)) for (const x of Object.values(A.bets)) { x.hit = x.n ? r3(x.hits / x.n) : null; x.roi = x.bet ? r3(x.ret / x.bet) : null; delete x.hits; }
    if (Object.keys(acc).length) actual.nankan = acc;
  }
  return { built: new Date().toISOString(), sports, races: rows, actual };
}
