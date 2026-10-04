// node tools/arc_build.mjs — キャッシュだけで再構築。ネット接続はしない。
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DAY,RACE_TIME,SOURCES,clean,norm,decode,number,tables,parseCard,parseForm,parseHorse,parseOdds,parsePast,parseWiki,csv,groupRows,predict,weatherAnalysis} from './lib/arc.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CACHE=path.join(ROOT,'data/cache/arc'), OUT=path.join(ROOT,'data/arc');
const raw=n=>fs.readFileSync(path.join(CACHE,n));
const html=n=>decode(raw(n+'.html'));
const json=n=>JSON.parse(raw(n+'.json'));
const warnings=[];
const horses=parseCard(execFileSync('pdftotext',['-layout',path.join(CACHE,'card.pdf'),'-'],{encoding:'utf8'}));
const primary=parseHorse(html('horse')), forms=parseForm(html('form')),extended=parseForm(html('netkeiba')),odds=parseOdds(html('overseas'));
for(const h of horses){
  const f=forms.get(h.no),extra=extended.get(h.no),p=primary.get(h.name);
  if(!f)throw new Error(`${h.name}の血統・近走情報がありません`);
  Object.assign(h,f);
  const merged=new Map([...f.form,...(extra?.form||[])].map(r=>[r.date,r]));
  for(const r of p?.form||[]){if(!merged.has(r.date))merged.set(r.date,r);else {const a=merged.get(r.date);if(a.place!==r.place)warnings.push(`${h.name} ${r.date}の着順に出典差（JRAを採用）`);merged.set(r.date,{...a,...r,going:a.going,field:a.field});}}
  h.form=[...merged.values()].filter(r=>r.date<DAY).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,9);
  h.sire=h.sire||p?.sire||null;h.odds=odds.get(norm(h.en))||null;
  h.daysSince=h.form[0]?Math.round((Date.parse(DAY)-Date.parse(h.form[0].date))/86400000):null;
}
const past=parsePast(html('past'));
if(past.length<100)throw new Error(`歴代結果の読み取り不足 ${past.length}年`);
const years=[];
for(const name of fs.readdirSync(CACHE).filter(n=>/^wp\d{4}\.txt$/.test(n)).sort()){
  const year=+name.slice(2,6),r=parseWiki(raw(name).toString(),year),p=past.find(p=>p.year===year);
  if(!r.date){const s=raw(name).toString(),m=s.match(new RegExp(`(?:Sunday )?(\\d{1,2}) October ${year}`));if(m)r.date=`${year}-10-${m[1].padStart(2,'0')}`;}
  if(!r.runners.length||r.runners.length!==p?.field){warnings.push(`${year}年の全着順は頭数照合できないため傾向集計から除外（${r.runners.length}/${p?.field}）`);continue;}
  // 1着の出典整合も確認。失格（2006年など）は勝利に数えない。
  const winner=r.runners.find(x=>x.place===1);
  if(!winner||norm(winner.name)!==norm(p.en)){warnings.push(`${year}年の勝ち馬が一致しないため全着順集計から除外`);continue;}
  years.push({...r,going:p.going,pen:p.pen,venue:p.venue});
}
const runners=years.filter(y=>y.venue==='ロンシャン').flatMap(y=>y.runners.map(r=>({...r,year:y.year,pen:y.pen,field:y.runners.length})));
const training={FR:'フランス',GB:'イギリス',IRE:'アイルランド',GER:'ドイツ',JPN:'日本',JP:'日本',ITY:'イタリア',ITA:'イタリア',USA:'アメリカ',SWI:'スイス',CZE:'チェコ',UAE:'UAE',ARG:'アルゼンチン',NOR:'ノルウェー',BRZ:'ブラジル'};
const countries=groupRows(runners,r=>training[r.country]||r.country);
const allWins=groupRows(past.map(p=>({...p,place:1})),r=>r.country==='西ドイツ'?'ドイツ':r.country);
const ages=groupRows(runners,r=>r.age===3?'3歳':r.age===4?'4歳':'5歳以上');
const draws=groupRows(runners.filter(r=>r.draw),r=>r.draw<=r.field/3?'内1/3':r.draw>r.field*2/3?'外1/3':'中1/3');
const goingGroups=['軽め','中間','重め'].map(name=>{const rr=runners.filter(r=>r.pen!=null&&(name==='軽め'?r.pen<=3.2:name==='中間'?r.pen>3.2&&r.pen<3.8:r.pen>=3.8));return {name,years:new Set(rr.map(r=>r.year)).size,n:rr.length,countries:groupRows(rr,r=>training[r.country]||r.country),ages:groupRows(rr,r=>r.age===3?'3歳':'4歳以上')};});
const jpTable=tables(html('history'))[0];
const japan=jpTable.slice(1).map(r=>({year:number(r[0]),name:r[1],age:r[2],jockey:r[3],trainer:r[4],result:r[5],place:/失格/.test(r[5])?null:number(r[5])}));
const pedigrees=csv(raw('wd_winners.csv').toString());
for(const p of past){const row=pedigrees.find(r=>number(r.evLabel)===p.year&&norm(r.hLabel)===norm(p.en));if(row)Object.assign(p,{sire:row.sLabel||null,grandsire:row.ssLabel||null,bms:row.bmsLabel||null});}
for(const h of horses)h.sireWinners=past.filter(p=>p.sire&&norm(p.sire)===norm(h.sire)).map(p=>({year:p.year,name:p.name,going:p.going}));
const weather=weatherAnalysis(json('meteo'),json('era5'),past,years);
if(!horses.every(h=>h.odds))warnings.push('海外オッズに欠測あり。全頭をレーティング中心の比較に切り替えています。');
const sources=Object.entries(SOURCES).map(([key,url])=>{const ext=key==='card'?'pdf':['meteo','era5'].includes(key)?'json':key==='wd_winners'?'csv':'html';const file=path.join(CACHE,`${key}.${ext}`);return {key,url,fetchedAt:fs.existsSync(file)?fs.statSync(file).mtime.toISOString():null};});
const result={version:1,builtAt:new Date().toISOString(),race:{name:'2026 凱旋門賞',day:DAY,start:RACE_TIME,venue:'パリロンシャン',distance:2400},
  horses,predictions:Object.fromEntries(['dry','soft','heavy'].map(s=>[s,predict(horses,s)])),past,years:years.map(y=>({year:y.year,date:y.date,n:y.runners.length,venue:y.venue})),
  statistics:{countries,allWins,ages,draws,drawN:runners.filter(r=>r.draw).length,goingGroups,runnerN:runners.length,yearN:years.filter(y=>y.venue==='ロンシャン').length},japan,weather,sources,warnings};
