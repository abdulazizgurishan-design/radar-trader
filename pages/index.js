// v7 - with Performance tab (date filter + win/loss + profit totals)
import { useState, useEffect, useCallback, useMemo } from "react";

const fmt = (n) => parseFloat(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const pct = (n) => { const v=parseFloat(n||0); return (v>=0?"+":"")+v.toFixed(2)+"%"; };
const POLYGON_KEY = process.env.NEXT_PUBLIC_POLYGON_KEY || "";

const saveEquity = (equity) => {
  try {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const history = JSON.parse(localStorage.getItem("equityHistory")||"{}");
    history[today] = parseFloat(equity||0);
    const keys = Object.keys(history).sort();
    if(keys.length > 30) delete history[keys[0]];
    localStorage.setItem("equityHistory", JSON.stringify(history));
  } catch(e){}
};

const getEquityHistory = () => {
  try { return JSON.parse(localStorage.getItem("equityHistory")||"{}"); } catch(e){ return {}; }
};

// رسم بياني للرصيد اليومي
const EquityChart = ({ data }) => {
  const entries = Object.entries(data).sort(([a],[b])=>a.localeCompare(b));
  if(entries.length < 2) return (
    <div style={{textAlign:"center",color:"rgba(255,255,255,0.2)",fontSize:11,padding:"20px 0"}}>
      سيظهر الرسم البياني بعد يومين من التداول 📈
    </div>
  );
  const values = entries.map(([,v])=>v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 300, H = 80, pad = 10;
  const pts = entries.map(([,v],i) => {
    const x = pad + (i/(entries.length-1))*(W-pad*2);
    const y = H - pad - ((v-min)/range)*(H-pad*2);
    return `${x},${y}`;
  });
  const isUp = values[values.length-1] >= values[0];
  const color = isUp ? "#00d4aa" : "#ff4757";
  const polyline = pts.join(" ");
  const lastPt = pts[pts.length-1].split(",");
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:"block"}}>
        <defs>
          <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3"/>
            <stop offset="100%" stopColor={color} stopOpacity="0"/>
          </linearGradient>
        </defs>
        {[0,0.5,1].map(r=>(
          <line key={r} x1={pad} y1={pad+(1-r)*(H-pad*2)} x2={W-pad} y2={pad+(1-r)*(H-pad*2)}
            stroke="rgba(255,255,255,0.05)" strokeWidth="1"/>
        ))}
        <polygon points={`${pts[0].split(",")[0]},${H-pad} ${polyline} ${lastPt[0]},${H-pad}`} fill="url(#eqGrad)"/>
        <polyline points={polyline} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
        <circle cx={lastPt[0]} cy={lastPt[1]} r="4" fill={color}/>
      </svg>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"rgba(255,255,255,0.3)",marginTop:4,padding:`0 ${pad}px`}}>
        <span>{entries[0][0].slice(5)} ◀ أقدم</span>
        <span style={{color,fontWeight:700}}>${fmt(values[values.length-1])}</span>
        <span>أحدث ▶ {entries[entries.length-1][0].slice(5)}</span>
      </div>
    </div>
  );
};

