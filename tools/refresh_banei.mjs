/* ばんえい版の反映係。launchd（com.banei.refresh）から15分おきに呼ぶ想定（常駐しない）。
   1) 出馬表（今日〜3日後）を取り直し、モデルを当てて banei.html / TOP に埋めて commit / push
      （馬体重・オッズは当日に入る。馬場水分は当日メニューに出る。joint はオッズが出たレースから効く）
   2) 21:30 以降に1日1回、今日の結果を取り込んで指数（index.json）と日別成績を作り直す
   3) 月曜の夜に1回、モデルを当てはめ直す（banei_fit → banei_backtest）
   banei_fetch.mjs の長い取得が走っている間は keiba.go.jp を二重に叩かないよう何もしない。
     NK_REFRESH_NOPUSH=1 … push しない
     NK_REFRESH_FORCE=1  … 出馬表を取り直して必ず作り直す */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { ROOT, ymdOf } from './lib/bn.mjs';

const D = path.join(ROOT, 'data', 'banei');
const now = new Date();
const today = ymdOf(now);
const stamp = () => new Date().toLocaleString('ja-JP', { hour12: false }).replace(/\//g, '-');
const run = (script, env = {}) => {
  try { execFileSync(process.execPath, ['--max-old-space-size=4000', path.join(ROOT, 'tools', script)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } }); return true; }
  catch (e) { console.error(`! ${script} 失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-3).join(' ')}`); return false; }
};
try { const ps = execSync('pgrep -f "tools/banei_fetch.mjs"', { encoding: 'utf8' }).trim(); if (ps && !process.env.NK_REFRESH_FORCE) { console.error(`${stamp()} banei_fetch が動作中なので見送り`); process.exit(0); } } catch { }
if (!fs.existsSync(path.join(D, 'model.json'))) { console.error(`${stamp()} model.json がまだ無い（banei_fit.mjs を先に）`); process.exit(0); }

const cardsFile = path.join(D, 'cards.jsonl');
const hasUpcoming = () => fs.existsSync(cardsFile) && fs.readFileSync(cardsFile, 'utf8').split('\n').some(l => { const m = l.match(/^\{"raceId":"(\d{8})/); return m && m[1] >= today; });
const dow = now.getDay(), hour = now.getHours();
const stampFile = path.join(D, '.refresh-stamp');
let prev = {}; try { prev = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { }
const addDays = (ymd, n) => { const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00`); d.setDate(d.getDate() + n); return ymdOf(d); };

let changed = false;
/* 1) 出馬表：今日〜3日後（出馬表は前日に出る。開催のない日は月別日程で空になり、何も取らない） */
const before = fs.existsSync(cardsFile) ? fs.statSync(cardsFile).size : 0;
if (run('banei_fetch.mjs', { BN_FROM: today, BN_TO: addDays(today, 3), BN_KIND: 'cards', BN_REFETCH: '1' })) {
  const after = fs.existsSync(cardsFile) ? fs.statSync(cardsFile).size : 0;
  if (after !== before || process.env.NK_REFRESH_FORCE) changed = true;
}
/* 2) 結果と指数：21:30 以降に1日1回（最終レースは 20:40 ごろ） */
if ((hour > 21 || (hour === 21 && now.getMinutes() >= 30)) && prev.resultsDay !== today) {
  if (run('banei_fetch.mjs', { BN_FROM: addDays(today, -2), BN_TO: today, BN_KIND: 'results' })) { prev.resultsDay = today; run('banei_build_db.mjs'); changed = true; }
}
/* 3) 週1回（月曜 22時以降）モデルを当てはめ直す */
if (dow === 1 && hour >= 22 && prev.fitWeek !== today) {
  if (run('banei_fit.mjs')) { run('banei_backtest.mjs'); prev.fitWeek = today; changed = true; }
}
fs.writeFileSync(stampFile, JSON.stringify(prev));
if (!changed && !hasUpcoming()) process.exit(0);
if (!changed && prev.builtAt && Date.now() - prev.builtAt < 6 * 3600000) process.exit(0);

const t0 = Date.now();
run('banei_build_results.mjs');
if (!run('banei_build_races.mjs')) process.exit(1);
if (!run('embed_db.mjs', { NK_EMBED_ONLY: 'banei' })) process.exit(1);
prev.builtAt = Date.now(); fs.writeFileSync(stampFile, JSON.stringify(prev));
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (process.env.NK_REFRESH_NOPUSH) { console.error(`${stamp()} 反映完了（${secs}秒・push なし）`); process.exit(0); }

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TARGETS = ['banei.html', 'top.html', 'data/banei/races.json', 'data/banei/top.json', 'data/banei/index.json', 'data/banei/model.json', 'data/banei/backtest.json', 'data/banei/preds.jsonl', 'data/banei/results.json'];
try {
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') { console.error(`${stamp()} main ではないので push しない`); process.exit(0); }
  git(['add', '--', ...TARGETS.filter(f => fs.existsSync(path.join(ROOT, f)))]);
  const staged = git(['diff', '--cached', '--name-only']);
  if (!staged) { console.error(`${stamp()} 反映完了（${secs}秒）／差分なし`); process.exit(0); }
  git(['commit', '-q', '-m', `chore(banei): ${stamp()} 時点の出馬表と予想を反映`, '-m', 'tools/refresh_banei.mjs による自動コミット']);
  /* push はしない。publish.mjs（launchd 15分おき）がまとめて押す＝Render のデプロイ回数を抑える。NK_PUSH_NOW=1 でその場で push */
  if (process.env.NK_PUSH_NOW) { try { git(['push', 'origin', 'main']); } catch { git(['fetch', '-q', 'origin', 'main']); git(['rebase', '-q', '--autostash', 'origin/main']); git(['push', 'origin', 'main']); } }
  console.error(`${stamp()} 反映＋commit 完了（${secs}秒・${staged.split('\n').length}ファイル）`);
} catch (e) {
  console.error(`${stamp()} git で失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ')}`);
  process.exit(1);
}
