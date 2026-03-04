# Session Memory

Converts pi session JSONL files into readable Obsidian-friendly markdown, organized by session with fork-aware segmentation.

## What it does

On every agent turn, converts the current session's JSONL into markdown files split at fork points. Each segment becomes one `.md` file with YAML frontmatter and Obsidian callouts.

- **User messages:** full text (`[!quote]` callout)
- **Assistant responses:** full text (`[!info]` callout)
- **Tool calls:** tool name + key arguments, collapsed (`[!example]` callout)
- **Tool results:** one-line summary, collapsed (`[!note]` callout)

Also generates per-session `_index.md` with a tree view, `_tree.canvas` for sessions with forks, and a top-level `_sessions.md` MOC grouped by project.

Integrates with [session-namer](../session-namer/) — if a session has a name (via `session_info` entries), it's used in the index title, segment frontmatter, and MOC link labels.

## Setup

On first run, the extension prompts for a vault path. Config is saved to `<profile>/session-memory.json` (e.g., `~/.pi/agent-shopify/session-memory.json`).

## Output

```
~/vault/work/pi-sessions/
    _sessions.md                        # MOC: all sessions grouped by project
    raw/
        2026-02-25-7a17aa7d-knowl-edge/
            _index.md                   # session index with tree view
            _tree.canvas                # Obsidian canvas (only if forks)
            001.md                      # root to first fork
            002a.md                     # first child branch (abandoned)
            002b.md                     # second child branch (continued)
            003a.md                     # branch from next fork
            003b.md                     # other branch
```

Each segment file has frontmatter:

```yaml
---
session_id: 7a17aa7d-a056-4ab6-b2f6-d3111e9e4a3b
session_name: "Build session memory extension"
cwd: /Users/you/project
date: 2026-02-25
project: knowl-edge
parent: "[[001]]"
status: active
message_count: 130
tools_used: [bash, edit, grep, read, write]
tags: [session, active]
content_hash: abc123def456
---
```

## Commands

- `/session-memory backfill` — convert all existing sessions in the current profile
- `/session-memory debug` — toggle debug notifications on flush

## Idempotency

Content is hashed per segment. Re-running (or backfill) skips files whose content hasn't changed. Index and canvas use `writeIfChanged`. MOC regenerates on backfill unconditionally, and on live flush when new sessions appear or segments are written (e.g., session name changes).

## Hooks

- `session_start` — load or interactively create config
- `agent_end` — debounced conversion of current session (2s)
- `session_shutdown` — immediate flush
- `session_before_switch` — flush before switching sessions

## Structure

```
extensions/session-memory/
    index.ts              # extension entry: hooks, commands
    lib/
        config.ts         # profile-aware config loading, interactive setup
        jsonl-to-md.ts    # core: parse JSONL tree, write markdown, index, canvas, MOC
        types.ts          # shared interfaces
    README.md
```

The `lib/` directory has zero pi imports — pure Node.js, usable from standalone scripts.
