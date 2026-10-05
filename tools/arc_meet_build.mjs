/* 凱旋門賞の週末のパリロンシャン全レースを組み立てる → data/arc/meet.json と longchamp.html（LC マーカー）。
   キャッシュ（tools/arc_meet_fetch.mjs が取ったもの）だけで作る。ネットにはつながない。

   馬場の見立て（このページの主眼）
   - 公式のペネトロメーター（France Galop が開催日の朝に計る硬度。数字が大きいほど軟らかい）
   - **勝ち時計からの逆算**：過去のロンシャン開催（2025-04〜）の全レースで
       1km あたりの勝ち時計 = コース（距離×走路）の基準 + クラスの補正 + b × ペネトロメーター
     を当てはめ、その日の各レースの時計から「時計どおりならペネトロメーターはいくつか」を出して平均する。
     **開催日ごとに外して当て直す検証**（その日を学習に入れずに逆算 → 公式の値と比べる）の誤差も並べる
   - 前日→翌日でペネトロメーターがどれだけ動いたかの過去の分布（日曜の見通しの幅）
   - 確定したレースの上位3頭のゲートと、レース後コメント（PMU／DATAHIPPIQUE）に出る通った位置（内・外・前・後ろ）
     node tools/arc_meet_build.mjs */
process.env.TZ = 'Asia/Tokyo';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data/cache/arc/pmu');
const OUT = path.join(ROOT, 'data/arc');
const DAY_ARC = process.env.ARC_DAY || '2026-10-04';
const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
/* アラブ（PUR-SANG ARABE）のレースは時計がまるで違うので物差しから外す */
const arabian = c => /ARAB/i.test(c?.libelle || '');
const pen = c => { const v = c?.penetrometre?.valeurMesure; return v ? +String(v).replace(',', '.') : null; };
const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* 馬場の呼び名（フランス）→ 英語・おおよその日本の言い方。**同じ物差しではない**ので画面にも但し書きを出す */
export const GOING = {
  'tres sec': ['Very firm', '良（硬）'], 'sec': ['Firm', '良（硬）'], 'tres bon': ['Good to firm', '良'], 'bon': ['Good', '良'],
  'bon souple': ['Good to soft', '稍重'], 'bon leger': ['Good to firm', '良'], 'souple': ['Soft', '重'], 'tres souple': ['Very soft', '重〜不良'],
  'collant': ['Holding', '重〜不良'], 'lourd': ['Heavy', '不良'], 'tres lourd': ['Very heavy', '不良'],
};
const goingOf = s => { const k = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); return GOING[k] ? { fr: s, en: GOING[k][0], ja: GOING[k][1] } : s ? { fr: s, en: null, ja: null } : null; };
/* 走路：パリロンシャンは5つ（外回り＝GRANDE、中回り＝MOYENNE、小回り＝PETITE、直線1000＝LIGNE DROITE、1400 の引き込み線＝NOUVELLE） */
const pisteOf = p => { const s = String(p || '').toUpperCase(); return s.includes('LIGNE DROITE') ? '直線' : s.includes('GRANDE') ? '外回り' : s.includes('MOYENNE') ? '中回り' : s.includes('PETITE') ? '小回り' : s.includes('NOUVELLE') ? '引き込み線' : '不明'; };
const CLASS = { GROUPE_I: 'G1', GROUPE_II: 'G2', GROUPE_III: 'G3', LISTED: 'L', HANDICAP: 'ハンデ', HANDICAP_DIVISE: 'ハンデ', HANDICAP_DE_CATEGORIE: 'ハンデ', COURSE_A_CONDITIONS: '条件', INCONNU: 'その他' };
const clsOf = c => CLASS[c] || (String(c || '').startsWith('HANDICAP') ? 'ハンデ' : c ? '条件' : 'その他');
const COUNTRY = { France: 'フランス', 'Royaume-Uni': 'イギリス', Irlande: 'アイルランド', Allemagne: 'ドイツ', Japon: '日本', Italie: 'イタリア', 'Etats-Unis': 'アメリカ', Qatar: 'カタール', 'Emirats Arabes Unis': 'UAE', Belgique: 'ベルギー', Suisse: 'スイス', Espagne: 'スペイン', 'République Tchèque': 'チェコ' };
const ja = (o, k) => o[k] || k || null;

