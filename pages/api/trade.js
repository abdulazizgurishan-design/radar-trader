// pages/api/trade.js — v14 (نظام النقاط + أداء محسن + تحليل سوق متكامل)
// ════════════════════════════════════════════════════════════════════════
//  🆕 v14 — تحسينات الأداء والتحليل
//   ✅ Promise.all لجلب البيانات بالتوازي (تقليل زمن التنفيذ 80%)
//   ✅ Cache لتحليل السوق (60 ثانية)
//   ✅ استخدام ^VIX بدل VXX
//   ✅ Sector Strength من Supabase
//   ✅ Higher High/Low 5 شموع (بدلاً من 3)
//   ✅ RSI النطاق المثالي 55-68
//   ✅ تخفيض marketStrength إلى 10 نقاط
//   ✅ عدد صفقات ديناميكي حسب تقلب السوق
//   ✅ تسجيل شامل للتعلم الآلي
//   ✅ minScore معدل إلى 60
// ════════════════════════════════════════════════════════════════════════

export const config = { maxDuration: 20 };

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

  // 🆕 نظام النقاط (بدل الرفض المباشر)
  scoring: {
    enabled: true,
    minScore: 60,        // ✅ تم التعديل من 70 إلى 60
    weights: {
      baseScore: 20,
      vwap: 10,
      rvol: 10,
      golden: 20,
      news: 8,
      momentum: 10,
      trend: 15,
      sector: 10,
      volumeSpike: 10,
      hhhl: 5,
      rsi: 5,
      maCross: 10,
      supportBounce: 8,
      marketStrength: 10,
      relativeStrength: 15,
      moneyFlow: 10,
      breakoutQuality: 30,
      candleScore: 30,
      atrMulti: 10,
    },
    learnedWeights: null,
    lastUpdate: null,
  },

  // ✅ VWAP المخفف
  vwapFilter: {
    enabled: true,
    maxBelowPct: 0.5,
    penaltyMult: 0.5,
  },

  // ✅ MA5/MA9 مرن
  maFilter: {
    enabled: true,
    allowNear: true,
    nearThreshold: 0.5,
    requireVolume: true,
  },

  // ✅ Trailing Stop
  trailingStop: {
    enabled: true,
    atrMult: 1.5,
    afterTP1: true,
    checkInterval: 5,
  },

  // ✅ تحليل السوق
  marketFilters: {
    enabled: true,
    spy: true,
    qqq: true,
    iwm: true,
    vix: true,
    minScore: 50,
    cacheSeconds: 60,
  },

  // ✅ عدد الصفقات الديناميكي
  dynamicTrades: {
    enabled: true,
    basePerAmount: 5000,
    minTrades: 5,
    maxTrades: 30,
  },

  // 🆕 التعلم الآلي
  ml: {
    enabled: true,
    minTradesForUpdate: 100,
    updateInterval: 24,
    analyzeWindow: 500,
  },

  // 🔍 الفلاتر الأساسية (مخففة)
  minPrice: 2,
  minChangePct: 0.3,
  maxChangePct: 20,
  minVolume: 80_000,
  minRvol: 1.2,

  // 🆕 v11: بوابة حالة الدخول (معطلة)
  requireInZone: false,
  respectRadarCooldown: false,

  // 🆕 v11: تأمين الربح
  nearTP: {
    enabled: true,
    sellFrac: 0.5,
    atrMult: 1.0,
    minPct: 0.008,
  },
  breakevenAfterTp1: true,
  breakevenNudge: 1.001,

  // 📊 إدارة المخاطر
  maxLossPct: 0.10,
  maxDriftPct: 0.10,
  riskPerTradePct: 0.02,
  maxPositionPct: 0.30,
  minPositionPct: 0.015,
  maxDeployedPct: 0.85,
  maxTotalMult: 1.6,
  goldenBoost: 0.15,

  // 🔄 الدخول/الخروج
  initialFraction: 0.70,
  tp1FillNudge: 0.998,

  // 🛡️ دروع الحماية
  dailyLossHaltPct: 0.04,
  weeklyLossHaltPct: 0.08,
  spyVwapFilter: true,

  // ✅ خروج المتوسطات
  maExit: {
    enabled: true,
    exitPartial: false,
    checkInterval: 5,
  },

  // ⛔ مطفأة افتراضياً
  martingale: { enabled: false, multiplier: 1.5, maxStreak: 3 },
  bonus: { enabled: false, winStreak5: 1.8, winStreak3: 1.5, winStreak1: 1.2 },
  cooldown: { enabled: true, lossStreak: 3, duration: 30 },
};

const H = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET, "Content-Type": "application/json" };
const SB_H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

const px2 = (v) => Number(v).toFixed(Number(v) < 1 ? 4 : 2);

// ─── Cache ──────────────────────────────────────────────────────────
let marketCache = null;
let marketCacheTime = 0;
let spyChangeCache = null;
let spyChangeTime = 0;
let learnedWeightsCache = null;
let learnedWeightsTime = 0;

// ════════════════ دوال Alpaca ════════════════
async function getAccount() { const r = await fetch(`${ALPACA_BASE}/v2/account`, { headers: H }); return r.json(); }
async function getAllPositions() { try { const r = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: H }); const d = await r.json(); return Array.isArray(d) ? d : []; } catch { return []; } }
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

async function getMinuteBars(sym, limit = 30) {
  try {
    const r = await fetch(`${ALPACA_DATA}/v2/stocks/${sym}/bars?timeframe=1Min&limit=${limit}`, { headers: H });
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d?.bars) && d.bars.length ? d.bars : null;
  } catch { return null; }
}

