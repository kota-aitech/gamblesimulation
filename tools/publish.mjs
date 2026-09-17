/* 公開係。各反映ジョブ（refresh / refresh_boat / refresh_jra / refresh_banei / nightly_results）はローカルに commit するだけにして、
   push はここが launchd（com.nankan.publish、15分おき）でまとめて行う。
   Render は push のたびにデプロイするので、1日600回 push していた頃はデプロイ回数（パイプライン分数）で止まった（2026-09-16）。
   これで多くても 1日96回。もっと減らすなら plist の StartInterval を伸ばす。
     NK_PUSH_NOW=1 を各ジョブに渡すと従来どおりその場で push する（手元確認用） */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'data', '.publish.lock');
const stamp = () => new Date().toLocaleString('ja-JP', { hour12: false }).replace(/\//g, '-');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitRetry = (args, n = 4) => {
  for (let i = 0; ; i++) {
    try { return git(args); }
    catch (e) { const m = String(e.stderr || e.message); if (i >= n - 1 || !/index\.lock|Another git process/.test(m)) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); }
  }
};
if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 10 * 60000) { console.error(`${stamp()} 前の publish がまだ動いている`); process.exit(0); }
fs.writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch { } });
try {
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') { process.exit(0); }
  const ahead = Number(git(['rev-list', '--count', 'origin/main..main']) || 0);
  if (!ahead) process.exit(0);                       // 出すものがない（静かに終わる）
  try { gitRetry(['push', 'origin', 'main']); }
  catch {
    /* 弾かれたらリモートを正として rebase して押し直す。作業中の未コミット変更は autostash で退避 */
    git(['fetch', '-q', 'origin', 'main']);
    gitRetry(['rebase', '-q', '--autostash', 'origin/main']);
    gitRetry(['push', 'origin', 'main']);
  }
  console.error(`${stamp()} push 完了（${ahead} コミット）`);
} catch (e) {
  console.error(`${stamp()} push 失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ')}`);
  process.exit(1);
}
