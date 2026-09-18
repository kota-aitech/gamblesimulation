/* JRA の「過去の含水率・クッション値」PDF を表に起こす最小のパーサ（Node 標準の zlib だけ。依存ゼロ）。
   PDF の中身は
     - 数値（含水率・クッション値）… 素のテキスト `[(14.4)] TJ`
     - 日本語（日付・見出し）      … Identity-H の CID `[<11751B591AA5>] TJ` ＋ フォントごとの /ToUnicode CMap
   なので、ToUnicode を読んで CID を戻し、`1 0 0 1 X Y Tm` の座標で行（Y）と列（X）に並べ直す。
   使い方: const rows = pdfRows(fs.readFileSync(f));   // [{y, cells:[{x, t}]}]  上から下・左から右 */
import zlib from 'node:zlib';

const inflate = b => { try { return zlib.inflateSync(b); } catch { try { return zlib.inflateRawSync(b); } catch { return null; } } };

/* 生ファイルから「番号 → 本文」を作る。圧縮オブジェクト（ObjStm）の中身も展開して足す */
function objects(buf) {
  const s = buf.toString('latin1'), map = new Map(), streams = new Map();
  const re = /(\d+) 0 obj/g; let m;
  while ((m = re.exec(s))) {
    const num = Number(m[1]), start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    const body = s.slice(start, end < 0 ? start + 4000 : end);
    map.set(num, body);
    const sm = /stream\r?\n/.exec(body);
    if (sm) {
      const st = start + sm.index + sm[0].length, en = s.indexOf('endstream', st);
      if (en > 0) { const raw = buf.slice(st, en); streams.set(num, /FlateDecode/.test(body) ? inflate(raw) : raw); }
    }
  }
  /* ObjStm（オブジェクトをまとめて圧縮したもの）を展開して番号→本文に足す */
  for (const [num, body] of [...map]) {
    if (!/\/Type\s*\/ObjStm/.test(body)) continue;
    const data = streams.get(num); if (!data) continue;
    const txt = data.toString('latin1');
    const n = Number((body.match(/\/N\s+(\d+)/) || [])[1] || 0);
    const first = Number((body.match(/\/First\s+(\d+)/) || [])[1] || 0);
    const head = txt.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const objNum = head[i * 2], off = head[i * 2 + 1];
      const next = i + 1 < n ? head[i * 2 + 3] : txt.length - first;
      if (objNum == null) continue;
      map.set(objNum, txt.slice(first + off, first + next));
    }
  }
  return { map, streams };
}

/* /ToUnicode の CMap（beginbfchar / beginbfrange）→ CID(16bit) → 文字 */
function cmapOf(txt) {
  const map = new Map();
  const uni = h => String.fromCodePoint(...(h.match(/.{1,4}/g) || []).map(x => parseInt(x, 16)).filter(c => c > 0));
  for (const blk of txt.match(/beginbfchar[\s\S]*?endbfchar/g) || [])
    for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(m[1], 16), uni(m[2]));
  for (const blk of txt.match(/beginbfrange[\s\S]*?endbfrange/g) || [])
    for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), base = parseInt(m[3], 16);
      for (let c = lo; c <= hi && c - lo < 512; c++) map.set(c, String.fromCodePoint(base + (c - lo)));
    }
  return map;
}

/* PDF の文字列リテラル `(...)` を戻す（\( や 8進エスケープ） */
function litText(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const d = raw[++i];
    if (d >= '0' && d <= '7') { let o = d; while (o.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') o += raw[++i]; out += String.fromCharCode(parseInt(o, 8)); }
    else out += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[d] ?? d;
  }
  return out;
}

export function pdfRows(buf, { yTol = 3 } = {}) {
  const { map, streams } = objects(buf);
  /* フォント名（/F1 など）→ ToUnicode。ページの Resources から拾う */
  const fonts = new Map();
  for (const body of map.values()) {
    const fm = body.match(/\/Font\s*<<([^>]*)>>/);
    if (!fm) continue;
    for (const r of fm[1].matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
      const fb = map.get(Number(r[2])); if (!fb) continue;
      const tu = fb.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      if (tu && streams.get(Number(tu[1]))) fonts.set(r[1], cmapOf(streams.get(Number(tu[1])).toString('latin1')));
    }
  }
  /* 内容ストリーム（BT と Tf を持つもの）を順に読む */
  const items = [];
  for (const [, data] of streams) {
    if (!data) continue;
    const t = data.toString('latin1');
    if (!/BT[\s\S]*Tf/.test(t)) continue;
    let font = null, x = 0, y = 0;
    const re = /\/(F\d+)\s+[\d.]+\s+Tf|1\s+0\s+0\s+1\s+([-\d.]+)\s+([-\d.]+)\s+Tm|\[([\s\S]*?)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj/g;
    let m;
    while ((m = re.exec(t))) {
      if (m[1]) { font = m[1]; continue; }
      if (m[2] != null) { x = Number(m[2]); y = Number(m[3]); continue; }
      let txt = '';
      const body = m[4] != null ? m[4] : m[5] != null ? `(${m[5]})` : `<${m[6]}>`;
      for (const p of body.matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>/g)) {
        if (p[1] != null) txt += litText(p[1]);
        else {
          const hex = p[2].replace(/\s+/g, ''), cm = fonts.get(font);
          for (let i = 0; i + 3 < hex.length + 1; i += 4) {
            const code = parseInt(hex.slice(i, i + 4), 16);
            txt += cm && cm.has(code) ? cm.get(code) : '';
          }
        }
      }
      if (txt.trim()) items.push({ x, y, t: txt.trim() });
    }
  }
  /* 行（Y が近いもの）にまとめて、左から右に並べる */
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const r = rows.find(r => Math.abs(r.y - it.y) <= yTol);
    if (r) { r.cells.push(it); r.y = (r.y * (r.cells.length - 1) + it.y) / r.cells.length; }
    else rows.push({ y: it.y, cells: [it] });
  }
  for (const r of rows) r.cells.sort((a, b) => a.x - b.x);
  return rows;
}
