/* sim.html のセクション0〜5（＝予想モデル本体）を Node の VM に読み込む。
   印もバックテストも「別式」を作らず必ずこれを通すこと。3Dページと結果が食い違わないため。
   ※ sim.html に最新の傾向データが埋まっている前提（embed_db.mjs のあとに使う）。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './nk.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function loadModel(track) {
  const html = fs.readFileSync(path.join(ROOT, 'sim.html'), 'utf8');
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const cut = js.indexOf('   6. 3Dシーン');
  const src = js.slice(0, js.lastIndexOf('/* ====', cut));
  const ctx = vm.createContext({ location: { search: '?track=' + track }, URLSearchParams, Math, JSON, console,
    document: { getElementById: () => ({ style: {}, dataset: {} }) } });
  vm.runInContext(src + '\nglobalThis.__M={monteCarlo,simRace,combinedTrend,gateEdge,paceOf,TK,BABA,WEATHER,CALIB_DEF};', ctx);
  return ctx.__M;
}

/* sim.html の autoBias と同じ式。あちらを変えたらここも変える。
   馬場・天候は実際に発表されたものを渡す（レース前に分かる情報なので使ってよい）。 */
export function condOf(M, dist, baba, weather) {
  const c = M.combinedTrend(dist), cal = M.TK.calib || M.CALIB_DEF;
  const { gd } = M.gateEdge(c);
  return {
    baba: M.BABA[baba] ? baba : M.TK.defaults.baba,
    weather: M.WEATHER[weather] ? weather : M.TK.defaults.weather,
    wind: 0, recent: 0.6, human: 1,
    front: +clamp((c.front3 - cal.frontMid) / (2.2 * cal.frontSd), -1, 1).toFixed(2),
    out: +clamp((gd - cal.gateMid) / (2.2 * cal.gateSd), -1, 1).toFixed(2),
  };
}
