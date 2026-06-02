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
  const { symbol } = req.body;
  if(!symbol) return res.status(400).json({ error: "symbol required" });
  try {
    const ordersRes = await fetch(`${ALPACA_BASE}/v2/orders?status=open&symbols=${symbol}`, { headers: H });
    const orders = await ordersRes.json();
    if(Array.isArray(orders)) {
      for(const o of orders) {
        await fetch(`${ALPACA_BASE}/v2/orders/${o.id}`, { method: "DELETE", headers: H });
      }
    }
    await new Promise(r => setTimeout(r, 1000));
    const r = await fetch(`${ALPACA_BASE}/v2/positions/${symbol}`, { method: "DELETE", headers: H });
    const d = await r.json();
    res.status(200).json({ success: true, symbol, result: d });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
