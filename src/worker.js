// Orbith: API nad D1 (akce, plakáty, poptávky) + statický web z ./public.
// Veřejné:  GET /api/events, GET /api/poster/:id, POST /api/inquiry
// Admin:    POST /api/login, POST /api/logout, /api/admin/* (cookie podepsaná heslem ADMIN_PASSWORD)

const COOKIE = "orbith_admin";
const SESSION_DAYS = 90;
const FIELDS = ["datum", "akce", "misto", "mesto", "poradatel", "plakat", "odkaz", "vstupenky", "lineup", "popis", "set_id"];
const MAX_POSTER = 1.5 * 1024 * 1024;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const clean = (v, max = 2000) => String(v ?? "").trim().slice(0, max);
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, ctx, url, p);
    } catch (e) {
      console.error(e);
      return bad("Chyba serveru", 500);
    }
  },
};

async function route(req, env, ctx, url, p) {
  const m = req.method;

  // ---------- veřejné ----------
  if (p === "/api/events" && m === "GET") {
    const { results } = await env.DB.prepare(`SELECT id,${FIELDS.join(",")} FROM events WHERE datum<>'' ORDER BY datum DESC`).all();
    return json(results.map(pub), 200, { "cache-control": "public, max-age=30" });
  }

  const pm = p.match(/^\/api\/poster\/([\w-]+)$/);
  if (pm && m === "GET") {
    const row = await env.DB.prepare("SELECT mime,data FROM posters WHERE id=?").bind(pm[1]).first();
    if (!row) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(row.data), { headers: { "content-type": row.mime, "cache-control": "public, max-age=31536000, immutable" } });
  }

  if (p === "/api/inquiry" && m === "POST") return inquiry(req, env, ctx);

  // ---------- přihlášení ----------
  if (p === "/api/login" && m === "POST") {
    if (!env.ADMIN_PASSWORD) return bad("Heslo do administrace ještě není nastavené", 503);
    const { password } = await req.json().catch(() => ({}));
    await new Promise((r) => setTimeout(r, 400)); // zpomalí hádání hesla
    if (!password || !(await same(String(password), env.ADMIN_PASSWORD))) return bad("Špatné heslo", 401);
    const exp = Date.now() + SESSION_DAYS * 864e5;
    const tok = `${exp}.${await sign(String(exp), env.ADMIN_PASSWORD)}`;
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=${tok}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict` });
  }
  if (p === "/api/logout" && m === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }

  // ---------- administrace ----------
  if (!p.startsWith("/api/admin/")) return bad("Neznámá adresa", 404);
  if (!(await authed(req, env))) return bad("Nejste přihlášený", 401);
  if (m !== "GET" && req.headers.get("x-orbith") !== "1") return bad("Chybí hlavička", 403); // CSRF pojistka

  if (p === "/api/admin/me") return json({ ok: true, mail: !!env.MAIL });

  if (p === "/api/admin/events" && m === "GET") {
    const { results } = await env.DB.prepare(`SELECT id,${FIELDS.join(",")},updated_at FROM events ORDER BY datum DESC`).all();
    return json(results);
  }
  if (p === "/api/admin/events" && m === "POST") {
    const b = await req.json().catch(() => null);
    if (!b) return bad("Špatná data");
    const e = Object.fromEntries(FIELDS.map((k) => [k, clean(b[k], k === "popis" ? 4000 : 1000)]));
    if (!e.akce) return bad("Doplňte název akce");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.datum)) return bad("Doplňte datum");
    const id = /^[\w-]{1,40}$/.test(b.id || "") ? b.id : uid();
    const old = await env.DB.prepare("SELECT plakat FROM events WHERE id=?").bind(id).first();
    await env.DB.prepare(
      `INSERT INTO events (id,${FIELDS.join(",")},updated_at) VALUES (?,${FIELDS.map(() => "?").join(",")},?)
       ON CONFLICT(id) DO UPDATE SET ${FIELDS.map((k) => `${k}=excluded.${k}`).join(",")},updated_at=excluded.updated_at`
    ).bind(id, ...FIELDS.map((k) => e[k]), Date.now()).run();
    if (old && old.plakat !== e.plakat) await dropPoster(env, old.plakat);
    return json({ ok: true, id });
  }
  const em = p.match(/^\/api\/admin\/events\/([\w-]+)$/);
  if (em && m === "DELETE") {
    const old = await env.DB.prepare("SELECT plakat FROM events WHERE id=?").bind(em[1]).first();
    await env.DB.prepare("DELETE FROM events WHERE id=?").bind(em[1]).run();
    if (old) await dropPoster(env, old.plakat);
    return json({ ok: true });
  }

  if (p === "/api/admin/poster" && m === "POST") {
    const mime = (req.headers.get("content-type") || "").split(";")[0];
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return bad("Plakát musí být obrázek");
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_POSTER) return bad("Plakát je moc velký");
    const id = uid();
    await env.DB.prepare("INSERT INTO posters (id,mime,data,created_at) VALUES (?,?,?,?)").bind(id, mime, buf, Date.now()).run();
    return json({ ok: true, url: `/api/poster/${id}` });
  }

  if (p === "/api/admin/inquiries" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM inquiries ORDER BY ts DESC LIMIT 300").all();
    return json(results.map((q) => ({ ...q, done: !!q.done })));
  }
  const qm = p.match(/^\/api\/admin\/inquiries\/([\w-]+)$/);
  if (qm && m === "PATCH") {
    const { done } = await req.json().catch(() => ({}));
    await env.DB.prepare("UPDATE inquiries SET done=? WHERE id=?").bind(done ? 1 : 0, qm[1]).run();
    return json({ ok: true });
  }
  if (qm && m === "DELETE") {
    await env.DB.prepare("DELETE FROM inquiries WHERE id=?").bind(qm[1]).run();
    return json({ ok: true });
  }

  return bad("Neznámá adresa", 404);
}

function pub(e) {
  const { set_id, ...rest } = e;
  return { ...rest, set: set_id || "" };
}

async function dropPoster(env, url) {
  const m = String(url || "").match(/^\/api\/poster\/([\w-]+)$/);
  if (m) await env.DB.prepare("DELETE FROM posters WHERE id=?").bind(m[1]).run();
}

// ---------- poptávka z webu ----------
async function inquiry(req, env, ctx) {
  const b = await req.json().catch(() => null);
  if (!b) return bad("Špatná data");
  if (b.web) return json({ ok: true }); // honeypot pro roboty
  const q = {
    id: uid(), ts: Date.now(),
    name: clean(b.name, 120), contact: clean(b.contact, 160), typ: clean(b.typ, 80),
    datum: clean(b.datum, 10), misto: clean(b.misto, 200), hoste: clean(b.hoste, 40),
    set_len: clean(b.set, 40), msg: clean(b.msg, 3000),
  };
  if (!q.name || !q.contact) return bad("Doplňte jméno a kontakt");
  const recent = await env.DB.prepare("SELECT COUNT(*) n FROM inquiries WHERE ts>?").bind(Date.now() - 6e5).first();
  if (recent && recent.n > 20) return bad("Zkuste to prosím za chvíli", 429);
  await env.DB.prepare("INSERT INTO inquiries (id,ts,name,contact,typ,datum,misto,hoste,set_len,msg,done) VALUES (?,?,?,?,?,?,?,?,?,?,0)")
    .bind(q.id, q.ts, q.name, q.contact, q.typ, q.datum, q.misto, q.hoste, q.set_len, q.msg).run();
  if (env.MAIL) ctx.waitUntil(mail(env, q).catch((e) => console.error("mail", e)));
  return json({ ok: true });
}

async function mail(env, q) {
  const { EmailMessage } = await import("cloudflare:email");
  const from = env.MAIL_FROM || "web@orbith.cz";
  const to = env.MAIL_TO || "ales.gehringer@gmail.com";
  const d = q.datum ? q.datum.split("-").reverse().map(Number).join(". ") : "—";
  const text = [
    `Nová poptávka z webu orbith.cz`, ``,
    `Jméno:   ${q.name}`, `Kontakt: ${q.contact}`, `Akce:    ${q.typ}`, `Datum:   ${d}`,
    `Místo:   ${q.misto || "—"}`, `Hosté:   ${q.hoste || "—"}`, `Set:     ${q.set_len || "—"}`, ``,
    q.msg || "(bez zprávy)", ``, `Všechny poptávky: https://orbith.cz/admin/`,
  ].join("\r\n");
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const replyTo = /@/.test(q.contact) ? `Reply-To: ${q.contact.replace(/[\r\n<>]/g, "")}\r\n` : "";
  const raw =
    `From: Web Orbith <${from}>\r\nTo: ${to}\r\n${replyTo}` +
    `Subject: =?UTF-8?B?${b64(`Poptávka: ${q.typ || "akce"} · ${q.name}`)}?=\r\n` +
    `Message-ID: <${q.id}@orbith.cz>\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    b64(text).replace(/.{76}/g, "$&\r\n");
  await env.MAIL.send(new EmailMessage(from, to, raw));
}

// ---------- přihlášení: podepsaná cookie ----------
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode("orbith:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function sign(data, secret) {
  const s = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(data));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function same(a, b) {
  const [x, y] = await Promise.all([sign(a, "cmp"), sign(b, "cmp")]);
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}
async function authed(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const c = (req.headers.get("cookie") || "").split(/;\s*/).find((x) => x.startsWith(COOKIE + "="));
  if (!c) return false;
  const [exp, sig] = c.slice(COOKIE.length + 1).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return same(sig, await sign(exp, env.ADMIN_PASSWORD));
}
