# Orbith · web

Web DJe Orbitha (Aleš Gehringer). Cloudflare Workers: statický web z `public/`, API v `src/worker.js`, data v D1 `orbith`.

- `/` web, akce načítá z `/api/events` (když API neodpoví, použijí se akce zapsané v `index.html`)
- `/admin/` administrace: přidání a úprava akcí, plakáty, poptávky z formuláře
- Heslo do administrace: secret `ADMIN_PASSWORD` (Worker → Settings → Variables and Secrets). Změna hesla odhlásí všechna zařízení.
- E-mail s poptávkou: po zapnutí Email Routingu na orbith.cz odkomentovat `send_email` ve `wrangler.jsonc`.

Lokálně: `npx wrangler dev` (heslo do `.dev.vars` jako `ADMIN_PASSWORD=...`).
