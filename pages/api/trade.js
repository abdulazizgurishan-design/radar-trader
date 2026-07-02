// ============================================================
// trade.js — MONEY MACHINE v2 💰 (مدمج مع النسخة القديمة)
// استراتيجية: زخم + أهداف صغيرة (0.7%) + وقف ضيق (0.5%)
// ============================================================

const ALPACA_KEY = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE = "https://paper-api.alpaca.markets";
const ALPACA_DATA = "https://data.alpaca.markets";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.RADARAZ_SUPABASE_KEY;

// ─── الإعدادات (مدمجة) ────────────────────────────────────
const CONFIG = {
  // 🎯 الأهداف والوقف
  TARGET_PROFIT: 0.007,      // 0.7%
  STOP_LOSS: 0.005,          // 0.5%
  MIN_RR: 1.2,
  
  // 🔍 فلاتر مخففة (مثل النسخة القديمة)
  MIN_SCORE: 55,
  MIN_PRICE: 2,
  MIN_CHANGE: 1.0,
  MAX_CHANGE: 15,
  MIN_VOLUME: 100000,
  MIN_RVOL: 1.0,
  MIN_RSI: 40,
  MAX_RSI: 80,
  MAX_DRIFT: 0.05,
  
  // 📊 إدارة المخاطر
  RISK_PER_TRADE: 0.015,
  MAX_POSITIONS: 8,
  MAX_DEPLOYED: 0.70,
  MIN_POSITION: 0.03,
  
  // 🚀 الدخول
  ENTRY_BUFFER: 1.01,
  
  // 🛡️ حماية
  MAX_SPREAD: 0.03,
  COOLDOWN_MINUTES: 3,
};

// ─── headers ──────────────────────────────────────────────
const H = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type": "application/json",
};

const SB_H = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

// ─── Vercel Hobby ────────────────────────────────────────────
export const config = {
  maxDuration: 10,
};

// ─── دوال Alpaca ──────────────────────────────────────────
async function getAccount() {
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/account`, { headers: H });
    return r.json();
  } catch {
    return { equity: 0, cash: 0 };
  }
}

async function getPositions() {
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

async function getQuote(sym) {
  try {
    const r = await fetch(`${ALPACA_DATA}/v2/stocks/${sym}/quotes/latest`, { headers: H });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.quote ?? null;
  } catch {
    return null;
  }
}

async function getOpenOrders(sym) {
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/orders?status=open`, { headers: H });
    const d = await r.json();
    if (!Array.isArray(d)) return [];
    return sym ? d.filter(o => o.symbol === sym) : d;
  } catch {
    return [];
  }
}

async function cancelAllOrders(sym) {
  try {
    const orders = await getOpenOrders(sym);
    for (const o of orders) {
      await fetch(`${ALPACA_BASE}/v2/orders/${o.id}`, { method: "DELETE", headers: H });
    }
  } catch {}
}

async function closePosition(sym) {
  try {
    await fetch(`${ALPACA_BASE}/v2/positions/${sym}`, { method: "DELETE", headers: H });
  } catch {}
}

// ─── أمر شراء مع وقف وهدف ──────────────────────────────────
async function buyWithProtection(sym, qty, price, stop, target) {
  const dec = price < 1 ? 4 : 2;
  
  const order = {
    symbol: sym,
    qty: String(qty),
    side: "buy",
    type: "limit",
    limit_price: price.toFixed(dec),
    time_in_force: "day",
    order_class: "bracket",
    take_profit: {
      limit_price: target.toFixed(dec),
    },
    stop_loss: {
      stop_price: stop.toFixed(dec),
      limit_price: (stop * 0.99).toFixed(dec),
    },
  };
  
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
      method: "POST",
      headers: H,
      body: JSON.stringify(order),
    });
    return r.json();
  } catch (e) {
    return { status: "rejected", message: e.message };
  }
}

