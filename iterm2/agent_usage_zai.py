#!/usr/bin/env python3
"""
iTerm2 AutoLaunch Status Bar Component for Z.AI Coding Plan usage.
Reads live/cached data from `agent-usage-term --json` so it shares the same
key resolution, 120s cache, 429 backoff, and GLM 2x peak schedule.
"""

import asyncio
import datetime
import html
import json
import os
import shutil

try:
    import iterm2
except ImportError:
    iterm2 = None


COMPONENT_ID = "com.chunny.agent-usage-term.zai"
DEFAULT_BIN = os.path.expanduser("~/.local/bin/agent-usage-term")
EXTRA_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"


def resolve_cli_command(force_refresh=False):
    bin_path = os.environ.get("AGENT_USAGE_TERM_BIN") or DEFAULT_BIN
    if not os.path.exists(bin_path):
        found = shutil.which("agent-usage-term", path=f"{os.path.expanduser('~/.local/bin')}:{EXTRA_PATH}")
        if found:
            bin_path = found
    args = [bin_path, "--json"]
    if force_refresh:
        args.append("--refresh")
    return args


async def fetch_usage_json(force_refresh=False, timeout_sec=8):
    cmd = resolve_cli_command(force_refresh=force_refresh)
    env = dict(os.environ)
    env["PATH"] = f"{os.path.expanduser('~/.local/bin')}:{EXTRA_PATH}:{env.get('PATH', '')}"
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        if proc.returncode != 0:
            err_msg = stderr.decode("utf-8", errors="replace").strip() or f"exit {proc.returncode}"
            return {"reading": {"label": "ZAI", "percent": None, "severity": "unknown", "error": err_msg}, "peak": {"active": False}}
        return json.loads(stdout.decode("utf-8"))
    except Exception as exc:
        return {
            "reading": {"label": "ZAI", "percent": None, "severity": "unknown", "error": str(exc)},
            "peak": {"active": False},
        }


def format_countdown(iso_str, now_dt=None, compact=True):
    if not iso_str:
        return ""
    try:
        target = datetime.datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if now_dt is None:
        now_dt = datetime.datetime.now(datetime.timezone.utc)
    secs = max(0, int((target - now_dt).total_seconds()))
    total_hours = secs // 3600
    mins = (secs % 3600) // 60
    days = total_hours // 24
    if days >= 1:
        rem_h = total_hours % 24
        return f"{days}d{rem_h}h" if compact else f"{days}d {rem_h}h"
    if total_hours >= 1:
        return f"{total_hours}h{mins:02d}m" if compact else f"{total_hours}h {mins:02d}m"
    return f"{mins}m" if compact else f"{mins}min"


