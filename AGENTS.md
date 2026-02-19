# Pi Extensions Repo

This repository contains custom extensions for pi, the coding agent.

## Structure

Extensions live in the `extensions/` directory. Each is a folder with `index.ts` + `README.md`:

```
extensions/
└── extension-name/
    ├── index.ts    # Entry point — exports default function(pi: ExtensionAPI)
    └── README.md   # Documentation
```

## Development Guidelines

- Extensions are TypeScript modules loaded via jiti (no compilation needed)
- Import types from `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui`
- Use `@sinclair/typebox` for tool parameter schemas
- Test with `/reload` — extensions in auto-discovered locations hot-reload
- After making changes, run `./install.sh` to symlink into all `~/.pi/*/extensions/` profiles

## Key APIs

- `pi.on("tool_call", ...)` — intercept tool calls (can block)
- `pi.on("tool_result", ...)` — modify tool results
- `pi.registerTool(...)` — register custom tools
- `pi.registerCommand(...)` — register `/commands`
- `ctx.ui.custom(...)` — custom TUI components
- `ctx.ui.confirm/select/notify(...)` — user interaction
- `ctx.modelRegistry.find(provider, id)` — find models through user's registry
- `ctx.modelRegistry.getApiKey(model)` — get API keys respecting user's config
- `complete(model, context, options)` from `@mariozechner/pi-ai` — direct LLM calls

## Existing Extensions

- **bash-guard** — Adversarial security review for bash commands using parallel LLM voters
- **hashline** — Content-anchored line editing — overrides read/grep/edit with `LINE:HASH` references