// ─── إدارة المراكز المفتوحة ──────────────────────────────
async function manageOpenPositions() {
  const results = [];
  
  try {
    const positions = await getPositions();
    if (!Array.isArray(positions) || positions.length === 0) {
      return results;
    }
    
    for (const pos of positions) {
      const symbol = pos.symbol;
      const currentPrice = parseFloat(pos.current_price);
      const avgEntry = parseFloat(pos.avg_entry_price);
      const qty = parseInt(pos.qty);
      const pnlPct = ((currentPrice - avgEntry) / avgEntry) * 100;
      
      // 🎯 تحقيق الهدف
      if (pnlPct >= CONFIG.TARGET_PROFIT * 100) {
        await cancelAllOrders(symbol);
        await closePosition(symbol);
        results.push({
          symbol,
          action: "✅ هدف محقق",
          pnl: pnlPct.toFixed(2) + "%",
          price: currentPrice,
        });
        continue;
      }
      
      // 🛑 وقف الخسارة
      if (pnlPct <= -CONFIG.STOP_LOSS * 100) {
        await cancelAllOrders(symbol);
        await closePosition(symbol);
        results.push({
          symbol,
          action: "🛑 وقف خسارة",
          pnl: pnlPct.toFixed(2) + "%",
          price: currentPrice,
        });
        continue;
      }
      
      // ⏳ تتبع وقف (Trailing)
      if (pnlPct >= 0.3) {
        const newStop = currentPrice * (1 - CONFIG.STOP_LOSS);
        await cancelAllOrders(symbol);
        const target = avgEntry * (1 + CONFIG.TARGET_PROFIT);
        const order = {
          symbol,
          qty: String(qty),
          side: "sell",
          type: "limit",
          limit_price: target.toFixed(2),
          time_in_force: "day",
          order_class: "bracket",
          stop_loss: {
            stop_price: newStop.toFixed(2),
            limit_price: (newStop * 0.99).toFixed(2),
          },
        };
        await fetch(`${ALPACA_BASE}/v2/orders`, {
          method: "POST",
          headers: H,
          body: JSON.stringify(order),
        });
        
        results.push({
          symbol,
          action: "🔒 تحديث الوقف",
          newStop: newStop.toFixed(2),
          pnl: pnlPct.toFixed(2) + "%",
        });
      }
    }
  } catch (error) {
    console.error("❌ خطأ في إدارة المراكز:", error);
  }
  
  return results;
}