// شارت السهم اللحظي
const StockChart = ({ symbol, entryPrice }) => {
  const [bars, setBars] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchBars = async () => {
      try {
        const today = new Date().toLocaleDateString("en-CA");
        const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/5/minute/${today}/${today}?adjusted=true&sort=asc&limit=100&apiKey=${POLYGON_KEY}`;
        const r = await fetch(url);
        const d = await r.json();
        if(d.results && d.results.length > 0) setBars(d.results);
      } catch(e) {}
      finally { setLoading(false); }
    };
    fetchBars();
  }, [symbol]);

  if(loading) return <div style={{textAlign:"center",fontSize:10,color:"rgba(255,255,255,0.3)",padding:"10px 0"}}>⟳ جاري تحميل الشارت...</div>;
  if(bars.length < 2) return <div style={{textAlign:"center",fontSize:10,color:"rgba(255,255,255,0.2)",padding:"10px 0"}}>لا توجد بيانات كافية</div>;

  const closes = bars.map(b=>b.c);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const W = 280, H = 70, pad = 8;

  const pts = closes.map((c,i) => {
    const x = pad + (i/(closes.length-1))*(W-pad*2);
    const y = H - pad - ((c-min)/range)*(H-pad*2);
    return `${x},${y}`;
  });

  const lastClose = closes[closes.length-1];
  const firstClose = closes[0];
  const isUp = lastClose >= firstClose;
  const color = isUp ? "#00d4aa" : "#ff4757";
  const polyline = pts.join(" ");
  const lastPt = pts[pts.length-1].split(",");

  const entryY = entryPrice ? H - pad - ((entryPrice-min)/range)*(H-pad*2) : null;

  return (
    <div style={{marginTop:10,padding:"10px",background:"rgba(0,0,0,0.3)",borderRadius:10}}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:"block"}}>
        <defs>
          <linearGradient id={`grad_${symbol}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25"/>
            <stop offset="100%" stopColor={color} stopOpacity="0"/>
          </linearGradient>
        </defs>
        {[0,0.5,1].map(r=>(
          <line key={r} x1={pad} y1={pad+(1-r)*(H-pad*2)} x2={W-pad} y2={pad+(1-r)*(H-pad*2)}
            stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>
        ))}
        {entryY && entryY >= pad && entryY <= H-pad && (
          <line x1={pad} y1={entryY} x2={W-pad} y2={entryY}
            stroke="#fbbf24" strokeWidth="1" strokeDasharray="4,3"/>
        )}
        <polygon points={`${pts[0].split(",")[0]},${H-pad} ${polyline} ${lastPt[0]},${H-pad}`} fill={`url(#grad_${symbol})`}/>
        <polyline points={polyline} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
        <circle cx={lastPt[0]} cy={lastPt[1]} r="3" fill={color}/>
      </svg>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"rgba(255,255,255,0.3)",marginTop:4}}>
        <span style={{color:"#fbbf24"}}>— دخول ${fmt(entryPrice)}</span>
        <span style={{color,fontWeight:700}}>${fmt(lastClose)}</span>
        <span>{bars.length} شمعة · 5د</span>
      </div>
    </div>
  );
};

const calcPnL = (order, allOrders) => {
  if(order.side !== "sell" || order.status !== "filled") return null;
  const buyOrder = allOrders.find(o =>
    o.symbol === order.symbol && o.side === "buy" && o.status === "filled" &&
    new Date(o.filled_at) < new Date(order.filled_at)
  );
  if(!buyOrder) return null;
  const buyPrice  = parseFloat(buyOrder.filled_avg_price || 0);
  const sellPrice = parseFloat(order.filled_avg_price || 0);
  const qty       = parseFloat(order.qty || 0);
  const pl        = (sellPrice - buyPrice) * qty;
  const plPct     = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
  return { pl, plPct, buyPrice, sellPrice, qty };
};

