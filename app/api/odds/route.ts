import {NextRequest,NextResponse} from 'next/server';
import {MARKETS,Prop,Sport} from '../../../lib/props';
export const dynamic='force-dynamic';
const sportKeys:Record<Sport,string>={NBA:'basketball_nba',NFL:'americanfootball_nfl'};
let cache:Record<string,{until:number;payload:unknown}>={};
export async function GET(req:NextRequest){
 const sport=req.nextUrl.searchParams.get('sport')==='NFL'?'NFL':'NBA';
 const key=process.env.ODDS_API_KEY;if(!key)return NextResponse.json({props:[],message:'Add ODDS_API_KEY in .env.local to fetch live player props.',configured:false});
 if(cache[sport]&&Date.now()<cache[sport].until)return NextResponse.json(cache[sport].payload);
 try{
  const base=`https://api.the-odds-api.com/v4/sports/${sportKeys[sport]}`;
  const eventsResponse=await fetch(`${base}/events?apiKey=${encodeURIComponent(key)}&dateFormat=iso`,{cache:'no-store'});
  if(!eventsResponse.ok)throw Error(`Events API returned ${eventsResponse.status}`);
  const events=await eventsResponse.json() as {id:string;home_team:string;away_team:string;commence_time:string}[];
  // Quota safety: only query next two events; additional event markets can consume many credits.
  const upcoming=events.filter(e=>new Date(e.commence_time).getTime()>Date.now()).sort((a,b)=>a.commence_time.localeCompare(b.commence_time)).slice(0,2);
  const markets=Object.keys(MARKETS[sport]).join(',');const props:Prop[]=[];let used=0;
  for(const event of upcoming){
   const r=await fetch(`${base}/events/${encodeURIComponent(event.id)}/odds?apiKey=${encodeURIComponent(key)}&regions=us&markets=${markets}&oddsFormat=american`,{cache:'no-store'});
   if(!r.ok){if(r.status===422)throw Error('Requested player markets unavailable on this API plan or for these events.');throw Error(`Player props API returned ${r.status}`)}
   used++;
   const d=await r.json() as {bookmakers?:{key:string;title:string;markets:{key:string;outcomes:{name:string;description?:string;point?:number;price:number}[]}[]}[]};
   for(const book of d.bookmakers??[])for(const m of book.markets??[]){if(!MARKETS[sport][m.key])continue;for(const outcome of m.outcomes??[]){if(!['Over','Under'].includes(outcome.name)||!outcome.description||typeof outcome.point!=='number')continue;
    props.push({id:[sport,event.id,book.key,m.key,outcome.description,outcome.name,outcome.point].join(':'),sport,player:outcome.description,market:MARKETS[sport][m.key],marketKey:m.key,line:outcome.point,side:outcome.name as 'Over'|'Under',odds:outcome.price,bookmaker:book.title,event:`${event.away_team} @ ${event.home_team}`,commence:event.commence_time,source:'live'});
   }}
  }
  const payload={props,configured:true,updatedAt:new Date().toISOString(),eventsChecked:upcoming.length,notice:`Checked ${upcoming.length} upcoming events; ${used} event prop requests. No props returned may mean books have not posted them.`};
  cache[sport]={payload,until:Date.now()+5*60*1000};return NextResponse.json(payload);
 }catch(e){return NextResponse.json({props:[],configured:true,message:e instanceof Error?e.message:'Unknown provider error'},{status:502})}
}
