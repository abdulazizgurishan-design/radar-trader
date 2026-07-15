// pages/api/scan.js — v12 (v11 + 🥇 الزخم الذهبي + فلاتر مخففة)
// ═══════════════════════════════════════════════════════════════════
//  🏗️ مبني حرفياً على v11 المنشور (التحكم عن بعد + حالة الدخول + قوة نسبية
//     + تهدئة + score_trace + حارس بيانات) — كل ذلك كما هو بلا تغيير.
//
//  🆕 v12 — دمج استراتيجية الزخم الذهبي (كنوع إشارة إضافي، لا يغيّر شيئاً قائماً):
//   ✅ شروطها الست من بيانات متوفرة أصلاً (صفر طلبات API إضافية):
//      1. السعر فوق VWAP اليومي (من snapshot بوليجون day.vw)
//      2. RVOL ≥ 3
//      3. تغير اليوم بين 4% و 15% (زخم بلا تطرف)
//      4. السعر بين $2 و $20
//      5. RSI < 80 + ليس صاعداً 3 أيام متتالية قبل اليوم (يمنع الدخول المتأخر)
//      6. نافذة الزخم: 9:30 – 11:00 بتوقيت نيويورك + SPY أخضر
//   ✅ من يستوفيها: بادج is_golden + مكافأة +5 نقاط (موسومة في score_trace)
//   ✅ خلف مفتاح FF.golden_momentum — تطفئه من Supabase بلا نشر
//   ✅ عتبات الاستراتيجية في CFG.GOLDEN — تعدّلها من Supabase بلا نشر
//   ✅ بدون أي عمود SQL جديد (يُحفظ داخل structure jsonb)
//
//  📝 ما لم يُدمج عمداً (قرار CTO):
//   - Float<50M: يحتاج طلب لكل سهم = يكسر ميزانية 10 ثوانٍ
//   - VIX<25: يحتاج اشتراك مؤشرات — بديله فلتر SPY الموجود
//   - كسر قمة أول شمعة 5د: مشغّل تنفيذ لحظي — مكانه trade.js لا الماسح اليومي
//   - trailing/breakeven: منفّذة أصلاً في trade v11
// ═══════════════════════════════════════════════════════════════════

export const config = { maxDuration: 10 };

const POLYGON_KEY  = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.RADARAZ_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.RADARAZ_SUPABASE_KEY;

// ── الإعدادات المدمجة (نسخة الطوارئ — مطابقة لـ v11 المنشور) ──
const CFG_DEFAULT = {
  BUDGET:        9000,
  MIN_CHANGE:    1.5,
  MIN_PRICE:     0.50,
  MIN_VOLUME:    200000,
  MIN_DOLLARVOL: 1e6,
  HEAVY_LIMIT:   80,
  BATCH:         30,
  AGGS_TIMEOUT:  2500,
  SAVE_MIN_EP:   55,
  MIN_RR:        1.0,
  CAPS: { t1: 8, t2: 20, t3: 35, sl: 8 },
  EARLY_FLOOR:   3,
  REBOUND: { RSI: 45, PRICE: 3, DVOL: 10e6, RET: 8 },
  HOT: { EP: 65, RVOL: 5, CHG: 6 },
  MAX_CHANGE: 40,
  // عتبات ميزات v11
  CHASE_EXT_PCT:  15,
  CHASE_BAND:     0.95,
  COOLDOWN_DAYS:  3,
  COOLDOWN_PENALTY: 8,
  RS_BONUS: 4, RS_PENALTY: 3, RS_EDGE: 5,
  DATA_WARN_PENALTY: 5,
  CHASE_PENALTY: 6,
  // 🆕 v12: عتبات الزخم الذهبي (قابلة للتعديل عن بعد)
  GOLDEN: {
    CHG_MIN: 4, CHG_MAX: 15,
    RVOL: 3,
    PRICE_MIN: 2, PRICE_MAX: 20,
    RSI_MAX: 80,
    WINDOW_START: 570,   // 9:30 ET بالدقائق
    WINDOW_END:   660,   // 11:00 ET
    BONUS: 5,
  },
};

