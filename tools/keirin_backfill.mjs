/* 競輪の過去データの取り込み（遡り）を launchd から少しずつ進める係（com.keirin.backfill、5分おき）。
   以前はシェルから nohup で1本走らせていたが、ログアウト・再起動・スリープで止まると手で起こし直す必要があった。
   ここは毎回「持っている最も古い日」から KR_BACKFILL_FROM（既定 20240101）へ向かって、keirin_fetch を
   KR_YIELD=1（反映係が動いている間は通信を止めて譲る）で最大 KR_BACKFILL_MINUTES 分（既定 25）だけ回す。
   取得済みのレースはキャッシュと races.jsonl から飛ばすので、途中で切れても次の回が続きから進む。
   別の keirin_fetch（手で回した長い取り込み）が動いていれば何もしない。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { ROOT, ymdOf, addDays, eachLine } from './lib/kr.mjs';

const FROM = process.env.KR_BACKFILL_FROM || '20240101';
const MIN = Number(process.env.KR_BACKFILL_MINUTES || 25);
const stamp = () => new Date().toLocaleString('ja-JP', { hour12: false });
setTimeout(() => { console.error(`${stamp()} 時間切れで打ち切り`); process.exit(0); }, (MIN + 3) * 60000).unref();

try {
  const ps = execSync('ps -ax -o command', { encoding: 'utf8' }).split('\n').filter(l => /tools\/keirin_fetch\.mjs/.test(l));
  if (ps.length) { console.error(`${stamp()} keirin_fetch が動作中なので見送り`); process.exit(0); }
} catch { }
/* 持っている最も古い日（結果つき） */
let oldest = null;
const rf = path.join(ROOT, 'data/keirin/races.jsonl');
eachLine(rf, l => { const m = l.match(/"date":"(\d{8})"/); if (m && /"result":\{/.test(l) && (!oldest || m[1] < oldest)) oldest = m[1]; });
if (oldest && oldest <= FROM) { console.error(`${stamp()} ${FROM} まで取り込み済み（最古 ${oldest}）`); process.exit(0); }
/* 途中で切れた日を取りこぼさないよう、最古の日の2日後から遡る */
const to = oldest ? addDays(oldest, 2) : ymdOf(new Date());
console.error(`${stamp()} ${to} から ${FROM} へ遡る（最大 ${MIN}分）`);
try {
  execFileSync(process.execPath, ['--max-old-space-size=3000', path.join(ROOT, 'tools/keirin_fetch.mjs')], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: MIN * 60000, killSignal: 'SIGTERM',
    env: { ...process.env, KR_YIELD: '1', KR_FROM: FROM, KR_TO: to, KR_ORDER: 'desc' },
  });
} catch (e) {
  /* 時間切れ（SIGTERM）は想定どおり。keirin_fetch は SIGTERM で溜めた分を書き出してから終わる */
  if (e.signal !== 'SIGTERM') console.error(`${stamp()} ! ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ')}`);
}
let now = null;
eachLine(rf, l => { const m = l.match(/"date":"(\d{8})"/); if (m && /"result":\{/.test(l) && (!now || m[1] < now)) now = m[1]; });
console.error(`${stamp()} 最古の日 ${oldest} → ${now}`);
