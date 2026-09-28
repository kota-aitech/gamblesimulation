/* 締切◯分前のオッズを、この Mac と無関係に取る役（GitHub Actions から回す）。

   なぜ要るか：取得・反映は launchd で Mac に置いてあるが、**フタを閉じるとスリープしてジョブが止まる**。
   結果・払戻・番組表は後から取り直せるのに対し、**締切前のオッズはその時刻を過ぎると二度と取れない**。
   そこでオッズの記録だけを Mac から切り離す。予想・印・ページの生成は今までどおり Mac 側。

   書き出し先は data/odds_cloud/<競技>/<日付>.jsonl（追記のみ）。
   **Mac 側はこのファイルを読むだけで書かない**ので、両方から push しても衝突しない
   （マージは tools/merge_cloud_odds.mjs が Mac 側で行う）。

     node tools/cloud_odds.mjs --sport=nankan     1周回だけ（cron 向き）
     CO_MINUTES=320 node tools/cloud_odds.mjs --sport=boat    320分ループ（Actions 向き）
   環境変数
     CO_LEAD   … 締切の何分前を「締切前」として残すか（既定 8）
     CO_TICK   … 見回りの間隔（秒。既定 30。締切が遠い時間帯は自動で伸ばす）
     CO_PUSH   … 0 なら commit / push しない（手元の試し用）
     CO_DAYS   … 何日先まで見るか（既定 1＝今日と明日）
*/
process.env.TZ = 'Asia/Tokyo';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { get as nkGet } from './lib/nk.mjs';
import { parseOdds } from './lib/odds.mjs';
import { get as btGet, VNAME } from './lib/bt.mjs';
import { parseOddsTF, parseOdds3T } from './lib/web.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 書き出し先は main とは別のブランチ（odds-cloud）に置く。
   **main へ push すると GitHub Pages が毎回ビルドされ、1時間10回の制限に当たる**ため。
   Actions では odds-cloud を別ディレクトリに checkout して、そこを CO_OUT_ROOT に渡す */
const OUT_ROOT = process.env.CO_OUT_ROOT ? path.resolve(process.env.CO_OUT_ROOT) : ROOT;
const BRANCH = process.env.CO_BRANCH || (OUT_ROOT === ROOT ? 'main' : 'odds-cloud');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const SPORT = arg('sport') || process.env.CO_SPORT;
const LEAD = Number(process.env.CO_LEAD || 8);
const MINUTES = Number(process.env.CO_MINUTES || 0);
const TICK = Number(process.env.CO_TICK || 30) * 1000;
const DAYS = Number(process.env.CO_DAYS || 1);
const PUSH = process.env.CO_PUSH !== '0';
if (!['nankan', 'boat', 'jra', 'keirin'].includes(SPORT)) { console.error('--sport=nankan|boat|jra|keirin が要る'); process.exit(2); }

const today = () => new Date().toLocaleDateString('sv-SE');
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() + n); return t.toLocaleDateString('sv-SE'); };
const at = (date, hhmm) => { const [h, m] = hhmm.split(':').map(Number); const t = new Date(date + 'T00:00:00'); t.setHours(h, m, 0, 0); return t; };
const log = (...a) => console.error(new Date().toLocaleTimeString('ja-JP'), ...a);
const wait = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const outFile = date => path.join(OUT_ROOT, 'data', 'odds_cloud', SPORT, `${date}.jsonl`);
const seen = new Set();                                  // 「レース|タグ」。再起動しても既存ファイルから復元する
const loadSeen = date => {
  const f = outFile(date);
  if (!fs.existsSync(f)) return;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) { try { const o = JSON.parse(l); seen.add(`${o.date}|${o.key}|${o.tag}`); } catch { } }
};
let dirty = false;
const append = (date, rec) => {
  const f = outFile(date);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(rec) + '\n');
  seen.add(`${date}|${rec.key}|${rec.tag}`);
  dirty = true;
};

