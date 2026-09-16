/* 出馬表ページ（race.html）と予想ページ（index.html）に載せる予想印を作る。

   印と勝率は**条件付きロジット**（fit_model.mjs の係数）で出す。
   3Dシミュレータは順位予測に向かないことが検証で分かったので、
   予測はロジット、シミュレータは「この馬場条件だとどう走るか」を見る道具、と役割を分けている。
   3角・4角の平均位置とペースはシミュレータの出力をそのまま使う（そこは物理のほうが素直）。

   ※ embed_db.mjs のあとに実行すること（index.html の傾向データを読むため）。
   出力: entries.<track>.json を更新し、race.html と index.html に埋め直す       */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { inject } from './lib/embed.mjs';
import { loadModel, condOf } from './lib/model.mjs';
import { makeFeaturizer, buildLapIndex, buildShikenIndex, buildFormIndex, FEATURES } from './lib/feat.mjs';
import { betPlan, confOf } from './lib/bets.mjs';
import { predictRace } from './lib/nkstage.mjs';
import { raceExtras } from './lib/nkresults.mjs';

const TRACKS = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki,船橋:funabashi,浦和:urawa').split(',').map(s => s.split(':')[1]);
const JA = { oi: '大井', kawasaki: '川崎', funabashi: '船橋', urawa: '浦和' };
const N = Number(process.env.NK_MARK_TRIALS || 600);
const FAST = !!process.env.NK_MARK_FAST;   // オッズだけ変わったときの再計算を省く
const MARKS = ['◎', '○', '▲', '△', '△', '☆'];
const r3 = x => Math.round(x * 1000) / 1000;

const MODELFILE = fs.existsSync(path.join(ROOT, 'data/nankan/model.live.json'))
  ? 'data/nankan/model.live.json' : 'data/nankan/model.json';
const MDL = fs.existsSync(path.join(ROOT, MODELFILE)) ? readJSON(MODELFILE) : null;
const DB = readJSON(process.env.NK_MARK_DB || 'data/nankan/index.json');
const featurize = makeFeaturizer(DB);
/* 取得ジョブが追記中でも壊れないよう、読めない行は捨てる */
const jl = f => fs.readFileSync(path.join(ROOT, 'data/nankan', f), 'utf8').split('\n')
  .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const cards = new Map(jl('cards.jsonl').map(c => [c.raceId, c]));
/* オッズがあれば第2段（人気との合成）まで使う。
   締切前スナップショット（watch_odds.mjs）を最優先、無ければ最終オッズ。 */
const oddsMap = new Map();
for (const o of jl('odds.jsonl')) oddsMap.set(o.raceId, { src: '最終', tan: o.tan, upd: o.updated || null });
/* 暫定(odds_pre.json) → 締切前(T-n) の順に上書きするので、締切前があればそちらが残る */
try {
  const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/nankan/odds_pre.json'), 'utf8'));
  for (const o of Object.values(P)) oddsMap.set(o.raceId, { src: `暫定(発走${o.minsToPost}分前)`, tan: o.tan, at: o.capturedAt || null, upd: o.updated || null });
} catch {}
for (const o of jl('odds_live.jsonl')) if (o.tag !== 'final' && o.tag !== 'pre') oddsMap.set(o.raceId, { src: `締切前(発走${o.minsToPost}分前)`, tan: o.tan, at: o.capturedAt || null, upd: o.updated || null });
const resForForm = jl('results.jsonl');
const LAP = buildLapIndex(resForForm, [...cards.values()]);
/* 能力・調教試験（新馬・転入初戦の手がかり）*/
try { LAP.shiken = buildShikenIndex(jl('shiken.jsonl')); } catch { LAP.shiken = null; }
/* 騎手・調教師の「そのレース時点」の調子（過去の騎乗だけから作る）*/
LAP.form = buildFormIndex([...cards.values()], resForForm);
if (!MDL) console.error('!! model.json がない。印はシミュレータの勝率で出す');

