# Cloudflare Workers Migration Plan

## Current State

- **Runtime:** Node.js 20+ (Express)
- **Database:** SQLite (better-sqlite3, file-based)
- **Crypto:** Node.js `crypto` module (AES-256-GCM)
- **Frontend:** Vite + React → static `client/dist/`
- **Deploy:** Manual `npm run dev` on local machine

## Target State

- **Runtime:** Cloudflare Workers (V8 isolates, Hono framework)
- **Database:** Cloudflare D1 (SQLite-compatible, serverless)
- **Crypto:** Web Crypto API (`crypto.subtle`)
- **Frontend:** Static assets served by Workers (or Cloudflare Pages)
- **Deploy:** `wrangler deploy` — zero-config CI/CD

---

## Phase 1: Runtime Migration (Express → Hono)

### What changes

| Current | Target |
|---------|--------|
| `express` + `cors` + `helmet` | `hono` (built-in CORS, middleware) |
| `app.use('/api/keys', keysRouter)` | `app.route('/api/keys', keysRouter)` |
| `express.json({ limit: '1mb' })` | `hono/body` middleware |
| `express.static(clientDist)` | `hono/serve-static` or Pages |

### Files to rewrite

```
server/src/app.ts              → workers/src/index.ts
server/src/routes/*.ts         → workers/src/routes/*.ts
server/src/middleware/*.ts     → workers/src/middleware/*.ts (inline into routes)
```

### What stays the same

- All route logic (keys, models, fallback, analytics, health, settings)
- All provider implementations (Google, Groq, OpenRouter, etc.)
- All business logic (router, ratelimit, health checker)
- Shared types (`shared/types.ts`)

### Effort: ~2 days

---

## Phase 2: Database Migration (SQLite → D1)

### What changes

| Current | Target |
|---------|--------|
| `better-sqlite3` (sync, file-based) | `D1Database` (async, HTTP-based) |
| `db.prepare('SELECT ...').all()` | `db.prepare('SELECT ...').all()` (same API!) |
| `db.prepare('INSERT ...').run()` | `db.prepare('INSERT ...').run()` (same API!) |
| File: `server/data/freeapi.db` | D1 binding: `env.DB` |

### The good news

D1 uses the **same SQL syntax** as SQLite. The `better-sqlite3` API maps almost 1:1 to D1's prepared statements. The main difference is **async vs sync**:

```typescript
// Current (sync)
const rows = db.prepare('SELECT * FROM api_keys').all()

// Workers (async)
const { results } = await env.DB.prepare('SELECT * FROM api_keys').all()
```

### Migration steps

1. Export current schema: `sqlite3 server/data/freeapi.db ".schema"` → `workers/migrations/001_initial.sql`
2. Create D1 database: `wrangler d1 create freellmapi`
3. Apply migration: `wrangler d1 execute freellmapi --file=workers/migrations/001_initial.sql`
4. Update all `getDb()` calls to use `env.DB` from Hono context
5. Seed initial data (models, fallback config) via migration script

### Tables to migrate

| Table | Rows | Notes |
|-------|------|-------|
| `api_keys` | ~55 | Encrypted keys — no schema change needed |
| `models` | ~100+ | Catalog — seed from current DB |
| `fallback_config` | ~100+ | Priority chain — seed from current DB |
| `requests` | variable | Analytics log — can start fresh |
| `rate_limits` | variable | In-memory cache, not persisted |

### Effort: ~3 days

---

## Phase 3: Crypto Migration (Node → Web Crypto)

### What changes

| Current | Target |
|---------|--------|
| `crypto.randomBytes(32)` | `crypto.getRandomValues(new Uint8Array(32))` |
| `crypto.createCipheriv('aes-256-gcm', key, iv)` | `crypto.subtle.importKey('raw', key, 'AES-GCM', ...)` + `crypto.subtle.encrypt()` |
| `crypto.createDecipheriv(...)` | `crypto.subtle.decrypt()` |
| Synchronous | Asynchronous |

### Current encryption flow

```typescript
// server/src/lib/crypto.ts
const key = crypto.scryptSync(password, salt, 32)
const iv = crypto.randomBytes(12)
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
let encrypted = cipher.update(plaintext)
encrypted = Buffer.concat([encrypted, cipher.final()])
return { encrypted, iv, authTag: cipher.getAuthTag() }
```

### Workers encryption flow

```typescript
// workers/src/lib/crypto.ts
const rawKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, rawKey, plaintextBytes)
// Auth tag is last 16 bytes of encrypted buffer
```

### Key management

| Secret | Current | Workers |
|--------|---------|---------|
| Encryption password | `.env` file | `wrangler secret put ENCRYPTION_KEY` |
| Unified API key | Generated on first run, stored in DB | `wrangler secret put UNIFIED_KEY` (or keep in D1) |

