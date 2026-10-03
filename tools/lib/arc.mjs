// 凱旋門賞専用。取得した公開情報の解析と、検証前の比較指数。
export const DAY = '2026-10-04';
export const RACE_TIME = '2026-10-04T16:05:00+02:00';
export const SOURCES = {
  card: 'https://www.jra.go.jp/news/202610/pdf/100204.pdf',
  horse: 'https://www.jra.go.jp/keiba/overseas/race/2026arc/horse.html',
  past: 'https://www.jra.go.jp/keiba/overseas/race/2026arc/past.html',
  history: 'https://www.jra.go.jp/keiba/overseas/race/2026arc/history.html',
  form: 'https://race.netkeiba.com/race/shutuba_past.html?race_id=2026C8010105',
  netkeiba: 'https://race.netkeiba.com/race/shutuba_past_9.html?race_id=2026C8010105',
  overseas: 'https://www.sportinglife.com/racing/news/ryan-moore-rides-benvenuto-cellini-in-arc-de-triomphe/234599',
  meteo: 'https://open-meteo.com/en/docs',
  era5: 'https://open-meteo.com/en/docs/historical-weather-api',
  wd_winners: 'https://www.wikidata.org/wiki/Q422296',
};
export function clean(s = '') {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : +n))
    .replace(/&(nbsp|amp|lt|gt|quot|apos|eacute|ecirc);/g, (_, n) => ({nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",eacute:'é',ecirc:'ê'}[n]))
    .replace(/\s+/g, ' ').trim();
}
export const norm = s => clean(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function decode(buf) {
  const meta = buf.toString().slice(0, 2000).match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
  return new TextDecoder(meta).decode(buf);
}
export const number = s => { const m = String(s ?? '').match(/\d+(?:\.\d+)?/); return m ? +m[0] : null; };
export function tables(s) {
  return [...s.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(t => {
    const rows = [], spans = [];
    for (const tr of t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = []; let col = 0;
      const skip = () => { while (spans[col]?.left > 0) { row[col] = spans[col].value; spans[col].left--; col++; } };
      for (const td of tr[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
        skip(); const value = clean(td[2]); const r = +(td[1].match(/rowspan=["']?(\d+)/)?.[1] || 1);
        const c = +(td[1].match(/colspan=["']?(\d+)/)?.[1] || 1);
        for (let j=0;j<c;j++) { row[col]=value; if(r>1)spans[col]={left:r-1,value}; col++; }
      }
      skip(); if(row.length)rows.push(row);
    }
    return rows;
  });
}
export function parseCard(s) {
  const out = [];
  for (const line of s.split('\n')) {
    const m = line.match(/^\s*(\d{1,2})\s+(\d{3})\s+(.+?)\s+([A-Z][A-Z '\-]+)\s*\(([A-Z]+)\)\s+([牡牝])\s*(\d+)\s+([\d.]+)kg\s+(.+?[（(]([仏英愛日独])[）)])\s+(.+?)\s+(\d+)\s*$/);
    if (!m) continue;
    out.push({no:+m[1],rating:+m[2],name:m[3].trim(),en:m[4].trim(),bred:m[5],sex:m[6],age:+m[7],weight:+m[8],trainer:m[9].trim(),country:({仏:'フランス',英:'イギリス',愛:'アイルランド',日:'日本',独:'ドイツ'})[m[10]],jockey:m[11].trim(),draw:+m[12]});
  }
  if(out.length!==16 || new Set(out.map(h=>h.no)).size!==16 || new Set(out.map(h=>h.draw)).size!==16)throw new Error('確定出馬表の16頭・馬番・ゲートを解析できません。旧ページを維持します。');
  return out;
}
const cls = (s, c) => clean(s.match(new RegExp(`<[^>]+class="${c}(?: [^"]*)?"[^>]*>([\\s\\S]*?)<\\/[^>]+>`))?.[1]);
export function parseForm(s) {
  const out = new Map();
  for (const m of s.matchAll(/<tr class="HorseList"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const h=m[1], cells=[...h.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)], no=number(clean(cells[1]?.[1]));
    if(!no)continue;
    const form=[];
    for(const c of h.matchAll(/<td class="Past[^>]*>([\s\S]*?)<\/td>/g)){
      const v=c[1], d=cls(v,'Data01'), date=d.match(/\d{4}\.\d{2}\.\d{2}/)?.[0]?.replaceAll('.','-');
      if(!date)continue;
      const race=cls(v,'Data02'), going=cls(v,'Data05'), n=cls(v,'Data03');
      form.push({date,course:d.replace(/\d{4}\.\d{2}\.\d{2}/,'').replace(/\s+\d+\s*$/,'').trim(),place:number(cls(v,'Num')),race,
        distance:number(going.match(/[芝ダ](\d+)/)?.[1]),going:going.match(/(不|重|稍|良)/)?.[1]||null,field:number(n.match(/(\d+)頭/)?.[1]),
        grade:race.match(/GIII|GII|GI|OP/)?.[0]||null,source:'netkeiba'});
    }
    out.set(no,{sire:cls(h,'Horse01'),dam:cls(h,'Horse03'),bms:cls(h,'Horse04').replace(/^\(|\)$/g,''),style:cls(h,'kyakusitu'),form});
  }
  return out;
}
export function parseHorse(s) {
  const out=new Map();
  for(const u of s.split(/<div class="horse_unit"[^>]*>/).slice(1)){
    const name=clean(u.match(/<h2>(.*?)<\/h2>/)?.[1]);
    const sire=clean(u.match(/class="line sire"[\s\S]*?<dd>(.*?)<\/dd>/)?.[1]);
    const form=(tables(u)[0]||[]).slice(1).map(r=>({date:r[0]?.replace(/年|月/g,'-').replace('日','').split('-').map((x,i)=>i?x.padStart(2,'0'):x).join('-'),course:r[1],distance:number(r[2]?.replaceAll(',','')),race:r[3],place:number(r[4]),source:'JRA'}));
    out.set(name,{sire,form});
  }
  return out;
}
export function parseOdds(s) {
  const t=clean(s), excerpt=t.match(/Paddy Power:\s*([\s\S]*?)Arc de Triomphe draw in full/)?.[1];
  const out=new Map(); let odds=null;
  for(let part of (excerpt||'').split(',')){
    part=part.trim().replace(/\.$/,'');const m=part.match(/^(\d+)(?:\/(\d+))?\s+(.+)/);
    if(m){odds=1+(+m[1])/(+(m[2]||1));part=m[3];}
    if(odds)out.set(norm(part),odds);
  }
  return out;
}
export function parsePast(s) {
  const table=tables(s).find(t=>t[0].some(c=>c.includes('生産者')));
  if(!table)throw new Error('歴代結果の表が見つかりません');
  return table.slice(1).filter(r=>r.length===12 && /\d{4}年/.test(r[0]) && /性齢/.test(r[2])).map(r=>{
    const year=number(r[0]); return {year,name:r[1].split(' ')[0],en:r[1].replace(/（[^）]*）/g,'').match(/[A-Z][A-Z '\-]+/)?.[0]?.trim(),age:number(r[2]),sex:r[2].includes('牝')?'牝':'牡',country:r[4].match(/（([^）]+)）/)?.[1]||'不明',time:r[6],draw:number(r[9].match(/ゲート\s*(\d+)/)?.[1]),field:number(r[9].match(/頭数\s*(\d+)/)?.[1]),going:r[11].match(/馬場状態\s*(\S+)/)?.[1]||null,pen:number(r[11].match(/硬度\s*([\d.]+)/)?.[1]),venue:[2016,2017].includes(year)?'シャンティイ':year===1943||year===1944?'ル・トランブレー':'ロンシャン'};
  });
}
function wikiText(s){return clean(s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g,'$2').replace(/\[\[([^\]]+)\]\]/g,'$1').replace(/'{2,}/g,''));}
export function parseWiki(s,year) {
  const result=[...s.matchAll(/\{\|[\s\S]*?\|\}/g)].map(m=>m[0]).find(t=>/Pos\./.test(t)&&/Horse/.test(t)&&/Age/.test(t));if(!result)return {year,runners:[]};
  const headers=[...result.matchAll(/^!([^\n]*)/gm)].map(m=>wikiText(m[1].split('|').at(-1)));
  const at=q=>headers.findIndex(v=>q.test(v));const hi=at(/Horse/),ai=at(/Age/),di=at(/Draw/),ti=at(/Trainer/),pi=at(/Pos/);
  const runners=[];
  for(const block of result.split(/\n\|-.*\n/).slice(1)){
    const cells=block.split('\n').filter(l=>/^\|(?![-}])/.test(l)).map(l=>wikiText(l.slice(1)));
    if(cells.length!==headers.length||hi<0||!cells[hi])continue;
    const place=/^\d+$/.test(cells[pi])?+cells[pi]:null;
    runners.push({name:cells[hi],place,age:number(cells[ai]),draw:di>=0?number(cells[di]):null,country:cells[ti]?.match(/\(([^)]+)\)/)?.[1]||'不明'});
  }
  const dt=s.match(/\|date\s*=\s*\{\{start date\|(\d{4})\|(\d+)\|(\d+)/i);
  const date=dt?`${dt[1]}-${dt[2].padStart(2,'0')}-${dt[3].padStart(2,'0')}`:null;
  const english=s.match(/\|date\s*=\s*(\d{1,2})\s+October\s+(\d{4})/i);
  return {year,date:date||(english?`${english[2]}-10-${english[1].padStart(2,'0')}`:null),runners};
}
export function csv(s){
  const rows=s.trim().split(/\r?\n/).map(l=>{const a=[];let v='',q=false;for(let i=0;i<l.length;i++){if(l[i]==='"'){if(q&&l[i+1]==='"'){v+='"';i++;}else q=!q;}else if(l[i]===','&&!q){a.push(v);v='';}else v+=l[i];}a.push(v);return a;});
  return rows.slice(1).map(r=>Object.fromEntries(rows[0].map((k,i)=>[k,r[i]||''])));
}
export const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const sum=a=>a.reduce((s,x)=>s+x,0);
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
export function groupRows(rows,key){
  const m=new Map();for(const r of rows){const k=key(r);if(k==null)continue;const v=m.get(k)||{name:k,n:0,wins:0,top3:0};v.n++;v.wins+=r.place===1;v.top3+=r.place!=null&&r.place<=3;m.set(k,v);}return [...m.values()].sort((a,b)=>b.wins-a.wins||b.n-a.n);
}
export function predict(horses, scenario) {
  const hasMarket=horses.every(h=>Number.isFinite(h.odds)&&h.odds>1), baseline=1/horses.length;
  const book=hasMarket?sum(horses.map(h=>1/h.odds)):null;
  const scored=horses.map(h=>{
    const f=h.form.filter(r=>r.place&&r.field>1), wet=f.filter(r=>['稍','重','不'].includes(r.going)),dry=f.filter(r=>r.going==='良');
    const perf=r=>1-(r.place-1)/(r.field-1);
    const subset=scenario==='dry'?dry:wet;
    // データの少ない条件は全体へ縮小。国内外の「重」は同じ物差しではない。
    const overall=(sum(f.map(perf))+2)/ (f.length+4);
    const fit=(sum(subset.map(perf))+4*overall)/(subset.length+4);
    const form=(overall-.5)*.30;
    const going=(fit-overall)*(scenario==='heavy'?.9:.6);
    const rating=.08*(h.rating-120+(59.5-h.weight)*2.20462);
    const market=hasMarket?Math.log((1/h.odds/book)/baseline):0;
    const score=hasMarket?.6*market+.4*rating+form+going:rating+form+going;
    return {...h,score,factors:{market,rating,form,going},wetN:wet.length,dryN:dry.length,wetTop3:wet.filter(r=>r.place<=3).length};
  }).sort((a,b)=>b.score-a.score);
  const max=Math.max(...scored.map(h=>h.score)), total=sum(scored.map(h=>Math.exp(h.score-max)));
  return scored.map((h,i)=>({...h,mark:['◎','○','▲','△','△','☆'][i]||'—',share:Math.exp(h.score-max)/total}));
}
function regression(rows) {
  const mx=mean(rows.map(r=>r.x)),my=mean(rows.map(r=>r.y));
  const xx=sum(rows.map(r=>(r.x-mx)**2)),xy=sum(rows.map(r=>(r.x-mx)*(r.y-my))),yy=sum(rows.map(r=>(r.y-my)**2));
  return {slope:xx?xy/xx:0,intercept:my-(xx?xy/xx:0)*mx,correlation:xx&&yy?xy/Math.sqrt(xx*yy):0};
}
export function weatherAnalysis(meteo,era,past,years) {
  const daily=meteo.daily,old=era.daily;
  const window=(d,date)=>{const i=d.time.indexOf(date);if(i<7)return null;const p=d.precipitation_sum.slice(i-7,i),e=d.et0_fao_evapotranspiration.slice(i-7,i);if([...p,...e].some(x=>!Number.isFinite(x)))return null;return {rain:sum(p),et:sum(e),balance:sum(p)-sum(e)};};
  const current=window(daily,DAY);const rows=[];
  for(const p of past.filter(p=>p.year>=1995&&p.pen&&p.venue==='ロンシャン')){
    const date=years.find(y=>y.year===p.year)?.date;if(!date)continue;const w=window(old,date);if(w)rows.push({year:p.year,x:w.balance,y:p.pen,rain:w.rain,date});
  }
  rows.sort((a,b)=>a.year-b.year);
  const checks=[];for(let i=12;i<rows.length;i++){const fit=regression(rows.slice(0,i)),r=rows[i];checks.push({year:r.year,actual:r.y,pred:fit.intercept+fit.slope*r.x,baseline:mean(rows.slice(0,i).map(x=>x.y))});}
  const fit=rows.length>=12?regression(rows):null;
  const errors=checks.map(r=>Math.abs(r.pred-r.actual)).sort((a,b)=>a-b);
  const radius=errors[Math.min(errors.length-1,Math.ceil(errors.length*.9)-1)];
  const estimate=fit&&current?fit.intercept+fit.slope*current.balance:null;
  const mae=mean(errors),baselineMAE=mean(checks.map(r=>Math.abs(r.baseline-r.actual)));
  const hour=meteo.hourly,hi=hour.time.indexOf(DAY+'T16:00'),di=daily.time.indexOf(DAY);
  const at=(obj,key,i)=>Number.isFinite(obj[key]?.[i])?obj[key][i]:null;
  return {days:daily.time.map((date,i)=>({date,rain:at(daily,'precipitation_sum',i),et:at(daily,'et0_fao_evapotranspiration',i),min:at(daily,'temperature_2m_min',i),max:at(daily,'temperature_2m_max',i),prob:at(daily,'precipitation_probability_max',i),wind:at(daily,'wind_speed_10m_max',i)})),current,fit,rows,checks,mae,baselineMAE,
    estimate,range:estimate!=null&&Number.isFinite(radius)?[estimate-radius,estimate+radius]:null,
    useful:mae!=null&&baselineMAE!=null&&mae<baselineMAE,soil:[at(hour,'soil_moisture_0_to_1cm',hi),at(hour,'soil_moisture_1_to_3cm',hi),at(hour,'soil_moisture_3_to_9cm',hi)],rainRaceDay:at(daily,'precipitation_sum',di),
    rainBeforeStart:sum(hour.time.map((t,i)=>t.startsWith(DAY)&&t<DAY+'T16:00'?at(hour,'precipitation',i):0).filter(Number.isFinite)),hour:DAY+'T16:00',timezone:meteo.timezone};
}
