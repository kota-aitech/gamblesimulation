/* 凱旋門賞の週末の反映係（launchd: com.arc.refresh、10分おき）。
     arc_meet_fetch（PMU：出馬表・オッズ・結果・払戻・ペネトロメーター）→ arc_fetch（JRA 特設・天気。各ページの TTL で間引く）
     → arc_build（arc.html）→ arc_meet_build（longchamp.html）→ 生成物だけ commit（push は publish.mjs）
   凱旋門賞の翌々日（ARC_DAY+2）を過ぎたら何もしない。 */
process.env.TZ = 'Asia/Tokyo';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchdog } from './lib/watchdog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = () => new Date().toLocaleString('ja-JP', { hour12: false });
const JOB = Number(process.env.NK_JOB_TIMEOUT || 25);
setTimeout(() => { console.error(`${stamp()} 時間切れで打ち切り`); process.exit(0); }, JOB * 60000).unref();
watchdog(JOB + 5);
const DAY = process.env.ARC_DAY || '2026-10-04';
if (Date.now() > Date.parse(DAY + 'T00:00:00+09:00') + 3 * 86400000 && !process.env.NK_REFRESH_FORCE) process.exit(0);

const run = (script, env = {}) => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'tools', script)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env }, timeout: 15 * 60000, killSignal: 'SIGKILL' }); return true; }
  catch (e) { console.error(`${stamp()} ! ${script} 失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-3).join(' ')}`); return false; }
};
run('arc_meet_fetch.mjs', { ARC_HIST: '0' });
run('arc_fetch.mjs');
run('arc_build.mjs');
if (!run('arc_meet_build.mjs')) process.exit(1);
if (process.env.NK_REFRESH_NOPUSH) { console.error(`${stamp()} 反映完了（commit なし）`); process.exit(0); }

const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TARGETS = ['arc.html', 'longchamp.html', 'data/arc/analysis.json', 'data/arc/meet.json'].filter(f => fs.existsSync(path.join(ROOT, f)));
try {
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') process.exit(0);
  git(['add', '--', ...TARGETS]);
  const staged = git(['diff', '--cached', '--name-only', '--', ...TARGETS]);
  if (!staged) process.exit(0);
  /* パスを明示（索引にある作業中のファイルを巻き込まない） */
  git(['commit', '-q', '-m', `chore(arc): ${stamp()} 時点のロンシャンの出馬表・結果・馬場を反映`, '-m', 'tools/refresh_arc.mjs による自動コミット', '--', ...TARGETS]);
  console.error(`${stamp()} 反映＋commit 完了（${staged.split('\n').length}ファイル）`);
} catch (e) { console.error(`${stamp()} git で失敗: ${String(e.stderr || e.message).split('\n').slice(-2).join(' ')}`); process.exit(1); }
