import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform, KeyStatus, ChatMessage } from '@freellmapi/shared/types.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 1000;

/**
 * Track consecutive failures per key
 */
const failureCount = new Map<number, number>();
const lastAttempt = new Map<number, number>();

/**
 * Generate exponential backoff delay
 */
function getDelay(attempt: number): number {
  return BASE_RETRY_MS * Math.pow(2, attempt);
}

/**
 * Logger with timestamp
 */
function logger(keyId: number, msg: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [Health][Key${keyId}] ${msg}`);
}

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const db = getDb();
  const keyRow = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!keyRow) return 'error';

  const provider = getProvider(keyRow.platform as Platform);
  if (!provider) return 'error';

  // Skip if already attempted recently and failing
  const now = Date.now();
  const lastTime = lastAttempt.get(keyId) || 0;
  if (now - lastTime < 60 * 1000) { // 1 minute cooldown
    logger(keyId, 'Skipping rapid retry');
    return keyRow.status || 'healthy';
  }
  lastAttempt.set(keyId, now);

  try {
    logger(keyId, 'Starting health validation');
    const encryptedKey = keyRow.encrypted_key;
    const iv = keyRow.iv;
    const authTag = keyRow.auth_tag;
    const apiKey = decrypt(encryptedKey, iv, authTag);

    // 1. Quick key format validation
    const isValid = await provider.validateKey(apiKey);
    if (!isValid) {
      logger(keyId, 'Key validation failed (invalid signature/format)');
      db.prepare('UPDATE api_keys SET status = ?, last_checked_at = datetime(\'now\') WHERE id = ?')
        .run('invalid', keyId);
      return 'invalid';
    }

    // 2. Real health test with retries
    const testMessage: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    let testResponse = undefined;

    // Find the highest-priority enabled model for this platform to use as a probe
    const modelRow = db.prepare(
      'SELECT model_id FROM models WHERE platform = ? AND enabled = 1 ORDER BY intelligence_rank ASC LIMIT 1'
    ).get(keyRow.platform) as { model_id: string } | undefined;
    const modelId = modelRow?.model_id || 'gpt-4o-mini';

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        logger(keyId, `Attempt ${attempt + 1} - sending 'hello' to ${keyRow.platform}/${modelId}`);
        testResponse = await provider.chatCompletion(
          apiKey,
          testMessage,
          modelId
        );

        logger(keyId, `Provider responded (attempt ${attempt + 1})`);
        break; // Success, exit retry loop
      } catch (err: any) {
        logger(keyId, `Attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < MAX_RETRIES - 1) {
          const delay = getDelay(attempt);
          logger(keyId, `Waiting ${delay}ms before retry`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw err; // Re-throw on final attempt
        }
      }
    }

    // 3. Validate response structure
    if (testResponse?.choices && testResponse.choices.length > 0) {
      const choice = testResponse.choices[0].message?.content;
      if (choice && choice.trim().length > 0) {
        logger(keyId, `Health check passed: ${choice.substring(0, 30)}`);
        db.prepare('UPDATE api_keys SET status = ?, last_checked_at = datetime(\'now\') WHERE id = ?')
          .run('healthy', keyId);
        failureCount.delete(keyId);
        return 'healthy';
      } else {
        logger(keyId, 'Empty response content');
        const status: KeyStatus = 'error';
        db.prepare('UPDATE api_keys SET status = ?, last_checked_at = datetime(\'now\') WHERE id = ?')
          .run(status, keyId);
        return 'error';
      }
    } else {
      logger(keyId, 'Missing choices in provider response');
      const status: KeyStatus = 'error';
      db.prepare('UPDATE api_keys SET status = ?, last_checked_at = datetime(\'now\') WHERE id = ?')
        .run(status, keyId);
      return 'error';
    }

  } catch (err: any) {
    // 4. Transport/network errors
    logger(keyId, `Transport error: ${err.message}`);
    const msg = String(err.message ?? err).toLowerCase();
    // Quota/rate-limit errors should be rate_limited, not error
    if (msg.includes('quota exceeded') || msg.includes('rate limit') || msg.includes('resource_exhausted')) {
      db.prepare('UPDATE api_keys SET status = ?, last_checked_at = datetime(\'now\') WHERE id = ?')
        .run('rate_limited', keyId);
      return 'rate_limited';
    }
    db.prepare('UPDATE api_keys SET status = ?, last_checked_at = datetime(\'now\') WHERE id = ?')
      .run('error', keyId);
    return 'error';
  }
}

export async function checkAllKeys(): Promise<{ id: number; status: KeyStatus }[]> {
  const db = getDb();
  const keys = db.prepare('SELECT id, platform FROM api_keys WHERE enabled = 1').all() as { id: number; platform: string }[];

  logger(0, `Checking ${keys.length} keys`);
  const results: { id: number; status: KeyStatus }[] = [];
  for (const key of keys) {
    const status = await checkKeyHealth(key.id);
    results.push({ id: key.id, status });
  }
  logger(0, 'Check complete');
  return results;
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startHealthChecker(): void {
  if (intervalId) return;
  logger(0, `Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);
  intervalId = setInterval(() => {
    checkAllKeys().catch(err => logger(0, `Check failed: ${err.message}`));
  }, CHECK_INTERVAL_MS);
}

export function stopHealthChecker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}