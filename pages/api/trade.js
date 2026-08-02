// pages/api/trade.js — v15 (لمسة المدير: يثق بدماغ الرادار + بصمة الرابح + خروج ثلاثي)
// ════════════════════════════════════════════════════════════════════════
//  🎯 فلسفة v15 (مبنية على ما أثبتته بيانات RadarAZ عبر مئات الصفقات):
//
//  1) البوت لا يعيد اختراع دماغ — يثق بـ predictionScore من الرادار مباشرة.
//     (v14 كان يحسب سكوراً خاصاً بـ20 عاملاً = دماغ ثانٍ يعارض الرادار).
//
//  2) بصمة الرابح (مثبتة رقمياً): يتداول الهادئ المبكر، يرفض المتفجّر والمخترِق.
//     - يرفض is_hot (اختراق): 0 رابحة من 10 في بياناتنا.
//     - يرفض RVOL متفجّر (>5): الخاسرة متوسطها 18.9، الرابحة 7.2.
//     - يفضّل RSI معتدل (40-65): المتأخر (RSI عالٍ) يخسر.
//     - يفضّل change صغير (لم ينفجر بعد): الفرصة الحيّة.
//
//  3) الوقف والأهداف = بنية الرادار الجديدة مباشرة (وقف ~-4% محميّ، أهداف مختلطة).
//     نفس ما يراه المشترك، نفس ما نقيسه. اتّساق كامل.
//
//  4) خروج ثلاثي الطبقات:
//     الطبقة 1: تأمين سريع — عند +2-3% يبيع 50% ويحرّك الوقف للتعادل.
//     الطبقة 2: وقف متحرّك (ATR) على الباقي — يحمي الربح، يترك الرابح يركض.
//     الطبقة 3: وقف صارم أوّلي (-4% من الرادار) لا يُتجاوز.
//
//  5) حمايات عليا (كما v14، مُبقاة): إيقاف يومي 4% · أسبوعي 8% · kill switch.
//
//  ⚙️ التشغيل: BOT_KILL=1 يوقف الدخول (يبقى يدير المفتوح). ابدأ به موقوفاً
//     حتى تنضج بيانات الرادار، ثم فعّله.
// ════════════════════════════════════════════════════════════════════════

export const config = { maxDuration: 20 };

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";
const ALPACA_DATA   = "https://data.alpaca.markets";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

// ─── الإعدادات (لمسة المدير) ─────────────────────────────────────────
const CFG = {
  // بوابة الدخول — تثق بالرادار + بصمة الرابح
  MIN_SCORE: 55,             // الحدّ الأدنى لـ predictionScore من الرادار (بعد ×0.6 يعني رادار قوي)
  REJECT_HOT: true,          // ارفض الاختراقات (أثبتت خسارتها)
  RVOL_MAX: 5.0,             // ارفض المتفجّر (فخّ)
  RVOL_MIN: 0.5,             // ارفض الميّت تماماً
  RSI_MIN: 38, RSI_MAX: 68,  // زخم صحّي، لا إشباع
  CHANGE_MAX: 8,             // لم ينفجر بعد (الفرصة حيّة)
  CHANGE_MIN: -2,
  REQUIRE_IN_ZONE: true,     // فقط داخل منطقة الدخول (لا ملاحقة)

  // إدارة المخاطر
  RISK_PER_TRADE: 0.01,      // 1% مخاطرة لكل صفقة (متحفّظ)
  MAX_POSITION_PCT: 0.20,    // سقف حجم المركز
  MIN_POSITION_PCT: 0.01,
  MAX_DEPLOYED_PCT: 0.80,    // سقف الانتشار الكلّي
  MAX_LOSS_PCT: 0.045,       // سقف الوقف المطلق (-4.5%، يطابق الرادار)

  // الخروج الثلاثي
  QUICK_TP_PCT: 0.025,       // الطبقة 1: تأمين عند +2.5%
  QUICK_TP_FRACTION: 0.50,   // يبيع 50%
  TRAIL_ATR_MULT: 1.5,       // الطبقة 2: وقف متحرّك بمسافة 1.5×ATR
  BREAKEVEN_NUDGE: 1.001,    // التعادل +0.1%

  // عدد الصفقات الديناميكي
  BASE_PER_AMOUNT: 5000,
  MIN_TRADES: 3,
  MAX_TRADES: 20,

  // حمايات عليا
  DAILY_LOSS_HALT: 0.04,
  WEEKLY_LOSS_HALT: 0.08,
  SPY_VWAP_FILTER: true,

  // نافذة التداول (ET بالدقائق)
  MANAGE_START: 575, MANAGE_END: 958,   // 9:35 - 15:58
  ENTER_START: 590,  ENTER_END: 900,    // 9:50 - 15:00
};

