// pages/api/close.js — إغلاق كامل لكل الصفقات المفتوحة
// ─────────────────────────────────────────────────────────────────
// يُستدعى الساعة 8:00م الرياض (1:00 PM ET) عبر cron
// يغلق كل المراكز بسعر السوق سواء حققت الهدف أو لا
// ─────────────────────────────────────────────────────────────────

const ALPACA_KEY    = process.env.ALPACA_KEY || process.env.NEXT_PUBLIC_ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET || process.env.NEXT_PUBLIC_ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";

const H = {
  "APCA-API-KEY-ID":     ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type":        "application/json",
};

export default async function handler(req, res) {
  try {
    // 1. اجلب كل المراكز المفتوحة
    const posRes = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: H });
    const positions = await posRes.json();

    if (!Array.isArray(positions) || positions.length === 0) {
      return res.status(200).json({
        success: true,
        message: "لا توجد صفقات مفتوحة لإغلاقها",
        closed: 0,
      });
    }

    // 2. ألغِ كل الأوامر المعلّقة أولاً (مهم قبل الإغلاق)
    await fetch(`${ALPACA_BASE}/v2/orders?status=open`, {
      method: "DELETE",
      headers: H,
    });

    // 3. أغلق كل المراكز بسعر السوق
    //    DELETE /v2/positions يغلق الكل دفعة واحدة
    const closeRes = await fetch(`${ALPACA_BASE}/v2/positions?cancel_orders=true`, {
      method: "DELETE",
      headers: H,
    });

    const closeData = await closeRes.json();

    // 4. تجهيز التقرير
    const closed = Array.isArray(closeData) ? closeData : [];
    const summary = closed.map(c => ({
      symbol: c.symbol,
      status: c.status,
      qty:    c.body?.qty || null,
    }));

    return res.status(200).json({
      success: true,
      message: `تم إغلاق ${closed.length} صفقة عند 8:00م`,
      closed:  closed.length,
      positions_before: positions.length,
      details: summary,
    });

  } catch (error) {
    return res.status(200).json({
      success: false,
      error:   error.message,
    });
  }
}
