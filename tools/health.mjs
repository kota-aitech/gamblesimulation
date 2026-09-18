/* 自動取得が動いているかの点検（ブラウザ不要・依存ゼロ）
     node tools/health.mjs
   見るもの
     1. launchd の各ジョブが読み込まれているか・前回の終了コード
     2. それぞれのログが最後に書かれた時刻（＝最後に「何かした」時刻）
     3. **スリープで止まっていた時間**（pmset の記録から10分以上の空白を拾う）
     4. 公開（push）の遅れ
   ジョブは変化が無いと何も書かないものがあるので、ログが古い＝止まっている とは限らない。
   スリープの空白と突き合わせて読む。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { return String(e.stdout || ''); } };
const ago = ms => ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)}秒前` : ms < 3600000 ? `${Math.round(ms / 60000)}分前` : `${(ms / 3600000).toFixed(1)}時間前`;
const JOBS = [
  ['com.nankan.oddswatch', 60, 'data/nankan/oddswatch.log', '南関のオッズ（締切前・暫定）'],
  ['com.nankan.refresh', 120, 'data/nankan/refresh.log', '南関の反映'],
  ['com.nankan.results', 86400, 'data/nankan/results.log', '南関の結果（21:20/23:00/6:30）'],
  ['com.boat.live', 60, 'data/boat/live.log', 'ボートの直前情報・オッズ・結果'],
  ['com.boat.refresh', 180, 'data/boat/refresh.log', 'ボートの反映'],
  ['com.jra.refresh', 1200, 'data/jra/refresh.log', '中央の取得と反映'],
  ['com.banei.refresh', 900, 'data/banei/refresh.log', 'ばんえいの取得と反映'],
  ['com.nankan.publish', 900, 'data/publish.log', '公開（GitHub へ push）'],
];
const listed = sh('launchctl', ['list']);
const now = Date.now();
console.log(`点検 ${new Date().toLocaleString('ja-JP', { hour12: false })}\n`);
console.log('ジョブ                     状態      前回の書き込み   間隔   中身');
for (const [label, sec, rel, name] of JOBS) {
  const line = listed.split('\n').find(l => l.endsWith('\t' + label) || l.split('\t')[2] === label);
  const exit = line ? line.split('\t')[1] : null;
  const f = path.join(ROOT, rel);
  const m = fs.existsSync(f) ? fs.statSync(f).mtimeMs : null;
  const state = !line ? '未登録' : exit !== '0' ? `前回失敗(${exit})` : '登録済み';
  console.log(`${label.padEnd(24)} ${state.padEnd(9)} ${ago(m ? now - m : null).padEnd(14)} ${String(sec).padStart(5)}秒  ${name}`);
}
/* スリープの空白（10分以上） */
const log = sh('pmset', ['-g', 'log']);
const ev = [];
for (const l of log.split('\n')) {
  const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) [+-]\d{4}\s+(Sleep|Wake|DarkWake)\s+\t/);   // 「Wake Requests」など別の行を拾わないよう、列の区切り（タブ）まで見る
  if (m) ev.push([Date.parse(m[1].replace(' ', 'T') + '+09:00'), m[2]]);
}
const gaps = [];
for (let i = 0; i < ev.length - 1; i++) {
  if (ev[i][1] !== 'Sleep') continue;
  let j = i + 1; while (j < ev.length && ev[j][1] !== 'Wake') j++;   // DarkWake ではジョブは動かない
  if (j >= ev.length) break;
  const min = (ev[j][0] - ev[i][0]) / 60000;
  if (min >= 10 && now - ev[j][0] < 7 * 86400000) gaps.push([ev[i][0], ev[j][0], min]);
  i = j;
}
console.log('\nスリープで止まっていた時間（直近1週間・10分以上。フタを閉じると必ずここに出る）');
if (!gaps.length) console.log('  なし');
for (const [a, b, min] of gaps.slice(-12)) {
  const f = t => new Date(t).toLocaleString('ja-JP', { hour12: false }).replace(/^\d+-/, '');
  console.log(`  ${f(a)} → ${f(b)}  ${Math.round(min)}分`);
}
const tot = gaps.filter(g => now - g[1] < 86400000).reduce((a, g) => a + g[2], 0);
console.log(`  直近24時間の停止合計 ${Math.round(tot)}分`);
console.log('  ※ フタを閉じたまま動かすには sudo sh tools/launchd/nosleep.sh on（電源接続中だけ寝なくなる）');
/* 公開の遅れ */
const ahead = sh('git', ['-C', ROOT, 'rev-list', '--count', 'origin/main..main']).trim();
const pl = path.join(ROOT, 'data/publish.log');
const last = fs.existsSync(pl) ? fs.readFileSync(pl, 'utf8').trim().split('\n').filter(l => /push 完了/.test(l)).pop() : null;
console.log(`\n公開  未 push ${ahead || 0} コミット／最後の push: ${last || '—'}`);
