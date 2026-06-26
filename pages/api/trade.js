// pages/api/trade.js — v9 (محرك إدارة ذكي: دخول متدرّج + خروج متدرّج + تعادل)
// ════════════════════════════════════════════════════════════════════════
//  B) خروج متدرّج: بيع 2/3 عند T1 → نقل الوقف للتعادل، والباقي 1/3 إلى T3
//  C) دخول متدرّج: ندخل 60% أولاً، ونضيف 40% فقط لو نزل لمستوى الدخول (فوق الوقف)
//  • الوقف/الأهداف من بنية السوق • الحجم حسب المخاطرة (~1.5%/صفقة)
//  • حالة كل مركز محفوظة في Supabase (جدول bot_positions)
//  • أوامر OCO (هدف+وقف مرتبطين) — تنفيذ لحظي بلا تعارض حجز الأسهم
//  ⚠️ بيتا — اختبر على الورقي وراقب أول صفقات. للإيقاف: STRATEGY.engine="simple"
// ════════════════════════════════════════════════════════════════════════

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const ALPACA_BASE   = "https://paper-api.alpaca.markets";
const ALPACA_DATA   = "https://data.alpaca.markets";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.RADARAZ_SUPABASE_KEY;

const STRATEGY = {
  engine: "smart",          // "smart" = الإدارة الكاملة | "simple" = دخول فقط بلا إدارة
  addEnabled: true,         // C) الدخول المتدرّج (يخفّض المتوسط فيُلمس TP1 أسهل)

  minScore: 65, minPrice: 3, minChangePct: 1, maxChangePct: 40,   // رُفع 60→65: البوت يتداول الأنظف فقط
  minVolume: 100_000, maxRSI: 78, skipChasers: true,
  minRR: 1.3,
  entryBuffer: 1.01,        // مكافحة الملاحقة: لا ندخل فوق التأكيد بأكثر من 1%
  minRoomPct: 0.015,        // لا بد من مسافة ربح ≥1.5% حتى TP1 (وإلا لا فائدة)

  maxLossPct:      0.07,    // 🆕 سقف خسارة صارم 7% — أي وقف بنيوي أبعد يُقصّ لهذا الحد (يحمي من الوقف البعيد مثل ANY ‑56%)
  riskPerTradePct: 0.015,   // مخاطرة 1.5% من الحساب/صفقة (سعر→وقف)
  maxPositionPct:  0.22,    // سقف المركز الواحد
  minPositionPct:  0.04,    // أرضية المركز
  maxDeployedPct:  0.85,    // أقصى انتشار (يبقي ~15% كاش)

  initialFraction: 0.60,    // ندخل 60% أولاً، نحجز 40% للإضافة عند التراجع
  tp1Fraction:     1.0,     // 🆕 خروج كامل عند TP1 (المقاومة) — أعلى احتمال نجاح
  tp1FillNudge:    0.998,   // 🆕 نضع TP1 داخل المقاومة 0.2% ليملأ قبل الزحام
  breakevenAfterTp1: true,  // (غير مؤثّر مع الخروج الكامل — يبقى للتوافق)

  // 🆕 المتداول الذكي البنيوي — Trailing Stop بمراحل (يحمي الربح المتراكم)
  trailEnabled: true,
  trailTiers: [             // عند بلوغ ربح gain%، ارفع الوقف ليحمي lock% من الدخول
    { gain: 0.03, lock: 0.00 },   // +3% ربح → الوقف للتعادل (خسارة صفر)
    { gain: 0.06, lock: 0.03 },   // +6% → احمِ +3%
    { gain: 0.10, lock: 0.06 },   // +10% → احمِ +6%
    { gain: 0.15, lock: 0.10 },   // +15% → احمِ +10%
    { gain: 0.22, lock: 0.15 },   // +22% → احمِ +15%
  ],
  maxTrades: 6,
};

const H    = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET, "Content-Type": "application/json" };
const SB_H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