/* ── 1) 過去のロンシャンの全レース → 時計の物差し ── */
const hist = [];
const histFiles = fs.existsSync(path.join(DIR, 'hist')) ? fs.readdirSync(path.join(DIR, 'hist')).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort() : [];
const meetDays = rd('meet_days.json') || [];
const dayFiles = [...histFiles.map(f => ['hist/' + f, f.slice(0, 10)]), ...meetDays.map(d => [`lon.${d}.json`, d])];
const penByDay = {};
for (const [f, day] of dayFiles) {
  const lon = rd(f); if (!lon) continue;
  for (const c of lon.courses) {
    const p = pen(c); if (p != null) penByDay[day] = p;
    if (arabian(c) || !c.dureeCourse || !c.distance || c.discipline !== 'PLAT' || c.typePiste && c.typePiste !== 'HERBE' || p == null) continue;
    const spk = c.dureeCourse / 1000 / (c.distance / 1000);
    if (spk < 50 || spk > 80) continue;
    hist.push({ day, r: c.numOrdre, dist: c.distance, piste: pisteOf(c.parcours), key: `${c.distance}|${pisteOf(c.parcours)}`, cls: clsOf(c.categorieParticularite), pen: p, spk, n: c.nombreDeclaresPartants });
  }
}
/* 1km あたりの秒 = α[コース] + γ[クラス] + b×pen。交互に平均を取り直す（後退当てはめ）。k=3 でコースの標本の少なさを全体平均へ縮める */
function fitTime(rows) {
  const a = {}, g = {}; let b = 0;
  const all = mean(rows.map(x => x.spk));
  for (let it = 0; it < 30; it++) {
    const ak = {}; for (const x of rows) { (ak[x.key] ||= []).push(x.spk - (g[x.cls] || 0) - b * x.pen); }
    const base = mean(rows.map(x => x.spk - (g[x.cls] || 0) - b * x.pen));
    for (const k in ak) a[k] = (ak[k].reduce((s, v) => s + v, 0) + 3 * base) / (ak[k].length + 3);
    const gk = {}; for (const x of rows) (gk[x.cls] ||= []).push(x.spk - a[x.key] - b * x.pen);
    for (const k in gk) g[k] = gk[k].reduce((s, v) => s + v, 0) / (gk[k].length + 5);
    const ys = rows.map(x => x.spk - a[x.key] - (g[x.cls] || 0)), ps = rows.map(x => x.pen);
    const mp = mean(ps), my = mean(ys);
    let sxy = 0, sxx = 0; ps.forEach((p, i) => { sxy += (p - mp) * (ys[i] - my); sxx += (p - mp) ** 2; });
    b = sxx ? sxy / sxx : 0;
    /* b を入れ替えたぶん α の水準もずれるので、次の周回で取り直す */
  }
  return { a, g, b, all, pred: x => (a[x.key] ?? all - b * 3.4) + (g[x.cls] || 0) + b * x.pen };
}
/* ある日のレースから「時計どおりのペネトロメーター」を逆算（コースの基準を持っているレースだけ） */
function impliedPen(fit, rows) {
  const per = rows.filter(x => fit.a[x.key] != null && fit.b > 0.05).map(x => ({ ...x, imp: (x.spk - fit.a[x.key] - (fit.g[x.cls] || 0)) / fit.b }));
  const imps = per.map(x => x.imp).sort((p, q) => p - q);
  /* 1本の暴れ（極端なスローペース等）に引っ張られないよう、上下1割を落とした平均 */
  const cut = Math.floor(imps.length * 0.1), mid = imps.slice(cut, imps.length - cut || undefined);
  return { per, value: mid.length ? mean(mid) : null };
}
const histOnly = hist.filter(x => !meetDays.includes(x.day));
const fit = fitTime(histOnly);
/* 検証：開催日を1日ずつ外して当て直し、その日の逆算値を公式の値と比べる（3R 以上ある日） */
const cv = [];
const histDays = [...new Set(histOnly.map(x => x.day))];
for (const d of histDays) {
  const test = histOnly.filter(x => x.day === d); if (test.length < 3) continue;
  const f = fitTime(histOnly.filter(x => x.day !== d));
  const imp = impliedPen(f, test).value; if (imp == null) continue;
  const base = mean(histOnly.filter(x => x.day !== d).map(x => x.pen));
  cv.push({ day: d, actual: test[0].pen, implied: r2(imp), base: r2(base) });
}
const mae = mean(cv.map(x => Math.abs(x.implied - x.actual))), maeBase = mean(cv.map(x => Math.abs(x.base - x.actual)));
/* 逆算の生の値は相関は高い（約0.7）が振れ幅が大きすぎる（G1 の多い日・ペースで時計が動く）。
   公式 ＝ c0 + c1 × 逆算 の直線で較正する。精度は1日ずつ外した当てはめで測る（較正の分も先読みしない） */
