#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TTL_SECONDS } from '../src/cache.js';
import { formatTerminalLine, formatTmuxSegment, formatWatchPane } from '../src/format.js';
import { getPeakState } from '../src/peak.js';
import { getZaiReading } from '../src/providers/zai.js';

const VERSION = '0.1.0';

function parseArgs(argv) {
  const opts = {
    command: 'status',
    json: false,
    refresh: false,
    compact: false,
    color: !process.env.NO_COLOR,
    style: 'pill',
    showReset: true,
    showPeak: true,
    ttl: Number(process.env.AGENT_USAGE_TTL) || DEFAULT_TTL_SECONDS,
    interval: 120,
    help: false,
    version: false,
  };

  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-v' || arg === '--version') {
      opts.version = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '-r' || arg === '--refresh') {
      opts.refresh = true;
    } else if (arg === '-c' || arg === '--compact') {
      opts.compact = true;
    } else if (arg === '--no-color') {
      opts.color = false;
    } else if (arg === '--no-reset') {
      opts.showReset = false;
    } else if (arg === '--no-peak') {
      opts.showPeak = false;
    } else if (arg === '--style' && argv[i + 1]) {
      opts.style = argv[++i];
    } else if (arg === '--ttl' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) opts.ttl = n;
    } else if ((arg === '-i' || arg === '--interval') && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 15) opts.interval = n;
    } else if (arg === '-w' || arg === '--watch') {
      opts.command = 'watch';
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  if (positionals.length > 0) {
    opts.command = positionals[0];
  }
  return opts;
}

function printHelp() {
  const text = `agent-usage-term v${VERSION}
Compact terminal and tmux status-bar monitor for Z.AI coding plan usage.

Usage:
  agent-usage-term [command] [options]

Commands:
  status         Print one compact line for terminal (default)
  tmux           Print a tmux status-bar formatted segment
  watch          Live compact view for a small terminal or tmux pane
  tmux-snippet   Print ~/.tmux.conf lines and live tmux apply command
  iterm2-install Link the iTerm2 AutoLaunch Status Bar extension

Options:
  -c, --compact           Shorter single-line output
  -r, --refresh           Bypass cache and backoff, fetch immediately
  --json                  Output raw JSON (reading + peak)
  --no-color              Disable ANSI colors (also respects NO_COLOR)
  --style <mode>          tmux style: pill (default), plain, minimal
  --no-reset              Hide reset countdown in tmux mode
  --no-peak               Hide 2x peak indicator in tmux mode
  --ttl <sec>             Cache TTL in seconds (default: ${DEFAULT_TTL_SECONDS})
  -i, --interval <sec>    Watch refresh interval in seconds (default: 120, min: 15)
  -h, --help              Show this help
  -v, --version           Show version

Key resolution order:
  1. ZAI_API_KEY env var
  2. ~/.config/agent-usage-term/env
  3. ~/.config/agent-usage-bar/env
  4. ~/projects/code/agent-usage-widget/.env or ~/projects/agent-usage-widget/.env
  5. ANTHROPIC_AUTH_TOKEN when ANTHROPIC_BASE_URL contains z.ai
`;
  process.stdout.write(text);
}

function printTmuxSnippet() {
  const binPath = path.join(os.homedir(), '.local', 'bin', 'agent-usage-term');
  const snippet = `# Add to ~/.tmux.conf:
set -g status-interval 15
set -g status-right-length 80
set -g status-right "#(${binPath} tmux) %H:%M %d-%b"

# Or apply immediately to your running tmux session:
tmux set -g status-interval 15 \\; set -g status-right-length 80 \\; set -g status-right "#(${binPath} tmux) %H:%M %d-%b"
`;
  process.stdout.write(snippet);
}

