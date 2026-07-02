// pages/api/trade.js — استراتيجية EV+ (قيمة متوقعة موجبة)
// ════════════════════════════════════════════════════════════════════════
//  الفلسفة: صفقات أقل + جودة أعلى + R:R لا يقل عن 2
//  ✅ هدف 2% / وقف 1% → تحتاج 34% نجاح فقط لتربح
//  ✅ نقل الوقف للتعادل بعد +1% (الرابحة لا تنقلب خاسرة)
//  ✅ قاطع دائرة يومي: توقف عند -2% خسارة أو +2% ربح (قفل الربح)
//  ✅ خروج زمني قبل الإغلاق بـ 20 دقيقة
//  ⚠️ لا يوجد نظام يضمن ربحاً يومياً — هذا تصميم سليم رياضياً فقط
// ════════════════════════════════════════════════════════════════════════

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";
const ALPACA_DATA   = "https://data.alpaca.markets";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.RADARAZ_SUPABASE_KEY;

// ════════════════════════════════════════════════════════════════════════
//  STRATEGY — إعدادات صارمة بقيمة متوقعة موجبة
// ════════════════════════════════════════════════════════════════════════

const STRATEGY = {
  engine: "ev_plus",

  // ─── فلاتر الدخول (صارمة عمداً) ─────────────────────
  minScore: 68,           // جودة عالية فقط
  minPrice: 3,            // تجنب أسهم البنس شديدة التذبذب
  minChangePct: 1.5,      // زخم حقيقي
  maxChangePct: 8,        // لا نلاحق سهماً انفجر بالفعل
  minVolume: 150_000,
  minRvol: 1.5,           // سيولة نسبية فوق المعدل
  minRSI: 45,
  maxRSI: 70,             // لا دخول في تشبع شرائي
  requireAboveVWAP: true, // فوق VWAP فقط (إن توفر)
  requireValidStructure: true, // بنية "صحيح" فقط
  maxDriftPct: 0.02,      // السعر الحي لا يبعد أكثر من 2% عن سعر الرادار

  // ─── الأهداف والوقف (R:R = 2) ───────────────────────
  TARGET_PROFIT: 0.02,    // 2%
  STOP_LOSS: 0.01,        // 1%
  BREAKEVEN_TRIGGER: 0.01,   // عند +1% → انقل الوقف للتعادل
  BREAKEVEN_OFFSET: 0.001,   // التعادل + 0.1% (تغطية العمولات/الانزلاق)

  // ─── إدارة المخاطر ──────────────────────────────────
  riskPerTradePct: 0.01,    // 1% من الرصيد مخاطرة لكل صفقة
  maxPositionPct: 0.20,
  minPositionPct: 0.02,
  maxDeployedPct: 0.60,
  maxTrades: 5,             // تركيز بدل تشتيت

  // ─── قاطع الدائرة اليومي ────────────────────────────
  DAILY_MAX_LOSS_PCT: -2.0,  // توقف عن الدخول عند خسارة يومية 2%
  DAILY_PROFIT_LOCK_PCT: 2.0, // توقف عن الدخول عند ربح يومي 2% (قفل الربح)

  // ─── الخروج الزمني ──────────────────────────────────
  FORCE_EXIT_MINS_BEFORE_CLOSE: 20, // إغلاق كل المراكز قبل 3:40 م ET
};

// ════════════════════════════════════════════════════════════════════════
//  HEADERS
// ════════════════════════════════════════════════════════════════════════

const H    = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET, "Content-Type": "application/json" };
const SB_H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

// ════════════════════════════════════════════════════════════════════════
//  دوال Alpaca
// ════════════════════════════════════════════════════════════════════════

async function getAccount() {
  const r = await fetch(`${ALPACA_BASE}/v2/account`, { headers: H });
  return r.json();
}

async function getAllPositions() {
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: H });
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

async function getLatestPrice(sym) {
  try {
    const r = await fetch(`${ALPACA_DATA}/v2/stocks/${sym}/trades/latest`, { headers: H });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.trade?.p ?? null;
  } catch {
    return null;
  }
}

