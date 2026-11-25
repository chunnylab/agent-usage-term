import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  formatCountdown,
  formatTerminalLine,
  formatTmuxSegment,
  formatWatchPane,
  renderBar,
} from '../src/format.js';
import { getPeakState } from '../src/peak.js';
import {
  getZaiReading,
  normalizeZaiPayload,
  parseRetryAfter,
  resolveZaiKey,
  severityFor,
} from '../src/providers/zai.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-usage-term-test-'));
}

describe('Z.AI key resolution', () => {
  it('prefers ZAI_API_KEY env var over files', () => {
    const tmp = makeTmpDir();
    const envFile = path.join(tmp, '.config', 'agent-usage-bar', 'env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, 'ZAI_API_KEY=from-file\n');

    const res = resolveZaiKey({ env: { ZAI_API_KEY: 'from-env' }, homeDir: tmp });
    assert.equal(res.key, 'from-env');
    assert.equal(res.source, 'env:ZAI_API_KEY');
  });

  it('falls back to ~/.config/agent-usage-bar/env and strips quotes', () => {
    const tmp = makeTmpDir();
    const envFile = path.join(tmp, '.config', 'agent-usage-bar', 'env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, 'ZAI_API_KEY="sk-bar-123"\n');

    const res = resolveZaiKey({ env: {}, homeDir: tmp });
    assert.equal(res.key, 'sk-bar-123');
    assert.equal(res.source, envFile);
  });

  it('uses ANTHROPIC_AUTH_TOKEN when ANTHROPIC_BASE_URL points at z.ai', () => {
    const tmp = makeTmpDir();
    const res = resolveZaiKey({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'relay-key-999',
      },
      homeDir: tmp,
    });
    assert.equal(res.key, 'relay-key-999');
    assert.equal(res.source, 'env:ANTHROPIC_AUTH_TOKEN');
  });
});

describe('Z.AI normalization and severity', () => {
  it('maps severity thresholds consistently', () => {
    assert.equal(severityFor(0), 'normal');
    assert.equal(severityFor(69), 'normal');
    assert.equal(severityFor(70), 'warning');
    assert.equal(severityFor(89), 'warning');
    assert.equal(severityFor(90), 'critical');
    assert.equal(severityFor(null), 'unknown');
  });

  it('normalizes TOKENS_LIMIT payload', () => {
    const resetMs = Date.UTC(2026, 10, 25, 11, 0, 0);
    const reading = normalizeZaiPayload({
      code: 200,
      data: {
        level: 'Pro',
        limits: [
          { type: 'OTHER', percentage: 10 },
          { type: 'TOKENS_LIMIT', percentage: 73.6, nextResetTime: resetMs },
        ],
      },
    }, Date.UTC(2026, 10, 25, 8, 0, 0));

    assert.equal(reading.percent, 74);
    assert.equal(reading.severity, 'warning');
    assert.equal(reading.plan, 'Pro');
    assert.equal(reading.resetsAt, new Date(resetMs).toISOString());
    assert.equal(reading.stale, false);
  });

  it('throws on non-200 Z.AI error code', () => {
    assert.throws(() => normalizeZaiPayload({ code: 1001, msg: 'invalid key' }), /invalid key/);
  });

  it('parses Retry-After seconds and ignores 0', () => {
    assert.equal(parseRetryAfter('120'), 120);
    assert.equal(parseRetryAfter('0'), null);
    assert.equal(parseRetryAfter(null), null);
  });
});

describe('Z.AI cache, backoff, and stale fallback', () => {
  it('caches fresh response and keeps stale value on 429', async () => {
    const tmp = makeTmpDir();
    const cachePath = path.join(tmp, 'zai.json');
    let calls = 0;

    const okFetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          code: 200,
          data: {
            level: 'Coding',
            limits: [{ type: 'TOKENS_LIMIT', percentage: 42, nextResetTime: 2_000_000_000_000 }],
          },
        }),
      };
    };

    const t0 = 1_700_000_000_000;
    const first = await getZaiReading({
      env: { ZAI_API_KEY: 'test-key' },
      homeDir: tmp,
      cachePath,
      fetchImpl: okFetch,
      ttlSeconds: 120,
      nowMs: t0,
    });
    assert.equal(first.percent, 42);
    assert.equal(first.fromCache, false);
    assert.equal(calls, 1);

    // Within TTL: should not call network.
    const second = await getZaiReading({
      env: { ZAI_API_KEY: 'test-key' },
      homeDir: tmp,
      cachePath,
      fetchImpl: okFetch,
      ttlSeconds: 120,
      nowMs: t0 + 30_000,
    });
    assert.equal(second.percent, 42);
    assert.equal(second.fromCache, true);
    assert.equal(calls, 1);

    // After TTL expires, simulate 429 -> should retain stale 42% and set backoff.
    const rateLimitedFetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '90' }),
        text: async () => 'too many requests',
      };
    };

    const t1 = t0 + 180_000;
    const third = await getZaiReading({
      env: { ZAI_API_KEY: 'test-key' },
      homeDir: tmp,
      cachePath,
      fetchImpl: rateLimitedFetch,
      ttlSeconds: 120,
      nowMs: t1,
    });
    assert.equal(third.percent, 42);
    assert.equal(third.stale, true);
    assert.match(third.error, /HTTP 429/);
    assert.equal(calls, 2);

    // During backoff: should skip network and return cached stale value.
    const fourth = await getZaiReading({
      env: { ZAI_API_KEY: 'test-key' },
      homeDir: tmp,
      cachePath,
      fetchImpl: rateLimitedFetch,
      ttlSeconds: 120,
      nowMs: t1 + 10_000,
    });
    assert.equal(fourth.percent, 42);
    assert.equal(fourth.stale, true);
    assert.equal(fourth.fromCache, true);
    assert.match(fourth.error, /rate limited/);
    assert.equal(calls, 2);
  });
});

