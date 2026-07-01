// pages/api/scan.js — v3 (الفترات الذهبية للتداول الآلي)
// ═══════════════════════════════════════════════════════════════════
//  ✅ يقرأ is_target (🎯 الهدف) ويعطيه الأولوية
//  ✅ أصلح اسم حقل الأخبار: news_age_h
//  ✅ نافذة أحدث (3 ساعات) → السعر الحي ≈ سعر دخول الرادار
//  ✅ نظام الفترات الذهبية:
//        الفترة الأولى: 4:30م - 6:30م (القناص + الزخم)
//        الفترة الثانية: 10:00م - 11:00م (الزخم المتأخر)
//  ✅ أهداف قريبة وسريعة للصفقات الآلية
// ═══════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.RADARAZ_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.RADARAZ_SUPABASE_KEY;

const MIN_SCORE       = 60;
const LOOKBACK_HOURS  = 3;
const MAX_LEADERS     = 20;
const MAX_SPECULATION = 30;

// ─── 🕐 نظام الفترات الذهبية للتداول الآلي ──────────────────────
function getTradingSession() {
  const saudiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
  const h = saudiNow.getHours(), m = saudiNow.getMinutes();
  const minutes = h * 60 + m;
  
  // الفترة الأولى: 4:30م - 6:30م (الزخم الصباحي)
  const isSession1 = minutes >= 16 * 60 + 30 && minutes < 18 * 60 + 30;
  
  // الفترة الثانية: 10:00م - 11:00م (الزخم المسائي)
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
      minScore: 68,
      minPrice: 3,
      maxChange: 8,
      minChange: 2,
      minVolume: 100_000,
      maxRSI: 75,
      minRR: 1.0,
      maxResults: 20,
      stopLoss: 0.04,
      target1: 0.035,
      target2: 0.06,
      target3: 0.09,
    };
  } else if (isSession2) {
    session = "session2";
    label = "🟡 الفترة الذهبية - الزخم المسائي (10:00م - 11:00م)";
    config = {
      name: "الزخم المسائي",
      strategy: "late_momentum",
      minScore: 55,
      minPrice: 2,
      maxChange: 5,
      minChange: 1.5,
      minVolume: 50_000,
      maxRSI: 72,
      minRR: 0.8,
      maxResults: 15,
      stopLoss: 0.03,
      target1: 0.025,
      target2: 0.04,
      target3: 0.06,
    };
  }
  
  return { session, label, config, isSession1, isSession2, minutes };
}

// ─── 🕐 نافذة التداول الأساسية (احتياطي) ────────────────────────
const TRADING_START_HOUR_ET = 9,  TRADING_START_MIN_ET = 50;
const TRADING_END_HOUR_ET   = 15, TRADING_END_MIN_ET   = 0;

function isTradingWindow() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const minutesNow   = et.getHours() * 60 + et.getMinutes();
  const minutesStart = TRADING_START_HOUR_ET * 60 + TRADING_START_MIN_ET;
  const minutesEnd   = TRADING_END_HOUR_ET   * 60 + TRADING_END_MIN_ET;
  return minutesNow >= minutesStart && minutesNow < minutesEnd;
}

// ─── 🎯 حساب أهداف سريعة للصفقات الآلية ──────────────────────────
function calcFastTargets(price, structure, sessionConfig) {
  const stopPct = sessionConfig.stopLoss;
  const target1Pct = sessionConfig.target1;
  const target2Pct = sessionConfig.target2;
  const target3Pct = sessionConfig.target3;
  
  // استخدام بنية السوق إن وجدت
  let stop = structure?.stop ? Number(structure.stop) : price * (1 - stopPct);
  let t1 = structure?.t1 ? Number(structure.t1) : price * (1 + target1Pct);
  let t2 = structure?.t2 ? Number(structure.t2) : price * (1 + target2Pct);
  let t3 = structure?.t3 ? Number(structure.t3) : price * (1 + target3Pct);
  
  // التأكد من ترتيب الأهداف
  t2 = Math.max(t2, t1 * 1.005);
  t3 = Math.max(t3, t2 * 1.005);
  
  // التأكد من أن الوقف أقل من السعر
  if (stop >= price) {
    stop = price * (1 - stopPct);
  }
  
  const risk = price - stop;
  const rr = risk > 0 ? ((t1 - price) / risk) : 0;
  
  return {
    sl: +stop.toFixed(2),
    t1: +t1.toFixed(2),
    t2: +t2.toFixed(2),
    t3: +t3.toFixed(2),
    risk: +risk.toFixed(2),
    slPct: -((risk / price) * 100).toFixed(2),
    t1Pct: +(((t1 - price) / price) * 100).toFixed(2),
    t2Pct: +(((t2 - price) / price) * 100).toFixed(2),
    t3Pct: +(((t3 - price) / price) * 100).toFixed(2),
    rr: +rr.toFixed(2),
  };
}

