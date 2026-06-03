// /api/trade.js — استراتيجية Radaraz — هدف T1
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";

const STRATEGY = {
  minScore:      65,
  minChangePct:  1,
  maxChangePct:  8,      // ✅ فوق 8% ما يدخل
  minVolume:     100_000,
  onlyAboveVWAP: true,
  maxTrades:     8,      // ✅ 8 أسهم
  riskPerTrade:  0.05,   // 5% من المحفظة
};

const H = {
  "APCA-API-KEY-ID":     ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type":        "application/json",
};

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
      qty:           qty.toString(),
      side:          "buy",
      type:          "market",
      time_in_force: "day",
      order_class:   "bracket",
      stop_loss:     { stop_price: stopLoss.toFixed(2) },
      take_profit:   { limit_price: takeProfit.toFixed(2) },
    }),
  });
  return await r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ✅ نافذة الدخول: 9:40-9:55 AM ET = 4:40-4:55 م السعودية
    const now = new Date();
    const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const h   = et.getHours(), m = et.getMinutes();
    const totalMins = h * 60 + m;
    const openMins  = 9 * 60 + 40;
    const closeMins = 9 * 60 + 55;

    const force = req.body?.force === true;

    if (!force && (totalMins < openMins || totalMins > closeMins)) {
      return res.status(200).json({
        success: true,
        message: `وقت الدخول 4:40-4:55 م السعودية فقط — الآن ${h}:${String(m).padStart(2,'0')} ET`,
        trades: []
      });
    }

    // جلب نتائج الرادار
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const scanRes = await fetch(`${baseUrl}/api/scan`);
    const scanData = await scanRes.json();
    const candidates = scanData.results ?? [];

    // فلترة
    const filtered = candidates.filter(s =>
      s.score      >= STRATEGY.minScore     &&
      s.change_pct >= STRATEGY.minChangePct &&
      s.change_pct <= STRATEGY.maxChangePct && // ✅ فوق 8% ما يدخل
      s.volume     >= STRATEGY.minVolume    &&
      s.price > s.vwap &&                      // ✅ VWAP
      s.levels?.t1 && s.levels?.sl            // ✅ لازم عنده أهداف
    );

    if (filtered.length === 0)
      return res.status(200).json({ success: true, message: "لا توجد فرص تستوفي الشروط", trades: [] });

    const [account, openPositions] = await Promise.all([getAccount(), getOpenPositions()]);
    const balance   = parseFloat(account.equity || account.cash || 0);
    const openCount = Array.isArray(openPositions) ? openPositions.length : 0;

    if (openCount >= STRATEGY.maxTrades)
      return res.status(200).json({ success: true, message: `وصلت الحد الأقصى (${STRATEGY.maxTrades})`, trades: [] });

    const toTrade = filtered.slice(0, STRATEGY.maxTrades - openCount);
    const trades  = [];

    for (const stock of toTrade) {
      if (await hasOpenPosition(stock.symbol)) continue;

      const qty = Math.floor((balance * STRATEGY.riskPerTrade) / stock.price);
      if (qty < 1) continue;

      // ✅ استخدام أهداف الرادار مباشرة
      const takeProfit = parseFloat(stock.levels.t1.toFixed(2));
      const stopLoss   = parseFloat(stock.levels.sl.toFixed(2));

      const order = await placeOrder({ symbol: stock.symbol, qty, stopLoss, takeProfit });

      trades.push({
        symbol:     stock.symbol,
        price:      stock.price,
        qty,
        takeProfit,
        stopLoss,
        t1Pct:      stock.levels.t1Pct,
        slPct:      stock.levels.slPct,
        score:      stock.score,
        status:     order.status ?? "error",
        error:      order.message ?? null,
      });
    }

    return res.status(200).json({ success: true, balance, tradesPlaced: trades.length, trades });

  } catch (error) {
    return res.status(200).json({ success: false, error: error.message });
  }
}
