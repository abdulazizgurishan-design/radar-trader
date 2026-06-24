// /api/stats.js — تشخيص صفقات البوت (مثل لوحة تشخيص الرادار، بس للتنفيذ الحقيقي)
// يقرأ الأوامر المغلقة من Alpaca، يطابق الشراء مع البيع لكل سهم،
// ويحسب: رابح/خاسر · Profit Factor · خروج بوقف vs هدف · صافي الربح.
// قراءة فقط — لا ينفّذ أي أمر. آمن تماماً.

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const BASE          = "https://paper-api.alpaca.markets";

const H = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };

async function getClosedOrders(limit = 500) {
  // نجلب الأوامر المنفّذة فقط (filled) — أحدث أولاً
  const url = `${BASE}/v2/orders?status=closed&limit=${limit}&direction=desc`;
  const r = await fetch(url, { headers: H });
  if (!r.ok) return [];
  const all = await r.json();
  return Array.isArray(all) ? all.filter(o => o.filled_at && parseFloat(o.filled_qty || 0) > 0) : [];
}

// مطابقة الصفقات بأسلوب FIFO لكل سهم:
//   كل شراء يفتح/يزيد مركزاً، وكل بيع يغلق جزءاً منه ويحقّق ربح/خسارة.
function buildTrades(orders) {
  // رتّب زمنياً تصاعدياً (الأقدم أولاً) لمطابقة صحيحة
  const chron = [...orders].sort((a, b) => new Date(a.filled_at) - new Date(b.filled_at));

  const lots = {};     // symbol -> [{ qty, price, time }]  (مشتريات مفتوحة)
  const trades = [];   // صفقات مغلقة (شراء↔بيع)

  for (const o of chron) {
    const sym   = o.symbol;
    const side  = o.side;                              // buy / sell
    const qty   = parseFloat(o.filled_qty || 0);
    const price = parseFloat(o.filled_avg_price || 0);
    const time  = o.filled_at;
    if (!qty || !price) continue;

    if (!lots[sym]) lots[sym] = [];

    if (side === "buy") {
      lots[sym].push({ qty, price, time });
    } else if (side === "sell") {
      let remaining = qty;
      while (remaining > 0 && lots[sym].length) {
        const lot = lots[sym][0];
        const matchQty = Math.min(remaining, lot.qty);
        const pnl = (price - lot.price) * matchQty;          // ربح/خسارة هذي القطعة
        const pnlPct = lot.price > 0 ? ((price - lot.price) / lot.price) * 100 : 0;
        const holdMin = (new Date(time) - new Date(lot.time)) / 60000;
        trades.push({
          symbol: sym,
          entry: lot.price, exit: price, qty: matchQty,
          pnl, pnlPct: +pnlPct.toFixed(2),
          entryTime: lot.time, exitTime: time,
          holdMin: Math.round(holdMin),
        });
        lot.qty -= matchQty;
        remaining -= matchQty;
        if (lot.qty <= 0.0000001) lots[sym].shift();
      }
      // لو بعنا أكثر من المملوك (نادر/short) نتجاهل الزائد
    }
  }
  return trades;
}

