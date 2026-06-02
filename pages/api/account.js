const ALPACA_KEY = process.env.NEXT_PUBLIC_ALPACA_KEY;
const ALPACA_SECRET = process.env.NEXT_PUBLIC_ALPACA_SECRET;
const BASE = "https://paper-api.alpaca.markets";

export default async function handler(req, res) {
  try {
    const [acc, pos, ord] = await Promise.all([
      fetch(`${BASE}/v2/account`, { headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET } }).then(r => r.json()),
      fetch(`${BASE}/v2/positions`, { headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET } }).then(r => r.json()),
      fetch(`${BASE}/v2/orders?status=closed&limit=100`, { headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET } }).then(r => r.json()),
    ]);
    res.status(200).json({ account: acc, positions: pos, orders: ord });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
