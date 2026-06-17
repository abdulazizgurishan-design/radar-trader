// pages/api/scan.js — STANDALONE EDITION v3 (Multi-Timeframe + MACD + News + Target)
// ═══════════════════════════════════════════════════════════════════
//  مسح مستقل تماماً — صفر اعتماد على جداول أخرى
//  ─────────────────────────────────────────────────────────────────
//  ترقيات هذا الإصدار:
//   ✅ المتوسطات/RSI/ATR/MACD حسب نوع الصفقة:
//        ⚡ مضاربة → فريم 60 دقيقة (سريع، يناسب اليوم)
//        📈 استثمار → فريم يومي (يناسب المستثمر)
//   ✅ إضافة MA50 + MACD(12,26,9) لتأكيد الاتجاه
//   ✅ المتوسطات صارت "بوابة" (gate) لا مجرد بونص
//   ✅ غربال صارم للأسهم أقل من $1
//   ✅ طبقة الأخبار اللحظية (Polygon News) — تفصل الكاتشي عن الوهمي
//   ✅ شارة 🎯 "الهدف" — التقاء كامل على الفريمين (نخبة)
//   ✅ أهداف واقعية (مضاربة على ATR 60د = أضيق وأقرب للتحقق)
//   ✅ إصلاح bug قسم الاستثمار (كان يستخدم "قيادي" بدل "استثمار")
//
//  ⚠️ ملاحظة توافق: شكل الرد للواجهة لم يتغيّر (نفس الحقول والأقسام).
//     شارة "الهدف" تُعرض عبر حقل signal الموجود أصلاً — لا تعديل واجهة.
//  ⚠️ هذا الإصدار يحفظ عمودين جديدين (is_target, news_age_h) — لازم تضيفهما
//     في جدول signals أولاً (SQL في الأسفل) قبل الرفع، وإلا يفشل الحفظ.
// ═══════════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 };

const POLYGON_KEY  = process.env.POLYGON_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

// ─── إعدادات الفلترة ───────────────────────────────────────────────
const FILTER = {
  MIN_PRICE:      0.30,
  MAX_PRICE:      500,
  MIN_VOLUME:     300_000,
  MIN_CHANGE:     3,
  MAX_CHANGE:     40,            // فوق 40% = دخول متأخر/pump → استبعاد نهائي
  MAX_RVOL:       100,
  MAX_RESULTS:    60,
  HEAVY_LIMIT:    30,            // عدد الأسهم للتحليل العميق (التزامن محكوم بالدفعات)
  SAVE_MIN_EP:    60,            // رفعناه من 50 → 60 (جودة أعلى للحفظ والبوت)
  STRICT_PRICE:   1.00,          // تحت هذا السعر = غربال صارم
};

// ─── مزج البنية (Swing) في الاختيار — كله قابل للضبط ───────────────
// الهدف: نعرض دخولات صحيحة، لا كل سهم مرتفع.
const STRUCT = {
  MIN_RR:        1.5,   // أدنى عائد/مخاطرة بنيوي ليُعدّ "دخول صحيح"
  MAX_POS:       0.66,  // أقصى موضع داخل المدى (0=دعم،1=مقاومة) ليُعدّ دخولاً مبكراً
  BONUS_VALID:   7,     // مكافأة الدخول الصحيح (يرفعه للأعلى)
  BONUS_OK:      2,     // مكافأة المقبول
  PENALTY_LATE:  6,     // خصم الملاحقة/غير المؤكد (يُنزّله)
  PENALTY_BADRR: 4,     // خصم إضافي لـ R:R < 1
  // إسقاط الملاحقة الواضحة فقط: سهم ارتفع كثير + دخوله سيء
  DROP_LATE:     true,  // فعّل/عطّل الإسقاط
  DROP_CHANGE:   10,    // لا نُسقط إلا إذا ارتفع أكثر من هذا
  DROP_POS:      0.80,  // + قريب من القمة (دخول متأخر)
  // 💎 حارس الجوهرة: لا نعرض سهماً هابطاً بلا تأكيد ارتداد
  STRICT_GEMS:   true,  // اعرض فقط: مؤكد صاعد أو ارتداد واضح
};

// ════════════════ أدوات المؤشرات ════════════════

function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

// سلسلة EMA كاملة (نحتاجها للماكد)
function emaSeries(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(period - 1).fill(null);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function calcSMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ATR14 بتمهيد Wilder (مطابق TradingView)
function calcATR14(bars) {
  if (!bars || bars.length < 15) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < 14) return null;
  let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
  return atr;
}

