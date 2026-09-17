/* ボート版の反映係。fetch_live.mjs（launchd: com.boat.live）が直前情報とオッズを拾い、
   こちらが「見える形」にして公開サイトへ届ける。南関の refresh.mjs と同じ考え方。
   launchd（com.boat.refresh）から数分おきに呼ぶ想定で、常駐しない。

   1) 1時間に1回、昨日〜明日の K（成績）と B（番組表）を od2 から取り直す
      （B は前日夕方に順次公開される。K は当日夜。直近日は lib/bt.mjs が 30分で取り直す）
   2) live.<今日>.json / programs.jsonl / model.json / index.json のどれかが変わっていたら
      build_boat → embed_db（boat だけ）→ commit / push
   変化が無ければ何もしない。

     NK_REFRESH_NOPUSH=1 … push しない（手元確認用）
     NK_REFRESH_FORCE=1  … 変化が無くても作り直す
   コミットは生成物だけ（boat.html と data/boat の生成 JSON）。tools/ や *.md は巻き込まない。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, ymdOf } from './lib/bt.mjs';

const TODAY = process.env.BT_TODAY || ymdOf(new Date());
const D = path.join(ROOT, 'data', 'boat');
const STAMP = path.join(D, '.refresh-stamp');
const OD2STAMP = path.join(D, '.od2-stamp');
const addDays = (ymd, n) => { const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00`); d.setDate(d.getDate() + n); return ymdOf(d); };

const run = (script, env) => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', script)],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
    return true;
  } catch (e) {
    console.error(`! ${script} 失敗: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-3).join(' ')}`);
    return false;
  }
};

/* 1) 番組表・成績の取り直し（1時間に1回） */
let od2Age = Infinity;
try { od2Age = (Date.now() - fs.statSync(OD2STAMP).mtimeMs) / 60000; } catch { }
if (od2Age > 60 || process.env.NK_REFRESH_FORCE) {
  run('fetch_od2.mjs', { BT_FROM: addDays(TODAY, -1), BT_TO: addDays(TODAY, 1) });
  fs.writeFileSync(OD2STAMP, String(Date.now()));
}

/* 1b) 潮位表は1日1回（年1ファイルなので実際はキャッシュから読むだけ） */
const TIDESTAMP = path.join(D, '.tide-stamp');
let tideAge = Infinity;
try { tideAge = (Date.now() - fs.statSync(TIDESTAMP).mtimeMs) / 3600000; } catch { }
if (tideAge > 24 || !fs.existsSync(path.join(D, 'tide.json'))) { run('fetch_tide.mjs'); fs.writeFileSync(TIDESTAMP, String(Date.now())); }

/* 2) 変化があるときだけ作り直す */
/* 節間の結果は昨日以前の K と live からも作るので、results.jsonl（K の取り直し）と昨日の live も見る */
const watch = [`live.${addDays(TODAY, -1)}.json`, `live.${TODAY}.json`, `live.${addDays(TODAY, 1)}.json`, 'programs.jsonl', 'results.jsonl', 'model.json', 'index.json', 'tide.json'].map(f => path.join(D, f));
const sig = watch.map(f => { try { const s = fs.statSync(f); return `${path.basename(f)}:${s.mtimeMs}:${s.size}`; } catch { return path.basename(f) + ':-'; } }).join('|');
let prev = '';
try { prev = fs.readFileSync(STAMP, 'utf8'); } catch { }
if (sig === prev && !process.env.NK_REFRESH_FORCE) process.exit(0);

const t0 = Date.now();
/* 順番：成績の集計（前回までに記録した予想 × 最新の K）→ 予想の再生成（締切が過ぎたレースを記録）→ 埋め込み */
run('build_boat_results.mjs');                                   // preds が無い初日は何もしない
if (!run('build_boat.mjs')) process.exit(1);
if (!run('embed_db.mjs', { NK_EMBED_ONLY: 'boat' })) process.exit(1);
fs.writeFileSync(STAMP, sig);
const secs = ((Date.now() - t0) / 1000).toFixed(0);

/* --- 公開サイトへ反映（生成物だけを commit / push）--- */
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/* 南関の refresh.mjs と同時に走ると index.lock でぶつかることがある。少し待って数回やり直す */
const gitRetry = (args, n = 4) => {
  for (let i = 0; ; i++) {
    try { return git(args); }
    catch (e) {
      const m = String(e.stderr || e.message);
      if (i >= n - 1 || !/index\.lock|Another git process/.test(m)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);   // 2秒待つ（同期）
    }
  }
};
const stamp = new Date().toLocaleString('ja-JP', { hour12: false }).replace(/\//g, '-');
if (process.env.NK_REFRESH_NOPUSH) { console.error(`${stamp} 反映完了（${secs}秒・push なし）`); process.exit(0); }
const TARGETS = ['boat.html', 'top.html', 'data/boat/today.json', 'data/boat/top.json', 'data/boat/odds_live.jsonl', 'data/boat/tide.json',
  'data/boat/preds.jsonl', 'data/boat/results.json',
  `data/boat/live.${TODAY}.json`, `data/boat/live.${addDays(TODAY, 1)}.json`];
try {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') { console.error(`${stamp} 反映完了（${secs}秒）／ブランチが ${branch} なので push しません`); process.exit(0); }
  const exists = TARGETS.filter(f => fs.existsSync(path.join(ROOT, f)));
  gitRetry(['add', '--', ...exists]);
  const staged = git(['diff', '--cached', '--name-only']);
  if (!staged) { console.error(`${stamp} 反映完了（${secs}秒）／内容に差分なし`); process.exit(0); }
  gitRetry(['commit', '-q', '-m', `chore(boat): ${stamp} 時点の直前情報とオッズを反映`,
    '-m', 'tools/refresh_boat.mjs による自動コミット（直前情報・オッズ更新 → 予測の再生成）']);
  /* push はしない。publish.mjs（launchd 15分おき）がまとめて押す＝Render のデプロイ回数を抑える。NK_PUSH_NOW=1 でその場で push */
  if (process.env.NK_PUSH_NOW) { try { git(['push', 'origin', 'main']); } catch { git(['fetch', '-q', 'origin', 'main']); git(['rebase', '-q', '--autostash', 'origin/main']); git(['push', 'origin', 'main']); } }
  console.error(`${stamp} 反映＋commit 完了（${secs}秒・${staged.split('\n').length}ファイル${process.env.NK_PUSH_NOW ? '・push' : '・push は publish'}）`);
} catch (e) {
  const msg = String(e.stderr || e.stdout || e.message).split('\n').filter(Boolean).slice(-2).join(' ');
  console.error(`${stamp} 反映は完了（${secs}秒）が git で失敗: ${msg}`);
  process.exit(1);
}
