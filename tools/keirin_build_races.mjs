/* 競輪の出走表（races.jsonl のうち今日以降）にモデルを当てて keirin.html に埋め込むデータを作る → data/keirin/races.json / top.json
   ばんえい（banei_build_races.mjs）と同じ作り。3連単オッズが出ていれば joint、無ければ base。2着・3着は段階モデル（ライン決着を表せる）。
   締切10分前を過ぎたレースの予想は preds.jsonl に1行ずつ記録する（後から作り直さない。日別成績の元）。
     KR_TODAY       … 基準日（既定 今日、YYYYMMDD）。これ以降の開催日だけ載せる
     KR_RECORD_FROM=YYYYMMDD … その日から昨日までの（学習に使っていない）レースも、予想を「再現」として記録する（late=9999）。
                             記録の仕組みができる前の実績を埋める用。オッズは確定値なので実戦よりやや有利。既に記録のあるレースは触らない */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON, ymdOf, venueByName } from './lib/kr.mjs';
import { FEATURES, NF, slim, buildAsOf, makeFeaturizer, stageCtx, combos, raceOf, lineInfo, TIP, bankCls, BANKS } from './lib/krfeat.mjs';
import { utilities } from './lib/bpl.mjs';

const TODAY = process.env.KR_TODAY || ymdOf(new Date());
const M = readJSON('data/keirin/model.json');
let DB = {}; try { DB = readJSON('data/keirin/index.json'); } catch { }
let BT = null; try { BT = readJSON('data/keirin/backtest.json'); } catch { }
const RECORD_FROM = process.env.KR_RECORD_FROM || null;
if (RECORD_FROM && RECORD_FROM <= M.meta.split) console.error(`  ! KR_RECORD_FROM（${RECORD_FROM}）が学習期間（〜${M.meta.split}）に掛かっている。学習に使ったレースの再現は実績として意味が無い`);
const beta = new Float64Array(NF), betaJ = M.joint ? new Float64Array(NF) : null;
{
  const missing = [];
  FEATURES.forEach((k, i) => { const j = M.meta.feats.indexOf(k); if (j < 0) missing.push(k); else { beta[i] = M.base.beta[j]; if (betaJ) betaJ[i] = M.joint.beta[j]; } });
  const extra = M.meta.feats.filter(k => !FEATURES.includes(k));
  if (extra.length) throw new Error(`model.json に krfeat.mjs に無い特徴量がある（${extra.join(',')}）。keirin_fit.mjs を回し直す`);
  if (missing.length) console.error(`  (モデルに無い特徴量は 0 で扱う: ${missing.join(',')}。keirin_fit.mjs を回すと効く)`);
}
const round = (v, k = 3) => v == null || !Number.isFinite(v) ? null : Number(v.toFixed(k));
const sg = (v, k = 2) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(k)}`;
const pc = (v, d = 0) => v == null ? '—' : (v * 100).toFixed(d) + '%';

/* レースを読む。keirin_build_db が保存した「一昨日まで」の積み上げ（asof.json）があれば、それより後のレースだけを読んで足す。
   今日以降（と記録の再現）はオッズと文章を残す */
let INIT = null;
if (!RECORD_FROM) try { INIT = readJSON('data/keirin/asof.json'); } catch { }
const races = [];
{
  const text = fs.readFileSync(path.join(ROOT, 'data/keirin/races.jsonl'), 'utf8');
  for (const l of text.split('\n')) {
    if (!l) continue;
    const d = (l.match(/"date":"(\d{8})"/) || [])[1];
    if (INIT && d && d <= INIT.upto) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r.date || !r.riders?.length) continue;
    const up = d >= TODAY || (RECORD_FROM && d >= RECORD_FROM);
    races.push(slim(r, up ? { odds: true, text: true, pay: true } : {}));
  }
  races.sort((a, b) => a.date.localeCompare(b.date) || a.jcd.localeCompare(b.jcd) || a.r - b.r);
}
const ASOF = buildAsOf(races, INIT);
const featurize = makeFeaturizer(ASOF);

/* 締切の近づいた（10分前〜）レースの予想を記録（回収率の算出用）。後から作り直さない */
const PREDS = path.join(ROOT, 'data/keirin/preds.jsonl');
const recorded = new Set();
if (fs.existsSync(PREDS)) for (const l of fs.readFileSync(PREDS, 'utf8').split('\n')) if (l) { try { recorded.add(JSON.parse(l).raceId); } catch { } }
const nowJ = new Date();
function recordPred(race, date) {
  if (recorded.has(race.raceId)) return;
  const close = race.close || race.post;
  const t = close ? new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${close.padStart(5, '0')}:00`) : null;
  const late = t ? (nowJ - t) / 60000 : null;
  /* 記録は締切10分前から（反映係は10分おきなので、締切前に必ず1回は通る）。締切後に記録すると確定オッズで予想することになり、実戦より有利になる。
     結果がもう出ているレース（反映係が寝ていて遅れた）も記録はするが、late に締切からの遅れが残る */
  const repro = RECORD_FROM && date < TODAY;
  if (!repro && (process.env.KR_TODAY || !t || late < -10)) return;
  const top = race.riders.slice().sort((a, b) => b.p1 - a.p1);
  fs.appendFileSync(PREDS, JSON.stringify({
    raceId: race.raceId, date, venue: race.venue, r: race.r, at: nowJ.toISOString(), late: repro ? 9999 : Math.round(late), level: race.level,
    top: top.map(h => h.no), p1: Object.fromEntries(top.map(h => [h.no, h.p1])), mkt: race.mktOrder || null, mktE3: race.mktE3 || null,
    ai: { e3: race.e3.slice(0, 10).map(x => x.k), q3: race.q3.slice(0, 5).map(x => x.k), e2: race.e2.slice(0, 5).map(x => x.k), q2: race.q2.slice(0, 3).map(x => x.k), wide: race.wide.slice(0, 3).map(x => x.k),
      ev: race.ev.map(x => x.k), line: race.lineBet || null },
  }) + '\n');
  recorded.add(race.raceId);
}

