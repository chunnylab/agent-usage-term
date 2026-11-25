import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TTL_SECONDS = 120;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 900_000;

export function defaultCachePath(homeDir = os.homedir()) {
  return path.join(homeDir, '.cache', 'agent-usage-term', 'zai.json');
}

export function readCache(cachePath = defaultCachePath()) {
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCache(data, cachePath = defaultCachePath()) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, cachePath);
  } catch {
    // Non-fatal: cache write failure should not break terminal output.
  }
}

export function isCacheFresh(entry, ttlSeconds = DEFAULT_TTL_SECONDS, nowMs = Date.now()) {
  if (!entry || typeof entry.fetchedAt !== 'number') return false;
  if (entry.error) return false;
  return nowMs - entry.fetchedAt < ttlSeconds * 1000;
}

export function isBackoffActive(entry, nowMs = Date.now()) {
  return Boolean(entry && typeof entry.backoffUntil === 'number' && entry.backoffUntil > nowMs);
}

export function computeNextBackoff(prevStrikes = 0, retryAfterSeconds = null, nowMs = Date.now()) {
  const strikes = prevStrikes + 1;
  const expMs = Math.min(BACKOFF_BASE_MS * 2 ** (strikes - 1), BACKOFF_CAP_MS);
  const serverMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds * 1000, 3600_000)
    : 0;
  return {
    strikes,
    backoffUntil: nowMs + Math.max(expMs, serverMs),
  };
}