// RSI14 بتمهيد Wilder
function calcRSI14(bars) {
  if (!bars || bars.length < 15) return null;
  const closes = bars.map(b => b.c);
  let gains = 0, losses = 0;
  for (let i = 1; i <= 14; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / 14, avgLoss = losses / 14;
  for (let i = 15; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * 13 + (diff >= 0 ? diff : 0)) / 14;
    avgLoss = (avgLoss * 13 + (diff < 0 ? -diff : 0)) / 14;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// MACD(12,26,9) — يرجع حالة الاتجاه
function calcMACD(closes) {
  if (!closes || closes.length < 35) return null;
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] == null || ema26[i] == null) continue;
    macdLine.push(ema12[i] - ema26[i]);
  }
  if (macdLine.length < 10) return null;
  const sig = emaSeries(macdLine, 9);
  const macdLast = macdLine[macdLine.length - 1];
  const sigLast  = sig[sig.length - 1];
  if (macdLast == null || sigLast == null) return null;
  const hist = macdLast - sigLast;
  const macdPrev = macdLine[macdLine.length - 2];
  const sigPrev  = sig[sig.length - 2];
  const histPrev = (macdPrev != null && sigPrev != null) ? macdPrev - sigPrev : null;
  return {
    bullish: macdLast > sigLast && hist > 0,
    rising:  histPrev != null ? hist > histPrev : false,
  };
}

function calcSupportResistance(bars, price) {
  if (!bars || bars.length < 10) return { resistances: [], supports: [] };
  const recent = bars.slice(-20);
  const resistances = [...new Set(recent.map(b => b.h))].filter(h => h > price).sort((a, b) => a - b);
  const supports    = [...new Set(recent.map(b => b.l))].filter(l => l < price).sort((a, b) => b - a);
  return { resistances, supports };
}

function calcFibTargets(bars, price) {
  if (!bars || bars.length < 10) return [];
  const recent = bars.slice(-20);
  const swingLow  = Math.min(...recent.map(b => b.l));
  const swingHigh = Math.max(...recent.map(b => b.h));
  const range = swingHigh - swingLow;
  if (range <= 0) return [];
  return [swingHigh + range * 0.272, swingHigh + range * 0.618, swingHigh + range * 1.0].filter(f => f > price);
}

// ─── أهداف الاستثمار (ATR أوسع — صبر) ─────────────────────────────
function calcSmartLevels(price, bars) {
  const atr = calcATR14(bars) || price * 0.05;
  const { resistances, supports } = calcSupportResistance(bars, price);
  const fibs = calcFibTargets(bars, price);

  // الوقف أولاً
  const atrSL = price - atr * 1.5;
  const supportSL = supports[0] ? supports[0] * 0.985 : atrSL;
  const sl = Math.max(Math.min(atrSL, supportSL), price * 0.88);
  const risk = price - sl;

  const atrT1 = price + atr * 1.0, atrT2 = price + atr * 2.0, atrT3 = price + atr * 3.0;
  let t1 = resistances[0] && resistances[0] < atrT1 * 1.3 ? Math.min(resistances[0], atrT1 * 1.3) : atrT1;
  t1 = Math.max(t1, price * 1.03, price + risk * 1.0);  // T1 لا يقل عن 1:1
  let t2 = resistances[1] && resistances[1] > t1 ? Math.max(atrT2, Math.min(resistances[1], atrT2 * 1.2)) : atrT2;
  t2 = Math.max(t2, t1 * 1.04);
  let t3 = fibs[1] && fibs[1] > t2 ? Math.max(atrT3, Math.min(fibs[1], atrT3 * 1.3)) : atrT3;
  t3 = Math.max(t3, t2 * 1.05);

  const f2 = n => +n.toFixed(2), pct = n => +(((n - price) / price) * 100).toFixed(2);
  return {
    t1: f2(t1), t2: f2(t2), t3: f2(t3), sl: f2(sl),
    t1Pct: pct(t1), t2Pct: pct(t2), t3Pct: pct(t3), slPct: pct(sl),
    risk: f2(price - sl), atr14: f2(atr),
  };
}

// ─── أهداف المضاربة (ATR 60د = أضيق وأقرب للتحقق) ─────────────────
// + إصلاح R:R: تضييق الوقف حتى لا تكون المخاطرة ضعف الهدف
function calcScalpLevels(price, bars) {
  const atr = calcATR14(bars) || price * 0.03;
  const { supports } = calcSupportResistance(bars, price);

  // الوقف أولاً: ATR×0.8 أو دعم قريب، بحد أقصى -4%
  const atrSL = price - atr * 0.8;
  const supportSL = supports[0] ? supports[0] * 0.992 : atrSL;
  const sl = Math.max(Math.min(atrSL, supportSL), price * 0.96);
  const risk = price - sl;

  // أهداف قريبة واقعية — لكن نضمن R:R ≥ 1.3 على T1 (ربط الهدف بالمخاطرة)
  let t1 = Math.max(price + atr * 0.6, price + risk * 1.3, price * 1.015);
  let t2 = Math.max(price + atr * 1.1, t1 + risk * 0.8, t1 * 1.02);
  let t3 = Math.max(price + atr * 1.7, t2 + risk * 0.8, t2 * 1.02);

  const f2 = n => +n.toFixed(2), pct = n => +(((n - price) / price) * 100).toFixed(2);
  return {
    t1: f2(t1), t2: f2(t2), t3: f2(t3), sl: f2(sl),
    t1Pct: pct(t1), t2Pct: pct(t2), t3Pct: pct(t3), slPct: pct(sl),
    risk: f2(price - sl), atr14: f2(atr),
  };
}

