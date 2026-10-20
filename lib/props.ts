export type Sport = 'NBA'|'NFL';
export type Prop = {id:string;sport:Sport;player:string;market:string;marketKey:string;line:number;side:'Over'|'Under';odds:number;bookmaker:string;event:string;commence:string;source:'live'|'manual'|'demo'};
export type LogRow = {sport:Sport;player:string;marketKey:string;date:string;value:number;opponent?:string};
export const MARKETS: Record<Sport,Record<string,string>> = {
  NBA:{player_points:'Points',player_rebounds:'Rebounds',player_assists:'Assists',player_threes:'3-Pointers',player_blocks:'Blocks',player_steals:'Steals',player_points_rebounds_assists:'Pts + Reb + Ast'},
  NFL:{player_pass_yds:'Passing Yards',player_rush_yds:'Rushing Yards',player_reception_yds:'Receiving Yards',player_receptions:'Receptions',player_pass_tds:'Passing TDs',player_rush_attempts:'Rushing Attempts',player_pass_completions:'Completions'}
};
export const normalize = (s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
export function analyze(prop:Prop,logs:LogRow[]){
 const games=logs.filter(x=>x.sport===prop.sport&&normalize(x.player)===normalize(prop.player)&&x.marketKey===prop.marketKey&&Number.isFinite(x.value)).sort((a,b)=>b.date.localeCompare(a.date));
 const hit=(n:number)=>{const batch=games.slice(0,n);if(!batch.length)return null;const hits=batch.filter(g=>prop.side==='Over'?g.value>prop.line:g.value<prop.line).length;const pushes=batch.filter(g=>g.value===prop.line).length;return {hits,total:batch.length,pushes,pct:Math.round(hits/batch.length*100)};};
 const recent=games.slice(0,10);const avg=recent.length?recent.reduce((s,r)=>s+r.value,0)/recent.length:null;
 // Deliberately not a prediction. Observed hit frequency is not a validated future probability.
 return {games,avg,hit5:hit(5),hit10:hit(10),hit20:hit(20),season:hit(1000)};
}
export function implied(odds:number){return odds<0?Math.abs(odds)/(Math.abs(odds)+100):100/(odds+100)}
export function parseCsv(content:string):LogRow[]{
 const lines=content.trim().split(/\r?\n/).filter(Boolean);if(lines.length<2)return [];
 const split=(s:string)=>{const out:string[]=[];let q=false,c='';for(let i=0;i<s.length;i++){if(s[i]==='"'){if(q&&s[i+1]==='"'){c+='"';i++;}else q=!q;}else if(s[i]===','&&!q){out.push(c.trim());c='';}else c+=s[i]}out.push(c.trim());return out};
 const headers=split(lines[0]).map(x=>x.toLowerCase());const required=['sport','player','marketkey','date','value'];if(required.some(k=>!headers.includes(k)))throw Error('CSV needs columns: sport,player,marketKey,date,value (optional: opponent)');
 return lines.slice(1).map(line=>{const cells=split(line),get=(k:string)=>cells[headers.indexOf(k)]??'';return {sport:get('sport').toUpperCase() as Sport,player:get('player'),marketKey:get('marketkey'),date:get('date'),value:Number(get('value')),opponent:get('opponent')}}).filter(r=>(r.sport==='NBA'||r.sport==='NFL')&&!!r.player&&!!r.date&&/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&Number.isFinite(r.value)&&!!MARKETS[r.sport][r.marketKey]);
}
export const DEMO_PROPS:Prop[]=[
 {id:'d1',sport:'NBA',player:'Demo Guard A',market:'Points',marketKey:'player_points',line:24.5,side:'Over',odds:-110,bookmaker:'Example Book',event:'Demo City vs Sample City',commence:'',source:'demo'},
 {id:'d2',sport:'NBA',player:'Demo Forward B',market:'Rebounds',marketKey:'player_rebounds',line:7.5,side:'Over',odds:-115,bookmaker:'Example Book',event:'Sample City vs Test City',commence:'',source:'demo'},
 {id:'d3',sport:'NFL',player:'Demo QB C',market:'Passing Yards',marketKey:'player_pass_yds',line:249.5,side:'Over',odds:-105,bookmaker:'Example Book',event:'Example FC vs Fictional FC',commence:'',source:'demo'},
 {id:'d4',sport:'NFL',player:'Demo Receiver D',market:'Receiving Yards',marketKey:'player_reception_yds',line:69.5,side:'Under',odds:-110,bookmaker:'Example Book',event:'Test FC vs Demo FC',commence:'',source:'demo'}
];
const demos:{sport:Sport;player:string;marketKey:string;values:number[]}[]=[
 {sport:'NBA',player:'Demo Guard A',marketKey:'player_points',values:[28,31,22,26,29,18,33,27,25,21,29,26,19,32,25,24,28,30,17,27]},
 {sport:'NBA',player:'Demo Forward B',marketKey:'player_rebounds',values:[9,10,6,11,8,9,7,13,9,5,8,10,6,9,12,11,5,8,7,10]},
 {sport:'NFL',player:'Demo QB C',marketKey:'player_pass_yds',values:[310,260,215,295,278,242,310,270,240,300,220,285]},
 {sport:'NFL',player:'Demo Receiver D',marketKey:'player_reception_yds',values:[53,48,90,62,51,78,68,45,49,83,60,66]}
];
export const DEMO_LOGS:LogRow[]=demos.flatMap(p=>p.values.map((value,i)=>({sport:p.sport,player:p.player,marketKey:p.marketKey,value,date:new Date(Date.UTC(2026,8,30)-i*7*86400000).toISOString().slice(0,10)})));
