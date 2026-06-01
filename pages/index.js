import { useState } from "react";

export default function TraderDashboard() {
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);

  const runTrade = async () => {
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res  = await fetch("/api/trade", { method: "POST" });
      const data = await res.json();
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#080c18",
      color: "#fff",
      fontFamily: "system-ui",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      direction: "rtl",
    }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>🤖</div>
      <h1 style={{ fontSize: 22, fontWeight: 900, marginBottom: 4, letterSpacing: 2 }}>
        RADAR <span style={{ color: "#818cf8" }}>TRADER</span>
      </h1>
      <p style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginBottom: 32 }}>
        تداول تلقائي · Paper Trading · ديمو
      </p>

      {/* زر التشغيل */}
      <button
        onClick={runTrade}
        disabled={loading}
        style={{
          background: loading ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
          border: "none",
          borderRadius: 14,
          padding: "16px 40px",
          color: loading ? "rgba(255,255,255,0.3)" : "#fff",
          fontWeight: 800,
          fontSize: 16,
          cursor: loading ? "not-allowed" : "pointer",
          marginBottom: 24,
          letterSpacing: 1,
          boxShadow: loading ? "none" : "0 8px 32px rgba(99,102,241,0.4)",
        }}
      >
        {loading ? "⟳ جاري التداول..." : "🚀 ابدأ التداول التلقائي"}
      </button>

      {/* خطأ */}
      {error && (
        <div style={{
          background: "rgba(255,71,87,0.1)",
          border: "1px solid rgba(255,71,87,0.3)",
          borderRadius: 12,
          padding: "12px 20px",
          color: "#ff4757",
          marginBottom: 16,
          fontSize: 13,
        }}>
          ❌ {error}
        </div>
      )}

      {/* النتائج */}
      {result && (
        <div style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16,
          padding: 20,
          width: "100%",
          maxWidth: 480,
        }}>
          {/* ملخص */}
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            {[
              { label: "الرصيد", value: result.balance ? `$${result.balance.toLocaleString()}` : "—", color: "#00d4aa" },
              { label: "صفقات نُفذت", value: result.tradesPlaced ?? 0, color: "#818cf8" },
              { label: "مفتوحة قبل", value: result.openBefore ?? 0, color: "#fbbf24" },
            ].map(s => (
              <div key={s.label} style={{
                flex: 1, minWidth: 80,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 10,
                padding: "10px 12px",
                textAlign: "center",
              }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: s.color, fontFamily: "monospace" }}>{s.value}</div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", marginTop: 3 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* رسالة */}
          {result.message && (
            <div style={{ fontSize: 13, color: "#fbbf24", marginBottom: 12, textAlign: "center" }}>
              ⚠️ {result.message}
            </div>
          )}

          {/* الصفقات */}
          {result.trades && result.trades.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>الصفقات المنفذة:</div>
              {result.trades.map((t, i) => (
                <div key={i} style={{
                  background: t.status === "accepted" || t.status === "pending_new"
                    ? "rgba(0,212,170,0.06)" : "rgba(255,71,87,0.06)",
                  border: `1px solid ${t.status === "accepted" || t.status === "pending_new"
                    ? "rgba(0,212,170,0.2)" : "rgba(255,71,87,0.2)"}`,
                  borderRadius: 10,
                  padding: "10px 14px",
                  marginBottom: 8,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}>
                  <div>
                    <div style={{ fontWeight: 700, fontFamily: "monospace", fontSize: 15 }}>{t.symbol}</div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
                      {t.qty} سهم · دخول ${t.price} · هدف ${t.takeProfit} · وقف ${t.stopLoss}
                    </div>
                  </div>
                  <div style={{
                    fontSize: 10, fontWeight: 700,
                    color: t.status === "accepted" || t.status === "pending_new" ? "#00d4aa" : "#ff4757",
                  }}>
                    {t.error ?? t.status}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p style={{ fontSize: 10, color: "rgba(255,255,255,0.15)", marginTop: 32 }}>
        Paper Trading · لا فلوس حقيقية · للتجربة فقط
      </p>
    </div>
  );
}
