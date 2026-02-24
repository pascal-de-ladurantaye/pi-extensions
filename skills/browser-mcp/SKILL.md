---
name: browser-mcp
description: Automates the user's real Chrome browser via the Browser MCP Chrome extension. Uses the user's logged-in sessions and real browser fingerprint to avoid bot detection. Use when the user needs to browse websites, fill forms, scrape data, or test web pages using their actual browser profile.
allowed-tools: Bash(browser-mcp:*)
---

# Browser Automation with Browser MCP

Control the user's real Chrome browser through the [Browser MCP](https://browsermcp.io) Chrome extension. Unlike headless browsers, this uses the user's actual browser profile — logged-in sessions, cookies, and real fingerprint.

## Prerequisites

1. Install the [Browser MCP Chrome extension](https://browsermcp.io)
2. On the target tab, click the extension icon → **Connect**

## Setup

Install dependencies (only needed once):

```bash
cd scripts && npm install
```

The CLI is at `scripts/browser-mcp` relative to this SKILL.md. Use the full path for all commands:

```
browser-mcp = <skill-directory>/scripts/browser-mcp
```

## Quick start

```bash
# start the daemon (once per session)
browser-mcp start
# navigate to a page
browser-mcp navigate https://example.com
# get accessibility snapshot with element refs
browser-mcp snapshot
# interact using refs from the snapshot
browser-mcp click "Submit button" ref1
browser-mcp type "Search input" ref2 "search query"
# take a screenshot
browser-mcp screenshot
# stop when done
browser-mcp stop
```

## Commands

### Lifecycle

```bash
browser-mcp start
browser-mcp stop
browser-mcp status
```

### Navigation

```bash
browser-mcp navigate https://example.com
browser-mcp go-back
browser-mcp go-forward
```

### Page State

```bash
browser-mcp snapshot
browser-mcp screenshot
browser-mcp screenshot --filename=result.png
```

### Interaction

All interaction commands take an `<element>` description (human-readable) and a `<ref>` (exact reference from the snapshot).

```bash
browser-mcp click "Submit button" ref1
browser-mcp type "Email input" ref2 "user@example.com"
browser-mcp type "Search box" ref3 "query" --submit
browser-mcp hover "Menu item" ref4
browser-mcp select "Country dropdown" ref5 "Canada"
browser-mcp select "Tags" ref6 "option1" "option2"
browser-mcp drag "Card" ref7 "Drop zone" ref8
```

### Keyboard

```bash
browser-mcp press-key Enter
browser-mcp press-key ArrowDown
browser-mcp press-key Tab
```

### Utility

```bash
browser-mcp wait 2
browser-mcp console
```

## Snapshots

After navigation and interaction commands, a snapshot of the page is captured automatically. The snapshot includes:

- **Page URL** and **Title**
- **ARIA accessibility tree** saved as a YAML file in `/tmp/browser-mcp/`

The YAML snapshot contains element references (like `ref1`, `ref2`) that you use in interaction commands. Always read the snapshot file to find the correct refs before interacting.

```bash
> browser-mcp navigate https://example.com
- Page URL: https://example.com/
- Page Title: Example Domain
- Page Snapshot: /tmp/browser-mcp/snapshot-2026-02-24T16-30-00-000Z.yaml
```

Use `read` on the snapshot file to see the full accessibility tree and element refs.

For more details on reading and using ARIA snapshots, see [references/aria-snapshots.md](references/aria-snapshots.md).

## Example: Form submission

```bash
browser-mcp start
browser-mcp navigate https://example.com/login
browser-mcp snapshot
# read the snapshot to find refs
browser-mcp type "Username" ref1 "myuser"
browser-mcp type "Password" ref2 "mypass" --submit
browser-mcp snapshot
browser-mcp stop
```

## Example: Multi-step workflow

```bash
browser-mcp start
browser-mcp navigate https://shop.example.com
browser-mcp snapshot
browser-mcp click "Search" ref1
browser-mcp type "Search input" ref2 "wireless keyboard" --submit
browser-mcp snapshot
# read snapshot, find first result
browser-mcp click "Wireless Keyboard Pro" ref5
browser-mcp snapshot
browser-mcp click "Add to Cart" ref12
browser-mcp stop
```

## Example: Data extraction

```bash
browser-mcp start
browser-mcp navigate https://dashboard.example.com
browser-mcp snapshot
# read the snapshot file to extract table data, metrics, etc.
browser-mcp screenshot --filename=dashboard.png
browser-mcp stop
```

## Troubleshooting

- **"Daemon not running"** → Run `browser-mcp start`
- **"No browser extension connected"** → Open Chrome, click the Browser MCP extension icon, press Connect
- **"Timeout waiting for response"** → The page may be loading slowly; try `browser-mcp wait 3` then retry
- **Port 9009 in use** → Another process is on the WebSocket port. Stop it or check `lsof -i :9009`
- **Daemon logs** → Check `/tmp/browser-mcp.log`
