/* boatrace.jp（公式Web）のパーサ。当日の直前情報とオッズはここでしか取れない。
   過去の蓄積は公式ダウンロード（od2）側で取るので、ここは「当日ぶん」に徹する。 */
import { text, num } from './bt.mjs';

/* 未公表のセルは '' や &nbsp; になる。0 と区別したいので null を返す */
const nn = v => {
  const t = String(v ?? '').replace(/[^\d.\-]/g, '');
  return t === '' || isNaN(t) ? null : Number(t);
};

const tds = html => [...html.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(m => ({ a: m[1], v: text(m[2]) }));
const tables = html => [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map(m => m[0]);
/* .06 → 0.06、F.01 → −0.01（フライング）、L.02 → 出遅れ */
/* 直前情報の風向アイコン（is-wind1〜16、17＝無風）は水面図基準の相対方位で、
   K ファイルの風向（北・北東… の絶対方位）とは場ごとに回転がずれている。
   標本1,640レース（before.jsonl）で K の風向と突き合わせ、16方位のうち
   もっとも一致する回転量を場ごとに求めた（一致率 69〜98%、風速2m以上で判定）。
   compass16 = (code − 1 + offset) mod 16、0＝北で時計回り。 */
export const WIND_OFFSET = {
  '01': 10, '02': 10, '03': 4, '04': 5, '05': 1, '06': 11, '07': 13, '08': 1, '09': 2, '10': 12, '11': 11, '12': 11,
  '13': 0, '14': 11, '15': 3, '16': 11, '17': 15, '18': 3, '19': 13, '20': 0, '21': 7, '22': 6, '23': 14, '24': 7,
};
const COMPASS8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
/* 風向コード → K と同じ8方位の文字列。無風・不明は '無風' */
export function windCompass(jcd, code) {
  if (!code || code >= 17 || WIND_OFFSET[jcd] == null) return '無風';
  const c16 = (code - 1 + WIND_OFFSET[jcd]) % 16;
  return COMPASS8[Math.round(c16 / 2) % 8];
}

/* 開催情報ページ（raceindex?jcd=&hd=）の日程タブ「9月12日 初日 / 9月13日 ２日目 / … / 9月15日 最終日」から
   節の日数と今日が何日目かを取る。勝ち上がり条件（予選最終日・準優・優勝戦）の判定に使う */
export function parseRaceIndex(html, hd) {
  const t = html.replace(/<[^>]+>/g, '|').replace(/\s+/g, '');
  const year = hd.slice(0, 4);
  const dates = [];
  for (const m of t.matchAll(/(\d{1,2})月(\d{1,2})日\|+(初日|[０-９0-9]+日目|最終日)/g)) {
    dates.push(`${year}${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}`);
  }
  const uniq = [...new Set(dates)];
  if (!uniq.length) return null;
  /* 年またぎ（12月→1月）は前の日付より小さくなったら翌年扱い */
  for (let i = 1; i < uniq.length; i++) if (uniq[i] < uniq[i - 1]) uniq[i] = String(Number(year) + 1) + uniq[i].slice(4);
  const dayIdx = uniq.indexOf(hd) + 1;
  return { days: uniq.length, dayIdx: dayIdx || null, dates: uniq };
}

export function stNum(s) {
  const m = String(s).trim().match(/^([FL])?\.?(\d{1,2})$|^([FL])?(\d\.\d\d)$/);
  if (!m) return { st: null, f: null, l: null };
  const sign = (m[1] || m[3]) === 'F' ? -1 : 1;
  const v = m[4] != null ? Number(m[4]) : Number('0.' + String(m[2]).padStart(2, '0'));
  return { st: sign * v, f: (m[1] || m[3]) === 'F' || null, l: (m[1] || m[3]) === 'L' || null };
}

/* ---- 直前情報（beforeinfo）----
   展示タイム・チルト・プロペラ・部品交換・調整重量・スタート展示（進入隊形とST）・水面気象 */
export function parseBefore(html) {
  const t = tables(html);
  const out = { boats: [], startEx: [], weather: {} };

  /* 1枚目は各レースの締切予定時刻 */
  if (t[0]) {
    const cells = tds(t[0]).map(c => c.v);
    const times = cells.filter(v => /^\d{1,2}:\d{2}$/.test(v));
    if (times.length) out.closes = times;
  }

  /* 2枚目が出走表。1艇 = rowspan で4行ぶん */
  if (t[1]) {
    const chunks = t[1].split(/(?=<td class="is-boatColor\d is-fs14" rowspan="4">)/).slice(1);
    for (const c of chunks) {
      const cs = tds(c);
      const r4 = cs.filter(x => /rowspan="4"/.test(x.a));
      const r2 = cs.filter(x => /rowspan="2"/.test(x.a));
      const toban = (c.match(/profile\?toban=(\d+)/) || [])[1] || null;
      const parts = [...(c.match(/<ul class="labelGroup1">([\s\S]*?)<\/ul>/) || ['', ''])[1]
        .matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(m => text(m[1])).filter(Boolean);
      /* r4 = [枠, 写真(空), 名前, 展示タイム, チルト, プロペラ, 部品交換]、r2 = [体重, 調整重量] */
      out.boats.push({
        lane: num(r4[0]?.v), toban, name: (r4[2]?.v || '').replace(/\s+/g, ''),
        weight: nn(r2[0]?.v),
        ex: nn(r4[3]?.v),                                               // 展示タイム
        tilt: nn(r4[4]?.v),
        prop: r4[5]?.v === '新' || null,                                // プロペラ交換
        parts,                                                          // 部品交換（整備力の手がかり）
        adjust: nn(r2[1]?.v),                                           // 調整重量
      });
    }
  }

  /* 3枚目がスタート展示。行の並びがそのまま進入コース、中の数字が艇番 */
  if (t[2]) {
    for (const m of t[2].matchAll(/<div class="table1_boatImage1">([\s\S]*?)<\/div>/g)) {
      const lane = num((m[1].match(/table1_boatImage1Number[^>]*>(\d)</) || [])[1]);
      const st = (m[1].match(/table1_boatImage1Time[^>]*>([^<]*)</) || [])[1] || '';
      const pos = (m[1].match(/table1_boatImage1Boat"\s*style="left:\s*([\d.]+)%/) || [])[1];
      if (lane) out.startEx.push({ course: out.startEx.length + 1, lane, ...stNum(st), pos: pos ? Number(pos) : null });
    }
  }

  /* 水面気象。風向は場のコース向きに合わせた1〜16の記号なので、番号のまま持つ */
  const w = html.match(/水面気象情報\s*([\d:]+)?現在/);
  if (w) out.weather.at = w[1] || null;
  const pick = (kind, re) => { const m = html.match(re); return m ? m[1] : null; };
  out.weather.temp = nn(pick('気温', /気温<\/span>\s*<span[^>]*>([\d.]+)℃/));
  out.weather.water = nn(pick('水温', /水温<\/span>\s*<span[^>]*>([\d.]+)℃/));
  out.weather.wind = nn(pick('風速', /風速<\/span>\s*<span[^>]*>(\d+)m/));
  out.weather.wave = nn(pick('波高', /波高<\/span>\s*<span[^>]*>(\d+)cm/));
  out.weather.windDir = Number(pick('風向', /weather1_bodyUnitImage is-wind(\d+)/)) || null;
  const sky = text((html.match(/is-weather\d"><\/p>\s*<div class="weather1_bodyUnitLabel">\s*<span[^>]*>([^<]*)</) || [])[1] || '');
  out.weather.sky = sky || null;
  /* 直前情報は各レース約30分前の公表。まだ出ていなければ published:false */
  out.published = out.boats.some(b => b.ex != null) || null;
  return out;
}

/* ---- オッズ ----
   ボートは3連単の全120通りが公式に出る。南関のように単勝から Harville で
   推定する必要がないので、期待値はそのまま実オッズで出せる。 */
export function parseOddsTF(html) {
  const t = tables(html);
  const win = {}, place = {};
  const rowsOf = tb => [...tb.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => tds(r[1]));
  for (const tb of t) {
    const isWin = /単勝オッズ/.test(tb), isPl = /複勝オッズ/.test(tb);
    if (!isWin && !isPl) continue;
    for (const r of rowsOf(tb)) {
      const lane = r.find(c => /is-boatColor\d/.test(c.a));
      if (!lane) continue;
      const l = nn(lane.v);
      const v = r.at(-1).v;
      if (isWin) win[l] = nn(v);
      else { const m = v.match(/([\d.]+)\s*-\s*([\d.]+)/); place[l] = m ? [Number(m[1]), Number(m[2])] : null; }
    }
  }
  return { win, place };
}

/* 3連単 odds3t / 3連複 odds3f。
   1着が列、2着が rowspan="4" のセル、その中で3着が縦に並ぶ。
   rowspan を数えずにセルを頭から3つずつ取ると列がずれる（30通りしか拾えなかった）。 */
function parseGrid(html, cols = 6) {
  const tb = tables(html).find(t => /oddsPoint/.test(t));
  if (!tb) return {};
  const out = {}, second = [];
  for (const r of tb.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = tds(r[1]);
    /* 1列あたり 3セル（2着＋3着＋オッズ）か 2セル（rowspan で2着を持ち越し）。
       セルに rowspan が付くかどうかで判定すると、組が1行しかない列（3連複の 2着=5）で
       ずれて4通り取りこぼす。行全体のセル数で決めるほうが確実。 */
    const per = cells.length / cols;
    if (per !== 2 && per !== 3) continue;
    for (let c = 0; c < cols; c++) {
      const off = c * per;
      if (per === 3) second[c] = cells[off].v;
      const third = cells[off + per - 2]?.v, o = cells[off + per - 1]?.v;
      if (!/^[1-6]$/.test(second[c] || '') || !/^[1-6]$/.test(third || '')) continue;
      const v = nn(o);
      if (v != null) out[`${c + 1}-${second[c]}-${third}`] = v;
    }
  }
  return out;
}
export const parseOdds3T = html => parseGrid(html);
/* 3連複は順不同なので 1=2=3 の形にそろえる */
export function parseOdds3F(html) {
  const out = {};
  for (const [k, v] of Object.entries(parseGrid(html))) {
    out[k.split('-').map(Number).sort((a, b) => a - b).join('=')] = v;
  }
  return out;
}