const lin = a => { const mx = mean(a.map(x => x.implied)), my = mean(a.map(x => x.actual)); let sxy = 0, sxx = 0; for (const x of a) { sxy += (x.implied - mx) * (x.actual - my); sxx += (x.implied - mx) ** 2; } const c1 = sxx ? sxy / sxx : 0; return [my - c1 * mx, c1]; };
const cal = cv.length >= 8 ? lin(cv) : [null, null];
const calErr = cv.length >= 8 ? mean(cv.map((x, i) => { const [c0, c1] = lin(cv.filter((_, k) => k !== i)); x.est = r2(c0 + c1 * x.implied); return Math.abs(x.est - x.actual); })) : null;
const calib = v => v == null || cal[0] == null ? null : r2(cal[0] + cal[1] * v);
const corr = (() => { const xs = cv.map(x => x.implied), ys = cv.map(x => x.actual), mx = mean(xs), my = mean(ys); let a = 0, b = 0, c = 0; xs.forEach((x, i) => { a += (x - mx) * (ys[i] - my); b += (x - mx) ** 2; c += (ys[i] - my) ** 2; }); return b && c ? a / Math.sqrt(b * c) : null; })();
/* 翌日の開催（1〜2日あと）でペネトロメーターがどう動いたか */
const pDays = Object.keys(penByDay).sort();
const nextDay = [];
for (let i = 1; i < pDays.length; i++) {
  const gap = (Date.parse(pDays[i]) - Date.parse(pDays[i - 1])) / 86400000;
  if (gap <= 2 && !meetDays.includes(pDays[i])) nextDay.push({ from: pDays[i - 1], to: pDays[i], d: r2(penByDay[pDays[i]] - penByDay[pDays[i - 1]]) });
}
const dsort = nextDay.map(x => x.d).sort((a, b) => a - b), q = p => dsort.length ? dsort[Math.min(dsort.length - 1, Math.floor(p * dsort.length))] : null;

/* ── 2) 週末の各レース ── */
const arc = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'analysis.json'), 'utf8')); } catch { return null; } })();
const jaName = new Map((arc?.horses || []).map(h => [norm(h.en), h.name]));
/* PMU の paysEntrainement は日本馬を「France」と返す（現地の滞在厩舎）。凱旋門賞の出走馬は JRA の確定出馬表の調教国を使う */
const arcCountry = new Map((arc?.horses || []).map(h => [norm(h.en), h.country]));
const BET = { SIMPLE_GAGNANT: '単勝', SIMPLE_PLACE: '複勝', COUPLE_GAGNANT: '馬連', COUPLE_PLACE: 'ワイド', COUPLE_ORDRE: '馬単', TRIO: '三連複', TIERCE: 'ティエルセ（三連単）', TRIO_ORDRE: '三連単' };
/* レース後コメントから通った位置を拾う（フランス語の決まり文句） */
const POS = [
  ['内', /(à|a) la corde|en dedans|le long de la lice|côté corde|cote corde|à l'intérieur|a l'interieur|le long du rail/i],
  ['外', /à l'extérieur|a l'exterieur|au large|en pleine piste|très large|tres large|par l'extérieur|par l'exterieur|en dehors/i],
  ['前', /en tête|en tete|aux avant-postes|dans le sillage (du|des) (leader|animateur)|a mené|a mene|mené|mene le train|au commandement|en deuxième position|en troisième position|dans le groupe de tête|dans le groupe de tete/i],
  ['後', /en queue|à l'arrière|a l'arriere|dans les derniers|dernier|attentiste|patient|en retrait|dans la seconde partie|au sein du peloton|dans le dernier tiers/i],
];
const posTags = t => POS.filter(([, re]) => re.test(t || '')).map(([k]) => k);

