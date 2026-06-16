// pages/api/scan.js — v2 (يقرأ إشارات Radaraz المحدّثة من Supabase)
// ═══════════════════════════════════════════════════════════════════
//  ✅ يقرأ is_target (🎯 الهدف) ويعطيه الأولوية
//  ✅ أصلح اسم حقل الأخبار: news_age_h (كان news_age_hours = فاضي)
//  ✅ نافذة أحدث (3 ساعات) → السعر الحي ≈ سعر دخول الرادار
//  ✅ يطابق فلتر الرادار: score ≥ 60 (بعد فلترة الرادار المشدّدة)
// ═══════════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.RADARAZ_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.RADARAZ_SUPABASE_KEY;

const MIN_SCORE       = 60;     // يطابق الحد الأدنى لحفظ الرادار
const LOOKBACK_HOURS  = 3;      // 🆕 أحدث — يقلّل فجوة السعر بين الدخول والتنفيذ
const MAX_LEADERS     = 20;
const MAX_SPECULATION = 30;

const TRADING_START_HOUR_ET = 9,  TRADING_START_MIN_ET = 30;
const TRADING_END_HOUR_ET   = 15, TRADING_END_MIN_ET   = 45;

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

export default async function handler(req, res) {
  try {
    if (!isTradingWindow()) {
      return res.status(200).json({
        success: true, results: [], leaders: [], speculation: [],
        total: 0, market_open: false, message: "خارج ساعات التداول",
      });
    }

    // اجلب إشارات Radaraz (آخر 3 ساعات، score ≥ 60)
    const sinceISO = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/signals`
      + `?select=*`
      + `&score=gte.${MIN_SCORE}`
      + `&created_at=gte.${sinceISO}`
      + `&order=score.desc`
      + `&limit=100`;

    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) throw new Error(`Radaraz Supabase: ${r.status}`);
    const rows = await r.json();

    // إزالة المكررات (دفاع إضافي — الرادار يزيلها أصلاً)
    const seen = new Set();
    const unique = rows.filter(s => {
      if (seen.has(s.symbol)) return false;
      seen.add(s.symbol);
      return true;
    });

    // تحويل صيغة Radaraz لصيغة البوت
    const formatted = unique.map(s => {
      const price    = Number(s.entry_price) || 0;
      const target1  = Number(s.target1)     || 0;
      const target2  = Number(s.target2)     || 0;
      const target3  = Number(s.target3)     || 0;
      const stopLoss = Number(s.stop_loss)   || 0;

      const slPct = price ? +(((stopLoss - price) / price) * 100).toFixed(2) : 0;
      const t1Pct = price ? +(((target1  - price) / price) * 100).toFixed(2) : 0;
      const t2Pct = price ? +(((target2  - price) / price) * 100).toFixed(2) : 0;
      const t3Pct = price ? +(((target3  - price) / price) * 100).toFixed(2) : 0;
      const risk  = +(price - stopLoss).toFixed(2);
      const rr    = risk > 0 ? ((target1 - price) / risk).toFixed(1) : "0";

      const score = s.score || s.ep || 0;
      const confidence =
        score >= 85 ? "💥 انفجاري" :
        score >= 70 ? "🔥 إشارة ممتازة" : "👀 مراقبة";

      return {
        symbol:     s.symbol,
        price,
        change_pct: Number(s.change_pct) || 0,
        volume:     s.volume || 0,
        rr,
        signal:     confidence,
        score,
        type:       s.type === "استثمار" ? "استثمار" : "مضاربة",
        rsi:        s.rsi ?? null,
        ma_signal:  s.ma_signal || null,
        atr14:      s.atr14 ?? null,
        early_watch: s.early_watch || false,
        is_target:  s.is_target || false,          // 🆕 الهدف
        vwap:       null,
        rvol:       Number(s.rvol) || null,
        is_hot:     s.is_hot || false,
        news_age_h: s.news_age_h ?? null,          // 🆕 اسم الحقل الصحيح
        levels: { sl: stopLoss, slPct, t1: target1, t1Pct, t2: target2, t2Pct, t3: target3, t3Pct, risk },
      };
    });

    // ترتيب: 🎯 الهدف → رصد مبكر → HOT → score
    formatted.sort((a, b) => {
      if (!!b.is_target   !== !!a.is_target)   return b.is_target   ? 1 : -1;
      if (!!b.early_watch !== !!a.early_watch) return b.early_watch ? 1 : -1;
      if (b.is_hot !== a.is_hot) return b.is_hot ? 1 : -1;
      return b.score - a.score;
    });

    const leaders = formatted.filter(s => s.type === "استثمار").slice(0, MAX_LEADERS);
    const spec    = formatted.filter(s => s.type === "مضاربة").slice(0, MAX_SPECULATION);

    return res.status(200).json({
      success: true,
      results: [...leaders, ...spec],
      leaders,
      speculation: spec,
      total: formatted.length,
      market_open: true,
      source: "radaraz",
    });

  } catch (error) {
    return res.status(200).json({ success: false, results: [], error: error.message });
  }
}