const softmax = us => { const mx = Math.max(...us); const e = us.map(u => Math.exp(u - mx)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); };
function logitP(f) {
  const { mean, sd, beta } = MDL;
  return softmax(f.rows.map(h => FEATURES.reduce((s, k, i) => s + beta[i] * ((h.x[k] - mean[k]) / sd[k]), 0)));
}
/* --- 買い目・期待値・自信度 ------------------------------------------
   計算は lib/bets.mjs（検証の race_pick.mjs と同じもの）。
   段位は evUmaren の分位で決める。**検証では絞り込みで回収率が安定して上がる
   証拠は得られていない**ので、あくまで強弱をつけるための参考値として出す。   */
const PICK = fs.existsSync(path.join(ROOT, 'data/nankan/racepick.json')) ? readJSON('data/nankan/racepick.json') : null;
const MAXPTS = Number(process.env.NK_BET_MAXPTS || 12);
const gradeOf = ev => {
  const t = (PICK && PICK.thresholds && PICK.thresholds.evUmaren) || { p10: 1.35, p25: 1.21, p50: 1.08 };
  return ev >= t.p10 ? 'S' : ev >= t.p25 ? 'A' : ev >= t.p50 ? 'B' : 'C';
};

/* 3着以内に入る確率（Harville）。三連系の期待値を見るときの土台にもなる */
function top3Of(p) {
  const n = p.length, out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = p[i];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const r1 = 1 - p[j];
      if (r1 <= 0) continue;
      s += p[j] * p[i] / r1;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const r2 = 1 - p[j] - p[k];
        if (r2 <= 0) continue;
        s += p[j] * (p[k] / r1) * (p[i] / r2);
      }
    }
    out[i] = Math.min(1, s);
  }
  return out;
}

