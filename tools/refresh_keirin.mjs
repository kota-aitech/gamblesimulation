/* 競輪版の反映係。launchd（com.keirin.refresh）から10分おきに呼ぶ想定（常駐しない）。
   1) 今日〜明日の出走表・オッズを取り直す（結果の出たレースは二度と取らない。結果の無いレースは30分おき＝KR_STALE）
      開催中（8〜24時）は今日のぶんを毎回見て、締切の近いレースのオッズと終わったレースの結果を拾う
   2) 1日1回、取りこぼしを埋める（持っている最後の日の前日から今日まで。Mac が寝ていて窓を逃しても埋まる）→ 集計（index.json）
   3) 月曜の夜に1回、モデルを当てはめ直す（keirin_fit → keirin_backtest）
   4) 予想を作り直して keirin.html / TOP に埋め込み、生成物だけを commit（push は publish.mjs がまとめて行う）
   keirin_fetch.mjs の長い取り込みが別に走っている間は Kドリームスを二重に叩かないよう何もしない。
     NK_REFRESH_NOPUSH=1 … commit しない
     NK_REFRESH_FORCE=1  … 変化が無くても作り直す */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { ROOT, ymdOf, addDays, PAUSE } from './lib/kr.mjs';

const D = path.join(ROOT, 'data', 'keirin');
const now = new Date();
const today = ymdOf(now);
const stamp = () => new Date().toLocaleString('ja-JP', { hour12: false }).replace(/\//g, '-');
/* 自分自身の見張り（CLAUDE.md「ジョブは必ず時間で打ち切る」）。launchd は前の実行が残っている間は次を起こさない */
setTimeout(() => { console.error(`${stamp()} 時間切れで打ち切り`); process.exit(0); }, Number(process.env.NK_JOB_TIMEOUT || 30) * 60000).unref();
const STEP_TIMEOUT = Number(process.env.NK_STEP_TIMEOUT || 20) * 60000;
const run = (script, env = {}, heap = 4000) => {
  try { execFileSync(process.execPath, [`--max-old-space-size=${heap}`, path.join(ROOT, 'tools', script)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env }, timeout: STEP_TIMEOUT, killSignal: 'SIGKILL' }); return true; }
  catch (e) { console.error(`! ${script} 失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-3).join(' ')}`); return false; }
};
if (!fs.existsSync(path.join(D, 'model.json'))) { console.error(`${stamp()} model.json がまだ無い（keirin_fit.mjs を先に）`); process.exit(0); }
/* 長い取り込み（KR_YIELD=1 で手で回す keirin_fetch）とは .pause で譲り合う：ここが動いている間は向こうが通信を止めて待つ。
   KR_YIELD を付けずに回している取り込みがあれば、二重に叩かないよう見送る */
try {
  const ps = execSync('ps -ax -o command', { encoding: 'utf8' }).split('\n').filter(l => /tools\/keirin_fetch\.mjs/.test(l));
  if (ps.length && !fs.existsSync(path.join(D, '.backfill')) && !process.env.NK_REFRESH_FORCE) { console.error(`${stamp()} keirin_fetch（譲り合いなし）が動作中なので見送り`); process.exit(0); }
} catch { }
fs.writeFileSync(PAUSE, String(process.pid));
const unpause = () => { try { fs.unlinkSync(PAUSE); } catch { } };
process.on('exit', unpause);

