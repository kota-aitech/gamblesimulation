/* オリジナル展示データ（一周・まわり足・直線タイム）— 各場の公式サイトが独自に計測して出しているもの。
   boatrace.jp（公式）には無く、場ごとにサイトも形式も違う。2026-09-15 に24場を調べた結果：

   取れる場（HTML に数値が入っている）
     XOOPS 系（/modules/yosou/…。iframe の中身を直接 GET。Referer・Cookie 不要・UTF-8。day=YYYYMMDD で前日も残る）
       01 桐生   cyokuzen.php kind=2      半周・まわり足・直線（一周ではなく半周）
       06 浜名湖 group-cyokuzen.php kind=2  一周・まわり足・直線
       08 常滑   group-cyokuzen.php kind=2
       09 津     group-tenji.php kind=1     （2周目の計測）
       10 三国   group-cyokuzen.php kind=2  （2周目。周回展示が1周なら1周目）
       11 びわこ cyokuzen.php kind=2        （直線＝バック側約150m）
       13 尼崎   group-cyokuzen.php kind=2  一周・まわり足（直線なし。まわり足は 11 秒台＝計測区間が違う）
       14 鳴門   group-cyokuzen.php kind=2  （調査時に取れたが、こちらの環境から名前解決できない時間帯があった）
       18 徳山   tenji.php                  一周・まわり足（直線なし）
       21 芦屋   group-cyokuzen.php kind=2
       22 福岡   tenji_info.php             （2周目の計測）
       23 唐津   group-cyokuzen.php kind=2
     TBK 系（/asp/kyogi/{場}/pc/…RR.htm。URL に日付が無く当日ぶんだけ。1艇＝<tbody>）
       04 平和島 yoso05RR.htm  一周・まわり足・直線（＋時速の行）
       12 住之江 st02RR.htm    一周・まわり足（直線なし）
   取れない場
     02 戸田（場内表示のみ。サイトに無い） 03 江戸川（直前予想コメントのみ） 05 多摩川（展示タイムまで） 07 蒲郡（展示タイムまで）
     15 丸亀・16 児島（TBK 系の st02RR.htm はあるが調査日は非開催で列が確認できていない。確認できたら足す）
     17 宮島（PDF のみ） 19 下関（PDF のみ） 20 若松（サイトに名前解決できず未確認） 24 大村（展示タイムまで）

   値は場ごとに計測区間が違う（桐生は半周、尼崎のまわり足は11秒台）ので、**場をまたいで比べない**。同じレースの6艇の中の相対で見る。 */

const xoops = (host, path, cells, labels) => ({ host, url: (d, r) => host + path.replace('{d}', d).replace('{r}', r), type: 'xoops', cells, labels, past: true });
const tbk = (host, path, cols, labels) => ({ host, url: (d, r) => host + path.replace('{rr}', String(r).padStart(2, '0')), type: 'tbk', cols, labels, past: false });
const L3 = { lap: '一周', turn: 'まわり足', str: '直線' }, L2 = { lap: '一周', turn: 'まわり足' };
const C4 = { ex: 'col5', lap: 'col6', turn: 'col7', str: 'col8' };

