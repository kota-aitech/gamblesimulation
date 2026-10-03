/* 外から自分を殺す見張り（2026-10-03 追加）。
   setTimeout(process.exit) の見張りでは救えない固まり方がある：Node 24 の process.exit が
   後片付け（NodePlatform::Shutdown → ワーカースレッドの join）で、GC 待ちのワーカーと
   デッドロックして**終わらないまま居座る**。実際に refresh_banei が 21時間止まった（CPU 0・子プロセスなし）。
   JS はもう動かないので、別プロセス（sh）が時間切れに SIGKILL する。
   本体が先に終われば sh は sleep のまま残るだけで、kill は「同じ PID がまだ同じスクリプト」のときだけ打つ。 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export function watchdog(minutes, script = process.argv[1]) {
  const secs = Math.max(60, Math.round(minutes * 60));
  const pid = process.pid, name = path.basename(script || '').replace(/'/g, '');
  const cmd = `sleep ${secs}; ps -p ${pid} -o command= 2>/dev/null | grep -q '${name}' && kill -9 ${pid}`;
  try { spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref(); } catch { }
}
