/**
 * Kathmandu HomeKraft & Flavors — single-file Worker.
 * Handles /api/* routes. Everything else (index.html, admin.html, qr.png)
 * is served automatically as a static asset before this code ever runs.
 * This _worker.js format works identically on Workers and Pages projects,
 * so it sidesteps any "Pages Functions vs Workers" project-type confusion.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-key",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
function requireAdmin(request, env) {
  const key = request.headers.get("x-admin-key");
  return !!env.ADMIN_KEY && key === env.ADMIN_KEY;
}
const DEFAULT_CONFIG = {
  business: "Kathmandu HomeKraft & Flavors",
  price: 350, currency: "Rs.", whatsapp: "",
  qr_url: "/qr.png", bank_name: "", acc_name: "Kathmandu HomeKraft & Flavors",
  acc_number: "", esewa: "", delivery: "1-2 days",
};
async function getConfig(env) {
  try {
    const row = await env.DB.prepare("SELECT v FROM settings WHERE k='config'").first();
    if (row && row.v) return { ...DEFAULT_CONFIG, ...JSON.parse(row.v) };
  } catch (e) {}
  return DEFAULT_CONFIG;
}
async function saveConfig(env, cfg) {
  const v = JSON.stringify(cfg);
  await env.DB.prepare(
    "INSERT INTO settings (k,v) VALUES ('config',?1) ON CONFLICT(k) DO UPDATE SET v=?1"
  ).bind(v).run();
}
function money(cfg, n) {
  return (cfg.currency || "Rs.") + " " + Number(n).toLocaleString("en-IN");
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
async function sendEmail(env, to, subject, innerHtml) {
  if (!env.BREVO_API_KEY || !env.FROM_EMAIL) return { ok: false, error: "email not configured" };
  let fromName = "Kathmandu HomeKraft & Flavors", fromEmail = env.FROM_EMAIL;
  const m = env.FROM_EMAIL.match(/^\s*(.*?)\s*<(.+)>\s*$/);
  if (m) { fromName = m[1].replace(/"/g, "") || fromName; fromEmail = m[2].trim(); }
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #eee;border-radius:14px;overflow:hidden">' +
    '<div style="background:#4A0D0D;color:#FBF4E6;padding:20px 24px"><div style="font-size:12px;letter-spacing:2px;opacity:.8">KATHMANDU HOMEKRAFT &amp; FLAVORS</div></div>' +
    '<div style="padding:24px;color:#2A1710;line-height:1.6">' + innerHtml + "</div>" +
    '<div style="background:#2E0808;color:#F7CC55;padding:12px 24px;font-size:12px">सत्यं परमं शुद्धम् — Traditional Homemade Taste</div></div>';
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { name: fromName, email: fromEmail }, to: [{ email: to }], subject, htmlContent: html }),
  });
  return { ok: r.ok };
}
function orderSummary(cfg, o) {
  let s = `${o.qty} × Seeta Mix Achaar (400g) — <b>${money(cfg, o.total)}</b>`;
  if (o.is_gift) s += `<br>Gift for: ${esc(o.recipient_name)}`;
  s += `<br>Deliver to: ${esc(o.delivery_location)}`;
  return s;
}

async function routeConfig(env) {
  const c = await getConfig(env);
  return json({
    price: c.price, currency: c.currency, whatsapp: c.whatsapp,
    qr: c.qr_url, bank: c.bank_name, accName: c.acc_name,
    accNum: c.acc_number, esewa: c.esewa, delivery: c.delivery,
  });
}

async function routeOrder(request, env) {
  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, msg: "Bad form data" }, 400); }
  const g = (k) => (form.get(k) || "").toString().trim();
  const cfg = await getConfig(env);
  const qty = Math.max(1, parseInt(g("qty") || "1", 10));
  const total = qty * Number(cfg.price || 0);
  const name = g("name"), email = g("email"), address = g("address");
  if (!name || !email.includes("@") || !address) return json({ ok: false, msg: "Please fill all required fields." }, 400);

  let key = null;
  const file = form.get("screenshot");
  if (file && typeof file === "object" && file.size) {
    if (file.size > 6 * 1024 * 1024) return json({ ok: false, msg: "Screenshot must be under 6 MB." }, 400);
    const type = file.type || "";
    if (!/image\/(jpeg|png|webp|jpg)/.test(type)) return json({ ok: false, msg: "Upload a JPG, PNG or WEBP image." }, 400);
    const ext = type.split("/")[1].replace("jpeg", "jpg");
    key = `screenshots/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await env.BUCKET.put(key, file.stream(), { httpMetadata: { contentType: type } });
  }

  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO orders (created_at,status,name,email,phone,qty,total,is_gift,recipient_name,recipient_phone,delivery_location,country,address,notes,txn_ref,screenshot_key)
     VALUES (?1,'pending',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
  ).bind(
    now, name, email, g("phone"), qty, total,
    g("is_gift") ? 1 : 0, g("recipient_name"), g("recipient_phone"),
    g("delivery_location"), g("country") || "Nepal", address, g("notes"), g("txn_ref"), key
  ).run();

  const id = res.meta.last_row_id;
  const o = { qty, total, is_gift: g("is_gift") ? 1 : 0, recipient_name: g("recipient_name"), delivery_location: g("delivery_location") };

  await sendEmail(env, email, `Thank you for your order #${id} — Seeta Mix Achaar`,
    `<p>Namaste ${esc(name)},</p>
     <p>Thank you for your order <b>#${id}</b>. We've received it and are <b>verifying your payment</b>. You'll get a confirmation email shortly with your delivery time.</p>
     <p style="background:#F4E7C9;border-radius:10px;padding:12px 14px">${orderSummary(cfg, o)}</p>
     <p style="font-size:13px;color:#6B5240">Storage: keep cool &amp; dry, use a dry spoon. Best before 3 months from packaging.</p>
     <p>Dhanyabaad! 🙏</p>`);

  if (env.NOTIFY_EMAIL) {
    await sendEmail(env, env.NOTIFY_EMAIL, `New order #${id} — verify payment`,
      `<p><b>New order #${id}</b> (awaiting verification).</p>
       <p>${orderSummary(cfg, o)}</p>
       <p>Name: ${esc(name)}<br>Phone: ${esc(g("phone"))}<br>Email: ${esc(email)}</p>
       <p>Open your admin page to review the screenshot and confirm.</p>`);
  }
  return json({ ok: true, id });
}

async function routeInquiry(request, env) {
  let d = {};
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) d = await request.json();
    else { const f = await request.formData(); for (const [k, v] of f) d[k] = v.toString(); }
  } catch { return json({ ok: false, msg: "Bad data" }, 400); }

  const type = d.type === "contact" ? "contact" : "bulk";
  const name = (d.name || "").trim(), email = (d.email || "").trim();
  if (!name || !email.includes("@")) return json({ ok: false, msg: "Enter your name and a valid email." }, 400);

  await env.DB.prepare(
    `INSERT INTO inquiries (created_at,type,name,company,country,email,phone,quantity,message)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
  ).bind(new Date().toISOString(), type, name, d.company || "", d.country || "", email, d.phone || "", d.quantity || "", d.message || "").run();

  const label = type === "contact" ? "Contact message" : "Bulk / wholesale enquiry";
  if (env.NOTIFY_EMAIL) {
    let body = `<p><b>New ${label}</b></p><p>Name: ${esc(name)}`;
    if (d.company) body += `<br>Company: ${esc(d.company)}`;
    if (d.country) body += `<br>Country: ${esc(d.country)}`;
    body += `<br>Email: ${esc(email)}`;
    if (d.phone) body += `<br>Phone: ${esc(d.phone)}`;
    if (d.quantity) body += `<br>Quantity: ${esc(d.quantity)}`;
    body += `</p><p>${esc(d.message || "")}</p>`;
    await sendEmail(env, env.NOTIFY_EMAIL, `New ${label}`, body);
  }
  await sendEmail(env, email, "We received your message",
    `<p>Namaste ${esc(name)},</p><p>Thanks for reaching out — we've received your ${esc(label.toLowerCase())} and will reply within 1–2 working days.</p>`);

  return json({ ok: true });
}

async function routeAdminOrders(request, env) {
  if (!requireAdmin(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
  const orders = await env.DB.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 300").all();
  const inquiries = await env.DB.prepare("SELECT * FROM inquiries ORDER BY id DESC LIMIT 300").all();
  return json({ ok: true, orders: orders.results || [], inquiries: inquiries.results || [] });
}

async function routeAdminFile(request, env, url) {
  if (!requireAdmin(request, env)) return new Response("Unauthorized", { status: 401, headers: CORS });
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400, headers: CORS });
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: CORS });
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "private, max-age=60", ...CORS },
  });
}

async function routeAdminConfirm(request, env) {
  if (!requireAdmin(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
  const id = parseInt(b.id, 10);
  if (!id) return json({ ok: false, error: "id required" }, 400);
  const o = await env.DB.prepare("SELECT * FROM orders WHERE id=?1").bind(id).first();
  if (!o) return json({ ok: false, error: "Order not found" }, 404);
  const cfg = await getConfig(env);

  if (b.action === "cancel") {
    await env.DB.prepare("UPDATE orders SET status='cancelled' WHERE id=?1").bind(id).run();
    return json({ ok: true, status: "cancelled" });
  }
  if (b.action === "deliver") {
    await env.DB.prepare("UPDATE orders SET status='delivered' WHERE id=?1").bind(id).run();
    return json({ ok: true, status: "delivered" });
  }
  const dt = (b.delivery_time || cfg.delivery || "1-2 days").toString();
  await env.DB.prepare("UPDATE orders SET status='confirmed', delivery_time=?2, confirmed_at=?3 WHERE id=?1")
    .bind(id, dt, new Date().toISOString()).run();

  await sendEmail(env, o.email, `Your order #${id} is confirmed ✅`,
    `<p>Namaste ${esc(o.name)},</p>
     <p>Good news — your payment is verified and order <b>#${id}</b> is <b>confirmed ✅</b>. It's being packed fresh.</p>
     <p style="background:#F4E7C9;border-radius:10px;padding:12px 14px">${orderSummary(cfg, o)}<br><b>Delivery:</b> within ${esc(dt)}</p>
     <p>Dhanyabaad! 🙏</p>`);

  return json({ ok: true, status: "confirmed" });
}

async function routeAdminStats(request, env) {
  if (!requireAdmin(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
  const sales = await env.DB.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status IN('confirmed','delivered')").first();
  const total = await env.DB.prepare("SELECT COUNT(*) c FROM orders").first();
  const pending = await env.DB.prepare("SELECT COUNT(*) c FROM orders WHERE status='pending'").first();
  const rows = await env.DB.prepare(
    "SELECT substr(confirmed_at,1,10) d, SUM(total) s FROM orders WHERE status IN('confirmed','delivered') AND confirmed_at >= ?1 GROUP BY d"
  ).bind(new Date(Date.now() - 30 * 864e5).toISOString()).all();
  const byday = {};
  for (const r of rows.results || []) byday[r.d] = r.s;
  const labels = [], values = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    labels.push(d.slice(5));
    values.push(byday[d] || 0);
  }
  return json({ ok: true, sales: sales.s || 0, orders: total.c || 0, pending: pending.c || 0, labels, values });
}

async function routeAdminSettings(request, env) {
  if (!requireAdmin(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
  if (request.method === "GET") return json({ ok: true, config: await getConfig(env) });
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
  const cur = await getConfig(env);
  const next = {
    business: b.business ?? cur.business,
    price: Number(b.price ?? cur.price) || 0,
    currency: b.currency ?? cur.currency,
    whatsapp: b.whatsapp ?? cur.whatsapp,
    qr_url: b.qr_url ?? cur.qr_url,
    bank_name: b.bank_name ?? cur.bank_name,
    acc_name: b.acc_name ?? cur.acc_name,
    acc_number: b.acc_number ?? cur.acc_number,
    esewa: b.esewa ?? cur.esewa,
    delivery: b.delivery ?? cur.delivery,
  };
  await saveConfig(env, next);
  return json({ ok: true, config: next });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      if (p === "/api/config" && request.method === "GET") return routeConfig(env);
      if (p === "/api/order" && request.method === "POST") return routeOrder(request, env);
      if (p === "/api/inquiry" && request.method === "POST") return routeInquiry(request, env);
      if (p === "/api/admin/orders" && request.method === "GET") return routeAdminOrders(request, env);
      if (p === "/api/admin/file" && request.method === "GET") return routeAdminFile(request, env, url);
      if (p === "/api/admin/confirm" && request.method === "POST") return routeAdminConfirm(request, env);
      if (p === "/api/admin/stats" && request.method === "GET") return routeAdminStats(request, env);
      if (p === "/api/admin/settings" && (request.method === "GET" || request.method === "POST")) return routeAdminSettings(request, env);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500);
    }

    // Not an API route — serve static assets (index.html, admin.html, qr.png, etc.)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
