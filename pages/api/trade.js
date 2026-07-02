// pages/api/trade.js — MONEY MACHINE 💰 (معدل حسب الاتفاق)
// ════════════════════════════════════════════════════════════════════════
//  ✅ الهدف: 0.7% (صفقات عادية) | 2% (قناص)
//  ✅ وقف الخسارة: 0.5% (صفقات عادية) | 1.5% (قناص)
//  ✅ خروج فوري (بدون تدرج)
//  ✅ عدد صفقات أكثر (10-15 باليوم)
// ════════════════════════════════════════════════════════════════════════

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";
const ALPACA_DATA   = "https://data.alpaca.markets";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.RADARAZ_SUPABASE_KEY;

// ════════════════════════════════════════════════════════════════════════
//  STRATEGY — الإعدادات المعدلة حسب الاتفاق
// ════════════════════════════════════════════════════════════════════════

const STRATEGY = {
  engine: "smart",
  addEnabled: false,                    // إلغاء التدرج

  // ─── الإعدادات الأساسية ──────────────────────────────
  minScore: 60,                         // 55 ← 60
  minPrice: 3,
  minChangePct: 1.5,                    // 1 ← 1.5
  maxChangePct: 15,                     // 40 ← 15
  minVolume: 150_000,                   // 100K ← 150K
  maxRSI: 72,                           // 75 ← 72
  skipChasers: true,
  minRR: 1.2,                           // 1.0 ← 1.2
  entryBuffer: 1.005,
  minRoomPct: 0.01,

  // ─── الأهداف والوقف (حسب الاتفاق) ────────────────────
  TARGET_PROFIT: 0.007,                 // 0.7% (صفقات عادية)
  STOP_LOSS: 0.005,                     // 0.5% (صفقات عادية)

  // ─── إدارة المخاطر ──────────────────────────────────
  maxLossPct: 0.05,
  maxDriftPct: 0.03,
  riskPerTradePct: 0.015,
  maxPositionPct: 0.25,
  minPositionPct: 0.03,
  maxDeployedPct: 0.70,

  // ─── الدخول/الخروج (مبسط) ──────────────────────────
  initialFraction: 0.70,
  tp1Fraction: 1.0,
  tp1FillNudge: 0.998,
  breakevenAfterTp1: false,
  tieredExit: false,                    // إلغاء التدرج
  scalpT1Sell: 1.0,
  investT1Sell: 1.0,
  trailEnabled: false,                  // إلغاء التتبع
  trailTiers: [],
  maxTrades: 10,                        // 8 ← 10

  // ─── القناص ──────────────────────────────────────────
  sniperEnabled: true,
  sniper: {
    minScore: 68,
    minRvol: 3,                         // 4 ← 3
    minRSI: 50,
    maxRSI: 68,                         // 65 ← 68
    minChange: 2,
    maxChange: 12,                      // 15 ← 12
    minVolume: 300_000,                 // 500K ← 300K
    stopLoss: 0.015,                    // 0.04 ← 0.015 (1.5%)
    target1: 0.02,                      // 0.035 ← 0.02 (2%)
    target2: 0.035,                     // 0.06 ← 0.035
    riskPerTrade: 0.012,
    maxPosition: 0.15,
    maxTrades: 5,                       // 4 ← 5
    requireCross: true,
    requireVCP: false,
  },
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

async function getPositionQty(sym) {
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/positions/${sym}`, { headers: H });
    if (!r.ok) return 0;
    const d = await r.json();
    return Math.abs(parseInt(d.qty)) || 0;
  } catch {
    return 0;
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

async function buyMarket(sym, qty) {
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ symbol: sym, qty: String(qty), side: "buy", type: "market", time_in_force: "day" })
  });
  return r.json();
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
//  دوال حسابية
// ════════════════════════════════════════════════════════════════════════

function calcSMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function isFreshCross(closes, fast = 9, slow = 21) {
  if (!closes || closes.length < slow + 2) return false;
  const fastMA = calcSMA(closes, fast);
  const slowMA = calcSMA(closes, slow);
  const fastPrev = calcSMA(closes.slice(0, -1), fast);
  const slowPrev = calcSMA(closes.slice(0, -1), slow);
  if (!fastMA || !slowMA || !fastPrev || !slowPrev) return false;
  return fastPrev <= slowPrev && fastMA > slowMA;
}

async function fetchHourlyBars(symbol) {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/hour/${from}/${to}?adjusted=true&sort=asc&limit=120&apiKey=${process.env.POLYGON_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.results && data.results.length) ? data.results : null;
  } catch {
    return null;
  }
}

function suitableEntry(st, price, t1, stopPx, minRR, buffer, minRoom) {
  if (!st || !price || !t1 || !stopPx) return false;
  const risk = price - stopPx;
  if (risk <= 0) return false;
  const rr = (t1 - price) / risk;
  return price > st.support &&
         price <= st.confirm * buffer &&
         t1 >= price * (1 + minRoom) &&
         rr >= minRR;
}

// ════════════════════════════════════════════════════════════════════════
//  إدارة المراكز المفتوحة (مبسطة)
// ════════════════════════════════════════════════════════════════════════

async function manageOpenPositions() {
  const results = [];
  try {
    const positions = await getAllPositions();
    if (!Array.isArray(positions) || positions.length === 0) return results;

    for (const pos of positions) {
      const symbol = pos.symbol;
      const currentPrice = parseFloat(pos.current_price);
      const avgEntry = parseFloat(pos.avg_entry_price);
      const pnlPct = ((currentPrice - avgEntry) / avgEntry) * 100;

      // 🎯 هدف 0.7% → خروج فوري
      if (pnlPct >= 0.7) {
        await cancelAll(symbol);
        await closePosition(symbol);
        results.push({ symbol, action: "✅ هدف 0.7%", pnl: pnlPct.toFixed(2) + "%" });
        continue;
      }

      // 🛑 وقف 0.5% → خروج فوري
      if (pnlPct <= -0.5) {
        await cancelAll(symbol);
        await closePosition(symbol);
        results.push({ symbol, action: "🛑 وقف 0.5%", pnl: pnlPct.toFixed(2) + "%" });
        continue;
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
    const log = { managed: [], entered: [], skipped: [], sniper: [] };
    const debug = { phase: "manage_only" };

    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const mins = et.getHours() * 60 + et.getMinutes();
    const day = et.getDay();
    const weekend = day === 0 || day === 6;

    // 9:30 ص - 4:00 م (بتوقيت نيويورك)
    const canManage = !weekend && mins >= 570 && mins <= 960;
    const canEnter = !weekend && mins >= 585 && mins < 945;

    if (!canManage) {
      return res.status(200).json({
        success: true,
        message: "خارج ساعات الإدارة",
        time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      });
    }

    // ═══ المرحلة 1: إدارة المراكز المفتوحة ═══
    log.managed = await manageOpenPositions();

    // ═══ المرحلة 2: دخول صفقات جديدة ═══
    if (canEnter) {
      const todayET = new Date().toISOString().split("T")[0];
      let candidates = [];

      try {
        const sr = await fetch(
          `${SUPABASE_URL}/rest/v1/signals?select=*&signal_date=eq.${todayET}&order=score.desc&limit=100`,
          { headers: SB_H }
        );
        if (sr.ok) {
          const rows = await sr.json();
          candidates = (Array.isArray(rows) ? rows : []).map(r => ({ ...r, price: r.entry_price }));
        }
      } catch {}

      const filtered = candidates.filter(s => {
        if (s.score < STRATEGY.minScore) return false;
        if (s.price < STRATEGY.minPrice) return false;
        if (s.change_pct < STRATEGY.minChangePct || s.change_pct > STRATEGY.maxChangePct) return false;
        if (s.volume < STRATEGY.minVolume) return false;
        if (s.rsi != null && s.rsi > STRATEGY.maxRSI) return false;
        if (s.vwap && s.price <= s.vwap) return false;
        if (!s.structure || s.structure.stop == null || s.structure.t1 == null) return false;
        const f = s.structure.flag || "";
        if (STRATEGY.skipChasers && (f.indexOf("ملاحقة") >= 0 || f.indexOf("غير مؤكد") >= 0 || f.indexOf("هابط") >= 0)) return false;
        return true;
      });

      const validEntry = x => x.structure && (x.structure.flag || "").indexOf("صحيح") >= 0;
      filtered.sort((a, b) => {
        if (!!b.is_target !== !!a.is_target) return b.is_target ? 1 : -1;
        if (validEntry(b) !== validEntry(a)) return validEntry(b) ? 1 : -1;
        if (!!b.early_watch !== !!a.early_watch) return b.early_watch ? 1 : -1;
        return (b.score || 0) - (a.score || 0);
      });

      const acct = await getAccount();
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

        const st = s.structure;
        const live = await getLatestPrice(s.symbol);
        const px = live || s.price;
        if (!px) {
          log.skipped.push({ symbol: s.symbol, reason: "لا يوجد سعر" });
          continue;
        }

        // ─── كشف القناص ──────────────────────────────────
        let isSniper = false;
        let sniperStopPx = 0;
        let sniperT1 = 0;
        let sniperT2 = 0;
        let sniperRisk = STRATEGY.riskPerTradePct;

        if (STRATEGY.sniperEnabled) {
          let freshCross = false;
          try {
            const hourlyBars = await fetchHourlyBars(s.symbol);
            if (hourlyBars && hourlyBars.length > 21) {
              const hourlyCloses = hourlyBars.map(b => b.c);
              freshCross = isFreshCross(hourlyCloses, 9, 21);
            }
          } catch {}

          const sniperConditions = {
            score: s.score >= STRATEGY.sniper.minScore,
            rvol: s.rvol >= STRATEGY.sniper.minRvol,
            rsi: s.rsi >= STRATEGY.sniper.minRSI && s.rsi <= STRATEGY.sniper.maxRSI,
            change: s.change_pct >= STRATEGY.sniper.minChange && s.change_pct <= STRATEGY.sniper.maxChange,
            volume: s.volume >= STRATEGY.sniper.minVolume,
            cross: !STRATEGY.sniper.requireCross || freshCross,
          };

          if (Object.values(sniperConditions).every(v => v === true)) {
            isSniper = true;
            sniperStopPx = px * (1 - STRATEGY.sniper.stopLoss);
            sniperT1 = px * (1 + STRATEGY.sniper.target1);
            sniperT2 = px * (1 + STRATEGY.sniper.target2);
            sniperRisk = STRATEGY.sniper.riskPerTrade;
            log.sniper.push({ symbol: s.symbol, score: s.score, rvol: s.rvol, rsi: s.rsi, cross: freshCross });
          }
        }

        // ─── حساب الأهداف ────────────────────────────────
        const radarPx = Number(s.price) || px;
        const driftPct = ((px - radarPx) / radarPx) * 100;
        if (driftPct > STRATEGY.maxDriftPct * 100) {
          log.skipped.push({ symbol: s.symbol, reason: `سعر متأخر ${driftPct.toFixed(1)}%` });
          continue;
        }

        const support = Number(st.support != null ? st.support : radarPx * 0.97);
        const confirm = Number(st.confirm != null ? st.confirm : radarPx);

        let t1, t3, stopPx;

        if (isSniper) {
          // 🎯 القناص: هدف 2%، وقف 1.5%
          stopPx = sniperStopPx;
          t1 = sniperT1;
          t3 = sniperT2;
        } else {
          // 🎯 العادي: هدف 0.7%، وقف 0.5%
          stopPx = px * (1 - STRATEGY.STOP_LOSS);
          t1 = px * (1 + STRATEGY.TARGET_PROFIT);
          t3 = px * (1 + STRATEGY.TARGET_PROFIT * 2);
        }

        // ─── التأكد من صحة الوقف ────────────────────────
        if (stopPx > 0 && px <= stopPx) {
          log.skipped.push({ symbol: s.symbol, reason: `ضرب الوقف (${stopPx.toFixed(2)})` });
          continue;
        }

        // ─── حساب RR ──────────────────────────────────────
        const rrLive = (px - stopPx) > 0 ? (t1 - px) / (px - stopPx) : 0;
        if (rrLive < STRATEGY.minRR) {
          log.skipped.push({ symbol: s.symbol, reason: `R:R ${rrLive.toFixed(1)}` });
          continue;
        }

        // ─── التأكد من منطقة الدخول ──────────────────────
        const stLive = { ...st, support, confirm, t1, stop: stopPx, t3, rr: +rrLive.toFixed(2), entry: px };
        if (!suitableEntry(stLive, px, t1, stopPx, STRATEGY.minRR, STRATEGY.entryBuffer, STRATEGY.minRoomPct)) {
          log.skipped.push({ symbol: s.symbol, reason: "خارج منطقة الدخول" });
          continue;
        }

        const riskPerShare = px - stopPx;
        if (riskPerShare <= 0) {
          log.skipped.push({ symbol: s.symbol, reason: "وقف غير صالح" });
          continue;
        }

        // ─── حساب حجم المركز ──────────────────────────────
        let qualityMult = 1.0;
        const sc = Number(s.score) || 60;
        if (sc >= 85) qualityMult = 1.6;
        else if (sc >= 75) qualityMult = 1.35;
        else if (sc >= 68) qualityMult = 1.15;
        else qualityMult = 0.85;
        if (s.vcp) qualityMult += 0.15;
        if (s.fresh_zone) qualityMult += 0.10;
        if (isSniper) qualityMult *= 1.1;

        const tradeRiskPct = isSniper ? sniperRisk : STRATEGY.riskPerTradePct;
        let fullValue = (balance * tradeRiskPct) * px / riskPerShare;
        fullValue = fullValue * qualityMult;
        const maxPosPct = isSniper ? STRATEGY.sniper.maxPosition : STRATEGY.maxPositionPct;
        fullValue = Math.min(fullValue, balance * maxPosPct);

        if (fullValue < balance * STRATEGY.minPositionPct) {
          log.skipped.push({ symbol: s.symbol, reason: "تحت أرضية المركز" });
          continue;
        }
        if (deployed + fullValue > maxDeployed) {
          log.skipped.push({ symbol: s.symbol, reason: "بلغ سقف الانتشار" });
          break;
        }

        const fullQty = Math.floor(fullValue / px);
        if (fullQty < 2) {
          log.skipped.push({ symbol: s.symbol, reason: "كمية صغيرة" });
          continue;
        }

        const initialQty = Math.max(1, Math.floor(fullQty * STRATEGY.initialFraction));

        // ─── تنفيذ الأمر ──────────────────────────────────
        const buy = await buyBracket(s.symbol, initialQty, t1, stopPx);
        if (buy.status === "rejected" || buy.code) {
          log.skipped.push({ symbol: s.symbol, reason: "رُفض البراكِت", err: buy.message || null });
          continue;
        }

        // ─── حفظ الخطة ────────────────────────────────────
        const plan = {
          symbol: s.symbol,
          status: "active",
          initial_qty: initialQty,
          add_qty: 0,
          added: false,
          add_enabled: false,
          total_qty: initialQty,
          avg_entry: px,
          stop: stopPx,
          t1: t1,
          t3: t3,
          support: support,
          confirm: confirm,
          tp1_done: false,
          be_moved: false,
          stock_type: isSniper ? "صياد 🎯" : (s.type || "مضاربة"),
          t1_sell_frac: 1.0,
          is_sniper: isSniper,
        };
        await planSave(plan);

        deployed += initialQty * px;
        openCount++;
        openSymbols.add(s.symbol);

        log.entered.push({
          symbol: s.symbol,
          type: isSniper ? "SNIPER 🎯" : "REGULAR",
          px: +px.toFixed(2),
          initialQty,
          stop: +stopPx.toFixed(2),
          tp1: +t1.toFixed(2),
          rr: +((t1 - px) / (px - stopPx)).toFixed(2),
        });
      }

      // ─── إحصائيات الرفض ──────────────────────────────
      const skipTally = {};
      for (const sk of log.skipped) skipTally[sk.reason] = (skipTally[sk.reason] || 0) + 1;

      debug.phase = "enter";
      debug.candidates = candidates.length;
      debug.after_filter = filtered.length;
      debug.max_trades = STRATEGY.maxTrades;
      debug.entered = log.entered.length;
      debug.skipped = log.skipped.length;
      debug.skip_reasons = skipTally;
      debug.sniper_candidates = log.sniper.length;
      debug.deployed_pct = balance > 0 ? Math.round((deployed / balance) * 100) : 0;
    }

    return res.status(200).json({
      success: true,
      engine: STRATEGY.engine,
      time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      debug,
      ...log,
    });

  } catch (e) {
    console.error("❌ خطأ:", e);
    return res.status(200).json({
      success: false,
      error: e.message,
      stack: process.env.NODE_ENV === "development" ? e.stack : undefined,
    });
  }
}
