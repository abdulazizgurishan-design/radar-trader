// pages/api/closeone.js — إغلاق مركز واحد (يلغي أوامره ثم يبيع بالسوق)
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";
const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const H = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET, "Content-Type": "application/json" };
const SB_H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { symbol } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  try {
    // ألغِ الأوامر المفتوحة للرمز
    const oo = await fetch(`${ALPACA_BASE}/v2/orders?status=open&symbols=${symbol}`, { headers: H }).then(r => r.json());
    if (Array.isArray(oo)) {
      for (const o of oo) {
        await fetch(`${ALPACA_BASE}/v2/orders/${o.id}`, { method: "DELETE", headers: H }).catch(() => {});
      }
    }
    // أغلق المركز (Alpaca DELETE position = بيع بالسوق)
    const r = await fetch(`${ALPACA_BASE}/v2/positions/${symbol}`, { method: "DELETE", headers: H });
    const ok = r.ok;

    // حدّث حالة الخطة في Supabase
    if (SUPABASE_URL) {
      await fetch(`${SUPABASE_URL}/rest/v1/bot_positions?symbol=eq.${symbol}`, {
        method: "PATCH", headers: SB_H,
        body: JSON.stringify({ status: "closed", updated_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    return res.status(200).json({ success: ok, symbol });
  } catch (e) {
    return res.status(200).json({ success: false, error: e.message });
  }
}