fs.mkdirSync(OUT,{recursive:true});
// 中身（builtAt・取得時刻を除く）が前回と同じなら書かない。10分おきの反映で無駄なコミットを積まないため
const strip=o=>JSON.stringify({...o,builtAt:null,sources:(o.sources||[]).map(x=>({...x,fetchedAt:null}))});
try{if(strip(JSON.parse(fs.readFileSync(path.join(OUT,'analysis.json'),'utf8')))===strip(result)){console.log('arc: 変化なし');process.exit(0);}}catch{}
function atomic(file,s){fs.writeFileSync(file+'.tmp',s);fs.renameSync(file+'.tmp',file);}
atomic(path.join(OUT,'analysis.json'),JSON.stringify(result,null,2)+'\n');
const page=path.join(ROOT,'arc.html');
if(fs.existsSync(page)){
  const old=fs.readFileSync(page,'utf8');
  const data=JSON.stringify(result).replace(/</g,'\\u003c');
  if(!old.includes('/* ARC:BEGIN */'))throw new Error('埋め込みマーカーがありません');
  atomic(page,old.replace(/\/\* ARC:BEGIN \*\/[\s\S]*?\/\* ARC:END \*\//,()=>`/* ARC:BEGIN */\nconst ARC=${data};\n/* ARC:END */`));
}
console.log(`arc: ${horses.length}頭 / 歴代 ${past.length}回 / 全着順 ${years.length}年 ${runners.length}頭（ロンシャン） / 日本馬 ${japan.length}出走`);
console.log(`天候の時系列検証 ${weather.checks.length}年: MAE ${weather.mae?.toFixed(2)} / 平均だけ ${weather.baselineMAE?.toFixed(2)}`);
console.log('予想',result.predictions.soft.slice(0,6).map(h=>h.mark+h.name).join(' '));
warnings.forEach(w=>console.error(w));
