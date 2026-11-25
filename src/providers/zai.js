import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_TTL_SECONDS,
  computeNextBackoff,
  defaultCachePath,
  isBackoffActive,
  isCacheFresh,
  readCache,
  writeCache,
} from '../cache.js';

export const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

export function severityFor(percent) {
  if (percent == null) return 'unknown';
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warning';
  return 'normal';
}

export function parseEnvFileForKey(filePath, keyName = 'ZAI_API_KEY') {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const re = new RegExp(`^\\s*${keyName}\\s*=\\s*(.+?)\\s*$`, 'm');
  const match = raw.match(re);
  if (!match) return null;
  const value = match[1].trim().replace(/^["']|["']$/g, '');
  return value || null;
}

/**
 * Resolve ZAI_API_KEY in priority order:
 * 1. ZAI_API_KEY environment variable
 * 2. ~/.config/agent-usage-term/env
 * 3. ~/.config/agent-usage-bar/env
 * 4. local widget .env files
 * 5. ANTHROPIC_AUTH_TOKEN when ANTHROPIC_BASE_URL points to z.ai
 */
export function resolveZaiKey({ env = process.env, homeDir = os.homedir(), extraEnvPaths = [] } = {}) {
  const fromEnv = (env.ZAI_API_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env:ZAI_API_KEY' };

  const candidates = [
    ...extraEnvPaths,
    path.join(homeDir, '.config', 'agent-usage-term', 'env'),
    path.join(homeDir, '.config', 'agent-usage-bar', 'env'),
    path.join(homeDir, 'projects', 'code', 'agent-usage-widget', '.env'),
    path.join(homeDir, 'projects', 'agent-usage-widget', '.env'),
  ];

  for (const filePath of candidates) {
    const found = parseEnvFileForKey(filePath);
    if (found) return { key: found, source: filePath };
  }

  const relayToken = (env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const relayBase = (env.ANTHROPIC_BASE_URL || '').trim();
  if (relayToken && relayBase.includes('z.ai')) {
    return { key: relayToken, source: 'env:ANTHROPIC_AUTH_TOKEN' };
  }

  return { key: null, source: null };
}

export function parseRetryAfter(raw, nowMs = Date.now()) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum)) return asNum > 0 ? asNum : null;
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const deltaSec = (parsedDate - nowMs) / 1000;
    return deltaSec > 0 ? deltaSec : null;
  }
  return null;
}

export function normalizeZaiPayload(body, nowMs = Date.now()) {
  if (body && typeof body.code === 'number' && body.code !== 200) {
    const err = new Error(body.msg || `Z.AI error ${body.code}`);
    err.zaiCode = body.code;
    throw err;
  }
  const data = (body && body.data) || {};
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const tokens = limits.find((item) => item && item.type === 'TOKENS_LIMIT');
  if (!tokens) {
    throw new Error('no TOKENS_LIMIT in response');
  }
  const rawPct = typeof tokens.percentage === 'number' ? tokens.percentage : 0;
  const percent = Math.round(rawPct);
  const resetsAt = typeof tokens.nextResetTime === 'number' && tokens.nextResetTime > 0
    ? new Date(tokens.nextResetTime).toISOString()
    : null;

  return {
    provider: 'zai',
    label: 'ZAI',
    plan: data.level || null,
    percent,
    severity: severityFor(percent),
    resetsAt,
    fetchedAt: nowMs,
    stale: false,
    error: null,
  };
}

export async function fetchZaiRaw(key, { fetchImpl = fetch, timeoutMs = 8000, nowMs = Date.now() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(ZAI_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      let snippet = '';
      try {
        snippet = (await res.text()).trim().slice(0, 160);
      } catch {
        // Ignore body read error.
      }
      const err = new Error(`HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
      err.status = res.status;
      err.retryAfter = parseRetryAfter(res.headers.get('retry-after'), nowMs);
      throw err;
    }

    const body = await res.json();
    return normalizeZaiPayload(body, nowMs);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch Z.AI reading with cache, 429 backoff, and stale last-known-good fallback.
 */
export async function getZaiReading({
  forceRefresh = false,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  cachePath = defaultCachePath(),
  env = process.env,
  homeDir = os.homedir(),
  fetchImpl = fetch,
  timeoutMs = 8000,
  nowMs = Date.now(),
} = {}) {
  const cached = readCache(cachePath);
  const { key, source } = resolveZaiKey({ env, homeDir });

  if (!key) {
    return {
      provider: 'zai',
      label: 'ZAI',
      plan: null,
      percent: null,
      severity: 'unknown',
      resetsAt: null,
      fetchedAt: nowMs,
      stale: false,
      fromCache: false,
      keySource: null,
      error: 'no key: set ZAI_API_KEY or ~/.config/agent-usage-bar/env',
    };
  }

  if (!forceRefresh && isCacheFresh(cached, ttlSeconds, nowMs)) {
    return { ...cached, fromCache: true, stale: false, keySource: source };
  }

  if (!forceRefresh && isBackoffActive(cached, nowMs)) {
    const waitSec = Math.max(1, Math.ceil((cached.backoffUntil - nowMs) / 1000));
    return {
      provider: 'zai',
      label: 'ZAI',
      plan: cached.plan ?? null,
      percent: cached.percent ?? null,
      severity: severityFor(cached.percent ?? null),
      resetsAt: cached.resetsAt ?? null,
      fetchedAt: cached.fetchedAt ?? nowMs,
      backoffUntil: cached.backoffUntil,
      strikes: cached.strikes ?? 1,
      stale: cached.percent != null,
      fromCache: true,
      keySource: source,
      error: `rate limited (retry in ${waitSec}s)`,
    };
  }

  try {
    const reading = await fetchZaiRaw(key, { fetchImpl, timeoutMs, nowMs });
    const stored = {
      ...reading,
      backoffUntil: null,
      strikes: 0,
    };
    writeCache(stored, cachePath);
    return { ...stored, fromCache: false, keySource: source };
  } catch (err) {
    const is429 = err && err.status === 429;
    const backoff = is429
      ? computeNextBackoff(cached?.strikes || 0, err.retryAfter, nowMs)
      : { strikes: cached?.strikes || 0, backoffUntil: cached?.backoffUntil || null };

    const message = err?.name === 'AbortError'
      ? `request timed out (${Math.round(timeoutMs / 1000)}s)`
      : (err?.message || String(err));

    const fallback = {
      provider: 'zai',
      label: 'ZAI',
      plan: cached?.plan ?? null,
      percent: cached?.percent ?? null,
      severity: severityFor(cached?.percent ?? null),
      resetsAt: cached?.resetsAt ?? null,
      fetchedAt: cached?.fetchedAt ?? nowMs,
      backoffUntil: backoff.backoffUntil,
      strikes: backoff.strikes,
      stale: cached?.percent != null,
      error: message,
    };
    writeCache(fallback, cachePath);
    return { ...fallback, fromCache: false, keySource: source };
  }
}
