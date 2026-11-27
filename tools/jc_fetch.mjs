#!/usr/bin/env node
// ジャパンカップ特設ページの材料を JRA の公開ページから取る → data/jc/foreign.json
//   外国馬プロフィール（報道室の PDF）・全成績（PDF）・調教状況と関係者コメント（日ごとのニュース）・調教後の馬体重
//   PDF の読み取りに pdftotext（poppler）を使う。凱旋門賞（arc_build）と同じ
import { execFileSync } from 'node:child_process';
import { get, getFile, body, lines, tables, clean, readJSON, writeJSON, SOURCES, JRA, KANA_EN, YEAR } from './lib/jc.mjs';

const z2h = s => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
const J = '[\\u3040-\\u30ff\\u4e00-\\u9fff、。・％]';
// pdftotext は和文と数字の間に空白を入れる。文章として読めるように詰める
const tight = s => s.replace(new RegExp(`(${J}|[)）])\\s+(?=[\\d(（])`, 'g'), '$1').replace(new RegExp(`([\\d)）.])\\s+(?=${J})`, 'g'), '$1').replace(/\s+/g, ' ').trim();
const pdf = (f, ...opt) => execFileSync('pdftotext', [...opt, f, '-'], { encoding: 'utf8', maxBuffer: 64e6 });

