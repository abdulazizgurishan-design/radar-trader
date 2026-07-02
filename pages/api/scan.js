// ============================================================
// scan.js — MONEY MACHINE v2 🔍
// جلب إشارات RadarAZ مع فلاتر محسّنة للأهداف الصغيرة
// الفترات الذهبية: 4:30م-6:30م (قناص) | 10:00م-11:00م (زخم)
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.RADARAZ_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.RADARAZ_SUPABASE_KEY;

// ─── الإعدادات الجديدة ────────────────────────────────────
const CONFIG = {
  // 🎯 الأهداف والوقف (ثابتة)
  TARGET_PROFIT: 0.007,      // 0.7%
  STOP_LOSS: 0.005,          // 0.5%
  MIN_RR: 1.4,               // 1.4:1
  
  // 🔍 فلاتر صارمة
  MIN_SCORE: 70,
  MIN_PRICE: 5,
  MIN_CHANGE: 1.5,
  MAX_CHANGE: 5,
  MIN_VOLUME: 200000,
  MIN_RVOL: 1.5,
  MIN_RSI: 55,
  MAX_RSI: 70,
  
  // 📊 الكميات
  MAX_RESULTS: 20,
  MAX_LEADERS: 20,
  MAX_SPECULATION: 30,
};

// ─── حساب الأهداف السريعة ──────────────────────────────────
function calcFastTargets(price) {
  const target = price * (1 + CONFIG.TARGET_PROFIT);
  const stop = price * (1 - CONFIG.STOP_LOSS);
  const risk = price - stop;
  const reward = target - price;
  const rr = risk > 0 ? reward / risk : 0;
  
  return {
    sl: +stop.toFixed(2),
    t1: +target.toFixed(2),
    risk: +risk.toFixed(2),
    slPct: -((risk / price) * 100).toFixed(2),
    t1Pct: +((reward / price) * 100).toFixed(2),
    rr: +rr.toFixed(2),
  };
}

// ─── التحقق من وقت التداول ──────────────────────────────────
function getTradingSession() {
  const saudiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
  const h = saudiNow.getHours(), m = saudiNow.getMinutes();
  const minutes = h * 60 + m;
  
  // الفترة الأولى: 4:30م - 6:30م (بتوقيت السعودية)
  const isSession1 = minutes >= 16 * 60 + 30 && minutes < 18 * 60 + 30;
  
  // الفترة الثانية: 10:00م - 11:00م (بتوقيت السعودية)
  const isSession2 = minutes >= 22 * 60 && minutes < 23 * 60;
  
  let session = "off";
  let label = "🔴 خارج أوقات التداول الآلي";
  let config = null;
  
  if (isSession1) {
    session = "session1";
    label = "🟢 الفترة الذهبية - الزخم الصباحي (4:30م - 6:30م)";
    config = {
      name: "الزخم الصباحي",
      strategy: "sniper_momentum",
      minScore: CONFIG.MIN_SCORE,
      minPrice: CONFIG.MIN_PRICE,
      maxChange: CONFIG.MAX_CHANGE,
      minChange: CONFIG.MIN_CHANGE,
      minVolume: CONFIG.MIN_VOLUME,
      maxRSI: CONFIG.MAX_RSI,
      minRR: CONFIG.MIN_RR,
      maxResults: CONFIG.MAX_RESULTS,
      stopLoss: CONFIG.STOP_LOSS,
      target1: CONFIG.TARGET_PROFIT,
    };
  } else if (isSession2) {
    session = "session2";
    label = "🟡 الفترة الذهبية - الزخم المسائي (10:00م - 11:00م)";
    config = {
      name: "الزخم المسائي",
      strategy: "late_momentum",
      minScore: Math.max(CONFIG.MIN_SCORE - 5, 65),
      minPrice: CONFIG.MIN_PRICE,
      maxChange: CONFIG.MAX_CHANGE - 1,
      minChange: CONFIG.MIN_CHANGE - 0.3,
      minVolume: CONFIG.MIN_VOLUME - 50000,
      maxRSI: CONFIG.MAX_RSI - 2,
      minRR: CONFIG.MIN_RR,
      maxResults: Math.min(CONFIG.MAX_RESULTS - 5, 15),
      stopLoss: CONFIG.STOP_LOSS,
      target1: CONFIG.TARGET_PROFIT,
    };
  }
  
  return { session, label, config, isSession1, isSession2, minutes };
}

// ─── التحقق من نافذة التداول الأمريكية ──────────────────────
const TRADING_START_HOUR_ET = 9, TRADING_START_MIN_ET = 30;
const TRADING_END_HOUR_ET = 16, TRADING_END_MIN_ET = 0;

