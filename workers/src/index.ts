import { Hono } from 'hono';
import { cors } from 'hono/cors';
import crypto from 'node:crypto';

type Bindings = {
  DB: D1Database;
  AI: Ai;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/api/*', cors());

// --- Crypto (AES-256-GCM, Workers-compatible via nodejs_compat) ---

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;

function parseHexKey(value: string, source: string): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars.`);
  }
  return Buffer.from(value, 'hex');
}

let cachedEncryptionKey: Buffer | null = null;

async function getEncryptionKey(db: D1Database): Promise<Buffer> {
  if (cachedEncryptionKey) return cachedEncryptionKey;

  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey !== 'your-64-char-hex-key-here') {
    cachedEncryptionKey = parseHexKey(envKey, 'env');
    return cachedEncryptionKey;
  }

  const { results } = await db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").all();
  const row = (results as any[])?.[0];
  if (row) {
    cachedEncryptionKey = parseHexKey(row.value, 'db');
    return cachedEncryptionKey;
  }

  cachedEncryptionKey = crypto.randomBytes(KEY_BYTES);
  await db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").bind(cachedEncryptionKey.toString('hex')).run();
  return cachedEncryptionKey;
}

async function encrypt(db: D1Database, text: string): Promise<{ encrypted: string; iv: string; authTag: string }> {
  const key = await getEncryptionKey(db);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return { encrypted, iv: iv.toString('hex'), authTag };
}

async function decrypt(db: D1Database, encrypted: string, iv: string, authTag: string): Promise<string> {
  const key = await getEncryptionKey(db);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****' + key.slice(-4);
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// --- Timing-safe string comparison ---

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// --- Auth middleware ---

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/ping') return next();

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: { message: 'Authentication required', type: 'authentication_error' } }, 401);
  }

  const token = authHeader.slice(7);
  const { results } = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").all();
  const unifiedKey = (results as any[])?.[0]?.value;

  if (!unifiedKey || !timingSafeEqual(token, unifiedKey)) {
    return c.json({ error: { message: 'Invalid API key', type: 'authentication_error' } }, 401);
  }

  return next();
});

// --- API Routes ---

// Health check (no auth)
app.get('/api/ping', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// DB status
app.get('/api/db-status', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT COUNT(*) as count FROM models').all();
  return c.json({ models: (results as any)[0]?.count ?? 0 });
});

// --- Keys routes ---

const PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7',
] as const;

// List keys (masked)
app.get('/api/keys', async (c) => {
  const db = c.env.DB;
  const { results } = await db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all();
  const rows = results as any[];

  const keys = await Promise.all(rows.map(async (row) => {
    let maskedKey = '****';
    try {
      const realKey = await decrypt(db, row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      status: row.status,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  }));

  return c.json(keys);
});

// Export keys (decrypted)
app.get('/api/keys/export', async (c) => {
  const db = c.env.DB;
  const { results } = await db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all();
  const rows = results as any[];

  const keys = await Promise.all(rows.map(async (row) => {
    let key = '';
    try {
      key = await decrypt(db, row.encrypted_key, row.iv, row.auth_tag);
    } catch {
      key = '[decrypt failed]';
    }
    return { platform: row.platform, key, label: row.label, status: row.status };
  }));

  return c.json(keys);
});

// Add a key
app.post('/api/keys', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();
  const { platform, key, label } = body;

  if (!platform || !key) {
    return c.json({ error: { message: 'platform and key are required' } }, 400);
  }
  if (!PLATFORMS.includes(platform as any)) {
    return c.json({ error: { message: `Unknown platform: ${platform}` } }, 400);
  }

  const { encrypted, iv, authTag } = await encrypt(db, key);
  const { results } = await db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).bind(platform, label ?? '', encrypted, iv, authTag).run();

  return c.json({
    id: results.meta?.last_row_id,
    platform,
    label: label ?? '',
    maskedKey: maskKey(key),
    status: 'unknown',
    enabled: true,
  }, 201);
});

// Delete all keys
app.delete('/api/keys', async (c) => {
  const { results } = await c.env.DB.prepare('DELETE FROM api_keys').run();
  return c.json({ success: true, deleted: results.meta?.changes });
});

// Delete non-working keys
app.delete('/api/keys/non-working', async (c) => {
  const { results } = await c.env.DB.prepare("DELETE FROM api_keys WHERE status != 'healthy'").run();
  return c.json({ success: true, deleted: results.meta?.changes });
});

// Delete a key
app.delete('/api/keys/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: { message: 'Invalid key ID' } }, 400);

  const { results } = await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
  if (results.meta?.changes === 0) return c.json({ error: { message: 'Key not found' } }, 404);

  return c.json({ success: true });
});

// Toggle enable/disable
app.patch('/api/keys/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: { message: 'Invalid key ID' } }, 400);

  const body = await c.req.json();
  if (typeof body.enabled !== 'boolean') return c.json({ error: { message: 'enabled must be a boolean' } }, 400);

  const { results } = await c.env.DB.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').bind(body.enabled ? 1 : 0, id).run();
  if (results.meta?.changes === 0) return c.json({ error: { message: 'Key not found' } }, 404);

  return c.json({ success: true, enabled: body.enabled });
});

// --- Models routes ---

app.get('/api/models', async (c) => {
  const db = c.env.DB;
  const { results: models } = await db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all();

  const { results: keyCounts } = await db.prepare(`
    SELECT platform, COUNT(*) as count FROM api_keys WHERE enabled = 1 GROUP BY platform
  `).all();

  const keyCountMap = new Map((keyCounts as any[]).map((k: any) => [k.platform, k.count]));

  const result = (models as any[]).map((m: any) => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    hasProvider: true,
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  return c.json(result);
});

// --- Fallback routes ---

app.get('/api/fallback', async (c) => {
  const db = c.env.DB;
  const { results: rows } = await db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.monthly_token_budget
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    ORDER BY fc.priority ASC
  `).all();

  const { results: keyCounts } = await db.prepare(`
    SELECT platform, COUNT(*) as count FROM api_keys WHERE enabled = 1 GROUP BY platform
  `).all();
  const keyCountMap = new Map((keyCounts as any[]).map((k: any) => [k.platform, k.count]));

  const result = (rows as any[]).map((r: any) => ({
    modelDbId: r.model_db_id,
    priority: r.priority,
    effectivePriority: r.priority,
    penalty: 0,
    rateLimitHits: 0,
    enabled: r.enabled === 1,
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name,
    intelligenceRank: r.intelligence_rank,
    speedRank: r.speed_rank,
    sizeLabel: r.size_label,
    rpmLimit: r.rpm_limit,
    rpdLimit: r.rpd_limit,
    monthlyTokenBudget: r.monthly_token_budget,
    keyCount: keyCountMap.get(r.platform) ?? 0,
  }));

  return c.json(result);
});

app.put('/api/fallback', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();
  if (!Array.isArray(body)) return c.json({ error: { message: 'Expected array' } }, 400);

  const update = db.prepare('UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?');
  for (const entry of body) {
    await update.bind(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId).run();
  }

  return c.json({ success: true });
});

const SORT_PRESETS: Record<string, string> = {
  intelligence: 'm.intelligence_rank ASC',
  speed: 'm.speed_rank ASC',
  budget: "CASE m.monthly_token_budget WHEN '~120M' THEN 1 WHEN '~50-100M' THEN 2 WHEN '~30M' THEN 3 WHEN '~18-45M' THEN 4 WHEN '~18M' THEN 5 WHEN '~15M' THEN 6 WHEN '~12M' THEN 7 WHEN '~6M' THEN 8 WHEN '~5-10M' THEN 9 WHEN '~4M' THEN 10 ELSE 11 END ASC",
};

app.post('/api/fallback/sort/:preset', async (c) => {
  const preset = c.req.param('preset');
  const orderBy = SORT_PRESETS[preset];
  if (!orderBy) return c.json({ error: { message: `Unknown preset: ${preset}` } }, 400);

  const db = c.env.DB;
  const { results: models } = await db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}`).all();

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
  for (let i = 0; i < (models as any[]).length; i++) {
    await update.bind(i + 1, (models as any[])[i].id).run();
  }

  return c.json({ success: true, preset });
});

app.get('/api/fallback/token-usage', async (c) => {
  const db = c.env.DB;

  const { results: platforms } = await db.prepare(`SELECT DISTINCT ak.platform FROM api_keys ak WHERE ak.enabled = 1`).all();
  const platformSet = new Set((platforms as any[]).map((p: any) => p.platform));

  const { results: models } = await db.prepare(`
    SELECT m.platform, m.model_id, m.display_name, m.monthly_token_budget, fc.priority
    FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id WHERE m.enabled = 1 ORDER BY fc.priority ASC
  `).all();

  function parseBudget(s: string): number {
    const m = s.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/);
    if (!m) return 0;
    const high = parseFloat(m[2] ?? m[1]);
    const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1;
    return high * unit;
  }

  const modelBudgets = (models as any[])
    .filter((m: any) => platformSet.has(m.platform))
    .map((m: any) => ({ displayName: m.display_name, platform: m.platform, budget: parseBudget(m.monthly_token_budget) }));

  const totalBudget = modelBudgets.reduce((s: number, m: any) => s + m.budget, 0);

  const { results: usage } = await db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_used FROM requests WHERE created_at >= datetime('now', 'start of month')
  `).all();

  return c.json({ totalBudget, totalUsed: (usage as any)[0]?.total_used ?? 0, models: modelBudgets });
});

// --- Analytics routes ---

function getSinceTimestamp(range: string): string {
  const now = Date.now();
  switch (range) {
    case '24h': return new Date(now - 24 * 60 * 60 * 1000).toISOString();
    case '30d': return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    case '7d': default: return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

app.get('/api/analytics/summary', async (c) => {
  const range = c.req.query('range') ?? '7d';
  const since = getSinceTimestamp(range);
  const db = c.env.DB;

  const { results } = await db.prepare(`
    SELECT COUNT(*) as total_requests,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
           SUM(input_tokens) as total_input_tokens,
           SUM(output_tokens) as total_output_tokens,
           AVG(latency_ms) as avg_latency_ms
    FROM requests WHERE created_at >= ?
  `).bind(since).all();

  const stats = (results as any)[0] ?? {};
  const totalRequests = stats.total_requests ?? 0;
  const successRate = totalRequests > 0 ? (stats.success_count / totalRequests) * 100 : 0;
  const inputCost = ((stats.total_input_tokens ?? 0) / 1_000_000) * 3;
  const outputCost = ((stats.total_output_tokens ?? 0) / 1_000_000) * 15;

  return c.json({
    totalRequests,
    successRate: Math.round(successRate * 10) / 10,
    totalInputTokens: stats.total_input_tokens ?? 0,
    totalOutputTokens: stats.total_output_tokens ?? 0,
    avgLatencyMs: Math.round(stats.avg_latency_ms ?? 0),
    estimatedCostSavings: Math.round((inputCost + outputCost) * 100) / 100,
  });
});

app.get('/api/analytics/by-model', async (c) => {
  const range = c.req.query('range') ?? '7d';
  const since = getSinceTimestamp(range);
  const db = c.env.DB;

  const { results } = await db.prepare(`
    SELECT r.platform, r.model_id, m.display_name,
           COUNT(*) as requests,
           SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
           AVG(r.latency_ms) as avg_latency_ms,
           SUM(r.input_tokens) as total_input_tokens,
           SUM(r.output_tokens) as total_output_tokens
    FROM requests r LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ? GROUP BY r.platform, r.model_id ORDER BY requests DESC
  `).bind(since).all();

  return c.json((results as any[]).map((r: any) => ({
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

app.get('/api/analytics/by-platform', async (c) => {
  const range = c.req.query('range') ?? '7d';
  const since = getSinceTimestamp(range);
  const db = c.env.DB;

  const { results } = await db.prepare(`
    SELECT platform, COUNT(*) as requests,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
           AVG(latency_ms) as avg_latency_ms,
           SUM(input_tokens) as total_input_tokens,
           SUM(output_tokens) as total_output_tokens
    FROM requests WHERE created_at >= ? GROUP BY platform ORDER BY requests DESC
  `).bind(since).all();

  return c.json((results as any[]).map((r: any) => ({
    platform: r.platform,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

app.get('/api/analytics/timeline', async (c) => {
  const range = c.req.query('range') ?? '7d';
  const interval = c.req.query('interval') ?? (range === '24h' ? 'hour' : 'day');
  const since = getSinceTimestamp(range);
  const db = c.env.DB;

  const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';

  const { results } = await db.prepare(`
    SELECT strftime('${dateFormat}', created_at) as timestamp,
           COUNT(*) as requests,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failure_count
    FROM requests WHERE created_at >= ?
    GROUP BY strftime('${dateFormat}', created_at) ORDER BY timestamp ASC
  `).bind(since).all();

  return c.json((results as any[]).map((r: any) => ({
    timestamp: r.timestamp,
    requests: r.requests,
    successCount: r.success_count,
    failureCount: r.failure_count,
  })));
});

app.get('/api/analytics/error-distribution', async (c) => {
  const range = c.req.query('range') ?? '7d';
  const since = getSinceTimestamp(range);
  const db = c.env.DB;

  const errorCase = `CASE
    WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
    WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
    WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
    WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
    WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
    WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
    WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
    ELSE 'Other' END`;

  const { results: detailed } = await db.prepare(`
    SELECT platform, model_id, ${errorCase} as error_category, COUNT(*) as count
    FROM requests WHERE status = 'error' AND created_at >= ?
    GROUP BY platform, error_category ORDER BY count DESC
  `).bind(since).all();

  const { results: byCategory } = await db.prepare(`
    SELECT ${errorCase} as category, COUNT(*) as count
    FROM requests WHERE status = 'error' AND created_at >= ?
    GROUP BY category ORDER BY count DESC
  `).bind(since).all();

  const { results: byPlatform } = await db.prepare(`
    SELECT platform, COUNT(*) as count FROM requests
    WHERE status = 'error' AND created_at >= ? GROUP BY platform ORDER BY count DESC
  `).bind(since).all();

  return c.json({ byCategory, byPlatform, detailed });
});

app.get('/api/analytics/errors', async (c) => {
  const range = c.req.query('range') ?? '7d';
  const since = getSinceTimestamp(range);
  const db = c.env.DB;

  const { results } = await db.prepare(`
    SELECT id, platform, model_id, error, latency_ms, created_at
    FROM requests WHERE status = 'error' AND created_at >= ?
    ORDER BY created_at DESC LIMIT 50
  `).bind(since).all();

  return c.json((results as any[]).map((r: any) => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    error: r.error,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  })));
});

// --- Health routes ---

app.get('/api/health', async (c) => {
  const db = c.env.DB;

  const { results: platforms } = await db.prepare(`
    SELECT platform, COUNT(*) as total_keys,
           SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy_keys,
           SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_keys,
           SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid_keys,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_keys,
           SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) as unknown_keys,
           SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_keys
    FROM api_keys GROUP BY platform
  `).all();

  const { results: keys } = await db.prepare(`
    SELECT id, platform, label, status, enabled, created_at, last_checked_at
    FROM api_keys ORDER BY platform, created_at DESC
  `).all();

  return c.json({
    platforms: (platforms as any[]).map((p: any) => ({
      platform: p.platform,
      hasProvider: true,
      totalKeys: p.total_keys,
      healthyKeys: p.healthy_keys,
      rateLimitedKeys: p.rate_limited_keys,
      invalidKeys: p.invalid_keys,
      errorKeys: p.error_keys,
      unknownKeys: p.unknown_keys,
      enabledKeys: p.enabled_keys,
    })),
    keys: (keys as any[]).map((k: any) => ({
      id: k.id,
      platform: k.platform,
      label: k.label,
      status: k.status,
      enabled: k.enabled === 1,
      createdAt: k.created_at,
      lastCheckedAt: k.last_checked_at,
    })),
  });
});

// Check all keys (triggers health checks)
app.post('/api/health/check-all', async (c) => {
  try {
    const db = c.env.DB;
    const { results } = await db.prepare(`
      SELECT id, platform, encrypted_key, iv, auth_tag FROM api_keys WHERE enabled = 1
    `).all();

    const rows = results as any[];
    const checkResults: { keyId: number; platform: string; status: string; debug?: string }[] = [];

    // Process in batches of 5 to avoid hitting Workers CPU limits
    const BATCH_SIZE = 5;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (row) => {
        let apiKey: string;
        try {
          apiKey = await decrypt(db, row.encrypted_key, row.iv, row.auth_tag);
        } catch (e: any) {
          return { keyId: row.id, platform: row.platform, status: 'decrypt_error', debug: e.message };
        }

        try {
          const status = await checkProviderKeyHealth(row.platform, apiKey);
          await db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?").bind(status, row.id).run();
          return { keyId: row.id, platform: row.platform, status };
        } catch (e: any) {
          await db.prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?").bind(row.id).run();
          return { keyId: row.id, platform: row.platform, status: 'check_error', debug: e.message };
        }
      }));
      checkResults.push(...batchResults);
    }

    return c.json({ checked: checkResults.length, results: checkResults });
  } catch (e: any) {
    return c.json({ error: e.message ?? 'Unknown error' }, 500);
  }
});

// Check single key
app.post('/api/health/check/:keyId', async (c) => {
  const keyId = parseInt(c.req.param('keyId'), 10);
  if (isNaN(keyId)) return c.json({ error: { message: 'Invalid key ID' } }, 400);

  const db = c.env.DB;
  const { results } = await db.prepare(
    "SELECT platform, encrypted_key, iv, auth_tag FROM api_keys WHERE id = ?"
  ).bind(keyId).all();

  const row = (results as any[])?.[0];
  if (!row) return c.json({ error: { message: 'Key not found' } }, 404);

  let apiKey: string;
  try {
    apiKey = await decrypt(db, row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return c.json({ keyId, status: 'error' });
  }

  try {
    const status = await checkProviderKeyHealth(row.platform, apiKey);
    await db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?").bind(status, keyId).run();
    return c.json({ keyId, status });
  } catch {
    await db.prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?").run(keyId);
    return c.json({ keyId, status: 'error' });
  }
});

// --- Settings routes ---

// Regenerate key (returns confirmation only, NOT the key)
app.post('/api/settings/api-key/regenerate', async (c) => {
  const db = c.env.DB;
  const newKey = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  await db.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").bind(newKey).run();
  return c.json({ success: true });
});

// --- /v1/chat/completions (Workers AI first, then fallback to external providers) ---

const WORKERS_AI_MODELS: Record<string, string> = {
  'auto': '', // Special: try Workers AI first, then fallback chain
  'llama-3.1-8b-instruct': '@cf/meta/llama-3.1-8b-instruct',
  'llama-3.1-8b-instruct-fast': '@cf/meta/llama-3.1-8b-instruct-fast',
  'llama-3.2-3b-instruct': '@cf/meta/llama-3.2-3b-instruct',
  'llama-3.2-1b-instruct': '@cf/meta/llama-3.2-1b-instruct',
  'gemma-3-12b-it': '@cf/google/gemma-3-12b-it',
  'gemma-4-26b-a4b-it': '@cf/google/gemma-4-26b-a4b-it',
  'qwen3-30b-a3b-fp8': '@cf/qwen/qwen3-30b-a3b-fp8',
  'qwq-32b': '@cf/qwen/qwq-32b',
  'mistral-small-3.1-24b-instruct': '@cf/mistralai/mistral-small-3.1-24b-instruct',
  'gpt-oss-20b': '@cf/openai/gpt-oss-20b',
  'gpt-oss-120b': '@cf/openai/gpt-oss-120b',
  'llama-4-scout-17b-16e-instruct': '@cf/meta/llama-4-scout-17b-16e-instruct',
  'deepseek-r1-distill-qwen-32b': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'glm-4.7-flash': '@cf/zai-org/glm-4.7-flash',
  'kimi-k2.5': '@cf/moonshotai/kimi-k2.5',
  'kimi-k2.6': '@cf/moonshotai/kimi-k2.6',
};

const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

app.post('/v1/chat/completions', async (c) => {
  const start = Date.now();
  const body = await c.req.json();

  const { messages, model: requestedModel, stream = false, temperature, max_tokens, top_p } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({
      error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' },
    }, 400);
  }

  // Try Workers AI first (auto, no model specified, or explicit Workers AI model)
  const isAuto = !requestedModel || requestedModel === 'auto';
  const workersAiModel = isAuto
    ? DEFAULT_WORKERS_AI_MODEL
    : (WORKERS_AI_MODELS[requestedModel] || (requestedModel.startsWith('@cf/') ? requestedModel : null));

  if (workersAiModel) {
    try {
      const aiInput: any = {
        messages,
        stream,
      };
      if (temperature !== undefined) aiInput.temperature = temperature;
      if (max_tokens !== undefined) aiInput.max_tokens = max_tokens;
      if (top_p !== undefined) aiInput.top_p = top_p;

      if (stream) {
        const streamResult = await c.env.AI.run(workersAiModel, aiInput) as ReadableStream;
        return new Response(streamResult, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Routed-Via': `workers-ai/${workersAiModel}`,
          },
        });
      }

      const result = await c.env.AI.run(workersAiModel, aiInput);
      const aiResponse = result as { response?: string };

      const responseText = aiResponse.response ?? '';
      const outputTokens = Math.ceil(responseText.length / 4);
      const inputTokens = messages.reduce((sum: number, m: any) => sum + Math.ceil((m.content || '').length / 4), 0);

      const completion: any = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: workersAiModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: responseText },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
        _routed_via: { platform: 'workers-ai', model: workersAiModel },
      };

      // Log request
      try {
        c.env.DB.prepare(`
          INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error)
          VALUES ('workers-ai', ?, 'success', ?, ?, ?, null)
        `).bind(workersAiModel, inputTokens, outputTokens, Date.now() - start).run();
      } catch {}

      return c.json(completion);
    } catch (aiError: any) {
      // Workers AI failed — fall through to external providers
      console.log(`[Proxy] Workers AI failed: ${aiError.message}, falling back to external providers`);
    }
  }

  // Fallback to external providers via the fallback chain
  const { results: fallbackRows } = await c.env.DB.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE m.enabled = 1 AND fc.enabled = 1
    ORDER BY fc.priority ASC
  `).all();

  const models = fallbackRows as any[];
  let lastError: string | null = null;

  for (const model of models) {
    // Get an enabled key for this platform
    const { results: keyRows } = await c.env.DB.prepare(`
      SELECT id, encrypted_key, iv, auth_tag FROM api_keys
      WHERE platform = ? AND enabled = 1 AND status != 'invalid'
      LIMIT 1
    `).bind(model.platform).all();

    const keyRow = (keyRows as any[])?.[0];
    if (!keyRow) continue;

    let apiKey: string;
    try {
      apiKey = await decrypt(c.env.DB, keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    } catch {
      continue;
    }

    const urlMap: Record<string, string | ((apiKey: string) => string)> = {
      google: (apiKey: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model.model_id}:generateContent?key=${apiKey}`,
      groq: 'https://api.groq.com/openai/v1/chat/completions',
      cerebras: 'https://api.cerebras.ai/v1/chat/completions',
      sambanova: 'https://api.sambanova.ai/v1/chat/completions',
      nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
      mistral: 'https://api.mistral.ai/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
      github: 'https://models.github.ai/inference/chat/completions',
      cohere: 'https://api.cohere.ai/v1/chat',
      cloudflare: (apiKey: string) => `https://api.cloudflare.com/client/v4/accounts/${apiKey.split(':')[0]}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
      zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      ollama: 'https://ollama.com/v1/chat/completions',
      kilo: 'https://api.kilo.ai/api/gateway/v1/chat/completions',
      pollinations: 'https://text.pollinations.ai/openai/v1/chat/completions',
      llm7: 'https://api.llm7.io/v1/chat/completions',
    };

    const urlEntry = urlMap[model.platform];
    if (!urlEntry) continue;

    const url = typeof urlEntry === 'function' ? urlEntry(apiKey) : urlEntry;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (model.platform === 'openrouter') {
      headers['HTTP-Referer'] = 'http://localhost:3001';
      headers['X-Title'] = 'FreeLLMAPI';
    }
    if (!['google', 'cloudflare'].includes(model.platform)) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const requestBody: any = { messages, model: model.model_id };
    if (temperature !== undefined) requestBody.temperature = temperature;
    if (max_tokens !== undefined) requestBody.max_tokens = max_tokens;
    if (top_p !== undefined) requestBody.top_p = top_p;
    if (stream) requestBody.stream = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      if (stream) {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(`${model.platform} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
        }

        return new Response(res.body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Routed-Via': `${model.platform}/${model.model_id}`,
          },
        });
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`${model.platform} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
      }

      const data = await res.json();
      const outputTokens = data.usage?.completion_tokens ?? 0;
      const inputTokens = data.usage?.prompt_tokens ?? 0;

      data._routed_via = { platform: model.platform, model: model.model_id };

      try {
        c.env.DB.prepare(`
          INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error)
          VALUES (?, ?, 'success', ?, ?, ?, null)
        `).bind(model.platform, model.model_id, inputTokens, outputTokens, Date.now() - start).run();
      } catch {}

      return c.json(data);
    } catch (err: any) {
      lastError = err.message;
      try {
        c.env.DB.prepare(`
          INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error)
          VALUES (?, ?, 'error', 0, 0, ?, ?)
        `).bind(model.platform, model.model_id, Date.now() - start, err.message).run();
      } catch {}

      const msg = err.message.toLowerCase();
      if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota') || msg.includes('timeout')) {
        continue; // Try next provider
      }
      // Non-retryable error
      return c.json({
        error: { message: `Provider error (${model.platform}): ${err.message}`, type: 'provider_error' },
      }, 502);
    }
  }

  // All providers failed
  return c.json({
    error: { message: `All models rate-limited or unavailable. Last error: ${lastError}`, type: 'rate_limit_error' },
  }, 429);
});

// OpenAI-compatible /models endpoint
app.get('/v1/models', async (c) => {
  const { results: models } = await c.env.DB.prepare('SELECT platform, model_id, display_name, context_window FROM models WHERE enabled = 1 ORDER BY intelligence_rank').all();

  const workersAiModels = Object.keys(WORKERS_AI_MODELS).map((id, i) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'workers-ai',
    name: id,
    context_window: 128000,
  }));

  const dbModels = (models as any[]).map(m => ({
    id: m.model_id,
    object: 'model',
    created: 0,
    owned_by: m.platform,
    name: m.display_name,
    context_window: m.context_window,
  }));

  return c.json({
    object: 'list',
    data: [...workersAiModels, ...dbModels],
  });
});

// --- SPA catch-all ---

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FreeLLMAPI · Unified LLM Router</title>
    <script type="module" crossorigin src="/assets/index-UiXSxkPQ.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-U9kTidis.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

app.get('*', (c) => {
  return c.html(INDEX_HTML);
});

// --- Health check helpers ---

async function checkProviderKeyHealth(platform: string, apiKey: string): Promise<string> {
  const urlMap: Record<string, string | ((apiKey: string) => string)> = {
    google: (apiKey: string) => `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    groq: 'https://api.groq.com/openai/v1/models',
    cerebras: 'https://api.cerebras.ai/v1/models',
    sambanova: 'https://api.sambanova.ai/v1/models',
    nvidia: 'https://integrate.api.nvidia.com/v1/models',
    mistral: 'https://api.mistral.ai/v1/models',
    openrouter: 'https://openrouter.ai/api/v1/models',
    github: 'https://models.github.ai/inference/models',
    cohere: 'https://api.cohere.ai/v1/models',
    cloudflare: (apiKey: string) => `https://api.cloudflare.com/client/v4/accounts/${apiKey.split(':')[0]}/ai/models`,
    zhipu: 'https://open.bigmodel.cn/api/paas/v4/models',
    ollama: 'https://ollama.com/v1/models',
    kilo: 'https://api.kilo.ai/api/gateway/v1/models',
    pollinations: 'https://text.pollinations.ai/openai/v1/models',
    llm7: 'https://api.llm7.io/v1/models',
  };

  const urlEntry = urlMap[platform];
  if (!urlEntry) return 'unknown';

  const url = typeof urlEntry === 'function' ? urlEntry(apiKey) : urlEntry;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (platform === 'openrouter') {
    headers['HTTP-Referer'] = 'http://localhost:3001';
    headers['X-Title'] = 'FreeLLMAPI';
  }
  if (!['google', 'cloudflare'].includes(platform)) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);

    // Check for Cloudflare WAF challenge (HTML response instead of JSON)
    const contentType = res.headers.get('content-type') || '';
    if (res.status === 403 && contentType.includes('text/html')) {
      // Cloudflare WAF block, not an API key issue
      return 'unknown';
    }

    // Match local behavior: valid key = not 401/403
    // 400/404/500/etc. still mean the key format is accepted
    if (res.status === 401 || res.status === 403) return 'invalid';
    if (res.status === 429) return 'rate_limited';
    if (res.ok) return 'healthy';
    return 'error';
  } catch {
    return 'error';
  }
}

export default app;