const days = [];
for (const day of meetDays) {
  const lon = rd(`lon.${day}.json`); if (!lon) continue;
  const races = [];
  for (const c of lon.courses) {
    const key = `${day}.C${c.numOrdre}`;
    const part = rd(`part.${key}.json`), perf = rd(`perf.${key}.json`), pay = rd(`pay.${key}.json`);
    /* 出走馬のページに着順がまだ無いときはレースの着順（ordreArrivee）から補う */
    const placeBy = new Map(); (c.ordreArrivee || []).forEach((g, i) => g.forEach(no => placeBy.set(no, i + 1)));
    const perfBy = new Map((perf?.participants || []).map(p => [p.numPmu, p.coursesCourues || []]));
    const done = !!c.arriveeDefinitive || c.statut?.startsWith('ARRIVEE');
    const runners = (part?.participants || []).map(p => {
      const rd5 = (perfBy.get(p.numPmu) || []).slice(0, 5).map(x => {
        const me = x.participants?.find(y => y.itsHim) || {};
        const win = x.participants?.find(y => y.place?.place === 1);
        return {
          date: new Date(x.date + (x.timezoneOffset || 0)).toISOString().slice(0, 10), track: x.hippodrome, race: x.nomPrix, dist: x.distance,
          going: goingOf(x.etatTerrain), field: x.nbParticipants, place: me.place?.place ?? null, raw: me.place?.statusArrivee !== 'PLACE' ? (me.place?.rawValue || me.place?.statusArrivee || null) : null,
          gap: me.distanceAvecPrecedent?.rawValue || null, jockey: me.nomJockey || null, kg: me.poidsJockey || null, draw: me.corde ?? null,
          time: x.tempsDuPremier ? r2(x.tempsDuPremier / 1000) : null, winner: win && !win.itsHim ? win.nomCheval : null, prize: x.allocation || null,
        };
      });
      /* 道悪（重・不良寄り）とそれ以外での着順。前5走だけなので目安 */
      const soft = rd5.filter(x => /souple|lourd|collant/i.test(x.going?.fr || '') && !/bon souple/i.test(x.going?.fr || '')), firm = rd5.filter(x => x.going && !soft.includes(x));
      const rel = a => { const v = a.filter(x => x.place && x.field > 1).map(x => 1 - (x.place - 1) / (x.field - 1)); return v.length ? r2(mean(v)) : null; };
      return {
        no: p.numPmu, name: p.nom, ja: jaName.get(norm(p.nom)) || null, age: p.age, sex: p.sexe === 'FEMELLES' ? '牝' : p.sexe === 'HONGRES' ? 'セ' : '牡',
        draw: p.placeCorde ?? null, kg: p.handicapPoids ? p.handicapPoids / 10 : null, rating: p.handicapValeur ?? null,
        jockey: p.driver || null, trainer: p.entraineur || null, owner: p.proprietaire || null, breeder: p.eleveur || null,
        country: arcCountry.get(norm(p.nom)) || ja(COUNTRY, p.paysEntrainement), bred: ja(COUNTRY, p.pays), sire: p.nomPere || null, dam: p.nomMere || null, bms: p.nomPereMere || null,
        blinkers: p.oeilleres && p.oeilleres !== 'SANS_OEILLERES' ? p.oeilleres.replace(/^OEILLERES_/, '') : null,
        musique: p.musique || null, starts: p.nombreCourses ?? null, wins: p.nombreVictoires ?? null, places: p.nombrePlaces ?? null,
        earn: p.gainsParticipant?.gainsCarriere != null ? Math.round(p.gainsParticipant.gainsCarriere / 100) : null,
        odds: p.dernierRapportDirect?.rapport ?? null, oddsRef: p.dernierRapportReference?.rapport ?? null, fav: !!p.dernierRapportDirect?.favoris,
        out: p.statut && p.statut !== 'PARTANT' ? p.statut : null, place: p.ordreArrivee ?? placeBy.get(p.numPmu) ?? null,
        comment: p.commentaireApresCourse?.texte || null, pos: posTags(p.commentaireApresCourse?.texte), softRel: rel(soft), softN: soft.filter(x => x.place).length, firmRel: rel(firm), form: rd5,
      };
    }).sort((a, b) => a.no - b.no);
    /* 人気：出走する馬の単勝オッズ順 */
    [...runners].filter(h => !h.out && h.odds > 1).sort((a, b) => a.odds - b.odds).forEach((h, i) => { h.pop = i + 1; });
    const payouts = (pay || []).filter(x => BET[x.typePari]).map(x => ({ bet: BET[x.typePari], rows: (x.rapports || []).filter(r => r.dividendePourUnEuro > 0 && !/NP/.test(r.combinaison)).slice(0, 3).map(r => ({ combo: r.combinaison, yen: r.dividendePourUnEuro != null ? r.dividendePourUnEuro / 100 : null })) }));
    const row = { day, r: c.numOrdre, key: `${c.distance}|${pisteOf(c.parcours)}`, cls: clsOf(c.categorieParticularite), pen: pen(c), spk: c.dureeCourse ? c.dureeCourse / c.distance : null };
    const imp = done && !arabian(c) && row.spk && fit.a[row.key] != null ? r2((row.spk - fit.a[row.key] - (fit.g[row.cls] || 0)) / fit.b) : null;
    const std = !arabian(c) && fit.a[row.key] != null ? r2((fit.a[row.key] + (fit.g[row.cls] || 0) + fit.b * (row.pen ?? 3.4)) * c.distance / 1000) : null;
    /* 凱旋門賞だけは arc.html の比較指数の印を載せる。馬場の想定は当日の公式の硬度から（無ければ稍重想定） */
    let markScenario = null;
    if (/ARC DE TRIOMPHE/i.test(c.libelle) && arc?.predictions) {
      const p = pen(c), sc = p == null ? 'soft' : p <= 3.3 ? 'dry' : p <= 3.8 ? 'soft' : 'heavy';
      markScenario = { dry: '乾いた馬場', soft: '標準（稍重〜重）', heavy: '渋った馬場' }[sc] + (p == null ? '（当日の計測前の既定）' : `（公式 ${p}）`);
      const mk = new Map((arc.predictions[sc] || []).map(h => [norm(h.en), h.mark]));
      for (const h of runners) { const m = mk.get(norm(h.name)); if (m && m !== '—') h.mark = m; }
    }
    races.push({ markScenario,
      r: c.numOrdre, name: c.libelle, short: c.libelleCourt, post: c.heureDepart, dist: c.distance, piste: pisteOf(c.parcours), parcours: c.parcours,
      cls: clsOf(c.categorieParticularite), grade: c.categorieParticularite, age: c.conditionAge, sexCond: c.conditionSexe, prize: c.montantPrix, n: c.nombreDeclaresPartants,
      openStretch: /open stretch/i.test(c.conditions || ''), pen: row.pen, going: goingOf(c.penetrometre?.intitule), status: c.statut, done,
      time: c.dureeCourse ? r2(c.dureeCourse / 1000) : null, stdTime: std, impliedPen: imp, arrival: c.ordreArrivee || null, incidents: c.incidents || null,
      arc: /ARC DE TRIOMPHE/i.test(c.libelle), arabian: arabian(c), runners, payouts,
    });
  }
  /* その日の確定レースからの逆算と、上位3頭の位置取り */
  const fin = races.filter(r => r.done && r.time);
  const dayRows = fin.filter(r => !r.arabian).map(r => ({ day, r: r.r, key: `${r.dist}|${r.piste}`, cls: r.cls, spk: r.time / (r.dist / 1000) }));
  const ip = impliedPen(fit, dayRows);
  const top3 = fin.flatMap(r => r.runners.filter(h => h.place && h.place <= 3).map(h => ({ ...h, field: r.runners.filter(x => !x.out).length, r: r.r })));
  const tag = k => top3.filter(h => h.pos.includes(k)).length;
  const drawRel = top3.filter(h => h.draw && h.field > 1).map(h => (h.draw - 1) / (h.field - 1));
  days.push({
    day, meteo: lon.meteo, pen: races.find(r => r.pen != null)?.pen ?? null, going: races.find(r => r.going)?.going || null, races,
    readout: { finished: fin.length, implied: r2(ip.value), est: calib(ip.value), perRace: ip.per.map(x => ({ r: x.r, imp: r2(x.imp) })), top3: top3.length, inside: tag('内'), outside: tag('外'), front: tag('前'), back: tag('後'), drawRel: r2(mean(drawRel)), inner: drawRel.filter(x => x < 1 / 3).length, outer: drawRel.filter(x => x > 2 / 3).length },
  });
}

