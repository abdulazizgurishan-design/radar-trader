// /api/trade.js — استراتيجية محسّنة لهدف 1-2% يومياً
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";

const STRATEGY = {
  minScore:        70,
  minChangePct:    2,       // ارتفع +2% من الفتح
  maxChangePct:    8,       // ما فات القطار
  minVolume:       100_000,
  minRvol:         1.5,     // حجم أعلى من المعتاد 1.5x
  onlyAboveVWAP:   true,    // ✅ شرط أساسي
  riskPerTrade:    0.05,    // 5% من المحفظة
  maxOpenTrades:   4,       // أقصى 4 صفقات
  takeProfitPct:   0.015,   // هدف 1.5%
  stopLossPct:     0.01,    // وقف خسارة 1%
};

const H = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET, "Content-Type": "application/json" };

async function getAccount() {
  const r = await fetch(`${ALPACA_BASE}/v2/account`, { headers: H });
  return await r.json();
}

async function getOpenPositions() {
  const r = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: H });
  return await r.json();
}

async function hasOpenPosition(symbol) {
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/positions/${symbol}`, { headers: H });
    return r.ok;
  } catch { return false; }
}

async function placeOrder({ symbol, qty, stopLoss, takeProfit }) {
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      symbol,
      qty: qty.toString(),
      side: "buy",
      type: "market",
      time_in_force: "day",
      order_class: "bracket",
      stop_loss:   { stop_price: stopLoss.toFixed(2) },
      take_profit: { limit_price: takeProfit.toFixed(2) },
    }),
  });
  return await r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // تحقق من وقت السوق — فقط أول ساعتين (9:30-11:30 AM نيويورك)
    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const h = et.getHours(), m = et.getMinutes();
    const minutesSinceOpen = (h - 9) * 60 + m - 30;

    if (minutesSinceOpen < 0 || minutesSinceOpen > 120) {
      return res.status(200).json({ success: true, message: "خارج وقت التداول (9:30-11:30 AM)", trades: [] });
    }

    // جلب نتائج الرادار
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const scanRes = await fetch(`${baseUrl}/api/scan`);
    const scanData = await scanRes.json();
    const candidates = scanData.results ?? [];

    // فلترة بالاستراتيجية
    const filtered = candidates.filter(s =>
      s.score       >= STRATEGY.minScore      &&
      s.change_pct  >= STRATEGY.minChangePct  &&
      s.change_pct  <= STRATEGY.maxChangePct  &&
      s.volume      >= STRATEGY.minVolume     &&
      (s.rvol == null || s.rvol >= STRATEGY.minRvol) &&
      s.price > s.vwap  // ✅ VWAP
    );

    if (filtered.length === 0)
      return res.status(200).json({ success: true, message: "لا توجد فرص تستوفي الشروط", trades: [] });

    const [account, openPositions] = await Promise.all([getAccount(), getOpenPositions()]);
    const balance = parseFloat(account.equity || account.cash || 0);
    const openCount = Array.isArray(openPositions) ? openPositions.length : 0;

    if (openCount >= STRATEGY.maxOpenTrades)
      return res.status(200).json({ success: true, message: `وصلت الحد الأقصى (${STRATEGY.maxOpenTrades})`, trades: [] });

    const toTrade = filtered.slice(0, STRATEGY.maxOpenTrades - openCount);
    const trades = [];

    for (const stock of toTrade) {
      if (await hasOpenPosition(stock.symbol)) continue;

      const qty = Math.floor((balance * STRATEGY.riskPerTrade) / stock.price);
      if (qty < 1) continue;

      const takeProfit = parseFloat((stock.price * (1 + STRATEGY.takeProfitPct)).toFixed(2));
      const stopLoss   = parseFloat((stock.price * (1 - STRATEGY.stopLossPct)).toFixed(2));

      const order = await placeOrder({ symbol: stock.symbol, qty, stopLoss, takeProfit });

      trades.push({
        symbol:     stock.symbol,
        price:      stock.price,
        qty,
        takeProfit,
        stopLoss,
        score:      stock.score,
        rvol:       stock.rvol,
        status:     order.status ?? "error",
        error:      order.message ?? null,
      });
    }

    return res.status(200).json({ success: true, balance, tradesPlaced: trades.length, trades });

  } catch (error) {
    return res.status(200).json({ success: false, error: error.message });
  }
}
