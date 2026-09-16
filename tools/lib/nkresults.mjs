/* 出馬表ページ（race.html）に添える「実測」：
   record  … 日別の成績の集計（results.<track>.json の meta.summary）
   results … 開催（回）ごとの結果：レースごとの着順・払戻・締切時点の印・的中（ボートの「節間の結果」と同じ見せ方。?view=results）
   build_marks.mjs と embed_db.mjs の両方が race.html の NKRACE を書くので、ここで一元化する（片方だけだと反映の順序で消える） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON } from './nk.mjs';

export function raceExtras(TRACKS) {
  const results = {}, record = {};
  for (const key of TRACKS) {
    const rp = path.join(ROOT, `data/nankan/results.${key}.json`);
    if (!fs.existsSync(rp)) continue;
    const R = readJSON(`data/nankan/results.${key}.json`);
    if (R.meta && R.meta.summary) record[R.track] = R.meta.summary;
    const dayN = dk => Number((dk.match(/第(\d+)日/) || [])[1]) || 0;
    const dayList = Object.entries(R.days).map(([dk, rs]) => ({ dk, n: dayN(dk), date: rs[0]?.date || '', rs })).filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date));
    const meets = [];
    for (const d of dayList) { const cur = meets.at(-1); if (!cur || d.n <= cur.days.at(-1).n) meets.push({ days: [] }); meets.at(-1).days.push(d); }
    const yenOf = (pay, kind, keyStr) => { const hit = (pay?.[kind] || []).find(x => x.c === keyStr); return hit ? hit.yen : 0; };
    const cmb2 = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) o.push([a[i], a[j]]); return o; };
    const cmb3 = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) for (let k = j + 1; k < a.length; k++) o.push([a[i], a[j], a[k]]); return o; };
    const sk = a => a.slice().sort((x, y) => x - y).join('-');
    results[key] = { track: R.track, meets: meets.slice(-2).map(m => ({
      days: m.days.map(d => {
        const rows = d.rs.map(r => {
          const hs = (R.races[`${d.dk}|${r.r}`] || []);
          const fin = hs.filter(h => h.pos >= 1).sort((a, b) => a.pos - b.pos).map(h => [h.no, h.gate]);
          const marks = hs.filter(h => h.mark).sort((a, b) => (b.win || 0) - (a.win || 0)).map(h => [h.no, h.gate, h.mark, Math.round((h.win || 0) * 100) / 100]);
          const top = marks.map(m => m[0]);
          const f3 = fin.slice(0, 3).map(x => x[0]);
          const pay = r.pay || {};
          /* 本命BOX（3頭・4頭）の的中と払戻。日別の成績（build_results）と同じ買い方。点数は 3頭＝馬連3・三連複1、4頭＝馬連6・三連複4 */
          const box = {};
          for (const k of [3, 4]) {
            const sel = top.slice(0, k); if (sel.length < k) continue;
            const u = f3.length >= 2 && cmb2(sel).some(c => sk(c) === sk(f3.slice(0, 2))), s3 = f3.length >= 3 && cmb3(sel).some(c => sk(c) === sk(f3));
            box[k] = [u ? yenOf(pay, 'umaren', sk(f3.slice(0, 2))) : 0, s3 ? yenOf(pay, 'sanpuku', sk(f3)) : 0];
          }
          return { r: r.r, cls: r.cls, dist: r.dist, n: r.n, baba: r.baba || null, src: r.oddsSrc || null,
            fin: fin.slice(0, 3), also: fin.slice(3).map(x => x[0]), marks: marks.slice(0, 4),
            pay: [yenOf(pay, 'tan', String(f3[0] ?? '')), f3.length >= 3 ? yenOf(pay, 'sanpuku', sk(f3)) : 0, (pay.santan || [])[0]?.yen ?? 0, (pay.santan || [])[0]?.pop ?? null],
            hit: [!!r.hit?.win, !!r.hit?.winInTop3], box };
        });
        const done = rows.filter(x => x.fin.length >= 3);
        const sum = { races: done.length, win: done.filter(x => x.hit[0]).length, top3: done.filter(x => x.hit[1]).length };
        const PTS = { 3: [3, 1], 4: [6, 4] };
        for (const k of [3, 4]) { const rs = done.filter(x => x.box[k]); sum[`b${k}`] = { n: rs.length, uCost: rs.length * PTS[k][0] * 100, uRet: rs.reduce((a, x) => a + x.box[k][0], 0), uHit: rs.filter(x => x.box[k][0]).length, sCost: rs.length * PTS[k][1] * 100, sRet: rs.reduce((a, x) => a + x.box[k][1], 0), sHit: rs.filter(x => x.box[k][1]).length }; }
        return { dk: d.dk, date: d.date, n: d.n, rows, sum };
      }),
    })) };
  }
  return { record, results };
}
