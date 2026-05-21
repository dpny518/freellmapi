import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('/api/*', cors());

app.get('/api/ping', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/db-status', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT COUNT(*) as count FROM models').all();
  return c.json({ models: (results as any)[0]?.count ?? 0 });
});

// SPA fallback: try assets first, then fall back to index.html
app.get('*', async (c) => {
  try {
    const assetReq = new Request(c.req.url);
    const assetRes = await c.env.ASSETS.fetch(assetReq);
    if (assetRes.status === 200) return assetRes;
  } catch {
    // Asset fetch failed, fall through to index.html
  }
  // Return index.html for SPA routing
  const url = new URL(c.req.url);
  const indexReq = new Request(`${url.origin}/index.html`);
  return c.env.ASSETS.fetch(indexReq);
});

export default app;