// ───────── Alpaca ─────────
async function getAccount()        { const r = await fetch(`${ALPACA_BASE}/v2/account`, { headers: H }); return r.json(); }
async function getAllPositions()   { try { const r = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: H }); const d = await r.json(); return Array.isArray(d) ? d : []; } catch { return []; } }
async function getPositionQty(sym) { try { const r = await fetch(`${ALPACA_BASE}/v2/positions/${sym}`, { headers: H }); if (!r.ok) return 0; const d = await r.json(); return Math.abs(parseInt(d.qty)) || 0; } catch { return 0; } }
async function getLatestPrice(sym) { try { const r = await fetch(`${ALPACA_DATA}/v2/stocks/${sym}/trades/latest`, { headers: H }); if (!r.ok) return null; const d = await r.json(); return d?.trade?.p ?? null; } catch { return null; } }
async function getOpenOrders(sym)  { try { const r = await fetch(`${ALPACA_BASE}/v2/orders?status=open&symbols=${sym}&nested=true`, { headers: H }); const d = await r.json(); return Array.isArray(d) ? d : []; } catch { return []; } }
async function cancelOrder(id)     { try { await fetch(`${ALPACA_BASE}/v2/orders/${id}`, { method: "DELETE", headers: H }); } catch {} }
async function cancelAll(sym)      { const oo = await getOpenOrders(sym); for (const o of oo) await cancelOrder(o.id); }
async function buyMarket(sym, qty) { const r = await fetch(`${ALPACA_BASE}/v2/orders`, { method: "POST", headers: H, body: JSON.stringify({ symbol: sym, qty: String(qty), side: "buy", type: "market", time_in_force: "day" }) }); return r.json(); }

// 🆕 شراء براكِت ذرّي: دخول + هدف + وقف في أمر واحد.
//    مستحيل يبقى مركز بلا حماية — Alpaca تضمن تفعيل الوقف/الهدف فور تنفيذ الشراء.
//    يحلّ كارثة "مركز مفتوح بلا وقف" (سبب خسائر -19%).
async function buyBracket(sym, qty, tp, sl) {
  const dec = (Number(tp) < 1 || Number(sl) < 1) ? 4 : 2;
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      symbol: sym, qty: String(qty), side: "buy", type: "market", time_in_force: "day",
      order_class: "bracket",
      take_profit: { limit_price: Number(tp).toFixed(dec) },
      stop_loss:   { stop_price:  Number(sl).toFixed(dec) },
    }),
  });
  return r.json();
}

// بيع وقف بسيط (شبكة أمان أخيرة لو فشل OCO/البراكِت) — الحماية أهم من الهدف
async function stopSell(sym, qty, sl) {
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
      method: "POST", headers: H,
      body: JSON.stringify({ symbol: sym, qty: String(qty), side: "sell", type: "stop",
        stop_price: Number(sl).toFixed(Number(sl) < 1 ? 4 : 2), time_in_force: "day" }),
    });
    return r.json();
  } catch { return null; }
}

// OCO بيع: هدف (limit) + وقف (stop) مرتبطان — أيّهما تحقّق يلغي الآخر
async function ocoSell(sym, qty, tp, sl) {
  const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      symbol: sym, qty: String(qty), side: "sell", type: "limit", time_in_force: "day",
      order_class: "oco",
      take_profit: { limit_price: tp.toFixed(2) },
      stop_loss:   { stop_price: sl.toFixed(2) },
    }),
  });
  return r.json();
}

// يضع حماية كامل الكمية: خروج كامل عند TP1 (المقاومة) بوقف البنية الذكي
// 🆕 مُحصّن: يتحقّق من نجاح OCO، وإن فشل يضع وقفاً بسيطاً (لا يترك المركز عارياً أبداً)
async function placeExits(sym, qty, p) {
  const raw = Number(p.t1) * STRATEGY.tp1FillNudge;   // داخل المقاومة بقليل ليملأ
  const t1px = +raw.toFixed(Number(p.t1) < 1 ? 4 : 2);
  const resp = await ocoSell(sym, qty, t1px, Number(p.stop));
  if (resp && (resp.code || resp.status === "rejected")) {
    // فشل OCO → شبكة أمان: وقف بسيط يضمن الحماية (نضحّي بالهدف مقابل عدم ترك المركز بلا وقف)
    await stopSell(sym, qty, Number(p.stop));
    return { ok: false, fallback: true };
  }
  return { ok: true };
}

