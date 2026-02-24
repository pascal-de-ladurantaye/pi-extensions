# Pi Extensions Repo

This repository contains custom extensions, themes, skills, and prompt templates for pi, the coding agent.

## Structure

- **Extensions** live in `extensions/`. Each is a folder with an `index.ts` entry point and a `README.md`. Extensions can include additional source files, a `package.json` with dependencies, and whatever structure makes sense for the complexity of the extension.
- **Themes** live in `themes/`. Each is a `.json` file following pi's theme format (51 required color tokens, optional `vars` and `export` sections).
- **Skills** live in `skills/`. Each is a folder named after the skill containing a `SKILL.md` with YAML frontmatter (`name`, `description`) and instructions. Skills can include scripts, references, and assets loaded on-demand by the agent.
- **Prompt templates** live in `prompts/`. Each is a `.md` file with optional YAML frontmatter (`description`). The filename becomes the `/command` name (e.g., `review.md` → `/review`). Templates support positional arguments (`$1`, `$2`, `$@`).

When building or modifying any of the above, always read the corresponding pi documentation first:
- Extensions → pi's extension docs
- Themes → pi's theme docs
- Skills → pi's skill docs
- Prompt templates → pi's prompt template docs

## Development Guidelines

### Extensions

- Extensions are TypeScript modules loaded via jiti (no compilation needed)
- Import types from `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui`
- Use `@sinclair/typebox` for tool parameter schemas
- Use `StringEnum` from `@mariozechner/pi-ai` for string enums (required for Google compatibility)
- npm dependencies are supported — add a `package.json`, run `npm install`, and imports resolve automatically
- Node.js built-ins (`node:fs`, `node:path`, `node:child_process`, etc.) are available
- Test with `/reload` — extensions in auto-discovered locations hot-reload

### Themes

- Themes are JSON files defining colors for pi's TUI
- Must define all 51 required color tokens (core UI, backgrounds, markdown, diffs, syntax, thinking levels, bash mode)
- Use `vars` to define reusable color palette entries referenced in `colors`
- Color values: hex (`"#ff0000"`), 256-color index (`39`), var reference (`"primary"`), or default (`""`)
- Optional `export` section controls `/export` HTML output colors
- Hot-reload: editing the active theme file auto-reloads it in pi

### Skills

- Skills follow the [Agent Skills standard](https://agentskills.io/specification)
- Each skill is a directory with a `SKILL.md` file containing YAML frontmatter
- Required frontmatter: `name` (lowercase, hyphens, max 64 chars) and `description` (max 1024 chars)
- Directory name must match the `name` field
- Use relative paths in SKILL.md to reference scripts, references, and assets
- Only descriptions are loaded into context at startup; full content loads on-demand via `read`
- Skills register as `/skill:name` commands

### Prompt Templates

- Templates are single `.md` files with optional `description` frontmatter
- The filename (without `.md`) becomes the `/command` name
- Support positional arguments: `$1`, `$2`, `$@` (all args), `${@:N}` (args from N)
- Discovery is non-recursive — templates must be directly in `prompts/`

### General

- **All extension/theme/skill/prompt development happens in this repo**, never directly in `~/.pi/*/`. The `~/.pi/*/` directories contain symlinks created by `./install.sh`.
- After making changes, run `./install.sh` to symlink into all `~/.pi/*/` profiles
- Test extensions and themes with `/reload` for hot-reload without restarting pi

## Key APIs

- `pi.on("tool_call", ...)` — intercept tool calls (can block)
- `pi.on("tool_result", ...)` — modify tool results
- `pi.on("input", ...)` — intercept, transform, or handle user input
- `pi.on("before_agent_start", ...)` — inject messages, modify system prompt
- `pi.on("context", ...)` — modify messages before LLM call
- `pi.on("session_start", ...)` — initialize on session load
- `pi.on("session_shutdown", ...)` — cleanup on exit
- `pi.on("session_before_compact", ...)` — custom compaction
- `pi.on("model_select", ...)` — react to model changes
- `pi.on("user_bash", ...)` — intercept `!`/`!!` commands
- `pi.registerTool(...)` — register custom tools
- `pi.registerCommand(...)` — register `/commands`
- `pi.registerShortcut(...)` — register keyboard shortcuts
- `pi.registerFlag(...)` — register CLI flags
- `pi.registerProvider(...)` — register or override model providers
- `pi.registerMessageRenderer(...)` — custom message rendering
- `pi.appendEntry(...)` — persist state in the session tree
- `pi.sendMessage(...)` — inject custom messages (steer, followUp, nextTurn)
- `pi.sendUserMessage(...)` — inject user messages
- `pi.setSessionName(...)` / `pi.setLabel(...)` — session metadata
- `pi.exec(...)` — execute shell commands
- `pi.getActiveTools()` / `pi.setActiveTools(...)` — manage active tools
- `pi.setModel(...)` / `pi.setThinkingLevel(...)` — control model and thinking
- `pi.events` — shared event bus for inter-extension communication
- `ctx.ui.custom(...)` — custom TUI components (full-screen or overlay)
- `ctx.ui.confirm/select/input/editor/notify(...)` — user interaction dialogs
- `ctx.ui.setStatus/setWidget/setFooter/setHeader(...)` — persistent UI elements
- `ctx.ui.setEditorComponent(...)` — replace the input editor (vim mode, etc.)
- `ctx.ui.setTheme/getAllThemes/getTheme(...)` — theme management
- `ctx.sessionManager` — read session entries, tree, leaf
- `ctx.modelRegistry.find(provider, id)` — find models through user's registry
- `ctx.modelRegistry.getApiKey(model)` — get API keys respecting user's config
- `ctx.compact(...)` — trigger compaction programmatically
- `ctx.getContextUsage()` — check current token usage
- `ctx.getSystemPrompt()` — read the effective system prompt
- `ctx.shutdown()` — request graceful shutdown
- `complete(model, context, options)` from `@mariozechner/pi-ai` — direct LLM calls

## Existing Extensions

- **bash-guard** — Adversarial security review for bash commands using parallel LLM voters
- **hashline** — Content-anchored line editing — overrides read/grep/edit with `LINE:HASH` references
- **snapshot** — Shadow-git filesystem checkpoints at each turn; offers file restore on `/fork`

## Session Log Analysis

Pi session logs are stored in `~/.pi/{profile}/sessions/` as `.jsonl` files. Each line is a JSON object. Key structure:
- `type: "session"` — session metadata (first line)
- `type: "message"` with `message.role` — conversation messages
  - Messages use `message.content[]` with parts of `type: "text"`, `type: "toolCall"`, etc.
  - Tool calls are in `content[]` with `type: "toolCall"`, fields: `name`, `arguments` (not `input` or `args`)
  - Tool results have `role: "toolResult"` with `toolName`, `toolCallId`, `content`
- `type: "custom"` — extension events (snapshots, etc.)

When analyzing session logs, use `message.content[]` to find tool calls and their arguments.

## Existing Themes

- **nightowl** — Dark theme inspired by the Night Owl VS Code theme. Deep navy background, teal accents, warm syntax colors.
- **darcula** — Dark theme inspired by the JetBrains Darcula IDE theme. Warm charcoal background, orange keywords, gold functions, green strings.
