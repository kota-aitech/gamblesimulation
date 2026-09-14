/* ブラウザなしで banei.html の <script> を実行し、全日・全レースを描画して例外と頭数不一致を検出する（jra_check と同じ DOM スタブ） */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './lib/bn.mjs';

const html = fs.readFileSync(path.join(ROOT, 'banei.html'), 'utf8');
const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const noop = () => {};
const store = new Map();
function el(id) {
  if (store.has(id)) return store.get(id);
  const e = { id, innerHTML: '', textContent: '', style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop }, querySelectorAll: () => [], querySelector: () => null, addEventListener: noop };
  store.set(id, e); return e;
}
ids.forEach(el);
const document = { getElementById: id => store.get(id) || null, querySelectorAll: () => [], querySelector: () => null, addEventListener: noop, title: '' };
let mobile = false;
const sandbox = { document, console, Math, JSON, URLSearchParams, Date, Map, Set, location: { search: '' }, history: { replaceState: noop },
  window: { matchMedia: () => ({ matches: mobile }), addEventListener: noop } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js + '\nglobalThis.__X={state,load,render,NKBANEI};', sandbox);
const X = sandbox.__X;
let bad = 0, races = 0;
for (const mode of [false, true]) {
  mobile = mode;
  for (let d = 0; d < X.NKBANEI.days.length; d++) for (let i = 0; i < X.NKBANEI.days[d].races.length; i++) {
    X.load(d, i);
    const r = X.NKBANEI.days[d].races[i];
    const rows = (store.get('ubody').innerHTML.match(/<tr class="h"/g) || []).length;
    if (rows !== r.n) { console.log(`  ! ${X.NKBANEI.days[d].date} ${r.r}R 頭数 ${r.n} ≠ 行 ${rows}`); bad++; }
    const s = r.horses.reduce((a, h) => a + h.p1, 0);
    if (Math.abs(s - 1) > 0.02) { console.log(`  ! ${r.raceId} 勝率の和 ${s.toFixed(3)}`); bad++; }
    if (!mode) races++;
  }
}
if (races) for (const id of ['rhead', 'ubody', 'ai', 'box', 'points', 'memo', 'src']) { const e = store.get(id); if (!e || (e.innerHTML || '').length + (e.textContent || '').length < 3) { console.log(`  ! #${id} が空`); bad++; } }
console.log(`banei: ${races} レース（PC・スマホ）をレンダリング、問題 ${bad} 件`);
process.exit(bad ? 1 : 0);
