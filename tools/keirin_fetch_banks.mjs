/* 全43場のバンクの形 → data/keirin/banks.json（コミット対象）
   Kドリームスの場のページ（/{場}/）の「バンクデータ」：周長・見なし直線距離・センター部路面傾斜（カント）・直線部路面傾斜・幅員と「バンクの特徴」の文。
   形は変わらないので月1で十分（キャッシュ 30日）。長い取り込み（KR_YIELD）が動いていても、ここは .pause を置いて譲ってもらう */
import fs from 'node:fs';
import { get, VENUES, BASE, writeJSON, text, num, PAUSE } from './lib/kr.mjs';

const dms = s => { const m = String(s || '').match(/(\d+)゜\s*(\d+)´\s*(\d+)″/); return m ? +(+m[1] + m[2] / 60 + m[3] / 3600).toFixed(2) : null; };
fs.writeFileSync(PAUSE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PAUSE); } catch { } });
const out = {};
for (const [code, slug, name] of VENUES) {
  try {
    const t = text((await get(`${BASE}/${slug}/`, { ttlDays: 30 })).replace(/<script[\s\S]*?<\/script>/g, ''));
    const feat = (t.match(/バンクの特徴\s*(.*?)\s*バンクデータ/) || [])[1] || '';
    out[name] = {
      code, slug,
      len: num((t.match(/周長\s*(\d+)m/) || [])[1]),
      straight: num((t.match(/見なし直線距離\s*([\d.]+)m/) || [])[1]),
      cant: dms((t.match(/センター部路面傾斜\s*([^\s]+)/) || [])[1]),
      cantStraight: dms((t.match(/直線部路面傾斜\s*([^\s]+)/) || [])[1]),
      width: { home: num((t.match(/ホーム幅員\s*([\d.]+)m/) || [])[1]), back: num((t.match(/バック幅員\s*([\d.]+)m/) || [])[1]) },
      feature: feat.split('・').map(s => s.replace(/["”“]/g, '').trim()).filter(s => s && !/^ＧＰ/.test(s)),
    };
    console.error(`${name} ${out[name].len}m 直線${out[name].straight}m カント${out[name].cant}°`);
  } catch (e) { console.error(`! ${name} ${e.message}`); }
}
writeJSON('data/keirin/banks.json', out);
