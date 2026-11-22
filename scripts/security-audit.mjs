#!/usr/bin/env node
// Safe signed-out audit. Does not fetch /api/odds or create Stripe checkouts.
// Usage: node scripts/security-audit.mjs https://propiq-app.up.railway.app
const base = (process.argv[2] || process.env.PROPIQ_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
if (!/^https?:\/\/[^/]+$/.test(base)) { console.error('Supply a valid site origin.'); process.exit(2); }
const fakeHeaders = {
  'x-user-tier': 'elite', 'x-membership-tier': 'elite', 'x-user-id': '00000000-0000-0000-0000-000000000001'
};
const checks = [
  { name:'Elite Dashboard denies signed-out visitors', method:'GET', path:'/api/research/dashboard?sport=NBA&season=current', expect:403 },
  { name:'Elite Line History denies signed-out visitors', method:'GET', path:'/api/research/line-history?sport=NBA', expect:403 },
  { name:'Pro Odds Comparison denies signed-out visitors', method:'GET', path:'/api/odds/compare?sport=NBA', expect:403 },
  { name:'Pro trend summaries deny forged tier headers', method:'POST', path:'/api/history', body:{mode:'trend-summary',sport:'NBA',season:'all',trends:[{player:'Audit Test',marketKey:'player_points',line:20.5,side:'Over'}]},expect:403 },
  { name:'Pro matchup summaries deny forged tier headers', method:'POST', path:'/api/history', body:{mode:'matchup-summary',sport:'NBA',season:'all',trends:[{player:'Audit Test',marketKey:'player_points',line:20.5,side:'Over'}]},expect:403 },
  { name:'History rejects unsupported modes', method:'POST', path:'/api/history', body:{mode:'admin',sport:'NBA',players:['Audit Test']},expect:400 },
  { name:'History GET does not dump player logs', method:'GET', path:'/api/history?sport=NBA',expect:200,assertJson:j=>Array.isArray(j.rows)&&j.rows.length===0},
  { name:'Saved Props blocks cross-origin writes', method:'PUT',path:'/api/saved-props',body:{saved:[]},expect:403 },
  { name:'Billing blocks cross-origin checkout',method:'POST',path:'/api/billing',body:{plan:'pro'},expect:403 },
  { name:'Signed-out entitlement remains Free',method:'GET',path:'/api/entitlements',expect:200,assertJson:j=>j.tier==='free' && j.authenticated===false},
];
let failed=0;
for (const item of checks) {
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), 14000);
  try {
    const response = await fetch(base + item.path, {
      method:item.method, headers:{...fakeHeaders,...(item.body?{'Content-Type':'application/json'}:{})},
      body:item.body?JSON.stringify(item.body):undefined,
      redirect:'manual',cache:'no-store', signal:controller.signal
    });
    const content = await response.text();
    let json;try{ json=JSON.parse(content); }catch{}
    const cacheHeader=(response.headers.get('cache-control')||'').toLowerCase();
    const cacheOk=cacheHeader.includes('no-store');
    const ok=response.status===item.expect && cacheOk && (!item.assertJson || item.assertJson(json||{}));
    console.log(`${ok?'PASS':'FAIL'} ${item.name} [HTTP ${response.status}, no-store=${cacheOk}]`);
    if (!ok) failed++;
  } catch (error) { console.log(`FAIL ${item.name} [${error.message}]`); failed++; }
  finally {clearTimeout(timeout);}
}
console.log(`\n${checks.length-failed}/${checks.length} checks passed. No odds provider or checkout endpoints were called.`);
console.log('Note: This does NOT verify paid account access, Supabase RLS, or Stripe webhook cancellation.');
process.exitCode=failed?1:0;
