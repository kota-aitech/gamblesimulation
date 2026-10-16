/* JRA 版の反映係。launchd（com.jra.refresh）から20分おきに呼ぶ想定（常駐しない）。
   1) 出馬表（今日〜3日後）を取り直し、モデルを当てて jra.html / TOP に埋めて commit / push
      （枠順確定・オッズ・馬体重は金曜〜当日に順次入る。第2段はオッズが出たレースから効く）
   2) 17:30 以降に1日1回、昨日〜今日の結果を取り込んで指数（index.json）を作り直す
   3) 月曜の夜に1回、モデルを当てはめ直す（jra_fit → jra_backtest）
   jra_fetch_results.mjs の長い取得が走っている間は Yahoo を二重に叩かないよう何もしない。
     NK_REFRESH_NOPUSH=1 … push しない
     NK_REFRESH_FORCE=1  … 出馬表を取り直して必ず作り直す */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { ROOT } from './lib/jra.mjs';
import { watchdog } from './lib/watchdog.mjs';

const D = path.join(ROOT, 'data', 'jra');
const now = new Date();
const today = now.toLocaleDateString('sv-SE');
const stamp = () => new Date().toLocaleString('ja-JP', { hour12: false }).replace(/\//g, '-');
/* 子プロセスには必ず実行時間の上限を付ける（NK_STEP_TIMEOUT 分、既定 20）。
   上限が無いと取得が通信待ちで固まったとき親も固まり、**launchd は前の実行が残っている間は次を起こさない**ので
   以後ずっと動かなくなる（2026-09-28 に refresh_banei が9日20時間ハングして居座っていた）。 */
/* **自分自身の見張り**：全体がこの時間を超えたら、道連れにせず自分を終わらせる（NK_JOB_TIMEOUT 分、既定 30）。
   launchd の StartInterval は前の実行が残っている間は次を起こさないので、
   1本ハングすると以後ずっと止まる。子プロセスの上限（STEP_TIMEOUT）で拾えない固まり方への保険。 */
setTimeout(() => { console.error(`${new Date().toLocaleString('ja-JP', { hour12: false })} 時間切れで打ち切り（30分）`); process.exit(0); },
  Number(process.env.NK_JOB_TIMEOUT || 30) * 60000).unref();
/* process.exit そのものが固まると上の見張りは効かない（lib/watchdog.mjs）。外の sh が5分あとに SIGKILL する */
watchdog(Number(process.env.NK_JOB_TIMEOUT || 30) + 5);
const STEP_TIMEOUT = Number(process.env.NK_STEP_TIMEOUT || 20) * 60000;
const run = (script, env = {}) => {
  try { execFileSync(process.execPath, ['--max-old-space-size=4000', path.join(ROOT, 'tools', script)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env }, timeout: STEP_TIMEOUT, killSignal: 'SIGKILL' }); return true; }
  catch (e) { console.error(`! ${script} 失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-3).join(' ')}`); return false; }
};
/* 長い取得が走っていたら何もしない */
try { const ps = execSync('pgrep -f jra_fetch_results.mjs', { encoding: 'utf8' }).trim(); if (ps) { console.error(`${stamp()} jra_fetch_results が動作中なので見送り`); process.exit(0); } } catch { }

