const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[38;2;76;175;125m',   // #4caf7d
  amber: '\x1b[38;2;224;163;38m',   // #e0a326
  red: '\x1b[38;2;224;82;74m',      // #e0524a
  muted: '\x1b[38;2;154;165;177m',  // #9aa5b1
  white: '\x1b[38;2;230;235;240m',
};

const TMUX_COLORS = {
  normal: '#4caf7d',
  warning: '#e0a326',
  critical: '#e0524a',
  unknown: '#9aa5b1',
  amber: '#e0a326',
  muted: '#9aa5b1',
  text: '#e6ebf0',
  pillBg: '#1e222a',
};

function ansiColorFor(severity) {
  switch (severity) {
    case 'critical': return ANSI.red;
    case 'warning': return ANSI.amber;
    case 'normal': return ANSI.green;
    default: return ANSI.muted;
  }
}

function tmuxColorFor(severity) {
  return TMUX_COLORS[severity] || TMUX_COLORS.unknown;
}

export function formatCountdown(iso, nowMs = Date.now(), { compact = false } = {}) {
  if (!iso) return '';
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return '';
  const secs = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const totalHours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const days = Math.floor(totalHours / 24);
  if (days >= 1) {
    const remHours = totalHours % 24;
    return compact ? `${days}d${remHours}h` : `${days}d ${remHours}h`;
  }
  if (totalHours >= 1) {
    const mm = String(mins).padStart(2, '0');
    return compact ? `${totalHours}h${mm}m` : `${totalHours}h ${mm}m`;
  }
  return compact ? `${mins}m` : `${mins}min`;
}

export function formatResetClock(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const target = new Date(iso);
  if (!Number.isFinite(target.getTime())) return '';
  const now = new Date(nowMs);
  const sameDay = target.getFullYear() === now.getFullYear()
    && target.getMonth() === now.getMonth()
    && target.getDate() === now.getDate();
  const hh = String(target.getHours()).padStart(2, '0');
  const mm = String(target.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[target.getDay()]} ${hh}:${mm}`;
}

export function formatTimeHHMM(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function renderBar(percent, width = 8) {
  const clamped = Math.max(0, Math.min(100, percent ?? 0));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function paint(text, code, enabled) {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

export function formatTerminalLine(
  reading,
  _peak,
  { color = true, compact = false, barWidth = 8, nowMs = Date.now() } = {},
) {
  const pct = reading.percent;
  const sevColor = ansiColorFor(reading.severity);
  const label = paint(reading.label || 'ZAI', `${ANSI.bold}${ANSI.white}`, color);

  if (pct == null) {
    const dash = paint('--', ANSI.muted, color);
    const errText = reading.error ? ` (${reading.error})` : '';
    return `${label}  ${dash}${paint(errText, ANSI.muted, color)}`;
  }

  const pctStyle = reading.stale ? `${ANSI.dim}${sevColor}` : `${ANSI.bold}${sevColor}`;
  const pctStr = paint(`${pct}%${reading.stale ? '*' : ''}`, pctStyle, color);

  const cd = formatCountdown(reading.resetsAt, nowMs, { compact: false });
  const clock = formatResetClock(reading.resetsAt, nowMs);
  const sep = paint(' | ', ANSI.muted, color);

  if (compact) {
    const parts = [`${label} ${pctStr}`];
    if (cd) parts.push(paint(cd, ANSI.muted, color));
    return parts.join(sep);
  }

  const bar = paint(renderBar(pct, barWidth), reading.stale ? `${ANSI.dim}${sevColor}` : sevColor, color);
  const segments = [`${label}  ${pctStr}  ${bar}`];
  if (clock && cd) {
    segments.push(paint(`Reset ${clock} (${cd})`, ANSI.muted, color));
  } else if (cd) {
    segments.push(paint(`Reset ${cd}`, ANSI.muted, color));
  }
  if (reading.stale && reading.error) {
    segments.push(paint(`[stale: ${reading.error}]`, ANSI.muted, color));
  }
  return segments.join(sep);
}

/**
 * Format a compact tmux status-bar segment using tmux #[...] style directives.
 * Default style "pill" renders a dark high-contrast badge that stays readable
 * on both tmux's default green status bar and dark custom themes.
 */
export function formatTmuxSegment(
  reading,
  _peak,
  { style = 'pill', showReset = true, nowMs = Date.now() } = {},
) {
  const pct = reading.percent;
  const fg = tmuxColorFor(reading.severity);
  const cd = showReset ? formatCountdown(reading.resetsAt, nowMs, { compact: false }) : '';

  if (style === 'minimal') {
    const val = pct == null ? '--' : `${pct}%${reading.stale ? '*' : ''}`;
    return cd ? `ZAI ${val} | ${cd}` : `ZAI ${val}`;
  }

  const bgPrefix = style === 'pill' ? `bg=${TMUX_COLORS.pillBg},` : '';
  const padL = style === 'pill' ? ' ' : '';
  const padR = style === 'pill' ? ' ' : '';

  if (pct == null) {
    return `#[${bgPrefix}fg=${TMUX_COLORS.muted}]${padL}ZAI  --${padR}#[default]`;
  }

  const pctAttr = reading.stale ? 'dim' : 'bold';
  const parts = [
    `#[${bgPrefix}fg=${TMUX_COLORS.text}]${padL}ZAI  `,
    `#[${bgPrefix}fg=${fg},${pctAttr}]${pct}%${reading.stale ? '*' : ''}#[nobold,nodim]`,
  ];

  if (cd) {
    parts.push(`#[${bgPrefix}fg=${TMUX_COLORS.muted}]  |  ${cd}`);
  }
  if (padR) {
    parts.push(`#[bg=${TMUX_COLORS.pillBg}]${padR}`);
  }
  parts.push('#[default]');
  return parts.join('');
}