function installIterm2Extension() {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const sourceScript = path.resolve(thisDir, '..', 'iterm2', 'agent_usage_zai.py');
  const home = os.homedir();
  const autoLaunchDir = path.join(home, 'Library', 'Application Support', 'iTerm2', 'Scripts', 'AutoLaunch');
  const targetScript = path.join(autoLaunchDir, 'agent_usage_zai.py');
  const runtimeDir = path.join(home, 'Library', 'Application Support', 'iTerm2', 'iterm2env');

  fs.mkdirSync(autoLaunchDir, { recursive: true });
  fs.chmodSync(sourceScript, 0o755);
  try {
    fs.unlinkSync(targetScript);
  } catch {
    // Ignore if target does not exist yet.
  }
  fs.symlinkSync(sourceScript, targetScript);

  const hasRuntime = fs.existsSync(runtimeDir);
  process.stdout.write(`Installed iTerm2 AutoLaunch script:\n  ${targetScript} -> ${sourceScript}\n`);
  if (!hasRuntime) {
    process.stdout.write('\nNext steps in iTerm2:\n');
    process.stdout.write('  1. Menu: Scripts -> Manage -> Install Python Runtime\n');
    process.stdout.write('  2. Menu: Scripts -> AutoLaunch -> agent_usage_zai.py (or restart iTerm2)\n');
    process.stdout.write('  3. Settings -> Profiles -> Session -> check "Status bar enabled" -> Configure Status Bar -> drag "Z.AI Usage" onto the bar\n');
  } else {
    process.stdout.write('\nNext steps in iTerm2:\n');
    process.stdout.write('  1. Menu: Scripts -> AutoLaunch -> agent_usage_zai.py (or restart iTerm2)\n');
    process.stdout.write('  2. Settings -> Profiles -> Session -> check "Status bar enabled" -> Configure Status Bar -> drag "Z.AI Usage" onto the bar\n');
  }
}

async function runWatch(opts) {
  const isTTY = Boolean(process.stdout.isTTY);
  let timer = null;
  let polling = false;
  let lastReading = null;

  const draw = () => {
    if (!lastReading) return;
    const width = process.stdout.columns || 44;
    const height = process.stdout.rows || 6;
    const peak = getPeakState(new Date());
    const frame = formatWatchPane(lastReading, peak, {
      width,
      height,
      color: opts.color,
      intervalSeconds: opts.interval,
    });
    if (isTTY) {
      process.stdout.write('\x1b[2J\x1b[H' + frame + '\n');
    } else {
      process.stdout.write(frame + '\n');
    }
  };

  const poll = async (forceRefresh = false) => {
    if (polling) return;
    polling = true;
    try {
      lastReading = await getZaiReading({
        forceRefresh,
        ttlSeconds: opts.ttl,
      });
      draw();
    } finally {
      polling = false;
    }
  };

  const cleanup = () => {
    if (timer) clearInterval(timer);
    if (isTTY) {
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
    }
    process.exit(0);
  };

  if (isTTY) {
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    process.stdout.on('resize', draw);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key) => {
        if (key === 'q' || key === 'Q' || key === '\x03') {
          cleanup();
        } else if (key === 'r' || key === 'R') {
          poll(true);
        }
      });
    }
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await poll(opts.refresh);
  timer = setInterval(() => poll(false), opts.interval * 1000);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (opts.command === 'tmux-snippet') {
    printTmuxSnippet();
    return;
  }
  if (opts.command === 'iterm2-install') {
    installIterm2Extension();
    return;
  }
  if (opts.command === 'watch') {
    await runWatch(opts);
    return;
  }

  const timeoutMs = opts.command === 'tmux' ? 4000 : 8000;
  const reading = await getZaiReading({
    forceRefresh: opts.refresh,
    ttlSeconds: opts.ttl,
    timeoutMs,
  });
  const peak = getPeakState(new Date());

  if (opts.json) {
    process.stdout.write(JSON.stringify({ reading, peak }, null, 2) + '\n');
    return;
  }

  if (opts.command === 'tmux') {
    const out = formatTmuxSegment(reading, peak, {
      style: opts.style,
      showReset: opts.showReset,
      showPeak: opts.showPeak,
    });
    process.stdout.write(out);
    return;
  }

  const line = formatTerminalLine(reading, peak, {
    color: opts.color,
    compact: opts.compact,
  });
  process.stdout.write(line + '\n');
}

main().catch((err) => {
  process.stderr.write(`agent-usage-term error: ${err?.message || err}\n`);
  process.exit(1);
});