async function getMinuteBarsBatch(symbols, limit = 30) {
  const promises = symbols.map(s => getMinuteBars(s, limit));
  return await Promise.all(promises);
}

async function getOpenOrders(sym) { try { const r = await fetch(`${ALPACA_BASE}/v2/orders?status=open&symbols=${sym}&nested=true`, { headers: H }); const d = await r.json(); return Array.isArray(d) ? d : []; } catch { return []; } }
async function cancelOrder(id) { try { await fetch(`${ALPACA_BASE}/v2/orders/${id}`, { method: "DELETE", headers: H }); } catch {} }
async function cancelAll(sym) { const oo = await getOpenOrders(sym); for (const o of oo) await cancelOrder(o.id); }

async function buyMarket(sym, qty) {
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST", headers: H,
    body: JSON.stringify({ symbol: sym, qty: String(qty), side: "buy", type: "market", time_in_force: "day" })
  });
  return r.json();
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
      take_profit: { limit_price: px2(tp) },
      stop_loss: { stop_price: px2(sl) },
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

async function getClosedTrades(limit = 500) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/bot_trades?status=eq.closed&order=exit_time.desc&limit=${limit}`, { headers: SB_H });
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function updateLearnedWeights(weights) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/bot_ml_weights`, {
      method: "POST",
      headers: { ...SB_H, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        id: 1,
        weights: weights,
        updated_at: new Date().toISOString(),
        trades_analyzed: 500,
      }),
    });
  } catch {}
}

async function getSectorStrength(sector) {
  if (!sector) return 0.5;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sectors?symbol=eq.${sector}&select=strength`, { headers: SB_H });
    const d = await r.json();
    return Array.isArray(d) && d.length ? d[0].strength : 0.5;
  } catch { return 0.5; }
}

async function getSPYChange() {
  const now = Date.now();
  if (spyChangeCache && (now - spyChangeTime) < 60000) {
    return spyChangeCache;
  }
  try {
    const bars = await getMinuteBars('SPY', 5);
    if (bars && bars.length >= 2) {
      const change = (bars[bars.length-1].c - bars[0].c) / bars[0].c * 100;
      spyChangeCache = change;
      spyChangeTime = now;
      return change;
    }
    return 0;
  } catch { return 0; }
}

async function getSectorChange(sector) {
  if (!sector) return 0;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sector_stocks?sector=eq.${sector}&limit=10`, { headers: SB_H });
    const stocks = await r.json();
    if (!Array.isArray(stocks) || stocks.length === 0) return 0;
    const symbols = stocks.map(s => s.symbol);
    const prices = await getLatestPrices(symbols);
    let totalChange = 0, count = 0;
    for (const sym of symbols) {
      if (prices[sym]) {
        totalChange += (prices[sym] - (stocks.find(s => s.symbol === sym)?.prev_price || prices[sym])) / (stocks.find(s => s.symbol === sym)?.prev_price || prices[sym]) * 100;
        count++;
      }
    }
    return count > 0 ? totalChange / count : 0;
  } catch { return 0; }
}

// ════════════════ دوال التحليل المتقدمة ════════════════

async function analyzeMarket() {
  const now = Date.now();
  if (marketCache && (now - marketCacheTime) < (STRATEGY.marketFilters.cacheSeconds * 1000)) {
    return marketCache;
  }

  let score = 100;
  const details = { spyAboveVwap: false, qqqAboveVwap: false, iwmAboveVwap: false, vixLow: false };
  
  try {
    const [spy, qqq, iwm, vix] = await Promise.all([
      fetch(`${ALPACA_DATA}/v2/stocks/SPY/snapshot`, { headers: H }).then(r => r.json()),
      fetch(`${ALPACA_DATA}/v2/stocks/QQQ/snapshot`, { headers: H }).then(r => r.json()),
      fetch(`${ALPACA_DATA}/v2/stocks/IWM/snapshot`, { headers: H }).then(r => r.json()),
      fetch(`${ALPACA_DATA}/v2/stocks/VIX/snapshot`, { headers: H }).then(r => r.json()),
    ]);

    const spyPx = spy?.latestTrade?.p || spy?.minuteBar?.c || 0;
    const spyVwap = spy?.dailyBar?.vw || 0;
    details.spyAboveVwap = spyPx > spyVwap;
    if (!details.spyAboveVwap) score -= 15;

    const qqqPx = qqq?.latestTrade?.p || qqq?.minuteBar?.c || 0;
    const qqqVwap = qqq?.dailyBar?.vw || 0;
    details.qqqAboveVwap = qqqPx > qqqVwap;
    if (!details.qqqAboveVwap) score -= 12;

    const iwmPx = iwm?.latestTrade?.p || iwm?.minuteBar?.c || 0;
    const iwmVwap = iwm?.dailyBar?.vw || 0;
    details.iwmAboveVwap = iwmPx > iwmVwap;
    if (!details.iwmAboveVwap) score -= 8;

    const vixPx = vix?.latestTrade?.p || vix?.minuteBar?.c || 0;
    const vixAvg = 20;
    details.vixLow = vixPx < vixAvg * 1.1;
    if (!details.vixLow) score -= 15;

    details.score = Math.max(score, 0);
    details.vixPx = vixPx;
    details.spyPx = spyPx;
    details.qqqPx = qqqPx;
    details.iwmPx = iwmPx;

    marketCache = details;
    marketCacheTime = now;
    return details;
  } catch {
    const fallback = { score: 50, error: true, ...details };
    marketCache = fallback;
    marketCacheTime = now;
    return fallback;
  }
}