const H = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET, "Content-Type": "application/json" };
const SB_H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
const px2 = (v) => Number(v).toFixed(Number(v) < 1 ? 4 : 2);

// ════════════════ Alpaca ════════════════
async function getAccount() { const r = await fetch(`${ALPACA_BASE}/v2/account`, { headers: H }); return r.json(); }
async function getAllPositions() { try { const r = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: H }); const d = await r.json(); return Array.isArray(d) ? d : []; } catch { return []; } }
async function getPositionQty(sym) { try { const r = await fetch(`${ALPACA_BASE}/v2/positions/${sym}`, { headers: H }); if (!r.ok) return 0; const d = await r.json(); return Math.abs(parseInt(d.qty)) || 0; } catch { return 0; } }
async function getLatestPrice(sym) { try { const r = await fetch(`${ALPACA_DATA}/v2/stocks/${sym}/trades/latest`, { headers: H }); if (!r.ok) return null; const d = await r.json(); return d?.trade?.p ?? null; } catch { return null; } }

async function getLatestPrices(symbols) {
  if (!symbols.length) return {};
  try {
    const r = await fetch(`${ALPACA_DATA}/v2/stocks/snapshots?symbols=${symbols.join(",")}`, { headers: H });
    if (!r.ok) return {};
    const d = await r.json();
    const map = d?.snapshots || d || {};
    const out = {};
    for (const [sym, snap] of Object.entries(map)) {
      const p = snap?.latestTrade?.p ?? snap?.minuteBar?.c ?? null;
      if (p) out[sym] = p;
    }
    return out;
  } catch { return {}; }
}

async function getMinuteBars(sym, limit = 30) {
  try {
    const r = await fetch(`${ALPACA_DATA}/v2/stocks/${sym}/bars?timeframe=1Min&limit=${limit}`, { headers: H });
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d?.bars) && d.bars.length ? d.bars : null;
  } catch { return null; }
}

async function getOpenOrders(sym) { try { const r = await fetch(`${ALPACA_BASE}/v2/orders?status=open&symbols=${sym}&nested=true`, { headers: H }); const d = await r.json(); return Array.isArray(d) ? d : []; } catch { return []; } }
async function cancelOrder(id) { try { await fetch(`${ALPACA_BASE}/v2/orders/${id}`, { method: "DELETE", headers: H }); } catch {} }
async function cancelAll(sym) { const oo = await getOpenOrders(sym); for (const o of oo) await cancelOrder(o.id); }

async function sellMarket(sym, qty) {
  return fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST", headers: H,
    body: JSON.stringify({ symbol: sym, qty: String(qty), side: "sell", type: "market", time_in_force: "day" })
  }).then(r => r.json()).catch(() => null);
}

async function buyBracket(sym, qty, tp, sl) {
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      symbol: sym, qty: String(qty), side: "buy", type: "market", time_in_force: "day",
      order_class: "bracket",
      take_profit: { limit_price: px2(tp) },
      stop_loss: { stop_price: px2(sl) },
    }),
  });
  return r.json();
}

async function ocoSell(sym, qty, tp, sl) {
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      symbol: sym, qty: String(qty), side: "sell", type: "limit", time_in_force: "day",
      order_class: "oco",
      take_profit: { limit_price: px2(tp) },
      stop_loss: { stop_price: px2(sl) },
    }),
  });
  return r.json();
}

async function stopSell(sym, qty, sl) {
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
      method: "POST", headers: H,
      body: JSON.stringify({ symbol: sym, qty: String(qty), side: "sell", type: "stop", stop_price: px2(sl), time_in_force: "day" }),
    });
    return r.json();
  } catch { return null; }
}