async function getOpenOrders(sym) {
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/orders?status=open&symbols=${sym}&nested=true`, { headers: H });
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

async function cancelOrder(id) {
  try {
    await fetch(`${ALPACA_BASE}/v2/orders/${id}`, { method: "DELETE", headers: H });
  } catch {}
}

async function cancelAll(sym) {
  const oo = await getOpenOrders(sym);
  for (const o of oo) await cancelOrder(o.id);
}

async function buyBracket(sym, qty, tp, sl) {
  const dec = (Number(tp) < 1 || Number(sl) < 1) ? 4 : 2;
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      symbol: sym,
      qty: String(qty),
      side: "buy",
      type: "market",
      time_in_force: "day",
      order_class: "bracket",
      take_profit: { limit_price: Number(tp).toFixed(dec) },
      stop_loss:   { stop_price:  Number(sl).toFixed(dec) },
    }),
  });
  return r.json();
}

// تحديث وقف الخسارة في أمر البراكِت المفتوح (لنقل التعادل)
async function replaceStopOrder(sym, newStop) {
  try {
    const orders = await getOpenOrders(sym);
    const stopLeg = orders
      .flatMap(o => [o, ...(o.legs || [])])
      .find(o => o.type === "stop" && o.side === "sell" && o.status !== "filled");
    if (!stopLeg) return false;
    const dec = newStop < 1 ? 4 : 2;
    const r = await fetch(`${ALPACA_BASE}/v2/orders/${stopLeg.id}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ stop_price: Number(newStop).toFixed(dec) }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function closePosition(sym) {
  try {
    await fetch(`${ALPACA_BASE}/v2/positions/${sym}`, { method: "DELETE", headers: H });
  } catch {}
}

// ════════════════════════════════════════════════════════════════════════
//  دوال Supabase
// ════════════════════════════════════════════════════════════════════════

async function planList() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/bot_positions?status=eq.active&select=*`, { headers: SB_H });
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

async function planSave(p) {
  p.updated_at = new Date().toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/bot_positions?on_conflict=symbol`, {
    method: "POST",
    headers: { ...SB_H, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(p),
  });
}

async function planClose(sym) {
  await fetch(`${SUPABASE_URL}/rest/v1/bot_positions?symbol=eq.${sym}`, {
    method: "PATCH",
    headers: SB_H,
    body: JSON.stringify({ status: "closed", updated_at: new Date().toISOString() }),
  });
}

// ════════════════════════════════════════════════════════════════════════
//  قاطع الدائرة اليومي — حساب أداء اليوم من Alpaca
// ════════════════════════════════════════════════════════════════════════

async function getDailyPnlPct(acct) {
  const equity = parseFloat(acct.equity || 0);
  const lastEquity = parseFloat(acct.last_equity || 0);
  if (!equity || !lastEquity) return 0;
  return ((equity - lastEquity) / lastEquity) * 100;
}

// ════════════════════════════════════════════════════════════════════════
//  إدارة المراكز المفتوحة
//  - نقل الوقف للتعادل بعد +1%
//  - خروج زمني قبل الإغلاق
//  (الهدف والوقف الأساسيان يديرهما أمر البراكِت لدى Alpaca — أدق من polling)
// ════════════════════════════════════════════════════════════════════════

async function manageOpenPositions(forceExit) {
  const results = [];
  try {
    const positions = await getAllPositions();
    if (!positions.length) return results;

    const plans = await planList();
    const planMap = new Map(plans.map(p => [p.symbol, p]));

    for (const pos of positions) {
      const symbol = pos.symbol;
      const currentPrice = parseFloat(pos.current_price);
      const avgEntry = parseFloat(pos.avg_entry_price);
      const pnlPct = ((currentPrice - avgEntry) / avgEntry) * 100;
      const plan = planMap.get(symbol);

      // ⏰ خروج زمني قبل الإغلاق — لا نبيّت مراكز مضاربة يومية
      if (forceExit) {
        await cancelAll(symbol);
        await closePosition(symbol);
        await planClose(symbol);
        results.push({ symbol, action: "⏰ خروج زمني قبل الإغلاق", pnl: pnlPct.toFixed(2) + "%" });
        continue;
      }

      // 🔒 نقل الوقف للتعادل بعد +1%
      if (plan && !plan.be_moved && pnlPct >= STRATEGY.BREAKEVEN_TRIGGER * 100) {
        const newStop = avgEntry * (1 + STRATEGY.BREAKEVEN_OFFSET);
        const ok = await replaceStopOrder(symbol, newStop);
        if (ok) {
          await planSave({ ...plan, be_moved: true, stop: +newStop.toFixed(4) });
          results.push({ symbol, action: "🔒 وقف → تعادل", pnl: pnlPct.toFixed(2) + "%" });
        }
      }
    }
  } catch (error) {
    console.error("❌ خطأ في إدارة المراكز:", error);
  }
  return results;
}