// أهداف تقريبية (fallback عند غياب الشموع)
function calcLevels(s) {
  const price = s.price;
  const tr  = Math.max(s.high - s.low, Math.abs(s.high - s.prevClose), Math.abs(s.low - s.prevClose));
  const atr = Math.max(tr, price * 0.02);
  const t1 = +(price + atr * 0.5).toFixed(2), t2 = +(price + atr * 1.0).toFixed(2), t3 = +(price + atr * 1.8).toFixed(2);
  const sl = +Math.max(price - atr * 0.8, price * 0.92).toFixed(2);
  return {
    t1, t2, t3, sl,
    t1Pct: +(((t1 - price) / price) * 100).toFixed(2), t2Pct: +(((t2 - price) / price) * 100).toFixed(2),
    t3Pct: +(((t3 - price) / price) * 100).toFixed(2), slPct: +(((sl - price) / price) * 100).toFixed(2),
    risk: +(price - sl).toFixed(2),
  };
}

// ════════════════ محرّك مستويات البنية (Swing + Fibonacci) ════════════════
// أسلوب "الصندوق الذهبي": ارتكاز/دخول/تأكيد/وقف/مقاومة + أهداف فيبوناتشي تصاعدية.
// إضافي بالكامل — لا يلمس s.levels (ATR). يُرفق كـ s.structure.
function findPivots(bars, w = 2) {
  const highs = [], lows = [];
  for (let i = w; i < bars.length - w; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
    }
    if (isHigh) highs.push(bars[i].h);
    if (isLow)  lows.push(bars[i].l);
  }
  return { highs, lows };
}

function computeStructureLevels(price, bars) {
  if (!bars || bars.length < 12 || !price) return null;
  const recent = bars.slice(-60);
  const { highs, lows } = findPivots(recent, 2);
  // ملاحظة: لا نخرج لو ما فيه pivots — نعتمد على الحد الأدنى/الأقصى الأخير كبديل
  // (الأسهم الصاعدة بقوة غالباً بلا قيعان/قمم تأرجح واضحة)

  // الدعم = أعلى قاع تأرجح تحت السعر | المقاومة = أدنى قمة تأرجح فوق السعر
  // البديل (بلا pivots) = حدود آخر 12 شمعة فقط — يبقي البنية قريبة وواقعية
  const recLows  = recent.slice(-12).map(b => b.l);
  const recHighs = recent.slice(-12).map(b => b.h);
  const lowsBelow  = lows.filter(l => l < price);
  const highsAbove = highs.filter(h => h > price);
  const support    = lowsBelow.length  ? Math.max(...lowsBelow)  : Math.min(...recLows);
  const resistance = highsAbove.length ? Math.min(...highsAbove) : Math.max(...recHighs);

  const swingHigh = Math.max(resistance, ...recent.map(b => b.h));
  const swingLow  = support;
  const range = Math.max(swingHigh - swingLow, price * 0.005);

  // تأكيد الاتجاه = أعلى قمة تأرجح كُسرت (تحت/عند السعر)
  const highsBelow = highs.filter(h => h <= price * 1.001);
  const confirm = highsBelow.length ? Math.max(...highsBelow) : support + range * 0.5;
  const trendUp = price >= confirm;

  // دخول عند الارتداد (38.2% من الساق الصاعدة) + وقف تحت الارتكاز
  // الوقف = نسبة من مدى التأرجح (يتأقلم مع تذبذب كل سهم بدل نسبة ثابتة)
  const buffer = Math.max(range * 0.10, price * 0.0005);
  const entry = support + (price - support) * 0.382;
  const stop  = support - buffer;
  const riskEntry = entry - stop;

  // أهداف فيبوناتشي تصاعدية (مضمونة الترتيب وفوق السعر)
  let t1   = (resistance > price * 1.005) ? resistance : swingHigh + range * 0.272;
  t1 = Math.max(t1, price * 1.005);
  let t2   = Math.max(swingHigh + range * 0.272, t1 * 1.003);   // 1.272
  let t3   = Math.max(swingHigh + range * 0.618, t2 * 1.003);   // 1.618
  let liq  = Math.max(swingHigh + range * 1.0,   t3 * 1.003);   // 2.0  — تفريغ سيولة
  let peak = Math.max(swingHigh + range * 1.618, liq * 1.003);  // 2.618 — القمة

  const f2 = n => +Number(n).toFixed(2);
  const pct = n => +(((n - price) / price) * 100).toFixed(2);
  const rr = riskEntry > 0 ? +(((t1 - entry) / riskEntry).toFixed(2)) : null;

  return {
    trend: trendUp ? "صاعد مؤكد ✅" : "ينتظر تأكيد ⏳",
    support: f2(support),       supportPct: pct(support),
    entry: f2(entry),           entryPct: pct(entry),
    confirm: f2(confirm),       confirmPct: pct(confirm),
    stop: f2(stop),             stopPct: pct(stop),
    resistance: f2(resistance), resistancePct: pct(resistance),
    t1: f2(t1),   t1Pct: pct(t1),
    t2: f2(t2),   t2Pct: pct(t2),
    t3: f2(t3),   t3Pct: pct(t3),
    liquidity: f2(liq),  liquidityPct: pct(liq),
    peak: f2(peak),      peakPct: pct(peak),
    rr,
  };
}