### Effort: ~1 day

---

## Phase 4: Provider Compatibility

### What works as-is

All providers use `fetch()` internally (via `this.fetchWithTimeout`), which is **native** in Workers. No changes needed for:

- Google, Groq, Cerebras, SambaNova, NVIDIA, Mistral
- OpenRouter, GitHub, Cohere, Cloudflare, Zhipu
- Ollama, Kilo, Pollinations, LLM7

### What needs changes

| Provider | Issue | Fix |
|----------|-------|-----|
| `AbortController` timeout | Workers supports it natively | No change needed |
| `TextDecoder`/`TextEncoder` | Native in Workers | No change needed |
| Streaming (`AsyncGenerator`) | Workers supports it | No change needed |

### Health checker

Current: `setInterval` runs every 5 minutes in the Node process.
Workers: No long-running processes. Options:

1. **Cron Trigger** — `wrangler.toml` cron: `"*/5 * * * *"` → hits `/api/health/check-all` internally
2. **Lazy check** — check keys on-demand when routing (adds latency but simpler)
3. **Queue Worker** — Cloudflare Queues for background health checks (overkill)

**Recommendation:** Cron Trigger. Add to `wrangler.toml`:

```toml
[[triggers.crons]]
cron = "*/5 * * * *"
```

### Effort: ~1 day

---

## Phase 5: Frontend Deployment

### Option A: Workers serves frontend (simpler)

```typescript
// workers/src/index.ts
app.get('*', async (c) => {
  const asset = await getAsset(c.req.path)
  if (asset) return c.body(asset, 200, { 'Content-Type': guessType(c.req.path) })
  return c.html(await getAsset('/index.html'))
})
```

- Uses `wrangler.toml` assets config
- Single deploy command: `wrangler deploy`
- Good enough for a single-user admin panel

### Option B: Cloudflare Pages (better)

- `wrangler pages deploy client/dist/`
- Separate from Workers API
- Built-in CDN, caching, preview deployments
- Better for if you ever add public pages

**Recommendation:** Option A for now. Switch to Pages if the frontend grows.

### Effort: ~0.5 days

---

## Phase 6: Secrets & Security

### Workers Secrets

```bash
wrangler secret put ENCRYPTION_KEY    # AES-256 key for provider key encryption
wrangler secret put UNIFIED_KEY       # Your unified API key (or generate on first deploy)
```

Secrets are:
- Encrypted at rest by Cloudflare
- Injected as `env.ENCRYPTION_KEY` at runtime
- Never visible in logs, source code, or D1
- Rotatable without redeploy

### D1 Data Security

| Data | Encrypted? | Where |
|------|-----------|-------|
| Provider API keys | Yes (AES-256-GCM) | D1 `api_keys.encrypted_key` |
| Unified API key | No (hashed with bcrypt) | D1 or Workers secret |
| Request logs | No | D1 `requests` table |
| Model catalog | No | D1 `models` table |

### CSP / CORS

- Workers runs on `*.workers.dev` — set custom domain for production
- CORS: allow only your domain (or localhost for dev)
- CSP: tighten for production (currently disabled in dev)

### Effort: ~0.5 days

---

## Phase 7: Deployment Pipeline

### wrangler.toml

```toml
name = "freellmapi"
main = "workers/src/index.ts"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "freellmapi"
database_id = "<from wrangler d1 create>"

[assets]
directory = "client/dist"
binding = "ASSETS"

[[triggers.crons]]
cron = "*/5 * * * *"
```

### Deploy command

```bash
npm run build          # builds client + workers
wrangler deploy        # pushes to Cloudflare
```

### CI/CD (GitHub Actions)

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci && npm run build
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
```

### Effort: ~1 day

---

## Phase 8: Admin Panel Authentication

**Problem:** The current app has zero auth. Anyone with the URL gets full admin access (view/edit/delete API keys, send requests, view analytics). For a public Workers deployment this must change.

### Option A: Cloudflare Access (recommended, zero code)

Enable in the Cloudflare dashboard — no code changes needed.

1. Go to Zero Trust → Access → Applications
2. Create an application pointing to your Worker's domain
3. Add a policy: allow only your email (Google/GitHub login, or email OTP)
4. Cloudflare intercepts all requests before they hit your Worker

**Pros:** No code, handles 2FA, audit logs, works with any identity provider
**Cons:** Requires Cloudflare Zero Trust ($0 for up to 50 users), only works on Cloudflare

### Option B: HTTP Basic Auth (~2 hours)

Hono middleware that checks `Authorization: Basic` header against Workers secrets.

```typescript
// workers/src/middleware/auth.ts
import { timingSafeEqual } from 'crypto'

