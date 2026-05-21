import crypto from 'crypto';
import { getDb, getUnifiedApiKey } from '../db/index.js';

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Auth middleware for Express. Validates the unified API key from
 * the Authorization header. Skips /api/ping (health check).
 */
export function authMiddleware(req: any, res: any, next: any) {
  // Skip health check
  if (req.path === '/api/ping') return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { message: 'Authentication required', type: 'authentication_error' },
    });
  }

  const token = authHeader.slice(7);
  const unifiedKey = getUnifiedApiKey();

  if (!unifiedKey || !timingSafeEqual(token, unifiedKey)) {
    return res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
  }

  next();
}
