// pages/api/trade.js — v7 (متوائم مع رادار محدّث)
// ═══════════════════════════════════════════════════════════════════
//  ✅ أولوية 🎯 الهدف ثم الرصد المبكر ثم التقاطع الذهبي ثم EP
//  ✅ حد أدنى للسعر $3 (يتجنّب gaps أسهم البنسات)
//  ✅ حجم مركز ~10% ثابت (اختبار عادل) + ميل بسيط للنخبة
//  ✅ 5–6 صفقات بالتوازي (≈50–60% منتشرة، الباقي كاش)
//  ✅ يرث أهداف/وقف الرادار (R:R مضبوطة) عبر bracket order
// ═══════════════════════════════════════════════════════════════════

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";

const STRATEGY = {
  minScore:     60,        // يطابق رادارك (يحفظ ≥60 بعد الفلترة)
  minPrice:     3,         // 🆕 حد أدنى — يتجنّب gaps البنسات
  minChangePct: 1,
  maxChangePct: 40,        // يطابق سقف الرادار
  minVolume:    100_000,
  maxRSI:       78,        // يتجنّب الإشباع الشرائي الشديد
  skipChasers:  true,      // 🆕 يتجاوز إشارات «ملاحقة/غير مؤكد» و«هابط» من البنية (متوائم مع radaraz)
};

// حجم المركز ~10% (ثابت للاختبار العادل) + ميل بسيط للقناعة الأعلى
const getRiskPct = (s) => {
  if (s.is_target)   return 0.12;   // 🎯 الهدف — أعلى قناعة
  if (s.early_watch) return 0.11;   // 🔍 رصد مبكر
  return 0.10;                      // الباقي — حجم ثابت
};

// 5–6 صفقات بالتوازي — حماية رأس المال (40%+ كاش دائماً)
const getMaxTrades = (candidates) => {
  if (!candidates.length) return 5;
  const strong = candidates.filter(s => s.is_target || s.early_watch).length;
  if (strong >= 3) return 6;   // فرص نخبة كثيرة
  return 5;
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
  try {
    // ─── 1. نافذة التداول: 9:50 ET - 3:00 PM ET (4:50م-10:00م الرياض صيفاً) ───
    const now = new Date();
    const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const h   = et.getHours(), m = et.getMinutes(), day = et.getDay();
    const totalMins = h * 60 + m;
    const isWeekend = day === 0 || day === 6;
    // 9:50 ET = 590 دقيقة (نتجنّب فوضى الافتتاح) | 3:00 PM ET = 900 (نوقف الدخول مبكراً قبل الإغلاق)
    const isMarketOpen = !isWeekend && totalMins >= 590 && totalMins < 900;

    if (!isMarketOpen) {
      return res.status(200).json({ success: true, message: "خارج ساعات التداول", trades: [] });
    }

    // ─── 2. جلب الإشارات من scan (يقرأ Radaraz Supabase) ───
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const scanRes  = await fetch(`${baseUrl}/api/scan`);
    const scanData = await scanRes.json();
    const candidates = scanData.results ?? [];

    // ─── 3. فلتر الجودة (متوائم مع الرادار) ───
    const filtered = candidates.filter(s => {
      if (s.score      < STRATEGY.minScore)     return false;
      if (s.price      < STRATEGY.minPrice)     return false;   // 🆕 حد $3
      if (s.change_pct < STRATEGY.minChangePct) return false;
      if (s.change_pct > STRATEGY.maxChangePct) return false;
      if (s.volume     < STRATEGY.minVolume)    return false;
      if (!s.levels?.t1 || !s.levels?.sl)       return false;
      if (s.rsi != null && s.rsi > STRATEGY.maxRSI) return false;
      if (s.vwap && s.price <= s.vwap)          return false;
      // 🆕 فلتر البنية: يتجاوز الملاحقة/الهابط (يتداول الجواهر فقط مثل radaraz)
      if (STRATEGY.skipChasers && s.structure && typeof s.structure.flag === "string") {
        const f = s.structure.flag;
        if (f.indexOf("ملاحقة") >= 0 || f.indexOf("غير مؤكد") >= 0 || f.indexOf("هابط") >= 0) return false;
      }
      return true;
    });

    // 🎯 أولوية: الهدف → دخول صحيح (بنية) → رصد مبكر → تقاطع ذهبي → EP الأعلى
    const validEntry = x => x.structure && typeof x.structure.flag === "string" && x.structure.flag.indexOf("صحيح") >= 0;
    filtered.sort((a, b) => {
      if (!!b.is_target   !== !!a.is_target)   return b.is_target   ? 1 : -1;
      if (validEntry(b)   !== validEntry(a))   return validEntry(b) ? 1 : -1;
      if (!!b.early_watch !== !!a.early_watch) return b.early_watch ? 1 : -1;
      const aGold = a.ma_signal === "تقاطع ذهبي 🌟" ? 1 : 0;
      const bGold = b.ma_signal === "تقاطع ذهبي 🌟" ? 1 : 0;
      if (bGold !== aGold) return bGold - aGold;
      return (b.score || 0) - (a.score || 0);
    });

    const marketMaxTrades = getMaxTrades(candidates);

    if (filtered.length === 0)
      return res.status(200).json({ success: true, message: "لا توجد فرص مطابقة", trades: [] });

    const [account, openPositions] = await Promise.all([getAccount(), getOpenPositions()]);
    const balance   = parseFloat(account.equity || account.cash || 0);
    const openCount = Array.isArray(openPositions) ? openPositions.length : 0;

    if (openCount >= marketMaxTrades)
      return res.status(200).json({ success: true, message: `وصلت الحد (${marketMaxTrades})`, trades: [] });

    const toTrade = filtered.slice(0, marketMaxTrades - openCount);
    const trades  = [];

    for (const stock of toTrade) {
      if (await hasOpenPosition(stock.symbol)) continue;

      const riskPct = getRiskPct(stock);
      const qty = Math.floor((balance * riskPct) / stock.price);
      if (qty < 1) continue;

      const takeProfit = parseFloat(stock.levels.t1.toFixed(2));
      const stopLoss   = parseFloat(stock.levels.sl.toFixed(2));

      const order = await placeOrder({ symbol: stock.symbol, qty, stopLoss, takeProfit });

      trades.push({
        symbol:      stock.symbol,
        price:       stock.price,
        qty,
        allocationPct: `${(riskPct * 100).toFixed(0)}%`,
        takeProfit,
        stopLoss,
        score:       stock.score,
        is_target:   stock.is_target || false,
        early_watch: stock.early_watch || false,
        ma_signal:   stock.ma_signal || null,
        rsi:         stock.rsi ?? null,
        status:      order.status ?? "error",
        error:       order.message ?? null,
      });
    }

    return res.status(200).json({
      success:      true,
      balance,
      maxTrades:    marketMaxTrades,
      tradesPlaced: trades.length,
      trades,
    });

  } catch (error) {
    return res.status(200).json({ success: false, error: error.message });
  }
}