// ─── الدالة الرئيسية ──────────────────────────────────────
export default async function handler(req, res) {
  const startTime = Date.now();
  const log = {
    entered: [],
    skipped: [],
    managed: [],
    errors: [],
  };
  
  try {
    // ─── التحقق من السر (مثل النسخة القديمة) ──────────────
    const secret = req.query.secret;
    // إذا كان المفتاح موجوداً، تحقق منه (متوافق مع النسخة القديمة)
    if (secret && secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "غير مصرح" });
    }
    // إذا لم يكن هناك مفتاح، استمر (مثل النسخة القديمة التي كانت تعمل)
    
    // ─── التحقق من وقت التداول ──────────────────────────
    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const mins = et.getHours() * 60 + et.getMinutes();
    const day = et.getDay();
    
    if (day === 0 || day === 6) {
      return res.status(200).json({
        success: true,
        message: "⏸️ عطلة نهاية الأسبوع",
        time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      });
    }
    
    const isTradingTime = mins >= 570 && mins <= 960;
    if (!isTradingTime) {
      return res.status(200).json({
        success: true,
        message: "⏳ خارج ساعات التداول",
        time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      });
    }
    
    // ─── إدارة المراكز المفتوحة ──────────────────────────
    log.managed = await manageOpenPositions();
    
    // ─── جلب بيانات الحساب ──────────────────────────────
    const account = await getAccount();
    const balance = parseFloat(account.equity || account.cash || 0);
    if (balance <= 0) {
      return res.status(200).json({
        success: true,
        message: "⚠️ رصيد غير كافٍ",
        balance: 0,
      });
    }
    
    // ─── جلب الإشارات من Supabase ──────────────────────
    const todayET = new Date().toISOString().split("T")[0];
    const url = `${SUPABASE_URL}/rest/v1/signals`
      + `?select=*`
      + `&signal_date=eq.${todayET}`
      + `&order=score.desc`
      + `&limit=100`;
    
    const sr = await fetch(url, { headers: SB_H });
    if (!sr.ok) {
      throw new Error(`Supabase error: ${sr.status}`);
    }
    const signals = await sr.json();
    
    if (!Array.isArray(signals) || signals.length === 0) {
      return res.status(200).json({
        success: true,
        message: "📭 لا توجد إشارات اليوم",
        candidates: 0,
      });
    }
    
    console.log(`📊 جلب ${signals.length} إشارة من Supabase`);
    
    // ─── الفلترة ──────────────────────────────────────────
    let candidates = signals.filter(s => {
      const price = s.entry_price || 0;
      const change = s.change_pct || 0;
      const volume = s.volume || 0;
      
      if (s.score < CONFIG.MIN_SCORE) return false;
      if (price < CONFIG.MIN_PRICE) return false;
      if (change < CONFIG.MIN_CHANGE || change > CONFIG.MAX_CHANGE) return false;
      if (volume < CONFIG.MIN_VOLUME) return false;
      if (s.rsi !== null && (s.rsi > CONFIG.MAX_RSI || s.rsi < CONFIG.MIN_RSI)) return false;
      if (s.rvol && s.rvol < CONFIG.MIN_RVOL) return false;
      if (s.vwap && price <= s.vwap) return false;
      
      return true;
    });
    
    console.log(`🔍 بعد الفلترة: ${candidates.length} إشارة`);
    
    // ─── ترتيب حسب الأولوية ────────────────────────────
    candidates.sort((a, b) => {
      if (b.is_target !== a.is_target) return b.is_target ? 1 : -1;
      if (b.early_watch !== a.early_watch) return b.early_watch ? 1 : -1;
      if (b.is_hot !== a.is_hot) return b.is_hot ? 1 : -1;
      return (b.score || 0) - (a.score || 0);
    });
    
    // ─── التحقق من المراكز المفتوحة ─────────────────────
    const positions = await getPositions();
    const openSymbols = new Set(positions.map(p => p.symbol));
    let openCount = openSymbols.size;
    let deployed = positions.reduce((sum, p) => sum + parseFloat(p.market_value || 0), 0);
    const maxDeploy = balance * CONFIG.MAX_DEPLOYED;
    
    // ─── تنفيذ الصفقات ──────────────────────────────────
    let entered = 0;
    let skippedCount = 0;
    const skipDetails = [];
    
    for (const s of candidates) {
      if (openCount >= CONFIG.MAX_POSITIONS) break;
      if (deployed >= maxDeploy) break;
      
      const symbol = s.symbol;
      if (openSymbols.has(symbol)) continue;
      
      // ─── السعر الحي ──────────────────────────────────
      const livePrice = await getLatestPrice(symbol);
      const radarPrice = s.entry_price || 0;
      const price = livePrice || radarPrice;
      
      if (!price || price <= 0) {
        skippedCount++;
        skipDetails.push({ symbol, reason: "لا يوجد سعر" });
        continue;
      }
      
      // التحقق من الانحراف
      if (radarPrice > 0) {
        const drift = ((price - radarPrice) / radarPrice);
        if (Math.abs(drift) > CONFIG.MAX_DRIFT) {
          skippedCount++;
          skipDetails.push({ symbol, reason: `انحراف ${(drift*100).toFixed(1)}%` });
          continue;
        }
      }
      
      // ─── التحقق من السبريد ──────────────────────────
      const quote = await getQuote(symbol);
      if (quote) {
        const spread = quote.ask_price - quote.bid_price;
        if (spread > CONFIG.MAX_SPREAD) {
          skippedCount++;
          skipDetails.push({ symbol, reason: `سبريد ${spread.toFixed(3)}` });
          continue;
        }
      }
      
      // ─── حساب الأهداف والوقف ────────────────────────
      const target = price * (1 + CONFIG.TARGET_PROFIT);
      const stop = price * (1 - CONFIG.STOP_LOSS);
      
      const risk = price - stop;
      const reward = target - price;
      const rr = reward / risk;
      
      if (rr < CONFIG.MIN_RR || risk <= 0) {
        skippedCount++;
        skipDetails.push({ symbol, reason: `RR ${rr.toFixed(2)}` });
        continue;
      }
      
      // ─── حساب حجم المركز ────────────────────────────
      const riskAmount = balance * CONFIG.RISK_PER_TRADE;
      let qty = Math.floor(riskAmount / risk);
      
      if (qty < 2) {
        skippedCount++;
        skipDetails.push({ symbol, reason: "كمية صغيرة" });
        continue;
      }
      
      const maxQty = Math.floor((balance * CONFIG.MAX_POSITIONS * 0.1) / price);
      const finalQty = Math.min(qty, maxQty);
      
      if (finalQty < 2) {
        skippedCount++;
        skipDetails.push({ symbol, reason: "كمية محدودة" });
        continue;
      }
      
      // ─── تنفيذ الأمر ────────────────────────────────
      const order = await buyWithProtection(symbol, finalQty, price, stop, target);
      
      if (order.status === "rejected" || order.code) {
        skippedCount++;
        skipDetails.push({ symbol, reason: "رفض", error: order.message || order.code });
        continue;
      }
      
      // ─── تحديث الإحصائيات ──────────────────────────
      openSymbols.add(symbol);
      openCount++;
      deployed += finalQty * price;
      entered++;
      
      log.entered.push({
        symbol,
        price: price.toFixed(2),
        qty: finalQty,
        target: target.toFixed(2),
        stop: stop.toFixed(2),
        rr: rr.toFixed(2),
        score: s.score,
        rsi: s.rsi,
        rvol: s.rvol,
      });
      
      // ─── حفظ الصفقة في Supabase ──────────────────────
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/bot_positions`, {
          method: "POST",
          headers: { ...SB_H, Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            symbol,
            qty: finalQty,
            avg_entry: price,
            stop_loss: stop,
            target: target,
            score: s.score,
            status: "active",
            created_at: new Date().toISOString(),
          }),
        });
      } catch (e) {
        log.errors.push({ symbol, error: e.message });
      }
    }
    
    // ─── الإحصائيات النهائية ──────────────────────────
    const totalTime = Date.now() - startTime;
    
    const skipSummary = {};
    for (const sk of skipDetails) {
      skipSummary[sk.reason] = (skipSummary[sk.reason] || 0) + 1;
    }
    
    return res.status(200).json({
      success: true,
      strategy: "MONEY_MACHINE_v2",
      source: "RadarAZ",
      time_ms: totalTime,
      time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      balance: balance.toFixed(2),
      positions: openCount,
      deployed: ((deployed / balance) * 100).toFixed(1) + "%",
      entered,
      skipped: skippedCount,
      managed: log.managed.length,
      skip_summary: skipSummary,
      log: {
        entered: log.entered,
        skipped: skipDetails.slice(0, 10),
        managed: log.managed,
        errors: log.errors,
      },
      config: {
        target: `${(CONFIG.TARGET_PROFIT * 100).toFixed(1)}%`,
        stop: `${(CONFIG.STOP_LOSS * 100).toFixed(1)}%`,
        minScore: CONFIG.MIN_SCORE,
        maxPositions: CONFIG.MAX_POSITIONS,
        minRR: CONFIG.MIN_RR,
        minRvol: CONFIG.MIN_RVOL,
        minRsi: CONFIG.MIN_RSI,
        maxRsi: CONFIG.MAX_RSI,
        minPrice: CONFIG.MIN_PRICE,
        maxDrift: `${(CONFIG.MAX_DRIFT * 100).toFixed(0)}%`,
      },
    });
    
  } catch (error) {
    console.error("❌ خطأ:", error);
    return res.status(200).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
}
