// ─── In-memory rate limiter ───────────────────────────────────────────────────
// Resets on server restart — sufficient for demo.
// In production, use a Redis-backed store (e.g. Upstash) for multi-instance support.

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const requestCounts = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig = { maxRequests: 60, windowMs: 60000 }
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = requestCounts.get(identifier);

  if (!entry || now >= entry.resetTime) {
    // First request in this window (or window expired) — start fresh
    requestCounts.set(identifier, { count: 1, resetTime: now + config.windowMs });
    return { allowed: true, remaining: config.maxRequests - 1 };
  }

  if (entry.count >= config.maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  entry.count += 1;
  return { allowed: true, remaining: config.maxRequests - entry.count };
}
