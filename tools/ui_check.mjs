/* ブラウザなしで index.html の <script> を丸ごと実行し、init() が最後まで通るかを見る。
   最小の DOM/Canvas スタブを当てて、描画・予想パネル・人的要因パネルの
   レンダリング関数が例外を出さないこと、主要な要素に中身が入ることを確認する。
   使い方: node tools/ui_check.mjs [oi|kawasaki|funabashi|urawa]                              */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './lib/nk.mjs';

const track = process.argv[2] || 'oi';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);

const noop = () => {};
const ctx2d = new Proxy({
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }),
  getImageData: () => ({ data: [] }),
}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^[a-z]/.test(k) ? noop : undefined)), set: () => true });

const store = new Map();
function el(id) {
  if (store.has(id)) return store.get(id);
  const e = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, checked: false,
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    children: [], clientWidth: 1200, clientHeight: 700, width: 0, height: 0,
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.unshift(c); return c; },
    addEventListener: noop, removeEventListener: noop, setPointerCapture: noop, getContext: () => ctx2d,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 700 }),
    querySelectorAll: () => [], querySelector: () => null, focus: noop, remove: noop, closest: () => null,
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
  document, console, Math, JSON, URLSearchParams, Date, Intl,
  location: { search: '?track=' + track },
  window: { devicePixelRatio: 1, addEventListener: noop, matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800 },
  performance: { now: () => Date.now() }, requestAnimationFrame: noop, cancelAnimationFrame: noop, setTimeout: (f) => { f(); return 0; }, clearTimeout: noop,
  alert: m => { throw new Error('alert: ' + m); },
  navigator: { userAgent: 'node' },
};
sandbox.window.document = document;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js + '\nglobalThis.__X={state,renderPred,renderPoints,renderTrend,renderHuman,monteCarlo,loadRace,DAYS,REAL};', sandbox);

const X = sandbox.__X;
const need = ['predHead', 'predBody', 'points', 'humanBody', 'humanNote', 'badge', 'trendStyle', 'trendGate', 'meetFacts', 'srcNote', 'humanHint'];
let bad = 0;
for (const id of need) {
  const e = store.get(id);
  const has = e && ((e.innerHTML || '').length > 3 || (e.textContent || '').length > 3);
  if (!has) { console.log(`  ! #${id} が空`); bad++; }
}
/* 全レースを一巡させて例外が出ないことを確認 */
let races = 0;
for (const dk of Object.keys(X.DAYS)) {
  for (let i = 0; i < X.DAYS[dk].length; i++) {
    X.loadRace(dk, i);
    const r = X.state.race;
    if (r.horses.length !== r.n) { console.log(`  ! ${dk} ${r.r}R 頭数 ${r.n} ≠ 出走馬 ${r.horses.length}`); bad++; }
    X.state.mc = X.monteCarlo(r, X.state.cond, 60);
    X.renderPred();
    races++;
  }
}
console.log(`${track}: ${races} レースをレンダリング、要素チェック ${need.length} 件、問題 ${bad} 件`);
console.log('人的要因パネル抜粋:', (store.get('humanBody').innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 220));
console.log('注記:', (store.get('humanNote').textContent || '').slice(0, 200));
console.log('自動バイアス:', store.get('autoHint').textContent);
console.log('読みのポイント:\n  ' + (store.get('points').innerHTML || '').split('</li>').map(x => x.replace(/<[^>]+>/g, '').trim()).filter(Boolean).join('\n  '));
process.exit(bad ? 1 : 0);
