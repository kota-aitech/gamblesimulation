/* ブラウザなしで race.html（出馬表ページ）を実行し、全開催日・全レースを描画する。
   使い方: node tools/race_check.mjs [oi|kawasaki|funabashi|urawa]                          */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './lib/nk.mjs';

const track = process.argv[2] || 'oi';
const html = fs.readFileSync(path.join(ROOT, 'race.html'), 'utf8');
const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const noop = () => {};
const store = new Map();
const mk = id => ({ id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, className: '',
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, appendChild: noop, addEventListener: noop });
ids.forEach(i => store.set(i, mk(i)));
const document = {
  getElementById: id => store.get(id) || null,
  createElement: () => mk('anon'), querySelector: () => mk('q'), querySelectorAll: () => [],
  addEventListener: noop, body: mk('body'),
};
const store2 = new Map();
const localStorage = { getItem: k => (store2.has(k) ? store2.get(k) : null), setItem: (k, v) => store2.set(k, String(v)), removeItem: k => store2.delete(k) };
const sandbox = { document, console, Math, JSON, Date, Intl, URLSearchParams, navigator: {}, alert: noop, setTimeout: noop,
  requestAnimationFrame: noop, localStorage,
  window: { matchMedia: () => ({ matches: false }), addEventListener: noop },
  location: { search: '?track=' + track } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js + '\nglobalThis.__X={D,render,NKR,setRace:(d,i)=>{day=d;ridx=i;},setLayout:v=>{layout=v;}};', sandbox);
const X = sandbox.__X;

let bad = 0, races = 0, horses = 0, withPast = 0, scratched = 0, graded = 0;
const r0 = (list, i) => list[i].r;
for (const [dk, list] of Object.entries(X.D.days)) {
  for (let i = 0; i < list.length; i++) {
    X.setRace(dk, i);
    const r = list[i];
    const hs = X.D.entries[`${dk}|${r.r}`] || [];
    const live = hs.filter(x => !x.scratch);
    /* 横型・縦型の両方を描いて確認する */
    let h = '';
    for (const lay of ['yoko', 'tate']) {
      X.setLayout(lay);
      store.get('board').innerHTML = '';
      X.render();
      const cur = store.get('board').innerHTML;
      if (cur.length < 500) { console.log(`  ! ${dk} ${r0(list, i)}R の${lay}描画が空`); bad++; }
      if (lay === 'yoko') {
        /* 展開予想に全頭が入っているか（欠けても画面では気づきにくい）*/
        const t = store.get('tenkai').innerHTML || '';
        const nos = (t.match(/class="tk-cell"/g) || []).length;
        /* 展開予想は出走馬のみ（取消は除く）*/
        if (live.length >= 4 && nos !== live.length) { console.log(`  ! ${dk} ${r.r}R 展開予想 ${nos}頭 ≠ 出走 ${live.length}頭`); bad++; }
      }
      if (lay === 'tate') {
        /* 柱の本数が全頭ぶんあるか（取消馬も薄く表示するので hs 基準）*/
        const pil = (cur.match(/<div class="pil /g) || []).length;
        if (pil !== hs.length) { console.log(`  ! ${dk} ${list[i].r}R 縦型の柱 ${pil}本 ≠ 出馬表 ${hs.length}頭`); bad++; }
      }
      h = lay === 'yoko' ? cur : h;
    }
    races++; horses += live.length;
    scratched += hs.length - live.length;
    withPast += live.filter(x => x.past && x.past.length).length;
    if (h.length < 500) { console.log(`  ! ${dk} ${r.r}R の描画が空`); bad++; continue; }
    if (list[i].grade) graded++;
    const marks = live.filter(x => x.mark).length;
    if (marks < Math.min(5, live.length)) { console.log(`  ! ${dk} ${r.r}R 印が ${marks} 個しかない`); bad++; }
    /* 新馬戦は前走が無いのが正しいので、前走コマの有無は「前走がある馬がいるとき」だけ見る */
    const anyPast = live.some(x => x.past && x.past.length);
    if (!/class="uma/.test(h) || (anyPast && !/class="run"/.test(h))) { console.log(`  ! ${dk} ${r.r}R 馬柱/前走の描画が欠けている`); bad++; }
    if (live.length !== r.n) { console.log(`  ! ${dk} ${r.r}R 頭数 ${r.n} ≠ 出走馬 ${live.length}`); bad++; }
    for (const x of live) {
      if (!x.jockey || !x.trainer) { console.log(`  ! ${dk} ${r.r}R ${x.name} 騎手/調教師が空`); bad++; }
      if (x.hIdx == null || x.ability == null) { console.log(`  ! ${dk} ${r.r}R ${x.name} 指数が欠落`); bad++; }
      if (x.win == null || x.top3 == null) { console.log(`  ! ${dk} ${r.r}R ${x.name} 勝率が欠落（build_marks 未実行）`); bad++; }
    }
  }
}
console.log(`${track}: ${races} レース / 出走 ${horses} 頭（うち前5走あり ${withPast}）/ 取消 ${scratched} 頭 / 段位あり ${graded} レース、問題 ${bad} 件`);
const rk = Object.keys(X.D.entries)[9] || Object.keys(X.D.entries)[0];
if (!rk) { console.log(`${track}: 今日以降の出馬表なし（開催の谷間）。問題 ${bad} 件`); process.exit(bad ? 1 : 0); }
const top = X.D.entries[rk].filter(h => h.mark).sort((a, b) => b.win - a.win);
console.log(`例 ${rk}: ` + top.map(h => `${h.mark}${h.no} ${h.name}(${(h.win * 100).toFixed(1)}%)`).join(' '));
process.exit(bad ? 1 : 0);
