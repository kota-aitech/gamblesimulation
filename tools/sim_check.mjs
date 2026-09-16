/* index.html のセクション0〜5（データとシミュレーション本体）だけを切り出して
   Node で動かし、脚質の位置取りと人的要因の効き方を確認する。
   使い方: node tools/sim_check.mjs [oi|kawasaki|funabashi|urawa]                          */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './lib/nk.mjs';

const track = process.argv[2] || 'oi';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const cut = js.indexOf('   6. 3Dシーン');
const src = js.slice(0, js.lastIndexOf('/* ====', cut));

const ctx = vm.createContext({ location: { search: '?track=' + track }, URLSearchParams, Math, JSON, console, document: { getElementById: () => ({ style: {}, dataset: {} }) } });
vm.runInContext(src + '\nglobalThis.__X={DAYS,REAL,DAYS_OI,DAYS_KW,monteCarlo,simRace,paceOf,STYLE,TRACKS,NKMETA};', ctx);
const { DAYS, REAL, monteCarlo, paceOf, STYLE, TRACKS } = ctx.__X;
const dayKey = Object.keys(DAYS)[0];
console.log(`== ${TRACKS[track].name} ${dayKey}`);

let checked = 0;
for (const [i, r] of DAYS[dayKey].entries()) {
  const real = REAL[dayKey + '|' + r.r];
  if (!real) { console.log(`${r.r}R  実出走馬なし`); continue; }
  if (real.length !== r.n) console.log(`  ! ${r.r}R 頭数不一致 番組${r.n} / データ${real.length}`);
  checked++;
}
console.log(`実データ ${checked}/${DAYS[dayKey].length} レース`);

/* 代表レースで人的要因の効きを比べる */
const key = Object.keys(REAL).find(k => k.startsWith(dayKey) && REAL[k].length >= 10);
/* 開催の谷間で実データが無い場は、サンプルの1レースしか無いので人的要因の比較は飛ばす（異常ではない） */
if (!key) { console.log('実出走馬のあるレースが無い（次の開催まで出馬表なし）。人的要因の比較は省略'); process.exit(0); }
const rr = DAYS[dayKey].find(x => x.r === Number(key.split('|')[1]));
const race = { ...rr, horses: REAL[key].map(h => ({ ...h })) };
const base = { baba: '良', weather: '曇', wind: 0, front: 0.45, out: 0.3, recent: 0.6, human: 0 };
const run = human => monteCarlo(race, { ...base, human }, 400);
const a = run(0), b = run(1), c = run(2);
console.log(`\n${key}  ${race.dist}m ${race.horses.length}頭  ペース ${a.pace.label}`);
console.log('馬                 hIdx   人0%   人1%   人2%   3角(人1)');
race.horses.map((h, i) => ({ h, i }))
  .sort((x, y) => b.win[y.i] - b.win[x.i])
  .forEach(({ h, i }) => console.log(
    `${(h.no + ' ' + h.name).padEnd(18)} ${String(h.hIdx ?? '—').padStart(5)} ${(a.win[i] * 100).toFixed(1).padStart(5)} ${(b.win[i] * 100).toFixed(1).padStart(6)} ${(c.win[i] * 100).toFixed(1).padStart(6)}   ${b.c3[i].toFixed(1)}`));

/* 全レース集計：3角の平均位置と、脚質別の勝率（前残り馬場 / 差し馬場） */
function sweep(front) {
  const agg = {}, win = {};
  for (const rr2 of DAYS[dayKey]) {
    const hs = REAL[dayKey + '|' + rr2.r];
    if (!hs) continue;
    const mc = monteCarlo({ ...rr2, horses: hs.map(h => ({ ...h })) }, { ...base, front, human: 1 }, 200);
    hs.forEach((h, i) => {
      (agg[h.style] ||= [0, 0])[0] += mc.c3[i]; agg[h.style][1]++;
      (win[h.style] ||= [0, 0])[0] += mc.win[i]; win[h.style][1]++;
    });
  }
  return { agg, win };
}
const A = sweep(0.45), B2 = sweep(-0.5);
console.log('\n全レース集計（人1.0）  ' + dayKey);
console.log('脚質   頭数  3角平均  勝率(前残り +0.45)  勝率(差し馬場 -0.5)');
for (const st of ['逃げ', '先行', '差し', '追込']) {
  if (!A.agg[st]) continue;
  const n = A.agg[st][1];
  console.log(`${st}  ${String(n).padStart(4)}  ${(A.agg[st][0] / n).toFixed(2).padStart(6)}   ${(A.win[st][0] / n * 100).toFixed(1).padStart(16)}%  ${(B2.win[st][0] / n * 100).toFixed(1).padStart(16)}%`);
}
