/* 生成した JSON を HTML のマーカー間に流し込む。
   /* NAME:BEGIN ... *​/  const VAR={...};  /* NAME:END *​/  の形を保つ。      */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './nk.mjs';

export function inject(file, marker, varName, data) {
  const p = path.join(ROOT, file);
  const html = fs.readFileSync(p, 'utf8');
  const B = `/* ${marker}:BEGIN`, E = `/* ${marker}:END */`;
  const i = html.indexOf(B), j = html.indexOf(E);
  // 反映係が何本も同じ HTML を書く。書いている途中のファイルを別の係が読むと、途中までの中身を元に書き戻して
  // **後ろが永久に欠ける**（2026-11-11 18:22 に top.html がこれで切れ、11/25 まで TOP が真っ白だった）。
  // 読んだものが最後まであることを確かめ、書くときは別名に書いてから置き換える（読む側は必ず完全な版を見る）。
  if (!/<\/html>\s*$/.test(html)) throw new Error(`${file} が途中で切れています（</html> で終わっていない）`);
  if (i < 0 || j < 0) throw new Error(`${file} に ${marker} マーカーがありません`);
  const head = html.slice(i, html.indexOf('\n', i) + 1);
  const body = `const ${varName}=${JSON.stringify(data)};\n`;
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, html.slice(0, i) + head + body + html.slice(j));
  fs.renameSync(tmp, p);
  console.error(`埋め込み ${(body.length / 1024).toFixed(0)} KB → ${file} (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
}
