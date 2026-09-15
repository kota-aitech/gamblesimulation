/* 記録した予想（preds.jsonl）と成績（results.jsonl の K）を突き合わせ、
   日別・場別の的中率と回収率を出す → data/boat/results.json
   南関の build_results.mjs と同じ考え方：予想は締切が過ぎた時点で記録したものを使い、
   後から作り直さない。買い方は backtest_boat.mjs と同じ（1点100円）。
     ◎単勝 / ◎複勝 / ◎○2連単 / ◎○2連複 / 本命3艇BOX 3連複(1点) / 本命3艇BOX 3連単(6点) / 本命4艇BOX 3連複(4点)
     基準：1号艇の単勝・複勝
   K は開催中に途中まで公開されるので、日中は「ここまでのレース」で更新されていく。
     BT_REC_DAYS … 何日ぶんを載せるか（既定 30） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON, VNAME } from './lib/bt.mjs';
import { BETS, mk, settle, merge, fin } from './lib/bsettle.mjs';

const DAYS = Number(process.env.BT_REC_DAYS || 30);
const PREDS = path.join(ROOT, 'data/boat/preds.jsonl');
if (!fs.existsSync(PREDS)) { console.error('preds.jsonl がまだ無い（締切が過ぎたレースを build_boat が記録する）'); process.exit(0); }

const preds = new Map();
for (const l of fs.readFileSync(PREDS, 'utf8').split('\n')) if (l) { try { const o = JSON.parse(l); preds.set(`${o.date}|${o.jcd}|${o.r}`, o); } catch { } }
const dates = [...new Set([...preds.values()].map(o => o.date))].sort().slice(-DAYS);
const want = new Set(dates);

/* 成績は対象日の行だけ読む（222MB を JSON.parse しない） */
const K = new Map();
for (const line of fs.readFileSync(path.join(ROOT, 'data/boat/results.jsonl'), 'utf8').split('\n')) {
  const m = line.match(/^\{"date":"(\d{8})","jcd":"(\d\d)"/);
  if (!m || !want.has(m[1])) continue;
  const o = JSON.parse(line);
  K.set(`${o.date}|${o.jcd}|${o.r}`, o);
}

/* 精算の式は lib/bsettle.mjs（build_boat.mjs の「節間の結果」と共用） */
const out = { built: new Date().toISOString(), bets: BETS, days: [], total: null };
const TOTAL = mk();
let matched = 0, pending = 0;
for (const date of dates) {
  const byV = new Map();
  const DAY = mk();
  for (const p of preds.values()) {
    if (p.date !== date) continue;
    const k = K.get(`${p.date}|${p.jcd}|${p.r}`);
    if (!k) { pending++; continue; }
    const S = settle(p, k);
    if (!S) { pending++; continue; }
    matched++;
    let V = byV.get(p.jcd); if (!V) byV.set(p.jcd, V = { S: mk(), preds: 0, late: 0 });
    merge(V.S, S); merge(DAY, S); merge(TOTAL, S);
    V.preds++; if (p.late > 30) V.late++;
  }
  const venues = [...byV.keys()].sort().map(jcd => ({ jcd, name: VNAME[jcd], late: byV.get(jcd).late, ...fin(byV.get(jcd).S) }));
  out.days.push({ date, venues, ...fin(DAY) });
}
out.total = fin(TOTAL);
out.note = `予想は締切後に記録したもの（late＝締切30分以上あとに記録したレース数。モデルはオッズを使わないので中身は同じ）。成績は公式ダウンロードデータ（K）。`;
writeJSON('data/boat/results.json', out);
const T = out.total;
console.error(`${dates.length}日 ${matched}R を精算（未確定 ${pending}R）。◎的中 ${T.hit1 != null ? (T.hit1 * 100).toFixed(1) : '—'}%／◎単勝 回収 ${T.bets['◎単勝'].roi != null ? (T.bets['◎単勝'].roi * 100).toFixed(1) : '—'}%／3艇BOX3連複 ${T.bets['3艇BOX3連複'].roi != null ? (T.bets['3艇BOX3連複'].roi * 100).toFixed(1) : '—'}% -> data/boat/results.json`);
