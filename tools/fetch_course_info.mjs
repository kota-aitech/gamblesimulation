/* 競馬場のコースの形（公式ページ）→ data/nankan/course.json・data/jra/course.json（コミット対象）
   競馬場ガイド（hbank.html）用。形は変わらないので月1で十分（キャッシュ 30日）。どちらも Shift_JIS。
     南関 nankankeiba.com /course_info/{場2}.do … 回り・内外コース・一周距離・幅員・見どころの文・距離別レコード
     中央 jra.go.jp /facilities/race/{場}/course/ … 芝・ダート（・障害）の 一周距離・幅員・直線距離・高低差・発走距離、コース紹介の文
   JRA は Referer と Accept が無いと Forbidden ページを返す（CLAUDE.md の含水率の節と同じ） */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'cache', 'course');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;
async function get(url, referer) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex').slice(0, 24) + '.html');
  if (fs.existsSync(f) && (Date.now() - fs.statSync(f).mtimeMs) / 86400000 < 30) return fs.readFileSync(f, 'utf8');
  const gap = Date.now() - last; if (gap < 1500) await sleep(1500 - gap); last = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = new TextDecoder('shift_jis').decode(await res.arrayBuffer());
  if (/Forbidden/.test(body) && body.length < 3000) throw new Error('Forbidden');
  fs.writeFileSync(f, body);
  return body;
}
const text = h => String(h ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const num = s => { const m = String(s || '').replace(/,/g, '').match(/[\d.]+/); return m ? +m[0] : null; };
const write = (rel, obj) => { fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(obj)); console.error(`-> ${rel}`); };