export default function App() {
  const [acc,setAcc]=useState(null);
  const [pos,setPos]=useState([]);
  const [ord,setOrd]=useState([]);
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState(null);
  const [ts,setTs]=useState(null);
  const [tab,setTab]=useState("dashboard");
  const [equityHist,setEquityHist]=useState({});
  const [expandedPos,setExpandedPos]=useState(null);
  const [closingPos,setClosingPos]=useState(null);
  const [perfRange,setPerfRange]=useState("all"); // فلتر تاريخ الأداء

  const closeOne = async(symbol)=>{
    setClosingPos(symbol);
    try {
      const r=await fetch("/api/closeone",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbol})});
      const d=await r.json();
      setMsg(d.success?`تم إغلاق ${symbol} ✅`:`خطأ في إغلاق ${symbol}`);
      load();
    } catch { setMsg("خطأ في الاتصال"); }
    finally { setClosingPos(null); }
  };

  const load = useCallback(async()=>{
    try {
      const r = await fetch("/api/account");
      const d = await r.json();
      if(d.account) {
        setAcc(d.account);
        setPos(Array.isArray(d.positions)?d.positions:[]);
        setOrd(Array.isArray(d.orders)?d.orders:[]);
        setTs(new Date());
        if(d.account.equity) { saveEquity(d.account.equity); setEquityHist(getEquityHistory()); }
      }
    } catch(e){console.error(e);}
  },[]);

  useEffect(()=>{ load(); const t=setInterval(load,30000); return ()=>clearInterval(t); },[load]);

  const trade = async()=>{
    setBusy(true); setMsg(null);
    try {
      const r=await fetch("/api/trade",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({force:true})});
      const d=await r.json();
      setMsg(d.tradesPlaced>0?`نفذت ${d.tradesPlaced} صفقة`:(d.message||"لا توجد فرص"));
      load();
    } catch { setMsg("خطأ في الاتصال"); } finally { setBusy(false); }
  };

  const closeAll = async()=>{
    setBusy(true); setMsg(null);
    try {
      const r=await fetch("/api/close",{method:"POST"});
      const d=await r.json();
      setMsg(d.message||"تم الإغلاق");
      load();
    } catch { setMsg("خطأ في الإغلاق"); } finally { setBusy(false); }
  };

  const eq=parseFloat(acc?.equity||0);
  const ca=parseFloat(acc?.cash||0);
  const pl=eq-parseFloat(acc?.last_equity||0);

  const marketStatus = () => {
    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const h = et.getHours(), m = et.getMinutes(), day = et.getDay();
    if(day === 0 || day === 6) return { open: false, label: "السوق مغلق — عطلة نهاية الأسبوع 🔴" };
    const mins = h * 60 + m;
    if(mins >= 570 && mins < 960) return { open: true, label: "السوق مفتوح 🟢" };
    if(mins >= 480 && mins < 570) return { open: false, label: "ما قبل السوق ⏳" };
    return { open: false, label: "السوق مغلق 🔴" };
  };
  const market = marketStatus();

  const today = new Date().toLocaleDateString("en-CA");
  const todayOrders = ord.filter(o => o.filled_at && new Date(o.filled_at).toLocaleDateString("en-CA")===today);
  const sellOrders = todayOrders.filter(o => o.side==="sell" && o.status==="filled");
  const todayPnLList = sellOrders.map(o => calcPnL(o, ord)).filter(Boolean);
  const todayTotalPL = todayPnLList.reduce((sum,x)=>sum+x.pl, 0);
  const todayTotalPct = eq > 0 ? (todayTotalPL / (eq - todayTotalPL)) * 100 : 0;

  // ═══ حساب الأداء حسب فلتر التاريخ ═══
  const perf = useMemo(() => {
    const now = Date.now();
    const ranges = {
      today: 1 * 86400000,
      week:  7 * 86400000,
      month: 30 * 86400000,
      all:   Infinity,
    };
    const cutoff = ranges[perfRange] === Infinity ? 0 : now - ranges[perfRange];

    // كل صفقات البيع المنفّذة ضمن الفترة
    const closed = ord
      .filter(o => o.side === "sell" && o.status === "filled" && o.filled_at)
      .filter(o => new Date(o.filled_at).getTime() >= cutoff)
      .map(o => ({ order: o, pnl: calcPnL(o, ord) }))
      .filter(x => x.pnl);

    const wins   = closed.filter(x => x.pnl.pl >= 0);
    const losses = closed.filter(x => x.pnl.pl < 0);
    const totalPL    = closed.reduce((s,x) => s + x.pnl.pl, 0);
    const grossWin   = wins.reduce((s,x) => s + x.pnl.pl, 0);
    const grossLoss  = losses.reduce((s,x) => s + x.pnl.pl, 0);
    const winRate    = closed.length ? (wins.length / closed.length) * 100 : 0;
    const avgWin     = wins.length ? grossWin / wins.length : 0;
    const avgLoss    = losses.length ? grossLoss / losses.length : 0;
    const bestTrade  = closed.length ? Math.max(...closed.map(x => x.pnl.pl)) : 0;
    const worstTrade = closed.length ? Math.min(...closed.map(x => x.pnl.pl)) : 0;

    return {
      closed: closed.sort((a,b) => new Date(b.order.filled_at) - new Date(a.order.filled_at)),
      total: closed.length, wins: wins.length, losses: losses.length,
      totalPL, grossWin, grossLoss, winRate, avgWin, avgLoss, bestTrade, worstTrade,
    };
  }, [ord, perfRange]);

  const tabStyle = (t) => ({
    flex:1, padding:"10px 0", background:tab===t?"rgba(129,140,248,0.15)":"transparent",
    border:"none", color:tab===t?"#818cf8":"rgba(255,255,255,0.3)",
    fontWeight:tab===t?800:500, fontSize:13, cursor:"pointer",
    borderBottom:`2px solid ${tab===t?"#818cf8":"transparent"}`,
    transition:"all 0.2s"
  });

  const rangeBtn = (r, label) => ({
    flex:1, padding:"8px 0", borderRadius:10,
    background: perfRange===r ? "rgba(129,140,248,0.2)" : "rgba(255,255,255,0.03)",
    border: `1px solid ${perfRange===r ? "rgba(129,140,248,0.4)" : "rgba(255,255,255,0.06)"}`,
    color: perfRange===r ? "#a5b4fc" : "rgba(255,255,255,0.4)",
    fontWeight: perfRange===r ? 700 : 500, fontSize:12, cursor:"pointer",
  });

  return (
    <div style={{minHeight:"100vh",background:"#080c18",color:"#fff",fontFamily:"system-ui",direction:"rtl",padding:"20px 16px 60px"}}>
      <div style={{textAlign:"center",marginBottom:20}}>
        <div style={{fontSize:32}}>🤖</div>
        <h1 style={{margin:"4px 0",fontSize:22,fontWeight:900,letterSpacing:2}}>RADAR <span style={{color:"#818cf8"}}>TRADER</span></h1>
        <div style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>{ts?`آخر تحديث: ${ts.toLocaleTimeString("ar")}`:"جاري التحميل..."}</div>
        <div style={{marginTop:6,display:"inline-block",background:market.open?"rgba(0,212,170,0.1)":"rgba(255,71,87,0.1)",border:`1px solid ${market.open?"rgba(0,212,170,0.3)":"rgba(255,71,87,0.3)"}`,borderRadius:20,padding:"3px 12px",fontSize:11,color:market.open?"#00d4aa":"#ff4757",fontWeight:700}}>
          {market.label}
        </div>
      </div>

      <div style={{display:"flex",background:"rgba(255,255,255,0.03)",borderRadius:12,marginBottom:20,overflow:"hidden"}}>
        <button style={tabStyle("dashboard")} onClick={()=>setTab("dashboard")}>📊 الداشبورد</button>
        <button style={tabStyle("performance")} onClick={()=>setTab("performance")}>📈 الأداء</button>
        <button style={tabStyle("history")} onClick={()=>setTab("history")}>📋 السجل</button>
      </div>

      {tab==="dashboard" && <>
        {acc && <div style={{display:"flex",gap:10,marginBottom:20}}>
          {[
            {l:"إجمالي الرصيد",v:`$${fmt(eq)}`,c:"#00d4aa"},
            {l:"كاش متاح",v:`$${fmt(ca)}`,c:"#818cf8"},
            {l:"ربح/خسارة اليوم",v:`${pl>=0?"+":""}$${fmt(pl)}`,s:pct((pl/parseFloat(acc.last_equity||1))*100),c:pl>=0?"#00d4aa":"#ff4757"}
          ].map(x=>(
            <div key={x.l} style={{flex:1,background:`rgba(${x.c=="#00d4aa"?"0,212,170":x.c=="#818cf8"?"129,140,248":"255,71,87"},0.08)`,border:`1px solid ${x.c}33`,borderRadius:14,padding:"12px 8px",textAlign:"center"}}>
              <div style={{fontSize:13,fontWeight:800,color:x.c,fontFamily:"monospace"}}>{x.v}</div>
              {x.s&&<div style={{fontSize:10,color:x.c}}>{x.s}</div>}
              <div style={{fontSize:8,color:"rgba(255,255,255,0.3)",marginTop:3}}>{x.l}</div>
            </div>
          ))}
        </div>}

        <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:16,padding:"14px 12px",marginBottom:20}}>
          <div style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.5)",marginBottom:10}}>📈 تطور الرصيد</div>
          <EquityChart data={equityHist}/>
        </div>

        <button onClick={trade} disabled={busy} style={{width:"100%",background:busy?"rgba(255,255,255,0.05)":"linear-gradient(135deg,#6366f1,#8b5cf6)",border:"none",borderRadius:14,padding:14,color:busy?"rgba(255,255,255,0.3)":"#fff",fontWeight:800,fontSize:15,cursor:busy?"not-allowed":"pointer",marginBottom:8,boxShadow:busy?"none":"0 8px 32px rgba(99,102,241,0.4)"}}>
          {busy?"⟳ جاري التداول...":"🚀 تداول الآن"}
        </button>
        <button onClick={closeAll} disabled={busy} style={{width:"100%",background:"rgba(255,71,87,0.1)",border:"1px solid rgba(255,71,87,0.3)",borderRadius:14,padding:12,color:"#ff4757",fontWeight:700,fontSize:13,cursor:busy?"not-allowed":"pointer",marginBottom:10}}>
          🔴 إغلاق كل الصفقات
        </button>
        {msg&&<div style={{textAlign:"center",fontSize:13,color:"#fbbf24",marginBottom:16}}>{msg}</div>}

        <div style={{marginBottom:24}}>
          <div style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,0.5)",marginBottom:10}}>📊 صفقات مفتوحة ({pos.length})</div>
          {pos.length===0
            ?<div style={{textAlign:"center",color:"rgba(255,255,255,0.2)",fontSize:12,padding:20,background:"rgba(255,255,255,0.02)",borderRadius:12}}>لا توجد صفقات مفتوحة</div>
            :pos.map(p=>{
              const up=parseFloat(p.unrealized_pl||0)>=0;
              const isExpanded = expandedPos===p.symbol;
              return(
                <div key={p.symbol} style={{background:"rgba(15,20,35,0.95)",border:`1px solid ${up?"rgba(0,212,170,0.2)":"rgba(255,71,87,0.2)"}`,borderRadius:14,padding:"14px 16px",marginBottom:10,borderRight:`3px solid ${up?"#00d4aa":"#ff4757"}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                    <div style={{fontFamily:"monospace",fontSize:17,fontWeight:800}}>{p.symbol}</div>
                    <div style={{textAlign:"left"}}>
                      <div style={{fontSize:15,fontWeight:700,color:up?"#00d4aa":"#ff4757",fontFamily:"monospace"}}>{up?"+":""}${fmt(p.unrealized_pl)}</div>
                      <div style={{fontSize:11,color:up?"#00d4aa":"#ff4757"}}>{pct(parseFloat(p.unrealized_plpc||0)*100)}</div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:10}}>
                    {[{l:"الكمية",v:p.qty},{l:"الدخول",v:`$${fmt(p.avg_entry_price)}`},{l:"الحالي",v:`$${fmt(p.current_price)}`},{l:"القيمة",v:`$${fmt(p.market_value)}`}].map(m=>(
                      <div key={m.l} style={{flex:1,background:"rgba(255,255,255,0.04)",borderRadius:8,padding:"6px 8px",textAlign:"center"}}>
                        <div style={{fontSize:11,fontWeight:700,color:"#f1f5f9",fontFamily:"monospace"}}>{m.v}</div>
                        <div style={{fontSize:8,color:"rgba(255,255,255,0.3)",marginTop:2}}>{m.l}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>setExpandedPos(isExpanded?null:p.symbol)} style={{flex:1,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:8,padding:"6px",color:"rgba(255,255,255,0.5)",fontSize:11,cursor:"pointer"}}>
                      {isExpanded?"▲ إخفاء":"📉 الشارت"}
                    </button>
                    <button onClick={()=>closeOne(p.symbol)} disabled={closingPos===p.symbol} style={{flex:1,background:"rgba(255,71,87,0.1)",border:"1px solid rgba(255,71,87,0.3)",borderRadius:8,padding:"6px",color:closingPos===p.symbol?"rgba(255,255,255,0.3)":"#ff4757",fontSize:11,fontWeight:700,cursor:closingPos===p.symbol?"not-allowed":"pointer"}}>
                      {closingPos===p.symbol?"⟳ جاري...":"🔴 إغلاق"}
                    </button>
                  </div>
                  {isExpanded && <StockChart symbol={p.symbol} entryPrice={parseFloat(p.avg_entry_price||0)}/>}
                </div>
              );
            })}
        </div>
      </>}

      {/* ═══════════ تبويب الأداء ═══════════ */}
      {tab==="performance" && <>
        {/* فلتر التاريخ */}
        <div style={{display:"flex",gap:8,marginBottom:18}}>
          <button style={rangeBtn("today","اليوم")} onClick={()=>setPerfRange("today")}>اليوم</button>
          <button style={rangeBtn("week","أسبوع")} onClick={()=>setPerfRange("week")}>أسبوع</button>
          <button style={rangeBtn("month","شهر")} onClick={()=>setPerfRange("month")}>شهر</button>
          <button style={rangeBtn("all","الكل")} onClick={()=>setPerfRange("all")}>الكل</button>
        </div>

        {/* البطل: صافي الربح */}
        <div style={{textAlign:"center",padding:"24px 16px",background:`linear-gradient(160deg,${perf.totalPL>=0?"rgba(0,212,170,0.12)":"rgba(255,71,87,0.12)"},transparent)`,border:`1px solid ${perf.totalPL>=0?"rgba(0,212,170,0.3)":"rgba(255,71,87,0.3)"}`,borderRadius:20,marginBottom:16}}>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:6}}>صافي الربح/الخسارة</div>
          <div style={{fontSize:42,fontWeight:900,color:perf.totalPL>=0?"#00d4aa":"#ff4757",fontFamily:"monospace",lineHeight:1,direction:"ltr"}}>
            {perf.totalPL>=0?"+":""}${fmt(perf.totalPL)}
          </div>
          <div style={{fontSize:12,color:"rgba(255,255,255,0.4)",marginTop:8}}>
            {perf.total} صفقة مغلقة · نسبة النجاح <span style={{color:perf.winRate>=50?"#00d4aa":"#fbbf24",fontWeight:700}}>{perf.winRate.toFixed(0)}%</span>
          </div>
        </div>

        {/* صف الإحصائيات الأساسية */}
        <div style={{display:"flex",gap:10,marginBottom:12}}>
          {[
            {l:"رابحة",v:perf.wins,c:"#00d4aa"},
            {l:"خاسرة",v:perf.losses,c:"#ff4757"},
            {l:"نسبة النجاح",v:`${perf.winRate.toFixed(0)}%`,c:"#818cf8"},
          ].map(x=>(
            <div key={x.l} style={{flex:1,background:`rgba(${x.c=="#00d4aa"?"0,212,170":x.c=="#818cf8"?"129,140,248":"255,71,87"},0.08)`,border:`1px solid ${x.c}33`,borderRadius:14,padding:"14px 8px",textAlign:"center"}}>
              <div style={{fontSize:22,fontWeight:900,color:x.c,fontFamily:"monospace"}}>{x.v}</div>
              <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",marginTop:3}}>{x.l}</div>
            </div>
          ))}
        </div>

        {/* تفاصيل الأرباح والخسائر */}
        <div style={{display:"flex",gap:10,marginBottom:12}}>
          <div style={{flex:1,background:"rgba(0,212,170,0.06)",border:"1px solid rgba(0,212,170,0.2)",borderRadius:14,padding:"12px",direction:"ltr",textAlign:"center"}}>
            <div style={{fontSize:9,color:"rgba(255,255,255,0.4)",marginBottom:4,direction:"rtl"}}>إجمالي الأرباح</div>
            <div style={{fontSize:16,fontWeight:800,color:"#00d4aa",fontFamily:"monospace"}}>+${fmt(perf.grossWin)}</div>
          </div>
          <div style={{flex:1,background:"rgba(255,71,87,0.06)",border:"1px solid rgba(255,71,87,0.2)",borderRadius:14,padding:"12px",direction:"ltr",textAlign:"center"}}>
            <div style={{fontSize:9,color:"rgba(255,255,255,0.4)",marginBottom:4,direction:"rtl"}}>إجمالي الخسائر</div>
            <div style={{fontSize:16,fontWeight:800,color:"#ff4757",fontFamily:"monospace"}}>${fmt(perf.grossLoss)}</div>
          </div>
        </div>

        {/* أفضل وأسوأ صفقة */}
        <div style={{display:"flex",gap:10,marginBottom:20}}>
          <div style={{flex:1,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:14,padding:"12px",direction:"ltr",textAlign:"center"}}>
            <div style={{fontSize:9,color:"rgba(255,255,255,0.4)",marginBottom:4,direction:"rtl"}}>🏆 أفضل صفقة</div>
            <div style={{fontSize:15,fontWeight:800,color:"#00d4aa",fontFamily:"monospace"}}>+${fmt(perf.bestTrade)}</div>
          </div>
          <div style={{flex:1,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:14,padding:"12px",direction:"ltr",textAlign:"center"}}>
            <div style={{fontSize:9,color:"rgba(255,255,255,0.4)",marginBottom:4,direction:"rtl"}}>📉 أسوأ صفقة</div>
            <div style={{fontSize:15,fontWeight:800,color:"#ff4757",fontFamily:"monospace"}}>${fmt(perf.worstTrade)}</div>
          </div>
        </div>

        {/* قائمة الصفقات المغلقة في الفترة */}
        <div style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,0.5)",marginBottom:10}}>📋 صفقات الفترة ({perf.total})</div>
        {perf.closed.length===0
          ?<div style={{textAlign:"center",color:"rgba(255,255,255,0.2)",fontSize:12,padding:40,background:"rgba(255,255,255,0.02)",borderRadius:12}}>لا توجد صفقات مغلقة في هذه الفترة</div>
          :perf.closed.map(({order:o,pnl})=>{
            const isProfit = pnl.pl >= 0;
            return (
              <div key={o.id} style={{background:"rgba(255,255,255,0.03)",border:`1px solid ${isProfit?"rgba(0,212,170,0.2)":"rgba(255,71,87,0.2)"}`,borderRadius:12,padding:"12px 14px",marginBottom:8,borderRight:`3px solid ${isProfit?"#00d4aa":"#ff4757"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontFamily:"monospace",fontWeight:800,fontSize:16}}>{o.symbol}</div>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",marginTop:3,direction:"ltr",textAlign:"right"}}>
                      {o.qty} × ${fmt(pnl.buyPrice)} → ${fmt(o.filled_avg_price)}
                    </div>
                    <div style={{fontSize:9,color:"rgba(255,255,255,0.2)",marginTop:2}}>
                      {o.filled_at?new Date(o.filled_at).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):""}
                    </div>
                  </div>
                  <div style={{textAlign:"left",direction:"ltr"}}>
                    <div style={{fontSize:16,fontWeight:900,color:isProfit?"#00d4aa":"#ff4757",fontFamily:"monospace"}}>
                      {isProfit?"+":""}${fmt(pnl.pl)}
                    </div>
                    <div style={{fontSize:12,color:isProfit?"#00d4aa":"#ff4757",fontWeight:700}}>
                      {pct(pnl.plPct)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
      </>}

      {tab==="history" && <>
        <div style={{display:"flex",gap:10,marginBottom:16}}>
          {[
            {l:"إجمالي البيع",v:ord.filter(o=>o.side==="sell"&&o.status==="filled").length,c:"#818cf8"},
            {l:"رابحة",v:ord.filter(o=>o.side==="sell"&&o.status==="filled"&&calcPnL(o,ord)?.pl>=0).length,c:"#00d4aa"},
            {l:"خاسرة",v:ord.filter(o=>o.side==="sell"&&o.status==="filled"&&calcPnL(o,ord)?.pl<0).length,c:"#ff4757"},
          ].map(x=>(
            <div key={x.l} style={{flex:1,background:`rgba(${x.c=="#818cf8"?"129,140,248":x.c=="#00d4aa"?"0,212,170":"255,71,87"},0.08)`,border:`1px solid ${x.c}33`,borderRadius:14,padding:"12px 8px",textAlign:"center"}}>
              <div style={{fontSize:20,fontWeight:900,color:x.c,fontFamily:"monospace"}}>{x.v}</div>
              <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",marginTop:3}}>{x.l}</div>
            </div>
          ))}
        </div>

        {todayPnLList.length > 0 && (
          <div style={{background:`rgba(${todayTotalPL>=0?"0,212,170":"255,71,87"},0.08)`,border:`1px solid ${todayTotalPL>=0?"rgba(0,212,170,0.3)":"rgba(255,71,87,0.3)"}`,borderRadius:16,padding:"16px",marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:700,color:"rgba(255,255,255,0.5)",marginBottom:8}}>📊 ملخص اليوم</div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:22,fontWeight:900,color:todayTotalPL>=0?"#00d4aa":"#ff4757",fontFamily:"monospace"}}>
                  {todayTotalPL>=0?"+":""}${fmt(todayTotalPL)}
                </div>
                <div style={{fontSize:12,color:todayTotalPL>=0?"#00d4aa":"#ff4757"}}>{pct(todayTotalPct)}</div>
              </div>
              <div style={{textAlign:"left"}}>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>صفقات مغلقة اليوم</div>
                <div style={{fontSize:20,fontWeight:800,color:"#818cf8",fontFamily:"monospace"}}>{todayPnLList.length}</div>
              </div>
            </div>
          </div>
        )}

        <div style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,0.5)",marginBottom:10}}>📋 سجل الصفقات</div>
        {ord.filter(o=>o.side==="sell"&&o.status==="filled").length===0
          ?<div style={{textAlign:"center",color:"rgba(255,255,255,0.2)",fontSize:12,padding:40,background:"rgba(255,255,255,0.02)",borderRadius:12}}>لا توجد صفقات مغلقة بعد</div>
          :ord.filter(o=>o.side==="sell"&&o.status==="filled").map(o=>{
            const pnl = calcPnL(o, ord);
            const isProfit = pnl?.pl >= 0;
            return (
              <div key={o.id} style={{background:"rgba(255,255,255,0.03)",border:`1px solid ${isProfit?"rgba(0,212,170,0.2)":"rgba(255,71,87,0.2)"}`,borderRadius:12,padding:"12px 14px",marginBottom:8,borderRight:`3px solid ${isProfit?"#00d4aa":"#ff4757"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontFamily:"monospace",fontWeight:800,fontSize:16}}>{o.symbol}</div>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",marginTop:3}}>
                      {o.qty} سهم · دخول ${fmt(pnl?.buyPrice)} · خروج ${fmt(o.filled_avg_price)}
                    </div>
                    <div style={{fontSize:9,color:"rgba(255,255,255,0.2)",marginTop:2}}>
                      {o.filled_at?new Date(o.filled_at).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):""}
                    </div>
                  </div>
                  {pnl && (
                    <div style={{textAlign:"left"}}>
                      <div style={{fontSize:16,fontWeight:900,color:isProfit?"#00d4aa":"#ff4757",fontFamily:"monospace"}}>
                        {isProfit?"+":""}${fmt(pnl.pl)}
                      </div>
                      <div style={{fontSize:12,color:isProfit?"#00d4aa":"#ff4757",textAlign:"center",fontWeight:700}}>
                        {pct(pnl.plPct)}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
      </>}

      <p style={{textAlign:"center",fontSize:10,color:"rgba(255,255,255,0.1)",marginTop:24}}>Paper Trading · لا فلوس حقيقية · يتحدث كل 30 ثانية</p>
    </div>
  );
}