// ════════════════ EP MODEL ════════════════
function calcEP(s) {
  let t = 0;
  const W = { rvol: 30, change: 25, gap: 15, vwap: 10, range: 10, volume: 10 };
  const rv = s.rvol || 0;
  t += rv >= 50 ? W.rvol * 1.15 : rv >= 20 ? W.rvol * 1.1 : rv >= 10 ? W.rvol
     : rv >= 5 ? W.rvol * .80 : rv >= 3 ? W.rvol * .60 : rv >= 2 ? W.rvol * .40 : rv >= 1.5 ? W.rvol * .20 : 0;
  const ch = s.changePct || 0;
  t += ch >= 10 && ch <= 30 ? W.change : ch >= 5 && ch < 10 ? W.change * .70 : ch >= 3 && ch < 5 ? W.change * .45
     : ch > 30 && ch <= 50 ? W.change * .85 : ch > 50 && ch <= 80 ? W.change * .65
     : ch > 80 && ch <= 120 ? W.change * .45 : ch > 120 ? W.change * .30 : 0;
  const g = s.gapPct || 0;
  t += g >= 20 ? W.gap * 1.2 : g >= 10 ? W.gap : g >= 5 ? W.gap * .60 : g >= 2 ? W.gap * .30 : 0;
  if (s.price > s.vwap && s.vwap > 0) t += W.vwap;
  else if (s.vwap > 0 && s.price >= s.vwap * 0.99) t += W.vwap * 0.5;
  if (s.high > s.low) {
    const pos = (s.price - s.low) / (s.high - s.low);
    t += pos >= 0.8 ? W.range : pos >= 0.6 ? W.range * .6 : pos >= 0.4 ? W.range * .3 : 0;
  }
  t += s.volume >= 5e6 ? W.volume : s.volume >= 2e6 ? W.volume * .7 : s.volume >= 1e6 ? W.volume * .5 : s.volume >= 5e5 ? W.volume * .3 : 0;
  if (rv >= 10 && ch >= 10) t += 8;
  if (rv >= 50) t += 5;
  let ep = Math.min(Math.round((t / Object.values(W).reduce((a, b) => a + b, 0)) * 100), 99);
  if (ch > 30 && ch <= 50) ep -= 4;
  else if (ch > 50 && ch <= 80) ep -= 8;
  else if (ch > 80 && ch <= 120) ep -= 12;
  else if (ch > 120) ep -= 16;
  return Math.max(0, Math.min(ep, 99));
}

// ════════════════ جلب السوق ════════════════
// تنفيذ على دفعات محكومة التزامن (يمنع إغراق Polygon بـ 70 طلب دفعة واحدة)
async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

async function fetchFullMarket() {
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${POLYGON_KEY}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) throw new Error(`Polygon ${res.status}`);
    const data = await res.json();
    return data.tickers || [];
  } catch (err) { clearTimeout(id); throw err; }
}

// جلب شموع بفريم محدد (60 دقيقة للمضاربة / يومي للاستثمار)
async function fetchAggs(symbol, multiplier, timespan, lookbackDays, limit) {
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const url  = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=${limit}&apiKey=${POLYGON_KEY}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.results && data.results.length) ? data.results : null;
  } catch { clearTimeout(id); return null; }
}

// إعداد الفريم حسب نوع الصفقة
function frameFor(style) {
  return style === "مضاربة"
    ? { mult: 60, span: "minute", days: 30,  limit: 600 }  // 60 دقيقة
    : { mult: 1,  span: "day",    days: 140, limit: 200 }; // يومي
}