/**
 * Render a compact live watch view suitable for a small terminal window or tmux pane.
 */
export function formatWatchPane(
  reading,
  _peak,
  { width = 44, height = 6, color = true, intervalSeconds = 120, nowMs = Date.now() } = {},
) {
  const pct = reading.percent;
  const sevColor = ansiColorFor(reading.severity);
  const label = paint('ZAI', `${ANSI.bold}${ANSI.white}`, color);
  const planSuffix = reading.plan ? paint(` ${reading.plan}`, ANSI.muted, color) : '';

  const cd = formatCountdown(reading.resetsAt, nowMs, { compact: width < 34 });
  const clock = formatResetClock(reading.resetsAt, nowMs);
  const updated = formatTimeHHMM(reading.fetchedAt);

  // Ultra-compact layout for tiny split panes (height <= 3).
  if (height <= 3) {
    const barW = Math.max(4, Math.min(12, width - 14));
    const pctText = pct == null ? paint('--', ANSI.muted, color) : paint(`${pct}%${reading.stale ? '*' : ''}`, `${ANSI.bold}${sevColor}`, color);
    const bar = pct == null ? '' : `  ${paint(renderBar(pct, barW), sevColor, color)}`;
    const line1 = `${label}  ${pctText}${bar}`;
    const meta = [];
    if (cd) meta.push(`Reset ${clock ? `${clock} ` : ''}(${cd})`);
    if (reading.error) meta.push(reading.error);
    const line2 = paint(meta.join('  |  ') || `Updated ${updated}`, ANSI.muted, color);
    return [line1, line2].join('\n');
  }

  const barWidth = Math.max(8, Math.min(24, width - 16));
  const pctText = pct == null
    ? paint('--', ANSI.muted, color)
    : paint(`${String(pct).padStart(3, ' ')}%${reading.stale ? '*' : ''}`, `${ANSI.bold}${sevColor}`, color);
  const bar = pct == null
    ? paint('░'.repeat(barWidth), ANSI.muted, color)
    : paint(renderBar(pct, barWidth), reading.stale ? `${ANSI.dim}${sevColor}` : sevColor, color);

  const lines = [];
  lines.push(`${label}${planSuffix}  ${pctText}  ${bar}`);

  if (clock && cd) {
    lines.push(paint(`Reset  ${clock} (${cd})`, ANSI.muted, color));
  } else if (cd) {
    lines.push(paint(`Reset  ${cd}`, ANSI.muted, color));
  }

  if (reading.error) {
    const prefix = reading.stale ? 'Stale  ' : 'Error  ';
    lines.push(paint(`${prefix}${reading.error}`, ANSI.amber, color));
  }

  if (height >= 5) {
    lines.push('');
    lines.push(paint(`Updated ${updated}  |  every ${intervalSeconds}s  |  [r] refresh  [q] quit`, ANSI.muted, color));
  }

  return lines.join('\n');
}