const stampFile = path.join(D, '.refresh-stamp');
let prev = {}; try { prev = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { }
const hour = now.getHours(), dow = now.getDay();
const rf = path.join(D, 'races.jsonl');
const size = () => fs.existsSync(rf) ? fs.statSync(rf).size : 0;
let changed = !!process.env.NK_REFRESH_FORCE;

/* 1) 今日〜明日。開催中は毎回（結果の無いレースは KR_STALE 分おきに取り直す）、夜間は1時間に1回 */
const liveHours = hour >= 7 && hour <= 23;
if (liveHours || !prev.cardsAt || Date.now() - prev.cardsAt > 3600000) {
  const b = size();
  if (run('keirin_fetch.mjs', { KR_FROM: today, KR_TO: addDays(today, 1), KR_STALE: liveHours ? '25' : '60' })) { prev.cardsAt = Date.now(); if (size() !== b) changed = true; }
}
/* 2) 取りこぼしを埋める＋集計：1日1回（持っている最後の結果の日から） */
if (prev.fillDay !== today && (hour >= 1 || !prev.fillAt || Date.now() - prev.fillAt > 86400000)) {
  let last = null;
  if (fs.existsSync(rf)) for (const l of fs.readFileSync(rf, 'utf8').split('\n')) { if (!/"result":\{/.test(l)) continue; const m = l.match(/"date":"(\d{8})"/); if (m && (!last || m[1] > last)) last = m[1]; }
  const from = last ? (last < addDays(today, -14) ? addDays(today, -14) : addDays(last, -1)) : addDays(today, -7);
  if (run('keirin_fetch.mjs', { KR_FROM: from, KR_TO: addDays(today, -1) })) { prev.fillDay = today; prev.fillAt = Date.now(); run('keirin_build_db.mjs', {}, 6000); run('keirin_build_venues.mjs', {}, 6000); run('build_guides.mjs', {}, 4000); changed = true; }
}
/* 2b) バンクの形（周長・見なし直線・カント）と、競馬場のコースの形は30日に1回取り直す */
{ const cf = path.join(ROOT, 'data/jra/course.json'); if (!fs.existsSync(cf) || Date.now() - fs.statSync(cf).mtimeMs > 30 * 86400000) run('fetch_course_info.mjs'); }
{ const bf = path.join(D, 'banks.json'); if (!fs.existsSync(bf) || Date.now() - fs.statSync(bf).mtimeMs > 30 * 86400000) run('keirin_fetch_banks.mjs'); }
/* 3) 週1回（月曜 22時以降）モデルを当てはめ直す。
      データを遡って取り込んでいる間（集計のレース数がモデルを作ったときの1.4倍を超えた）は、曜日を待たずに当て直す（1日1回まで） */
let grown = false;
try {
  const ix = JSON.parse(fs.readFileSync(path.join(D, 'index.json'), 'utf8')), md = JSON.parse(fs.readFileSync(path.join(D, 'model.json'), 'utf8'));
  grown = ix.meta.races > 1.4 * ((md.meta.train || 0) + (md.meta.test || 0) + 1) && prev.fitDay !== today;
} catch { }
if (grown) { console.error(`${stamp()} データが増えたのでモデルを当て直す`); if (run('keirin_fit.mjs', {}, 6000)) { run('keirin_backtest.mjs', {}, 6000); run('keirin_build_db.mjs', {}, 6000); prev.fitDay = today; changed = true; } }
if (dow === 1 && hour >= 22 && prev.fitWeek !== today) {
  if (run('keirin_fit.mjs', {}, 6000)) { run('keirin_backtest.mjs', {}, 6000); prev.fitWeek = today; changed = true; }
}
fs.writeFileSync(stampFile, JSON.stringify(prev));
/* 開催時間中は毎回作り直す。予想の記録は「締切10分前〜締切」の窓で行うので、データが変わった時だけにすると
   （結果の無いレースの取り直しは25分おき）窓を逃すレースが出る（2026-09-28 の初日に1時間で5件しか記録できなかった） */
if (hour >= 8 && hour <= 23) changed = true;
if (!changed && prev.builtAt && Date.now() - prev.builtAt < 3 * 3600000) process.exit(0);

const t0 = Date.now();
if (!run('keirin_build_races.mjs', {}, 6000)) process.exit(1);
run('keirin_build_results.mjs');
if (!run('embed_db.mjs', { NK_EMBED_ONLY: 'keirin' })) process.exit(1);
if (!run('keirin_check.mjs')) console.error(`${stamp()} ! keirin_check で問題あり（commit は続ける）`);
prev.builtAt = Date.now(); fs.writeFileSync(stampFile, JSON.stringify(prev));
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (process.env.NK_REFRESH_NOPUSH) { console.error(`${stamp()} 反映完了（${secs}秒・commit なし）`); process.exit(0); }

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TARGETS = ['keirin.html', 'kbank.html', 'data/keirin/venues.json', 'top.html', 'picks.html', 'bbank.html', 'hbank.html', 'kbank.html', 'data/boat/guide.json', 'data/guide_horse.json', 'data/jra/course.json', 'data/nankan/course.json', 'data/banei/course.json', 'data/keirin/banks.json', 'data/keirin/races.json', 'data/keirin/top.json', 'data/keirin/index.json', 'data/keirin/model.json', 'data/keirin/backtest.json', 'data/keirin/preds.jsonl', 'data/keirin/results.json'];
try {
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') { console.error(`${stamp()} main ではないので commit しない`); process.exit(0); }
  const files = TARGETS.filter(f => fs.existsSync(path.join(ROOT, f)));
  git(['add', '--', ...files]);
  const staged = git(['diff', '--cached', '--name-only', '--', ...files]);
  if (!staged) { console.error(`${stamp()} 反映完了（${secs}秒）／差分なし`); process.exit(0); }
  /* パスを明示（索引にある他の作業ファイルを巻き込まないため。CLAUDE.md の「commit は必ずパスを明示する」） */
  git(['commit', '-q', '-m', `chore(keirin): ${stamp()} 時点の出走表と予想を反映`, '-m', 'tools/refresh_keirin.mjs による自動コミット', '--', ...files]);
  console.error(`${stamp()} 反映＋commit 完了（${secs}秒・${staged.split('\n').length}ファイル）`);
} catch (e) {
  console.error(`${stamp()} git で失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ')}`);
  process.exit(1);
}