function analyze(trades) {
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const flat   = trades.filter(t => t.pnl === 0);

  const grossWin  = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const netPnl    = trades.reduce((a, t) => a + t.pnl, 0);

  const avgWin  = wins.length   ? grossWin  / wins.length   : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  // Profit Factor = إجمالي الأرباح ÷ إجمالي الخسائر (>1 = رابح، <1 = خاسر)
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
  // متوسط الربح ÷ متوسط الخسارة (Payoff) — هل الرابح يغطّي الخاسر؟
  const payoff = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 999 : 0);

  const decided  = wins.length + losses.length;
  const winRate  = decided ? (wins.length / decided) * 100 : 0;

  // أكبر رابح وأكبر خاسر (للسياق)
  const best  = trades.reduce((m, t) => (!m || t.pnl > m.pnl) ? t : m, null);
  const worst = trades.reduce((m, t) => (!m || t.pnl < m.pnl) ? t : m, null);

  // متوسط مدة الإمساك
  const avgHold = trades.length ? Math.round(trades.reduce((a, t) => a + t.holdMin, 0) / trades.length) : 0;

  return {
    total_trades: trades.length,
    wins: wins.length, losses: losses.length, flat: flat.length,
    win_rate_pct: +winRate.toFixed(1),
    net_pnl: +netPnl.toFixed(2),
    gross_win: +grossWin.toFixed(2),
    gross_loss: +grossLoss.toFixed(2),
    avg_win: +avgWin.toFixed(2),
    avg_loss: +avgLoss.toFixed(2),
    profit_factor: +profitFactor.toFixed(2),
    payoff_ratio: +payoff.toFixed(2),
    avg_hold_min: avgHold,
    best:  best  ? { symbol: best.symbol,  pnl: +best.pnl.toFixed(2),  pct: best.pnlPct }  : null,
    worst: worst ? { symbol: worst.symbol, pnl: +worst.pnl.toFixed(2), pct: worst.pnlPct } : null,
  };
}

// الحكم التلقائي: هل الاستراتيجية رابحة؟ وما العلاج؟
function verdict(a) {
  if (a.total_trades < 10) {
    return {
      status: "عيّنة صغيرة",
      message: `فقط ${a.total_trades} صفقة — لا يكفي للحكم. انتظر 20-30 صفقة قبل أي قرار.`,
    };
  }
  if (a.profit_factor >= 1.5) {
    return { status: "رابح قوي ✅", message: `Profit Factor ${a.profit_factor} ممتاز. الاستراتيجية رابحة — لا تغيّرها.` };
  }
  if (a.profit_factor >= 1.0) {
    return { status: "رابح حدّي 🟡", message: `Profit Factor ${a.profit_factor} فوق 1 بقليل. رابح لكن هش — حسّن نسبة الربح/الخسارة.` };
  }
  // خاسر — شخّص السبب
  if (a.payoff_ratio < 1 && a.win_rate_pct >= 50) {
    return { status: "خاسر — الوقف ضيق 🔴", message: `تربح كثيراً (${a.win_rate_pct}%) لكن خسائرك أكبر من أرباحك (payoff ${a.payoff_ratio}). الوقف يُضرب مبكراً أو الهدف قريب جداً. وسّع الهدف أو الوقف.` };
  }
  if (a.win_rate_pct < 45) {
    return { status: "خاسر — اختيار سيء 🔴", message: `نسبة الربح ${a.win_rate_pct}% منخفضة. مشكلة في اختيار الأسهم (الدخول)، مو الإدارة.` };
  }
  return { status: "خاسر 🔴", message: `Profit Factor ${a.profit_factor} تحت 1. راجع الوقف والهدف معاً.` };
}

export default async function handler(req, res) {
  try {
    if (!ALPACA_KEY || !ALPACA_SECRET) {
      return res.status(200).json({ error: "no_alpaca_keys" });
    }
    const orders = await getClosedOrders(500);
    const trades = buildTrades(orders);
    const stats  = analyze(trades);
    const judge  = verdict(stats);

    // آخر 15 صفقة للعرض (الأحدث أولاً)
    const recent = [...trades].reverse().slice(0, 15).map(t => ({
      symbol: t.symbol, entry: t.entry, exit: t.exit, qty: t.qty,
      pnl: +t.pnl.toFixed(2), pct: t.pnlPct, hold_min: t.holdMin,
      result: t.pnl > 0 ? "رابح" : t.pnl < 0 ? "خاسر" : "تعادل",
    }));

    return res.status(200).json({
      success: true,
      stats,
      verdict: judge,
      recent_trades: recent,
      raw_orders_count: orders.length,
    });
  } catch (e) {
    return res.status(200).json({ success: false, error: e.message });
  }
}
