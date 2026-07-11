// pages/api/trade.js — v11 (شراء في منطقة الدخول + تأمين الربح)
// ════════════════════════════════════════════════════════════════════════
//  🏗️ مبني على v10 — كل الدروع كما هي (Kill/يومي/أسبوعي/SPY-VWAP/براكِت ذري)
//
//  🔴 إصلاح قاتل: fetchAggs كانت غير معرّفة → مرحلة الدخول كانت تنهار بصمت
//     (البوت كان يدير المفتوح فقط ولا يدخل صفقات). أُضيفت getMinuteBars من Alpaca.
//
//  🆕 v11 — التكامل مع scan v11:
//   ✅ بوابة الدخول: 🟢 in_zone فقط (من structure.entry_state) — لا شراء ممتد/ملاحقة
//   ✅ احترام تهدئة الرادار: structure.cooldown = true → تخطٍ
//   ✅ هدف قريب لتأمين الربح: 50% من الكمية تُباع عند min(T1, سعر + 1×ATR)
//   ✅ بعد تنفيذ الهدف القريب → نقل وقف الباقي للتعادل (صفقة مجانية)
//   ✅ التنفيذ ببراكِتين ذريين (نصف بهدف قريب + نصف بهدف T1) — الحماية على Alpaca
//
//  🛡️ تصحيحات مخاطر (قرار CTO — قابلة للنقاش بالبيانات):
//   ⛔ المارتينغيل مطفأ افتراضياً: مضاعفة الحجم بعد الخسارة تناقض riskPerTradePct
//      وتكسّر القاطع اليومي. كذلك bot_state لا يُكتب فيه أصلاً (loss_streak فارغ دائماً).
//   ⛔ مكافآت win_streak مطفأة لنفس السبب (bot_state غير مُغذّى).
//   ✅ سقف صارم على أي مضاعف إجمالي: 0.85 – 1.6
//   ✅ بوابة الارتداد من الدعم صارت ترجيحاً لا شرط قطع (كانت تمنع أغلب الدخولات)
//   ✅ مهلة 10ث مصرّحة + حارس وقت داخلي لحلقة الدخول
// ════════════════════════════════════════════════════════════════════════

export const config = { maxDuration: 10 };

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";
const ALPACA_DATA   = "https://data.alpaca.markets";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.RADARAZ_SUPABASE_KEY;

// ─── الإعدادات ──────────────────────────────────────────────────────
const STRATEGY = {
  engine: "smart",
  addEnabled: false,

  // 🔍 الفلاتر الأساسية
  minScore: 60,
  minPrice: 3,
  minChangePct: 1.5,
  maxChangePct: 10,
  minVolume: 200_000,
  minRvol: 2.0,
  minRSI: 50,
  maxRSI: 72,
  minRR: 1.0,
  entryBuffer: 1.02,
  minRoomPct: 0.01,

  // 🆕 v11: بوابة حالة الدخول (من scan v11)
  requireInZone: true,        // شراء في 🟢 فقط
  respectRadarCooldown: true, // لا شراء لسهم ضرب وقفه مؤخراً

  // 🆕 v11: تأمين الربح
  nearTP: {
    enabled: true,
    sellFrac: 0.5,     // نصف الكمية عند الهدف القريب
    atrMult: 1.0,      // الهدف القريب = سعر + 1×ATR
    minPct: 0.008,     // أرضية 0.8% (لو ATR ضئيل)
  },
  breakevenAfterTp1: true,   // بعد الهدف القريب → وقف الباقي عند التعادل
  breakevenNudge: 1.001,     // تعادل + هامش عمولة بسيط

  // 📊 إدارة المخاطر
  maxLossPct: 0.07,
  maxDriftPct: 0.05,
  riskPerTradePct: 0.015,
  maxPositionPct: 0.25,
  minPositionPct: 0.03,
  maxDeployedPct: 0.70,
  maxTrades: 10,
  maxTotalMult: 1.6,   // 🆕 سقف صارم لأي مضاعفات حجم مجتمعة

  // 🔄 الدخول/الخروج
  initialFraction: 0.70,
  tp1FillNudge: 0.998,

  // 🛡️ دروع الحماية (كما هي — لا تُمس)
  dailyLossHaltPct: 0.02,
  weeklyLossHaltPct: 0.05,
  spyVwapFilter: true,

  // ⛔ مطفأة افتراضياً (انظر الترويسة) — التفعيل قرار واعٍ بعد بيانات paper
  martingale: { enabled: false, multiplier: 1.5, maxStreak: 3 },
  bonus: { enabled: false, winStreak5: 1.8, winStreak3: 1.5, winStreak1: 1.2 },
  cooldown: { enabled: true, lossStreak: 3, duration: 30 },
};