// ── مفاتيح الميزات ──
const FF_DEFAULT = {
  remote_config: true,
  entry_state:   true,
  rel_strength:  true,
  cooldown:      true,
  score_trace:   true,
  data_guard:    true,
  news:          true,
  golden_momentum: true,   // 🆕 v12
};

// ── Capped cache ──────────────────────────────────────────────────
const CACHE = { aggs: new Map() };
const CACHE_TTL = 5 * 60 * 1000;
function getCache(key) {
  const hit = CACHE.aggs.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit.data;
  return null;
}
function setCache(key, data) {
  if (CACHE.aggs.size > 300) CACHE.aggs.clear();
  CACHE.aggs.set(key, { data, time: Date.now() });
}

// ── Helpers ───────────────────────────────────────────────────────
const nyNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
const sigDate = () => nyNow().toISOString().split("T")[0];
const r2 = (n) => Math.round(n * 100) / 100;

async function fetchJson(url, timeoutMs, headers) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(id);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(id);
    return null;
  }
}

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

// ── إعدادات عن بعد ──
async function fetchRemoteConfig() {
  const data = await fetchJson(
    `${SUPABASE_URL}/rest/v1/radar_config?key=eq.scan&select=value`,
    900, SB_HEADERS
  );
  return (data && data[0] && data[0].value) || null;
}
function mergeConfig(base, remote) {
  if (!remote || typeof remote !== "object") return { cfg: { ...base.cfg }, ff: { ...base.ff }, source: "default" };
  const cfg = { ...base.cfg };
  const ff  = { ...base.ff };
  for (const k of Object.keys(remote)) {
    if (k === "FF" && typeof remote.FF === "object") {
      for (const f of Object.keys(remote.FF)) if (f in ff) ff[f] = !!remote.FF[f];
    } else if (["CAPS", "REBOUND", "HOT", "GOLDEN"].includes(k) && typeof remote[k] === "object") {
      cfg[k] = { ...cfg[k], ...remote[k] };
    } else if (k in cfg && typeof remote[k] === typeof cfg[k]) {
      cfg[k] = remote[k];
    }
  }
  return { cfg, ff, source: "remote" };
}

// ── قائمة التهدئة ──
async function fetchCooldownSet(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
  const data = await fetchJson(
    `${SUPABASE_URL}/rest/v1/signals?or=(stop_hit.eq.true,status.eq.STOPPED)&signal_date=gte.${since}&select=symbol&limit=300`,
    1200, SB_HEADERS
  );
  const set = new Set();
  if (Array.isArray(data)) for (const r of data) if (r.symbol) set.add(r.symbol);
  return set;
}

// ── Full market snapshot ────────────────────────────────────────────
async function fetchFullMarket(left) {
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${POLYGON_KEY}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      if (!res.ok) {
        if (attempt === 1 || left() < 4500) throw new Error(`Polygon ${res.status}`);
        await new Promise(r => setTimeout(r, 250));
        continue;
      }
      const data = await res.json();
      return data.tickers || [];
    } catch (err) {
      clearTimeout(id);
      if (attempt === 1 || left() < 4500) throw err;
      await new Promise(r => setTimeout(r, 250));
    }
  }
  throw new Error("Failed to fetch market");
}