def format_local_clock(iso_str, now_local=None):
    if not iso_str:
        return ""
    try:
        target = datetime.datetime.fromisoformat(iso_str.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return ""
    if now_local is None:
        now_local = datetime.datetime.now().astimezone()
    if target.date() == now_local.date():
        return target.strftime("%H:%M")
    return target.strftime("%a %H:%M")


def severity_dot(severity):
    return {
        "normal": "🟢",
        "warning": "🟡",
        "critical": "🔴",
    }.get(severity, "⚪")


def severity_hex(severity):
    return {
        "normal": "#4caf7d",
        "warning": "#e0a326",
        "critical": "#e0524a",
    }.get(severity, "#9aa5b1")


def format_bar_variants(payload, knobs=None, now_dt=None):
    """Return a list of status bar strings from longest to shortest."""
    knobs = knobs or {}
    show_dot = knobs.get("show_dot", True)
    show_reset = knobs.get("show_reset", True)

    reading = payload.get("reading") or {}

    pct = reading.get("percent")
    severity = reading.get("severity", "unknown")
    stale = bool(reading.get("stale"))
    prefix = f"{severity_dot(severity)} " if show_dot else ""

    if pct is None:
        return [f"{prefix}ZAI  --", "ZAI --"]

    pct_str = f"{pct}%{'*' if stale else ''}"
    base = f"{prefix}ZAI  {pct_str}"

    clock = format_local_clock(reading.get("resetsAt")) if show_reset else ""
    cd = format_countdown(reading.get("resetsAt"), now_dt=now_dt, compact=False) if show_reset else ""

    variants = []
    if clock and cd:
        variants.append(f"{base}   |   Reset {clock} ({cd})")
    if cd:
        variants.append(f"{base}   |   {cd}")
    variants.append(base)
    if show_dot:
        variants.append(f"ZAI {pct_str}")

    # Deduplicate preserving order
    seen = set()
    ordered = []
    for item in variants:
        if item not in seen:
            seen.add(item)
            ordered.append(item)
    return ordered


def render_popover_html(payload, now_dt=None):
    reading = payload.get("reading") or {}

    pct = reading.get("percent")
    severity = reading.get("severity", "unknown")
    color = severity_hex(severity)
    plan = reading.get("plan") or ""
    stale = bool(reading.get("stale"))
    error = reading.get("error") or ""

    pct_display = "--" if pct is None else f"{pct}%{'*' if stale else ''}"
    bar_width = 0 if pct is None else max(0, min(100, int(pct)))

    reset_clock = format_local_clock(reading.get("resetsAt"))
    reset_cd = format_countdown(reading.get("resetsAt"), now_dt=now_dt, compact=False)
    if reset_clock and reset_cd:
        reset_line = f"{reset_clock} ({reset_cd})"
    elif reset_cd:
        reset_line = f"in {reset_cd}"
    else:
        reset_line = "Unavailable"

    fetched_ms = reading.get("fetchedAt")
    updated_str = ""
    if isinstance(fetched_ms, (int, float)) and fetched_ms > 0:
        updated_str = datetime.datetime.fromtimestamp(fetched_ms / 1000).strftime("%H:%M:%S")

    err_html = ""
    if error:
        tag = "Stale" if stale else "Error"
        err_html = f'<div class="row err">{tag}: {html.escape(str(error))}</div>'

    plan_badge = f'<span class="plan">{html.escape(str(plan).upper())}</span>' if plan else ""

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {{
    margin: 0;
    padding: 16px 18px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    font-size: 12px;
    color: #e6ebf0;
    background: #1b1f27;
  }}
  .header {{
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 10px;
  }}
  .title {{
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.2px;
  }}
  .plan {{
    margin-left: 6px;
    padding: 1px 5px;
    font-size: 10px;
    border-radius: 4px;
    background: #2b3240;
    color: #9aa5b1;
  }}
  .pct {{
    font-size: 18px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: {color};
  }}
  .track {{
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: #2b3240;
    overflow: hidden;
    margin-bottom: 12px;
  }}
  .fill {{
    height: 100%;
    width: {bar_width}%;
    background: {color};
  }}
  .kv {{
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin: 4px 0;
    line-height: 1.4;
  }}
  .label {{
    color: #9aa5b1;
  }}
  .val {{
    color: #e6ebf0;
    font-variant-numeric: tabular-nums;
  }}
  .err {{
    margin-top: 6px;
    color: #e0524a;
    font-size: 11px;
  }}
  .footer {{
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid #2b3240;
    color: #7d8794;
    font-size: 11px;
  }}
</style>
</head>
<body>
  <div class="header">
    <div class="title">Z.AI Token Quota{plan_badge}</div>
    <div class="pct">{html.escape(pct_display)}</div>
  </div>
  <div class="track"><div class="fill"></div></div>
  <div class="kv">
    <span class="label">Reset time</span>
    <span class="val">{html.escape(reset_line)}</span>
  </div>
  {err_html}
  <div class="footer">Updated {html.escape(updated_str or "just now")} · Click to refresh</div>
</body>
</html>"""


async def main(connection):
    knobs = [
        iterm2.CheckboxKnob("Show severity dot", True, "show_dot"),
        iterm2.CheckboxKnob("Show reset time", True, "show_reset"),
    ]

    component = iterm2.StatusBarComponent(
        short_description="Z.AI Usage",
        detailed_description="Shows Z.AI Coding Plan token quota and reset time. Click to refresh.",
        knobs=knobs,
        exemplar="🟢 ZAI  46%   |   Reset 19:04 (2h 05m)",
        update_cadence=30,
        identifier=COMPONENT_ID,
    )

    @iterm2.RPC
    async def onclick(session_id):
        payload = await fetch_usage_json(force_refresh=True)
        popover_html = render_popover_html(payload)
        await component.async_open_popover(
            session_id,
            popover_html,
            iterm2.util.Size(310, 145),
        )

    @iterm2.StatusBarRPC
    async def coro(knobs):
        payload = await fetch_usage_json(force_refresh=False)
        return format_bar_variants(payload, knobs=knobs)

    await component.async_register(connection, coro, onclick=onclick)


if __name__ == "__main__":
    if iterm2 is None:
        raise SystemExit("iterm2 Python module is not available in this interpreter. Run inside iTerm2 Python Runtime.")
    iterm2.run_forever(main)
