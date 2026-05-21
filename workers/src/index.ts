import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  DB: D1Database;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
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

// SPA fallback — serve index.html for non-API routes
app.get('*', async (c) => {
  const req = new Request(c.req.url, c.req.raw);
  const assetResponse = await c.env.ASSETS.fetch(req);
  if (assetResponse.status === 200) return assetResponse;
  // Fallback to index.html for SPA routing
  const indexReq = new Request(`${new URL(c.req.url).origin}/index.html`);
  return c.env.ASSETS.fetch(indexReq);
});

export default app;