// ───────── Supabase (جدول الخطط) ─────────
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

// منطقة دخول مناسبة (مثل لمبة الرادار) — تعتمد المستويات الواقعية من الماسح
function suitableEntry(st, price, t1, stopPx, minRR, buffer, minRoom) {
  if (!st || !price || !t1 || !stopPx) return false;
  const risk = price - stopPx;
  if (risk <= 0) return false;
  const rr = (t1 - price) / risk;
  return price > st.support &&            // فوق الارتكاز
         price <= st.confirm * buffer &&  // غير ملاحق (قرب/تحت التأكيد)
         t1 >= price * (1 + minRoom) &&    // مسافة ربح كافية حتى TP1
         rr >= minRR;                      // عائد/مخاطرة مجزٍ
}

export default async function handler(req, res) {
  try {
    const log = { managed: [], entered: [], skipped: [] };
    const debug = { phase: "manage_only" };
    const now = new Date();
    const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const mins = et.getHours() * 60 + et.getMinutes(), day = et.getDay();
    const weekend = day === 0 || day === 6;
    const canManage = !weekend && mins >= 575 && mins <= 958;   // 9:35–3:58 ET
    const canEnter  = !weekend && mins >= 590 && mins <  900;   // 9:50–3:00 ET

    if (!canManage)
      return res.status(200).json({ success: true, message: "خارج ساعات الإدارة", ...log });

    // ═══ المرحلة 1: إدارة المراكز المفتوحة ═══
    if (STRATEGY.engine === "smart") {
      const plans = await planList();
      for (const p of plans) {
        const sym = p.symbol;
        const held = await getPositionQty(sym);
        const live = await getLatestPrice(sym);

        // أُغلق المركز بالكامل (وقف أو كل الأهداف)
        if (held === 0) {
          await cancelAll(sym);
          await planClose(sym);
          log.managed.push({ symbol: sym, action: "أُغلق المركز" });
          continue;
        }

        // C) إضافة متدرّجة: نزل لمستوى الدخول، فوق الوقف، ولم نُضف بعد
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

        // B) كشف تنفيذ T1 (بِيع ~2/3 والسعر فوق التعادل) → نقل الوقف للتعادل
        const tp1q = Math.floor(Number(p.total_qty) * STRATEGY.tp1Fraction);
        const remain = Number(p.total_qty) - tp1q;
        if (!p.tp1_done && held <= remain && held < Number(p.total_qty) && live && live > Number(p.avg_entry)) {
          p.tp1_done = true; p.be_moved = STRATEGY.breakevenAfterTp1;
          await cancelAll(sym);
          await placeExits(sym, held, p);   // الباقي: T3 + وقف تعادل
          await planSave(p);
          log.managed.push({ symbol: sym, action: "جني T1 + وقف تعادل", remaining: held, stop: STRATEGY.breakevenAfterTp1 ? +Number(p.avg_entry).toFixed(2) : Number(p.stop) });
          continue;
        }

        // 🆕 Trailing Stop بمراحل — يرفع الوقف مع صعود السهم (يحمي الربح المتراكم)
        if (STRATEGY.trailEnabled && live && Number(p.avg_entry) > 0) {
          const gain = (live - Number(p.avg_entry)) / Number(p.avg_entry);
          // أعلى مرحلة بلغها الربح
          let newLock = null;
          for (const tier of STRATEGY.trailTiers) {
            if (gain >= tier.gain) newLock = tier.lock;
          }
          if (newLock != null) {
            const newStop = +(Number(p.avg_entry) * (1 + newLock)).toFixed(Number(p.avg_entry) < 1 ? 4 : 2);
            const curStop = Number(p.stop) || 0;
            // نرفع الوقف فقط (لا ننزله أبداً)، وبفارق ملموس يتجاوز ضجيج صغير
            if (newStop > curStop && newStop < live) {
              await cancelAll(sym);
              const t3px = +(Number(p.t3) || live * 1.5).toFixed(Number(live) < 1 ? 4 : 2);
              // هدف بعيد (T3) + وقف مرفوع — أيّهما تحقّق يلغي الآخر
              let ok = await ocoSell(sym, held, t3px, newStop);
              if (!ok || ok.code) { await stopSell(sym, held, newStop); }  // fallback: وقف على الأقل
              p.stop = newStop; p.trail_lock = newLock;
              await planSave(p);
              log.managed.push({ symbol: sym, action: "🔼 رفع الوقف (trailing)", gainPct: +(gain*100).toFixed(1), newStop, protects: `+${(newLock*100).toFixed(0)}%` });
              continue;
            }
          }
        }

        // إصلاح ذاتي: مركز مفتوح بلا أوامر حماية → أعد وضعها
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
      // نقرأ إشارات اليوم المحفوظة (سريع) بدل مسح حيّ ثقيل يستهلك مهلة الدالة (Hobby 10ث).
      //   البوت يتحقق من السعر الحيّ لكل سهم قبل الدخول، فلا حاجة للمسح اللحظي هنا.
      const todayET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
        .toISOString().split("T")[0];
      let candidates = [];
      try {
        const sr = await fetch(`${SUPABASE_URL}/rest/v1/signals?select=*&signal_date=eq.${todayET}&order=score.desc&limit=100`, { headers: SB_H });
        if (sr.ok) {
          const rows = await sr.json();
          candidates = (Array.isArray(rows) ? rows : []).map(r => ({ ...r, price: r.entry_price }));
        }
      } catch { /* تجاهل — نكتفي بالإدارة */ }

      const filtered = candidates.filter(s => {
        if (s.score < STRATEGY.minScore) return false;
        if (s.price < STRATEGY.minPrice) return false;
        if (s.change_pct < STRATEGY.minChangePct || s.change_pct > STRATEGY.maxChangePct) return false;
        if (s.volume < STRATEGY.minVolume) return false;
        if (s.rsi != null && s.rsi > STRATEGY.maxRSI) return false;
        if (s.vwap && s.price <= s.vwap) return false;
        if (!s.structure || s.structure.stop == null || s.structure.t1 == null) return false; // المحرك الذكي يتطلب بنية
        const f = s.structure.flag || "";
        if (STRATEGY.skipChasers && (f.indexOf("ملاحقة") >= 0 || f.indexOf("غير مؤكد") >= 0 || f.indexOf("هابط") >= 0)) return false;
        return true;
      });

      const validEntry = x => x.structure && (x.structure.flag || "").indexOf("صحيح") >= 0;
      filtered.sort((a, b) => {
        if (!!b.is_target   !== !!a.is_target)   return b.is_target   ? 1 : -1;
        if (validEntry(b)   !== validEntry(a))   return validEntry(b) ? 1 : -1;
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

        // 🆕 المستويات الواقعية/الذكية من الماسح (نفس ما يعرضه الرادار):
        //    TP1 = هدف واقعي (مقاومة قريبة أو ATR)، الوقف = الوقف الذكي المحسوب.
        const t1     = Number(s.target1   != null ? s.target1   : st.t1);
        let   stopPx = Number(s.stop_loss != null ? s.stop_loss : st.stop);
        const t3     = Number(s.target3   != null ? s.target3   : st.t3);

        // 🆕 سقف خسارة صارم 7%: لو الوقف البنيوي أبعد من 7% تحت السعر الحيّ، نرفعه لحد 7%.
        //    يحمي من الكوارث (ANY: وقف بنيوي ‑56%). الوقف الأقرب = خسارة أصغر.
        const capFloor = px * (1 - STRATEGY.maxLossPct);
        if (stopPx < capFloor) stopPx = capFloor;

        if (!suitableEntry(st, px, t1, stopPx, STRATEGY.minRR, STRATEGY.entryBuffer, STRATEGY.minRoomPct)) {
          log.skipped.push({ symbol: s.symbol, reason: "خارج منطقة الدخول / R:R ضعيف", px: +px.toFixed(2), confirm: st.confirm }); continue;
        }
        const riskPerShare = px - stopPx;
        if (riskPerShare <= 0) { log.skipped.push({ symbol: s.symbol, reason: "وقف غير صالح" }); continue; }

        let fullValue = (balance * STRATEGY.riskPerTradePct) * px / riskPerShare;
        fullValue = Math.min(fullValue, balance * STRATEGY.maxPositionPct);
        if (fullValue < balance * STRATEGY.minPositionPct) { log.skipped.push({ symbol: s.symbol, reason: "تحت أرضية المركز" }); continue; }
        if (deployed + fullValue > maxDeployed) { log.skipped.push({ symbol: s.symbol, reason: "بلغ سقف الانتشار" }); break; }

        const fullQty = Math.floor(fullValue / px);
        if (fullQty < 2) { log.skipped.push({ symbol: s.symbol, reason: "كمية صغيرة" }); continue; }
        const initialQty = Math.max(1, Math.floor(fullQty * STRATEGY.initialFraction));
        const addQty = fullQty - initialQty;

        // 🆕 شراء براكِت ذرّي: الدخول + الهدف + الوقف معاً. الوقف مضمون من لحظة التنفيذ.
        const t1px = +(Number(t1) * STRATEGY.tp1FillNudge).toFixed(Number(t1) < 1 ? 4 : 2);
        const buy = await buyBracket(s.symbol, initialQty, t1px, stopPx);
        if (buy.status === "rejected" || buy.code) {
          // فشل البراكِت (سعر/حد) → لا ندخل أبداً بلا حماية. نتخطّى بدل المخاطرة بمركز عارٍ.
          log.skipped.push({ symbol: s.symbol, reason: "رُفض البراكِت (لا دخول بلا وقف)", err: buy.message || null }); continue;
        }

        const plan = {
          symbol: s.symbol, status: "active",
          initial_qty: initialQty, add_qty: addQty, added: false, add_enabled: STRATEGY.addEnabled && addQty > 0,
          total_qty: initialQty, avg_entry: px, add_level: st.entry, stop: stopPx, t1: t1, t3: t3,
          support: st.support, confirm: st.confirm, tp1_done: false, be_moved: false,
        };
        // البراكِت وضع الحماية ذرّياً — لا حاجة لـ placeExits منفصل هنا (يمنع أمراً مكرراً)
        await planSave(plan);

        deployed += initialQty * px; openCount++; openSymbols.add(s.symbol);
        log.entered.push({ symbol: s.symbol, px: +px.toFixed(2), initialQty, reserveAdd: addQty, stop: +stopPx.toFixed(2), tp1: +t1.toFixed(2), exit: "bracket@TP1", rr: +((t1 - px) / (px - stopPx)).toFixed(2) });
      }

      // 📊 Telemetry — ليش دخل/ما دخل (قمع البوت): مرشحون → بعد الفلتر → الأسباب
      const skipTally = {};
      for (const sk of log.skipped) skipTally[sk.reason] = (skipTally[sk.reason] || 0) + 1;
      debug.phase = "enter";
      debug.candidates = candidates.length;
      debug.after_filter = filtered.length;
      debug.open_before = openSymbols.size - log.entered.length;
      debug.max_trades = STRATEGY.maxTrades;
      debug.entered = log.entered.length;
      debug.skipped = log.skipped.length;
      debug.skip_reasons = skipTally;
      debug.deployed_pct = balance > 0 ? Math.round((deployed / balance) * 100) : 0;
    }

    return res.status(200).json({
      success: true, engine: STRATEGY.engine,
      time_et: `${et.getHours()}:${String(et.getMinutes()).padStart(2, "0")}`,
      debug,
      ...log,
    });
  } catch (e) {
    return res.status(200).json({ success: false, error: e.message });
  }
}