/* ---- 南関東（nankankeiba）---- */
const BASE = 'https://www.nankankeiba.com';
const nankan = {
  async races(date) {
    const ymd = date.replace(/-/g, '');
    const q = ymd.slice(0, 4) + String(Math.floor((Number(ymd.slice(4, 6)) - 1) / 3) * 3 + 1).padStart(2, '0');
    const cal = await nkGet(`${BASE}/calendar/${q}.do`, { ttlDays: 0.02 });
    const days = [...new Set([...cal.matchAll(/\/program\/(\d{14})\.do/g)].map(m => m[1]))].filter(d => d.startsWith(ymd));
    const out = [];
    for (const day of days) {
      const pg = await nkGet(`${BASE}/program/${day}.do`, { ttlDays: 0.02 });
      for (const rid of [...new Set([...pg.matchAll(/\/syousai\/(\d{16})\.do/g)].map(m => m[1]))].sort()) {
        const html = await nkGet(`${BASE}/uma_shosai/${rid}.do`, { ttlDays: 0.5 });
        const t = /発走時刻[\s\S]{0,80}?(\d{1,2}:\d{2})/.exec(html.replace(/<[^>]+>/g, ' '));
        if (!t) continue;
        /* 南関の発売締切は発走のおよそ1分前 */
        out.push({ key: rid, date, label: `${Number(rid.slice(14, 16))}R`, post: t[1], close: at(date, t[1]).getTime() - 60000 });
      }
    }
    return out;
  },
  async snap(r) {
    const o = parseOdds(await nkGet(`${BASE}/oddsJS/${r.key}.do?_=${Date.now()}`, { ttlDays: 0, tries: 2 }));
    if (!o.live) return null;
    return { updated: o.updated, tan: o.tan, fuku: o.fuku };
  },
};

/* ---- ボート（boatrace.jp）---- */
const B = 'https://www.boatrace.jp/owpc/pc/race/';
const boat = {
  async races(date) {
    const hd = date.replace(/-/g, '');
    const idx = await btGet(`${B}index?hd=${hd}`, { ttlDays: 0.02 });
    const jcds = [...new Set([...idx.matchAll(/jcd=(\d\d)/g)].map(m => m[1]))].sort();
    const out = [];
    for (const jcd of jcds) {
      let closes = [];
      try {
        const html = await btGet(`${B}oddstf?rno=1&jcd=${jcd}&hd=${hd}`, { ttlDays: 0.02 });
        closes = [...html.matchAll(/<td[^>]*>(\d{1,2}:\d{2})<\/td>/g)].map(m => m[1]).slice(0, 12);
      } catch (e) { log(`  ! ${VNAME[jcd]} 締切時刻が取れない: ${e.message}`); continue; }
      closes.forEach((c, i) => out.push({ key: `${jcd}-${i + 1}`, date, label: `${VNAME[jcd]}${i + 1}R`, jcd, r: i + 1, post: c, close: at(date, c).getTime() }));
    }
    return out;
  },
  async snap(r) {
    const hd = r.date.replace(/-/g, '');
    const tf = parseOddsTF(await btGet(`${B}oddstf?rno=${r.r}&jcd=${r.jcd}&hd=${hd}`, { ttlDays: 0 }));
    if (!Object.keys(tf.win || {}).length) return null;
    let tri = {};
    try { tri = parseOdds3T(await btGet(`${B}odds3t?rno=${r.r}&jcd=${r.jcd}&hd=${hd}`, { ttlDays: 0 })); } catch { }
    return { jcd: r.jcd, r: r.r, win: tf.win, place: tf.place, tri };
  },
};

