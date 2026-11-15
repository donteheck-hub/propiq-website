'use client';
import { useEffect, useState } from 'react';

type Info = {enabled?:boolean;authenticated?:boolean;plan?:string;status?:string;notice?:string};

export default function BillingTestActions({ plan }: {plan:'pro'|'elite'}) {
  const [info,setInfo] = useState<Info>({});
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/billing',{cache:'no-store',signal:controller.signal}).then(r=>r.json()).then((v:Info)=>setInfo(v)).catch(()=>{});
    return () => controller.abort();
  },[]);
  async function start() {
    setBusy(true); setMessage('');
    try {
      const res=await fetch('/api/billing',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({plan})});
      const data=await res.json() as {url?:string;error?:string};
      if (!res.ok || !data.url) throw new Error(data.error || 'Test checkout unavailable.');
      window.location.assign(data.url);
    } catch (e) {setMessage(e instanceof Error?e.message:'Unable to start test checkout.');setBusy(false);}
  }
  return <div className="billing-actions">
    <button type="button" disabled={!info.enabled || !info.authenticated || busy} onClick={()=>void start()} className="billing-test-btn">
      {busy?'Opening…': 'Test '+(plan==='pro'?'Pro':'Elite')+' checkout'}
    </button>
    <span className="billing-test-note">{!info.enabled?'Test checkout disabled until configured.':!info.authenticated?'Sign in with a verified email to test checkout.':'Stripe TEST MODE — no real charges.'}</span>
    {info.status && <span className="billing-test-note">Your test subscription: {info.plan} · {info.status}</span>}
    {message && <span className="billing-test-error" role="status">{message}</span>}
  </div>;
}
