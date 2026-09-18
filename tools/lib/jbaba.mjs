/* JRA 公式の含水率・クッション値（tools/jra_fetch_baba.mjs → data/jra/baba.jsonl）を
   特徴量から引くための索引。

   - 測定はゴール前と4角の2点。両方あれば平均を「その日の含水率」とする
   - **生の値は場と芝ダで水準が違う**（芝は 10〜16%、ダートは 2〜12%、場ごとにも癖がある）ので、
     場×芝ダの平均・標準偏差で標準化した偏差（`dev`）で持つ。0 がその場のふつう、+1 で1σぶん湿っている
   - その日の測定が無ければ同じ場の直近4日以内を使う（金曜正午の値を土日に当てる）。
     jra_build_races.mjs の babaFor と同じ決まり */
import fs from 'node:fs';
import path from 'node:path';

const SURF = s => /芝/.test(s || '') ? '芝' : /ダ/.test(s || '') ? 'ダート' : null;

export function loadBaba(file) {
  const f = file || path.join(process.cwd(), 'data/jra/baba.jsonl');
  const MAP = new Map();                                    // 日付|場 -> 行
  let rows = [];
  try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) { const o = JSON.parse(l); MAP.set(`${o.date}|${o.venue}`, o); rows.push(o); } } catch { }

  /* 場×芝ダの平均・標準偏差（標準化用）。標本の少ない場は全体の値に寄せる */
  const acc = new Map(), all = new Map();
  const push = (m, k, v) => { const a = m.get(k) || m.set(k, [0, 0, 0]).get(k); a[0] += v; a[1] += v * v; a[2]++; };
  const moistRaw = (o, surf) => {
    const g = surf === '芝' ? o.turfGoal : o.dirtGoal, c = surf === '芝' ? o.turfCorner : o.dirtCorner;
    return g != null && c != null ? (g + c) / 2 : (g ?? c ?? null);
  };
  for (const o of rows) for (const surf of ['芝', 'ダート']) {
    const v = moistRaw(o, surf); if (v == null) continue;
    push(acc, `${o.venue}|${surf}`, v); push(all, surf, v);
  }
  for (const o of rows) if (o.cushion != null) { push(acc, `${o.venue}|C`, o.cushion); push(all, 'C', o.cushion); }
  const stat = (m, k, fb) => {
    const a = m.get(k), b = all.get(fb);
    const st = a => { const mu = a[0] / a[2], sd = Math.sqrt(Math.max(1e-6, a[1] / a[2] - mu * mu)); return [mu, sd]; };
    if (!b) return null;
    const [gm, gs] = st(b);
    if (!a || a[2] < 30) return [gm, gs];                    // 30日未満はその場の癖を信用しない
    const [mu, sd] = st(a);
    return [mu, Math.max(sd, 0.4 * gs)];                     // 変動の小さい場で偏差が暴れないように床を置く
  };

  const cache = new Map();
  const atCache = new Map();
  /* その日（無ければ直近4日以内）の測定 */
  function at(date, venue) {
    const key = `${date}|${venue}`;
    if (atCache.has(key)) return atCache.get(key);
    let out = null;
    for (let k = 0; k <= 4; k++) {
      const d = k === 0 ? date : new Date(Date.parse(date + 'T00:00:00') - k * 86400000).toISOString().slice(0, 10);
      const b = MAP.get(`${d}|${venue}`);
      if (b) { out = { ...b, at: d, ago: k }; break; }
    }
    atCache.set(key, out);
    return out;
  }
  /* 含水率とクッション値を「その場のふつうからのズレ」に直して返す */
  function of(date, venue, surface) {
    const surf = SURF(surface);
    if (!surf || !date || !venue) return null;
    const key = `${date}|${venue}|${surf}`;
    if (cache.has(key)) return cache.get(key);
    const b = at(date, venue);
    let out = null;
    if (b) {
      const v = moistRaw(b, surf);
      const s = stat(acc, `${venue}|${surf}`, surf);
      const dev = v != null && s ? Math.max(-3, Math.min(3, (v - s[0]) / s[1])) : null;
      let cush = null, cdev = null;
      if (surf === '芝' && b.cushion != null) {
        cush = b.cushion;
        const cs = stat(acc, `${venue}|C`, 'C');
        if (cs) cdev = Math.max(-3, Math.min(3, (cush - cs[0]) / cs[1]));
      }
      out = (dev == null && cdev == null) ? null : { surf, moist: v, dev, cushion: cush, cdev, ago: b.ago, at: b.at };
    }
    cache.set(key, out);
    return out;
  }
  return { size: MAP.size, at, of };
}
