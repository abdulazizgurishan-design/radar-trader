// pages/api/close.js — إغلاق كل المراكز المفتوحة (طوارئ)
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";
const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const H = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET, "Content-Type": "application/json" };
const SB_H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    // ألغِ كل الأوامر المفتوحة
    await fetch(`${ALPACA_BASE}/v2/orders`, { method: "DELETE", headers: H }).catch(() => {});
    // أغلق كل المراكز (Alpaca: DELETE /v2/positions = تصفية الكل)
    const r = await fetch(`${ALPACA_BASE}/v2/positions?cancel_orders=true`, { method: "DELETE", headers: H });
    const result = await r.json().catch(() => []);

    // علّم كل الخطط النشطة مغلقة
    if (SUPABASE_URL) {
      await fetch(`${SUPABASE_URL}/rest/v1/bot_positions?status=eq.active`, {
        method: "PATCH", headers: SB_H,
        body: JSON.stringify({ status: "closed", updated_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    const count = Array.isArray(result) ? result.length : 0;
    return res.status(200).json({ success: true, message: `تم إغلاق ${count} مركز`, closed: count });
  } catch (e) {
    return res.status(200).json({ success: false, error: e.message });
  }
}
