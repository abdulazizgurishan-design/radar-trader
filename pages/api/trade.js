// /api/trade.js — استراتيجية Radaraz الكاملة
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
  riskPerTrade:  0.05,   // 5% من المحفظة لكل سهم
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

// شراء بسيط بدون bracket — المراقبة تتولى البيع
async function placeMarketBuy({ symbol, qty, stopLoss }) {
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      symbol,
      qty:           qty.toString(),
      side:          "buy",
      type:          "market",
      time_in_force: "day",
      order_class:   "simple",
    }),
  });
  return await r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ✅ فقط الساعة 4:40-4:50 م السعودية = 1:40-1:50 PM UTC
    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const h = et.getHours(), m = et.getMinutes();
    // السوق يفتح 9:30 AM ET = 4:30 PM السعودية
    // نشتري بعد 10 دقائق = 9:40 AM ET
    const totalMins = h * 60 + m;
    const openMins  = 9 * 60 + 40;  // 9:40 AM ET
    const closeMins = 9 * 60 + 55;  // نافذة 15 دقيقة فقط للدخول

    // اسمح بالتشغيل اليدوي في أي وقت لو method=POST مع force=true
    const force = req.body?.force === true;

    if (!force && (totalMins < openMins || totalMins > closeMins)) {
      return res.status(200).json({
        success: true,
        message: `وقت الدخول 9:40-9:55 AM ET (4:40-4:55 م السعودية) — الآن ${h}:${String(m).padStart(2,'0')}`,
        trades: []
      });
    }

    // جلب نتائج الرادار
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const scanRes = await fetch(`${baseUrl}/api/scan`);
    const scanData = await scanRes.json();
    const candidates = scanData.results ?? [];

    // فلترة بالاستراتيجية
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
    const balance  = parseFloat(account.equity || account.cash || 0);
    const openCount = Array.isArray(openPositions) ? openPositions.length : 0;

    if (openCount >= STRATEGY.maxTrades)
      return res.status(200).json({ success: true, message: `وصلت الحد الأقصى (${STRATEGY.maxTrades} أسهم)`, trades: [] });

    const slots   = STRATEGY.maxTrades - openCount;
    const toTrade = filtered.slice(0, slots);
    const trades  = [];

    for (const stock of toTrade) {
      if (await hasOpenPosition(stock.symbol)) continue;

      const qty = Math.floor((balance * STRATEGY.riskPerTrade) / stock.price);
      if (qty < 3) continue; // نحتاج على الأقل 3 أسهم عشان نقدر نقسم

      const order = await placeMarketBuy({ symbol: stock.symbol, qty });

      // حفظ خطة التداول في response عشان monitor يقرأها
      trades.push({
        symbol:   stock.symbol,
        price:    stock.price,
        qty,
        t1:       stock.levels.t1,
        t2:       stock.levels.t2,
        t3:       stock.levels.t3,
        sl:       stock.levels.sl,
        // كميات البيع
        qtyT1:    Math.floor(qty * 0.5),  // 50%
        qtyT2:    Math.floor(qty * 0.3),  // 30%
        qtyT3:    qty - Math.floor(qty * 0.5) - Math.floor(qty * 0.3), // 20%
        score:    stock.score,
        status:   order.status ?? "error",
        error:    order.message ?? null,
      });
    }

    return res.status(200).json({
      success:      true,
      balance,
      tradesPlaced: trades.length,
      trades,
    });

  } catch (error) {
    return res.status(200).json({ success: false, error: error.message });
  }
}
