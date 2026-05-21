import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { getProvider, hasProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform } from '@freellmapi/shared/types.js';

export const modelsRouter = Router();

// List all models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all() as any[];

  // Count keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map(m => ({
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
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});

// Discover live models from a provider's API
modelsRouter.get('/discover/:platform', async (req: Request, res: Response) => {
  const platform = req.params.platform as Platform;
  if (!hasProvider(platform)) {
    res.status(400).json({ error: { message: `Unknown platform: ${platform}` } });
    return;
  }

  const provider = getProvider(platform);
  if (!provider) {
    res.status(400).json({ error: { message: `No provider registered for: ${platform}` } });
    return;
  }

  const db = getDb();
  const keyRow = db.prepare(`
    SELECT encrypted_key, iv, auth_tag FROM api_keys
    WHERE platform = ? AND enabled = 1 ORDER BY id LIMIT 1
  `).get(platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;

  if (!keyRow) {
    res.status(404).json({ error: { message: `No enabled API key found for ${platform}` } });
    return;
  }

  let apiKey: string;
  try {
    apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  } catch {
    res.status(500).json({ error: { message: 'Failed to decrypt API key' } });
    return;
  }

  try {
    const models = await provider.listModels(apiKey);
    res.json({ platform, count: models.length, models });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message ?? 'Failed to fetch models' } });
  }
});