const GROUP = {
  scoreRel: '得点', scoreRank: '得点', scoreTop: '得点', clsRel: '得点',
  winRate: '成績', q2: '成績', q3: '成績', sRate: '脚質', bRate: '脚質', jiriki: '脚質', sashiMark: '脚質', styleNige: '脚質', styleRyo: '脚質', gear: 'その他', young: 'その他', age: 'その他',
  formAvg: '近況', formLast: '近況', curMeet: '近況', venueFit: '当所', bankFit: '当所', finalShare: '成績',
  single: 'ライン', lineHead: 'ライン', lineSecond: 'ライン', lineThird: 'ライン', lineSize: 'ライン', lineScore: 'ライン', headPower: 'ライン', secondBehindStrong: 'ライン', rivalHeads: 'ライン', nLines: 'ライン', bigLine: 'ライン',
  home: '地元', homeRegion: '地元', homeInLine: '地元', homeHead: '地元', homeX: '地元',
  tip: '記者', evalRel: '記者', rIdx: '成績', rPosFit: 'ライン', venueHeadEdge: 'バンク', venueSecondEdge: 'バンク', dayHeadEdge: '当日', dayJiriki: '当日', windNige: '当日', mktLog: '人気', pairFit: 'ライン', bankJiri: 'バンク',
  rLineFin: '選手の癖', initLead: 'ライン', initSecond: 'ライン', rBankFit: 'バンク', venueStyleFit: 'バンク', straightX: 'バンク', cantX: 'バンク',
};
const GROUPS = ['得点', '成績', '近況', '脚質', 'ライン', '選手の癖', '地元', '当所', 'バンク', '当日', '記者', '人気', 'その他'];
const contrib = (x, b) => { const g = Object.fromEntries(GROUPS.map(k => [k, 0])); for (let i = 0; i < NF; i++) g[GROUP[FEATURES[i]] || 'その他'] += b[i] * x[i]; return GROUPS.map(k => round(g[k], 2)); };
const slotName = li => li.size === 1 ? '単騎' : li.pos === 0 ? '先頭' : li.pos === 1 ? '番手' : `${li.pos + 1}番手`;
const HOME = DB.home?.all;