// حساب كل المؤشرات من مجموعة شموع
function computeTech(bars) {
  if (!bars || bars.length < 21) return null;
  const closes = bars.map(b => b.c);
  const price = closes[closes.length - 1];
  const sma9 = calcSMA(closes, 9), sma21 = calcSMA(closes, 21), sma50 = calcSMA(closes, 50);
  const ema9 = calcEMA(closes, 9), ema21 = calcEMA(closes, 21);
  const rsiRaw = calcRSI14(bars), atr = calcATR14(bars), macd = calcMACD(closes);

  let maSignal = null, maBonus = 0;
  if (sma9 && sma21 && sma9 > sma21) { maBonus += 6; maSignal = "صاعد"; }
  if (ema9 && ema21 && ema9 > ema21) { maBonus += 5; maSignal = maSignal === "صاعد" ? "صاعد قوي ⚡" : "EMA صاعد"; }
  if (sma21 && price > sma21) maBonus += 3;
  if (sma50 && price > sma50) maBonus += 2;
  const sma9p = calcSMA(closes.slice(0, -3), 9), sma21p = calcSMA(closes.slice(0, -3), 21);
  const freshGolden = !!(sma9p && sma21p && sma9p <= sma21p && sma9 > sma21);
  if (freshGolden) { maBonus += 6; maSignal = "تقاطع ذهبي 🌟"; }

  let recentMaxJump = 0;
  const lastN = closes.slice(-8);
  for (let i = 1; i < lastN.length; i++) {
    const j = ((lastN[i] - lastN[i - 1]) / lastN[i - 1]) * 100;
    if (j > recentMaxJump) recentMaxJump = j;
  }

  return {
    price, atr, macd,
    rsi: rsiRaw != null ? Math.round(rsiRaw) : null,
    maSignal, maBonus: Math.min(maBonus, 20),
    priceAboveMA21: !!(sma21 && price > sma21),
    aligned: !!(sma9 && sma21 && price > sma21 && sma9 > sma21), // اصطفاف صاعد كامل
    freshGolden,
    recentMaxJump: +recentMaxJump.toFixed(1),
    bars,
  };
}