const ent = { meta: null };
for (const key of TRACKS) {
  const M = loadModel(key);
  const d = readJSON(`data/nankan/entries.${key}.json`);
  let done = 0, noModel = 0, reused = 0;
  for (const [dk, list] of Object.entries(d.days)) {
    for (const r of list) {
      const rk = `${dk}|${r.r}`;
      const all = d.entries[rk] || [];
      /* オッズが「発売中止」になっている馬は取消として扱う。
         出馬表の取消反映は遅れることがあり、1頭でも欠けると
         「オッズなし」に落ちてレース丸ごとおすすめが出せなくなっていた。 */
      const od0 = oddsMap.get(r.raceId);
      if (od0) for (const h of all) {
        const t = od0.tan[h.no];
        if (t && t.sale === false) { h.scratch = true; h.noSale = true; }
      }
      const live = all.filter(h => !h.scratch);
      if (live.length < 2) continue;
      r.n = live.length;                     // 発売中止ぶんを頭数から引く

      /* シミュレータ：3角・4角の平均位置とペース（馬場条件つき）。
         オッズだけが変わったときは前回の結果を使い回す（NK_MARK_FAST）。
         位置取りは馬場条件が同じなら変わらないので、毎回600回まわす必要がない。 */
      const cond = condOf(M, r.dist);
      const reusable = FAST && r.pace && live.every(h => h.c3 != null && h.simWin != null);
      const mc = reusable
        ? { win: live.map(h => h.simWin), c3: live.map(h => h.c3), c4: live.map(h => h.c4),
            pace: { label: r.pace }, winTime: r.winTime }
        : M.monteCarlo({ dist: r.dist, horses: live.map(h => ({ ...h })) }, cond, N);
      if (reusable) reused++;

      /* 予測：ロジット（lib/nkstage.mjs の predictRace。オッズがあれば joint → 第2段、無ければ基礎。2着・3着は段階モデル） */
      let p = null, marketP = null, combos = null;
      const card = cards.get(r.raceId);
      const od = oddsMap.get(r.raceId);
      if (MDL && card) {
        const f = featurize(card, cond.baba, null, LAP);
        const pr = f ? predictRace(MDL, f, od ? od.tan : null, live.map(h => h.no)) : null;
        if (pr && pr.nos.length === live.length && live.every((h, i) => pr.nos[i] === h.no)) {
          p = pr.p; combos = pr.combos;
          if (pr.pm) { marketP = pr.pm; live.forEach((h, i) => { h.pubOdds = od.tan[h.no].odds; h.pFund = r3(pr.pFund[i]); }); r.oddsSrc = od.src; r.oddsAt = od.at || null; r.oddsUpd = od.upd || null; r.pSrc = pr.src; }
        }
      }
      if (!p) { p = mc.win.slice(); noModel++; }
      const t3 = combos ? combos.top3 : top3Of(p);

      /* 自信度・期待値・おすすめ買い目 */
      r.conf = r3(confOf(p));
      r.pTop = r3(Math.max(...p));
      if (marketP) {
        const plan = betPlan(p, marketP, live.map(h => h.no), MAXPTS, combos);
        r.ev = { umaren: plan.umaren.best, sanpuku: plan.sanpuku.best };
        r.nPos = { umaren: plan.umaren.nPos, sanpuku: plan.sanpuku.nPos };
        r.bets = { umaren: plan.umaren.buy, sanpuku: plan.sanpuku.buy };
        r.grade = gradeOf(plan.umaren.best);
      } else { r.ev = null; r.bets = null; r.grade = null; }

      const order = p.map((w, i) => [w, t3[i], i]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
      const mark = {};
      order.forEach(([, , i], q) => { if (q < MARKS.length) mark[i] = MARKS[q]; });
      /* 本命BOX。過去230レースの実績では、期待値1.0超だけを買うやり方（回収率0〜52%）より
         こちらのほうがはるかに良い（三連複4頭BOXで84〜112%）。おすすめの主役はこちら。 */
      const ordNos = order.map(([, , i]) => live[i].no);
      const cmb2 = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) o.push([a[i], a[j]]); return o; };
      const cmb3 = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) for (let k = j + 1; k < a.length; k++) o.push([a[i], a[j], a[k]]); return o; };
      r.box = {};
      for (const k of [3, 4]) if (ordNos.length >= k) {
        const sel = ordNos.slice(0, k);
        r.box[k] = { sel, umaren: cmb2(sel).map(c => c.join('-')), sanpuku: cmb3(sel).map(c => c.join('-')) };
      }
      live.forEach((h, i) => {
        h.win = r3(p[i]); h.top3 = r3(t3[i]);
        h.simWin = r3(mc.win[i]);
        h.c3 = r3(mc.c3[i]); h.c4 = r3(mc.c4[i]);
        h.mark = mark[i] || '';
        h.rank = order.findIndex(([, , j]) => j === i) + 1;
      });
      r.pace = mc.pace.label;
      r.cond = cond;
      r.winTime = r3(mc.winTime);
      done++;
    }
  }
  const blendN = Object.values(d.days).flat().filter(r => r.oddsSrc).length;
  d.meta = { ...d.meta, marks: { trials: N, model: MDL ? MODELFILE : null, blended: blendN,
    note: MDL ? `印と勝率は条件付きロジット${blendN ? `（${blendN}レースは単勝オッズと合成）` : '（オッズなし）'}。3角/4角の位置とペースはシミュレータ` : 'モデル未生成のためシミュレータの勝率' } };
  writeJSON(`data/nankan/entries.${key}.json`, d);
  ent[key] = { track: d.track, days: d.days, entries: d.entries };
  ent.meta = d.meta;
  console.error(`${JA[key] || key}: ${done} レースに印（ロジット${done - noModel} / シミュレータ${noModel} / うちオッズ合成 ${blendN}${reused ? ` / 位置取り再利用 ${reused}` : ''}）`);
}
/* 実測（日別の集計と、開催ごとのレース結果）は lib/nkresults.mjs で組む。embed_db.mjs も同じものを埋める */
Object.assign(ent, raceExtras(TRACKS));
inject('race.html', 'NKRACE', 'NKR', ent);

/* index.html にも「本紙予想」の確率を渡す（races.*.json 側にも同じ値を入れる） */
const light = {};
for (const key of TRACKS) {
  const rp = `data/nankan/races.${key}.json`;
  if (!fs.existsSync(path.join(ROOT, rp))) continue;
  const R = readJSON(rp);
  for (const [rk, hs] of Object.entries(R.real)) {
    const src = (ent[key].entries[rk] || []);
    for (const h of hs) {
      const s = src.find(x => x.no === h.no);
      if (s) { h.pWin = s.win; h.pTop3 = s.top3; h.mark = s.mark; }
    }
  }
  writeJSON(rp, R);
  light[key] = { days: R.days, real: R.real };
}
console.error('races.*.json にも本紙予想を書き戻した（index.html は embed_db で反映）');
