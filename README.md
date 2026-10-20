# ORBITH

Web DJe Orbitha (Aleš Gehringer) — orbith.cz.

- `public/` — celý web (index.html, fotky, plakáty, videa)
- `wrangler.jsonc` — nastavení Cloudflare Workers (static assets)

Nasazení: Cloudflare Workers Builds z větve `main` (deploy command `npx wrangler deploy`). Každý push do `main` se nasadí automaticky.

Web: [vojtechsvoboda.cz](https://vojtechsvoboda.cz)
