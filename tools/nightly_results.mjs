/* 南関の「その日の結果」を夜に取り込み、日別の成績を作り直して公開する。あわせて翌日以降の出馬表も取り込む。
   launchd（com.nankan.results）が 21:20 / 23:00 / 翌 06:30 に呼ぶ想定（常駐しない）。
   昨日〜今日の開催を対象にするので、1回目で取り切れなくても次の回で拾える。
   出馬表は前日の夕方に出るので、21:20 の回で翌日ぶんが入り、06:30 の回で取り漏れを拾う。

     fetch_payouts → fetch_results → fetch_odds（最終オッズ）→ build_results
     → fetch_cards（今月）→ fetch_trend → build_trend → build_races → build_browse → embed_db → build_marks
     → build_top → embed_db → commit / push

     NK_BT_TRACKS      … 対象の場（既定 大井,川崎）
     NK_REFRESH_NOPUSH … push しない（手元確認用）
   結果ページも印も、取り込んだ後の予想は作り直さない（記録済みの予想で精算する）。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib/nk.mjs';

const ymd = d => d.toLocaleDateString('sv-SE');
const today = new Date(), yest = new Date(today); yest.setDate(yest.getDate() - 1);
const env = { NK_BT_TRACKS: process.env.NK_BT_TRACKS || '大井,川崎', NK_BT_FROM: ymd(yest), NK_BT_TO: ymd(today) };
const stamp = () => new Date().toLocaleString('ja-JP', { hour12: false }).replace(/\//g, '-');

const run = (script, extra = {}) => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', script)],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env, ...extra } });
    void out;
    return true;
  } catch (e) {
    console.error(`! ${script} 失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-3).join(' ')}`);
    return false;
  }
};
const t0 = Date.now();
console.error(`${stamp()} 結果取得 ${env.NK_BT_TRACKS} ${env.NK_BT_FROM}〜${env.NK_BT_TO}`);
run('fetch_payouts.mjs');
run('fetch_results.mjs');
run('fetch_odds.mjs');
if (!run('build_results.mjs')) process.exit(1);
/* 出馬表の取り込み（今月ぶん。取得済みはキャッシュ、新しい開催日だけ増える）→ 傾向 → 番組・出走馬 → データブラウザ → 埋め込み → 印 */
const ym = ymd(today).slice(0, 7).replace('-', '');
if (run('fetch_cards.mjs', { NK_FROM: ym, NK_TO: ym })) {
  run('fetch_trend.mjs'); run('build_trend.mjs');
  if (run('build_races.mjs')) { run('build_browse.mjs'); run('embed_db.mjs'); run('build_marks.mjs'); }
}
if (!run('build_top.mjs')) process.exit(1);
if (!run('embed_db.mjs')) process.exit(1);
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (process.env.NK_REFRESH_NOPUSH) { console.error(`${stamp()} 取り込み完了（${secs}秒・push なし）`); process.exit(0); }

/* --- 公開（生成物と取り込んだ生データだけを commit / push）--- */
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TARGETS = ['index.html', 'race.html', 'top.html', 'data.html', 'marks.html', 'boat.html',
  'data/nankan/results.jsonl', 'data/nankan/payouts.jsonl', 'data/nankan/odds.jsonl',
  'data/nankan/results.oi.json', 'data/nankan/results.kawasaki.json', 'data/nankan/top.json',
  'data/nankan/entries.oi.json', 'data/nankan/entries.kawasaki.json', 'data/nankan/races.oi.json', 'data/nankan/races.kawasaki.json',
  'data/nankan/marksrec.json', 'data/nankan/backtest.json',
  'data/nankan/trend.oi.json', 'data/nankan/trend.kawasaki.json', 'data/nankan/meet.oi.json', 'data/nankan/meet.kawasaki.json', 'data/nankan/browse.json'];
try {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') { console.error(`${stamp()} 取り込み完了（${secs}秒）／ブランチが ${branch} なので push しません`); process.exit(0); }
  git(['add', '--', ...TARGETS.filter(f => fs.existsSync(path.join(ROOT, f)))]);
  const staged = git(['diff', '--cached', '--name-only']);
  if (!staged) { console.error(`${stamp()} 取り込み完了（${secs}秒）／差分なし`); process.exit(0); }
  git(['commit', '-q', '-m', `chore(results): ${env.NK_BT_TO} の結果を取り込み`, '-m', 'tools/nightly_results.mjs による自動コミット（結果・払戻・最終オッズ → 日別の成績）']);
  try { git(['push', 'origin', 'main']); }
  catch { git(['fetch', '-q', 'origin', 'main']); git(['rebase', '-q', '--autostash', 'origin/main']); git(['push', 'origin', 'main']); }
  console.error(`${stamp()} 取り込み＋push 完了（${secs}秒・${staged.split('\n').length}ファイル）`);
} catch (e) {
  console.error(`${stamp()} 取り込みは完了（${secs}秒）が git で失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ')}`);
  process.exit(1);
}
