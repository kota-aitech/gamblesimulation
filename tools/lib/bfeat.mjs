import { tideOf } from './tide.mjs';
/* 条件付きロジット（Plackett–Luce）用の特徴量。レース前に分かる情報だけを使う。
   単位はすべて「対数オッズ差」に寄せる（南関側と同じ約束）。

   ボートは着順が進入コースにほぼ支配される。素の勝率を実力として扱うと
   1号艇の選手が全員名人に見えるので、必ず「場×コースの基準からの上振れ」で持つ。

   レベルは2つ。
     pre … 番組表と天候だけ（発走の数時間前に出せる）。進入は枠なり前提で
           場の「枠番別コース取得率」で重みづけする
     ex  … 直前情報が出たあと。進入コースが確定し、展示タイムが使える
   どちらも3年ぶんの K ファイルで学習できる（K に 展示・進入が入っているため）。 */

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const logit = p => { const q = clamp(p, 1e-3, 1 - 1e-3); return Math.log(q / (1 - q)); };
const GRADES = ['A1', 'A2', 'B1', 'B2'];

export const FEATS = [
  'cz',          // 進入コースの基準（場×コース）の対数オッズ
  'czTop2',      // 同・2連対の基準
  'rIdx',        // 選手の実力（コース補正済み）
  'rIdxC',       // そのコースでの上振れ
  'rIdxJ',       // 当地での上振れ
  'stFast',      // 平均STの速さ（+ が速い）
  'stFastC',     // そのコースでの平均STの速さ
  'natWin', 'nat2', 'locWin', 'loc2',
  'gA1', 'gA2', 'gB1',
  'age', 'weight',
  'setuAvg', 'setuN',
  'motor2', 'motorIdx', 'boat2',
  'fRate', 'makuri', 'inGain',
  'windC', 'waveC',            // windAbs/waveAbs は全艇で同じ値になり、条件付きロジットでは
                               // 構造的に係数0になるので置かない
  'wDir', 'wSpd', 'wWave',     // 場ごとに実測した「この条件でこのコースが得か損か」
  'tune', 'mUp',               // 整備力と、モーター2連率の直近の伸び
  'form', 'formN',             // 直近90日の調子（そのレースより前だけで計算）
  'mForm',                     // モーターの直近45日の調子
  'setuST', 'setuEx', 'setuRuns',  // 今節のここまでのST・展示タイム
  'ptRate', 'ptGap', 'ptRank',     // 節間の競走得点率・準優ボーダーとの差・節内順位（lib/bload.mjs の attachPoints）
  'dayIn1', 'dayOut', 'dayMak',    // その日のここまでの傾向（イン有利／外が来ている／まくりが決まる）× 進入コース
  'todayRel', 'todaySt',           // 選手の当日ここまでの走り（相対着順・ST）
  'exDev', 'exRank',           // ex レベルのみ（pre では 0）
  'setuF', 'setuF2',           // 今節にFを切っている（本数・2本以上）。F持ちはスタートを控える
  'tideC', 'tideLvlC',         // 潮の局面（上げ／下げ）と潮位の高さ × コース（干満差のある場だけ。lib/tide.mjs）
  'phFinalC', 'phSemiC',       // 優勝戦・準優勝戦 × コース（インが堅い／荒れる）
  'kyuNear', 'kyuBelow',       // 級別ボーダー争い：ボーダーに近い（期末が近いほど強く）・下から狙う側か（lib/bload.mjs の kyu）
];
/* 級別ボーダーとの差。いまの級（A1/A2/B1）ごとに見るべきボーダーが違う。B2 と出走の少ない選手は対象外 */
export function kyuGapOf(kyu, grade) {
  if (!kyu || kyu.rate == null || kyu.runs < 30 || !kyu.border) return null;
  const b = kyu.border;
  if (grade === 'A1') return { gap: kyu.rate - b.A1, target: 'A1維持', border: b.A1 };
  if (grade === 'A2') { const up = kyu.rate - b.A1, keep = kyu.rate - b.A2; return Math.abs(up) <= Math.abs(keep) ? { gap: up, target: 'A1昇格', border: b.A1 } : { gap: keep, target: 'A2維持', border: b.A2 }; }
  if (grade === 'B1') return { gap: kyu.rate - b.A2, target: 'A2昇格', border: b.A2 };
  return null;
}
export const NF = FEATS.length;

/* 今節成績の文字列（'1526' など）→ 平均着順と走数。F/K/S は6着相当に寄せる */
function setuOf(s) {
  const v = [...String(s || '')].map(c => /[1-6]/.test(c) ? Number(c) : 6.5).filter(x => x);
  return v.length ? { avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length } : { avg: 3.5, n: 0 };
}