const H    = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET, "Content-Type": "application/json" };
const SB_H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

const px2 = (v) => Number(v).toFixed(Number(v) < 1 ? 4 : 2);

// ════════════════ دوال Alpaca ════════════════
async function getAccount()        { const r = await fetch(`${ALPACA_BASE}/v2/account`, { headers: H }); return r.json(); }
async function getAllPositions()   { try { const r = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: H }); const d = await r.json(); return Array.isArray(d) ? d : []; } catch { return []; } }
async function getPositionQty(sym) { try { const r = await fetch(`${ALPACA_BASE}/v2/positions/${sym}`, { headers: H }); if (!r.ok) return 0; const d = await r.json(); return Math.abs(parseInt(d.qty)) || 0; } catch { return 0; } }
async function getLatestPrice(sym) { try { const r = await fetch(`${ALPACA_DATA}/v2/stocks/${sym}/trades/latest`, { headers: H }); if (!r.ok) return null; const d = await r.json(); return d?.trade?.p ?? null; } catch { return null; } }

async function getLatestPrices(symbols) {
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

// 🆕 v11: شموع الدقائق من Alpaca (كانت fetchAggs غير معرّفة — سبب انهيار الدخول)
async function getMinuteBars(sym, limit = 30) {
  try {
    const r = await fetch(`${ALPACA_DATA}/v2/stocks/${sym}/bars?timeframe=1Min&limit=${limit}`, { headers: H });
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d?.bars) && d.bars.length ? d.bars : null;
  } catch { return null; }
}

async function getOpenOrders(sym)  { try { const r = await fetch(`${ALPACA_BASE}/v2/orders?status=open&symbols=${sym}&nested=true`, { headers: H }); const d = await r.json(); return Array.isArray(d) ? d : []; } catch { return []; } }
async function cancelOrder(id)     { try { await fetch(`${ALPACA_BASE}/v2/orders/${id}`, { method: "DELETE", headers: H }); } catch {} }
async function cancelAll(sym)      { const oo = await getOpenOrders(sym); for (const o of oo) await cancelOrder(o.id); }
async function buyMarket(sym, qty) { const r = await fetch(`${ALPACA_BASE}/v2/orders`, { method: "POST", headers: H, body: JSON.stringify({ symbol: sym, qty: String(qty), side: "buy", type: "market", time_in_force: "day" }) }); return r.json(); }

async function buyBracket(sym, qty, tp, sl) {
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      symbol: sym, qty: String(qty), side: "buy", type: "market", time_in_force: "day",
      order_class: "bracket",
      take_profit: { limit_price: px2(tp) },
      stop_loss:   { stop_price:  px2(sl) },
    }),
  });
  return r.json();
}

async function stopSell(sym, qty, sl) {
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
      method: "POST", headers: H,
      body: JSON.stringify({ symbol: sym, qty: String(qty), side: "sell", type: "stop",
        stop_price: px2(sl), time_in_force: "day" }),
    });
    return r.json();
  } catch { return null; }
}

async function ocoSell(sym, qty, tp, sl) {
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      symbol: sym, qty: String(qty), side: "sell", type: "limit", time_in_force: "day",
      order_class: "oco",
      take_profit: { limit_price: px2(tp) },   // 🆕 كان .toFixed(2) دائماً — يكسر أسهم تحت $1
      stop_loss:   { stop_price: px2(sl) },
    }),
  });
  return r.json();
}

async function placeExits(sym, qty, p) {
  const raw = Number(p.t1) * STRATEGY.tp1FillNudge;
  const resp = await ocoSell(sym, qty, raw, Number(p.stop));
  if (resp && (resp.code || resp.status === "rejected")) {
    await stopSell(sym, qty, Number(p.stop));
    return { ok: false, fallback: true };
  }
  return { ok: true };
}

// ════════════════ دوال Supabase ════════════════
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