/* ---- 中央（netkeiba）---- */
const jget = async (url, ref) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*', ...(ref ? { Referer: ref } : {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return url.includes('/api/') ? buf.toString('utf8') : new TextDecoder('euc-jp').decode(buf);
};
const jra = {
  async races(date) {
    const html = await jget(`https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${date.replace(/-/g, '')}`);
    const out = [], done = new Set();
    for (const m of html.matchAll(/race_id=(\d{12})/g)) {
      const id = m[1]; if (done.has(id)) continue;
      const t = /(\d{1,2}:\d{2})/.exec(html.slice(m.index, m.index + 800));
      if (!t) continue;
      done.add(id);
      /* JRA の発売締切は発走時刻そのもの */
      out.push({ key: id, date, label: `${Number(id.slice(10, 12))}R`, post: t[1], close: at(date, t[1]).getTime() });
    }
    return out;
  },
  async snap(r) {
    const j = JSON.parse(await jget(`https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${r.key}&type=1&action=init`,
      `https://race.netkeiba.com/odds/index.html?race_id=${r.key}`));
    const o = j?.data?.odds?.['1'];
    if (!o || !Object.keys(o).length) return null;
    const tan = {};
    for (const [no, v] of Object.entries(o)) tan[no] = { odds: Number(v[0]) || null, pop: Number(v[2]) || null };
    return { status: j.status, updated: j?.data?.official_datetime, tan };
  },
};
/* ---- 競輪（楽天Kドリームス）----
   番組：日付ページ（全場のリンク）→ 場の「一覧」ページ（全レースの発走・締切が並ぶ）。1日 1＋場の数 リクエスト
   締切前：レース詳細ページ（約250KB）を1回取り、3連単210通り・2車単・3連複・2車複のオッズだけ残す。
   Mac が寝ていても、あとで起きたときにこのオッズで予想を記録できる（keirin_build_races が odds_live の T-8 を使う） */
