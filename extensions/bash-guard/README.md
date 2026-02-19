# Bash Guard

Adversarial security review extension for [pi](https://github.com/badlogic/pi-mono). Intercepts bash tool calls and runs parallel security reviews using fast LLM voters before allowing execution.

## How it works

```
LLM calls bash tool
       │
       ▼
  Whitelisted? ──yes──▶ Allow instantly
       │ no
       ▼
  Fire 5 parallel Haiku 4.5 voters
  "Is this command safe? YES or NO"
       │
       ▼
  ┌────────────────────────────┐
  │ Unanimous YES → Allow      │
  │ Unanimous NO  → Block†     │
  │ Split vote    → Block†     │
  └────────────────────────────┘
  † User can override. On-demand explanation
    via main model with full conversation context.
```

## Features

### Voting
- **5 parallel voters** using Claude Haiku 4.5 (configurable)
- **5-second timeout** per voter — timeouts count as abstentions
- **Live vote tracker** UI with real-time dot updates
- **Multi-model support** — round-robin across available models

### Decisions
- **Unanimous YES** → auto-allow with notification
- **Unanimous NO / Split** → bordered markdown dialog with:
  - Command preview
  - Vote icon breakdown
  - On-demand explanation (fetched in background)
  - `y` to allow, `n`/`esc` to block
- **Override warning** — every override is surfaced as a notification
- **Denial reason** — returned to the LLM so it can adjust

### Explainer
- Uses Claude Haiku 4.5 with reasoning disabled (falls back to `ctx.model`)
- Includes last 20 messages of conversation context (user, assistant, thinking, tool calls, tool results)
- Structured XML context for clean prompt boundaries
- Fixed output format:
  - **What it does**
  - **Why it's being run**
  - **Risk**

### Whitelist
Read-only commands bypass the review entirely for zero overhead:
- File inspection: `ls`, `cat`, `head`, `tail`, `wc`, `file`, `stat`, `diff`
- Search: `grep`, `rg`
- Text processing: `cut`, `tr`, `uniq`, `jq`
- Path utilities: `basename`, `dirname`, `realpath`, `readlink`, `cd`
- System info: `pwd`, `whoami`, `date`, `uname`, `id`, `hostname`, `nproc`, `free`, `uptime`, `env`, `printenv`
- Checksums: `md5`/`md5sum`, `sha*sum`
- Other: `echo`, `printf`, `which`, `type`, `du`, `df`, `tree`, `man`, `test`, `[`
- Git (read-only): `status`, `log`, `diff`, `show`, `branch`, `tag`, `remote`, `stash list`, `config --get`

**Disqualifiers** — any of these send the command to voters regardless:
- Pipes (`|`), semicolons (`;`), ampersands (`&`), backticks (`` ` ``), newlines
- Subshells (`$(...)`)
- Redirects (`>`, `>>`)

**Intentionally omitted** from whitelist:
- `find`/`fd` — `-exec`, `-delete` flags
- `awk` — `system()` builtin, internal file I/O
- `sort` — `-o` flag writes to files

## Commands

| Command | Description |
|---|---|
| `/guard` | Toggle guard on/off |
| `/guard on` | Enable guard |
| `/guard off` | Disable guard |
| `/guard debug` | Toggle debug mode |

## Debug Mode

When enabled (`/guard debug`), shows a detailed debug pane on every review:

```
  ┄┄ Debug ┄┄
  #1 haiku-4.5       YES   420ms
  #2 haiku-4.5       NO    380ms
  #3 haiku-4.5       YES   410ms
  #4 haiku-4.5       YES   290ms
  #5 haiku-4.5       YES   310ms
  Avg: haiku-4.5 362ms
```

- Per-voter: model, vote, latency, error message
- Per-model averages with fastest **bolded**
- Unanimous YES with debug: shows full dialog (press any key to continue)

Debug state persists across `/reload`.

## Status Bar

- `🔒 guard` — active
- `🔒 guard 🔍` — active with debug
- `🔓 guard off` — disabled

## Non-interactive Mode

In print mode (`-p`) or JSON mode, the guard:
- Blocks anything that isn't unanimous YES
- Returns a descriptive denial reason to the LLM
- No UI prompts (no user to ask)

## Configuration

Edit `index.ts` constants at the top of the file:

| Constant | Default | Description |
|---|---|---|
| `VOTES_PER_MODEL` | `5` | Number of votes per available model |
| `VOTE_TIMEOUT_MS` | `5000` | Timeout per voter in milliseconds |
| `EXPLAINER_PROVIDER` | `"anthropic"` | Provider for the explainer model |
| `EXPLAINER_MODEL_ID` | `"claude-haiku-4-5"` | Model ID for the explainer |
| `EXPLAINER_CONTEXT_MESSAGES` | `20` | Number of recent messages sent to explainer |

Voter model candidates are defined in `resolveVoterModels()`. Models are resolved through the user's model registry, so proxy configurations and custom API keys are respected automatically.

## Security

- **Not exposed as a tool** — the LLM cannot disable its own sandboxing
- **User-only control** — only `/guard` commands can toggle the guard
- **Override audit trail** — every override is logged as a warning notification
