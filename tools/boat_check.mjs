/* ブラウザなしで boat.html の <script> を丸ごと実行し、全日・全場・全レースを
   読み込んで描画関数が例外を出さないこと、艇数が6であること、主要な要素に中身が
   入ることを確認する（南関の ui_check.mjs と同じ DOM スタブ）。
   使い方: node tools/boat_check.mjs                                              */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './lib/bt.mjs';

const html = fs.readFileSync(path.join(ROOT, 'boat.html'), 'utf8');
const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);

const noop = () => {};
const ctx2d = new Proxy({
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }),
}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^[a-z]/.test(k) ? noop : undefined)), set: () => true });

const store = new Map();
function el(id) {
  if (store.has(id)) return store.get(id);
  const e = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, checked: false,
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    children: [], clientWidth: 1200, clientHeight: 700, width: 0, height: 0, scrollLeft: 0, scrollWidth: 0,
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.unshift(c); return c; },
    addEventListener: noop, removeEventListener: noop, setPointerCapture: noop, getContext: () => ctx2d,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 700 }),
    querySelectorAll: () => [], querySelector: () => null, focus: noop, remove: noop, closest: () => null, scrollIntoView: noop,
  };
  store.set(id, e);
  return e;
}
ids.forEach(el);
const document = {
  getElementById: id => (store.has(id) ? store.get(id) : null),
  createElement: () => el('anon' + Math.random()),
  querySelectorAll: () => [], querySelector: () => null,
  addEventListener: noop, body: el('body'), title: '',
};
const sandbox = {
  document, console, Math, JSON, URLSearchParams, Date, Intl, Map, Set,
  location: { search: '', hash: '' },
  window: { devicePixelRatio: 1, addEventListener: noop, matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800 },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  performance: { now: () => Date.now() }, requestAnimationFrame: noop, cancelAnimationFrame: noop, setTimeout: (f) => { f(); return 0; }, clearTimeout: noop,
  setInterval: () => 0, clearInterval: noop, history: { replaceState: noop },
  alert: m => { throw new Error('alert: ' + m); },
  navigator: { userAgent: 'node' },
};
sandbox.window.document = document;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js + '\nglobalThis.__X={state,loadRace,renderPred,renderLog,sampleRace,NKBOAT};', sandbox);

const X = sandbox.__X;
let bad = 0, races = 0, exN = 0;
for (let d = 0; d < X.NKBOAT.days.length; d++) {
  const day = X.NKBOAT.days[d];
  for (let v = 0; v < day.venues.length; v++) {
    for (let i = 0; i < day.venues[v].races.length; i++) {
      X.loadRace(d, v, i);
      const r = X.state.race;
      if (r.boats.length !== 6) { console.log(`  ! ${day.date} ${day.venues[v].name} ${r.r}R 艇数 ${r.boats.length}`); bad++; }
      const p = (r.ex || r.pre).p1, s = p.reduce((a, b) => a + b, 0);
      if (Math.abs(s - 1) > 0.01) { console.log(`  ! ${day.date} ${day.venues[v].name} ${r.r}R 勝率の和 ${s.toFixed(3)}`); bad++; }
      X.renderPred();
      const rec = X.sampleRace(r, 1234 + i, true);
      if (!rec.frames?.length) { console.log(`  ! ${day.date} ${day.venues[v].name} ${r.r}R フレームが空`); bad++; }
      if (r.level === 'ex') exN++;
      races++;
      /* 節間の結果：当日ぶんの行数＝レース数、結果の付いたレースには着順3つ */
      const L = day.venues[v].log;
      if (L) {
        const td = L.days.find(x => x.date === day.date);
        if (!td || td.rows.length !== day.venues[v].races.length) { console.log(`  ! ${day.date} ${day.venues[v].name} 節間の結果の行数が出走レース数と違う`); bad++; }
        if (r.result && (!r.result.fin || r.result.fin.length !== 3)) { console.log(`  ! ${day.date} ${day.venues[v].name} ${r.r}R 結果の着順が3つない`); bad++; }
      }
    }
  }
}
const need = ['predHead', 'predBody', 'points', 'trifecta', 'badge', 'venueInfo', 'srcNote', 'recBox', 'vhead', 'races', 'logTitle', 'btBox'];
for (const id of need) {
  const e = store.get(id);
  const has = e && ((e.innerHTML || '').length > 3 || (e.textContent || '').length > 3);
  if (!has) { console.log(`  ! #${id} が空`); bad++; }
}
let logDays = 0, logRes = 0; for (const d of X.NKBOAT.days) for (const v of d.venues) for (const x of (v.log?.days || [])) { logDays++; logRes += x.done; }
console.log(`boat: ${races} レース（直前情報あり ${exN}）をレンダリング、節間の結果 ${logDays} 日 ${logRes} R、要素チェック ${need.length} 件、問題 ${bad} 件`);
console.log('読みのポイント抜粋:', (store.get('points').innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
process.exit(bad ? 1 : 0);
