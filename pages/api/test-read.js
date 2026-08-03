// pages/api/test-read.js — تشخيص مستقل: هل مشروع البوت يقرأ إشارات الرادار؟
// افتح: https://traderx99.vercel.app/api/test-read
// بعد التشخيص، احذفه.
export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  const out = {
    env: {
      SUPABASE_URL_set: !!SUPABASE_URL,
      SUPABASE_URL_preview: SUPABASE_URL ? SUPABASE_URL.slice(0, 40) : null,
      key_set: !!SUPABASE_KEY,
      key_length: SUPABASE_KEY ? SUPABASE_KEY.length : 0,
      key_type_guess: SUPABASE_KEY ? (SUPABASE_KEY.length > 100 ? "service_role (long)" : "anon (short)") : "none",
      has_ALPACA: !!process.env.ALPACA_KEY,
      BOT_KILL: process.env.BOT_KILL || "(not set)",
    },
  };

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    out.conclusion = "🔴 متغيّرات Supabase ناقصة في بيئة مشروع البوت";
    return res.status(200).json(out);
  }

  const SB_H = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

  // اختبار 1: كل الإشارات المفتوحة الحديثة
  try {
    const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/signals?status=eq.OPEN&created_at=gte.${since}&order=score.desc&limit=100`;
    const r = await fetch(url, { headers: SB_H });
    out.test_open_recent = { status: r.status, ok: r.ok };
    if (r.ok) {
      const rows = await r.json();
      out.test_open_recent.count = Array.isArray(rows) ? rows.length : "not-array";
      out.test_open_recent.sample = Array.isArray(rows) && rows[0]
        ? { symbol: rows[0].symbol, score: rows[0].score, type: rows[0].type, status: rows[0].status, has_structure: rows[0].structure != null }
        : null;
    } else {
      out.test_open_recent.error = (await r.text()).slice(0, 200);
    }
  } catch (e) { out.test_open_recent = { error: e.message }; }

  // اختبار 2: أي إشارات على الإطلاق (بلا فلتر)
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/signals?select=symbol,status,score&limit=5&order=created_at.desc`, { headers: SB_H });
    out.test_any = { status: r.status };
    if (r.ok) { const rows = await r.json(); out.test_any.count = rows.length; out.test_any.rows = rows; }
    else out.test_any.error = (await r.text()).slice(0, 200);
  } catch (e) { out.test_any = { error: e.message }; }

  // خلاصة
  const c = out.test_open_recent?.count;
  out.conclusion =
    out.test_any?.count === 0 ? "🔴 لا يقرأ أي صف — تحقّق من RLS أو المفتاح (استخدم service_role)"
    : c > 0 ? `🟢 يقرأ ${c} إشارة مفتوحة — البوت يجب أن يعمل`
    : "🟡 يصل للقاعدة لكن 0 إشارة OPEN حديثة — تحقّق من status/created_at";

  return res.status(200).json(out);
}
