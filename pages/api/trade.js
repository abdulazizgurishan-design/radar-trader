// =============================================
// /api/trade.js — التداول التلقائي مع Alpaca
// Paper Trading (ديمو — لا فلوس حقيقية)
// =============================================

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets"; // ديمو — غيّر لـ api.alpaca.markets للحقيقي

// =============================================
// ⚙️ استراتيجيتك — عدّل هنا فقط
// =============================================
const STRATEGY = {
  minScore:        85,      // أقل score للدخول
  maxChangePct:    6,       // أقصى نسبة ارتفاع للدخول — فوقها فات القطار
  minChangePct:    2,       // أقل نسبة ارتفاع للدخول
  minVolume:       300_000, // أقل حجم تداول
  riskPerTrade:    0.03,    // 3% من المحفظة لكل صفقة
  maxOpenTrades:   5,       // أقصى صفقات مفتوحة في نفس الوقت
  onlyAboveVWAP:   true,    // شرط: السعر فوق VWAP
  minRR:           1.5,     // أقل نسبة ربح/خسارة
  takeProfitPct:   0.025,   // الخروج بعد +2.5% من سعر الدخول
};

// =============================================
// Helper: جلب رصيد الحساب
// =============================================
async function getAccountBalance() {
  const res = await fetch(`${ALPACA_BASE}/v2/account`, {
    headers: {
      "APCA-API-KEY-ID":     ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    },
  });
  const data = await res.json();
  return parseFloat(data.equity || data.cash || 0);
}

// =============================================
// Helper: جلب الصفقات المفتوحة حالياً
// =============================================
async function getOpenPositions() {
  const res = await fetch(`${ALPACA_BASE}/v2/positions`, {
    headers: {
      "APCA-API-KEY-ID":     ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    },
  });
  return await res.json();
}

// =============================================
// Helper: إرسال أمر شراء
// =============================================
async function placeOrder({ symbol, qty, stopLoss, takeProfit }) {
  const body = {
    symbol,
    qty:        qty.toString(),
    side:       "buy",
    type:       "market",
    time_in_force: "day",
    order_class: "bracket",
    stop_loss:   { stop_price: stopLoss.toFixed(2) },
    take_profit: { limit_price: takeProfit.toFixed(2) },
  };

  const res = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST",
    headers: {
      "APCA-API-KEY-ID":     ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
      "Content-Type":        "application/json",
    },
    body: JSON.stringify(body),
  });

  return await res.json();
}

// =============================================
// Helper: فحص هل السهم عنده مركز مفتوح
// =============================================
async function hasOpenPosition(symbol) {
  try {
    const res = await fetch(`${ALPACA_BASE}/v2/positions/${symbol}`, {
      headers: {
        "APCA-API-KEY-ID":     ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// =============================================
// Handler الرئيسي
// =============================================
export default async function handler(req, res) {
  // فقط POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1. جلب نتائج الرادار
    const scanRes = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/scan`);
    const scanData = await scanRes.json();
    const candidates = scanData.results ?? [];

    // 2. فلترة بناءً على الاستراتيجية
    const filtered = candidates.filter(s =>
      s.score          >= STRATEGY.minScore      &&
      s.change_pct     <= STRATEGY.maxChangePct  &&
      s.change_pct     >= STRATEGY.minChangePct  &&
      s.volume         >= STRATEGY.minVolume      &&
      parseFloat(s.rr) >= STRATEGY.minRR          &&
      (!STRATEGY.onlyAboveVWAP || s.price > s.vwap)
    );

    if (filtered.length === 0) {
      return res.status(200).json({ success: true, message: "لا توجد فرص تستوفي الشروط", trades: [] });
    }

    // 3. جلب رصيد الحساب والمراكز المفتوحة
    const [balance, openPositions] = await Promise.all([
      getAccountBalance(),
      getOpenPositions(),
    ]);

    const openCount = Array.isArray(openPositions) ? openPositions.length : 0;

    if (openCount >= STRATEGY.maxOpenTrades) {
      return res.status(200).json({
        success: true,
        message: `وصلت الحد الأقصى للصفقات المفتوحة (${STRATEGY.maxOpenTrades})`,
        trades: [],
      });
    }

    const availableSlots = STRATEGY.maxOpenTrades - openCount;
    const toTrade = filtered.slice(0, availableSlots);
    const trades = [];

    for (const stock of toTrade) {
      // تحقق ما في مركز مفتوح لنفس السهم
      const alreadyOpen = await hasOpenPosition(stock.symbol);
      if (alreadyOpen) continue;

      // حساب الكمية بناءً على نسبة المخاطرة
      const tradeAmount = balance * STRATEGY.riskPerTrade;
      const qty = Math.floor(tradeAmount / stock.price);
      if (qty < 1) continue;

      // إرسال الأمر مع وقف الخسارة والهدف الأول
      const order = await placeOrder({
        symbol:     stock.symbol,
        qty,
        stopLoss:   stock.levels.sl,
        takeProfit: parseFloat((stock.price * (1 + STRATEGY.takeProfitPct)).toFixed(2)),
      });

      trades.push({
        symbol:    stock.symbol,
        price:     stock.price,
        qty,
        stopLoss:  stock.levels.sl,
        takeProfit: parseFloat((stock.price * (1 + STRATEGY.takeProfitPct)).toFixed(2)),
        score:     stock.score,
        orderId:   order.id ?? null,
        status:    order.status ?? "error",
        error:     order.message ?? null,
      });
    }

    return res.status(200).json({
      success: true,
      balance,
      openBefore: openCount,
      tradesPlaced: trades.length,
      trades,
    });

  } catch (error) {
    return res.status(200).json({ success: false, error: error.message });
  }
}