async function getBotState(sym) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/bot_state?symbol=eq.${sym}&select=*`, { headers: SB_H });
    const d = await r.json();
    return Array.isArray(d) && d.length ? d[0] : null;
  } catch { return null; }
}

async function logTrade(trade) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/bot_trades`, {
      method: "POST", headers: SB_H,
      body: JSON.stringify(trade),
    });
  } catch {}
}

// ════════════════ دوال التحليل الذكي (كما هي) ════════════════
function predictMomentum(bars) {
  if (!bars || bars.length < 20) return { likelyUp: true, confidence: 0.5, label: "⚠️ بيانات غير كافية" };
  const closes = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  const last20 = closes.slice(-20);
  const last10 = closes.slice(-10);

  const trendStrength = (last20[last20.length - 1] - last20[0]) / last20[0];
  const recentStrength = (last10[last10.length - 1] - last10[0]) / last10[0];

  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1];
  const volRatio = lastVol / avgVol;

  const confidence = (trendStrength * 0.3 + recentStrength * 0.4 + Math.min(volRatio / 2, 0.3));
  const likelyUp = confidence > 0.5;

  let label = "⚠️ ضعف زخم";
  if (confidence > 0.7) label = "🔥 زخم قوي";
  else if (confidence > 0.5) label = "📈 زخم معتدل";

  return { likelyUp, confidence: Math.min(confidence, 1), label };
}

function detectReversal(bars) {
  if (!bars || bars.length < 3) return { hasReversal: false, patterns: [], confidence: 0, signal: 'WAIT' };
  const last = bars.slice(-3);
  const patterns = [];

  const isHammer = (b) => b.c > b.o && (b.h - b.c) < (b.c - b.l) * 0.3 && (b.c - b.l) > (b.h - b.l) * 0.6;
  const isShootingStar = (b) => b.c < b.o && (b.c - b.l) < (b.h - b.c) * 0.3 && (b.h - b.c) > (b.h - b.l) * 0.6;
  const isBullishEngulfing = (prev, curr) => prev.c < prev.o && curr.c > curr.o && curr.c > prev.o && curr.o < prev.c;
  const isDoji = (b) => Math.abs(b.c - b.o) / (b.h - b.l) < 0.15;

  if (last[2] && isHammer(last[2])) patterns.push('hammer');
  if (last[2] && isShootingStar(last[2])) patterns.push('shooting_star');
  if (last[1] && last[2] && isBullishEngulfing(last[1], last[2])) patterns.push('engulfing');
  if (last[2] && isDoji(last[2])) patterns.push('doji');

  return {
    hasReversal: patterns.length > 0,
    patterns,
    confidence: patterns.length / 4,
    signal: patterns.includes('hammer') || patterns.includes('engulfing') ? 'BUY' : 'WAIT'
  };
}

function analyzeVolume(volumes, prices) {
  if (!volumes || volumes.length < 20) return { ratio: 1, quality: '⚠️ بيانات غير كافية', flow: { positive: true }, warnings: [] };
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVolume = volumes[volumes.length - 1];
  const ratio = lastVolume / avgVolume;

  let quality = '⚠️ ضعيف';
  if (ratio > 2) quality = '🔥 ضخم';
  else if (ratio > 1.5) quality = '📊 قوي';
  else if (ratio > 1) quality = '📈 جيد';

  const warnings = [];
  if (ratio > 5) warnings.push('زيادة حجم غير طبيعية (pump?)');

  return { ratio, quality, flow: { positive: ratio > 1.2 }, warnings };
}

function detectSupportBounce(bars, price, support) {
  if (!bars || bars.length < 5 || !support) return { touchedSupport: false, bounced: false, volumeSupport: false, isBounce: false, confidence: 0 };
  const lastFew = bars.slice(-5);
  const touchedSupport = lastFew.some(b => b.l <= support * 1.01);
  const lastBar = lastFew[lastFew.length - 1];
  const bounced = lastBar && lastBar.c > lastBar.o && lastBar.c > support * 1.01;
  const avgVol = lastFew.slice(0, -1).reduce((a, b) => a + b.v, 0) / Math.max(lastFew.length - 1, 1);
  const volumeSupport = lastBar && lastBar.v > avgVol * 1.2;

  return {
    touchedSupport,
    bounced,
    volumeSupport,
    isBounce: touchedSupport && bounced && volumeSupport,
    confidence: (touchedSupport + bounced + volumeSupport) / 3
  };
}