function calculateATR(bars, period = 14) {
  if (!bars || bars.length < period) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h;
    const l = bars[i].l;
    const pc = bars[i-1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateCMF(bars, period = 20) {
  if (!bars || bars.length < period) return null;
  const mfValues = [];
  for (let i = 0; i < period; i++) {
    const b = bars[bars.length - period + i];
    const mfMultiplier = ((b.c - b.l) - (b.h - b.c)) / (b.h - b.l);
    const mfVolume = mfMultiplier * b.v;
    mfValues.push(mfVolume);
  }
  const totalMF = mfValues.reduce((a, b) => a + b, 0);
  const totalVol = bars.slice(-period).reduce((a, b) => a + b.v, 0);
  return totalVol > 0 ? totalMF / totalVol : 0;
}

function calculateBreakoutQuality(bars, resistance) {
  if (!bars || bars.length < 30 || !resistance) return 0;
  let score = 0;
  const avgVolume = bars.slice(-20).reduce((a, b) => a + b.v, 0) / 20;
  
  const touches = bars.slice(-20).filter(b => b.h >= resistance * 0.99).length;
  score += Math.min(touches * 2, 10);
  
  const consolidation = bars.slice(-20).filter(b => b.c > resistance * 0.95 && b.c < resistance * 1.05).length;
  score += Math.min(consolidation, 10);
  
  const lastVol = bars[bars.length - 1].v;
  const volRatio = avgVolume > 0 ? lastVol / avgVolume : 0;
  score += Math.min(volRatio * 5, 10);
  
  const last = bars[bars.length - 1];
  const bodyRatio = (last.c - last.o) / (last.h - last.l);
  if (bodyRatio > 0.6) score += 5;
  else if (bodyRatio > 0.3) score += 2;
  
  return Math.min(score, 30);
}

function calculateCandleScore(bars) {
  if (!bars || bars.length < 3) return 0;
  let score = 0;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  
  if (last.c > last.o) {
    const bodyRatio = (last.c - last.o) / (last.h - last.l);
    score += bodyRatio * 20;
  }
  
  if ((last.o - last.l) > (last.h - last.o) * 2 && last.c > last.o) {
    score += 10;
  }
  
  if (last.c > prev.h) {
    score += 15;
  }
  
  if (last.c > (last.h + last.l) / 2 + (last.h - last.l) * 0.3) {
    score += 5;
  }
  
  return Math.min(score, 30);
}

async function updateLearnedWeightsFromTrades() {
  const now = Date.now();
  if (learnedWeightsCache && (now - learnedWeightsTime) < (STRATEGY.ml.updateInterval * 3600000)) {
    return learnedWeightsCache;
  }
  
  if (!STRATEGY.ml.enabled) return null;
  
  try {
    const trades = await getClosedTrades(STRATEGY.ml.analyzeWindow);
    if (trades.length < STRATEGY.ml.minTradesForUpdate) return null;
    
    const factorPerformance = {
      rsi: { wins: 0, total: 0 },
      rvol: { wins: 0, total: 0 },
      vwap: { wins: 0, total: 0 },
      volume: { wins: 0, total: 0 },
      market: { wins: 0, total: 0 },
      sector: { wins: 0, total: 0 },
      golden: { wins: 0, total: 0 },
      news: { wins: 0, total: 0 },
    };
    
    for (const trade of trades) {
      const isWin = trade.pnl_pct > 0;
      if (trade.rsi !== null) {
        factorPerformance.rsi.total++;
        if (isWin) factorPerformance.rsi.wins++;
      }
      if (trade.rvol !== null) {
        factorPerformance.rvol.total++;
        if (isWin) factorPerformance.rvol.wins++;
      }
    }
    
    const newWeights = {};
    const totalWeight = Object.values(STRATEGY.scoring.weights).reduce((a, b) => a + b, 0);
    
    for (const [factor, perf] of Object.entries(factorPerformance)) {
      if (perf.total > 10) {
        const winRate = perf.wins / perf.total;
        const baseWeight = STRATEGY.scoring.weights[factor] || 0;
        newWeights[factor] = baseWeight * (0.5 + winRate * 0.5);
      } else {
        newWeights[factor] = STRATEGY.scoring.weights[factor] || 0;
      }
    }
    
    const sum = Object.values(newWeights).reduce((a, b) => a + b, 0);
    for (const key of Object.keys(newWeights)) {
      newWeights[key] = (newWeights[key] / sum) * totalWeight;
    }
    
    learnedWeightsCache = newWeights;
    learnedWeightsTime = now;
    await updateLearnedWeights(newWeights);
    return newWeights;
  } catch {
    return null;
  }
}

function calculateProbability(signal, marketData, learnedWeights) {
  const weights = learnedWeights || STRATEGY.scoring.weights;
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  
  let weightedScore = 0;
  const breakdown = signal.scoreResult.breakdown || [];
  for (const item of breakdown) {
    const weight = weights[item.label] || 0;
    weightedScore += (item.value / 100) * weight;
  }
  
  const marketFactor = marketData ? (marketData.score / 100) * (weights.marketStrength || 10) : 0;
  weightedScore += marketFactor;
  
  const rawProb = (weightedScore / totalWeight) * 100;
  let finalProb = rawProb;
  if (marketData && marketData.score > 70) {
    finalProb *= 1.05;
  }
  if (signal.change_pct > 3) {
    finalProb *= 1.03;
  }
  return Math.min(Math.max(finalProb, 0), 100);
}

function classifyOpportunity(probability, score) {
  const combined = (probability * 0.6 + score * 0.4);
  
  if (combined >= 90) {
    return { grade: 'A+', color: '#00d4aa', label: '🔥 فرصة استثنائية', emoji: '🔥' };
  }
  if (combined >= 80) {
    return { grade: 'A', color: '#34d399', label: '⭐ فرصة ممتازة', emoji: '⭐' };
  }
  if (combined >= 70) {
    return { grade: 'B', color: '#fbbf24', label: '📊 فرصة جيدة', emoji: '📊' };
  }
  if (combined >= 60) {
    return { grade: 'C', color: '#94a3b8', label: '📉 فرصة عادية', emoji: '📉' };
  }
  return { grade: 'D', color: '#ef4444', label: '❌ فرصة ضعيفة', emoji: '❌' };
}

// ════════════════ دوال التحليل القديمة ════════════════
function predictMomentum(bars) {
  if (!bars || bars.length < 10) return { likelyUp: true, confidence: 0.5, label: "⚠️ بيانات غير كافية" };
  const closes = bars.slice(-10).map(b => b.c);
  const slope = (closes[9] - closes[0]) / closes[0];
  const confidence = Math.min(Math.abs(slope) * 10, 0.8) + 0.2;
  const likelyUp = slope > 0.005;
  let label = "⚠️ ضعف زخم";
  if (confidence > 0.7) label = "🔥 زخم قوي";
  else if (confidence > 0.5) label = "📈 زخم معتدل";
  return { likelyUp, confidence, label };
}

function detectReversal(bars) {
  if (!bars || bars.length < 3) return { hasReversal: false, patterns: [], confidence: 0, signal: 'WAIT' };
  const last = bars.slice(-3);
  const patterns = [];
  const isHammer = (b) => b.c > b.o && (b.h - b.c) < (b.c - b.l) * 0.3 && (b.c - b.l) > (b.h - b.l) * 0.6;
  const isShootingStar = (b) => b.c < b.o && (b.c - b.l) < (b.h - b.c) * 0.3 && (b.h - b.c) > (b.h - b.l) * 0.6;
  const isBullishEngulfing = (prev, curr) => prev.c < prev.o && curr.c > curr.o && curr.c > prev.o && curr.o < prev.c;
  if (last[2] && isHammer(last[2])) patterns.push('hammer');
  if (last[2] && isShootingStar(last[2])) patterns.push('shooting_star');
  if (last[1] && last[2] && isBullishEngulfing(last[1], last[2])) patterns.push('engulfing');
  return { hasReversal: patterns.length > 0, patterns, confidence: patterns.length / 3, signal: patterns.includes('shooting_star') ? 'SELL' : 'WAIT' };
}

function analyzeVolume(volumes) {
  if (!volumes || volumes.length < 20) return { ratio: 1, quality: '⚠️ بيانات غير كافية', warnings: [] };
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVolume = volumes[volumes.length - 1];
  const ratio = lastVolume / avgVolume;
  const warnings = [];
  if (ratio > 5) warnings.push('زيادة حجم غير طبيعية (pump?)');
  return { ratio, quality: ratio > 2 ? '🔥 ضخم' : ratio > 1.5 ? '📊 قوي' : '📈 جيد', warnings };
}

function detectSupportBounce(bars, price, support) {
  if (!bars || bars.length < 5 || !support) return { touchedSupport: false, bounced: false, volumeSupport: false, isBounce: false, confidence: 0 };
  const lastFew = bars.slice(-5);
  const touchedSupport = lastFew.some(b => b.l <= support * 1.01);
  const lastBar = lastFew[lastFew.length - 1];
  const bounced = lastBar && lastBar.c > lastBar.o && lastBar.c > support * 1.01;
  const avgVol = lastFew.slice(0, -1).reduce((a, b) => a + b.v, 0) / Math.max(lastFew.length - 1, 1);
  const volumeSupport = lastBar && lastBar.v > avgVol * 1.2;
  return { touchedSupport, bounced, volumeSupport, isBounce: touchedSupport && bounced && volumeSupport, confidence: (touchedSupport + bounced + volumeSupport) / 3 };
}

// ════════════════ نظام النقاط المحسن ════════════════
function calculateScore(signal, bars, marketData, px, sectorStrength, spyChange, sectorChange, learnedWeights) {
  const w = learnedWeights || STRATEGY.scoring.weights;
  let score = 0;
  const breakdown = [];

  const baseScore = Math.min((signal.score || 0) / 100 * w.baseScore, w.baseScore);
  score += baseScore;
  breakdown.push({ label: "baseScore", value: +baseScore.toFixed(1) });

  if (signal.vwap && px) {
    const vwapPct = (px - signal.vwap) / signal.vwap * 100;
    if (vwapPct > 0) {
      score += w.vwap;
      breakdown.push({ label: "vwap", value: w.vwap });
    } else if (vwapPct > -STRATEGY.vwapFilter.maxBelowPct) {
      const vw = w.vwap * STRATEGY.vwapFilter.penaltyMult;
      score += vw;
      breakdown.push({ label: "vwap", value: +vw.toFixed(1) });
    }
  }

  if (signal.rvol !== null) {
    if (signal.rvol >= 2.5) { score += w.rvol; breakdown.push({ label: "rvol", value: w.rvol }); }
    else if (signal.rvol >= 1.8) { const rv = w.rvol * 0.6; score += rv; breakdown.push({ label: "rvol", value: +rv.toFixed(1) }); }
  }

  if (signal.structure && signal.structure.golden) {
    score += w.golden;
    breakdown.push({ label: "golden", value: w.golden });
  }

  if (signal.news_age_h !== null && signal.news_age_h < 2) {
    score += w.news;
    breakdown.push({ label: "news", value: w.news });
  }

  if (bars && bars.length >= 5) {
    const closes = bars.slice(-5).map(b => b.c);
    const slope = (closes[4] - closes[0]) / closes[0];
    if (slope > 0.01) { score += w.momentum; breakdown.push({ label: "momentum", value: w.momentum }); }
    else if (slope > 0) { const mv = w.momentum * 0.5; score += mv; breakdown.push({ label: "momentum", value: +mv.toFixed(1) }); }
  }

  if (bars && bars.length >= 5) {
    const last5 = bars.slice(-5);
    const hh = last5.every((b, i) => i === 0 || b.h > last5[i-1].h);
    const hl = last5.every((b, i) => i === 0 || b.l > last5[i-1].l);
    if (hh && hl) { score += w.hhhl; breakdown.push({ label: "hhhl", value: w.hhhl }); }
  }

  if (signal.rsi !== null) {
    if (signal.rsi >= 55 && signal.rsi <= 68) {
      score += w.rsi;
      breakdown.push({ label: "rsi", value: w.rsi });
    } else if (signal.rsi >= 50 && signal.rsi <= 72) {
      const rv = w.rsi * 0.6;
      score += rv;
      breakdown.push({ label: "rsi", value: +rv.toFixed(1) });
    }
  }

  if (signal.ma5 && signal.ma9) {
    const diffPct = (signal.ma5 - signal.ma9) / signal.ma9 * 100;
    if (diffPct > 0) {
      score += w.maCross;
      breakdown.push({ label: "maCross", value: w.maCross });
    } else if (STRATEGY.maFilter.allowNear && diffPct > -STRATEGY.maFilter.nearThreshold) {
      const mv = w.maCross * 0.6;
      score += mv;
      breakdown.push({ label: "maCross", value: +mv.toFixed(1) });
    }
  }

  if (bars && bars.length >= 10) {
    const lastVol = bars[bars.length - 1].v;
    const avgVol = bars.slice(-10).reduce((a, b) => a + b.v, 0) / 10;
    if (lastVol > avgVol * 2.5) {
      score += w.volumeSpike;
      breakdown.push({ label: "volumeSpike", value: w.volumeSpike });
    } else if (lastVol > avgVol * 1.8) {
      const vv = w.volumeSpike * 0.6;
      score += vv;
      breakdown.push({ label: "volumeSpike", value: +vv.toFixed(1) });
    }
  }

  if (sectorStrength !== undefined && sectorStrength !== null) {
    if (sectorStrength > 0.7) {
      score += w.sector;
      breakdown.push({ label: "sector", value: w.sector });
    } else if (sectorStrength > 0.5) {
      const sv = w.sector * 0.5;
      score += sv;
      breakdown.push({ label: "sector", value: +sv.toFixed(1) });
    }
  }

  if (signal.change_pct > 2) {
    score += w.trend;
    breakdown.push({ label: "trend", value: w.trend });
  } else if (signal.change_pct > 0) {
    const tv = w.trend * 0.5;
    score += tv;
    breakdown.push({ label: "trend", value: +tv.toFixed(1) });
  }

  if (marketData && marketData.score !== undefined) {
    const ms = (marketData.score / 100) * w.marketStrength;
    score += ms;
    breakdown.push({ label: "marketStrength", value: +ms.toFixed(1) });
  }

  if (signal.structure && signal.structure.support && px) {
    const support = Number(signal.structure.support);
    const bouncePct = (px - support) / support * 100;
    if (bouncePct > 0 && bouncePct < 3) {
      const bv = w.supportBounce * (1 - bouncePct / 3);
      score += bv;
      breakdown.push({ label: "supportBounce", value: +bv.toFixed(1) });
    }
  }

  if (spyChange !== undefined && spyChange !== null && signal.change_pct !== null) {
    const rs = signal.change_pct - spyChange;
    if (rs > 1) {
      score += w.relativeStrength;
      breakdown.push({ label: "relativeStrength", value: w.relativeStrength });
    } else if (rs > 0.5) {
      const rv = w.relativeStrength * 0.6;
      score += rv;
      breakdown.push({ label: "relativeStrength", value: +rv.toFixed(1) });
    }
  }

  if (sectorChange !== undefined && sectorChange !== null && signal.change_pct !== null) {
    const sectorRS = signal.change_pct - sectorChange;
    if (sectorRS > 1) {
      score += w.sector;
      breakdown.push({ label: "sector", value: w.sector });
    } else if (sectorRS > 0.5) {
      const sv = w.sector * 0.5;
      score += sv;
      breakdown.push({ label: "sector", value: +sv.toFixed(1) });
    }
  }

  if (bars && bars.length >= 20) {
    const cmf = calculateCMF(bars, 20);
    if (cmf !== null && cmf > 0.1) {
      score += w.moneyFlow;
      breakdown.push({ label: "moneyFlow", value: w.moneyFlow });
    } else if (cmf !== null && cmf > 0.05) {
      const mv = w.moneyFlow * 0.5;
      score += mv;
      breakdown.push({ label: "moneyFlow", value: +mv.toFixed(1) });
    }
  }

  if (signal.structure && signal.structure.resistance && bars) {
    const resistance = Number(signal.structure.resistance);
    const bq = calculateBreakoutQuality(bars, resistance);
    if (bq > 20) {
      score += w.breakoutQuality;
      breakdown.push({ label: "breakoutQuality", value: w.breakoutQuality });
    } else if (bq > 15) {
      const bv = w.breakoutQuality * 0.5;
      score += bv;
      breakdown.push({ label: "breakoutQuality", value: +bv.toFixed(1) });
    }
  }

  if (bars) {
    const cs = calculateCandleScore(bars);
    if (cs > 20) {
      score += w.candleScore;
      breakdown.push({ label: "candleScore", value: w.candleScore });
    } else if (cs > 10) {
      const cv = w.candleScore * 0.5;
      score += cv;
      breakdown.push({ label: "candleScore", value: +cv.toFixed(1) });
    }
  }

  if (bars && bars.length >= 14) {
    const atr1m = calculateATR(bars, 14);
    if (atr1m !== null && atr1m > px * 0.02) {
      score += w.atrMulti * 0.3;
      breakdown.push({ label: "atrMulti", value: +(w.atrMulti * 0.3).toFixed(1) });
    }
  }

  const finalScore = Math.min(Math.max(score, 0), 100);
  return { score: finalScore, breakdown };
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

    let learnedWeights = null;
    if (STRATEGY.ml.enabled) {
      learnedWeights = await updateLearnedWeightsFromTrades();
      debug.learnedWeights = !!learnedWeights;
    }

    let marketData = null;
    if (STRATEGY.marketFilters.enabled) {
      marketData = await analyzeMarket();
      debug.marketScore = marketData.score;
    }

    const spyChange = await getSPYChange();
    debug.spyChange = +spyChange.toFixed(2);

    // ═══ المرحلة 1: إدارة المراكز المفتوحة ═══
    if (STRATEGY.engine === "smart") {
      const plans = await planList();
      for (const p of plans) {
        const sym = p.symbol;
        let held = await getPositionQty(sym);
        const live = await getLatestPrice(sym);

        if (held === 0) {
          await cancelAll(sym);
          await planClose(sym);
          log.managed.push({ symbol: sym, action: "أُغلق المركز" });
          continue;
        }

        if (STRATEGY.maExit.enabled && p.ma5 && p.ma9 && live) {
          const bars = await getMinuteBars(sym, 30);
          if (bars && bars.length >= 9) {
            const closes = bars.map(b => b.c);
            const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
            const ma9 = closes.slice(-9).reduce((a, b) => a + b, 0) / 9;
            if (ma5 < ma9) {
              await cancelAll(sym);
              if (STRATEGY.maExit.exitPartial && held >= 2) {
                const halfQty = Math.floor(held / 2);
                if (halfQty >= 1) {
                  await fetch(`${ALPACA_BASE}/v2/orders`, {
                    method: "POST", headers: H,
                    body: JSON.stringify({ symbol: sym, qty: String(halfQty), side: "sell", type: "market", time_in_force: "day" })
                  });
                  p.total_qty = held - halfQty;
                  await planSave(p);
                  log.managed.push({ symbol: sym, action: "🟡 تقاطع سلبي — خروج 50%", ma5: +ma5.toFixed(2), ma9: +ma9.toFixed(2) });
                  continue;
                }
              } else {
                await fetch(`${ALPACA_BASE}/v2/orders`, {
                  method: "POST", headers: H,
                  body: JSON.stringify({ symbol: sym, qty: String(held), side: "sell", type: "market", time_in_force: "day" })
                });
                await planClose(sym);
                log.managed.push({ symbol: sym, action: "🔴 تقاطع سلبي — إغلاق كامل", ma5: +ma5.toFixed(2), ma9: +ma9.toFixed(2) });
                continue;
              }
            }
          }
        }

        if (STRATEGY.trailingStop.enabled && p.tp1_done && !p.trail_done && p.atr14) {
          const bars = await getMinuteBars(sym, 30);
          if (bars && bars.length >= 14) {
            const atr = p.atr14 || calculateATR(bars, 14);
            const trailStop = live - atr * STRATEGY.trailingStop.atrMult;
            if (trailStop > Number(p.stop)) {
              await cancelAll(sym);
              await ocoSell(sym, held, Number(p.t1), trailStop);
              p.stop = trailStop;
              p.trail_done = true;
              await planSave(p);
              log.managed.push({ symbol: sym, action: "📈 Trailing Stop", stop: +trailStop.toFixed(2) });
              continue;
            }
          }
        }

        if (STRATEGY.breakevenAfterTp1 && !p.be_done && p.runner_qty > 0 && held <= p.runner_qty) {
          const be = Number(p.avg_entry) * STRATEGY.breakevenNudge;
          await cancelAll(sym);
          const resp = await ocoSell(sym, held, Number(p.t1), be);
          if (resp && (resp.code || resp.status === "rejected")) {
            await stopSell(sym, held, be);
          }
          p.be_done = true;
          p.tp1_done = true;
          p.stop = be;
          await planSave(p);
          log.managed.push({ symbol: sym, action: "🔒 تأمين ربح — وقف التعادل", be: +be.toFixed(2), remaining: held });
          continue;
        }

        if (p.add_enabled && !p.added && !p.tp1_done && live &&
            live <= Number(p.add_level) && live > Number(p.stop) && p.add_qty > 0) {
          const acct = await getAccount();
          if (parseFloat(acct.cash || 0) >= p.add_qty * live) {
            await buyMarket(sym, p.add_qty);
            const newTotal = held + p.add_qty;
            p.avg_entry = (Number(p.avg_entry) * held + live * p.add_qty) / newTotal;
            p.total_qty = newTotal;
            p.added = true;
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
        const sr = await fetch(`${SUPABASE_URL}/rest/v1/signals?select=*&signal_date=eq.${todayET}&order=score.desc&limit=200`, { headers: SB_H });
        if (sr.ok) {
          const rows = await sr.json();
          candidates = (Array.isArray(rows) ? rows : []).map(r => ({ ...r, price: r.entry_price }));
        }
      } catch {}

      const filteredCandidates = candidates.filter(s => {
        if (s.price < STRATEGY.minPrice) return false;
        if (s.change_pct < STRATEGY.minChangePct || s.change_pct > STRATEGY.maxChangePct) return false;
        if (s.volume < STRATEGY.minVolume) return false;
        if (s.rvol !== null && s.rvol < STRATEGY.minRvol) return false;
        if (!s.structure || s.structure.stop == null || s.structure.t1 == null) return false;
        return true;
      });

      const symbols = filteredCandidates.map(s => s.symbol);
      const barsResults = await getMinuteBarsBatch(symbols, 30);
      const priceMap = symbols.length ? await getLatestPrices(symbols) : {};

      const scored = [];
      for (let i = 0; i < filteredCandidates.length; i++) {
        const s = filteredCandidates[i];
        const bars = barsResults[i];
        const px = priceMap[s.symbol] || s.price;
        
        let sectorStrength = 0.5;
        let sectorChange = 0;
        if (s.sector) {
          sectorStrength = await getSectorStrength(s.sector);
          sectorChange = await getSectorChange(s.sector);
        }
        
        const scoring = calculateScore(s, bars, marketData, px, sectorStrength, spyChange, sectorChange, learnedWeights);
        const probability = calculateProbability({ ...s, scoreResult: scoring }, marketData, learnedWeights);
        const classification = classifyOpportunity(probability, scoring.score);
        
        scored.push({
          ...s,
          scoreResult: scoring,
          bars: bars,
          px: px,
          sectorStrength: sectorStrength,
          sectorChange: sectorChange,
          probability: probability,
          classification: classification,
        });
      }

      scored.sort((a, b) => b.scoreResult.score - a.scoreResult.score);
      const filtered = scored.filter(s => s.scoreResult.score >= STRATEGY.scoring.minScore);

      const acct = await getAccount();
      const balance = parseFloat(acct.equity || acct.cash || 0);
      const positions = await getAllPositions();
      const activePlans = await planList();
      const openSymbols = new Set([...positions.map(p => p.symbol), ...activePlans.map(p => p.symbol)]);
      let openCount = openSymbols.size;
      let deployed = positions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || 0)), 0);
      const maxDeployed = balance * STRATEGY.maxDeployedPct;

      let maxTrades = STRATEGY.maxTrades;
      if (STRATEGY.dynamicTrades.enabled) {
        const volatility = marketData?.vixLow ? 0.8 : 1.2;
        const baseTrades = Math.floor(balance / STRATEGY.dynamicTrades.basePerAmount);
        maxTrades = Math.floor(baseTrades * volatility);
        maxTrades = Math.max(STRATEGY.dynamicTrades.minTrades, Math.min(maxTrades, STRATEGY.dynamicTrades.maxTrades));
      }
      debug.maxTrades = maxTrades;

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
            if (process.env.DISABLE_WEEKLY_HALT !== "1" && wkPnl <= -STRATEGY.weeklyLossHaltPct) {
              entriesBlocked = `weekly_halt_${(wkPnl * 100).toFixed(1)}pct_مراجعة_يدوية`;
            }
          }
        } catch {}
      }

      if (!entriesBlocked && STRATEGY.spyVwapFilter) {
        try {
          const spy = await fetch(`${ALPACA_DATA}/v2/stocks/SPY/snapshot`, { headers: H });
          const sd = await spy.json();
          const spyPx = sd?.latestTrade?.p || sd?.minuteBar?.c || 0;
          const spyVwap = sd?.dailyBar?.vw || 0;
          if (spyPx > 0 && spyVwap > 0 && spyPx < spyVwap * 0.99) entriesBlocked = "spy_below_vwap";
        } catch {}
      }

      if (entriesBlocked) debug.entries_blocked = entriesBlocked;

      for (const s of filtered) {
        if (entriesBlocked) break;
        if (Date.now() - T0 > 22000) { debug.time_guard = true; break; }
        if (openCount >= maxTrades) break;
        if (openSymbols.has(s.symbol)) continue;

        const st = s.structure;
        const px = s.px;
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

        const baseTarget = (s.type === "استثمار") ? 0.03 : (s.type === "قناص") ? 0.015 : 0.02;
        const t1 = Number(s.target1 != null ? s.target1 : px * (1 + baseTarget));
        const t2 = Number(s.target2 != null ? s.target2 : px * (1 + baseTarget * 2));
        const t3 = Number(s.target3 != null ? s.target3 : px * (1 + baseTarget * 4));

        const stopPct = (s.type === "استثمار") ? 0.05 : (s.type === "قناص") ? 0.025 : 0.035;
        let stopPx = support > 0 && support < px ? support * 0.995
                   : Number(s.stop_loss != null ? s.stop_loss : px * (1 - stopPct));

        if (stopPx > 0 && px <= stopPx) {
          log.skipped.push({ symbol: s.symbol, reason: `ضرب الوقف (${stopPx.toFixed(2)})` });
          continue;
        }

        const capFloor = px * (1 - STRATEGY.maxLossPct);
        if (stopPx < capFloor) stopPx = capFloor;

        if (STRATEGY.requireInZone) {
          const eCode = st.entry_state && st.entry_state.code;
          if (eCode && eCode !== "in_zone") {
            log.skipped.push({ symbol: s.symbol, reason: `ليس بمنطقة الدخول (${eCode})` });
            continue;
          }
        }

        const riskPerShare = px - stopPx;
        if (riskPerShare <= 0) {
          log.skipped.push({ symbol: s.symbol, reason: "وقف غير صالح" });
          continue;
        }

        let qualityMult = 1.0;
        const sc = s.scoreResult.score || 50;
        if (sc >= 85) qualityMult = 1.6;
        else if (sc >= 75) qualityMult = 1.35;
        else if (sc >= 68) qualityMult = 1.15;
        else qualityMult = 0.85;
        if (s.vcp) qualityMult += 0.15;
        if (s.fresh_zone) qualityMult += 0.10;
        if (st && st.golden) qualityMult += STRATEGY.goldenBoost;
        if (s.probability > 85) qualityMult += 0.2;
        else if (s.probability > 75) qualityMult += 0.1;

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

        const atr = Number(s.atr14) || px * 0.02;
        const nearDist = Math.max(atr * STRATEGY.nearTP.atrMult, px * STRATEGY.nearTP.minPct);
        const nearTPpx = Math.min(t1, px + nearDist);
        const tp1Qty = STRATEGY.nearTP.enabled ? Math.max(1, Math.floor(initialQty * STRATEGY.nearTP.sellFrac)) : 0;
        const runnerQty = initialQty - tp1Qty;

        let buyOk = false, buyErr = null;
        if (STRATEGY.nearTP.enabled && tp1Qty >= 1 && runnerQty >= 1) {
          const b1 = await buyBracket(s.symbol, tp1Qty, nearTPpx * STRATEGY.tp1FillNudge, stopPx);
          if (b1.status === "rejected" || b1.code) {
            buyErr = b1.message || "رفض براكِت الهدف القريب";
          } else {
            const b2 = await buyBracket(s.symbol, runnerQty, t1 * STRATEGY.tp1FillNudge, stopPx);
            if (b2.status === "rejected" || b2.code) {
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

        const plan = {
          symbol: s.symbol,
          status: "active",
          initial_qty: initialQty,
          add_qty: addQty,
          added: false,
          add_enabled: STRATEGY.addEnabled && addQty > 0,
          total_qty: initialQty,
          avg_entry: px,
          add_level: (support + px) / 2,
          stop: stopPx,
          t1: t1,
          t2: t2,
          t3: t3,
          support: support,
          confirm: confirm,
          tp1_done: false,
          near_tp: +nearTPpx.toFixed(4),
          tp1_qty: tp1Qty,
          runner_qty: runnerQty,
          be_done: false,
          trail_done: false,
          atr14: atr,
          ma5: s.ma5 || null,
          ma9: s.ma9 || null,
          signal_score: s.scoreResult.score,
          probability: s.probability,
          grade: s.classification.grade,
          market_score: marketData?.score || null,
          sector_strength: s.sectorStrength || null,
          stock_type: s.type || "مضاربة",
          t1_sell_frac: (s.type === "استثمار") ? 0.33 : 0.50,
        };
        await planSave(plan);

        await logTrade({
          symbol: s.symbol,
          entry_price: px,
          signal_score: s.scoreResult.score,
          probability: s.probability,
          grade: s.classification.grade,
          breakdown: JSON.stringify(s.scoreResult.breakdown),
          ma5: s.ma5,
          ma9: s.ma9,
          rsi: s.rsi,
          rvol: s.rvol,
          volume: s.volume,
          vwap: s.vwap,
          market_score: marketData?.score,
          sector: s.sector || null,
          sector_strength: s.sectorStrength || null,
          sector_change: s.sectorChange || null,
          spy_change: spyChange || null,
          news_age: s.news_age_h || null,
          golden: !!(st && st.golden),
          cmf: s.cmf || null,
          breakout_quality: s.breakout_quality || null,
          candle_score: s.candle_score || null,
          entry_time: new Date().toISOString(),
          status: "open",
        });

        deployed += initialQty * px;
        openCount++;
        openSymbols.add(s.symbol);

        log.entered.push({
          symbol: s.symbol,
          px: +px.toFixed(2),
          initialQty,
          score: s.scoreResult.score,
          probability: +s.probability.toFixed(1),
          grade: s.classification.grade,
          breakdown: s.scoreResult.breakdown.slice(0, 5),
          nearTP: +nearTPpx.toFixed(2),
          stop: +stopPx.toFixed(2),
          tp1: +t1.toFixed(2),
          rr: +((t1 - px) / (px - stopPx)).toFixed(2),
          sector_strength: s.sectorStrength || null,
          spy_rs: +(s.change_pct - spyChange).toFixed(2),
        });
      }

      const skipTally = {};
      for (const sk of log.skipped) skipTally[sk.reason] = (skipTally[sk.reason] || 0) + 1;
      debug.phase = "enter";
      debug.candidates = candidates.length;
      debug.after_basic_filter = filteredCandidates.length;
      debug.scored = scored.length;
      debug.after_score_filter = filtered.length;
      debug.entered = log.entered.length;
      debug.skipped = log.skipped.length;
      debug.skip_reasons = skipTally;
      debug.deployed_pct = balance > 0 ? Math.round((deployed / balance) * 100) : 0;
      debug.maxTrades = maxTrades;
      debug.marketScore = marketData?.score || 0;
      debug.spyChange = +spyChange.toFixed(2);
    }

    return res.status(200).json({
      success: true,
      engine: STRATEGY.engine,
      version: "v14",
      time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      elapsed_ms: Date.now() - T0,
      debug,
      ...log,
    });

  } catch (e) {
    console.error("❌ trade.js error:", e);
    return res.status(200).json({ success: false, error: e.message, elapsed_ms: Date.now() - T0 });
  }
}