export const ORIGEX = {
  '01': xoops('https://www.kiryu-kyotei.com', '/modules/yosou/cyokuzen.php?day={d}&race={r}&kind=2&if=1', C4, { lap: '半周', turn: 'まわり足', str: '直線' }),
  '04': tbk('https://www.heiwajima.gr.jp', '/asp/kyogi/04/pc/yoso05{rr}.htm', ['lap', 'turn', 'str', 'ex', 'weight'], L3),
  '06': xoops('https://www.boatrace-hamanako.jp', '/modules/yosou/group-cyokuzen.php?day={d}&race={r}&kind=2&if=1', C4, L3),
  '08': xoops('https://www.boatrace-tokoname.jp', '/modules/yosou/group-cyokuzen.php?day={d}&race={r}&kind=2&if=1', C4, L3),
  '09': xoops('https://www.boatrace-tsu.com', '/modules/yosou/group-tenji.php?type=group-tenji&day={d}&race={r}&kind=1&if=1', C4, L3),
  '10': xoops('https://www.boatrace-mikuni.jp', '/modules/yosou/group-cyokuzen.php?day={d}&race={r}&kind=2&if=1', C4, L3),
  '11': xoops('https://www.boatrace-biwako.jp', '/modules/yosou/cyokuzen.php?day={d}&race={r}&if=1&kind=2', C4, L3),
  '12': tbk('https://www.boatrace-suminoe.jp', '/asp/kyogi/12/pc/st02{rr}.htm', ['weight', 'tilt', 'ex', 'lap', 'turn'], L2),
  '13': xoops('https://www.boatrace-amagasaki.jp', '/modules/yosou/group-cyokuzen.php?day={d}&race={r}&kind=2&if=1', { ex: 'col5', lap: 'col6', turn: 'col7' }, L2),
  '14': xoops('https://www.boatrace-naruto.jp', '/modules/yosou/group-cyokuzen.php?day={d}&race={r}&kind=2&if=1', C4, L3),
  '18': xoops('https://www.boatrace-tokuyama.jp', '/modules/yosou/tenji.php?day={d}&race={r}&if=1', { ex: 'col10', lap: 'col11', turn: 'col12' }, L2),
  '21': xoops('https://www.boatrace-ashiya.com', '/modules/yosou/group-cyokuzen.php?day={d}&race={r}&kind=2&if=1', { ex: 'col6', lap: 'col7', turn: 'col8', str: 'col9' }, L3),
  '22': xoops('https://www.boatrace-fukuoka.com', '/modules/yosou/tenji_info.php?day={d}&race={r}&if=1', { ex: 'col6', lap: 'col7', turn: 'col8', str: 'col9' }, L3),
  '23': xoops('https://www.boatrace-karatsu.jp', '/modules/yosou/group-cyokuzen.php?day={d}&race={r}&kind=2&if=1', C4, L3),
};

const num = s => { const t = String(s ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim(); return /^-?\d+\.\d+$/.test(t) ? Number(t) : null; };

/* XOOPS 系：艇のブロックは tei_color(N) / imp-num(N) の枠セルで切り、値は td の colN クラスで拾う */
function parseXoops(html, cfg) {
  const out = {};
  /* 枠のクラスは1艇に2回出ることがある（桐生は艇番セルと選手セルの両方）ので、次の「別の枠」までを1ブロックにする */
  const marks = [...html.matchAll(/(?:tei_color|imp-num)(\d)\b/g)].filter(m => m[1] >= '1' && m[1] <= '6');
  for (let i = 0; i < marks.length; i++) {
    const lane = Number(marks[i][1]);
    if (out[lane]) continue;
    let j = i + 1; while (j < marks.length && Number(marks[j][1]) === lane) j++;
    const block = html.slice(marks[i].index, marks[j]?.index ?? html.length);
    const row = {};
    for (const [k, col] of Object.entries(cfg.cells)) {
      /* 同じ colN が2つあるサイトがある（鳴門はチルトと展示が両方 col5）。展示は 5.5〜7.8 秒の値を優先する */
      const vals = [...block.matchAll(new RegExp(`<td[^>]*class=['"][^'"]*\\b${col}\\b[^'"]*['"][^>]*>([\\s\\S]*?)<\\/td>`, 'g'))].map(m => num(m[1]));
      row[k] = k === 'ex' ? (vals.find(v => v != null && v >= 5.5 && v <= 7.8) ?? vals.find(v => v != null) ?? null) : (vals.find(v => v != null) ?? null);
    }
    out[lane] = row;
  }
  return out;
}
/* TBK 系：1艇＝<tbody>。枠は waku0N、値は選手名セルのあとの td を順に */
function parseTbk(html, cfg) {
  const out = {};
  for (const m of html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)) {
    const b = m[1];
    const lane = Number((b.match(/waku0?(\d)/) || [])[1]);
    if (!(lane >= 1 && lane <= 6) || out[lane]) continue;
    const tr = (b.match(/<tr[^>]*>([\s\S]*?)<\/tr>/) || [])[1] || '';
    const after = tr.slice(tr.indexOf('racer_name'));
    const tds = [...after.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => x[1]);   // 選手名セルの開始タグは 'racer_name' より前なので含まれない
    const row = {};
    cfg.cols.forEach((k, i) => { if (k !== 'weight' && k !== 'tilt') row[k] = num(tds[i]); });
    out[lane] = row;
  }
  return out;
}
export function parseOrigEx(jcd, html) {
  const cfg = ORIGEX[jcd]; if (!cfg) return null;
  const boats = cfg.type === 'tbk' ? parseTbk(html, cfg) : parseXoops(html, cfg);
  const keys = Object.keys(cfg.labels);
  const has = Object.values(boats).some(b => keys.some(k => b[k] != null));
  return { published: has, labels: cfg.labels, boats };
}