function generateAlerts(symbol, signal, price) {
  const alerts = [];
  if (signal.strength > 0.7) {
    alerts.push({ type: '📈 ENTRY', message: `فرصة قوية في ${symbol} بسعر $${price.toFixed(2)}`, priority: 'HIGH' });
  }
  if (signal.stop && price < signal.stop * 1.02) {
    alerts.push({ type: '🛑 WARNING', message: `${symbol} يقترب من وقف الخسارة`, priority: 'HIGH' });
  }
  if (signal.target && price > signal.target * 0.98) {
    alerts.push({ type: '🎯 TARGET', message: `${symbol} يقترب من هدف الربح`, priority: 'MEDIUM' });
  }
  if (signal.resistance && price > signal.resistance) {
    alerts.push({ type: '🚀 BREAKOUT', message: `${symbol} كسر المقاومة عند $${price.toFixed(2)}`, priority: 'HIGH' });
  }
  return alerts;
}

// ════════════════ الدوال المساعدة ════════════════
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

// ════════════════ MAIN HANDLER ════════════════
export default async function handler(req, res) {
  const T0 = Date.now();
  try {
    const log = { managed: [], entered: [], skipped: [] };
    const debug = { phase: "manage_only" };
    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const mins = et.getHours() * 60 + et.getMinutes(), day = et.getDay();
    const weekend = day === 0 || day === 6;
    const canManage = !weekend && mins >= 575 && mins <= 958;
    const canEnter = !weekend && mins >= 590 && mins < 900;

    if (!canManage) {
      return res.status(200).json({ success: true, message: "خارج ساعات الإدارة", ...log });
    }

    // ═══ المرحلة 1: إدارة المراكز المفتوحة ═══
    if (STRATEGY.engine === "smart") {
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

        // 🆕 v11: تأمين الربح — الهدف القريب نُفّذ؟ → وقف الباقي للتعادل
        if (STRATEGY.breakevenAfterTp1 && !p.be_done && p.runner_qty > 0 && held <= p.runner_qty) {
          const be = Number(p.avg_entry) * STRATEGY.breakevenNudge;
          await cancelAll(sym);
          const resp = await ocoSell(sym, held, Number(p.t1), be);
          if (resp && (resp.code || resp.status === "rejected")) {
            await stopSell(sym, held, be);   // احتياط: وقف تعادل على الأقل
          }
          p.be_done = true; p.tp1_done = true; p.stop = be;
          await planSave(p);
          log.managed.push({ symbol: sym, action: "🔒 تأمين ربح — وقف الباقي للتعادل", be: +be.toFixed(2), remaining: held });
          continue;
        }

        if (p.add_enabled && !p.added && !p.tp1_done && live &&
            live <= Number(p.add_level) && live > Number(p.stop) && p.add_qty > 0) {
          const acct = await getAccount();
          if (parseFloat(acct.cash || 0) >= p.add_qty * live) {
            await buyMarket(sym, p.add_qty);
            const newTotal = held + p.add_qty;
            p.avg_entry = (Number(p.avg_entry) * held + live * p.add_qty) / newTotal;
            p.total_qty = newTotal; p.added = true;
            await cancelAll(sym);
            await placeExits(sym, newTotal, p);
            await planSave(p);
            log.managed.push({ symbol: sym, action: "إضافة متدرّجة", addQty: p.add_qty, newAvg: +Number(p.avg_entry).toFixed(2) });
            continue;
          }
        }

        const oo = await getOpenOrders(sym);
        if (oo.length === 0) {
          await placeExits(sym, held, p);
          log.managed.push({ symbol: sym, action: "إصلاح أوامر الحماية", held });
          continue;
        }
        log.managed.push({ symbol: sym, action: "تتبّع", held, live });
      }
    }

    // ═══ المرحلة 2: دخول صفقات جديدة ═══
    if (canEnter) {
      const todayET = new Date().toISOString().split("T")[0];
      let candidates = [];
      try {
        const sr = await fetch(`${SUPABASE_URL}/rest/v1/signals?select=*&signal_date=eq.${todayET}&order=score.desc&limit=100`, { headers: SB_H });
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
        if (s.rvol != null && s.rvol < STRATEGY.minRvol) return false;
        if (s.vwap && s.price <= s.vwap) return false;
        if (!s.structure || s.structure.stop == null || s.structure.t1 == null) return false;
        // 🆕 v11: احترام تهدئة الرادار (سهم ضرب وقفه مؤخراً)
        if (STRATEGY.respectRadarCooldown && s.structure.cooldown) return false;
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

      // ─── الدروع (كما هي — لا تُمس) ────────────────────────
      let entriesBlocked = null;

      if (process.env.BOT_KILL === "1") entriesBlocked = "kill_switch";

      const lastEq = parseFloat(acct.last_equity || 0);
      if (!entriesBlocked && lastEq > 0) {
        const dayPnl = (balance - lastEq) / lastEq;
        if (dayPnl <= -STRATEGY.dailyLossHaltPct) entriesBlocked = `daily_halt_${(dayPnl * 100).toFixed(1)}pct`;
      }

      if (!entriesBlocked) {
        try {
          const ph = await fetch(`${ALPACA_BASE}/v2/account/portfolio/history?period=1W&timeframe=1D`, { headers: H });
          const phd = await ph.json();
          const eqArr = (phd?.equity || []).filter(v => v > 0);
          if (eqArr.length > 1) {
            const wkPnl = (balance - eqArr[0]) / eqArr[0];
            if (process.env.DISABLE_WEEKLY_HALT !== "1" && wkPnl <= -STRATEGY.weeklyLossHaltPct) entriesBlocked = `weekly_halt_${(wkPnl * 100).toFixed(1)}pct_مراجعة_يدوية`;
          }
        } catch {}
      }

      if (!entriesBlocked && STRATEGY.spyVwapFilter) {
        try {
          const spy = await fetch(`${ALPACA_DATA}/v2/stocks/SPY/snapshot`, { headers: H });
          const sd = await spy.json();
          const spyPx = sd?.latestTrade?.p || sd?.minuteBar?.c || 0;
          const spyVwap = sd?.dailyBar?.vw || 0;
          if (spyPx > 0 && spyVwap > 0 && spyPx < spyVwap) entriesBlocked = "spy_below_vwap";
        } catch {}
      }

      if (entriesBlocked) debug.entries_blocked = entriesBlocked;

      const priceMap = filtered.length ? await getLatestPrices(filtered.map(x => x.symbol)) : {};

      for (const s of filtered) {
        if (entriesBlocked) break;
        if (Date.now() - T0 > 8500) { debug.time_guard = true; break; }  // 🆕 حارس المهلة
        if (openCount >= STRATEGY.maxTrades) break;
        if (openSymbols.has(s.symbol)) continue;

        const st = s.structure;
        const live = priceMap[s.symbol] ?? await getLatestPrice(s.symbol);
        const px = live || s.price;
        if (!px) { log.skipped.push({ symbol: s.symbol, reason: "لا يوجد سعر" }); continue; }

        const radarPx = Number(s.price) || px;
        const driftPct = ((px - radarPx) / radarPx) * 100;
        if (driftPct > STRATEGY.maxDriftPct * 100) {
          log.skipped.push({ symbol: s.symbol, reason: `سعر متأخر ${driftPct.toFixed(1)}%` });
          continue;
        }

        const support = Number(st.support != null ? st.support : radarPx * 0.97);
        const confirm = Number(st.confirm != null ? st.confirm : radarPx);
        const priceShift = px - radarPx;
        const t1 = Number(s.target1 != null ? s.target1 : st.t1) + priceShift;
        const t3 = Number(s.target3 != null ? s.target3 : st.t3) + priceShift;
        let stopPx = support > 0 && support < px ? support * 0.995
                   : Number(s.stop_loss != null ? s.stop_loss : st.stop);

        if (stopPx > 0 && px <= stopPx) {
          log.skipped.push({ symbol: s.symbol, reason: `ضرب الوقف (${stopPx.toFixed(2)})` });
          continue;
        }

        const capFloor = px * (1 - STRATEGY.maxLossPct);
        if (stopPx < capFloor) stopPx = capFloor;

        // 🆕 v11: بوابة 🟢 in_zone — قلب التكامل مع scan v11
        if (STRATEGY.requireInZone) {
          const eCode = st.entry_state && st.entry_state.code;
          if (eCode) {
            if (eCode !== "in_zone") {
              log.skipped.push({ symbol: s.symbol, reason: `ليس بمنطقة الدخول (${eCode})` });
              continue;
            }
          } else if (!suitableEntry(st, px, t1, stopPx, STRATEGY.minRR, STRATEGY.entryBuffer, STRATEGY.minRoomPct)) {
            // إشارة قديمة بدون entry_state → الفحص الهيكلي القديم
            log.skipped.push({ symbol: s.symbol, reason: "خارج منطقة الدخول (فحص هيكلي)" });
            continue;
          }
        }

        const rrLive = (px - stopPx) > 0 ? (t1 - px) / (px - stopPx) : 0;
        if (rrLive < STRATEGY.minRR) {
          log.skipped.push({ symbol: s.symbol, reason: `R:R ${rrLive.toFixed(1)}` });
          continue;
        }

        // ─── التحليل الذكي (v11: انتقائي — يمنع فقط عند خطر واضح) ───
        const bars = await getMinuteBars(s.symbol, 30);
        const closes = bars ? bars.map(b => b.c) : [];
        const volumes = bars ? bars.map(b => b.v) : [];

        let momentum = { likelyUp: true, confidence: 0.5, label: "⚠️ غير معروف" };
        if (bars && bars.length >= 20) {
          momentum = predictMomentum(bars);
          if (!momentum.likelyUp && momentum.confidence > 0.6) {
            log.skipped.push({ symbol: s.symbol, reason: `زخم ضعيف (${momentum.label})` });
            continue;
          }
        }

        // انعكاس هابط صريح فقط يمنع (شهاب) — الباقي ترجيح لا قطع
        let bounceInfo = null;
        if (bars && bars.length >= 3) {
          const reversal = detectReversal(bars);
          if (reversal.patterns.includes('shooting_star')) {
            log.skipped.push({ symbol: s.symbol, reason: "انعكاس هابط (شهاب)" });
            continue;
          }
        }
        if (volumes.length >= 20) {
          const volAnalysis = analyzeVolume(volumes, closes);
          if (volAnalysis.warnings.length > 0) {
            log.skipped.push({ symbol: s.symbol, reason: `تحذير حجم: ${volAnalysis.warnings.join(',')}` });
            continue;
          }
        }
        if (bars && bars.length >= 5 && support > 0) {
          bounceInfo = detectSupportBounce(bars, px, support);  // ترجيح فقط — لا يمنع
        }

        // ─── حساب حجم المركز ──────────────────────────────
        const riskPerShare = px - stopPx;
        if (riskPerShare <= 0) {
          log.skipped.push({ symbol: s.symbol, reason: "وقف غير صالح" });
          continue;
        }

        let qualityMult = 1.0;
        const sc = Number(s.score) || 60;
        if (sc >= 85) qualityMult = 1.6;
        else if (sc >= 75) qualityMult = 1.35;
        else if (sc >= 68) qualityMult = 1.15;
        else qualityMult = 0.85;
        if (s.vcp) qualityMult += 0.15;
        if (s.fresh_zone) qualityMult += 0.10;
        if (bounceInfo && bounceInfo.isBounce) qualityMult += 0.10;  // 🆕 الارتداد ترجيح

        // ⛔ مارتينغيل/مكافآت مطفأة افتراضياً — ولو فُعّلت: سقف صارم
        let extraMult = 1.0;
        if (STRATEGY.martingale.enabled) {
          const state = await getBotState(s.symbol);
          if (state && state.loss_streak > 0) {
            const streak = Math.min(state.loss_streak, STRATEGY.martingale.maxStreak);
            extraMult *= 1 + (streak * 0.5);
          }
        }
        if (STRATEGY.bonus.enabled) {
          const state = await getBotState(s.symbol);
          if (state && state.win_streak >= 5) extraMult *= STRATEGY.bonus.winStreak5;
          else if (state && state.win_streak >= 3) extraMult *= STRATEGY.bonus.winStreak3;
          else if (state && state.win_streak >= 1) extraMult *= STRATEGY.bonus.winStreak1;
        }

        // 🆕 السقف الصارم: لا مضاعف إجمالي فوق 1.6 مهما اجتمعت الأسباب
        const totalMult = Math.min(Math.max(qualityMult * extraMult, 0.85), STRATEGY.maxTotalMult);

        let fullValue = (balance * STRATEGY.riskPerTradePct) * px / riskPerShare;
        fullValue = fullValue * totalMult;
        fullValue = Math.min(fullValue, balance * STRATEGY.maxPositionPct);

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
        const initialQty = Math.max(2, Math.floor(fullQty * STRATEGY.initialFraction));
        const addQty = Math.max(0, fullQty - initialQty);

        // ─── 🆕 v11: الهدف القريب لتأمين الربح ─────────────
        const atr = Number(s.atr14) || px * 0.02;
        const nearDist = Math.max(atr * STRATEGY.nearTP.atrMult, px * STRATEGY.nearTP.minPct);
        const nearTPpx = Math.min(t1, px + nearDist);   // لا يتجاوز T1 أبداً
        const tp1Qty = STRATEGY.nearTP.enabled ? Math.max(1, Math.floor(initialQty * STRATEGY.nearTP.sellFrac)) : 0;
        const runnerQty = initialQty - tp1Qty;

        // ─── التنفيذ: براكِتان ذريان (الحماية تعيش على Alpaca) ──
        let buyOk = false, buyErr = null;
        if (STRATEGY.nearTP.enabled && tp1Qty >= 1 && runnerQty >= 1) {
          const b1 = await buyBracket(s.symbol, tp1Qty, nearTPpx * STRATEGY.tp1FillNudge, stopPx);
          if (b1.status === "rejected" || b1.code) { buyErr = b1.message || "رفض براكِت الهدف القريب"; }
          else {
            const b2 = await buyBracket(s.symbol, runnerQty, t1 * STRATEGY.tp1FillNudge, stopPx);
            if (b2.status === "rejected" || b2.code) {
              // النصف الأول دخل — النصف الثاني رُفض: نكمل بالنصف الأول فقط (محمي ببراكِته)
              log.skipped.push({ symbol: s.symbol, reason: "براكِت الثاني رُفض — دخلنا بالنصف الأول فقط" });
            }
            buyOk = true;
          }
        } else {
          const buy = await buyBracket(s.symbol, initialQty, t1 * STRATEGY.tp1FillNudge, stopPx);
          if (buy.status === "rejected" || buy.code) buyErr = buy.message || null;
          else buyOk = true;
        }

        if (!buyOk) {
          log.skipped.push({ symbol: s.symbol, reason: "رُفض البراكِت", err: buyErr });
          continue;
        }

        // ─── حفظ الخطة ──────────────────────────────────
        const plan = {
          symbol: s.symbol, status: "active",
          initial_qty: initialQty, add_qty: addQty, added: false,
          add_enabled: STRATEGY.addEnabled && addQty > 0,
          total_qty: initialQty, avg_entry: px,
          add_level: (support + px) / 2, stop: stopPx, t1: t1, t3: t3,
          support: support, confirm: confirm, tp1_done: false,
          // 🆕 v11: حقول تأمين الربح
          near_tp: +nearTPpx.toFixed(4), tp1_qty: tp1Qty, runner_qty: runnerQty, be_done: false,
          stock_type: s.type || "مضاربة",
          t1_sell_frac: (s.type === "استثمار") ? 0.33 : 0.50,
        };
        await planSave(plan);

        deployed += initialQty * px;
        openCount++;
        openSymbols.add(s.symbol);

        log.entered.push({
          symbol: s.symbol,
          px: +px.toFixed(2),
          initialQty,
          nearTP: +nearTPpx.toFixed(2),
          tp1Qty, runnerQty,
          reserveAdd: addQty,
          stop: +stopPx.toFixed(2),
          tp1: +t1.toFixed(2),
          rr: +((t1 - px) / (px - stopPx)).toFixed(2),
          momentum: momentum.label,
          entry_state: (st.entry_state && st.entry_state.code) || "legacy",
        });
      }

      const skipTally = {};
      for (const sk of log.skipped) skipTally[sk.reason] = (skipTally[sk.reason] || 0) + 1;
      debug.phase = "enter";
      debug.candidates = candidates.length;
      debug.after_filter = filtered.length;
      debug.entered = log.entered.length;
      debug.skipped = log.skipped.length;
      debug.skip_reasons = skipTally;
      debug.deployed_pct = balance > 0 ? Math.round((deployed / balance) * 100) : 0;
    }

    return res.status(200).json({
      success: true,
      engine: STRATEGY.engine,
      time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      elapsed_ms: Date.now() - T0,
      debug,
      ...log,
    });

  } catch (e) {
    return res.status(200).json({ success: false, error: e.message, elapsed_ms: Date.now() - T0 });
  }
}
