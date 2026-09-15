/* 潮の局面（tide.json → レースの締切時刻の 上げ／下げ と 潮位の高さ）。bfeat.mjs と build_boat.mjs で共用。
   tide.json が無い・その場に観測点が無い・日付が無いときは null（特徴量は 0 になる） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './bt.mjs';
let T = null;
function load() { if (T !== null) return T; try { T = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/boat/tide.json'), 'utf8')); } catch { T = false; } return T; }
export function tideOf(jcd, date, close) {
  const t = load(); if (!t) return null;
  const st = t.station?.[jcd]; if (!st) return null;
  const d = t.data?.[st.code]?.[date]; if (!d || !close) return null;
  const [h, m] = String(close).split(':').map(Number); if (!Number.isFinite(h)) return null;
  const min = h * 60 + (m || 0);
  const i = Math.max(0, Math.min(23, Math.floor(min / 60)));
  const a = d.h[i], b = d.h[Math.min(23, i + 1)];
  const lv = a + (b - a) * ((min - i * 60) / 60);
  const lo = Math.min(...d.h), hi = Math.max(...d.h);
  const phase = b > a + 1 ? 1 : b < a - 1 ? -1 : 0;                       // 上げ +1／下げ −1／転換 0
  const lvl = hi > lo ? (lv - (lo + hi) / 2) / ((hi - lo) / 2) : 0;       // その日の中での高さ −1〜+1
  return { phase, lvl: Math.max(-1, Math.min(1, lvl)), station: st.name };
}
