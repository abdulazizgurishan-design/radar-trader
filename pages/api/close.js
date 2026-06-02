const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";

const H = {
  "APCA-API-KEY-ID":     ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type":        "application/json",
};

export default async function handler(req, res) {
  if(req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    await fetch(`${ALPACA_BASE}/v2/orders`, { method: "DELETE", headers: H });
    await new Promise(r => setTimeout(r, 2000));
    const posRes = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: H });
    const positions = await posRes.json();
    if(!Array.isArray(positions) || positions.length === 0)
      return res.status(200).json({ success: true, message: "لا توجد صفقات مفتوحة", closed: 0 });
    const results = [];
    for(const pos of positions) {
      try {
        const r = await fetch(`${ALPACA_BASE}/v2/positions/${pos.symbol}`, { method: "DELETE", headers: H });
        const d = await r.json();
        results.push({ symbol: pos.symbol, status: d.status ?? "submitted" });
      } catch(e) {
        results.push({ symbol: pos.symbol, error: e.message });
      }
    }
    return res.status(200).json({ success: true, message: `تم إغلاق ${results.length} صفقة`, closed: results.length, results });
  } catch(error) {
    return res.status(200).json({ success: false, error: error.message });
  }
}