/* 進入コースの確率ベクトル。
   ex: 実際の進入が分かっているので one-hot。
   pre: 場の「枠番別コース取得率」（stadium.json の take、％）を使う */
function courseProb(lane, course, take) {
  /* 進入固定レースは枠＝コース（pre でも確定） */
  const p = [0, 0, 0, 0, 0, 0];
  if (course) { p[course - 1] = 1; return p; }
  const row = take?.[lane - 1];
  if (!row) { p[lane - 1] = 1; return p; }
  const s = row.reduce((a, b) => a + b, 0) || 1;
  for (let c = 0; c < 6; c++) p[c] = row[c] / s;
  return p;
}

/* DB（index.json）と場データ（stadium.json）を渡して、1レースぶんの行列を作る。
   race: { jcd, date, dist, wind, wave, weather, entries|boats }
   boats[i]: { lane, toban, course?, ex?, grade, age, weight, natWin, nat2, locWin, loc2,
               motor, motor2, boat, boat2, setu } */
export function raceFeatures(race, boats, DB, ST, { level = 'pre' } = {}) {
  const jcd = race.jcd;
  const base = DB.base || {};
  const take = ST?.[jcd]?.take;
  const bz = (c, kind) => {
    const b = base[jcd + '|' + c];
    return b ? logit(b[kind]) : logit(kind === 'win' ? 1 / 6 : 2 / 6);
  };
  const exs = boats.map(b => (level === 'ex' ? b.ex : null)).filter(v => v != null);
  const exMean = exs.length ? exs.reduce((a, b) => a + b, 0) / exs.length : null;
  const exSorted = [...exs].sort((a, b) => a - b);
  /* 気象が未発表（当日の pre で直前情報がまだ無い）なら 0＝影響なし にする。
     null を 0m として「無風の表」を引くと、無風のときの偏りが乗ってしまう */
  const known = race.wind != null;
  const wind = race.wind ?? 0, wave = race.wave ?? 0;
  /* 場ごとに実測した水面条件の効き（index.json の cond）。
     風向は絶対方位で来るので、場の向きを人手で入れずにここで吸収する。 */
  const CD = DB.cond?.[jcd] || {};
  const spdB = !known ? null : wind <= 0 ? '0' : wind <= 2 ? '1-2' : wind <= 4 ? '3-4' : wind <= 6 ? '5-6' : '7+';
  const wavB = !known ? null : wave <= 2 ? '0-2' : wave <= 5 ? '3-5' : wave <= 9 ? '6-9' : '10+';
  const dirB = (wind >= 3 && race.windDir && race.windDir !== '無風') ? race.windDir : null;
  const condShift = (kind, bucket, cp) => {
    const t = bucket && CD[kind]?.[bucket];
    return t ? cp.reduce((a, p, i) => a + p * (t[i + 1] ?? 0), 0) : 0;
  };

  return boats.map(b => {
    const r = DB.racer?.[b.toban] || null;
    const cp = courseProb(b.lane, level === 'ex' ? b.course : (race.fixed ? b.lane : null), take);
    const cMid = cp.reduce((a, p, i) => a + p * (i + 1), 0);      // 期待進入コース
    const x = new Float64Array(NF);
    const set = (k, v) => { x[FEATS.indexOf(k)] = Number.isFinite(v) ? v : 0; };

    /* コース中心化（内 −1 〜 外 +1）。レース内で同じ値になる旗はこれと掛けて艇ごとの値にする */
    const cC = (cMid - 3.5) / 2.5;
    const nF = [...String(b.setu || '')].filter(ch => ch === 'F').length;
    set('setuF', nF); set('setuF2', nF >= 2 ? 1 : 0);
    const td = race.tide === undefined ? tideOf(race.jcd, race.date, race.close) : race.tide;
    set('tideC', td ? td.phase * cC : 0); set('tideLvlC', td ? td.lvl * cC : 0);
    const cls = race.cls || '';
    set('phFinalC', /優勝戦/.test(cls) && !/準優/.test(cls) ? cC : 0); set('phSemiC', /準優/.test(cls) ? cC : 0);
    const kg = kyuGapOf(b.kyu, b.grade);
    const near = kg ? Math.max(0, 1 - Math.abs(kg.gap) / 0.4) * ((b.kyu.daysLeft ?? 999) <= 75 ? 1 : 0.4) : 0;
    set('kyuNear', near); set('kyuBelow', kg && kg.gap < 0 ? near : 0);
    set('cz', cp.reduce((a, p, i) => a + p * bz(i + 1, 'win'), 0) - logit(1 / 6));
    set('czTop2', cp.reduce((a, p, i) => a + p * bz(i + 1, 'top2'), 0) - logit(2 / 6));

    set('rIdx', r?.idx ?? 0);
    set('rIdxC', r ? cp.reduce((a, p, i) => a + p * (r.byC?.[i + 1] ?? 0), 0) : 0);
    set('rIdxJ', r?.byJ?.[jcd] ?? 0);
    set('stFast', r?.stDev != null ? -r.stDev * 10 : 0);          // 0.01秒＝0.1 の目盛りに
    set('stFastC', r ? cp.reduce((a, p, i) => a + p * (r.stByC?.[i + 1] != null && r.st != null ? -(r.stByC[i + 1] - r.st) * 10 : 0), 0) : 0);

    set('natWin', (b.natWin ?? 5.5) - 5.5);
    set('nat2', ((b.nat2 ?? 35) - 35) / 10);
    set('locWin', b.locWin ? b.locWin - 5.5 : 0);
    set('loc2', b.loc2 ? (b.loc2 - 35) / 10 : 0);
    set('gA1', b.grade === 'A1' ? 1 : 0);
    set('gA2', b.grade === 'A2' ? 1 : 0);
    set('gB1', b.grade === 'B1' ? 1 : 0);
    set('age', ((b.age ?? 38) - 38) / 10);
    set('weight', ((b.weight ?? 52) - 52) / 5);

    const su = setuOf(b.setu);
    set('setuAvg', (3.5 - su.avg) / 2);
    set('setuN', clamp(su.n, 0, 6) / 6);

    set('motor2', ((b.motor2 ?? 35) - 35) / 10);
    set('motorIdx', DB.motor?.[jcd]?.[b.motor + '#' + (b.motorGen || 1)]?.idx ?? 0);
    set('boat2', ((b.boat2 ?? 35) - 35) / 10);

    set('fRate', -(r?.fRate ?? 0) * 20);
    set('makuri', r?.kim ? (r.kim[1] + r.kim[3]) - 0.35 : 0);
    /* 前づけ癖。枠より内を取る選手は pre の段階で進入が読みにくい */
    set('inGain', level === 'ex' ? 0 : (r?.inGain ?? 0));

    /* 風・波はコースによって効き方が変わる。中心（3.5コース）からのズレに掛ける */
    set('windC', wind * (cMid - 3.5) / 10);
    set('waveC', wave * (cMid - 3.5) / 100);
    set('wDir', condShift('dir', dirB, cp));
    set('wSpd', condShift('spd', spdB, cp));
    set('wWave', condShift('wav', wavB, cp));

    set('tune', r?.tune ?? 0);
    set('mUp', b.mUp != null ? b.mUp / 5 : 0);

    /* 時点つきの指標（lib/bload.mjs が「そのレースより前」だけで作る） */
    set('form', (b.form ?? 0) * 4);
    set('formN', Math.min(1, (b.formN ?? 0) / 25));
    set('mForm', (b.mForm ?? 0) * 4);
    /* 今節のST。本人の平常値より速ければ + */
    set('setuST', b.setuST != null && r?.st != null ? (r.st - b.setuST) * 10 : 0);
    set('setuEx', b.setuEx != null ? b.setuEx * 20 : 0);
    set('setuRuns', Math.min(1, (b.setuRuns ?? 0) / 6));
    /* 競走得点。初日（今節の成績なし）は 0。得点率は 5.5 を中心に、ボーダー差は ±2点で ±1 に */
    set('ptRate', b.ptRate != null ? (b.ptRate - 5.5) / 2 : 0);
    set('ptGap', b.ptGap != null ? clamp(b.ptGap / 2, -2, 2) : 0);
    set('ptRank', b.ptRank != null && b.ptTot > 1 ? 0.5 - (b.ptRank - 1) / (b.ptTot - 1) : 0);

    /* その日のここまでの傾向。場全体の値なので、コースとの掛け算で艇ごとの値にする */
    set('dayIn1', (b.dayIn1 ?? 0) * 2 * (cp[0] - 1 / 6));
    set('dayOut', (b.dayOut ?? 0) / 2 * (cMid - 3.5) / 2.5);
    set('dayMak', (b.dayMak ?? 0) * 2 * (cMid - 3.5) / 2.5);
    set('todayRel', (b.todayRel ?? 0) * 2);
    set('todaySt', b.todaySt != null && r?.st != null ? (r.st - b.todaySt) * 10 : 0);

    if (level === 'ex' && b.ex != null && exMean != null) {
      set('exDev', (exMean - b.ex) * 20);                          // 速いほど +
      set('exRank', (3.5 - (exSorted.indexOf(b.ex) + 1)) / 2);
    }
    return x;
  });
}