describe('Peak hours', () => {
  it('detects weekday peak (14:00-18:00 UTC+8) and off-peak', () => {
    // 2026-11-25 is Wednesday. 15:00 UTC+7 = 16:00 UTC+8 (in peak).
    const inPeak = getPeakState(new Date('2026-11-25T08:00:00Z'), {});
    assert.equal(inPeak.active, true);
    assert.equal(inPeak.endsAt, '2026-11-25T10:00:00.000Z');

    // 19:00 UTC+8 = 11:00 UTC (off peak).
    const offPeak = getPeakState(new Date('2026-11-25T11:00:00Z'), {});
    assert.equal(offPeak.active, false);
    assert.equal(offPeak.nextStartAt, '2026-11-26T06:00:00.000Z');
  });

  it('supports CU_PEAK_FORCE override', () => {
    const forced = getPeakState(new Date('2026-11-25T11:00:00Z'), { CU_PEAK_FORCE: 'peak' });
    assert.equal(forced.active, true);
  });
});

describe('Formatters', () => {
  const nowMs = Date.UTC(2026, 10, 25, 8, 0, 0);
  const reading = {
    label: 'ZAI',
    plan: 'Pro',
    percent: 46,
    severity: 'normal',
    resetsAt: new Date(nowMs + 2 * 3600_000 + 5 * 60_000).toISOString(),
    fetchedAt: nowMs,
    stale: false,
    error: null,
  };
  const activePeak = {
    active: true,
    endsAt: new Date(nowMs + 90 * 60_000).toISOString(),
    nextStartAt: null,
  };

  it('formats countdowns and bars', () => {
    assert.equal(formatCountdown(reading.resetsAt, nowMs), '2h 05m');
    assert.equal(formatCountdown(reading.resetsAt, nowMs, { compact: true }), '2h05m');
    assert.equal(renderBar(50, 8), '████░░░░');
  });

  it('formats terminal line in normal and compact modes without 2x', () => {
    const full = formatTerminalLine(reading, activePeak, { color: false, nowMs });
    assert.match(full, /ZAI\s+46%/);
    assert.match(full, /Reset .* \(2h 05m\)/);
    assert.doesNotMatch(full, /2x|PEAK/);

    const compact = formatTerminalLine(reading, activePeak, { color: false, compact: true, nowMs });
    assert.equal(compact, 'ZAI 46% | 2h 05m');
  });

  it('formats tmux pill, plain, and minimal segments without 2x', () => {
    const pill = formatTmuxSegment(reading, activePeak, { style: 'pill', nowMs });
    assert.match(pill, /bg=#1e222a/);
    assert.match(pill, /fg=#4caf7d,bold]46%/);
    assert.match(pill, /2h 05m/);
    assert.doesNotMatch(pill, /2x/);

    const minimal = formatTmuxSegment(reading, activePeak, { style: 'minimal', nowMs });
    assert.equal(minimal, 'ZAI 46% | 2h 05m');
  });

  it('formats compact watch pane for tiny height without 2x', () => {
    const tiny = formatWatchPane(reading, activePeak, { width: 32, height: 3, color: false, nowMs });
    const lines = tiny.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /ZAI  46%/);
    assert.match(lines[1], /Reset/);
    assert.doesNotMatch(tiny, /2x/);
  });
});