export function basicAuth(user: string, pass: string) {
  return async (c: Context, next: Function) => {
    const auth = c.req.header('Authorization')
    const expected = `Basic ${btoa(`${user}:${pass}`)}`
    if (!auth || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      c.header('WWW-Authenticate', 'Basic realm="FreeLLMAPI"')
      return c.text('Unauthorized', 401)
    }
    await next()
  }
}

// In index.ts — apply to all admin routes, NOT /v1 proxy
app.use('/api/*', basicAuth(c.env.ADMIN_USER, c.env.ADMIN_PASS))
app.use('/fallback/*', basicAuth(c.env.ADMIN_USER, c.env.ADMIN_PASS))
app.use('/analytics/*', basicAuth(c.env.ADMIN_USER, c.env.ADMIN_PASS))
// /v1/* stays open — clients authenticate with unified API key, not admin auth
```

Secrets:
```bash
wrangler secret put ADMIN_USER    # your username
wrangler secret put ADMIN_PASS    # strong password
```

**Pros:** Works anywhere, no external dependency, ~20 lines of code
**Cons:** No 2FA, browser login UI is ugly, credentials shared via `wrangler secret`

### Option C: Session-based login with KV (~1 day)

Full login page with username/password, session tokens stored in Cloudflare KV.

1. Add `/login` page to the React frontend
2. POST `/api/auth/login` checks credentials, sets a session cookie
3. KV stores `{ sessionId: { user, expires } }` with TTL
4. Middleware validates session cookie on all admin routes
5. `/api/auth/logout` deletes session from KV

```typescript
// wrangler.toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "<from wrangler kv:namespace create>"
```

**Pros:** Custom login UI, can add 2FA later, session revocation
**Cons:** More code, KV adds complexity, session management edge cases

### What needs protecting

| Route | Auth needed? | Why |
|-------|-------------|-----|
| `/v1/*` | No — uses unified API key | This is the public API endpoint |
| `/api/keys/*` | Yes | View/edit/delete provider credentials |
| `/api/fallback/*` | Yes | Reorder model priorities |
| `/api/analytics/*` | Yes | View request logs and usage |
| `/api/health/*` | Yes | Trigger health checks |
| `/api/settings/*` | Yes | Regenerate unified API key |
| `/api/models/discover/*` | Yes | Uses provider API keys internally |
| Frontend pages (`/keys`, `/fallback`, `/analytics`) | Yes | SPA calls the above API routes |

### Recommendation

Start with **Option A (Cloudflare Access)** if deploying to Cloudflare — zero code, best security. Add **Option B (Basic Auth)** as a fallback for local development or non-Cloudflare deployments. Both can coexist: Basic Auth checks first, then Cloudflare Access if deployed there.

---

## Effort Summary

| Phase | What | Days |
|-------|------|------|
| 1 | Express → Hono | 2 |
| 2 | SQLite → D1 | 3 |
| 3 | Node crypto → Web Crypto | 1 |
| 4 | Provider compatibility + health cron | 1 |
| 5 | Frontend deployment | 0.5 |
| 6 | Secrets & security | 0.5 |
| 7 | Deployment pipeline | 1 |
| 8 | Admin panel auth (optional) | 0–1 |
| **Total** | | **~9–10 days** |

## Cost Estimate (Cloudflare Free Tier)

| Resource | Free Tier | Your Usage |
|----------|-----------|------------|
| Workers requests | 100K/day | ~10K/day (plenty of headroom) |
| D1 storage | 5 GB | ~10 MB (tiny) |
| D1 reads | 5M/day | ~50K/day |
| D1 writes | 100K/day | ~5K/day |
| Cron triggers | 1K/month | ~8.6K/month (exceeds free) |
| **Total cost** | **$0** | **~$5/mo** (cron overage) |

The cron overage is the only cost. Can reduce to hourly checks (`0 * * * *`) to stay free.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| D1 cold starts | +200ms on first request after idle | Keep-alive ping every 5 min |
| Web Crypto async | All crypto calls become async | Refactor `encrypt/decrypt` to return Promises |
| Workers 15s CPU limit | Long health checks may timeout | Split health checks into batches, use 120s limit on paid tier |
| No `setInterval` | Background tasks don't work | Use cron triggers instead |
| Bundle size limit | 1MB for Workers | Tree-shake providers, lazy-load unused ones |

## Recommendation

**Do it.** The migration is straightforward — mostly API surface changes (Express→Hono, sync→async). The core logic (routing, providers, rate limiting) stays identical. You get:

- Always-on (no need to keep a local server running)
- Global edge deployment (lower latency worldwide)
- Zero infra management (no server to maintain)
- Built-in HTTPS and DDoS protection
- $0-5/mo cost
