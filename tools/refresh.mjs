/* オッズが更新されたら、印・期待値・おすすめ買い目・TOPを作り直して各ページに埋め直し、
   git に commit / push して公開サイトへ反映する。
   watch_odds.mjs がオッズを取り、こちらが「見える形」にして届ける係。
   launchd から数分おきに呼ぶ想定（常駐しない）。

   オッズに変化が無ければ何もしない（毎回1MB書き換えるのは無駄なので）。

   push を止めたいときは NK_REFRESH_NOPUSH=1。
   コミットは生成物だけに限る（tools/ や *.md を巻き込まない）ので、
   作業中でも安全に走らせられる。                                            */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib/nk.mjs';

const STAMP = path.join(ROOT, 'data', 'nankan', '.refresh-stamp');
const watch = ['odds_pre.json', 'odds_live.jsonl'].map(f => path.join(ROOT, 'data/nankan', f));
const sig = watch.map(f => { try { const s = fs.statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return f + ':-'; } }).join('|');
let prev = '';
try { prev = fs.readFileSync(STAMP, 'utf8'); } catch {}
/* 開催中の結果：発走10分後から、終わったレースの結果・払戻を取る（1レース1回。8分おき）。取れたら results.<track>.json を作り直して
   「開催の結果」と日別の成績を日中に更新する。夜の nightly_results と同じ取得スクリプトなので二重にはならない（取得済みは飛ばす） */
const RSTAMP = path.join(ROOT, 'data', 'nankan', '.results-stamp');
let rAge = Infinity;
try { rAge = (Date.now() - fs.statSync(RSTAMP).mtimeMs) / 60000; } catch {}
let resultsChanged = false;
if (rAge > 8 || process.env.NK_REFRESH_FORCE) {
  const today = new Date().toLocaleDateString('sv-SE');
  const before = (() => { try { return fs.statSync(path.join(ROOT, 'data/nankan/results.jsonl')).size; } catch { return 0; } })();
  const envR = { NK_BT_FROM: today, NK_BT_TO: today, NK_RES_AFTER_POST: '10' };
  run2('fetch_results.mjs', envR); run2('fetch_payouts.mjs', envR);
  fs.writeFileSync(RSTAMP, String(Date.now()));
  const after = (() => { try { return fs.statSync(path.join(ROOT, 'data/nankan/results.jsonl')).size; } catch { return 0; } })();
  if (after !== before) { resultsChanged = true; run2('build_results.mjs'); }
}
if (sig === prev && !resultsChanged && !process.env.NK_REFRESH_FORCE) { process.exit(0); }
function run2(script, env) {
  try { execFileSync(process.execPath, [path.join(ROOT, 'tools', script)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } }); return true; }
  catch (e) { console.error(`! ${script} 失敗: ${String(e.stderr || e.message).split('\n').slice(-3).join(' ')}`); return false; }
}

const run = (script, env) => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', script)],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
    return true;
  } catch (e) {
    console.error(`! ${script} 失敗: ${String(e.stderr || e.message).split('\n').slice(-3).join(' ')}`);
    return false;
  }
};
const t0 = Date.now();
// 位置取りは馬場条件が変わらなければ同じなので、オッズ更新時は使い回す
if (!run('build_marks.mjs', { NK_MARK_FAST: '1' })) process.exit(1);
if (!run('build_top.mjs')) process.exit(1);     // TOP の要約
if (!run('embed_db.mjs')) process.exit(1);      // 各ページに埋め込み
fs.writeFileSync(STAMP, sig);
const secs = ((Date.now() - t0) / 1000).toFixed(0);

/* --- 公開サイトへ反映（生成物だけを commit / push）--- */
const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const stamp = new Date().toLocaleString('ja-JP', { hour12: false }).replace(/\//g, '-');
if (process.env.NK_REFRESH_NOPUSH) {
  console.error(`${stamp} 反映完了（${secs}秒・push なし）`);
  process.exit(0);
}
/* 対象は生成物のみ。手で編集中のコードや文書は絶対に巻き込まない */
const TARGETS = ['sim.html', 'race.html', 'top.html', 'data.html', 'marks.html',
  ...['oi', 'kawasaki', 'funabashi', 'urawa'].flatMap(k => [`data/nankan/entries.${k}.json`, `data/nankan/races.${k}.json`, `data/nankan/results.${k}.json`]),
  'data/nankan/results.jsonl', 'data/nankan/payouts.jsonl',
  'data/nankan/top.json', 'data/nankan/odds_pre.json', 'data/nankan/odds_live.jsonl'];
try {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') { console.error(`${stamp} 反映完了（${secs}秒）／ブランチが ${branch} なので push しません`); process.exit(0); }
  const exists = TARGETS.filter(f => fs.existsSync(path.join(ROOT, f)));
  git(['add', '--', ...exists]);
  const staged = git(['diff', '--cached', '--name-only']);
  if (!staged) { console.error(`${stamp} 反映完了（${secs}秒）／内容に差分なし`); process.exit(0); }
  const n = staged.split('\n').length;
  /* **パスを明示して commit する。** 引数なしだと索引にある他のファイル（手作業の途中のコードなど）まで
     巻き込んで公開してしまう（2026-09-24 に実際に起きた）。ここは生成物だけを出す約束 */
  git(['commit', '-q', '-m', `chore(odds): ${stamp} 時点のオッズを反映`,
    '-m', 'tools/refresh.mjs による自動コミット（オッズ更新 → 印・期待値・買い目・TOPの再生成）', '--', ...exists]);
  /* push はしない。publish.mjs（launchd 15分おき）がまとめて押す＝Render のデプロイ回数を抑える。NK_PUSH_NOW=1 でその場で push */
  if (process.env.NK_PUSH_NOW) { try { git(['push', 'origin', 'main']); } catch { git(['fetch', '-q', 'origin', 'main']); git(['rebase', '-q', '--autostash', 'origin/main']); git(['push', 'origin', 'main']); } }
  console.error(`${stamp} 反映＋commit 完了（${secs}秒・${n}ファイル${process.env.NK_PUSH_NOW ? '・push' : '・push は publish'}）`);
} catch (e) {
  const msg = String(e.stderr || e.stdout || e.message).split('\n').filter(Boolean).slice(-2).join(' ');
  console.error(`${stamp} 反映は完了（${secs}秒）が git で失敗: ${msg}`);
  process.exit(1);
}
