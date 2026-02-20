# Pi Extensions Repo

This repository contains custom extensions for pi, the coding agent.

## Structure

Extensions live in the `extensions/` directory. Each is a folder with an `index.ts` entry point and a `README.md`. Extensions can include additional source files, a `package.json` with dependencies, and whatever structure makes sense for the complexity of the extension.

When building or modifying extensions, always read pi's extension documentation first.

## Development Guidelines

- Extensions are TypeScript modules loaded via jiti (no compilation needed)
- Import types from `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui`
- Use `@sinclair/typebox` for tool parameter schemas
- npm dependencies are supported — add a `package.json`, run `npm install`, and imports resolve automatically
- Node.js built-ins (`node:fs`, `node:path`, `node:child_process`, etc.) are available
- Test with `/reload` — extensions in auto-discovered locations hot-reload
- After making changes, run `./install.sh` to symlink into all `~/.pi/*/extensions/` profiles

## Key APIs

- `pi.on("tool_call", ...)` — intercept tool calls (can block)
- `pi.on("tool_result", ...)` — modify tool results
- `pi.registerTool(...)` — register custom tools
- `pi.registerCommand(...)` — register `/commands`
- `pi.appendEntry(...)` — persist state in the session tree
- `ctx.ui.custom(...)` — custom TUI components
- `ctx.ui.confirm/select/notify(...)` — user interaction
- `ctx.sessionManager` — read session entries, tree, leaf
- `ctx.modelRegistry.find(provider, id)` — find models through user's registry
- `ctx.modelRegistry.getApiKey(model)` — get API keys respecting user's config
- `complete(model, context, options)` from `@mariozechner/pi-ai` — direct LLM calls

## Existing Extensions

- **bash-guard** — Adversarial security review for bash commands using parallel LLM voters
- **hashline** — Content-anchored line editing — overrides read/grep/edit with `LINE:HASH` references
- **snapshot** — Shadow-git filesystem checkpoints at each turn; offers file restore on `/fork`