const days = new Map();
let nR = 0, nJ = 0;
for (const r0 of races) {
  if (r0.date < TODAY && !(RECORD_FROM && r0.date >= RECORD_FROM)) continue;
  /* 時点の値は「このレースの直前」（of）を使う。latest だと締切後に記録する予想にこのレース自身の結果が当日の傾向として混ざる */
  const f = featurize(r0);
  if (!f) continue;
  const race = f.race;
  const hasMkt = !!f.mkt;
  let U = utilities(f.rows.map(x => x.x), beta), level = 'base', tau = M.base.tau, stage = M.base.stage, bUse = beta;
  if (hasMkt && betaJ) { U = utilities(f.rows.map(x => x.x), betaJ); tau = M.joint.tau; stage = M.joint.stage; level = 'joint'; bUse = betaJ; nJ++; }
  const nos = f.rows.map(x => x.no);
  const C = combos(U, tau, stageCtx(f), stage, nos);
  const order = C.p1.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const marks = {}; ['◎', '○', '▲', '△', '△', '☆'].forEach((m, i) => { if (order[i] != null) marks[order[i]] = m; });
  const odds = r0.odds || {};
  const riders = f.rows.map((x, i) => {
    const h = x.h, li = x.li, as = x.as || {};
    const note = [];
    const runs = [h.cur, h.prev1, h.prev2].filter(Boolean).flatMap((m, mi) => m.runs.map(rr => ({ ...rr, meet: mi, venue: m.venue, grade: m.grade })));
    note.push(`競走得点 ${h.score ?? '—'}（レース内 ${f.rows.filter(y => (y.h.score || 0) > (h.score || 0)).length + 1}位）／直近4ヶ月 ${h.w1 ?? 0}-${h.w2 ?? 0}-${h.w3 ?? 0}-${h.wx ?? 0}（勝率${h.winRate ?? '—'}%・3連対率${h.q3 ?? '—'}%）`);
    note.push(`${h.style || ''}／S${h.S ?? 0}・B${h.B ?? 0}／逃${h.nige ?? 0}・捲${h.makuri ?? 0}・差${h.sashi ?? 0}・マ${h.mark ?? 0}${h.gear ? `／ギヤ${h.gear}` : ''}${f.initLine && f.initLine[0] === h.no ? '／主導権を取りそう（B・逃げの比率がいちばん高い先頭）' : ''}`);
    if (as.rLineFinN >= 2) note.push(`${li.pos === 0 ? '先頭' : '番手'}のときのライン決着（先頭と番手がそろって2着内）${as.rLineFinC}/${as.rLineFinN}回（上振れ ${sg(as.rLineFin)}）`);
    const bc = bankCls(race.bank);
    if (as.rBankN >= 4) note.push(`${bc}バンク ${as.rBankN}走で3着内 ${as.rBankT}回（本人の平常比 ${sg(as.rBankFit)}${as.rBankFit >= 0.3 ? '・得意' : as.rBankFit <= -0.3 ? '・苦手' : ''}）`);
    if (f.known && !race.girls) note.push(`ライン：${f.lines[li.li].join('-')} の${slotName(li)}${li.pos >= 1 ? `（前は ${f.lines[li.li][li.pos - 1]}番）` : ''}${as.rPosN >= 3 ? `／この位置での3着内の上振れ ${sg(as.rPosFit)}（${as.rPosN}走）` : ''}${as.pairN ? `／${li.pos === 0 ? '番手' : '前'}との連係 ${as.pairN}回で2人そろって3着内 ${as.pairC}回` : ''}`);
    if (x.home) note.push(`地元（${h.pref}）${HOME?.winMult ? `。地元は同じ得点順位の他の選手より1着率が実測 ${HOME.winMult.toFixed(2)}倍` : ''}${as.rHomeN >= 3 ? `／本人の地元での3着内の上振れ ${sg(as.rHome)}（${as.rHomeN}走）` : ''}`);
    else if (x.homeReg) note.push(`地区地元（${h.region}）`);
    const vr = h.venueRec, br = h.bankRec;
    if (vr && vr.some(v => v)) note.push(`当所5年 ${vr.join('-')}${br && br.some(v => v) ? `／同走路（${race.bank || '?'}）年間 ${br.join('-')}` : ''}`);
    const recent = runs.slice().reverse().slice(0, 6).map(rr => typeof rr.pos === 'number' ? rr.pos : '落').join('');
    if (recent) note.push(`近況 ${recent}${h.cur?.runs?.length ? `（今場所 ${h.cur.runs.map(rr => typeof rr.pos === 'number' ? rr.pos : '落').join('-')}）` : ''}`);
    if (h.comment) note.push(`コメント「${h.comment}」`);
    return {
      no: h.no, waku: h.waku, name: h.name, pref: h.pref, age: h.age, term: h.term, cls: h.cls, style: h.style, gear: h.gear, score: h.score,
      S: h.S, B: h.B, nige: h.nige, makuri: h.makuri, sashi: h.sashi, mark: h.mark, w: [h.w1, h.w2, h.w3, h.wx], winRate: h.winRate, q2: h.q2, q3: h.q3,
      tip: h.tip || null, eval: h.eval, comment: h.comment || null, home: x.home, homeReg: x.homeReg, region: h.region,
      line: f.known && !race.girls ? { li: li.li, pos: li.pos, size: li.size, slot: slotName(li) } : null,
      meets: [h.cur, h.prev1, h.prev2].map(m => m && m.runs.length ? { venue: m.venue, grade: m.grade, runs: m.runs.map(rr => [rr.date ? `${+rr.date.slice(4, 6)}/${+rr.date.slice(6, 8)}` : '', (rr.kind || '').replace(/^[SA]級/, ''), rr.pos, rr.agari]) } : null),
      venueRec: h.venueRec, bankRec: h.bankRec,
      p1: round(C.p1[i], 4), top2: round(C.top2[i], 3), top3: round(C.top3[i], 3), U: round(U[i], 2), mkt: f.mkt ? round(f.mkt[i], 4) : null,
      markAI: marks[i] || '', c: contrib(x.x, bUse), note,
      bankFit: as.rBankN >= 4 ? round(as.rBankFit, 2) : null, bankN: as.rBankN || 0, lineFin: as.rLineFinN >= 2 ? [as.rLineFinC, as.rLineFinN] : null,
      init: f.initLine && f.initLine[0] === h.no ? 1 : f.initLine && f.initLine[1] === h.no ? 2 : 0,
    };
  });
  /* 3連単の期待値（モデル確率×オッズ）。極端な低確率の組は外す（買えない買い目で期待値が決まらないように。南関の LIMIT と同じ考え） */
  const ev = [];
  if (odds.e3) for (const [k, p] of C.e3.slice(0, 60)) { const o = odds.e3[k]; if (o && o < 9999 && p >= 0.01 && o <= 300) ev.push({ k, p: round(p, 4), o, ev: round(p * o, 2) }); }
  ev.sort((a, b) => b.ev - a.ev);
  const evPick = ev.filter(x => x.ev >= 1.0).slice(0, 6);
  const top = i => riders[order[i]];
  const nn = h => `${h.no} ${h.name}`;
  const pts = [];
  pts.push(`本命 ${nn(top(0))}（1着 ${pc(C.p1[order[0]], 1)}）、対抗 ${nn(top(1))}（${pc(C.p1[order[1]], 1)}）、単穴 ${nn(top(2))}。`);
  /* ライン */
  let lineBet = null;
  if (f.known && !race.girls) {
    const lineTxt = f.lines.map(l => l.join('-')).join('／');
    const nl = f.lines.filter(l => l.length >= 2).length, ns = f.lines.filter(l => l.length === 1).length;
    pts.push(`並び：${lineTxt}（${nl}分戦${ns ? `＋単騎${ns}` : ''}）。`);
    if (f.initLine) { const hh = riders.find(h => h.no === f.initLine[0]); pts.push(`主導権：B（バック）・逃げの比率から ${hh ? `${nn(hh)}（B${hh.B ?? 0}・逃${hh.nige ?? 0}）` : ''} のライン（${f.initLine.join('-')}）が前を取りそう${f.initGap < 0.15 ? '。ただし他のラインの先頭と差が小さく、主導権争いになりうる' : ''}。`); }
    const heads = f.lines.map(l => riders.find(h => h.no === l[0])).filter(h => h && (h.style === '逃' || (h.nige || 0) >= 3));
    if (heads.length >= 2) pts.push(`先行型が ${heads.length}人（${heads.map(nn).join('・')}）。主導権争いで脚を使い合えば、番手・追込や捲りに展開が向く。`);
    else if (heads.length === 1) pts.push(`先行型は ${nn(heads[0])} だけ。主導権を取りやすく、番手の ${f.lines.find(l => l[0] === heads[0].no)?.[1] ?? '—'}番にも流れが向く。`);
    else pts.push('はっきりした先行型がいない。スローからの捲り・中団からの差しの展開が考えられる。');
    const lsc = f.lines.filter(l => l.length >= 2).map(l => [l, l.reduce((a, no) => a + (riders.find(h => h.no === no)?.score || 0), 0) / l.length]).sort((a, b) => b[1] - a[1]);
    if (lsc.length) pts.push(`ラインの平均得点：${lsc.map(([l, s]) => `${l.join('-')} ${s.toFixed(1)}`).join('、')}。`);
    /* ラインの買い目：本命のラインの「ライン決着」（本命→同じラインの番手） */
    const w = top(0);
    const lf = riders.filter(h => h.lineFin && h.lineFin[1] >= 3 && h.line && h.line.pos === 1).map(h => `${nn(h)}（番手で ${h.lineFin[0]}/${h.lineFin[1]}回）`);
    if (lf.length) pts.push(`番手のときのライン決着の実績：${lf.join('、')}。`);
    if (w.line && w.line.size >= 2) {
      const L0 = f.lines[w.line.li];
      const mate = w.line.pos === 0 ? L0[1] : L0[w.line.pos - 1];
      lineBet = { e2: [`${w.no}-${mate}`, `${mate}-${w.no}`], line: L0 };
      const pl = C.e2.filter(([k]) => { const [a, b] = k.split('-').map(Number); return L0.includes(a) && L0.includes(b); }).reduce((s, x) => s + x[1], 0);
      pts.push(`本命 ${w.no}番のライン（${L0.join('-')}）で1・2着を独占する確率 ${pc(pl, 1)}${DB.lineOneTwo ? `（全体の実測のライン決着率 ${pc(DB.lineOneTwo, 0)}）` : ''}。`);
    }
  }
  /* 地元 */
  const homes = riders.filter(h => h.home);
  if (homes.length) pts.push(`地元：${homes.map(nn).join('・')}${HOME?.winMult ? `。実測では地元は同じ得点順位の他の選手より1着率 ${HOME.winMult.toFixed(2)}倍・3着内 ${HOME.top3Mult?.toFixed(2)}倍（${HOME.runs?.toLocaleString()}走）` : ''}${M.homeMult ? `、モデルの地元係数は勝ちの見込みを ${M.homeMult.toFixed(2)}倍` : ''}。`);
  /* 得点 */
  const sc = riders.map(h => h.score || 0).sort((a, b) => b - a);
  if (sc.length >= 2) pts.push(`競走得点の最上位は ${riders.find(h => h.score === sc[0])?.name}（${sc[0]}）、2位との差 ${(sc[0] - sc[1]).toFixed(2)}。${sc[0] - sc[1] >= 3 ? '得点では抜けている。' : '得点差は小さく混戦。'}`);
  /* 当日・開催のバンク傾向（このレースより前の結果だけ） */
  const D = f.day || {};
  if (D.dRaw?.n >= 2) pts.push(`本日の${race.venue}ここまで ${D.dRaw.n}R：ラインの先頭が ${D.dRaw.head}勝・自力（逃げ・捲り）決着 ${D.dRaw.jiri}回${D.wind != null ? `、直前のレースの風速 ${D.wind}m` : ''}。${D.dRaw.head / D.dRaw.n >= 0.55 ? '前が残っている。' : D.dRaw.head / D.dRaw.n <= 0.25 ? '先頭が残れていない（番手・差しが届く）。' : ''}`);
  if (D.mRaw?.n >= 6) pts.push(`この開催（${race.day}日目までの ${D.mRaw.n}R）は先頭 ${D.mRaw.head}勝・自力決着 ${D.mRaw.jiri}回。`);
  const BK = BANKS[race.venue];
  if (BK) {
    const bc = bankCls(race.bank || BK.len);
    pts.push(`${race.venue}バンク：周長 ${BK.len}m・見なし直線 ${BK.straight}m・カント ${BK.cant}°（${BK.straight >= 60 ? '直線が長く差し・追込が届きやすい' : BK.straight <= 45 ? '直線が短く先行・捲りが残りやすい' : '直線は標準'}、${BK.cant >= 34 ? 'カントがきつく捲りが決まりやすい' : BK.cant <= 28 ? 'カントが緩い' : 'カントは標準'}）。${(BK.feature || []).slice(0, 2).join('／')}`);
    if (f.kim && f.kim.n >= 10) pts.push(`${race.venue}の決まり手（${f.kim.n}R、全体比）：${['逃', '捲', '差', 'マ'].map((k, j) => `${k} ${pc(f.kim.raw[j] / f.kim.n, 0)}（${sg((f.kim.share[j] - f.kim.base[j]) * 100, 0)}pt）`).join('・')}。`);
    const good = riders.filter(h => h.bankFit != null && h.bankFit >= 0.3).map(h => `${nn(h)}（${h.bankN}走）`), bad = riders.filter(h => h.bankFit != null && h.bankFit <= -0.3).map(h => `${nn(h)}（${h.bankN}走）`);
    if (good.length) pts.push(`${bc}バンクが得意：${good.join('、')}。`);
    if (bad.length) pts.push(`${bc}バンクは苦手：${bad.join('、')}。`);
  }
  const VS = DB.venues?.[race.venue];
  if (VS?.slot) pts.push(`${race.venue}（${race.bank || VS.bank}バンク）の実測：${VS.slot.map(s => `${s.name} ${pc(s.win, 0)}`).join('・')}の1着率、決まり手 ${Object.entries(VS.kim || {}).slice(0, 4).map(([k, v]) => `${k}${pc(v, 0)}`).join('・')}（${VS.races}R）。`);
  /* 記者 */
  const tipTop = riders.find(h => h.tip === '◎');
  if (tipTop) pts.push(`記者の本命 ${nn(tipTop)}${r0.review ? `。レース評「${r0.review}」` : ''}`);
  pts.push(`3連単の本線 ${C.e3[0][0]}（${pc(C.e3[0][1], 1)}）、3連複 ${C.q3[0][0]}（${pc(C.q3[0][1], 1)}）、2車単 ${C.e2[0][0]}（${pc(C.e2[0][1], 1)}）。`);
  if (evPick.length) pts.push(`オッズと比べて期待値が 1.0 を超える3連単：${evPick.slice(0, 4).map(x => `${x.k}（${x.o}倍・${x.ev}）`).join('、')}。※ 期待値だけで買う方法は他競技の検証で回収率が悪かった。参考まで。`);
  const mktOrder = f.mkt ? f.mkt.map((q, i) => [q, nos[i]]).sort((a, b) => b[0] - a[0]).map(x => x[1]) : null, mktTop = mktOrder ? mktOrder[0] : null;
  const mktE3 = r0.odds?.e3 ? Object.entries(r0.odds.e3).filter(([, v]) => v > 0 && v < 9999).sort((a, b) => a[1] - b[1])[0]?.[0] || null : null;
  const race1 = {
    raceId: r0.raceId, r: r0.r, title: r0.title, kind: r0.kind, stage: race.stage, girls: race.girls, cond: r0.cond, post: r0.post, close: r0.close, n: riders.length, level,
    venue: r0.venue, day: r0.day, grade: r0.grade, meetName: r0.meetName, bank: r0.bank || DB.venues?.[r0.venue]?.bank || null,
    bankInfo: BANKS[r0.venue] ? { straight: BANKS[r0.venue].straight, cant: BANKS[r0.venue].cant } : null, initLine: f.initLine, reporter: r0.reporter, review: r0.review || null,
    lines: f.known ? f.lines : [], lineRole: r0.lineRole || [], riders, mktTop, mktOrder, mktE3, oddsAt: r0.oddsAt, oddsConfirmed: r0.oddsConfirmed,
    box3: order.slice(0, 3).map(i => nos[i]).sort((a, b) => a - b), box4: order.slice(0, 4).map(i => nos[i]).sort((a, b) => a - b),
    e3: C.e3.slice(0, 10).map(([k, p]) => ({ k, p: round(p, 4), o: odds.e3?.[k] ?? null })), q3: C.q3.slice(0, 6).map(([k, p]) => ({ k, p: round(p, 4), o: typeof odds.q3?.[k] === 'number' ? odds.q3[k] : null })),
    e2: C.e2.slice(0, 6).map(([k, p]) => ({ k, p: round(p, 4), o: odds.e2?.[k] ?? null })), q2: C.q2.slice(0, 5).map(([k, p]) => ({ k, p: round(p, 4), o: typeof odds.q2?.[k] === 'number' ? odds.q2[k] : null })),
    wide: C.wide.slice(0, 5).map(([k, p]) => ({ k, p: round(p, 4) })), ev: evPick, lineBet,
    conf: round(1 - (-C.p1.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0)) / Math.log(C.p1.length), 3),
    result: r0.result ? { order: r0.result.order.filter(o => typeof o.pos === 'number' && o.pos <= 3).map(o => [o.pos, o.no, o.kimarite]), e3: r0.pay?.e3?.[0] || null, q3: r0.pay?.q3?.[0] || null, e2: r0.pay?.e2?.[0] || null, weather: r0.result.weather, wind: r0.result.wind } : null,
    points: pts,
  };
  recordPred(race1, r0.date);
  if (r0.date < TODAY) continue;
  const dd = days.get(r0.date) || days.set(r0.date, new Map()).get(r0.date);
  const vk = r0.jcd;
  const v = dd.get(vk) || dd.set(vk, { jcd: vk, venue: r0.venue, slug: r0.slug, grade: r0.grade, meetName: r0.meetName, day: r0.day, bank: r0.bank || DB.venues?.[r0.venue]?.bank || null, races: [] }).get(vk);
  v.races.push(race1);
  nR++;
}
const out = {
  meta: {
    built: new Date().toISOString(), today: TODAY, groups: GROUPS,
    model: { built: M.meta.built, split: M.meta.split, train: M.meta.train, test: M.meta.test, from: M.meta.from, to: M.meta.to, base: M.base.test, joint: M.joint?.test || null, mktOnly: M.mktOnly, baseSame: M.baseSame,
      coef: M.base.coef.slice(0, 14), jointCoef: M.joint?.coef?.slice(0, 14) || null, homeMult: M.homeMult, stage: M.base.stage },
    index: DB.meta ? { from: DB.meta.from, to: DB.meta.to, races: DB.meta.races, slots: DB.slots, lineOneTwo: DB.lineOneTwo, home: DB.home, kimarite: DB.kimarite, venues: DB.venues } : null,
    backtest: BT ? { level: BT.meta.level, from: BT.meta.from, to: BT.meta.to, races: BT.meta.races, table: BT.table, note: BT.meta.note, byVenue: BT.byVenue } : null,
  },
  days: [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([date, vs]) => ({ date, venues: [...vs.values()].sort((a, b) => (a.races[0]?.post || '').localeCompare(b.races[0]?.post || '')).map(v => ({ ...v, races: v.races.sort((a, b) => a.r - b.r) })) })),
};
writeJSON('data/keirin/races.json', out);
const top = {
  builtAt: out.meta.built, today: TODAY, model: { train: M.meta.train, test: M.meta.test, base: M.base.test, joint: M.joint?.test || null, mktOnly: M.mktOnly }, backtest: out.meta.backtest,
  days: out.days.map(d => ({ date: d.date, venues: d.venues.map(v => ({ venue: v.venue, jcd: v.jcd, grade: v.grade, meetName: v.meetName, day: v.day, bank: v.bank, races: v.races.map(r => {
    const t = r.riders.slice().sort((a, b) => b.p1 - a.p1).slice(0, 3);
    return { r: r.r, kind: r.kind, post: r.post, close: r.close, n: r.n, level: r.level, conf: r.conf, girls: r.girls, lines: r.lines,
      top: t.map(h => ({ no: h.no, name: h.name, p: round(h.p1, 3), home: h.home, score: h.score, slot: h.line?.slot || null })),
      e3: r.e3[0], q3: r.q3[0], box3: r.box3, res: r.result ? r.result.order.map(o => o[1]) : null };
  }) })) })),
};
writeJSON('data/keirin/top.json', top);
console.error(`${TODAY} 以降 ${nR}R（joint＝オッズあり ${nJ}R）`);
for (const d of out.days) console.error(`  ${d.date} ${d.venues.map(v => `${v.venue}${v.races.length}R`).join(' ')}`);