/* 直近に開催があるか（cards.jsonl に今日以降のレースがあるか、無ければ取りに行って確かめる） */
const cardsFile = path.join(D, 'cards.jsonl');
const hasUpcoming = () => fs.existsSync(cardsFile) && fs.readFileSync(cardsFile, 'utf8').split('\n').some(l => { const m = l.match(/"date":"(\d{4}-\d{2}-\d{2})"/); return m && m[1] >= today; });
const dow = now.getDay(), hour = now.getHours();
const stampFile = path.join(D, '.refresh-stamp');
let prev = {}; try { prev = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { }

let changed = false;
/* 1) 出馬表：開催が近い日（木〜日）は毎回、それ以外は1日1回 */
const cardsDue = process.env.NK_REFRESH_FORCE || [4, 5, 6, 0].includes(dow) || prev.cardsDay !== today;
if (cardsDue) {
  const before = fs.existsSync(cardsFile) ? fs.statSync(cardsFile).size : 0;
  if (run('jra_fetch_cards.mjs')) { prev.cardsDay = today; const after = fs.statSync(cardsFile).size; if (after !== before || process.env.NK_REFRESH_FORCE) changed = true; }
  /* 出馬表に出てきた新しい馬の血統・馬主（取得済みは飛ばすので数頭〜数十頭）。長い取得が走っていれば見送り */
  let horsesRunning = false; try { horsesRunning = !!execSync('pgrep -f jra_fetch_horses.mjs', { encoding: 'utf8' }).trim(); } catch { }
  if (!horsesRunning) run('jra_fetch_horses.mjs');
}
/* 2) 結果と指数：1日1回（最終レースは 16:30 ごろなので、ふだんは 17 時以降の回で入る）。
   17時の窓を寝て逃し続けても取り込めるよう、**前回から1日以上あいていれば時間帯を問わず**走らせる。
   取得側（jra_fetch_results.mjs）の既定は直近30日なので、数日寝ていても穴は自然に埋まる */
const staleDays = prev.resultsAt ? (Date.now() - prev.resultsAt) / 86400000 : 99;
if (prev.resultsDay !== today && (hour >= 17 || staleDays >= 1)) {
  if (run('jra_fetch_results.mjs')) { prev.resultsDay = today; prev.resultsAt = Date.now(); run('jra_build_db.mjs'); changed = true; }
}
/* 2b) 含水率・クッション値：当日の馬場情報（開催中のみ）と、今年のアーカイブ（開催後の木曜に更新）。1日1回。
   **早期終了より前に置く**こと。あとに置くと「変化なしなら6時間に1回」で飛ばされ、開催日の値を取り逃す */
if (prev.babaDay !== today) {
  if (run('jra_fetch_baba.mjs', { JRA_BABA_FROM: String(new Date().getFullYear()), JRA_BABA_TO: String(new Date().getFullYear()) })) { prev.babaDay = today; changed = true; }
}
/* 3) 週1回（月曜 20時以降）モデルを当てはめ直す */
if (dow === 1 && hour >= 20 && prev.fitWeek !== `${today}`) {
  if (run('jra_fit.mjs', { JRA_FIT_EPOCH: '300' })) { run('jra_backtest.mjs'); run('jra_baba_stats.mjs'); prev.fitWeek = today; changed = true; }
}
fs.writeFileSync(stampFile, JSON.stringify(prev));

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TARGETS = ['jra.html', 'top.html', 'picks.html', 'bbank.html', 'hbank.html', 'kbank.html', 'data/boat/guide.json', 'data/guide_horse.json', 'data/jra/course.json', 'data/nankan/course.json', 'data/banei/course.json', 'data/jra/races.json', 'data/jra/top.json', 'data/jra/index.json', 'data/jra/model.json', 'data/jra/backtest.json', 'data/jra/baba.jsonl', 'data/jra/baba_stats.json',
  'data/jra/preds.jsonl', 'data/jra/results.json', 'data/jra/horses.jsonl'];
/* 作り直して埋め込み、commit する。push は publish.mjs（launchd 15分おき）がまとめて押す。NK_PUSH_NOW=1 でその場で push */
function buildAndCommit(what) {
  const t0 = Date.now();
  run('jra_build_results.mjs');                                   // 記録済みの予想 × 最新の結果（preds が無い初日は何もしない）
  if (!run('jra_build_races.mjs')) return false;
  if (!run('embed_db.mjs', { NK_EMBED_ONLY: 'jra' })) return false;
  prev.builtAt = Date.now(); fs.writeFileSync(stampFile, JSON.stringify(prev));
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (process.env.NK_REFRESH_NOPUSH) { console.error(`${stamp()} ${what}完了（${secs}秒・push なし）`); return true; }
  try {
    if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') { console.error(`${stamp()} main ではないので push しない`); return true; }
    const files = TARGETS.filter(f => fs.existsSync(path.join(ROOT, f)));
    git(['add', '--', ...files]);
    const staged = git(['diff', '--cached', '--name-only', '--', ...files]);
    if (!staged) { console.error(`${stamp()} ${what}完了（${secs}秒）／差分なし`); return true; }
    /* パスを明示（索引にある他の作業ファイルを巻き込まないため。tools/refresh.mjs の注記を参照） */
    git(['commit', '-q', '-m', `chore(jra): ${stamp()} 時点の出馬表と予想を反映`, '-m', 'tools/refresh_jra.mjs による自動コミット', '--', ...files]);
    if (process.env.NK_PUSH_NOW) { try { git(['push', 'origin', 'main']); } catch { git(['fetch', '-q', 'origin', 'main']); git(['rebase', '-q', '--autostash', 'origin/main']); git(['push', 'origin', 'main']); } }
    console.error(`${stamp()} ${what}＋commit 完了（${secs}秒・${staged.split('\n').length}ファイル）`);
  } catch (e) { console.error(`${stamp()} git で失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ')}`); }
  return true;
}

if (changed || (hasUpcoming() && !(prev.builtAt && Date.now() - prev.builtAt < 6 * 3600000))) {   // 変化なしなら6時間に1回だけ作り直す
  if (!buildAndCommit('反映')) process.exit(1);
}

/* 4) 発走前の記録（2026-10-16 追加）。この回は20分おきにしか起きないので、予想の記録が発走の16〜24分後になっていた。
   この回のうちに「発走10分前」を迎える今日のレースがあれば、その時刻まで待って
   そのレースだけ出馬表（オッズ）を取り直し、作り直して記録する（jra_build_races は発走12分前から記録する）。
   次の回（20分後）と重ならないよう、起動から LOOP_MIN 分までに迎えるレースだけを扱う */
const LOOP_MIN = Number(process.env.JRA_RECORD_LOOP || 17);
const startedAt = now.getTime();
const recordedIds = () => { const s = new Set(); try { for (const l of fs.readFileSync(path.join(D, 'preds.jsonl'), 'utf8').split('\n')) { const m = l.match(/"raceId":"(\d+)"/); if (m) s.add(m[1]); } } catch { } return s; };
const todayRaces = () => { const out = []; try { for (const l of fs.readFileSync(cardsFile, 'utf8').split('\n')) { if (!l.includes(`"date":"${today}"`)) continue; const c = JSON.parse(l); if (c.start && c.surface !== '障') out.push({ raceId: c.raceId, t: new Date(`${c.date}T${c.start.padStart(5, '0')}:00`).getTime() }); } } catch { } return out.sort((a, b) => a.t - b.t); };
for (let guard = 0; guard < 20; guard++) {
  const done = recordedIds();
  const next = todayRaces().find(r => !done.has(r.raceId) && r.t > Date.now() - 60000);
  if (!next) break;
  const wake = next.t - 10 * 60000;
  if (wake > startedAt + LOOP_MIN * 60000) break;                 // 次の回に任せる
  if (wake > Date.now()) await new Promise(res => setTimeout(res, wake - Date.now()));
  run('jra_fetch_cards.mjs', { JRA_SOON: '12' });                 // 発走12分以内のレースだけ、キャッシュを使わずに
  buildAndCommit('発走前の記録');
  if (recordedIds().size === done.size) break;                    // 記録できなかった（枠順なし等）なら打ち切る
}
