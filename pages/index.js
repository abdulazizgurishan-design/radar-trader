// v2
import { useState, useEffect, useCallback } from "react";
const B = "https://paper-api.alpaca.markets";
const H = () => ({ "APCA-API-KEY-ID": process.env.NEXT_PUBLIC_ALPACA_KEY, "APCA-API-SECRET-KEY": process.env.NEXT_PUBLIC_ALPACA_SECRET });
const get = (u) => fetch(u, { headers: H() }).then(r => r.json());
const fmt = (n) => parseFloat(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const pct = (n) => { const v=parseFloat(n||0); return (v>=0?"+":"")+v.toFixed(2)+"%"; };
export default function App() {
  const [acc,setAcc]=useState(null);
  const [pos,setPos]=useState([]);
  const [ord,setOrd]=useState([]);
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState(null);
  const [ts,setTs]=useState(null);
  const load = useCallback(async()=>{
    try {
      const [a,p,o] = await Promise.all([get(`${B}/v2/account`),get(`${B}/v2/positions`),get(`${B}/v2/orders?status=closed&limit=10`)]);
      setAcc(a); setPos(Array.isArray(p)?p:[]); setOrd(Array.isArray(o)?o:[]); setTs(new Date());
    } catch(e){console.error(e);}
  },[]);
  useEffect(()=>{ load(); const t=setInterval(load,30000); return ()=>clearInterval(t); },[load]);
  const trade = async()=>{
    setBusy(true); setMsg(null);
    try {
      const r=await fetch("/api/trade",{method:"POST"});
      const d=await r.json();
      setMsg(d.tradesPlaced>0?`نفذت ${d.tradesPlaced} صفقة`:(d.message||"لا توجد فرص"));
      load();
    } catch { setMsg("خطأ في الاتصال"); } finally { setBusy(false); }
  };
  const eq=parseFloat(acc?.equity||0);
  const ca=parseFloat(acc?.cash||0);
  const pl=eq-parseFloat(acc?.last_equity||0);
  return (
    <div style={{minHeight:"100vh",background:"#080c18",color:"#fff",fontFamily:"system-ui",direction:"rtl",padding:"20px 16px 40px"}}>
      <div style={{textAlign:"center",marginBottom:24}}>
        <div style={{fontSize:32}}>🤖</div>
        <h1 style={{margin:"4px 0",fontSize:22,fontWeight:900,letterSpacing:2}}>RADAR <span style={{color:"#818cf8"}}>TRADER</span></h1>
        <div style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>{ts?`آخر تحديث: ${ts.toLocaleTimeString("ar")}`:"جاري التحميل..."}</div>
      </div>
      {acc && <div style={{display:"flex",gap:10,marginBottom:20}}>
        {[{l:"إجمالي الرصيد",v:`$${fmt(eq)}`,c:"#00d4aa"},{l:"كاش متاح",v:`$${fmt(ca)}`,c:"#818cf8"},{l:"ربح/خسارة اليوم",v:`${pl>=0?"+":""}$${fmt(pl)}`,s:pct((pl/parseFloat(acc.last_equity||1))*100),c:pl>=0?"#00d4aa":"#ff4757"}].map(x=>(
          <div key={x.l} style={{flex:1,background:`rgba(${x.c=="#00d4aa"?"0,212,170":x.c=="#818cf8"?"129,140,248":"255,71,87"},0.08)`,border:`1px solid ${x.c}33`,borderRadius:14,padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontSize:15,fontWeight:800,color:x.c,fontFamily:"monospace"}}>{x.v}</div>
            {x.s&&<div style={{fontSize:11,color:x.c}}>{x.s}</div>}
            <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",marginTop:3}}>{x.l}</div>
          </div>
        ))}
      </div>}
      <button onClick={trade} disabled={busy} style={{width:"100%",background:busy?"rgba(255,255,255,0.05)":"linear-gradient(135deg,#6366f1,#8b5cf6)",border:"none",borderRadius:14,padding:14,color:busy?"rgba(255,255,255,0.3)":"#fff",fontWeight:800,fontSize:15,cursor:busy?"not-allowed":"pointer",marginBottom:10,boxShadow:busy?"none":"0 8px 32px rgba(99,102,241,0.4)"}}>
        {busy?"⟳ جاري التداول...":"🚀 تداول الآن"}
      </button>
      {msg&&<div style={{textAlign:"center",fontSize:13,color:"#fbbf24",marginBottom:16}}>{msg}</div>}
      <div style={{marginBottom:24}}>
        <div style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,0.5)",marginBottom:10}}>📊 صفقات مفتوحة ({pos.length})</div>
        {pos.length===0?<div style={{textAlign:"center",color:"rgba(255,255,255,0.2)",fontSize:12,padding:20,background:"rgba(255,255,255,0.02)",borderRadius:12}}>لا توجد صفقات مفتوحة</div>
        :pos.map(p=>{const up=parseFloat(p.unrealized_pl||0)>=0;return(
          <div key={p.symbol} style={{background:"rgba(15,20,35,0.95)",border:`1px solid ${up?"rgba(0,212,170,0.2)":"rgba(255,71,87,0.2)"}`,borderRadius:14,padding:"14px 16px",marginBottom:10,borderRight:`3px solid ${up?"#00d4aa":"#ff4757"}`}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
              <div style={{fontFamily:"monospace",fontSize:17,fontWeight:800}}>{p.symbol}</div>
              <div style={{textAlign:"left"}}>
                <div style={{fontSize:15,fontWeight:700,color:up?"#00d4aa":"#ff4757",fontFamily:"monospace"}}>{up?"+":""}${fmt(p.unrealized_pl)}</div>
                <div style={{fontSize:11,color:up?"#00d4aa":"#ff4757"}}>{pct(parseFloat(p.unrealized_plpc||0)*100)}</div>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              {[{l:"الكمية",v:p.qty},{l:"الدخول",v:`$${fmt(p.avg_entry_price)}`},{l:"الحالي",v:`$${fmt(p.current_price)}`},{l:"القيمة",v:`$${fmt(p.market_value)}`}].map(m=>(
                <div key={m.l} style={{flex:1,background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"6px 8px",textAlign:"center"}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#f1f5f9",fontFamily:"monospace"}}>{m.v}</div>
                  <div style={{fontSize:8,color:"rgba(255,255,255,0.3)",marginTop:2}}>{m.l}</div>
                </div>
              ))}
            </div>
          </div>
        );})}
      </div>
      <div>
        <div style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,0.5)",marginBottom:10}}>✅ آخر الصفقات المغلقة</div>
        {ord.length===0?<div style={{textAlign:"center",color:"rgba(255,255,255,0.2)",fontSize:12,padding:20,background:"rgba(255,255,255,0.02)",borderRadius:12}}>لا توجد صفقات مغلقة</div>
        :ord.map(o=>(
          <div key={o.id} style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:12,padding:"10px 14px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontFamily:"monospace",fontWeight:700,fontSize:14}}>{o.symbol}</div>
              <div style={{fontSize:10,color:"rgba(255,255,255,0.3)",marginTop:2}}>{o.side==="buy"?"🟢 شراء":"🔴 بيع"} · {o.qty} سهم · ${fmt(o.filled_avg_price)}</div>
            </div>
            <div style={{fontSize:10,fontWeight:700,color:o.status==="filled"?"#00d4aa":"rgba(255,255,255,0.3)",background:o.status==="filled"?"rgba(0,212,170,0.1)":"rgba(255,255,255,0.05)",padding:"3px 8px",borderRadius:20}}>
              {o.status==="filled"?"✅ منفذ":o.status}
            </div>
          </div>
        ))}
      </div>
      <p style={{textAlign:"center",fontSize:10,color:"rgba(255,255,255,0.1)",marginTop:24}}>Paper Trading · لا فلوس حقيقية · يتحدث كل 30 ثانية</p>
    </div>
  );
}
