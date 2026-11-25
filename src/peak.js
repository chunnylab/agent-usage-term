// GLM Coding Plan peak-hours schedule (Zhipu / BigModel):
// Peak: Mon-Fri 14:00-18:00 UTC+8 (Beijing), which is 13:00-17:00 UTC+7 (Bangkok).
// Off-peak calls consume 50% credit; peak calls consume full credit (2x off-peak).

const OFFSET_HOURS = 8;
const OFFSET_MS = OFFSET_HOURS * 3600_000;
const WEEKDAYS = [1, 2, 3, 4, 5]; // Mon..Fri
const START_MIN = 14 * 60;
const END_MIN = 18 * 60;

function beijingParts(now) {
  const b = new Date(now.getTime() + OFFSET_MS);
  return {
    day: b.getUTCDay(),
    minutesOfDay: b.getUTCHours() * 60 + b.getUTCMinutes(),
    y: b.getUTCFullYear(),
    mo: b.getUTCMonth(),
    d: b.getUTCDate(),
  };
}

function beijingInstant(y, mo, d, h, mi) {
  return Date.UTC(y, mo, d, h, mi, 0) - OFFSET_MS;
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Compute whether `now` is inside the GLM peak window.
 * Supports CU_PEAK_FORCE=peak|on|off for previewing either state.
 */
export function getPeakState(now = new Date(), env = process.env) {
  const force = (env.CU_PEAK_FORCE || '').toLowerCase();
  if (force === 'peak' || force === 'on') {
    return { active: true, endsAt: toIso(now.getTime() + 2 * 3600_000), nextStartAt: null };
  }
  if (force === 'off') {
    return { active: false, endsAt: null, nextStartAt: toIso(now.getTime() + 3600_000) };
  }

  const p = beijingParts(now);
  const isWeekday = WEEKDAYS.includes(p.day);
  const inPeak = isWeekday && p.minutesOfDay >= START_MIN && p.minutesOfDay < END_MIN;

  if (inPeak) {
    return { active: true, endsAt: toIso(beijingInstant(p.y, p.mo, p.d, 18, 0)), nextStartAt: null };
  }

  for (let add = 0; add <= 7; add++) {
    const ms = beijingInstant(p.y, p.mo, p.d + add, 14, 0);
    const day = new Date(ms).getUTCDay();
    if (WEEKDAYS.includes(day) && ms > now.getTime()) {
      return { active: false, endsAt: null, nextStartAt: toIso(ms) };
    }
  }
  return { active: false, endsAt: null, nextStartAt: null };
}
