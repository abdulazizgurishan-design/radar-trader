// v6 — استراتيجية مطوّرة: رصد مبكر أولوية + RSI/MA + قيود مخففة
const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";

const STRATEGY = {
  minScore:     60,        // مخفف من 65 (فرص أكثر)
  minChangePct: 1,
  maxChangePct: 40,        // مرفوع من 30 (يسمح بزخم أقوى)
  minVolume:    100_000,
  maxTrades:    8,
  // فلاتر ذكية للجودة (بدل القيود العمياء)
  maxRSI:       80,        // يتجنّب الإشباع الشرائي الشديد فقط
};

// ✅ نسبة المخاطرة حسب قوة الإشارة + أولوية الرصد المبكر
const getRiskPct = (stock) => {
  // 🔍 الرصد المبكر = أفضل نقطة دخول → مخاطرة أعلى (ثقة أكبر)
  if (stock.early_watch) return 0.10;       // 10% — فرصة ذهبية مبكرة
  const score = stock.score || 0;
  if (score >= 85) return 0.08;             // 8% — إشارة قوية جداً
  if (score >= 75) return 0.06;             // 6% — إشارة جيدة
  return 0.05;                              // 5% — إشارة عادية
};

// ✅ عدد الصفقات حسب قوة السوق
const getMaxTrades = (candidates) => {
  if (candidates.length === 0) return 4;
  const withVwap = candidates.filter(s => s.vwap);
  if (withVwap.length === 0) return 6;       // مرفوع من 5 (قيود أخف)
  const aboveVwap = withVwap.filter(s => s.price > s.vwap).length;
  const ratio = aboveVwap / withVwap.length;
  if (ratio >= 0.7) return 8; // سوق قوي
  if (ratio >= 0.5) return 6; // سوق متوسط (مرفوع من 5)
  return 4;                   // سوق ضعيف (مرفوع من 3)
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
  // يقبل GET (كرونات Vercel + المجدول الخارجي) و POST (يدوي)
  // الكرونات تنادي بـ GET افتراضياً — رفضها كان يمنع كل الصفقات

  try {
    // ─── 1. نافذة التداول: 9:30 ET - 3:45 PM ET (4:30م-10:45م الرياض) ───
    const now = new Date();
    const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const h   = et.getHours(), m = et.getMinutes(), day = et.getDay();
    const totalMins = h * 60 + m;
    const isWeekend = day === 0 || day === 6;
    // 9:30 ET = 570 دقيقة | 3:45 PM ET = 945 دقيقة (نتوقف قبل الإغلاق بـ15د)
    const isMarketOpen = !isWeekend && totalMins >= 570 && totalMins < 945;

    if (!isMarketOpen) {
      return res.status(200).json({
        success: true,
        message: "البوت يعمل 4:30م-10:45م الرياض (إثنين-جمعة)",
        trades: []
      });
    }

    // ─── 2. جلب الإشارات من scan (الذي يقرأ من Radaraz Supabase) ───
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const scanRes = await fetch(`${baseUrl}/api/scan`);
    const scanData = await scanRes.json();
    const candidates = scanData.results ?? [];

    // ─── 3. فلتر الإشارات (قيود مخففة + جودة ذكية) ──────────────
    const marketMaxTrades = getMaxTrades(candidates);

    const filtered = candidates.filter(s => {
      if (s.score      < STRATEGY.minScore)     return false;
      if (s.change_pct < STRATEGY.minChangePct) return false;
      if (s.change_pct > STRATEGY.maxChangePct) return false;
      if (s.volume     < STRATEGY.minVolume)    return false;
      if (!s.levels?.t1 || !s.levels?.sl)       return false;
      // 📊 يتجنّب الإشباع الشرائي الشديد فقط (RSI > 80)
      if (s.rsi != null && s.rsi > STRATEGY.maxRSI) return false;
      // VWAP اختياري
      if (s.vwap && s.price <= s.vwap)          return false;
      return true;
    });

    // 🔍 أولوية الرصد المبكر — أفضل نقاط الدخول أولاً
    // ثم تقاطع ذهبي، ثم EP الأعلى
    filtered.sort((a, b) => {
      if (!!b.early_watch !== !!a.early_watch) return b.early_watch ? 1 : -1;
      const aGold = a.ma_signal === "تقاطع ذهبي 🌟" ? 1 : 0;
      const bGold = b.ma_signal === "تقاطع ذهبي 🌟" ? 1 : 0;
      if (bGold !== aGold) return bGold - aGold;
      return (b.score || 0) - (a.score || 0);
    });

    if (filtered.length === 0)
      return res.status(200).json({
        success: true,
        message: `لا توجد فرص — قوة السوق: ${marketMaxTrades === 8 ? "🔥 قوي" : marketMaxTrades === 5 ? "😐 متوسط" : "⚠️ ضعيف"}`,
        trades: []
      });

    const [account, openPositions] = await Promise.all([getAccount(), getOpenPositions()]);
    const balance   = parseFloat(account.equity || account.cash || 0);
    const openCount = Array.isArray(openPositions) ? openPositions.length : 0;

    if (openCount >= marketMaxTrades)
      return res.status(200).json({
        success: true,
        message: `وصلت الحد الأقصى (${marketMaxTrades} حسب قوة السوق)`,
        trades: []
      });

    const toTrade = filtered.slice(0, marketMaxTrades - openCount);
    const trades  = [];

    for (const stock of toTrade) {
      if (await hasOpenPosition(stock.symbol)) continue;

      // ✅ نسبة مخاطرة ديناميكية (الرصد المبكر أولوية)
      const riskPct = getRiskPct(stock);
      const qty = Math.floor((balance * riskPct) / stock.price);
      if (qty < 1) continue;

      // ✅ T1 = الإغلاق التلقائي عند الهدف الأول
      const takeProfit = parseFloat(stock.levels.t1.toFixed(2));
      const stopLoss   = parseFloat(stock.levels.sl.toFixed(2));

      // ✅ Bracket Order = إغلاق تلقائي عند T1 أو SL
      const order = await placeOrder({ symbol: stock.symbol, qty, stopLoss, takeProfit });

      trades.push({
        symbol:      stock.symbol,
        price:       stock.price,
        qty,
        riskPct:     `${(riskPct*100).toFixed(0)}%`,
        takeProfit,
        stopLoss,
        score:       stock.score,
        is_hot:      stock.is_hot || false,
        early_watch: stock.early_watch || false,
        ma_signal:   stock.ma_signal || null,
        rsi:         stock.rsi ?? null,
        status:      order.status ?? "error",
        error:       order.message ?? null,
      });
    }

    return res.status(200).json({
      success:        true,
      balance,
      marketStrength: marketMaxTrades === 8 ? "🔥 قوي" : marketMaxTrades === 5 ? "😐 متوسط" : "⚠️ ضعيف",
      tradesPlaced:   trades.length,
      trades,
    });

  } catch (error) {
    return res.status(200).json({ success: false, error: error.message });
  }
}
