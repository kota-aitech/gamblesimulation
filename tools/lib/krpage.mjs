/* 楽天Kドリームスのページを読む。
     parseDay(html)                … 日付の一覧 → [{slug, raceId}]
     parseRace(html, slug, raceId) … レース詳細 → 1レース1オブジェクト（races.jsonl の1行）
   raceId は 16桁＝場2＋初日8＋日目2＋"00"＋R2。実際の開催日はページの「YYYY年MM月DD日 レース詳細」から取る。
   表はどれも行が <tr class="nX"> で車番ごとに並ぶ（7車立てなら n1〜n7、9車立てなら n1〜n9）。枠番のセルは rowspan で抜けることがある。 */
import { text, num, zen, venueBySlug, regionOf } from './kr.mjs';

export function parseDay(html) {
  const out = [], seen = new Set();
  for (const m of html.matchAll(/https:\/\/keirin\.kdreams\.jp\/([a-z]+)\/racedetail\/(\d{16})\//g)) {
    const k = m[2]; if (seen.has(k)) continue; seen.add(k);
    out.push({ slug: m[1], raceId: k });
  }
  return out;
}

const cells = tr => [...tr.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map(m => ({ attr: m[1], html: m[2], t: text(m[2]) }));
const rowsOf = tbl => [...tbl.matchAll(/<tr class="n(\d+)\s*"[^>]*>([\s\S]*?)<\/tr>/g)].map(m => ({ no: +m[1], html: m[2] }));
const tablesOf = html => [...html.matchAll(/<table class="racecard_table([^"]*)"[\s\S]*?<\/table>/g)].map(m => ({ cls: m[1], html: m[0] }));
const riderCell = cs => cs.find(c => /class="rider/.test(c.attr));
const prefOf = s => zen(s).replace(/[\s　]/g, '');

/* 選手名・府県/年齢/期別 */
function riderOf(c) {
  const name = text(c.html.split(/<br\s*\/?>/i)[0]).replace(/\s+/g, ' ');
  const home = text((c.html.match(/<span class="home">([\s\S]*?)<\/span>/) || [])[1] || '');
  const [pref, age, term] = home.split('/').map(s => s.trim());
  return { name, pref: prefOf(pref || ''), age: num(age), term: num(term) };
}

export function parseRace(html, slug, raceId) {
  const V = venueBySlug[slug] || { slug, name: slug };
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const dm = body.match(/(\d{4})年(\d{2})月(\d{2})日 レース詳細/);
  const date = dm ? `${dm[1]}${dm[2]}${dm[3]}` : null;
  const r = +raceId.slice(-2), day = +raceId.slice(10, 12), start8 = raceId.slice(2, 10);
  const hdr = (body.match(/<div class="racecard_header">([\s\S]*?)<div class="racecard_nav-wrapper">/) || [])[1] || '';
  const title = text((hdr.match(/<h2 class="title">([\s\S]*?)<span/) || [])[1] || '');
  const kind = text((hdr.match(/<span class="status">([\s\S]*?)<\/span>/) || [])[1] || '');
  const tm = [...hdr.matchAll(/<dd>(\d{1,2}:\d{2})<\/dd>/g)].map(m => m[1]);
  const cond = text((hdr.match(/勝ち上がり条件：<\/dt>\s*<dd>([\s\S]*?)<\/dd>/) || [])[1] || '');
  /* 開催名とグレード（F1/F2/G3/G2/G1/GP）。見出しの帯（「Ｆ２」の後に開催名） */
  const gm = body.match(/<(?:p|span|dt|div)[^>]*class="[^"]*grade[^"]*"[^>]*>([\s\S]*?)<\/(?:p|span|dt|div)>/);
  let grade = gm ? zen(text(gm[1])) : null;
  if (!grade || !/^(F1|F2|G1|G2|G3|GP)$/.test(grade)) { const m2 = zen(text(body.slice(0, body.indexOf('開催日：') > 0 ? body.indexOf('開催日：') : 0))).match(/\b(GP|G1|G2|G3|F1|F2)\b/g); grade = m2 ? m2.at(-1) : null; }
  const meetName = (() => { const i = body.indexOf('開催日：'); if (i < 0) return null; const seg = text(body.slice(Math.max(0, i - 1500), i)); const m = seg.match(/(?:GP|G1|G2|G3|F1|F2|ＧＰ|Ｇ１|Ｇ２|Ｇ３|Ｆ１|Ｆ２)\s+(.+?)\s+プログラム/); return m ? m[1].trim() : null; })();
  const bank = num((body.match(/同走路年間勝利度数【(\d+)】/) || [])[1]);
  const reporter = text((hdr.match(/予想担当記者：<\/dt>\s*<dd>([\s\S]*?)<\/dd>/) || [])[1] || '') || null;

  const T = tablesOf(body);
  const riders = new Map();
  const R = no => riders.get(no) || riders.set(no, { no }).get(no);
  /* 1) 出走表：印・好気合・総評・枠・車番・選手・級班・脚質・ギヤ・競走得点・S・B・逃・捲・差・マ・1着・2着・3着・着外・勝率・2連対率・3連対率 */
  if (T[0]) for (const row of rowsOf(T[0].html)) {
    const cs = cells(row.html), rc = riderCell(cs); if (!rc) continue;
    const ri = cs.indexOf(rc), h = R(row.no);
    Object.assign(h, riderOf(rc));
    h.tip = text((cs.find(c => /class="tip/.test(c.attr)) || {}).html || '') || null;
    h.kiai = text((cs.find(c => /class="kiai/.test(c.attr)) || {}).html || '') || null;
    h.eval = num(text((cs.find(c => /class="evaluation/.test(c.attr)) || {}).html || ''));
    const br = cs.find(c => /class="bracket/.test(c.attr)); if (br) h.waku = num(br.t);
    const v = cs.slice(ri + 1).map(c => c.t);
    [h.cls, h.style] = [v[0] || null, v[1] || null];
    h.gear = num(v[2]); h.score = num(v[3]);
    [h.S, h.B, h.nige, h.makuri, h.sashi, h.mark, h.w1, h.w2, h.w3, h.wx] = v.slice(4, 14).map(num);
    [h.winRate, h.q2, h.q3] = v.slice(14, 17).map(num);
  }
  /* 枠番の rowspan を埋める（抜けた行は直前の枠） */
  { let w = null; for (const no of [...riders.keys()].sort((a, b) => a - b)) { const h = riders.get(no); if (h.waku != null) w = h.waku; else h.waku = w; } }
  for (const t of T.slice(1)) {
    const hd = text(t.html.slice(0, t.html.indexOf('<tr class="n')));
    for (const row of rowsOf(t.html)) {
      const cs = cells(row.html), rc = riderCell(cs); if (!rc) continue;
      const h = R(row.no), ri = cs.indexOf(rc), v = cs.slice(ri + 1).map(c => c.t);
      if (/選手コメント/.test(hd)) {
        h.comment = text((cs.find(c => /class="comment/.test(c.attr)) || {}).html || '') || null;
      } else if (/今場所成績/.test(hd)) {
        /* 今場所・前場所・前々場所：開催場＋グレード、各日の 日付/種目/着順/上り */
        const meets = cs.slice(ri + 2).map(c => {
          const st = zen(text((c.html.match(/<p class="stadium">([\s\S]*?)<\/p>/) || [])[1] || ''));
          const runs = [...c.html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => {
            const sp = [...m[1].matchAll(/<span>([\s\S]*?)<\/span>/g)].map(x => text(x[1]));
            const pos = (sp[2] || '').match(/^(\d+)着/);
            const vid = m[1].match(/kyogijoCd=(\d+)&gradeCd=\d+&kaisaiDate=(\d{8})&raceNo=(\d+)/);
            return { kind: zen(sp[1] || '') || null, pos: pos ? +pos[1] : (sp[2] || null), agari: num(sp[3]), jcd: vid ? vid[1] : null, date: vid ? vid[2] : null, r: vid ? +vid[3] : null };
          });
          const [vn, gr] = st.split(/\s+/);
          return { venue: vn || null, grade: gr || null, runs };
        });
        [h.cur, h.prev1, h.prev2] = meets;
      } else if (/年間勝利度数|決勝/.test(hd) && v.length >= 20) {
        /* 年間勝利度数：決勝・特選・準決・予選 × 1着・2着・3着・着外 */
        const n = v.slice(4, 20).map(num);
        h.year = { final: n.slice(0, 4), special: n.slice(4, 8), semi: n.slice(8, 12), pre: n.slice(12, 16) };
      } else if (/同走路/.test(hd)) h.bankRec = v.slice(4, 8).map(num);
      else if (/当所/.test(hd)) h.venueRec = v.slice(4, 8).map(num);
    }
  }
  /* 並び予想：<span class="icon_p"><span class="p00N">車番</span><span class="p1xx">役割</span></span>、空きの icon_p space がラインの区切り */
  const line = [];
  const lp = (body.match(/<div class="line_position">([\s\S]*?)<\/div>/) || [])[1];
  if (lp) {
    let cur = [];
    for (const m of lp.matchAll(/<span class="icon_p( space)?">([\s\S]*?)<\/span>\s*(?=<span class="icon_p|$)/g)) {
      if (m[1]) { if (cur.length) { line.push(cur); cur = []; } continue; }
      const no = num(text((m[2].match(/<span class="p0\d\d">([\s\S]*?)<\/span>/) || [])[1] || ''));
      const role = text((m[2].match(/<span class="p[12]\d\d">([\s\S]*?)<\/span>/) || [])[1] || '');
      if (no) cur.push({ no, role });
    }
    if (cur.length) line.push(cur);
  }
  const review = text((body.match(/<p class="racereview">([\s\S]*?)<\/p>/) || [])[1] || '');
  /* 結果 */
  let result = null;
  const rs = body.match(/<div class="yosou-odds-result_contents[^"]*" id="JS_CONTENTS_RESULT"\s*>([\s\S]*?)<div class="refund_table_area">/);
  if (rs) {
    const wx = text((rs[1].match(/<p class="weather">([\s\S]*?)<\/p>/) || [])[1] || '');
    const wm = wx.match(/天候\s*(\S+?)\s*\/\s*風速\s*([\d.]+)m/);
    const order = [];
    const rt = (rs[1].match(/<table class="result_table">([\s\S]*?)<\/table>/) || [])[1] || '';
    for (const tr of rt.split(/<tr>/).slice(2)) {
      const cs = cells(tr); if (cs.length < 8) continue;
      const no = num(text((cs[2].html.match(/<span[^>]*>(\d+)<\/span>/) || [])[1] || cs[2].t));
      const p = cs[1].t;
      order.push({ pos: /^\d+$/.test(p) ? +p : p || null, no, diff: cs[4].t || null, agari: num(cs[5].t), kimarite: cs[6].t || null, sb: cs[7].t || null, why: cs[8] ? cs[8].t || null : null });
    }
    if (order.length) result = { weather: wm ? wm[1] : null, wind: wm ? +wm[2] : null, order };
  }
  /* 払戻（結果がある時だけ）。表の並びは固定：1行目＝2枠複・2車複・3連複（＋ワイド）、2行目＝2枠単・2車単・3連単。
     各セルの <dt> が組番、<dd> が「金額円(人気)」。未発売は dd が無い。同着はセルに dl が複数並ぶ */
  let pay = null;
  const rf = (body.match(/<table class="refund_table">([\s\S]*?)<\/table>/) || [])[1];
  if (rf && result) {
    pay = {};
    const dlOf = h => [...h.matchAll(/<dt>([\s\S]*?)<\/dt>\s*(?:<dd>([\s\S]*?)<\/dd>)?/g)]
      .map(m => ({ c: zen(text(m[1])).replace(/=/g, '-'), y: num(text((m[2] || '').replace(/<span>[\s\S]*?<\/span>/, ''))), pop: num((text(m[2] || '').match(/\((\d+)\)/) || [])[1]) }))
      .filter(x => x.y != null);
    const slots = [...rf.matchAll(/<td>(複|単)<\/td>\s*<td>([\s\S]*?)<\/td>/g)].map(m => [m[1], m[2]]);
    const KEYS = { 複: ['bq', 'q2', 'q3'], 単: ['be', 'e2', 'e3'] }, k = { 複: 0, 単: 0 };
    for (const [t, h] of slots) { const key = KEYS[t][k[t]++]; const d = dlOf(h); if (key && d.length) pay[key] = d; }
    const wd = (rf.match(/<td rowspan="2" class="wide">([\s\S]*?)<\/td>/) || [])[1];
    if (wd) { const d = dlOf(wd); if (d.length) pay.wide = d; }
  }
  /* オッズ（確定または発売中）。3連単は1着ごとの表（列＝2着・行＝3着）、2車単は列＝1着・行＝2着、3連複・2車複は人気順の一覧 */
  const odds = {};
  const oc = k => { const i = body.indexOf(`id="JS_ODDSCONTENTS_${k}"`); if (i < 0) return ''; const j = body.indexOf('<div class="odds_contents', i + 30); return body.slice(i, j > 0 ? j : i + 60000); };
  const n = riders.size;
  {
    const s = oc('3rentan'), tri = {};
    for (const tm2 of s.matchAll(/<table class="odds_table bt\d[^"]*">([\s\S]*?)<\/table>/g)) {
      const t = tm2[1];
      const first = num((t.match(/<span class="number">(\d+)<\/span>/) || [])[1]); if (!first) continue;
      const hdrRow = t.split(/<tr>/)[2] || '';
      const colNos = [...hdrRow.matchAll(/<th class="n(\d+)">/g)].map(m => +m[1]);
      for (const tr of t.split(/<tr>/).slice(4)) {
        const th = tr.match(/^\s*<th class="n(\d+)">/); if (!th) continue;
        const third = +th[1];
        const tds = [...tr.matchAll(/<td(?: class="([^"]*)")?>([\s\S]*?)<\/td>/g)];
        tds.forEach((m, ci) => { const sec = colNos[ci]; const v = num(text(m[2])); if (sec && v && sec !== third && sec !== first) tri[`${first}-${sec}-${third}`] = v; });
      }
    }
    if (Object.keys(tri).length) odds.e3 = tri;
  }
  {
    const s = oc('2shatan'), ex = {};
    const t = (s.match(/<table class="odds_table">([\s\S]*?)<\/table>/) || [])[1] || '';
    const colNos = [...(t.split(/<tr>/)[1] || '').matchAll(/<th class="n(\d+)">/g)].map(m => +m[1]);
    for (const tr of t.split(/<tr>/).slice(3)) {
      const th = tr.match(/^\s*<th class="n(\d+)">/); if (!th) continue;
      const sec = +th[1];
      [...tr.matchAll(/<td(?: class="([^"]*)")?>([\s\S]*?)<\/td>/g)].forEach((m, ci) => { const fst = colNos[ci], v = num(text(m[2])); if (fst && v && fst !== sec) ex[`${fst}-${sec}`] = v; });
    }
    if (Object.keys(ex).length) odds.e2 = ex;
  }
  const popList = k => { const s = oc(k), p = s.indexOf('oddspop_table_wrapper'), o = {}; if (p < 0) return null; for (const m of s.slice(p).matchAll(/<span class="num">([^<]+)<\/span><span class="odds">([^<]+)<\/span>/g)) { const v = num(m[2].split('～')[0]); if (v) o[zen(m[1]).replace(/=/g, '-')] = m[2].includes('～') ? [v, num(m[2].split('～')[1])] : v; } return Object.keys(o).length ? o : null; };
  const q3 = popList('3renhuku'), q2 = popList('2shahuku'), wd = popList('wide');
  if (q3) odds.q3 = q3; if (q2) odds.q2 = q2; if (wd) odds.wide = wd;
  const confirmed = /icon_confirmed">確定オッズ/.test(body);
  const oddsAt = (body.match(/<p class="time">(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2})現在<\/p>/) || [])[1] || null;

  const list = [...riders.values()].filter(h => h.name).sort((a, b) => a.no - b.no);
  for (const h of list) h.region = regionOf(h.pref);
  /* 欠車：出走表にいて結果に着順が無い（「欠」）選手。結果が無い段階では出走表のまま */
  return {
    raceId, date, venue: V.name, slug, jcd: raceId.slice(0, 2), start8, day, r, title: title || null, kind: zen(kind) || null, cond: cond || null, grade, meetName, bank,
    post: tm[0] || null, close: tm[1] || null, reporter, n: list.length,
    riders: list, line: line.map(l => l.map(x => x.no)), lineRole: line.map(l => l.map(x => x.role)), review: review && !/ありません/.test(review) ? review : null,
    result, pay, odds: Object.keys(odds).length ? odds : null, oddsConfirmed: confirmed, oddsAt,
  };
}