/* ── 3) 過去のロンシャンのまとめ（場の特徴の実測） ── */
const byKey = {};
for (const x of histOnly) { const k = x.key; (byKey[k] ||= []).push(x); }
const courses = Object.entries(byKey).map(([k, a]) => ({ key: k, dist: +k.split('|')[0], piste: k.split('|')[1], n: a.length, base: r2(fit.a[k] * (+k.split('|')[0]) / 1000), best: r2(Math.min(...a.map(x => x.spk)) * (+k.split('|')[0]) / 1000) })).filter(x => x.n >= 3).sort((a, b) => a.dist - b.dist || b.n - a.n);
const penBands = [[0, 3.2, '〜3.2（良）'], [3.2, 3.5, '3.3〜3.5（稍重）'], [3.5, 3.9, '3.6〜3.9（重）'], [3.9, 9, '4.0〜（重〜不良）']].map(([lo, hi, label]) => ({ label, days: pDays.filter(d => !meetDays.includes(d) && penByDay[d] > lo && penByDay[d] <= hi).length }));
const out = {
  version: 1, builtAt: new Date().toISOString(), meetDays, days,
  going: {
    fit: { b: r2(fit.b), races: histOnly.length, days: histDays.length, from: histDays[0], to: histDays.at(-1), cls: Object.fromEntries(Object.entries(fit.g).map(([k, v]) => [k, r2(v)])) },
    cv: { n: cv.length, mae: r2(mae), maeBase: r2(maeBase), corr: r2(corr), calMae: r2(calErr), cal: cal.map(r2), rows: cv.slice(-40),
      /* 前年の凱旋門賞の週末（同じ検証の中から）。この週末は G1 が多く、物差しの外れ方を見せる */
      lastArc: cv.filter(x => Math.abs(Date.parse(x.day) - (Date.parse(DAY_ARC) - 364 * 86400000)) <= 3 * 86400000) },
    nextDay: { n: nextDay.length, median: q(0.5), lo: q(0.1), hi: q(0.9), rows: nextDay.slice(-12) },
    seasonPen: pDays.filter(d => !meetDays.includes(d)).slice(-30).map(d => ({ day: d, pen: penByDay[d] })), penBands,
  },
  courses,
  sources: [
    { name: 'PMU（出馬表・前走・結果・払戻・ペネトロメーター）', url: 'https://online.turfinfo.api.pmu.fr/rest/client/1/programme/' + (meetDays[0] || '').split('-').reverse().join('') },
    { name: 'JRA 海外競馬発売「パリロンシャン競馬場」コース紹介', url: 'https://www.jra.go.jp/keiba/overseas/country/france/longchamp.html' },
    { name: 'JRA 2026年凱旋門賞 特設', url: 'https://www.jra.go.jp/keiba/overseas/race/2026arc/' },
  ],
};
fs.mkdirSync(OUT, { recursive: true });
/* 中身が前回と同じなら書かない（builtAt だけ変わって10分ごとに自動コミットされていた） */
const strip = o => JSON.stringify({ ...o, builtAt: null });
let same = false; try { same = strip(JSON.parse(fs.readFileSync(path.join(OUT, 'meet.json'), 'utf8'))) === strip(out); } catch { }
if (same) { console.log('ロンシャン 変化なし'); process.exit(0); }
fs.writeFileSync(path.join(OUT, 'meet.json.tmp'), JSON.stringify(out)); fs.renameSync(path.join(OUT, 'meet.json.tmp'), path.join(OUT, 'meet.json'));
const page = path.join(ROOT, 'longchamp.html');
if (fs.existsSync(page)) {
  const s = fs.readFileSync(page, 'utf8');
  if (!s.includes('/* LC:BEGIN */')) throw new Error('longchamp.html に LC マーカーがありません');
  const data = JSON.stringify(out).replace(/</g, '\\u003c');
  fs.writeFileSync(page + '.tmp', s.replace(/\/\* LC:BEGIN \*\/[\s\S]*?\/\* LC:END \*\//, () => `/* LC:BEGIN */\nconst LC=${data};\n/* LC:END */`));
  fs.renameSync(page + '.tmp', page);
}
console.log(`ロンシャン 週末 ${days.map(d => `${d.day} ${d.races.length}R（確定${d.readout.finished}）`).join('／')}`);
console.log(`時計の物差し：過去 ${histOnly.length}R・${histDays.length}日、b=${r2(fit.b)}秒/km/硬度1。日ごとの逆算の検証 ${cv.length}日：生 ${r2(mae)}・較正後 ${r2(calErr)}（季節平均だけ ${r2(maeBase)}）相関 ${r2(corr)}`);
console.log(`翌日の変化（${nextDay.length}組）中央値 ${q(0.5)}・1割〜9割 ${q(0.1)}〜${q(0.9)}`);
