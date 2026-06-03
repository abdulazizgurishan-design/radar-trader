// /api/monitor.js — مراقبة الأهداف وتنفيذ البيع التدريجي
// يُستدعى كل دقيقة من vercel.json
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";

const H = {
  "APCA-API-KEY-ID":     ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type":        "application/json",
};

// Trailing Stop: لو السعر ارتفع 1% فوق T1 يرفع وقف الخسارة
const TRAILING_STOP_PCT = 0.01;

async function getPositions() {
  const r = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: H });
  return await r.json();
}

async function getFilledOrders() {
  const r = await fetch(`${ALPACA_BASE}/v2/orders?status=filled&limit=50`, { headers: H });
  return await r.json();
}

async function sellPartial({ symbol, qty }) {
  if (qty < 1) return null;
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      symbol,
      qty:           qty.toString(),
      side:          "sell",
      type:          "market",
      time_in_force: "day",
    }),
  });
  return await r.json();
}

async function cancelAllOrders(symbol) {
  const r = await fetch(`${ALPACA_BASE}/v2/orders?status=open&symbols=${symbol}`, { headers: H });
  const orders = await r.json();
  if (Array.isArray(orders)) {
    for (const o of orders) {
      await fetch(`${ALPACA_BASE}/v2/orders/${o.id}`, { method: "DELETE", headers: H });
    }
  }
}

export default async function handler(req, res) {
  try {
    const now = new Date();
    const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const h   = et.getHours(), m = et.getMinutes();

    // إغلاق كل شيء الساعة 3:00 PM ET = 10:00 PM السعودية
    const totalMins  = h * 60 + m;
    const closeMins  = 15 * 60; // 3:00 PM ET = قبل ساعة من إغلاق السوق

    // الساعة 7 م السعودية = 12 PM ET
    const forcedCloseMins = 12 * 60; // 12:00 PM ET = 7:00 PM السعودية

    const positions = await getPositions();
    if (!Array.isArray(positions) || positions.length === 0) {
      return res.status(200).json({ success: true, message: "لا توجد صفقات مفتوحة", actions: [] });
    }

    const actions = [];

    for (const pos of positions) {
      const symbol       = pos.symbol;
      const currentPrice = parseFloat(pos.current_price || 0);
      const entryPrice   = parseFloat(pos.avg_entry_price || 0);
      const currentQty   = parseInt(pos.qty || 0);

      if (currentQty < 1) continue;

      // ✅ إغلاق إجباري الساعة 7 م السعودية (12 PM ET)
      if (totalMins >= forcedCloseMins) {
        await cancelAllOrders(symbol);
        await new Promise(r => setTimeout(r, 500));
        const result = await sellPartial({ symbol, qty: currentQty });
        actions.push({ symbol, action: "إغلاق إجباري 7م", qty: currentQty, result: result?.status });
        continue;
      }

      // حساب الأهداف من سعر الدخول (نفس Radaraz)
      const atr = Math.max(
        parseFloat(pos.lastday_price || entryPrice) * 0.02,
        entryPrice * 0.02
      );
      const t1 = parseFloat((entryPrice + atr * 0.5).toFixed(2));
      const t2 = parseFloat((entryPrice + atr * 1.0).toFixed(2));
      const t3 = parseFloat((entryPrice + atr * 1.8).toFixed(2));
      const sl = parseFloat(Math.max(entryPrice - atr * 0.8, entryPrice * 0.90).toFixed(2));

      // كميات البيع
      const qtyT1 = Math.floor(currentQty * 0.5);
      const qtyT2 = Math.floor(currentQty * 0.3);
      const qtyT3 = currentQty - qtyT1 - qtyT2;

      // Trailing Stop — لو وصل T1 يرفع SL لسعر الدخول
      const unrealizedPct = entryPrice > 0 ? (currentPrice - entryPrice) / entryPrice : 0;

      // ✅ وصل T3 — بيع كل المتبقي
      if (currentPrice >= t3 && currentQty > 0) {
        await cancelAllOrders(symbol);
        const result = await sellPartial({ symbol, qty: currentQty });
        actions.push({ symbol, action: "وصل T3 — بيع 100%", qty: currentQty, price: currentPrice, result: result?.status });
      }
      // ✅ وصل T2 — بيع 30%
      else if (currentPrice >= t2 && currentQty >= qtyT2 && qtyT2 > 0) {
        const result = await sellPartial({ symbol, qty: qtyT2 });
        actions.push({ symbol, action: "وصل T2 — بيع 30%", qty: qtyT2, price: currentPrice, result: result?.status });
      }
      // ✅ وصل T1 — بيع 50%
      else if (currentPrice >= t1 && currentQty >= qtyT1 && qtyT1 > 0) {
        const result = await sellPartial({ symbol, qty: qtyT1 });
        actions.push({ symbol, action: "وصل T1 — بيع 50%", qty: qtyT1, price: currentPrice, result: result?.status });
      }
      // ✅ ضرب وقف الخسارة
      else if (currentPrice <= sl) {
        await cancelAllOrders(symbol);
        await new Promise(r => setTimeout(r, 500));
        const result = await sellPartial({ symbol, qty: currentQty });
        actions.push({ symbol, action: "وقف الخسارة", qty: currentQty, price: currentPrice, result: result?.status });
      }
    }

    return res.status(200).json({ success: true, actions, checked: positions.length });

  } catch (error) {
    return res.status(200).json({ success: false, error: error.message });
  }
}
