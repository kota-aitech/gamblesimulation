/* 出馬表1頭ぶんの推定値（脚質・能力・上がり・距離・道悪）と、
   人的要因・血統の指数、寸評をまとめて作る。
   build_races.mjs（本番データ生成）と backtest.mjs（検証）で同じものを使うため、
   ここに切り出してある。DB は data/nankan/index.json。                       */
export function makeDerivers(DB, SK, FM) {
  const r2 = x => Math.round(x * 100) / 100;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const W = [1, .85, .7, .55, .45];                      // 前走ほど重い
  
  /* 略称（前走欄は「御神訓」など）→ 騎手レコード。部分列一致 */
  const JLIST = Object.values(DB.jockey).sort((a, b) => b.n - a.n);
  const JEXACT = new Map(JLIST.map(x => [x.name, x]));
  function jockeyByName(nm) {
    if (!nm) return null;
    if (JEXACT.has(nm)) return JEXACT.get(nm);
    for (const x of JLIST) { let i = 0; for (const ch of x.name) if (ch === nm[i]) i++; if (i === nm.length) return x; }
    return null;
  }
  
  const wavg = (arr, f) => {
    let s = 0, w = 0;
    arr.forEach((x, i) => { const v = f(x); if (v == null) return; s += v * W[i]; w += W[i]; });
    return w ? s / w : null;
  };
  const rel = p => p.field > 1 ? 1 - (p.pos - 1) / (p.field - 1) : 0.5;
  
  /* 脚質判定：前5走の1角（＝序盤）通過順を頭数+1で割った比率の加重平均。
     閾値は cards.jsonl 全体（約12,800 頭走）の分布を見て、
     逃げ12% / 先行33% / 差し41% / 追込14% になる位置に置いてある。
     逃げは「常に1〜2番手」という定義を優先して絶対順位でも拾う。            */
  function styleOf(past) {
    const rs = past.filter(p => p.corners.length && p.field > 1);
    if (!rs.length) return { style: '先行', pos: null, ratio: null };
    const early = rs.map(p => p.corners[0]);
    let sA = 0, sR = 0, w = 0;
    rs.forEach((p, i) => { const k = W[i] ?? 0.4; sA += early[i] * k; sR += early[i] / (p.field + 1) * k; w += k; });
    const abs = sA / w, ratio = sR / w;
    const style = (abs <= 2.0 || ratio <= 0.22) ? '逃げ' : ratio <= 0.45 ? '先行' : ratio <= 0.72 ? '差し' : '追込';
    return { style, pos: r2(abs), ratio: r2(ratio) };
  }
  
  function derive(h, dist) {
    const past = h.past.slice(0, 5);
    const st = styleOf(past);
    const rw = wavg(past, rel);
    const ability = past.length ? clamp(0.19 + 0.58 * Math.pow(clamp(rw, 0, 1), 1.25), .15, .92) : .45;
    const f3 = wavg(past, p => p.last3f);
    const rank3 = wavg(past, p => (p.last3fRank && p.field ? 1 - (p.last3fRank - 1) / Math.max(1, p.field - 1) : null));
    let close = f3 ? clamp(0.70 - (f3 - 36.5) * 0.10, .25, .85) : .5;
    if (rank3 != null) close = clamp(close * 0.75 + (0.25 + 0.55 * rank3) * 0.25, .2, .9);
    const near = past.filter(p => Math.abs(p.dist - dist) <= 200);
    const maxD = past.length ? Math.max(...past.map(p => p.dist)) : dist;
    const stamina = near.length ? clamp(0.20 + 0.60 * wavg(near, rel), .2, .9)
      : clamp((dist > maxD ? .40 : .50) + 0.15 * (rw ?? .5), .25, .7);
    const wetR = past.filter(p => p.baba !== '良');
    const wet = wetR.length ? clamp(0.20 + 0.60 * wavg(wetR, rel), .2, .9) : .5;
    return { style: st.style, st, epos: st.ratio, ability: r2(ability), close: r2(close), stamina: r2(stamina), wet: r2(wet), f3: f3 ? r2(f3) : null };
  }
  
  /* 種牡馬名は出馬表が半角、リーディングが全角のことがあるので正規化して突き合わせる */
  const norm = x => (x || '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  
  /* 血統の寄与。実績（前5走）が少ない馬ほど重く、5走そろっていれば 0 にする。
     父の全体指数＋今回距離での偏り＋母の父 を足して、信頼度で減衰させる。 */
  function pedigree(h, dist) {
    const S = DB.sire[norm(h.sire)], B = DB.bms[norm(h.damSire)];
    const sD = S && S.byDist && S.byDist[dist] ? S.byDist[dist].idx : 0;
    const conf = Math.max(0, 1 - h.past.length / 4);
    const raw = (S ? S.idx : 0) + 0.45 * sD + 0.35 * (B ? B.idx : 0);
    return { sire: h.sire, damSire: h.damSire,
      sIdx: S ? r2(S.idx) : 0, sN: S ? S.n : 0, sDist: r2(sD), sDistN: S && S.byDist && S.byDist[dist] ? S.byDist[dist].n : 0,
      bmsIdx: B ? r2(B.idx) : 0, bmsN: B ? B.n : 0,
      bIdx: r2(raw * conf), bConf: r2(conf) };
  }
  
  function human(h, track) {
    const J = DB.jockey['kis' + h.jockeyId], T = DB.trainer['cho' + h.trainerId];
    const C = DB.combo[`kis${h.jockeyId}|cho${h.trainerId}`];
    const O = DB.owner[h.owner];
    const prevJ = h.past.length ? jockeyByName(h.past[0].jockey) : null;
    const jIdx = J ? J.idx : 0, tIdx = T ? T.idx : 0;
    const cIdx = C ? C.cIdx : 0, bond = C ? C.bond : 0;
    const jUp = prevJ ? r2(jIdx - prevJ.idx) : 0;
    const spot = (bond < 0.08 && jIdx > 0.30) ? 1 : 0;
    const away = (h.trainerBase && h.trainerBase !== track ? 0.5 : 0) + (h.jockeyBase && h.jockeyBase !== track ? 0.5 : 0);
    const oAgg = O ? O.oAgg : 0, oIdx = O ? O.oIdx3 : 0;
    const shobu = clamp(0.55 * jUp + 0.35 * spot * jIdx + 0.30 * oAgg + 0.12 * away, -1, 1.5);
    const hIdx = DB.fit.wJ * jIdx + DB.fit.wT * tIdx + cIdx + 0.20 * oIdx + 0.30 * shobu;
    return {
      jockey: h.jockey, jockeyBase: h.jockeyBase, trainer: h.trainer, trainerBase: h.trainerBase, owner: h.owner,
      jIdx: r2(jIdx), tIdx: r2(tIdx), cIdx: r2(cIdx), bond: r2(bond),
      cN: C ? C.n : 0, cW: C ? C.w : 0, cRate: C ? r2(C.winRate) : 0,
      oIdx: r2(oIdx), oAgg: r2(oAgg), oN: O ? O.n : 0,
      prevJockey: prevJ ? prevJ.name : (h.past[0]?.jockey || ''), jUp, spot, away: r2(away),
      shobu: r2(shobu), hIdx: r2(hIdx),
    };
  }
  
  /* 寸評。読んで分かる日本語にする。
     note は [見出し, 本文] の配列で、race.html が見出しつきで組む。
     memo はそれを1行に連ねたもの（sim.html 用）。                          */
  function chaku(rs) {
    const c = [0, 0, 0, 0];
    rs.forEach(p => c[Math.min(p.pos, 4) - 1]++);
    return `[${c[0]}-${c[1]}-${c[2]}-${c[3]}]`;
  }
  /* 能力・調教試験。前走が無い馬にとっては唯一の実走記録なので必ず出す */
  function shikenOf(h) {
    const r = SK && SK.by ? SK.by.get(h.horseId) : null;
    if (!r) return null;
    const diff = SK.med ? +(r.time - SK.med).toFixed(1) : null;
    return { date: r.date, track: r.track, time: r.time, pass: r.pass, bw: r.bw,
      jockey: r.jockey, diff, fast: diff != null && diff <= -1 };
  }

  /* 馬体重。今回の値と、その馬の普段との差 */
  function bodyOf(h) {
    if (!h.bw) return null;
    const ws = (h.past || []).map(p => p.kg).filter(x => x > 0);
    const avg = ws.length ? Math.round(ws.reduce((a, b) => a + b, 0) / ws.length) : null;
    const dev = avg ? h.bw - avg : null;
    return { bw: h.bw, diff: h.bwDiff ?? null, avg, dev,
      note: dev == null ? '' : dev >= 10 ? '普段より重め' : dev <= -10 ? '普段より絞れている' : '' };
  }
  /* 騎手の調子（そのレース時点の直近成績。平常値と比べて上か下か） */
  function formOf(h, raceId) {
    if (!FM || !h.jockeyId) return null;
    const J = DB.jockey['kis' + h.jockeyId];
    const f = FM.get(raceId, 'j', h.jockeyId, J ? J.idx : 0);
    if (!f.n || f.n < 20) return null;
    return { n: f.n, form: r2(f.form), rides30: f.rides30,
      label: f.form >= 0.25 ? '好調' : f.form <= -0.25 ? '不振' : '平常' };
  }

  function memoOf(h, d, hu, pd, dist, raceId) {
    const note = [];
    const past = h.past || [];
    const p0 = past[0];

    /* 近走：前走の中身＋近走の着順並び。文にせず要点だけ */
    if (p0) {
      const run = p0.corners && p0.corners.length
        ? (p0.corners[0] <= 2 ? '逃げて' : p0.corners[0] / (p0.field + 1) <= 0.45 ? '前で' : p0.corners[0] / (p0.field + 1) <= 0.72 ? '中団' : '後方')
        : '';
      const in3 = past.filter(x => x.pos <= 3).length;
      note.push(['近走', `前走 ${p0.track}${p0.dist}${p0.baba !== '良' ? p0.baba : ''} ${p0.pop}人気${run}${p0.pos}着`
        + `／近${past.length}走 ${past.map(x => x.pos).join('-')}（3着内${in3}）`]);
    } else {
      note.push(['近走', '南関の前走なし（新馬・転入初戦）']);
    }

    /* 能力試験（前走が無いときは近走の代わりにここが手がかり）*/
    const sk = shikenOf(h);
    if (sk && (past.length < 3)) {
      note.push(['能力試験', `${sk.date.slice(5).replace('-', '/')} ${sk.track} ${sk.time}秒 ${sk.pass}`
        + (sk.diff != null ? `（平均比 ${sk.diff >= 0 ? '+' : ''}${sk.diff}秒${sk.fast ? '・速い' : ''}）` : '')
        + (sk.bw ? `／${sk.bw}kg` : '')]);
    }

    /* 脚質：型・位置・上がり */
    const legs = [d.style];
    if (d.st.pos != null) legs.push(`3角${d.st.pos.toFixed(1)}番手`);
    if (d.f3) legs.push(`上がり${d.f3}秒${d.close >= 0.65 ? '（速い）' : d.close <= 0.45 ? '（遅い）' : ''}`);
    note.push(['脚質', legs.join('・')]);

    /* 条件：距離と道悪。着度数だけ */
    const cond = [];
    const near = past.filter(p => Math.abs(p.dist - (dist || 0)) <= 200);
    cond.push(near.length ? `今回距離 ${near.length}戦${chaku(near)}`
      : past.length ? `今回距離は未経験（最長${Math.max(...past.map(p => p.dist))}m）` : '距離実績なし');
    const wet = past.filter(p => p.baba !== '良');
    cond.push(wet.length ? `道悪 ${wet.length}戦${chaku(wet)}` : '道悪未経験');
    note.push(['条件', cond.join('／')]);

    /* 馬体重 */
    const bd = bodyOf(h);
    if (bd) {
      const bits2 = [`${bd.bw}kg${bd.diff != null ? `（${bd.diff >= 0 ? '+' : ''}${bd.diff}）` : ''}`];
      if (bd.avg) bits2.push(`平均${bd.avg}kg${bd.note ? '・' + bd.note : ''}`);
      note.push(['馬体', bits2.join('／')]);
    }

    /* 人：コンビと乗り替わりだけ */
    const fo = formOf(h, raceId);
    const man = [`${hu.jockey}×${hu.trainer}`];
    if (fo && fo.label !== '平常') man.push(`${hu.jockey}は直近${fo.n}騎乗が${fo.label}`);
    if (hu.cN >= 20) man.push(`コンビ${hu.cN}走${hu.cW}勝${hu.bond >= 0.30 ? '・主戦' : hu.bond >= 0.12 ? '・準主戦' : ''}`);
    else man.push(hu.cN ? `コンビ${hu.cN}走のみ` : 'コンビ初');
    if (hu.jUp >= 0.35) man.push('騎手強化');
    else if (hu.jUp <= -0.35) man.push('騎手弱化');
    if (hu.spot) man.push('スポット起用');
    note.push(['人', man.join('／')]);

    /* 血統：名前と、効いているときだけ数値 */
    if (pd && pd.sire) {
      const b = [`父${pd.sire}`];
      if (pd.damSire) b.push(`母父${pd.damSire}`);
      if (pd.sDistN >= 50 && Math.abs(pd.sDist) >= 0.15) b.push(`この距離${pd.sDist >= 0 ? '+' : ''}${pd.sDist}`);
      note.push(['血統', b.join('／')]);
    }

    /* brief：縦型の柱に入れる1行。目を引く要素だけ拾う */
    const bits = [];
    if (p0) bits.push(`前走${p0.pop}人気${p0.pos}着`);
    else if (sk) bits.push(`試験${sk.time}秒${sk.fast ? '(速)' : ''}`);
    if (bd && bd.note) bits.push(bd.note);
    if (fo && fo.label !== '平常') bits.push(`騎手${fo.label}`);
    bits.push(d.style);
    if (hu.jUp >= 0.35) bits.push('騎手強化');
    else if (hu.spot) bits.push('スポット');
    if (d.wet >= 0.65 && wet.length >= 2) bits.push('道悪巧者');
    if (d.close >= 0.68) bits.push('決め手');
    return { note, brief: bits.join('・'), memo: note.map(([k, v]) => `【${k}】${v}`).join('') };
  }

  return { derive, human, pedigree, memoOf, shikenOf, bodyOf, formOf, styleOf, jockeyByName, norm };
}