const KR = 'https://keirin.kdreams.jp';
const krGetRaw = async url => { const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(40000) }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); };
let krLast = 0;
const krGet = async url => { const gap = Date.now() - krLast; if (gap < 1500) await wait(1500 - gap); krLast = Date.now(); return krGetRaw(url); };
const keirin = {
  async races(date) {
    const [y, m, d] = date.split('-');
    const day = await krGet(`${KR}/racecard/${y}/${m}/${d}/`);
    const cards = [...new Set([...day.matchAll(/https:\/\/keirin\.kdreams\.jp\/([a-z]+)\/racecard\/(\d{14})\//g)].map(x => `${x[1]}|${x[2]}`))];
    const out = [];
    for (const c of cards) {
      const [slug, cid] = c.split('|');
      /* その日に開催している場だけ（日付ページには前日初日の開催も載る。一覧ページの中のレースIDで日を確かめる） */
      let html; try { html = await krGet(`${KR}/${slug}/racecard/${cid}/`); } catch (e) { log(`  ! ${slug} 一覧 ${e.message}`); continue; }
      for (const b of html.matchAll(/racedetail\/(\d{16})\/"><span class="num">(\d+)R<\/span>[\s\S]{0,400}?<dt>発走<\/dt><dd>(\d{1,2}:\d{2})<\/dd><dt>締切<\/dt><dd>(\d{1,2}:\d{2})<\/dd>/g)) {
        const rid = b[1]; if (out.some(o => o.key === rid)) continue;
        out.push({ key: rid, date, slug, label: `${slug}${b[2]}R`, post: b[3], close: at(date, b[4]).getTime() });
      }
    }
    /* 日付ページには当日開催の場だけが載るので、ここで拾ったレースは全部その日のもの */
    return out;
  },
  async snap(r) {
    const { parseRace } = await import('./lib/krpage.mjs');
    const p = parseRace(await krGetRaw(`${KR}/${r.slug}/racedetail/${r.key}/`), r.slug, r.key);
    if (!p.odds?.e3 || Object.keys(p.odds.e3).length < 20) return null;
    return { raceId: r.key, slug: r.slug, oddsAt: p.oddsAt, odds: { e3: p.odds.e3, e2: p.odds.e2 || null, q3: p.odds.q3 || null, q2: p.odds.q2 || null } };
  },
};
const SRC = { nankan, boat, jra, keirin }[SPORT];

/* ---- git（Actions のトークンで押す。Mac 側はこのファイルを書かないので衝突しない）----

   **3競技が同じ枝（odds-cloud）へ同時に押すので、ほぼ毎回 rebase が要る。**
   2026-09-27 に、その rebase が `fatal: empty ident name` で失敗し続けた。
   commit には `-c user.name` を渡していたが **rebase にも識別子が要る**のを見落としていた。
   しかも一度こけると `.git/rebase-merge` が残り、以後の commit が全部失敗して
   「push 失敗（空のメッセージ）」が延々と出る＝**拾ったオッズが1件も保存されない**。
   実際に 9/27 のボートは12時〜16時のぶんが丸ごと失われた。
   対策：識別子は最初に一度 config に書き込む／失敗したら rebase を中断して畳み直す／原因を必ず表に出す。 */
const gitRaw = (args, opts = {}) => execFileSync('git', args, { cwd: OUT_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const git = args => gitRaw(args).trim();
/* 失敗の中身を必ず読めるようにする（stderr が空のことがあるので stdout も見る） */
const errText = e => [e.stderr, e.stdout, e.message].map(x => String(x || '').trim()).filter(Boolean).join(' / ').split('\n').filter(Boolean).slice(-3).join(' ') || '（出力なし）';
if (PUSH) {
  try {
    git(['config', 'user.name', 'odds-bot']);
    git(['config', 'user.email', 'odds-bot@users.noreply.github.com']);
    git(['config', 'rebase.autoStash', 'true']);
  } catch (e) { log(`git の設定に失敗: ${errText(e)}`); }
}
/* 途中で止まった rebase / merge を畳む。残っていると以後の commit が全部失敗する */
const unstick = () => {
  for (const a of [['rebase', '--abort'], ['merge', '--abort'], ['cherry-pick', '--abort']]) {
    try { gitRaw(a); } catch { /* 進行中でなければ失敗して当然 */ }
  }
};
let lastPush = 0, failStreak = 0;
function publish(force) {
  if (!PUSH || !dirty) return;
  if (!force && Date.now() - lastPush < Number(process.env.CO_PUSH_EVERY || 3) * 60000) return;
  try {
    unstick();
    git(['add', '--', `data/odds_cloud/${SPORT}`]);
    if (!git(['status', '--porcelain', '--', `data/odds_cloud/${SPORT}`])) { dirty = false; return; }
    git(['commit', '-q', '-m', `chore(odds): ${SPORT} 締切前オッズ ${new Date().toLocaleString('ja-JP', { hour12: false })}`, '--', `data/odds_cloud/${SPORT}`]);
    let pushed = false;
    for (let i = 0; i < 5 && !pushed; i++) {
      try { git(['push', 'origin', `HEAD:${BRANCH}`]); pushed = true; }
      catch (e) {
        if (i === 4) throw e;
        /* 他の競技が先に押していたら、取り直して自分のコミットを載せ替える */
        try { git(['fetch', '-q', 'origin', BRANCH]); git(['rebase', '-q', `origin/${BRANCH}`]); }
        catch (e2) { unstick(); log(`rebase をやり直す: ${errText(e2)}`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000); }
      }
    }
    dirty = false; lastPush = Date.now(); failStreak = 0;
    log('push 完了');
  } catch (e) {
    failStreak++;
    log(`push 失敗（${failStreak}回目）: ${errText(e)}`);
    unstick();
    /* 続けて失敗するなら枝を取り直してやり直す（手元の記録は残したまま載せ替える） */
    if (failStreak >= 3) {
      try {
        const keep = fs.readdirSync(path.join(OUT_ROOT, 'data/odds_cloud', SPORT)).map(f => [f, fs.readFileSync(path.join(OUT_ROOT, 'data/odds_cloud', SPORT, f))]);
        git(['fetch', '-q', 'origin', BRANCH]);
        git(['reset', '-q', '--hard', `origin/${BRANCH}`]);
        for (const [f, buf] of keep) {                    // 取り直した枝の上に、手元の記録を足し直す
          const q = path.join(OUT_ROOT, 'data/odds_cloud', SPORT, f);
          if (!f.endsWith('.jsonl')) { fs.writeFileSync(q, buf); continue; }
          const have = new Set((fs.existsSync(q) ? fs.readFileSync(q, 'utf8') : '').split('\n').filter(Boolean));
          const add = String(buf).split('\n').filter(Boolean).filter(l => !have.has(l));
          if (add.length) fs.appendFileSync(q, add.join('\n') + '\n');
        }
        failStreak = 0; dirty = true;
        log('枝を取り直して記録を載せ直した');
      } catch (e2) { log(`取り直しにも失敗: ${errText(e2)}`); }
    }
  }
}

/* ---- 見回り ---- */
const end = MINUTES ? Date.now() + MINUTES * 60000 : 0;
let sched = new Map(), schedAt = 0;
/* 番組（レースと締切時刻）は日に何度も変わらないのに、ジョブが再起動するたび取り直すと
   取得元を余計に叩く（南関は1レース1ページ＝1日48ページ）。odds-cloud に置いて使い回す */
const schedFile = date => path.join(OUT_ROOT, 'data', 'odds_cloud', SPORT, `sched.${date}.json`);
const SCHED_TTL = Number(process.env.CO_SCHED_TTL || 6) * 3600000;
async function racesOf(date) {
  const f = schedFile(date);
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Date.now() - Date.parse(c.savedAt) < SCHED_TTL && c.races?.length) return c.races;
  } catch { }
  const races = await SRC.races(date);
  if (races.length) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ savedAt: new Date().toISOString(), races }));
    dirty = true;
  }
  return races;
}
async function schedule() {
  if (Date.now() - schedAt < 20 * 60000 && sched.size) return sched;
  const m = new Map();
  for (let i = 0; i <= DAYS; i++) {
    const d = addDays(today(), i);
    loadSeen(d);
    try { for (const r of await racesOf(d)) m.set(`${d}|${r.key}`, r); }
    catch (e) { log(`${d} の番組が取れない: ${e.message}`); }
  }
  if (m.size) { sched = m; schedAt = Date.now(); log(`対象 ${m.size}レース`); }
  return sched;
}
async function tick() {
  const races = await schedule();
  const now = Date.now();
  let nearest = Infinity;
  for (const r of races.values()) {
    const left = (r.close - now) / 60000;
    if (left > 0) nearest = Math.min(nearest, left);
    /* 締切 LEAD 分前（少し過ぎても拾う）と、レース後の最終オッズ */
    const tag = (left <= LEAD + 0.6 && left >= LEAD - 4) ? 'pre'
      : (SPORT !== 'boat' && SPORT !== 'keirin' && left <= -22 && left >= -90) ? 'final' : null;   // 競輪の確定オッズは結果ページに残るので取らない
    if (!tag || seen.has(`${r.date}|${r.key}|${tag}`)) continue;
    try {
      const o = await SRC.snap(r);
      if (!o) continue;
      append(r.date, { sport: SPORT, key: r.key, date: r.date, label: r.label, tag, post: r.post,
        close: new Date(r.close).toLocaleTimeString('ja-JP', { hour12: false }).slice(0, 5),
        capturedAt: new Date().toISOString(), minsToClose: Math.round(left), ...o });
      log(`✓ ${r.date} ${r.label} ${tag}（締切${Math.round(left)}分前）`);
    } catch (e) { log(`! ${r.label} ${tag} ${e.message}`); }
  }
  publish(false);
  return nearest;
}
log(`${SPORT} のオッズ取得を開始（締切${LEAD}分前・${MINUTES ? MINUTES + '分ループ' : '1周回'}）`);
do {
  const nearest = await tick();
  if (!end) break;
  /* 締切が遠い時間帯は見回りを間引く（次の締切の20分前までは寝ていてよい） */
  const idle = Number.isFinite(nearest) && nearest > LEAD + 20;
  await wait(idle ? Math.min((nearest - LEAD - 15) * 60000, 10 * 60000) : TICK);
} while (Date.now() < end);
publish(true);
log('終了');