// ── Daily candles per symbol ─────────────────────────────────────
async function fetchAggs(symbol, timeoutMs, days = 130) {
  const key = `${symbol}:${days}`;
  const cached = getCache(key);
  if (cached) return cached;
  const to = sigDate();
  const from = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=${days}&apiKey=${POLYGON_KEY}`;
  const data = await fetchJson(url, timeoutMs);
  const bars = data && data.results ? data.results : null;
  if (bars) setCache(key, bars);
  return bars;
}

// ── حارس البيانات ──
function cleanBars(bars) {
  if (!bars) return null;
  const out = bars.filter(b => b && b.c > 0 && b.h > 0 && b.l > 0 && b.h >= b.l && b.v >= 0);
  return out.length ? out : null;
}
function splitSuspect(bars) {
  if (!bars || bars.length < 10) return false;
  const scan = bars.slice(-63, -3);
  for (let i = 1; i < scan.length; i++) {
    const prev = scan[i - 1].c, cur = scan[i].c;
    if (prev > 0 && (cur / prev > 1.6 || cur / prev < 0.55)) return true;
  }
  return false;
}

// ── Indicators ────────────────────────────────────────────────────
function sma(arr, p) {
  if (!arr || arr.length < p) return null;
  let s = 0;
  for (let i = arr.length - p; i < arr.length; i++) s += arr[i];
  return s / p;
}
function rsi14(closes) {
  if (!closes || closes.length < 15) return null;
  let g = 0, l = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  const rs = (g / 14) / (l / 14);
  return Math.round(100 - 100 / (1 + rs));
}
function atr14(bars) {
  if (!bars || bars.length < 15) return null;
  let s = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    s += tr;
  }
  return s / 14;
}
function ret3m(bars) {
  if (!bars || bars.length < 40) return null;
  const oldC = bars[0].c, nowC = bars[bars.length - 1].c;
  if (!oldC || oldC <= 0) return null;
  const ret = ((nowC - oldC) / oldC) * 100;
  if (ret > 300 || ret < -95) return null;
  return Math.round(ret);
}
function ret20(bars) {
  if (!bars || bars.length < 21) return null;
  const oldC = bars[bars.length - 21].c, nowC = bars[bars.length - 1].c;
  if (!oldC || oldC <= 0) return null;
  return ((nowC - oldC) / oldC) * 100;
}
function vcpCheck(bars) {
  if (!bars || bars.length < 30) return { vcp: false, contraction: null };
  const seg = (a) => {
    let hi = -Infinity, lo = Infinity;
    for (const b of a) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
    return ((hi - lo) / lo) * 100;
  };
  const r1 = seg(bars.slice(-30, -20));
  const r2v = seg(bars.slice(-20, -10));
  const r3 = seg(bars.slice(-10));
  const ok = r3 < r2v && r2v < r1 && r3 < 12;
  return { vcp: ok, contraction: ok ? Math.round(r3) : null };
}
// 🆕 v12: هل السهم صاعد 3 أيام متتالية قبل اليوم؟ (شرط "لا تدخل متأخراً")
function upStreak3(bars) {
  if (!bars || bars.length < 5) return false;
  // آخر شمعة = اليوم الجاري غالباً — نفحص الثلاث قبلها
  const b = bars.slice(-4, -1);
  if (b.length < 3) return false;
  return b.every((bar, i) => i === 0
    ? bar.c > bars[bars.length - 5].c
    : bar.c > b[i - 1].c);
}

// ── AI-Az structure (كما في v11) ──────────────────────────────────
function buildStructure(price, bars, ind, CFG) {
  if (!bars || bars.length < 30 || !price) return null;
  const cap = (v, maxPct) => Math.min(v, price * (1 + maxPct / 100));
  const capDn = (v, maxPct) => Math.max(v, price * (1 - maxPct / 100));

  let hi20 = -Infinity, lo20 = Infinity;
  for (const b of bars.slice(-20)) { if (b.h > hi20) hi20 = b.h; if (b.l < lo20) lo20 = b.l; }
  const atr = ind.atr || (price * 0.03);
  const atrPct = r2((atr / price) * 100);

  const support    = capDn(lo20, 12);
  const stop       = capDn(Math.min(support * 0.995, price * (1 - CFG.CAPS.sl / 100)), CFG.CAPS.sl);
  const entry      = r2(Math.min(price, (support + price) / 2));
  const confirm    = r2(Math.min(price * 1.01, hi20 * 1.001));
  const resistance = r2(Math.max(hi20, price * 1.02));
  const t1 = r2(cap(price * (1 + Math.min(CFG.CAPS.t1, Math.max(3, atrPct * 1.2)) / 100), CFG.CAPS.t1));
  const t2 = r2(cap(price * (1 + Math.min(CFG.CAPS.t2, Math.max(8, atrPct * 2.5)) / 100), CFG.CAPS.t2));
  const t3 = r2(cap(price * (1 + Math.min(CFG.CAPS.t3, Math.max(14, atrPct * 4)) / 100), CFG.CAPS.t3));
  const liquidity = r2(cap(resistance * 1.06, CFG.CAPS.t3 + 10));
  const peak      = r2(cap(resistance * 1.12, CFG.CAPS.t3 + 15));

  const risk = price - stop;
  const reward = t2 - price;
  const rr = risk > 0 ? r2(reward / risk) : null;
  if (rr == null || rr < CFG.MIN_RR) return null;

  const aboveMA = ind.ma21 != null && price > ind.ma21;
  const trend = aboveMA && ind.ma21 > (ind.ma50 || 0) ? "صاعد مؤكد ✅"
              : aboveMA ? "ينتظر تأكيد ⏳"
              : "هابط بلا تأكيد ⛔";
  let flag;
  if (price > support && price <= confirm * 1.01 && rr >= CFG.MIN_RR) flag = "دخول صحيح ✅";
  else if (aboveMA && rr >= CFG.MIN_RR) flag = "مقبول";
  else flag = "ملاحقة/غير مؤكد ⚠️";

  const pctOf = (v) => r2(((v - price) / price) * 100);
  return {
    rr, t1, t2, t3, flag, trend, atrPct,
    peak, stop: r2(stop), entry, confirm,
    support: r2(support), resistance, liquidity,
    t1Pct: pctOf(t1), t2Pct: pctOf(t2), t3Pct: pctOf(t3),
    stopPct: pctOf(stop), entryPct: pctOf(entry), confirmPct: pctOf(confirm),
    supportPct: pctOf(support), resistancePct: pctOf(resistance),
    posInBand: r2((price - support) / Math.max(0.01, resistance - support)),
  };
}

function buildLevels(price, st) {
  if (!st) return { t1: 0, t1Pct: 0, t2: 0, t2Pct: 0, t3: 0, t3Pct: 0, sl: 0, slPct: 0, risk: 0 };
  return {
    t1: st.t1, t1Pct: st.t1Pct, t2: st.t2, t2Pct: st.t2Pct,
    t3: st.t3, t3Pct: st.t3Pct, sl: st.stop, slPct: st.stopPct,
    risk: Math.abs(st.stopPct),
  };
}

// ── حالة الدخول (كما في v11) ──
function entryState(price, ind, st, CFG) {
  if (!st) return { code: "none", label: "—", wait_price: null };
  const extPct = ind.ma21 ? ((price - ind.ma21) / ind.ma21) * 100 : 0;
  if (extPct >= CFG.CHASE_EXT_PCT || st.posInBand >= CFG.CHASE_BAND) {
    return { code: "chasing", label: "🔴 ملاحقة خطرة — لا تدخل الآن", wait_price: st.entry, ext_pct: r2(extPct) };
  }
  if (st.flag === "دخول صحيح ✅" && st.posInBand <= 0.75) {
    return { code: "in_zone", label: "🟢 داخل منطقة الدخول", wait_price: null, ext_pct: r2(extPct) };
  }
  return { code: "wait_pullback", label: `🟡 ممتد — انتظره عند ${st.entry}`, wait_price: st.entry, ext_pct: r2(extPct) };
}

// ── 🆕 v12: فحص الزخم الذهبي (كل مدخلاته متوفرة مسبقاً — صفر تكلفة) ──
function goldenCheck(a, ind, minsET, regime, G) {
  const checks = {
    above_vwap: a.vwap != null && a.price > a.vwap,
    rvol:       (ind.rvol ?? 0) >= G.RVOL,
    change:     a.change_pct >= G.CHG_MIN && a.change_pct <= G.CHG_MAX,
    price:      a.price >= G.PRICE_MIN && a.price <= G.PRICE_MAX,
    not_late:   (ind.rsi ?? 100) < G.RSI_MAX && !ind.up3,
    window:     minsET >= G.WINDOW_START && minsET <= G.WINDOW_END && regime === "قوي",
  };
  const passed = Object.values(checks).filter(Boolean).length;
  return { golden: passed === 6, passed, checks };
}

// ── Save signals ───────────────────────────────────────────────────
async function saveSignals(rows, left, debug, CFG) {
  if (!rows.length) return { saved: 0, status: 0 };
  const timeout = Math.max(600, Math.min(1500, left() - 400));
  if (timeout < 600) { debug.save_skipped = true; return { saved: 0, status: 0 }; }
  const payload = rows.map(s => ({
    symbol: s.symbol,
    signal_date: sigDate(),
    entry_price: s.price,
    target1: s.levels.t1, target2: s.levels.t2, target3: s.levels.t3,
    stop_loss: s.levels.sl,
    score: s.score, ep: s.score,
    volume: s.volume, change_pct: s.change_pct,
    type: s.type, status: "OPEN",
    rvol: s.rvol, rsi: s.rsi, atr14: s.atr14,
    ma_signal: s.ma_signal,
    news_age_h: s.news_age_h, news_age_hours: s.news_age_h,
    is_hot: s.is_hot,
    early_watch: s.early_watch, is_target: s.is_target,
    vcp: s.vcp, vcp_contraction: s.vcp_contraction,
    fresh_zone: s.fresh_zone || false,
    premarket_watch: s.premarket_watch || false,
    structure: s.structure,   // يحمل entry_state + score_trace + rs20 + golden (jsonb)
    is_smart_bounce: false,
    smart_bounce_confidence: 0,
  }));
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/signals?on_conflict=symbol,signal_date`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...SB_HEADERS,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(payload),
      }
    );
    clearTimeout(id);
    return { saved: res.ok ? payload.length : 0, status: res.status };
  } catch {
    clearTimeout(id);
    debug.save_timeout = true;
    return { saved: 0, status: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  const T0 = Date.now();
  let CFG = { ...CFG_DEFAULT, CAPS: { ...CFG_DEFAULT.CAPS }, REBOUND: { ...CFG_DEFAULT.REBOUND }, HOT: { ...CFG_DEFAULT.HOT }, GOLDEN: { ...CFG_DEFAULT.GOLDEN } };
  let FF  = { ...FF_DEFAULT };
  const left = () => CFG.BUDGET - (Date.now() - T0);
  const light = req.query.light === "1";
  const debug = {
    market_scanned: 0, market_regime: null, config_source: "default",
    cooldown_symbols: 0, spy_rs_ready: false,
    after_filter: 0, top_selected: 0,
    tech_analyzed: 0, news_fetched: 0,
    dropped_total: 0, dropped_late: 0, dropped_strict_gems: 0, dropped_stretch: 0,
    dropped_penny_gate: 0, dropped_trend_gate: 0, dropped_no_tech: 0, dropped_timeout: 0,
    dropped_extreme_gain: 0,
    data_warned: 0, chase_flagged: 0, cooldown_hits: 0,
    golden_count: 0,   // 🆕 v12
    survivors: 0, below_save_ep: 0, saved: 0,
  };

  try {
    // ── Stage 1: الجلبات المستقلة بالتوازي ──
    const [tickers, remoteCfg, cooldownSet] = await Promise.all([
      fetchFullMarket(left),
      FF.remote_config ? fetchRemoteConfig() : Promise.resolve(null),
      FF_DEFAULT.cooldown ? fetchCooldownSet(CFG_DEFAULT.COOLDOWN_DAYS) : Promise.resolve(new Set()),
    ]);
    debug.market_scanned = tickers.length;

    const merged = mergeConfig({ cfg: CFG, ff: FF }, remoteCfg);
    CFG = merged.cfg; FF = merged.ff;
    debug.config_source = merged.source;
    debug.cooldown_symbols = cooldownSet.size;

    // ── SPY pulse ──
    const spy = tickers.find(t => t.ticker === "SPY");
    if (spy && spy.day) {
      const spyChg = spy.todaysChangePerc ?? 0;
      debug.market_regime = spyChg >= 0 ? "قوي" : "ضعيف";
    }

    // 🆕 v12: دقائق الجلسة الحالية (لنافذة الزخم الذهبي)
    const ny = nyNow();
    const minsET = ny.getHours() * 60 + ny.getMinutes();

    // ── Stage 2: primary funnel ──
    const movers = { gainers: [], losers: [], volume: [], value: [] };
    const cand = [];
    for (const t of tickers) {
      const d = t.day || {};
      const price = d.c || t.lastTrade?.p || 0;
      const vol = d.v || 0;
      const chg = t.todaysChangePerc ?? 0;
      if (!price || !vol) continue;
      // 🆕 v12: التقاط VWAP اليومي من السنابشوت (d.vw) — مجاني
      const row = { symbol: t.ticker, price: r2(price), change_pct: r2(chg), volume: vol, dollar_vol: price * vol, vwap: d.vw || null };
      movers.gainers.push(row); movers.losers.push(row);
      movers.volume.push(row);  movers.value.push(row);

      if (price < CFG.MIN_PRICE) { debug.dropped_penny_gate++; continue; }
      if (Math.abs(chg) < CFG.MIN_CHANGE) continue;
      if (vol < CFG.MIN_VOLUME || price * vol < CFG.MIN_DOLLARVOL) continue;
      if (chg > CFG.MAX_CHANGE) { debug.dropped_extreme_gain++; continue; }
      if (/[.\-]|W$/.test(t.ticker) || t.ticker.length > 5) continue;
      cand.push(row);
    }
    movers.gainers = movers.gainers.sort((a, b) => b.change_pct - a.change_pct).slice(0, 15);
    movers.losers  = movers.losers.sort((a, b) => a.change_pct - b.change_pct).slice(0, 15);
    movers.volume  = movers.volume.sort((a, b) => b.volume - a.volume).slice(0, 15);
    movers.value   = movers.value.sort((a, b) => b.dollar_vol - a.dollar_vol).slice(0, 15);

    debug.after_filter = cand.length;
    const heavy = cand
      .sort((a, b) => (b.change_pct * Math.log10(b.dollar_vol)) - (a.change_pct * Math.log10(a.dollar_vol)))
      .slice(0, CFG.HEAVY_LIMIT);
    debug.top_selected = heavy.length;

    // ── شموع SPY للقوة النسبية ──
    let spyRet20 = null;
    if (FF.rel_strength && left() > 3000) {
      const spyBars = cleanBars(await fetchAggs("SPY", CFG.AGGS_TIMEOUT));
      spyRet20 = ret20(spyBars);
      debug.spy_rs_ready = spyRet20 != null;
    }

    // ── Stage 3: heavy analysis ──
    const analyzed = [];
    for (let i = 0; i < heavy.length; i += CFG.BATCH) {
      if (left() < 1800) { debug.dropped_timeout += heavy.length - i; break; }
      const batch = heavy.slice(i, i + CFG.BATCH);
      const results = await Promise.all(batch.map(async (c) => {
        let bars = await fetchAggs(c.symbol, CFG.AGGS_TIMEOUT);
        if (FF.data_guard) bars = cleanBars(bars);
        if (!bars || bars.length < 30) { debug.dropped_no_tech++; return null; }
        const closes = bars.map(b => b.c);
        const vols = bars.map(b => b.v);
        const ind = {
          ma21: sma(closes, 21), ma50: sma(closes, 50),
          rsi: rsi14(closes), atr: atr14(bars),
          rvol: (() => { const a = sma(vols.slice(0, -1), 20); return a ? r2(c.volume / a) : null; })(),
          ret3m: ret3m(bars),
          ret20: ret20(bars),
          vcp: vcpCheck(bars),
          data_warn: FF.data_guard ? splitSuspect(bars) : false,
          up3: upStreak3(bars),   // 🆕 v12
        };
        return { ...c, bars, ind };
      }));
      for (const r of results) if (r) analyzed.push(r);
    }
    debug.tech_analyzed = analyzed.length;

    // ── Stage 4: gates + structure + score ──
    const signals = [];
    for (const a of analyzed) {
      const { ind } = a;
      if (ind.ma21 == null || a.price < ind.ma21 * 0.95) { debug.dropped_trend_gate++; continue; }
      if ((ind.rsi ?? 50) > 85 || (ind.rvol ?? 1) < 0.6) { debug.dropped_strict_gems++; continue; }
      if (a.change_pct > 30 && (ind.rvol ?? 0) < 2) { debug.dropped_stretch++; continue; }

      const st = buildStructure(a.price, a.bars, ind, CFG);
      const levels = buildLevels(a.price, st);
      const eState = FF.entry_state ? entryState(a.price, ind, st, CFG) : null;

      // السكور مع تتبع المكونات — أوزان v11 كما هي
      const trace = {};
      let ep = 30; trace.base = 30;
      const add = (k, v) => { if (v) { ep += v; trace[k] = v; } };

      if (ind.rvol >= 3) add("rvol3", 12); else if (ind.rvol >= 1.5) add("rvol15", 6);
      if (ind.rsi >= 45 && ind.rsi <= 70) add("rsi_zone", 10);
      if (a.price > (ind.ma21 || 0) && (ind.ma21 || 0) > (ind.ma50 || 0)) add("trend", 10);
      if (ind.vcp.vcp) add("vcp", 8);
      if (st && st.flag === "دخول صحيح ✅") add("entry_flag", 6);
      if (debug.market_regime === "قوي") add("regime", 2);

      let rs20 = null;
      if (FF.rel_strength && spyRet20 != null && ind.ret20 != null) {
        rs20 = r2(ind.ret20 - spyRet20);
        if (rs20 >= CFG.RS_EDGE) add("rel_strength", CFG.RS_BONUS);
        else if (rs20 < 0) add("rel_weak", -CFG.RS_PENALTY);
      }
      const inCooldown = FF.cooldown && cooldownSet.has(a.symbol);
      if (inCooldown) { add("cooldown", -CFG.COOLDOWN_PENALTY); debug.cooldown_hits++; }
      if (eState && eState.code === "chasing") { add("chasing", -CFG.CHASE_PENALTY); debug.chase_flagged++; }
      if (ind.data_warn) { add("data_warn", -CFG.DATA_WARN_PENALTY); debug.data_warned++; }

      // 🆕 v12: الزخم الذهبي — فحص الشروط الست + مكافأة
      let golden = null;
      if (FF.golden_momentum) {
        golden = goldenCheck(a, ind, minsET, debug.market_regime, CFG.GOLDEN);
        if (golden.golden) { add("golden", CFG.GOLDEN.BONUS); debug.golden_count++; }
      }

      ep = Math.max(0, Math.min(99, ep));

      const isHot = ep >= CFG.HOT.EP && (ind.rvol ?? 0) >= CFG.HOT.RVOL && a.change_pct >= CFG.HOT.CHG;
      const early = a.price >= CFG.EARLY_FLOOR && a.change_pct >= 2 && a.change_pct <= 15
                    && ind.vcp.vcp && st != null;
      const isTarget = st != null && st.flag === "دخول صحيح ✅" && ep >= 65;

      const isRebound = (ind.rsi ?? 99) < CFG.REBOUND.RSI
                     && a.price >= CFG.REBOUND.PRICE
                     && a.dollar_vol >= CFG.REBOUND.DVOL
                     && (ind.ret3m ?? 0) >= CFG.REBOUND.RET;
      const isSniper = isHot && st != null && st.rr >= 1.8;

      const isExtreme = a.change_pct > 25;
      const signalLabel = isExtreme
        ? (ep >= 80 ? "💥 انفجاري" : "🔥 عالي جداً ⚠️")
        : (ep >= 80 ? "💥 انفجاري" : ep >= 65 ? "🔥 عالي" : "📊 متوسط");

      const stOut = st ? {
        ...st,
        ...(eState ? { entry_state: eState } : {}),
        ...(FF.score_trace ? { score_trace: trace } : {}),
        ...(rs20 != null ? { rs20 } : {}),
        ...(inCooldown ? { cooldown: true } : {}),
        ...(ind.data_warn ? { data_warn: true } : {}),
        ...(golden && golden.golden ? { golden: golden.checks } : {}),   // 🆕 v12
      } : st;

      signals.push({
        symbol: a.symbol, price: a.price, change_pct: a.change_pct,
        volume: a.volume, dollar_vol: a.dollar_vol,
        score: ep, rvol: ind.rvol, rsi: ind.rsi,
        atr14: ind.atr != null ? r2(ind.atr) : null,
        ret3m: ind.ret3m,
        ma_signal: ind.ma21 && ind.ma50 ? (ind.ma21 > ind.ma50 ? "فوق MA21/50" : "بين المتوسطات") : null,
        vcp: ind.vcp.vcp, vcp_contraction: ind.vcp.contraction,
        is_hot: isHot, early_watch: early, is_target: isTarget,
        is_rebound: isRebound, is_sniper: isSniper,
        sniper_type: isSniper ? "momentum" : null,
        type: isRebound ? "ارتداد" : (a.dollar_vol >= 50e6 && ep >= 60 ? "استثمار" : "مضاربة"),
        signal: signalLabel,
        news_age_h: null,
        levels, structure: stOut,
        is_extreme_gain: isExtreme,
        entry_state: eState ? eState.code : null,
        entry_label: eState ? eState.label : null,
        wait_price: eState ? eState.wait_price : null,
        rs20, in_cooldown: inCooldown || false,
        // 🆕 v12: حقول الزخم الذهبي للواجهة
        is_golden: !!(golden && golden.golden),
        golden_passed: golden ? golden.passed : null,
        vwap: a.vwap,
      });
    }
    debug.survivors = signals.length;

    // ── Stage 5: news ──
    if (FF.news && left() >= 1500 && signals.length) {
      const newsTargets = signals.filter(s => s.is_hot || s.is_target || s.is_golden).slice(0, 6);   // 🆕 v12: الذهبي يستحق فحص الخبر
      await Promise.all(newsTargets.map(async (s) => {
        const data = await fetchJson(
          `https://api.polygon.io/v2/reference/news?ticker=${s.symbol}&limit=1&apiKey=${POLYGON_KEY}`,
          1200
        );
        const art = data && data.results && data.results[0];
        if (art && art.published_utc) {
          s.news_age_h = Math.round((Date.now() - new Date(art.published_utc)) / 3600000);
          debug.news_fetched++;
        }
      }));
    } else if (signals.length) {
      debug.news_skipped = true;
    }

    // ── Stage 6: save ──
    const toSave = signals.filter(s => s.score >= CFG.SAVE_MIN_EP && s.structure);
    debug.below_save_ep = signals.length - toSave.length;
    const saveResult = await saveSignals(toSave, left, debug, CFG);
    debug.saved = saveResult.saved;

    debug.dropped_total = debug.dropped_late + debug.dropped_strict_gems + debug.dropped_stretch
      + debug.dropped_penny_gate + debug.dropped_trend_gate + debug.dropped_no_tech
      + debug.dropped_timeout + debug.dropped_extreme_gain;

    // ── Response ──
    const base = {
      success: true,
      total: signals.length,
      market_regime: debug.market_regime,
      hot: signals.filter(s => s.is_hot).length,
      target: signals.filter(s => s.is_target).length,
      early: signals.filter(s => s.early_watch).length,
      rebound: signals.filter(s => s.is_rebound).length,
      in_zone: signals.filter(s => s.entry_state === "in_zone").length,
      chasing: signals.filter(s => s.entry_state === "chasing").length,
      golden: signals.filter(s => s.is_golden).length,   // 🆕 v12
      saved: saveResult.saved,
      saveResult,
      elapsed_ms: Date.now() - T0,
      debug,
    };
    if (light) return res.status(200).json({ ...base, light: true });
    return res.status(200).json({ ...base, results: signals, movers });

  } catch (err) {
    return res.status(200).json({
      success: false, error: err.message, partial: true,
      elapsed_ms: Date.now() - T0, debug,
    });
  }
}