/* ---- 南関 ---- */
const NK = [['18', '浦和', 'urawa'], ['19', '船橋', 'funabashi'], ['20', '大井', 'oi'], ['21', '川崎', 'kawasaki']];
const nk = {};
for (const [code, name, key] of NK) {
  try {
    const h = (await get(`https://www.nankankeiba.com/course_info/${code}.do`, 'https://www.nankankeiba.com/course_menu/course.do')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    const t = text(h);
    const i = t.indexOf('コース概略'), j = t.indexOf('コース距離別成績', i);
    const body = i >= 0 ? t.slice(i + 5, j > 0 ? j : i + 1500) : '';
    /* 「右回り 内コース ダート 右回り 一周距離 1,400m 幅員 25m」の並びを拾う */
    const courses = [...body.matchAll(/(内|外|本)?コース\s*(ダート|芝)\s*(右回り|左回り)\s*一周距離\s*([\d,]+)m\s*幅員\s*([\d.～~〜-]+)m/g)].map(m => ({ inout: m[1] === '本' ? null : m[1] || null, surface: m[2], turn: m[3], len: num(m[4]), width: m[5] }));
    const notes = body.replace(/(内|外|本)?コース\s*(ダート|芝)\s*(右回り|左回り)\s*一周距離\s*[\d,]+m\s*幅員\s*[\d.～~〜-]+m/g, '').replace(/(右回り|左回り)\s+/g, ' ').split(/(?<=。)/).map(s => s.trim()).filter(s => s.length > 8 && !/基準タイム|ご了承|レコードを表示/.test(s));
    const straight = [...body.matchAll(/(?:直線|ホームストレッチ)\D{0,6}?([\d,]+)メートル/g)].map(m => num(m[1]));
    const recs = [...t.slice(j).matchAll(/(\d{3,4})m\s*(?:\((内|外)\)\s*)?(?:※\d\s*)?(\d:\d{2}\.\d|\d{2}\.\d)\s+(\S+)\s+(\S+(?:\s\S+)?)\s+(\d{4}\/\d{1,2}\/\d{1,2})/g)].slice(0, 20).map(m => ({ dist: +m[1], inout: m[2] || null, time: m[3], horse: m[4], date: m[6] }));
    nk[key] = { code, name, courses, straight: straight.length ? Math.max(...straight) : null, notes: [...new Set(notes)].slice(0, 4), records: recs, src: `https://www.nankankeiba.com/course_info/${code}.do` };
    console.error(`${name}: コース ${courses.length}・直線 ${nk[key].straight}m・レコード ${recs.length}`);
  } catch (e) { console.error(`! ${name} ${e.message}`); }
}
/* 地方競馬の公式サイト keiba.go.jp の「コース一覧」：全地方競馬場の 回り・1周距離・直線距離（ゴールまで）・幅員・高低差・フルゲート。
   nankankeiba のページには直線が大井しか書かれていないので、直線はこちらを使う。帯広（ばんえい）の形（直線200m・障害の高さ）もここ（UTF-8） */
const NAR = {};
{
  const gap = Date.now() - last; if (gap < 1500) await sleep(1500 - gap);
  const f = path.join(CACHE, 'nar_course.html');
  let h;
  if (fs.existsSync(f) && (Date.now() - fs.statSync(f).mtimeMs) / 86400000 < 30) h = fs.readFileSync(f, 'utf8');
  else { const res = await fetch('https://www.keiba.go.jp/guide/course/', { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(30000) }); h = await res.text(); fs.writeFileSync(f, h); last = Date.now(); }
  const IDS = { uraw: '浦和', funa: '船橋', ooi: '大井', kawa: '川崎', obi: '帯広' };
  for (const [id, name] of Object.entries(IDS)) {
    const i = h.indexOf(`id="course_${id}"`); if (i < 0) continue;
    const j = h.indexOf('id="course_', i + 20), t = text(h.slice(i, j > 0 ? j : i + 6000).replace(/^[^>]*>/, ''));
    const field = k => { const m = t.match(new RegExp(k + '\\s+(.*?)\\s+(?:回り|1周距離|直線距離|全長|幅員|高低差|フルゲート|$)')); return m ? m[1].trim() : null; };
    const st = field('直線距離');
    /* 「外回りコース(右)／486m （ゴールまで386m）」「300m（ゴールまで220m）」を分解 */
    const straight = st ? [...st.matchAll(/(?:([^／\s]*コース(?:\([右左]\))?)／)?\s*([\d,]+)m\s*（ゴールまで([\d,]+)m）/g)].map(m => ({ course: m[1] || null, full: num(m[2]), goal: num(m[3]) })) : [];
    NAR[name] = { intro: t.slice(t.indexOf(name + '競馬場') + name.length + 3, t.indexOf('データ名')).trim(), turn: field('回り'), len: field('1周距離'), total: field('全長'), straight, straightText: st, width: field('幅員'), height: field('高低差'), fullgate: field('フルゲート'), src: 'https://www.keiba.go.jp/guide/course/' };
    console.error(`${name}（NAR）：直線 ${straight.map(x => `${x.course || ''}${x.goal}m`).join('・') || st || '—'}／高低差 ${NAR[name].height}`);
  }
}
for (const t of Object.values(nk)) { const n = NAR[t.name]; if (!n) continue; t.nar = n; const g = n.straight.map(x => x.goal).filter(Boolean); if (g.length) t.straight = Math.max(...g); }
write('data/nankan/course.json', { built: new Date().toISOString(), tracks: nk });
if (NAR['帯広']) write('data/banei/course.json', { built: new Date().toISOString(), ...NAR['帯広'] });

/* ---- 中央 ---- */
const JR = [['01', '札幌', 'sapporo'], ['02', '函館', 'hakodate'], ['03', '福島', 'fukushima'], ['04', '新潟', 'niigata'], ['05', '東京', 'tokyo'], ['06', '中山', 'nakayama'], ['07', '中京', 'chukyo'], ['08', '京都', 'kyoto'], ['09', '阪神', 'hanshin'], ['10', '小倉', 'kokura']];
const jr = {};
for (const [code, name, slug] of JR) {
  try {
    const url = `https://www.jra.go.jp/facilities/race/${slug}/course/index.html`;
    const h = (await get(url, `https://www.jra.go.jp/facilities/race/${slug}/`)).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    const out = { code, name, slug, turn: /右回り/.test(text(h).slice(0, 20000)) && !/左回り/.test(text(h).slice(0, 20000)) ? '右' : /左回り/.test(text(h)) && !/右回り/.test(text(h)) ? '左' : null, src: url };
    /* 「芝コース」「ダートコース」「障害コース」の区画ごとに、中のすべての表を読む。
       場によって組み方が違う（内回り・外回りで表が2つ、1つのセルに「328.4m(内回り)<br>403.7m(外回り)」など）ので、
       見出しの列ごとに値を全部集め、直線と高低差は最小（内回り）と最大（外回り）を持つ */
    const dataPart = h.slice(Math.max(0, h.indexOf('<h3>コースデータ</h3>')));
    const blocks = dataPart.split(/<h3>(?=(?:芝|ダート|障害)コース<\/h3>)/).slice(1);
    const mvals = c => [...String(c).replace(/,/g, '').matchAll(/([\d.]+)m/g)].map(m => +m[1]);
    for (const blk of blocks) {
      const sf = /^芝/.test(blk) ? 'turf' : /^ダート/.test(blk) ? 'dirt' : /^障害/.test(blk) ? 'jump' : null; if (!sf) continue;
      const o = (out[sf] ||= {}), acc = { len: [], straight: [], height: [], width: [], dists: [] };
      for (const tb of blk.matchAll(/<table[\s\S]*?<\/table>/g)) {
        const ths = [...tb[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => text(m[1]));
        const rows = [...tb[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => x[1])).filter(r => r.length);
        for (const r of rows) {
          const off = ths.length - r.length;   // 行見出しの無い表と、コース名（A/B…）の列がある表の両方に合わせる
          r.forEach((cell, i) => { const k = ths[i + Math.max(0, off)] || ''; const v = mvals(cell.replace(/<br\s*\/?>/g, ' '));
            if (/一周/.test(k)) acc.len.push(...v); else if (/直線/.test(k)) acc.straight.push(...v); else if (/高低差/.test(k)) acc.height.push(...v);
            else if (/幅員/.test(k)) acc.width.push(...v); else if (/発走/.test(k)) acc.dists.push(...v); });
        }
      }
      const mm = a => a.length ? [Math.min(...a), Math.max(...a)] : null;
      o.len = acc.len[0] ?? null; o.straight = mm(acc.straight); o.height = mm(acc.height); o.width = mm(acc.width);
      o.dists = [...new Set(acc.dists.filter(v => v >= 800))].sort((a, b) => a - b);
    }
    /* 左右の回り：見出し「芝コース高低断面図（左回り）」 */
    const tm = h.match(/芝コース高低断面図（(右|左)回り/) || h.match(/ダートコース高低断面図（(右|左)回り/); if (tm) out.turn = tm[1];
    /* コース紹介の文：本文の段落のうち長いもの */
    const paras = [...h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => text(m[1])).filter(s => s.length >= 60 && /コース|直線|コーナー|坂/.test(s) && !/スクロール|Copyright|JRA/.test(s.slice(0, 20)));
    out.notes = paras.slice(0, 4);
    jr[name] = out;
    console.error(`${name}: ${out.turn || '?'}回り 芝 直線${out.turf?.straight?.join('〜') ?? '—'}m 高低差${out.turf?.height?.join('〜') ?? '—'}m 距離${out.turf?.dists?.length ?? 0}／ダ 直線${out.dirt?.straight?.join('〜') ?? '—'}m 高低差${out.dirt?.height?.join('〜') ?? '—'}・文 ${out.notes.length}`);
  } catch (e) { console.error(`! ${name} ${e.message}`); }
}
write('data/jra/course.json', { built: new Date().toISOString(), venues: jr });
