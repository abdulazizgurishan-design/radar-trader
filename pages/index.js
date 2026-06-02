import { useState, useEffect, useCallback } from "react";
const ALPACA_BASE = "https://paper-api.alpaca.markets";
const KEY    = "AKJB26REF36E5DH5NLAUBALFFW";
const SECRET = "Gn2oWK3hQqjXYnBLHZLZX5PVcGGGw19UZAezuk1puK4J";
const headers = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET };
async function fetchAccount() { const r = await fetch(`${ALPACA_BASE}/v2/account`, { headers }); return r.json(); }
async function fetchPositions() { const r = await fetch(`${ALPACA_BASE}/v2/positions`, { headers }); return r.json(); }
async function fetchOrders() { const r = await fetch(`${ALPACA_BASE}/v2/orders?status=closed&limit=20`, { headers }); return r.json(); }
function fmt(n) { return parseFloat(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtPct(n) { const v = parseFloat(n || 0); return (v >= 0 ? "+" : "") + v.toFixed(2) + "%"; }
export default function Dashboard() {
  const [account, setAccount] = useState(null);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [trading, setTrading] = useState(false);
  const [tradeMsg, setTradeMsg] = useState(null);
  const refresh = useCallback(async () => {
    try {
      const [acc, pos, ord] = await Promise.all([fetchAccount(), fetchPositions(), fetchOrders()]);
      setAccount(acc);
      setPositions(Array.isArray(pos) ? pos : []);
      setOrders(Array.isArray(ord) ? ord : []);
      setLastUpdate(new Date());
    } catch (e) { console.error(e); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 30_000); return () => clearInterval(t); }, [refresh]);
  const runTrade = async () => {
    setTrading(true); setTradeMsg(null);
    try {
      const r = await fetch("/api/trade", { method: "POST" });
      const d = await r.json();
      setTradeMsg(d.tradesPlaced > 0 ? `✅ نُفذت ${d.tradesPlaced} صفقة` : `⚠️ ${d.message || "لا توجد فرص"}`);
      await refresh();
    } catch { setTradeMsg("❌ خطأ في الاتصال"); } finally { setTrading(false); }
  };
  const equity = parseFloat(account?.equity || 0);
  const cash = parseFloat(account?.cash || 0);
  const dayPL = parseFloat(account?.equity || 0) - parseFloat(account?.last_equity || 0);
  const dayPLPct = account?.last_equity ? (dayPL / parseFloat(account.last_equity)) * 100 : 0;
  return (
    <div style={{ minHeight: "100vh", background: "#080c18", color: "#fff", fontFamily: "system-ui", direction: "rtl", padding: "20px 16px 40px" }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ fontSize: 32, marginBottom: 4 }}>🤖</div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, letterSpacing: 2 }}>RADAR <span style={{ color: "#818cf8" }}>TRADER</span></h1>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>{lastUpdate ? `آخر تحديث: ${lastUpdate.toLocaleTimeString("ar")}` : "جاري التحميل..."}</div>
      </div>
      {account && (
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          {[
            { label: "إجمالي الرصيد", value: `$${fmt(equity)}`, color: "#00d4aa", bg: "rgba(0,212,170,0.08)", border: "rgba(0,212,170,0.2)" },
            { label: "كاش متاح", value: `$${fmt(cash)}`, color: "#818cf8", bg: "rgba(129,140,248,0.08)", border: "rgba(129,140,248,0.2)" },
            { label: "ربح/خسارة اليوم", value: `${dayPL >= 0 ? "+" : ""}$${fmt(dayPL)}`, sub: fmtPct(dayPLPct), color: dayPL >= 0 ? "#00d4aa" : "#ff4757", bg: dayPL >= 0 ? "rgba(0,212,170,0.08)" : "rgba(255,71,87,0.08)", border: dayPL >= 0 ? "rgba(0,212,170,0.2)" : "rgba(255,71,87,0.2)" },
          ].map(s => (
            <div key={s.label} style={{ flex: 1, minWidth: 90, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 14, padding: "12px 14px", textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: s.color, fontFamily: "monospace" }}>{s.value}</div>
              {s.sub && <div style={{ fontSize: 11, color: s.color, opacity: 0.8 }}>{s.sub}</div>}
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginTop: 3 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}
      <button onClick={runTrade} disabled={trading} style={{ width: "100%", background: trading ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#6366f1,#8b5cf6)", border: "none", borderRadius: 14, padding: "14px", color: trading ? "rgba(255,255,255,0.3)" : "#fff", fontWeight: 800, fontSize: 15, cursor: trading ? "not-allowed" : "pointer", marginBottom: 10, letterSpacing: 1, boxShadow: trading ? "none" : "0 8px 32px rgba(99,102,241,0.4)" }}>
        {trading ? "⟳ جاري التداول..." : "🚀 تداول الآن"}
      </button>
      {tradeMsg && <div style={{ textAlign: "center", fontSize: 13, color: "#fbbf24", marginBottom: 16 }}>{tradeMsg}</div>}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.5)", marginBottom: 10 }}>📊 صفقات مفتوحة ({positions.length})</div>
        {loading ? <div style={{ textAlign: "center", color: "rgba(255,255,255,0.2)", fontSize: 12, padding: 20 }}>جاري التحميل...</div>
        : positions.length === 0 ? <div style={{ textAlign: "center", color: "rgba(255,255,255,0.2)", fontSize: 12, padding: 20, background: "rgba(255,255,255,0.02)", borderRadius: 12 }}>لا توجد صفقات مفتوحة</div>
        : positions.map(p => {
          const pl = parseFloat(p.unrealized_pl || 0);
          const plPct = parseFloat(p.unrealized_plpc || 0) * 100;
          const isUp = pl >= 0;
          return (
            <div key={p.symbol} style={{ background: "linear-gradient(135deg,rgba(15,20,35,0.95),rgba(20,28,48,0.95))", border: `1px solid ${isUp ? "rgba(0,212,170,0.2)" : "rgba(255,71,87,0.2)"}`, borderRadius: 14, padding: "14px 16px", marginBottom: 10, borderRight: `3px solid ${isUp ? "#00d4aa" : "#ff4757"}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontFamily: "monospace", fontSize: 17, fontWeight: 800 }}>{p.symbol}</div>
                <div style={{ textAlign: "left" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: isUp ? "#00d4aa" : "#ff4757", fontFamily: "monospace" }}>{isUp ? "+" : ""}${fmt(pl)}</div>
                  <div style={{ fontSize: 11, color: isUp ? "#00d4aa" : "#ff4757" }}>{fmtPct(plPct)}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[{ label: "الكمية", value: p.qty }, { label: "سعر الدخول", value: `$${fmt(p.avg_entry_price)}` }, { label: "السعر الحالي", value: `$${fmt(p.current_price)}` }, { label: "القيمة", value: `$${fmt(p.market_value)}` }].map(m => (
                  <div key={m.label} style={{ flex: 1, minWidth: 60, background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "6px 8px", textAlign: "center" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#f1f5f9", fontFamily: "monospace" }}>{m.value}</div>
                    <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>{m.label}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.5)", marginBottom: 10 }}>✅ آخر الصفقات المغلقة</div>
        {orders.length === 0 ? <div style={{ textAlign: "center", color: "rgba(255,255,255,0.2)", fontSize: 12, padding: 20, background: "rgba(255,255,255,0.02)", borderRadius: 12 }}>لا توجد صفقات مغلقة</div>
        : orders.slice(0, 10).map(o => (
          <div key={o.id} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "10px 14px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>{o.symbol}</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>{o.side === "buy" ? "🟢 شراء" : "🔴 بيع"} · {o.qty} سهم · ${fmt(o.filled_avg_price)}</div>
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, color: o.status === "filled" ? "#00d4aa" : "rgba(255,255,255,0.3)", background: o.status === "filled" ? "rgba(0,212,170,0.1)" : "rgba(255,255,255,0.05)", padding: "3px 8px", borderRadius: 20 }}>
              {o.status === "filled" ? "✅ منفذ" : o.status}
            </div>
          </div>
        ))}
      </div>
      <p style={{ textAlign: "center", fontSize: 10, color: "rgba(255,255,255,0.1)", marginTop: 24 }}>Paper Trading · لا فلوس حقيقية · يتحدث كل 30 ثانية</p>
    </div>
  );
}
