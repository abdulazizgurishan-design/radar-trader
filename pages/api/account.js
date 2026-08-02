// pages/api/account.js — يزوّد الواجهة بالحساب + المراكز + الأوامر
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";
const H = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET, "Content-Type": "application/json" };

export default async function handler(req, res) {
  try {
    const [acctR, posR, ordR] = await Promise.all([
      fetch(`${ALPACA_BASE}/v2/account`, { headers: H }),
      fetch(`${ALPACA_BASE}/v2/positions`, { headers: H }),
      fetch(`${ALPACA_BASE}/v2/orders?status=all&limit=200&direction=desc`, { headers: H }),
    ]);
    const account = await acctR.json();
    const positions = await posR.json();
    const orders = await ordR.json();
    return res.status(200).json({
      account,
      positions: Array.isArray(positions) ? positions : [],
      orders: Array.isArray(orders) ? orders : [],
    });
  } catch (e) {
    return res.status(200).json({ error: e.message, account: null, positions: [], orders: [] });
  }
}
