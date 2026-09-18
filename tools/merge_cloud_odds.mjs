/* odds-cloud ブランチ（GitHub Actions が書く締切前オッズ）を、この Mac の既存ファイルへ取り込む。

   役割分担
     クラウド（tools/cloud_odds.mjs）… 締切8分前のオッズを拾って odds-cloud ブランチに追記するだけ
     Mac（これ）                      … 取り込んで data/nankan/odds_live.jsonl などに混ぜる
   **クラウドは main を触らず、Mac は odds-cloud を触らない**ので、両方から push しても衝突しない。

   同じレース・同じタグの記録が既にあれば入れない（Mac が起きていたときは Mac の記録が残る）。
     node tools/merge_cloud_odds.mjs          取り込む（変化があれば commit）
     NK_MERGE_NOCOMMIT=1 …                    commit しない */
process.env.TZ = 'Asia/Tokyo';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BR = process.env.NK_MERGE_BRANCH || 'origin/odds-cloud';
const DAYS = Number(process.env.NK_MERGE_DAYS || 10);
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const stamp = () => new Date().toLocaleString('ja-JP', { hour12: false }).replace(/\//g, '-');
const TRACK = { '18': '浦和', '19': '船橋', '20': '大井', '21': '川崎' };

try { git(['fetch', '-q', 'origin', 'odds-cloud']); }
catch (e) { console.error(`${stamp()} odds-cloud が取れない: ${String(e.stderr || e.message).split('\n').slice(-1)}`); process.exit(0); }

const since = new Date(Date.now() - DAYS * 86400000).toLocaleDateString('sv-SE');
let files = [];
try { files = git(['ls-tree', '-r', '--name-only', BR, '--', 'data/odds_cloud']).split('\n').filter(f => /\.jsonl$/.test(f)); } catch { }
files = files.filter(f => (f.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/) || [])[1] >= since);
if (!files.length) { process.exit(0); }

/* 取り込み先ごとの「もう持っている記録」の鍵 */
const load = rel => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
};
const keys = { nankan: new Set(), boat: new Set(), jra: new Set() };
for (const l of load('data/nankan/odds_live.jsonl')) { try { const o = JSON.parse(l); keys.nankan.add(`${o.raceId}|${o.tag}`); } catch { } }
for (const l of load('data/boat/odds_live.jsonl')) { try { const o = JSON.parse(l); keys.boat.add(`${o.date}|${o.jcd}|${o.r}|${o.kind}`); } catch { } }
for (const l of load('data/jra/odds_live.jsonl')) { try { const o = JSON.parse(l); keys.jra.add(`${o.raceId}|${o.tag}`); } catch { } }

const add = { nankan: [], boat: [], jra: [] };
for (const f of files) {
  const sport = f.split('/')[2];
  let body = ''; try { body = git(['show', `${BR}:${f}`]); } catch { continue; }
  for (const l of body.split('\n')) {
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const tag = o.tag === 'pre' ? `T-${Math.abs(o.minsToClose) || 8}` : o.tag;
    if (sport === 'nankan') {
      const k = `${o.key}|${tag}`; if (keys.nankan.has(k)) continue; keys.nankan.add(k);
      add.nankan.push({ raceId: o.key, date: o.date, track: TRACK[o.key.slice(8, 10)] || '', R: Number(o.key.slice(14, 16)),
        tag, post: o.post, capturedAt: o.capturedAt, minsToPost: o.minsToClose + 1, updated: o.updated, tan: o.tan, fuku: o.fuku, src: 'cloud' });
    } else if (sport === 'boat') {
      const ymd = o.date.replace(/-/g, ''), k = `${ymd}|${o.jcd}|${o.r}|T-8`;
      if (keys.boat.has(k)) continue; keys.boat.add(k);
      add.boat.push({ date: ymd, jcd: o.jcd, r: o.r, kind: 'T-8', win: o.win, place: o.place, ex3: o.tri, at: o.capturedAt, left: o.minsToClose, src: 'cloud' });
    } else if (sport === 'jra') {
      const k = `${o.key}|${tag}`; if (keys.jra.has(k)) continue; keys.jra.add(k);
      add.jra.push({ raceId: o.key, date: o.date, R: Number(o.key.slice(10, 12)), tag, post: o.post,
        capturedAt: o.capturedAt, minsToPost: o.minsToClose, status: o.status, updated: o.updated, tan: o.tan, src: 'cloud' });
    }
  }
}
const OUT = { nankan: 'data/nankan/odds_live.jsonl', boat: 'data/boat/odds_live.jsonl', jra: 'data/jra/odds_live.jsonl' };
const wrote = [];
for (const [sport, rows] of Object.entries(add)) {
  if (!rows.length) continue;
  rows.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
  const p = path.join(ROOT, OUT[sport]);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  wrote.push(`${sport} ${rows.length}件`);
}
if (!wrote.length) process.exit(0);
console.error(`${stamp()} クラウドのオッズを取り込み: ${wrote.join('／')}`);
if (process.env.NK_MERGE_NOCOMMIT) process.exit(0);
try {
  git(['add', ...Object.values(OUT).filter(f => fs.existsSync(path.join(ROOT, f)))]);
  if (git(['status', '--porcelain', '--', ...Object.values(OUT)]).trim()) git(['commit', '-q', '-m', `chore(odds): クラウドの締切前オッズを取り込み（${wrote.join('／')}）`]);
} catch (e) { console.error(`  ! commit 失敗: ${String(e.stderr || e.message).split('\n').slice(-1)}`); }