// ════════════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  try {
    const log = { managed: [], entered: [], skipped: [] };
    const debug = { phase: "manage_only" };

    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const mins = et.getHours() * 60 + et.getMinutes();
    const day = et.getDay();
    const weekend = day === 0 || day === 6;

    const MARKET_OPEN = 570;   // 9:30
    const MARKET_CLOSE = 960;  // 16:00
    const forceExitAt = MARKET_CLOSE - STRATEGY.FORCE_EXIT_MINS_BEFORE_CLOSE; // 15:40

    const canManage = !weekend && mins >= MARKET_OPEN && mins <= MARKET_CLOSE;
    // لا دخول في أول 15 دقيقة (تذبذب الافتتاح) ولا بعد 2:30 م (لا وقت كافٍ للهدف)
    const canEnterWindow = !weekend && mins >= MARKET_OPEN + 15 && mins < 870;
    const forceExit = !weekend && mins >= forceExitAt;

    if (!canManage) {
      return res.status(200).json({
        success: true,
        message: "خارج ساعات الإدارة",
        time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      });
    }

    // ═══ المرحلة 1: إدارة المراكز المفتوحة ═══
    log.managed = await manageOpenPositions(forceExit);

    // ═══ قاطع الدائرة اليومي ═══
    const acct = await getAccount();
    const dailyPnl = await getDailyPnlPct(acct);
    debug.daily_pnl_pct = +dailyPnl.toFixed(2);

    let circuitBreaker = null;
    if (dailyPnl <= STRATEGY.DAILY_MAX_LOSS_PCT) {
      circuitBreaker = `🛑 قاطع الدائرة: خسارة يومية ${dailyPnl.toFixed(2)}% — لا دخول جديد اليوم`;
    } else if (dailyPnl >= STRATEGY.DAILY_PROFIT_LOCK_PCT) {
      circuitBreaker = `🔒 قفل الربح: ربح يومي ${dailyPnl.toFixed(2)}% — تم تحقيق هدف اليوم`;
    }

    // ═══ المرحلة 2: دخول صفقات جديدة ═══
    if (canEnterWindow && !forceExit && !circuitBreaker) {
      const todayET = et.toISOString().split("T")[0];
      let candidates = [];

      try {
        const sr = await fetch(
          `${SUPABASE_URL}/rest/v1/signals?select=*&signal_date=eq.${todayET}&score=gte.${STRATEGY.minScore}&order=score.desc&limit=100`,
          { headers: SB_H }
        );
        if (sr.ok) {
          const rows = await sr.json();
          candidates = (Array.isArray(rows) ? rows : []).map(r => ({ ...r, price: r.entry_price }));
        }
      } catch {}

      // ─── الفلاتر الصارمة ──────────────────────────────
      const filtered = candidates.filter(s => {
        if (s.score < STRATEGY.minScore) return false;
        if (s.price < STRATEGY.minPrice) return false;
        if (s.change_pct < STRATEGY.minChangePct || s.change_pct > STRATEGY.maxChangePct) return false;
        if (s.volume < STRATEGY.minVolume) return false;
        if (s.rvol != null && s.rvol < STRATEGY.minRvol) return false;
        if (s.rsi != null && (s.rsi < STRATEGY.minRSI || s.rsi > STRATEGY.maxRSI)) return false;
        if (STRATEGY.requireAboveVWAP && s.vwap && s.price <= s.vwap) return false;
        if (!s.structure || s.structure.stop == null || s.structure.t1 == null) return false;
        const f = s.structure.flag || "";
        if (STRATEGY.requireValidStructure && f.indexOf("صحيح") < 0) return false;
        if (f.indexOf("ملاحقة") >= 0 || f.indexOf("غير مؤكد") >= 0 || f.indexOf("هابط") >= 0) return false;
        return true;
      });

      filtered.sort((a, b) => {
        if (!!b.is_target !== !!a.is_target) return b.is_target ? 1 : -1;
        return (b.score || 0) - (a.score || 0);
      });

      const balance = parseFloat(acct.equity || acct.cash || 0);
      const positions = await getAllPositions();
      const activePlans = await planList();
      const openSymbols = new Set([...positions.map(p => p.symbol), ...activePlans.map(p => p.symbol)]);
      let openCount = openSymbols.size;
      let deployed = positions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || 0)), 0);
      const maxDeployed = balance * STRATEGY.maxDeployedPct;

      for (const s of filtered) {
        if (openCount >= STRATEGY.maxTrades) break;
        if (openSymbols.has(s.symbol)) continue;

        const live = await getLatestPrice(s.symbol);
        const px = live || Number(s.price);
        if (!px) {
          log.skipped.push({ symbol: s.symbol, reason: "لا يوجد سعر" });
          continue;
        }

        // السعر الحي لا يبعد كثيراً عن سعر الرادار (منع الملاحقة)
        const radarPx = Number(s.price) || px;
        const drift = (px - radarPx) / radarPx;
        if (drift > STRATEGY.maxDriftPct) {
          log.skipped.push({ symbol: s.symbol, reason: `سعر متأخر ${(drift * 100).toFixed(1)}%` });
          continue;
        }

        // ─── الأهداف: R:R = 2 ثابت ─────────────────────
        const stopPx = px * (1 - STRATEGY.STOP_LOSS);
        const t1 = px * (1 + STRATEGY.TARGET_PROFIT);
        const riskPerShare = px - stopPx;

        // ─── حجم المركز: مخاطرة 1% من الرصيد ───────────
        let fullValue = (balance * STRATEGY.riskPerTradePct) * px / riskPerShare;
        fullValue = Math.min(fullValue, balance * STRATEGY.maxPositionPct);

        if (fullValue < balance * STRATEGY.minPositionPct) {
          log.skipped.push({ symbol: s.symbol, reason: "تحت أرضية المركز" });
          continue;
        }
        if (deployed + fullValue > maxDeployed) {
          log.skipped.push({ symbol: s.symbol, reason: "بلغ سقف الانتشار" });
          break;
        }

        const qty = Math.floor(fullValue / px);
        if (qty < 2) {
          log.skipped.push({ symbol: s.symbol, reason: "كمية صغيرة" });
          continue;
        }

        // ─── تنفيذ الأمر (براكِت: الهدف والوقف لدى Alpaca) ─
        const buy = await buyBracket(s.symbol, qty, t1, stopPx);
        if (buy.status === "rejected" || buy.code) {
          log.skipped.push({ symbol: s.symbol, reason: "رُفض البراكِت", err: buy.message || null });
          continue;
        }

        await planSave({
          symbol: s.symbol,
          status: "active",
          initial_qty: qty,
          total_qty: qty,
          avg_entry: px,
          stop: +stopPx.toFixed(4),
          t1: +t1.toFixed(4),
          be_moved: false,
          stock_type: s.type || "مضاربة",
          is_sniper: false,
        });

        deployed += qty * px;
        openCount++;
        openSymbols.add(s.symbol);

        log.entered.push({
          symbol: s.symbol,
          px: +px.toFixed(2),
          qty,
          stop: +stopPx.toFixed(2),
          tp: +t1.toFixed(2),
          rr: 2.0,
          score: s.score,
        });
      }

      const skipTally = {};
      for (const sk of log.skipped) skipTally[sk.reason] = (skipTally[sk.reason] || 0) + 1;

      debug.phase = "enter";
      debug.candidates = candidates.length;
      debug.after_filter = filtered.length;
      debug.entered = log.entered.length;
      debug.skip_reasons = skipTally;
      debug.deployed_pct = balance > 0 ? Math.round((deployed / balance) * 100) : 0;
    } else if (circuitBreaker) {
      debug.phase = "circuit_breaker";
      debug.message = circuitBreaker;
    }

    return res.status(200).json({
      success: true,
      engine: STRATEGY.engine,
      time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      circuit_breaker: circuitBreaker,
      debug,
      ...log,
    });

  } catch (e) {
    console.error("❌ خطأ:", e);
    return res.status(200).json({
      success: false,
      error: e.message,
    });
  }
}