/* ---------- プロフィール PDF ---------- */
function parseProfile(text) {
  const all = z2h(text).split('\n').map(l => l.trim()).filter(l => l && !/^\d+ \/ \d+$/.test(l));
  const end = all.findIndex(l => /関係者プロフィール/.test(l));
  const L = end > 0 ? all.slice(0, end) : all;
  const issued = all.find(l => /^\d{4}\s*年\s*\d+\s*月\s*\d+\s*日$/.test(tight(l)));
  const head = {}; const major = []; let i = 0, inMajor = false; const para = [];
  const kv = (l, re) => { const m = tight(l).match(re); return m ? m[1].trim() : null; };
  for (; i < L.length; i++) {
    const l = L[i], t = tight(l);
    if (/^➢/.test(l)) { const m = t.match(/➢\s*(.+?)\s*[（(]([A-Z '\-]+)[)）]\s*＝\s*(.+)$/); if (m) { head.name = m[1]; head.en = m[2].replace(/\s+/g, ' ').trim(); head.country = m[3]; } continue; }
    if (/^(牡|牝|せん)\s*\d/.test(t) && !head.sexAge) { const m = t.match(/^(牡|牝|せん)\s*(\d+)歳・(.+?)\s*[（(](.+?)産・(\d{4})年(\d+)月(\d+)日生まれ/); if (m) Object.assign(head, { sex: m[1], age: +m[2], sexAge: m[1] + m[2], color: m[3], bred: m[4], born: `${m[5]}-${m[6].padStart(2, '0')}-${m[7].padStart(2, '0')}` }); continue; }
    if (/^父[:：]/.test(t)) { const m = t.match(/^父[:：]\s*(.+?)\s*＝\s*母[:：]\s*(.+?)\s*[（(]母の父[:：]\s*(.+?)[)）]/); if (m) Object.assign(head, { sire: m[1], dam: m[2], damsire: m[3] }); continue; }
    let v;
    if ((v = kv(l, /^馬\s*主\s*[:：]\s*(.+)$/))) { head.owner = v; continue; }
    if ((v = kv(l, /^調教師\s*[:：]\s*(.+)$/))) { head.trainer = v; continue; }
    if ((v = kv(l, /^騎\s*手\s*[:：]\s*(.+)$/))) { head.jockey = v; continue; }
    if ((v = kv(l, /^戦\s*績\s*[:：]\s*(.+)$/))) { head.record = v; continue; }
    if ((v = kv(l, /^総獲得賞金\s*[:：]\s*(.+)$/))) { head.earnings = v; continue; }
    const mj = t.match(/^(?:主な戦績\s*[:：]\s*)?([’'][\d&’' ]+)\s*(.+?)\s*[（(](G\s?[I1-3]+|L)[)）]\s*(\d+)\s*着$/);
    if (mj && (inMajor || /^主な戦績/.test(t))) { inMajor = true; major.push({ year: mj[1].replace(/\s+/g, '').replace(/'/g, '’'), race: mj[2], grade: mj[3].replace(/\s/g, '').replace('GI', 'G1'), pos: +mj[4] }); continue; }
    if (inMajor || (head.earnings && !/^主な戦績/.test(t))) { if (head.earnings) break; }
  }
  // 本文。行頭が全角空白で始まる行が段落の先頭（pdftotext -layout では字下げ1つ）
  const raw = z2h(text).split('\n'); const startIdx = raw.findIndex(l => tight(l).includes(L[i] ? tight(L[i]).slice(0, 12) : '\u0000'));
  const endIdx = raw.findIndex(l => /関係者プロフィール/.test(l));
  let cur = '';
  for (const l of raw.slice(startIdx, endIdx > 0 ? endIdx : undefined)) {
    if (!l.trim() || /^\s*\d+ \/ \d+\s*$/.test(l) || /競馬担当各位|報 道 室|^\s*\d{4}\s*年/.test(z2h(l))) continue;
    if (/^\s{1,3}\S/.test(l) && cur && /。$/.test(cur)) { para.push(cur); cur = ''; }
    cur += l.trim();
  }
  if (cur) para.push(cur);
  const paras = para.map(tight);
  const story = paras.join('');
  // 父・父の父・母の父のカタカナ（最初の「X（その父Y）」が父、次が母）
  const pairs = [...story.matchAll(/([ァ-ヶー]+)[（(](?:その)?父([ァ-ヶー]+)[)）]/g)].map(m => [m[1], m[2]]);
  head.sireKana = pairs[0]?.[0] || null; head.grandsireKana = pairs[0]?.[1] || null;
  const dsK = /^[ァ-ヶー]+$/.test(head.damsire || '');
  head.damKana = /^[ァ-ヶー]+$/.test(head.dam || '') ? head.dam : dsK ? story.match(/母の([ァ-ヶー]{3,})/)?.[1] || null : pairs[1]?.[0] || null;
  head.damsireKana = /^[ァ-ヶー]+$/.test(head.damsire || '') ? head.damsire : pairs[1]?.[1] || null;
  head.grandsire = KANA_EN[head.grandsireKana] || null;
  // まとめの段落（通算成績・左回り・馬場別・持ち時計）から数字を拾う
  const sum = paras.slice().reverse().find(p => /通算|ここまで\d+戦/.test(p) && /左回り/.test(p)) || '';
  const rec = (re, lastWin) => { const m = sum.match(re); if (!m) return null; const g = m[0]; const n = +(g.match(/(\d+)戦/)?.[1] ?? 0); const ws = [...g.matchAll(/(\d+)勝/g)].map(x => +x[1]); return { n, w: (lastWin ? ws[ws.length - 1] : ws[0]) ?? 0, p2: +(g.match(/2着(\d+)回/)?.[1] ?? 0), p3: +(g.match(/3着(\d+)回/)?.[1] ?? 0), text: g }; };
  const seg = '(?:して|中)?[^。、]*?(?:\\d+勝)?(?:、2着\\d+回)?(?:、3着\\d+回)?(?:、4着\\d+回)?';
  const stats = {
    left: rec(new RegExp(`左回り(?:では|は)?\\d+戦${seg}`)),
    good: rec(new RegExp(`良馬場で\\d+戦${seg}`)),
    d2400: rec(new RegExp(`\\d+戦(?:は|が)芝2,400m[^。]*?で、?(?:全\\d+勝のうち)?\\d+勝[^。]*`), true),
  };
  const bt = sum.match(/(\d)分(\d+)秒(\d+)[（(]良馬場[)）]/);
  stats.best2400 = bt && /2,400m|クラシックディスタンス/.test(sum) ? { time: `${bt[1]}:${bt[2].padStart(2, '0')}.${bt[3]}`, sec: +bt[1] * 60 + +bt[2] + +('0.' + bt[3]), baba: '良' } : null;
  const rt = story.match(/レーティング(\d{3})で[^。]*?世界(\d+)位(タイ)?/g);
  const lastRating = sum.match(/レーティング(\d{3})/) || (rt ? rt[rt.length - 1].match(/レーティング(\d{3})/) : null);
  stats.rating = lastRating ? +lastRating[1] : null;
  return { ...head, issued: issued ? tight(issued) : null, major, summary: sum, paras: paras.length, stats };
}

/* ---------- 全成績 PDF（単語の座標から行と列を組み直す） ---------- */
function parseRecord(tsv) {
  const W = tsv.split('\n').slice(1).map(l => l.split('\t')).filter(c => c[0] === '5').map(c => ({ page: +c[1], x: +c[6], y: +c[7], w: +c[8], h: +c[9], yc: +c[7] + +c[9] / 2, t: z2h(c[11]) }));
  const out = [];
  for (const page of [...new Set(W.map(w => w.page))]) {
    const P = W.filter(w => w.page === page);
    const h0 = P.find(w => w.t === '年月日'); if (!h0) continue;
    const H = P.filter(w => Math.abs(w.y - h0.y) <= 1.5);
    const col = n => H.find(w => w.t === n);
    const need = ['競馬場', '国', '廻り', '格', '距離', '状', '頭', '着', 'タイム'].map(col);
    if (need.some(x => !x)) throw new Error('全成績の表頭が読めない');
    const [cV, cC, cT, cG, cD, cB, cN, cP, cTm] = need; const mid = (a, b) => (a.x + a.w + b.x) / 2;
    const cJ = col('騎手'), cK = col('重量'), cPass = H.find(w => /^通過順位/.test(w.t)), cBw = P.find(w => w.t === '馬体重' && Math.abs(w.y - h0.y) < 12);
    const cW2 = P.find(w => w.t === 'タイム' && w.y > h0.y + 1 && w.y < h0.y + 10 && w.x > cTm.x + 60), cM = col('着差');
    const edges = [['date', -1], ['venue', Math.max(...P.filter(w => w.x < cV.x - 4 && /^(\d\d\.)?\d\d\.\d\d$/.test(w.t)).map(w => w.x + w.w)) + 1.5], ['country', cC.x - 2], ['turn', mid(cC, cT)], ['name', cT.x + cT.w + 1], ['grade', cG.x - 3], ['dist', mid(cG, cD) - 3], ['baba', mid(cD, cB) + 1], ['n', mid(cB, cN)], ['pos', mid(cN, cP)], ['time', cTm.x - 3], ['winner', cTm.x + cTm.w + 2],
      ['wtime', cW2 ? cW2.x - 14 : (cM?.x ?? 1e9) - 50], ['margin', (cM?.x ?? 1e9) - 6], ['jockey', (cJ?.x ?? 1e9) - 22], ['weight', (cK?.x ?? 1e9) - 6], ['bw', cBw ? cBw.x - 4 : 1e9], ['pass', (cPass?.x ?? 1e9) - 6]];
    const colOf = w => { const cx = w.x + Math.min(w.w, 8) / 2; let k = 'date'; for (const [n, x] of edges) if (cx >= x) k = n; return k; };
    const anchors = P.filter(w => w.y > h0.y + 6 && w.x < cV.x - 4 && /^(\d\d\.)?\d\d\.\d\d$/.test(w.t)).sort((a, b) => a.y - b.y);
    const noteY = P.find(w => /留意事項/.test(w.t) && w.y > h0.y)?.y ?? 1e9;
    // 和文は行の箱が高く（座標が上に出る）、数字は低い。箱の中央の高さで比べれば同じ行にそろう。
    // レース名が2段に折り返す行は上下に分かれて入るので、いちばん近い日付の行にまとめる
    const rows = anchors.map(a => ({ a, cells: {} }));
    for (const w of P) {
      if (w.y <= h0.y + 6 || w.y >= noteY - 2) continue;
      let best = null, bd = 1e9; for (const r of rows) { const d = Math.abs(w.yc - r.a.yc); if (d < bd) { bd = d; best = r; } }
      if (!best || bd > 11) continue;
      (best.cells[colOf(w)] ||= []).push(w);
    }
    for (const r of rows) { const c = { date: r.a.t }; for (const k in r.cells) if (k !== 'date') c[k] = r.cells[k].sort((a, b) => Math.abs(a.yc - b.yc) > 3 ? a.yc - b.yc : a.x - b.x).map(w => w.t).join(''); out.push(c); }
  }
  let yy = null; const runs = [];
  for (const c of out) {
    const d = c.date.match(/^(?:(\d\d)\.)?(\d\d)\.(\d\d)$/); if (d[1]) yy = d[1];
    const dm = (c.dist || '').match(/^(障|ダ|全)?(\d{3,4})$/); const tm = (c.time || '').match(/\d:\d\d\.\d/);
    if (!dm || !tm || !yy) throw new Error(`全成績の行が読めない ${JSON.stringify(c)}`);
    const pos = /^\d+$/.test(c.pos || '') ? +c.pos : (c.pos || null);
    runs.push({ date: `20${yy}-${d[2]}-${d[3]}`, venue: c.venue || null, country: c.country || null, turn: c.turn || null, name: (c.name || '').replace(/^－/, ''), grade: (c.grade || '').replace('－', '') || null,
      surface: dm[1] === '障' ? '障' : dm[1] === 'ダ' ? 'ダ' : dm[1] === '全' ? '全' : '芝', dist: +dm[2], baba: (c.baba || '').replace(/^稍$/, '稍重').replace(/^不$/, '不良') || null, n: +c.n || null, pos, time: tm[0],
      winner: (c.winner || '').replace(/[()（）]/g, '') || null, weight: +(c.weight || '').match(/[\d.]+/)?.[0] || null, bw: +(c.bw || '').match(/\d{3}/)?.[0] || null });
  }
  return runs;
}

/* ---------- 調教状況・関係者コメント（1日1ページ） ---------- */
function parseTraining(html, names) {
  const L = lines(body(html)); const out = []; let cur = null;
  const cond = L.find(l => /^\[?天候/.test(l)) || null;
  for (let i = 0; i < L.length; i++) {
    const l = L[i]; const nm = names.find(n => l.startsWith(n + '（') || l === n);
    if (nm && /歳/.test(l)) { cur = { name: nm, rider: null, menu: null, who: null, comment: null }; out.push(cur); continue; }
    if (!cur) continue;
    if (/^関連ニュース|^ジャパンカップ（GⅠ）$/.test(l)) break;
    let m;
    if ((m = l.match(/^調教状況[（(](.+?)\s*騎乗[)）]/))) cur.rider = m[1];
    else if (/^調教内容$/.test(l)) cur.menu = L[i + 1] || null;
    else if ((m = l.match(/^(.+?)のコメント$/))) { cur.who = m[1]; const c = []; for (let k = i + 1; k < L.length && !names.some(n => L[k].startsWith(n + '（')) && !/^関連ニュース|^ジャパンカップ（GⅠ）$|のコメント$|^調教状況/.test(L[k]); k++) c.push(L[k]); cur.comment = c.join(' '); }
  }
  return { cond: cond ? cond.replace(/[\[\]]/g, '') : null, horses: out.filter(h => h.menu || h.comment) };
}

/* ---------- 本体 ---------- */
const errs = [];
const top = body(await get(SOURCES.foreign, 120));
const list = [...top.matchAll(/<a href="(jc\d\d)\.html"[^>]*>([^<]+)<\/a>/g)].map(m => ({ key: m[1], name: clean(m[2]) }));
if (!list.length) throw new Error('外国馬の一覧が読めない');
const news = [...top.matchAll(/<a href="(\/news\/\d{6}\/\d+\.html)"[^>]*>([^<]*調教状況[^<]*)<\/a>/g)].map(m => ({ url: JRA + m[1], title: clean(m[2]) }))
  .filter((x, i, a) => a.findIndex(y => y.url === x.url) === i);
const horses = [];
for (const h of list) {
  const base = `${JRA}/news/gaikokuba/${YEAR}/`;
  const page = body(await get(`${base}${h.key}.html`, 720, { referer: SOURCES.foreign }));
  const pdfs = [...page.matchAll(/href="(pdf\/[^"]+\.pdf)"/g)].map(m => base + m[1]);
  const pUrl = pdfs.find(u => !/_s\.pdf$/.test(u)), sUrl = pdfs.find(u => /_s\.pdf$/.test(u));
  const o = { key: h.key, name: h.name, page: `${base}${h.key}.html`, profilePdf: pUrl || null, recordPdf: sUrl || null };
  try { Object.assign(o, parseProfile(pdf(await getFile(pUrl), '-layout')), { name: h.name }); } catch (e) { errs.push(`${h.name} プロフィール: ${e.message}`); }
  try {
    o.runs = parseRecord(pdf(await getFile(sUrl), '-tsv'));
    const total = +(o.record || '').match(/全\s*(\d+)\s*戦/)?.[1];
    if (total && o.runs.length !== total) { errs.push(`${h.name} 全成績: ${o.runs.length}行（通算${total}戦と合わない）`); o.runsPartial = true; }
  } catch (e) { errs.push(`${h.name} 全成績: ${e.message}`); o.runs = null; }
  horses.push(o);
}
const names = horses.map(h => h.name);
const training = [];
for (const n of news) {
  const date = n.title.match(/(\d+)月(\d+)日/); if (!date) continue;
  try { const t = parseTraining(await get(n.url, 60 * 24 * 30, { referer: SOURCES.foreign }), names); training.push({ date: `${YEAR}-${date[1].padStart(2, '0')}-${date[2].padStart(2, '0')}`, url: n.url, ...t }); }
  catch (e) { errs.push(`調教状況 ${n.title}: ${e.message}`); }
}
training.sort((a, b) => b.date.localeCompare(a.date));
// 調教後の馬体重（G1 のページからリンクを拾う）
let weights = null;
try {
  const g1 = await get(SOURCES.g1, 120);
  const wl = g1.match(/href="(\/news\/\d{6}\/\d+\.html)"[^>]*>[^<]*(?:<[^>]+>[^<]*)*?調教後の馬体重/)?.[1] || [...g1.matchAll(/<a[^>]+href="(\/news\/\d{6}\/\d+\.html)"[^>]*>([\s\S]*?)<\/a>/g)].find(m => /調教後の馬体重/.test(clean(m[2])))?.[1];
  if (wl) {
    const t = tables(body(await get(JRA + wl, 720))).find(t => t.some(r => r.some(c => /馬体重/.test(c))));
    const rows = (t || []).filter(r => /^\d+$/.test(r[1] || '')).map(r => ({ waku: +r[0], no: +r[1], name: r[2], bw: +r[3] || null, day: r[4], place: r[5], prev: +r[r.length - 1] || null, prevNote: /^\d+$/.test(r[r.length - 1]) ? null : r[r.length - 1] }));
    if (rows.length) weights = { url: JRA + wl, rows };
  }
} catch (e) { errs.push(`調教後の馬体重: ${e.message}`); }

for (const e of errs) console.error('  ! ' + e);
if (horses.some(h => !h.sire)) { console.error('プロフィールが読めない馬がいるので、前の foreign.json を残す'); process.exit(2); }
const out = { horses, training, weights, sources: SOURCES };
const prev = readJSON('data/jc/foreign.json');
if (prev && JSON.stringify({ ...prev, fetchedAt: 0 }) === JSON.stringify({ fetchedAt: 0, ...out })) { console.log('変化なし'); process.exit(0); }
writeJSON('data/jc/foreign.json', { fetchedAt: new Date().toISOString(), ...out });
console.log(`-> data/jc/foreign.json 外国馬${horses.length}頭／調教状況${training.length}日／馬体重${weights?.rows.length ?? 0}頭`);