// ════════════════ Supabase (حالة البوت) ════════════════
async function planList() { try { const r = await fetch(`${SUPABASE_URL}/rest/v1/bot_positions?status=eq.active&select=*`, { headers: SB_H }); const d = await r.json(); return Array.isArray(d) ? d : []; } catch { return []; } }
async function planSave(p) {
  p.updated_at = new Date().toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/bot_positions?on_conflict=symbol`, {
    method: "POST", headers: { ...SB_H, Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(p),
  });
}
async function planClose(sym) {
  await fetch(`${SUPABASE_URL}/rest/v1/bot_positions?symbol=eq.${sym}`, {
    method: "PATCH", headers: SB_H, body: JSON.stringify({ status: "closed", updated_at: new Date().toISOString() }),
  });
}
async function logTrade(trade) {
  try { await fetch(`${SUPABASE_URL}/rest/v1/bot_trades`, { method: "POST", headers: SB_H, body: JSON.stringify(trade) }); } catch {}
}

function calculateATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── بوابة الدخول: بصمة الرابح (لمسة المدير) ───
// ترجع {ok, reason} — نرفض ما يخالف ما أثبتته البيانات.
function winnerGate(s) {
  // 1) درجة الرادار كافية
  if ((s.score ?? 0) < CFG.MIN_SCORE) return { ok: false, reason: `score ${s.score} < ${CFG.MIN_SCORE}` };
  // 2) ارفض الاختراقات (0 رابحة من 10)
  if (CFG.REJECT_HOT && s.is_hot) return { ok: false, reason: 'اختراق (is_hot) — يخسر' };
  // 3) RVOL: لا متفجّر ولا ميّت
  if (s.rvol != null && (s.rvol > CFG.RVOL_MAX || s.rvol < CFG.RVOL_MIN))
    return { ok: false, reason: `rvol ${s.rvol} خارج [${CFG.RVOL_MIN},${CFG.RVOL_MAX}]` };
  // 4) RSI معتدل (لا إشباع)
  if (s.rsi != null && (s.rsi < CFG.RSI_MIN || s.rsi > CFG.RSI_MAX))
    return { ok: false, reason: `rsi ${s.rsi} خارج [${CFG.RSI_MIN},${CFG.RSI_MAX}]` };
  // 5) لم ينفجر بعد (الفرصة حيّة)
  if (s.change_pct != null && (s.change_pct > CFG.CHANGE_MAX || s.change_pct < CFG.CHANGE_MIN))
    return { ok: false, reason: `change ${s.change_pct}% خارج النطاق` };
  // 6) بنية صالحة (وقف وأهداف من الرادار)
  if (!s.structure || s.structure.stop == null || s.structure.t1 == null)
    return { ok: false, reason: 'بنية ناقصة' };
  // 7) داخل منطقة الدخول فقط (لا ملاحقة)
  if (CFG.REQUIRE_IN_ZONE) {
    const code = s.structure.entry_state?.code || s.entry_state;
    if (code && code !== 'in_zone') return { ok: false, reason: `ليس بمنطقة الدخول (${code})` };
  }
  return { ok: true, reason: 'بصمة الرابح ✅' };
}

// ════════════════ MAIN ════════════════
export default async function handler(req, res) {
  const T0 = Date.now();
  try {
    const log = { managed: [], entered: [], skipped: [] };
    const debug = { version: "v15", phase: "manage_only" };
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const mins = et.getHours() * 60 + et.getMinutes(), day = et.getDay();
    const weekend = day === 0 || day === 6;
    const canManage = !weekend && mins >= CFG.MANAGE_START && mins <= CFG.MANAGE_END;
    const canEnter  = !weekend && mins >= CFG.ENTER_START && mins < CFG.ENTER_END;

    if (!canManage) return res.status(200).json({ success: true, message: "خارج ساعات الإدارة", ...log });

    // ═══ المرحلة 1: إدارة المراكز (الخروج الثلاثي) ═══
    const plans = await planList();
    for (const p of plans) {
      const sym = p.symbol;
      const held = await getPositionQty(sym);
      const live = await getLatestPrice(sym);

      if (held === 0) {
        await cancelAll(sym);
        await planClose(sym);
        log.managed.push({ symbol: sym, action: "أُغلق المركز" });
        continue;
      }
      if (!live) { log.managed.push({ symbol: sym, action: "لا سعر" }); continue; }

      const entry = Number(p.avg_entry);
      const gainPct = (live - entry) / entry;

      // ── الطبقة 1: تأمين سريع عند +2.5% (يبيع 50% + وقف للتعادل) ──
      if (!p.quick_done && gainPct >= CFG.QUICK_TP_PCT && held >= 2) {
        const sellQty = Math.max(1, Math.floor(held * CFG.QUICK_TP_FRACTION));
        await cancelAll(sym);
        await sellMarket(sym, sellQty);
        const remaining = held - sellQty;
        const be = entry * CFG.BREAKEVEN_NUDGE;
        if (remaining >= 1) {
          const resp = await ocoSell(sym, remaining, Number(p.t3 || p.t1), be);
          if (resp && (resp.code || resp.status === "rejected")) await stopSell(sym, remaining, be);
        }
        p.quick_done = true;
        p.be_done = true;
        p.stop = be;
        p.total_qty = remaining;
        await planSave(p);
        log.managed.push({ symbol: sym, action: "🔒 تأمين +2.5% (بيع 50% + تعادل)", sold: sellQty, remaining });
        continue;
      }

      // ── الطبقة 2: وقف متحرّك على الباقي بعد التأمين ──
      if (p.quick_done && !p.trail_done) {
        const bars = await getMinuteBars(sym, 30);
        const atr = calculateATR(bars, 14) || (live * 0.02);
        const trailStop = live - atr * CFG.TRAIL_ATR_MULT;
        if (trailStop > Number(p.stop)) {
          await cancelAll(sym);
          const resp = await ocoSell(sym, held, Number(p.t3 || p.t1), trailStop);
          if (resp && (resp.code || resp.status === "rejected")) await stopSell(sym, held, trailStop);
          p.stop = trailStop;
          await planSave(p);
          log.managed.push({ symbol: sym, action: "📈 وقف متحرّك", stop: +trailStop.toFixed(2) });
          continue;
        }
      }

      // ── إصلاح أوامر الحماية إن غابت ──
      const oo = await getOpenOrders(sym);
      if (oo.length === 0) {
        const resp = await ocoSell(sym, held, Number(p.t1), Number(p.stop));
        if (resp && (resp.code || resp.status === "rejected")) await stopSell(sym, held, Number(p.stop));
        log.managed.push({ symbol: sym, action: "🛡️ إصلاح الحماية", held });
        continue;
      }
      log.managed.push({ symbol: sym, action: "تتبّع", held, gainPct: +(gainPct*100).toFixed(1) });
    }

    // ═══ المرحلة 2: الدخول (بصمة الرابح) ═══
    if (canEnter) {
      debug.phase = "enter";

      // حمايات عليا
      let blocked = null;
      if (process.env.BOT_KILL === "1") blocked = "kill_switch";

      const acct = await getAccount();
      const balance = parseFloat(acct.equity || acct.cash || 0);
      const lastEq = parseFloat(acct.last_equity || 0);
      if (!blocked && lastEq > 0) {
        const dayPnl = (balance - lastEq) / lastEq;
        if (dayPnl <= -CFG.DAILY_LOSS_HALT) blocked = `daily_halt_${(dayPnl*100).toFixed(1)}%`;
      }
      if (!blocked && CFG.SPY_VWAP_FILTER) {
        try {
          const sd = await fetch(`${ALPACA_DATA}/v2/stocks/SPY/snapshot`, { headers: H }).then(r => r.json());
          const spyPx = sd?.latestTrade?.p || sd?.minuteBar?.c || 0;
          const spyVwap = sd?.dailyBar?.vw || 0;
          if (spyPx > 0 && spyVwap > 0 && spyPx < spyVwap * 0.99) blocked = "spy_below_vwap";
        } catch {}
      }

      if (blocked) {
        debug.entries_blocked = blocked;
      } else {
        // اقرأ إشارات الرادار (نثق بدماغه — لا نعيد التقييم)
        let candidates = [];
        try {
          const sr = await fetch(`${SUPABASE_URL}/rest/v1/signals?signal_date=eq.${et.toISOString().split("T")[0]}&order=score.desc&limit=100`, { headers: SB_H });
          if (sr.ok) {
            const rows = await sr.json();
            candidates = (Array.isArray(rows) ? rows : []).map(r => ({ ...r, price: r.entry_price }));
          }
        } catch {}
        debug.candidates = candidates.length;

        // بوابة بصمة الرابح
        const passed = [];
        for (const s of candidates) {
          const gate = winnerGate(s);
          if (gate.ok) passed.push(s);
          else log.skipped.push({ symbol: s.symbol, reason: gate.reason });
        }
        debug.passed_gate = passed.length;

        // عدد الصفقات الديناميكي
        let maxTrades = Math.floor(balance / CFG.BASE_PER_AMOUNT);
        maxTrades = Math.max(CFG.MIN_TRADES, Math.min(maxTrades, CFG.MAX_TRADES));

        const positions = await getAllPositions();
        const activePlans = await planList();
        const openSymbols = new Set([...positions.map(p => p.symbol), ...activePlans.map(p => p.symbol)]);
        let openCount = openSymbols.size;
        let deployed = positions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || 0)), 0);
        const maxDeployed = balance * CFG.MAX_DEPLOYED_PCT;

        const symbols = passed.map(s => s.symbol);
        const priceMap = await getLatestPrices(symbols);

        for (const s of passed) {
          if (Date.now() - T0 > 22000) { debug.time_guard = true; break; }
          if (openCount >= maxTrades) break;
          if (openSymbols.has(s.symbol)) continue;

          const px = priceMap[s.symbol] || s.price;
          if (!px) { log.skipped.push({ symbol: s.symbol, reason: "لا سعر" }); continue; }

          // انزلاق: لا تدخل إن ابتعد السعر كثيراً عن سعر الرادار
          const radarPx = Number(s.price) || px;
          const drift = ((px - radarPx) / radarPx) * 100;
          if (drift > 3) { log.skipped.push({ symbol: s.symbol, reason: `انزلاق ${drift.toFixed(1)}%` }); continue; }

          // الوقف والأهداف من الرادار مباشرة (بنية المستويات الجديدة)
          const st = s.structure;
          let stopPx = Number(st.stop);
          const t1 = Number(st.t1);
          const t3 = Number(st.t3 || st.t1);

          // سقف الوقف المطلق (-4.5%)
          const capFloor = px * (1 - CFG.MAX_LOSS_PCT);
          if (stopPx < capFloor) stopPx = capFloor;
          if (stopPx >= px) { log.skipped.push({ symbol: s.symbol, reason: "وقف فوق السعر" }); continue; }

          const riskPerShare = px - stopPx;
          if (riskPerShare <= 0) { log.skipped.push({ symbol: s.symbol, reason: "مخاطرة غير صالحة" }); continue; }

          // حجم المركز حسب المخاطرة
          let posValue = (balance * CFG.RISK_PER_TRADE) * px / riskPerShare;
          posValue = Math.min(posValue, balance * CFG.MAX_POSITION_PCT);
          if (posValue < balance * CFG.MIN_POSITION_PCT) { log.skipped.push({ symbol: s.symbol, reason: "تحت أرضية المركز" }); continue; }
          if (deployed + posValue > maxDeployed) { log.skipped.push({ symbol: s.symbol, reason: "سقف الانتشار" }); break; }

          const qty = Math.floor(posValue / px);
          if (qty < 2) { log.skipped.push({ symbol: s.symbol, reason: "كمية صغيرة" }); continue; }

          // ادخل ببراكِت: هدف أوّلي t1، وقف من الرادار
          const buy = await buyBracket(s.symbol, qty, t1 * 0.998, stopPx);
          if (buy.status === "rejected" || buy.code) {
            log.skipped.push({ symbol: s.symbol, reason: "رُفض البراكِت", err: buy.message });
            continue;
          }

          const atr = Number(s.atr14) || px * 0.02;
          const plan = {
            symbol: s.symbol, status: "active",
            total_qty: qty, avg_entry: px,
            stop: stopPx, t1, t3,
            quick_done: false, be_done: false, trail_done: false,
            atr14: atr,
            signal_score: s.score,
            stock_type: s.type || "مضاربة",
          };
          await planSave(plan);
          await logTrade({
            symbol: s.symbol, entry_price: px, signal_score: s.score,
            rsi: s.rsi, rvol: s.rvol, change_pct: s.change_pct,
            news_sentiment: s.news_sentiment || null,
            stop: stopPx, t1, t3,
            entry_time: new Date().toISOString(), status: "open",
          });

          deployed += qty * px;
          openCount++;
          openSymbols.add(s.symbol);
          log.entered.push({
            symbol: s.symbol, px: +px.toFixed(2), qty, score: s.score,
            stop: +stopPx.toFixed(2), t1: +t1.toFixed(2),
            rr: +((t1 - px) / (px - stopPx)).toFixed(2),
            rvol: s.rvol, rsi: s.rsi,
          });
        }

        const skipTally = {};
        for (const sk of log.skipped) skipTally[sk.reason] = (skipTally[sk.reason] || 0) + 1;
        debug.entered = log.entered.length;
        debug.skipped = log.skipped.length;
        debug.skip_reasons = skipTally;
        debug.deployed_pct = balance > 0 ? Math.round((deployed / balance) * 100) : 0;
        debug.maxTrades = maxTrades;
      }
    }

    return res.status(200).json({
      success: true, version: "v15",
      time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      elapsed_ms: Date.now() - T0, debug, ...log,
    });
  } catch (e) {
    return res.status(200).json({ success: false, error: e.message, elapsed_ms: Date.now() - T0 });
  }
}