function isTradingWindow() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const minutesNow = et.getHours() * 60 + et.getMinutes();
  const minutesStart = TRADING_START_HOUR_ET * 60 + TRADING_START_MIN_ET;
  const minutesEnd = TRADING_END_HOUR_ET * 60 + TRADING_END_MIN_ET;
  return minutesNow >= minutesStart && minutesNow < minutesEnd;
}

// ─── الدالة الرئيسية ──────────────────────────────────────
export default async function handler(req, res) {
  try {
    // ─── التحقق من الفترات الذهبية ──────────────────────
    const tradingSession = getTradingSession();
    const isActiveSession = tradingSession.session !== "off";
    const sessionConfig = tradingSession.config;
    
    // إذا كان خارج الفترات الذهبية، نرجع رد فارغ
    if (!isActiveSession) {
      return res.status(200).json({
        success: true,
        results: [],
        leaders: [],
        speculation: [],
        total: 0,
        market_open: false,
        session: tradingSession.label,
        sessionActive: false,
        message: `⏳ خارج فترات التداول الآلي (${tradingSession.label})`,
      });
    }
    
    // ─── التحقق من نافذة التداول الأساسية ──────────────
    if (!isTradingWindow()) {
      return res.status(200).json({
        success: true,
        results: [],
        leaders: [],
        speculation: [],
        total: 0,
        market_open: false,
        session: tradingSession.label,
        sessionActive: true,
        message: "⏳ السوق خارج ساعات التداول الأساسية",
      });
    }
    
    // ─── جلب الإشارات من Supabase ──────────────────────
    const todayET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
      .toISOString().split("T")[0];
    
    const url = `${SUPABASE_URL}/rest/v1/signals`
      + `?select=*`
      + `&score=gte.${sessionConfig.minScore}`
      + `&signal_date=eq.${todayET}`
      + `&order=score.desc`
      + `&limit=100`;
    
    const r = await fetch(url, {
      headers: { 
        apikey: SUPABASE_KEY, 
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    });
    
    if (!r.ok) throw new Error(`Radaraz Supabase: ${r.status}`);
    const rows = await r.json();
    
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(200).json({
        success: true,
        results: [],
        leaders: [],
        speculation: [],
        total: 0,
        market_open: true,
        session: {
          active: true,
          label: tradingSession.label,
          name: sessionConfig.name,
          strategy: sessionConfig.strategy,
        },
        source: "radaraz",
        message: "📭 لا توجد إشارات اليوم",
      });
    }
    
    // إزالة المكررات
    const seen = new Set();
    const unique = rows.filter(s => {
      if (seen.has(s.symbol)) return false;
      seen.add(s.symbol);
      return true;
    });
    
    // ─── تحويل وتحليل الإشارات ──────────────────────────
    const formatted = unique
      .map(s => {
        const price = Number(s.entry_price) || 0;
        if (price === 0) return null;
        
        // حساب الأهداف السريعة
        const fastLevels = calcFastTargets(price);
        
        // فلتر RR
        if (fastLevels.rr < sessionConfig.minRR) return null;
        
        const score = s.score || s.ep || 0;
        const confidence = score >= 85 ? "💥 انفجاري" : 
                          score >= 75 ? "🔥 ممتاز" : 
                          score >= 70 ? "✅ جيد" : "👀 مراقبة";
        
        const sessionLabel = tradingSession.session === "session1" ? "⚡ قناص" : "🌙 زخم";
        
        return {
          symbol: s.symbol,
          price: price,
          change_pct: Number(s.change_pct) || 0,
          volume: s.volume || 0,
          rr: fastLevels.rr,
          signal: `🎯 ${sessionLabel} ${confidence}`,
          score: score,
          type: s.type === "استثمار" ? "استثمار" : "مضاربة",
          rsi: s.rsi ?? null,
          ma_signal: s.ma_signal || null,
          atr14: s.atr14 ?? null,
          early_watch: s.early_watch || false,
          is_target: s.is_target || false,
          rvol: Number(s.rvol) || null,
          is_hot: s.is_hot || false,
          news_age_h: s.news_age_h ?? null,
          structure: s.structure || null,
          vcp: s.vcp || false,
          fresh_zone: s.fresh_zone || false,
          // 🆕 الأهداف الجديدة (تتجاوز بنية الرادار)
          levels: {
            sl: fastLevels.sl,
            slPct: fastLevels.slPct,
            t1: fastLevels.t1,
            t1Pct: fastLevels.t1Pct,
            risk: fastLevels.risk,
          },
          // معلومات الفترة
          session: {
            name: sessionConfig.name,
            strategy: sessionConfig.strategy,
            label: tradingSession.label,
          },
        };
      })
      .filter(Boolean);
    
    // ─── فلترة إضافية حسب إعدادات الفترة ──────────────
    const filtered = formatted.filter(s => {
      // فلتر السعر
      if (s.price < (sessionConfig.minPrice || CONFIG.MIN_PRICE)) return false;
      
      // فلتر التغير (القيمة المطلقة للزخم)
      const absChange = Math.abs(s.change_pct);
      if (absChange > (sessionConfig.maxChange || CONFIG.MAX_CHANGE)) return false;
      if (absChange < (sessionConfig.minChange || CONFIG.MIN_CHANGE)) return false;
      
      // فلتر الحجم
      if (s.volume < (sessionConfig.minVolume || CONFIG.MIN_VOLUME)) return false;
      
      // فلتر RSI
      if (s.rsi != null && s.rsi > (sessionConfig.maxRSI || CONFIG.MAX_RSI)) return false;
      if (s.rsi != null && s.rsi < CONFIG.MIN_RSI) return false;
      
      // فلتر RVOL
      if (s.rvol != null && s.rvol < CONFIG.MIN_RVOL) return false;
      
      // فلتر RR
      if (s.rr < (sessionConfig.minRR || CONFIG.MIN_RR)) return false;
      
      return true;
    });
    
    // ─── ترتيب حسب الأولوية ──────────────────────────────
    const validEntry = x => {
      if (!x.structure) return false;
      const flag = x.structure.flag || "";
      return flag.indexOf("صحيح") >= 0;
    };
    
    filtered.sort((a, b) => {
      // 1. 🎯 الهدف أولاً
      if (!!b.is_target !== !!a.is_target) return b.is_target ? 1 : -1;
      // 2. دخول صحيح
      if (validEntry(b) !== validEntry(a)) return validEntry(b) ? 1 : -1;
      // 3. رصد مبكر
      if (!!b.early_watch !== !!a.early_watch) return b.early_watch ? 1 : -1;
      // 4. HOT
      if (b.is_hot !== a.is_hot) return b.is_hot ? 1 : -1;
      // 5. السكور
      return (b.score || 0) - (a.score || 0);
    });
    
    // ─── تقسيم النتائج ──────────────────────────────────
    const maxResults = sessionConfig.maxResults || CONFIG.MAX_RESULTS;
    const results = filtered.slice(0, maxResults);
    
    const leaders = results.filter(s => s.type === "استثمار").slice(0, CONFIG.MAX_LEADERS);
    const speculation = results.filter(s => s.type === "مضاربة").slice(0, CONFIG.MAX_SPECULATION);
    
    // ─── إحصائيات الرفض ──────────────────────────────────
    const skipStats = {
      price: formatted.filter(s => s.price < (sessionConfig.minPrice || CONFIG.MIN_PRICE)).length,
      change: formatted.filter(s => {
        const absChange = Math.abs(s.change_pct);
        return absChange > (sessionConfig.maxChange || CONFIG.MAX_CHANGE) || 
               absChange < (sessionConfig.minChange || CONFIG.MIN_CHANGE);
      }).length,
      volume: formatted.filter(s => s.volume < (sessionConfig.minVolume || CONFIG.MIN_VOLUME)).length,
      rsi: formatted.filter(s => {
        if (s.rsi == null) return false;
        return s.rsi > (sessionConfig.maxRSI || CONFIG.MAX_RSI) || s.rsi < CONFIG.MIN_RSI;
      }).length,
      rvol: formatted.filter(s => s.rvol != null && s.rvol < CONFIG.MIN_RVOL).length,
      rr: formatted.filter(s => s.rr < (sessionConfig.minRR || CONFIG.MIN_RR)).length,
    };
    
    return res.status(200).json({
      success: true,
      results: results,
      leaders: leaders,
      speculation: speculation,
      total: filtered.length,
      total_raw: unique.length,
      market_open: true,
      session: {
        active: true,
        label: tradingSession.label,
        name: sessionConfig.name,
        strategy: sessionConfig.strategy,
        maxResults: maxResults,
        isSession1: tradingSession.isSession1,
        isSession2: tradingSession.isSession2,
        minutes: tradingSession.minutes,
      },
      source: "radaraz",
      config: {
        target: `${(CONFIG.TARGET_PROFIT * 100).toFixed(1)}%`,
        stop: `${(CONFIG.STOP_LOSS * 100).toFixed(1)}%`,
        minScore: sessionConfig.minScore,
        minRR: sessionConfig.minRR,
        minPrice: sessionConfig.minPrice,
        maxChange: sessionConfig.maxChange,
        minChange: sessionConfig.minChange,
        minVolume: sessionConfig.minVolume,
        maxRSI: sessionConfig.maxRSI,
      },
      skip_stats: skipStats,
      timestamp: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error("❌ خطأ في scan.js:", error);
    return res.status(200).json({
      success: false,
      results: [],
      leaders: [],
      speculation: [],
      total: 0,
      market_open: false,
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
}
