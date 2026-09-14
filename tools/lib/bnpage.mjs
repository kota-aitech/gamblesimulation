/* keiba.go.jp（地方競馬情報サイト）のパーサ。ばんえい（帯広）用。
   ページは UTF-8 の素直な HTML。表は <tr class="tBorder"> で1頭（出馬表は1頭＝5行）。 */
import { text, num, zen } from './bn.mjs';

const tds = html => [...html.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(m => ({ a: m[1], v: text(m[2]), raw: m[2] }));
const rows = html => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
const tables = html => [...html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/g)].map(m => m[0]);
const timeSec = t => { const m = String(t || '').match(/(\d+):(\d\d\.\d)/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const ymdFromParam = s => { const m = String(s || '').replace(/%2F/gi, '/').match(/(\d{4})\/(\d{2})\/(\d{2})/); return m ? m[1] + m[2] + m[3] : null; };

/* ---- 月別開催日程：帯広ば の行にある RaceList リンクの日付 ---- */
export function parseMonthly(html) {
  const i = html.indexOf('<td>帯広ば</td>');
  if (i < 0) return [];
  const row = html.slice(i, html.indexOf('</tr>', i));
  return [...new Set([...row.matchAll(/k_raceDate=([^"&]+)/g)].map(m => ymdFromParam(m[1])).filter(Boolean))].sort();
}

/* ---- 当日メニュー：レース一覧（発走・競走名・天候・馬場水分・頭数）と変更情報（出走取消） ---- */
export function parseRaceList(html, ymd) {
  const out = { date: ymd, races: [], changes: [] };
  const tb = tables(html).find(t => /競走名・出馬表/.test(t));
  if (tb) {
    for (const r of rows(tb)) {
      const c = tds(r);
      if (c.length < 8) continue;
      const rn = num((c[0].v.match(/(\d+)R/) || [])[1]);
      if (!rn) continue;
      const kind = c[3].v;                         // 特別／重賞 など
      out.races.push({
        r: rn, start: (c[1].v.match(/\d{1,2}:\d{2}/) || [])[0] || null, kind: kind || null,
        name: zen(c[4].v), dist: num((c[5].v.match(/(\d+)m/) || [])[1]), weather: c[6].v || null,
        moist: num(c[7].v), n: num(c[8]?.v),
      });
    }
  }
  const ch = tables(html).find(t => /変更区分/.test(t));
  if (ch) for (const r of rows(ch)) {
    const c = tds(r);
    if (c.length < 5) continue;
    const rn = num((c[0].v.match(/(\d+)R/) || [])[1]); if (!rn) continue;
    out.changes.push({ r: rn, no: num(c[1].v), name: c[2].v, kind: c[3].v, reason: c[4].v, detail: c[5]?.v || null });
  }
  return out;
}

/* レース見出し（出馬表・成績で共通）：競走名・条件文・天候・馬場水分・賞金 */
function parseHead(html) {
  const h = { name: null, cond: null, weather: null, moist: null, dist: null, prize: [] };
  const h3 = html.match(/<section class="raceTitle">[\s\S]*?<h3>([\s\S]*?)<\/h3>/);
  if (h3) h.name = zen(text(h3[1]));
  const li = (html.match(/<ul class="dataArea">([\s\S]*?)<\/ul>/) || ['', ''])[1];
  const items = [...li.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => text(m[1]));
  if (items[0]) {
    h.cond = zen(items[0]);
    h.weather = (items[0].match(/天候：(\S+)/) || [])[1] || null;
    h.moist = num((items[0].match(/馬場：([\d.]+)/) || [])[1]);
    h.dist = num((items[0].match(/(\d+)ｍ|(\d+)m/) || []).slice(1).find(Boolean));
  }
  if (items[1]) h.prize = [...items[1].matchAll(/(\d)着([\d,]+)円/g)].map(m => num(m[2]));
  const st = html.match(/第(\d+)競走\s*(\d{1,2}:\d{2})発走/);
  h.start = st ? st[2] : null;
  const grade = html.match(/<p class="subTitle">([\s\S]*?)<\/p>/);
  h.sub = grade ? zen(text(grade[1])) || null : null;
  return h;
}

/* ---- 競走成績（RaceMarkTable）---- */
export function parseResult(html, ymd, r) {
  const head = parseHead(html);
  const out = { raceId: `${ymd}${String(r).padStart(2, '0')}`, date: ymd, r, ...head, entries: [], pay: {} };
  const tb = html.match(/<section class="gradeTable">([\s\S]*?)<\/section>/);
  if (tb) for (const row of rows(tb[1])) {
    if (!/class="tBorder"|courseNum/.test(row) && !/horseName/.test(row)) continue;
    const c = tds(row);
    if (c.length < 14) continue;
    const posTxt = c[0].v, pos = /^\d+$/.test(posTxt) ? Number(posTxt) : null;
    const sa = c[5].v.replace(/\s/g, '');
    out.entries.push({
      pos, posTxt: pos == null ? posTxt : undefined,
      waku: num(c[1].v), no: num(c[2].v), name: c[3].v.replace(/\s/g, ''), horseId: (c[3].raw.match(/k_lineageLoginCode=(\d+)/) || [])[1] || null,
      belong: c[4].v, sexAge: sa, load: num(c[6].v),
      jockey: c[7].v.replace(/（.*?）/, '').replace(/\s/g, ''), jockeyId: (c[7].raw.match(/k_riderLicenseNo=(\d+)/) || [])[1] || null,
      trainer: c[8].v.replace(/\s/g, ''), trainerId: (c[8].raw.match(/k_trainerLicenseNo=(\d+)/) || [])[1] || null,
      bw: num((c[9].v.match(/^(\d+)/) || [])[1]), bwDiff: (m => m ? Number(m[1]) : null)(c[9].v.match(/\(([+-]?\d+)\)/)),
      time: timeSec(c[10].v), margin: c[11].v || null, pop: num(c[13].v), odds: num(c[14].v),
    });
  }
  /* 払戻：「単勝 1 380円 2人気 複勝 1 150円 4人気 4 120円 1人気 …」 */
  const KIND = { '単勝': 'win', '複勝': 'place', '枠連複': 'wakuren', '馬連複': 'umaren', '馬連単': 'umatan', 'ワイド': 'wide', '三連複': 'sanpuku', '三連単': 'santan' };
  const ps = html.indexOf('払戻金');
  if (ps >= 0) {
    const pt = text(html.slice(ps, html.indexOf('優勝馬情報', ps) > 0 ? html.indexOf('優勝馬情報', ps) : ps + 6000));
    for (const m of pt.matchAll(/(単勝|複勝|枠連複|馬連複|馬連単|ワイド|三連複|三連単)((?:\s*[\d\-]+\s*[\d,]+円(?:\s*\d+人気)?)+)/g)) {
      const rowsP = [...m[2].matchAll(/([\d\-]+)\s*([\d,]+)円(?:\s*(\d+)人気)?/g)].map(x => ({ c: x[1], y: num(x[2]), pop: x[3] ? Number(x[3]) : null }));
      if (rowsP.length) out.pay[KIND[m[1]]] = rowsP;
    }
  }
  /* 優勝馬の血統・馬主（勝ち馬だけ。全頭ぶんは出馬表から） */
  const wi = html.indexOf('優勝馬情報');
  if (wi >= 0) {
    const wt = text(html.slice(wi, wi + 6000));
    const pk = re => { const m = wt.match(re); return m ? m[1].replace(/\s/g, '') : null; };
    out.winner = { sire: pk(/父\s+(\S+(?:\s\S+)*?)\s+父父/), dam: pk(/\s母\s+(\S+(?:\s\S+)*?)\s+母父/), damsire: pk(/母父\s+(\S+(?:\s\S+)*?)\s+母母/), owner: pk(/馬主\s+(.+?)\s+中央収得賞金/), breeder: pk(/生産牧場\s+(.+?)\s+中央付加賞金/) };
  }
  return out;
}

/* ---- 出馬表（DebaTable）：1頭＝5行 ----
   1行目 枠・馬番・馬名・騎手・オッズ(人気)・着別成績・前5走（着順 日付 馬場水分 頭数 / 場 距離 馬番）
   2行目 性齢・毛色・生年月日・「☆ 積載 着別」・前5走の競走名（リンクに日付とレース番号）
   3行目 父・調教師・馬体重(増減)・前5走の「人気 馬体重 騎手 積載」
   4行目 母・馬主・前5走のタイム
   5行目 （母父）・生産牧場・変更情報・前5走の「着差 勝ち馬（または2着馬）」 */
export function parseCard(html, ymd, r) {
  const head = parseHead(html);
  const out = { raceId: `${ymd}${String(r).padStart(2, '0')}`, date: ymd, r, ...head, entries: [] };
  const sec = html.match(/<section class="cardTable">([\s\S]*?)<\/section>/);
  if (!sec) return out;
  const blocks = sec[1].split(/<tr class="tBorder">/).slice(1);
  for (const b0 of blocks) {
    /* 着別成績のセルは入れ子の <table>（全／場／距 の行）。先に抜いておかないと行の切り方が崩れる */
    let arrival = '';
    const b = b0.replace(/<table class="arrival[\s\S]*?<\/table>/, m => { arrival = m; return ''; });
    const rs = rows('<tr>' + b).slice(0, 5).map(x => tds(x));
    const [r0, r2, r3, r4, r5] = rs;
    if (!r0 || r0.length < 8) continue;
    /* 同じ枠の2頭目は枠のセル（rowspan）が無い。直前の馬の枠を引き継ぐ */
    let waku;
    let r1 = r0;
    if (/courseNum/.test(r0[0].a)) waku = num(r0[0].v); else { waku = out.entries.at(-1)?.waku ?? null; r1 = [{ a: '', v: '', raw: '' }, ...r0]; }
    const e = {
      waku, no: num(r1[1].v), name: r1[2].v.replace(/\s/g, ''), horseId: (r1[2].raw.match(/k_lineageLoginCode=(\d+)/) || [])[1] || null,
      jockey: r1[3].v.replace(/（.*?）/, '').replace(/\s/g, ''), jockeyId: (r1[3].raw.match(/k_riderLicenseNo=(\d+)/) || [])[1] || null,
      odds: num((r1[4].v.match(/([\d.]+)/) || [])[1]), pop: num((r1[4].v.match(/(\d+)人気/) || [])[1]),
    };
    /* 着別成績：「全 1- 1- 1- 10」= 1着-2着-3着-着外、「場」「距」も同じ形 */
    for (const [key, label] of [['recAll', '全'], ['recVenue', '場'], ['recDist', '距']]) {
      const m = arrival.match(new RegExp(`<td>${label}[\\s\\S]*?<\\/tr>`));
      if (m) { const nums = text(m[0]).replace(label, '').split(/-\s*/).map(num); if (nums.length >= 4 && nums.every(v => v != null)) e[key] = nums.slice(0, 4); }
    }
    if (r2) {
      e.sexAge = r2[0].v.replace(/\s/g, ''); e.color = r2[1].v; e.birth = r2[2].v.replace(/生$/, '');
      const ld = r2[3].v.match(/(☆|▲|△|★)?\s*(\d{3,4})\s*([\d-]+)?/);
      if (ld) { e.apprentice = ld[1] || null; e.load = num(ld[2]); e.recMisc = ld[3] || null; }
    }
    if (r3) {
      e.sire = r3[0].v.replace(/\s/g, ''); e.trainer = r3[1].v.replace(/（.*?）/, '').replace(/\s/g, ''); e.trainerId = (r3[1].raw.match(/k_trainerLicenseNo=(\d+)/) || [])[1] || null;
      e.bw = num((r3[2].v.match(/^(\d+)/) || [])[1]); e.bwDiff = (m => m ? Number(m[1]) : null)(r3[2].v.match(/\(([+-]?\d+)\)/));
    }
    if (r4) { e.dam = r4[0].v.replace(/\s/g, ''); e.owner = r4[1].v.replace(/\s/g, ''); }
    if (r5) { e.damsire = r5[0].v.replace(/[（）()\s]/g, '') || null; e.breeder = r5[1].v.replace(/\s/g, ''); e.info = r5[2]?.v || null; e.scratch = /取消|除外/.test(e.info || '') || null; }
    /* 前5走：1行目の末尾5セル、2〜5行目の末尾5セル */
    const past = [];
    for (let i = 0; i < 5; i++) {
      const c1 = r1[r1.length - 5 + i], c2 = r2?.[r2.length - 5 + i], c3 = r3?.[r3.length - 5 + i], c4 = r4?.[r4.length - 5 + i], c5 = r5?.[r5.length - 5 + i];
      if (!c1 || !/pastRank/.test(c1.raw)) continue;
      const m1 = c1.v.match(/^(\S+)\s+(\d\d)\.(\d\d)\.(\d\d)\s+([\d.]+)\s+(\d+)頭\s+(\S+)\s+(\S+)\s+(\d+)番/);
      if (!m1) continue;
      const href = c2 ? (c2.raw.match(/k_raceDate=([^"&]+)&k_raceNo=(\d+)/) || []) : [];
      const m3 = c3 ? c3.v.match(/(\d+)人\s+(\d+)\s+(\S+)\s+(\d+)/) : null;
      const m5 = c5 ? c5.v.match(/^([\d.]+)\s*(\S*)/) : null;
      past.push({
        pos: /^\d+$/.test(m1[1]) ? Number(m1[1]) : null, posTxt: m1[1], date: `20${m1[2]}${m1[3]}${m1[4]}`, moist: Number(m1[5]), n: Number(m1[6]), venue: m1[7], dist: num((m1[8].match(/(\d+)/) || [])[1]), no: Number(m1[9]),
        raceId: href[1] ? `${ymdFromParam(href[1])}${String(href[2]).padStart(2, '0')}` : null, name: c2 ? zen(c2.v) : null,
        pop: m3 ? Number(m3[1]) : null, bw: m3 ? Number(m3[2]) : null, jockey: m3 ? m3[3] : null, load: m3 ? Number(m3[4]) : null,
        time: c4 ? timeSec(c4.v) : null, diff: m5 && m5[1] ? Number(m5[1]) : null, rival: m5 ? m5[2] || null : null,
      });
    }
    e.past = past;
    out.entries.push(e);
  }
  return out;
}
