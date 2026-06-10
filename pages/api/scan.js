// pages/api/scan.js — يسحب الإشارات من Radaraz Supabase مباشرة
// ─────────────────────────────────────────────────────────────────
// بدل ما يمسح السوق بنفسه، يقرأ إشارات Radaraz الجاهزة (EP ≥ 70)
// السوق المسموح: 4:30م - 8:00م الرياض (9:30ص - 1:00م ET)
// ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.RADARAZ_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.RADARAZ_SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

const MIN_EP            = 70;     // الحد الأدنى للإشارة
const LOOKBACK_HOURS    = 4;      // آخر 4 ساعات
const MAX_LEADERS       = 20;
const MAX_SPECULATION   = 30;

// ─── ساعات تشغيل البوت (بتوقيت ET) ─────────────────────────────
// 9:30 AM ET (فتح السوق) = 4:30 PM الرياض
// 1:00 PM ET (إيقاف فتح صفقات) = 8:00 PM الرياض
const TRADING_START_HOUR_ET = 9;   // 9:30 صباحاً ET
const TRADING_START_MIN_ET  = 30;
const TRADING_END_HOUR_ET   = 13;  // 1:00 ظهراً ET = 8:00م الرياض

function isTradingWindow() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h   = et.getHours();
  const m   = et.getMinutes();
  const day = et.getDay();

  if (day === 0 || day === 6) return false; // عطلة نهاية الأسبوع

  const minutesNow   = h * 60 + m;
  const minutesStart = TRADING_START_HOUR_ET * 60 + TRADING_START_MIN_ET;
  const minutesEnd   = TRADING_END_HOUR_ET   * 60;

  return minutesNow >= minutesStart && minutesNow < minutesEnd;
}

export default async function handler(req, res) {
  try {
    // ─── 1. تحقّق من نافذة التداول ────────────────────────────
    const tradingOpen = isTradingWindow();

    if (!tradingOpen) {
      return res.status(200).json({
        success:     true,
        results:     [],
        leaders:     [],
        speculation: [],
        total:       0,
        market_open: false,
        message:     "خارج ساعات التداول (4:30م - 8:00م الرياض)",
      });
    }

    // ─── 2. اجلب الإشارات من Radaraz Supabase ─────────────────
    const sinceISO = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/signals`
      + `?select=*`
      + `&ep=gte.${MIN_EP}`
      + `&created_at=gte.${sinceISO}`
      + `&order=ep.desc`
      + `&limit=100`;

    const r = await fetch(url, {
      headers: {
        apikey:        SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });

    if (!r.ok) throw new Error(`Radaraz Supabase: ${r.status}`);
    const rows = await r.json();

    // ─── 3. إزالة المكررات (آخر إشارة لكل سهم) ───────────────
    const seen = new Set();
    const unique = rows.filter(s => {
      if (seen.has(s.symbol)) return false;
      seen.add(s.symbol);
      return true;
    });

    // ─── 4. تحويل صيغة Radaraz لصيغة بوتك ────────────────────
    const formatted = unique.map(s => {
      const price    = Number(s.entry_price) || 0;
      const target1  = Number(s.target1)     || 0;
      const target2  = Number(s.target2)     || 0;
      const target3  = Number(s.target3)     || 0;
      const stopLoss = Number(s.stop_loss)   || 0;

      const slPct    = price ? +(((stopLoss - price) / price) * 100).toFixed(2) : 0;
      const t1Pct    = price ? +(((target1  - price) / price) * 100).toFixed(2) : 0;
      const t2Pct    = price ? +(((target2  - price) / price) * 100).toFixed(2) : 0;
      const t3Pct    = price ? +(((target3  - price) / price) * 100).toFixed(2) : 0;
      const risk     = +(price - stopLoss).toFixed(2);
      const reward   = target1 - price;
      const rr       = risk > 0 ? (reward / risk).toFixed(1) : "0";

      const score    = s.ep || s.score || 0;
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
        type:       s.type === "قيادي" ? "قيادي" : "مضاربة",
        marketCap:  null,
        ema9:       null,
        ema20:      null,
        rsi:        null,
        vwap:       null,
        rvol:       Number(s.rvol) || null,
        is_hot:     s.is_hot || false,
        news_age_h: s.news_age_hours,
        levels: {
          sl: stopLoss, slPct,
          t1: target1,  t1Pct,
          t2: target2,  t2Pct,
          t3: target3,  t3Pct,
          risk,
        },
      };
    });

    // ─── 5. ترتيب: HOT أولاً ثم EP ───────────────────────────
    formatted.sort((a, b) => {
      if (b.is_hot !== a.is_hot) return b.is_hot ? 1 : -1;
      return b.score - a.score;
    });

    // ─── 6. تقسيم: قيادي / مضاربة ────────────────────────────
    const leaders = formatted.filter(s => s.type === "قيادي").slice(0, MAX_LEADERS);
    const spec    = formatted.filter(s => s.type === "مضاربة").slice(0, MAX_SPECULATION);
    const all     = [...leaders, ...spec];

    return res.status(200).json({
      success:     true,
      results:     all,
      leaders,
      speculation: spec,
      total:       formatted.length,
      market_open: true,
      source:      "radaraz",
    });

  } catch (error) {
    return res.status(200).json({
      success: false,
      results: [],
      error:   error.message,
    });
  }
}