export default async function handler(req, res) {
  try {
    // ─── 🕐 التحقق من الفترات الذهبية ──────────────────────────────
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

    // ─── التحقق من نافذة التداول الأساسية ──────────────────────────
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

    // ─── جلب الإشارات من Supabase ──────────────────────────────────
    const todayET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
      .toISOString().split("T")[0];
    const url = `${SUPABASE_URL}/rest/v1/signals`
      + `?select=*`
      + `&score=gte.${sessionConfig.minScore || MIN_SCORE}`
      + `&signal_date=eq.${todayET}`
      + `&order=score.desc`
      + `&limit=100`;

    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) throw new Error(`Radaraz Supabase: ${r.status}`);
    const rows = await r.json();

    // إزالة المكررات
    const seen = new Set();
    const unique = rows.filter(s => {
      if (seen.has(s.symbol)) return false;
      seen.add(s.symbol);
      return true;
    });

    // ─── تحويل صيغة Radaraz لصيغة البوت مع أهداف سريعة ────────────
    const formatted = unique
      .map(s => {
        const price = Number(s.entry_price) || 0;
        if (price === 0) return null;

        // 🆕 حساب الأهداف السريعة حسب الفترة
        const structure = s.structure || null;
        const fastLevels = calcFastTargets(price, structure, sessionConfig);

        const score = s.score || s.ep || 0;
        const confidence = score >= 85 ? "💥 انفجاري" : score >= 70 ? "🔥 إشارة ممتازة" : "👀 مراقبة";

        // 🆕 إضافة علامة الفترة
        const sessionLabel = tradingSession.session === "session1" ? "⚡ قناص" : "🌙 زخم";

        return {
          symbol: s.symbol,
          price,
          change_pct: Number(s.change_pct) || 0,
          volume: s.volume || 0,
          rr: fastLevels.rr,
          signal: `🎯 ${sessionLabel} ${confidence}`,
          score,
          type: s.type === "استثمار" ? "استثمار" : "مضاربة",
          rsi: s.rsi ?? null,
          ma_signal: s.ma_signal || null,
          atr14: s.atr14 ?? null,
          early_watch: s.early_watch || false,
          is_target: s.is_target || false,
          vwap: null,
          rvol: Number(s.rvol) || null,
          is_hot: s.is_hot || false,
          news_age_h: s.news_age_h ?? null,
          structure: s.structure || null,
          // 🆕 أهداف سريعة
          levels: {
            sl: fastLevels.sl,
            slPct: fastLevels.slPct,
            t1: fastLevels.t1,
            t1Pct: fastLevels.t1Pct,
            t2: fastLevels.t2,
            t2Pct: fastLevels.t2Pct,
            t3: fastLevels.t3,
            t3Pct: fastLevels.t3Pct,
            risk: fastLevels.risk,
          },
          // 🆕 معلومات الفترة
          session: {
            name: sessionConfig.name,
            strategy: sessionConfig.strategy,
            label: tradingSession.label,
          },
        };
      })
      .filter(Boolean);

    // ─── فلترة إضافية حسب إعدادات الفترة ──────────────────────────
    const filtered = formatted.filter(s => {
      if (s.price < (sessionConfig.minPrice || 2)) return false;
      if (Math.abs(s.change_pct) > (sessionConfig.maxChange || 8)) return false;
      if (Math.abs(s.change_pct) < (sessionConfig.minChange || 1.5)) return false;
      if (s.volume < (sessionConfig.minVolume || 50_000)) return false;
      if (s.rsi != null && s.rsi > (sessionConfig.maxRSI || 75)) return false;
      if (s.rr < (sessionConfig.minRR || 0.8)) return false;
      return true;
    });

    // ─── ترتيب: 🎯 الهدف → دخول صحيح → رصد مبكر → HOT → score ────
    const validEntry = x => x.structure && typeof x.structure.flag === "string" && x.structure.flag.indexOf("صحيح") >= 0;
    filtered.sort((a, b) => {
      if (!!b.is_target   !== !!a.is_target)   return b.is_target   ? 1 : -1;
      if (validEntry(b)   !== validEntry(a))   return validEntry(b) ? 1 : -1;
      if (!!b.early_watch !== !!a.early_watch) return b.early_watch ? 1 : -1;
      if (b.is_hot !== a.is_hot) return b.is_hot ? 1 : -1;
      return b.score - a.score;
    });

    const maxResults = sessionConfig.maxResults || 20;
    const leaders = filtered.filter(s => s.type === "استثمار").slice(0, MAX_LEADERS);
    const spec = filtered.filter(s => s.type === "مضاربة").slice(0, Math.min(MAX_SPECULATION, maxResults));

    return res.status(200).json({
      success: true,
      results: [...leaders, ...spec].slice(0, maxResults),
      leaders,
      speculation: spec,
      total: filtered.length,
      market_open: true,
      session: {
        active: true,
        label: tradingSession.label,
        name: sessionConfig.name,
        strategy: sessionConfig.strategy,
        maxResults: maxResults,
      },
      source: "radaraz",
    });

  } catch (error) {
    return res.status(200).json({
      success: false,
      results: [],
      error: error.message,
    });
  }
}