// ════════════════ الأخبار اللحظية ════════════════
async function fetchNews(symbol) {
  const url = `https://api.polygon.io/v2/reference/news?ticker=${symbol}&limit=3&order=desc&sort=published_utc&apiKey=${POLYGON_KEY}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return { ageH: null, sentiment: null, hasNews: false };
    const data = await res.json();
    const results = data.results || [];
    if (!results.length) return { ageH: null, sentiment: null, hasNews: false };
    const latest = results[0];
    const ageH = latest.published_utc ? (Date.now() - new Date(latest.published_utc).getTime()) / 3600000 : null;
    let sentiment = null;
    if (Array.isArray(latest.insights)) {
      const ins = latest.insights.find(i => i.ticker === symbol);
      if (ins) sentiment = ins.sentiment;
    }
    return { ageH: ageH != null ? +ageH.toFixed(1) : null, sentiment, hasNews: true };
  } catch { clearTimeout(id); return { ageH: null, sentiment: null, hasNews: false }; }
}

// ════════════════ الحفظ في Supabase (UPSERT — يمنع التكرار) ════════
// المفتاح الفريد: (symbol, signal_date).
// ignore-duplicates: أول رصد للسهم في اليوم يُحفظ ويثبت (سعر الدخول/الأهداف/الوقت)،
// والمسحات اللاحقة لنفس السهم في نفس اليوم تُتجاهل — صفر تكرار + تجميد عند أول إشارة.
async function saveSignals(signals) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !signals.length) return { saved: 0, skipped: true };
  // تاريخ الإشارة بتوقيت السوق (ET) — ثابت لكل صفوف هذا المسح
  const sigDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    .toISOString().split("T")[0];
  const nowISO = new Date().toISOString();
  const rows = signals.map(s => ({
    symbol: s.symbol, signal_date: sigDate, type: s.type, entry_price: s.price, change_pct: s.changePct,
    volume: Math.round(s.volume), rvol: s.rvol, ep: s.ep, score: s.ep, is_hot: s.is_hot,
    target1: s.levels.t1, target2: s.levels.t2, target3: s.levels.t3, stop_loss: s.levels.sl,
    status: "OPEN", ma_signal: s.ma_signal || null, rsi: s.rsi ?? null,
    atr14: s.levels?.atr14 ?? null, early_watch: s.early_watch || false,
    is_target: s.is_target || false, news_age_h: s.news_age_h ?? null,
    created_at: nowISO,   // وقت أول رصد — يثبت (يُكتب مرة واحدة عند أول إدخال)
  }));
  try {
    // on_conflict على (symbol, signal_date) + ignore-duplicates = أول رصد يثبت، التكرار يُتجاهل
    const res = await fetch(`${SUPABASE_URL}/rest/v1/signals?on_conflict=symbol,signal_date`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    return { saved: res.ok ? rows.length : 0, status: res.status };
  } catch (err) { return { saved: 0, error: err.message }; }
}

// ════════════════ MAIN HANDLER ════════════════
export default async function handler(req, res) {
  const t0 = Date.now();
  const isSubscriber = req.query.sub === "1";

  try {
    const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const etH = etNow.getHours(), etM = etNow.getMinutes();
    const isPreMarket = (etH >= 4 && (etH < 9 || (etH === 9 && etM < 30)));
    const minVolume = isPreMarket ? 50_000 : FILTER.MIN_VOLUME;

    // 1) جلب كامل السوق
    const allTickers = await fetchFullMarket();
    const t1 = Date.now();

    // 2) فلترة أساسية
    const candidates = [];
    for (const tk of allTickers) {
      const day = tk.day || {}, prev = tk.prevDay || {}, min = tk.min || {};
      const price  = tk.lastTrade?.p || min.c || day.c || prev.c || 0;
      const volume = day.v || min.av || 0;
      if (!tk.ticker || tk.ticker.includes(".")) continue;
      if (!/^[A-Z]{1,6}$/.test(tk.ticker)) continue;
      if (price < FILTER.MIN_PRICE || price > FILTER.MAX_PRICE) continue;
      if (volume < minVolume) continue;
      const prevClose = prev.c || day.o || price;
      let changePct = tk.todaysChangePerc;
      if (changePct == null || changePct === 0) changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
      if (changePct < FILTER.MIN_CHANGE) continue;
      if (changePct > FILTER.MAX_CHANGE) continue;
      const gapPct = (day.o && prevClose) ? ((day.o - prevClose) / prevClose) * 100 : 0;
      let rvol = (prev.v && prev.v > 0) ? +(volume / prev.v).toFixed(1) : 0;
      if (rvol > FILTER.MAX_RVOL) continue;
      candidates.push({
        symbol: tk.ticker, price: +price.toFixed(2), open: day.o || price, volume,
        vwap: day.vw || min.vw || 0, high: day.h || min.h || price, low: day.l || min.l || price,
        prevClose, changePct: +changePct.toFixed(2), gapPct: +gapPct.toFixed(2), rvol,
      });
    }

    // 3) EP + تصنيف نوع الصفقة
    const scored = candidates.map(s => {
      const ep = calcEP(s);
      const levels = calcLevels(s);
      const is_hot = ep >= 75 && s.rvol >= 10 && s.changePct >= 10;
      const dollarVolume = s.price * s.volume;
      const isScalp  = s.changePct >= 5 && s.rvol >= 5;
      const isInvest = s.price >= 20 && dollarVolume >= 100_000_000 && s.changePct <= 15;
      const type = isScalp ? "مضاربة" : (isInvest ? "استثمار" : "مضاربة");
      return { ...s, ep, levels, is_hot, type, trade_style: type, dollarVolume,
        signal: ep >= 80 ? "💥 انفجاري" : ep >= 60 ? "🔥 عالي" : "👀 مراقبة" };
    });

    // 4) ترتيب أولي
    scored.sort((a, b) => (b.is_hot !== a.is_hot) ? (b.is_hot ? 1 : -1) : (b.ep !== a.ep) ? b.ep - a.ep : b.rvol - a.rvol);

    // 5) أعلى N للتحليل الثقيل
    const top = scored.slice(0, FILTER.HEAVY_LIMIT);

    // 5.5) التحليل الفني متعدّد الفريمات + الأخبار + البوابة + الهدف
    //      على دفعات من 8 (≈16 طلب متزامن فقط بدل 70) — أمان من timeout
    await inBatches(top, 8, async (s) => {
      const fr = frameFor(s.trade_style);
      const [bars, news] = await Promise.all([
        fetchAggs(s.symbol, fr.mult, fr.span, fr.days, fr.limit),
        fetchNews(s.symbol),
      ]);

      const tech = computeTech(bars);
      s._tech = tech;
      s._news = news;
      s._drop = false;

      // المتوسطات + الأهداف من الفريم الصحيح
      if (tech) {
        s.ep = Math.min(s.ep + tech.maBonus, 99);
        s.ma_signal = tech.maSignal;
        if (tech.rsi != null) {
          s.rsi = tech.rsi;
          if (tech.rsi >= 80) s.ep = Math.max(0, s.ep - 8);
          else if (tech.rsi >= 72) s.ep = Math.max(0, s.ep - 4);
          else if (tech.rsi >= 50 && tech.rsi <= 65) s.ep = Math.min(99, s.ep + 3);
        } else s.rsi = null;
        // MACD
        if (tech.macd && tech.macd.bullish) s.ep = Math.min(99, s.ep + (tech.macd.rising ? 7 : 5));
        // أهداف واقعية بالفريم الصحيح
        if (tech.bars && tech.bars.length >= 15) {
          s.levels = s.trade_style === "مضاربة" ? calcScalpLevels(s.price, tech.bars) : calcSmartLevels(s.price, tech.bars);
          s.levels_source = s.trade_style === "مضاربة" ? "scalp_60m" : "smart_daily";
          s.structure = computeStructureLevels(s.price, tech.bars);   // 🆕 مستويات البنية (إضافية)
        } else s.levels_source = "atr_basic";
        s.week_max_jump = tech.recentMaxJump;
      } else {
        s.ma_signal = null; s.rsi = s.rsi ?? null; s.levels_source = "atr_basic"; s.week_max_jump = null;
      }

      // ── الأخبار: تمييز الكاتشي عن الوهمي ──
      const freshNews = news.hasNews && news.ageH != null && news.ageH <= 48;
      if (freshNews) {
        s.ep = Math.min(99, s.ep + (news.sentiment === "positive" ? 6 : 3));
      }
      // ارتفاع كبير بدون خبر طازج = خطر تلاعب (pump) → خصم ثقة
      if (s.changePct > 20 && !freshNews) s.ep = Math.max(0, s.ep - 8);
      s.news_age_h = news.ageH;

      // 📉 خصم الامتداد التدرّجي: كل ما ارتفع السهم فوق 12% قلّ سكوره
      //   (نفضّل الدخول المبكر — السهم اللي صعد كثير = دخول متأخر)
      if (s.changePct > 12) {
        s.ep = Math.max(0, s.ep - Math.round((s.changePct - 12) * 0.7));
      }

      // 🔀 مزج البنية: نرفع الدخول الصحيح ونُنزّل/نُسقط الملاحقة
      //   (دخول صحيح = اتجاه مؤكد + R:R جيد + ما زال قريب من الدعم + فيه مجال للهدف)
      if (s.structure) {
        const st = s.structure;
        const band = st.resistance - st.support;
        const pos = band > 0 ? (s.price - st.support) / band : 1;   // 0=عند الدعم .. 1=عند المقاومة
        const confirmed = s.price >= st.confirm;
        const rrOk = st.rr != null && st.rr >= STRUCT.MIN_RR;
        const room = st.resistance > s.price * 1.01;
        const fresh = pos <= STRUCT.MAX_POS;

        let adj = 0, flag;
        if (confirmed && rrOk && room && fresh) { adj = STRUCT.BONUS_VALID; flag = "دخول صحيح ✅"; }
        else if (confirmed && (rrOk || fresh))  { adj = STRUCT.BONUS_OK;    flag = "مقبول"; }
        else                                    { adj = -STRUCT.PENALTY_LATE; flag = "ملاحقة/غير مؤكد ⚠️"; }
        if (st.rr != null && st.rr < 1) adj -= STRUCT.PENALTY_BADRR;

        s.ep = Math.max(0, Math.min(99, s.ep + adj));
        st.flag = flag;
        st.posInBand = +pos.toFixed(2);

        // إسقاط الملاحقة الواضحة فقط: ارتفع كثير + قريب من القمة (دخول متأخر سيء)
        if (STRUCT.DROP_LATE && s.changePct > STRUCT.DROP_CHANGE && pos > STRUCT.DROP_POS) s._drop = true;

        // 💎 حارس الجوهرة: هابط + بلا تأكيد ارتداد → لا يظهر
        if (STRUCT.STRICT_GEMS && tech.bars && tech.bars.length >= 3) {
          const lc = tech.bars.slice(-3).map(b => b.c);
          const fallingNow = lc[2] < lc[1] && lc[1] < lc[0];           // إغلاقان متتاليان أدنى
          const confirmedUp = s.price >= st.confirm && tech.priceAboveMA21
                              && (tech.macd ? tech.macd.bullish : true);
          const lastBar = tech.bars[tech.bars.length - 1];
          const reversalBar = lastBar && lastBar.c > lastBar.o;        // شمعة ارتداد خضراء
          if (fallingNow && !confirmedUp && !reversalBar) {
            s._drop = true;
            st.flag = "هابط بلا تأكيد ⛔";
          }
        }
      }

      // ── البوابة (gate) ──
      if (s.price < FILTER.STRICT_PRICE) {
        // غربال صارم لأقل من $1: لازم كل الشروط
        const pass = tech && tech.aligned
          && s.rvol >= 5
          && tech.rsi != null && tech.rsi >= 50 && tech.rsi <= 68
          && tech.macd && tech.macd.bullish
          && s.ep >= 70;
        if (!pass) s._drop = true;
      } else {
        // $1 فأعلى:
        if (tech) {
          // عندنا بيانات → لازم اتجاه صاعد (فوق MA21)
          if (!tech.priceAboveMA21) s._drop = true;
        } else {
          // لا بيانات فنية (سهم جديد/تاريخ قصير) → ما نثق إلا بالمبكر
          s.ep = Math.min(s.ep, 72);                 // سقف بدون تأكيد
          if (s.changePct > 15) s._drop = true;      // ممتد + غير مؤكد = خطر pump
          else if (s.ep < 60) s._drop = true;
        }
      }

      // إعادة تقييم HOT + الإشارة
      s.is_hot = s.ep >= 75 && s.rvol >= 10 && s.changePct >= 10;
      s.signal = s.ep >= 80 ? "💥 انفجاري" : s.ep >= 60 ? "🔥 عالي" : "👀 مراقبة";

      // ── رصد مبكر ──
      const strongMA = ["تقاطع ذهبي 🌟", "صاعد قوي ⚡", "EMA صاعد"].includes(s.ma_signal);
      const inEarlyZone = s.changePct >= 2 && s.changePct <= 15;
      let early = 0;
      if (strongMA) early++;
      if (s.rsi != null && s.rsi >= 50 && s.rsi <= 68) early++;
      if (s.rvol != null && s.rvol >= 3 && s.rvol <= 30) early++;
      if (s.ep >= 65) early++;
      if (s.week_max_jump != null && s.week_max_jump <= 25) early++;
      s.early_watch = inEarlyZone && early >= 2;

      // ── 🎯 الهدف: التقاء كامل على الفريم الأساسي ──
      const earlyStage = s.changePct >= 2 && s.changePct <= 15;
      const volHigh = s.volume >= 1_000_000;
      const liqIn = s.rvol >= 4;
      const rsiPos = s.rsi != null && s.rsi >= 50 && s.rsi <= 68;
      const macdBull = !!(tech && tech.macd && tech.macd.bullish);
      const primaryConfluence = !s._drop && earlyStage && volHigh && liqIn && rsiPos && macdBull && tech && tech.aligned;
      s._primaryConfluence = primaryConfluence;
    });

    // 5.6) تأكيد الهدف على الفريم الآخر (للمرشحين النهائيين فقط) — على دفعات
    const finalists = top.filter(s => s._primaryConfluence);
    await inBatches(finalists, 8, async (s) => {
      const other = s.trade_style === "مضاربة"
        ? { mult: 1, span: "day", days: 140, limit: 200 }
        : { mult: 60, span: "minute", days: 30, limit: 600 };
      const otherBars = await fetchAggs(s.symbol, other.mult, other.span, other.days, other.limit);
      const otherTech = computeTech(otherBars);
      // النخبة: التقاء كامل على الفريم الأساسي + اتجاه صاعد على الفريم الآخر (فوق MA21)
      if (otherTech && otherTech.priceAboveMA21) {
        s.is_target = true;
        s.signal = "🎯 الهدف";
        s.ep = Math.max(s.ep, 90);
        s.is_hot = true;
      }
    });

    // 5.7) تطبيق الإسقاط (البوابة)
    let survivors = top.filter(s => !s._drop);
    // الفرز مبنيّ على البنية: 🎯 نخبة → دخول صحيح → رصد مبكر → مقبول → زخم فقط → EP
    const tier = s => {
      if (s.is_target) return 5;                                          // نخبة (التقاء متعدّد الفريمات)
      if (s.structure && s.structure.flag === "دخول صحيح ✅") return 4;   // دخول بنيوي صحيح
      if (s.early_watch) return 3;                                        // رصد مبكر
      if (s.structure && s.structure.flag === "مقبول") return 2;          // بنية مقبولة
      if (s.is_hot) return 1;                                             // زخم فقط (أدنى)
      return 0;
    };
    survivors.sort((a, b) => {
      const ta = tier(a), tb = tier(b);
      if (tb !== ta) return tb - ta;
      if (b.ep !== a.ep) return b.ep - a.ep;
      return b.rvol - a.rvol;
    });

    // 6) الحفظ (فقط غير المشترك + EP >= حد)
    let saveResult = { skipped: true, reason: "subscriber scan" };
    if (!isSubscriber) {
      const toSave = survivors.filter(s => s.ep >= FILTER.SAVE_MIN_EP);
      saveResult = await saveSignals(toSave);
    }

    // 7) تجهيز الرد (نفس شكل الواجهة تماماً)
    const toCard = s => ({
      symbol: s.symbol, price: s.price, change_pct: s.changePct, score: s.ep, signal: s.signal,
      type: s.type, volume: s.volume, rvol: s.rvol, is_hot: s.is_hot, vwap: s.vwap,
      ma_signal: s.ma_signal || null, rsi: s.rsi ?? null, early_watch: s.early_watch || false,
      week_max_jump: s.week_max_jump ?? null, levels: s.levels, atr14: s.levels?.atr14 || null,
      levels_source: s.levels_source || "atr_basic", is_target: s.is_target || false,
      news_age_h: s.news_age_h ?? null,
      structure: s.structure || null,   // 🆕 مستويات البنية (Swing + فيبوناتشي)
    });

    const results     = survivors.map(toCard);
    const leaders     = results.filter(s => s.type === "استثمار");   // 🐞 إصلاح: كان "قيادي"
    const speculation = results.filter(s => s.type !== "استثمار");
    const early       = results.filter(s => s.early_watch);

    return res.status(200).json({
      success: true, total: results.length,
      hot: results.filter(s => s.is_hot).length,
      target: results.filter(s => s.is_target).length,
      early: early.length, saved: saveResult.saved || 0, saveResult,
      timing: { market_fetch: t1 - t0, total_ms: Date.now() - t0 },
      market_scanned: allTickers.length, after_filter: candidates.length,
      results, leaders, speculation, earlyWatch: early,
    });

  } catch (error) {
    return res.status(200).json({ success: false, error: error.message, results: [], leaders: [], speculation: [] });
  }
}
