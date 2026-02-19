# pi-extensions

Custom extensions for [pi](https://github.com/badlogic/pi-mono), the coding agent.

## Extensions

| Extension | Description |
|---|---|
| [bash-guard](./bash-guard/) | Adversarial security review for bash commands — parallel LLM voters assess safety before execution |

## Install

```bash
./install.sh
```

This symlinks into all pi agent config directories found in `~/.pi/`:
- **Extensions** — each `*/index.ts` folder → `~/.pi/*/extensions/`
- **Global AGENTS.md** — `global-agents.md` → `~/.pi/*/AGENTS.md`

Then run `/reload` in pi to pick up the changes.

## Uninstall

Remove the symlinks from your pi config directories:

```bash
rm ~/.pi/*/extensions/bash-guard
```

## Structure

Each extension is a directory with an `index.ts` entry point:

```
pi-extensions/
├── install.sh              # Symlink installer
├── README.md
├── AGENTS.md               # Repo-local context (for working in this repo)
├── global-agents.md        # Global context (symlinked to ~/.pi/*/AGENTS.md)
├── bash-guard/
│   ├── index.ts            # Extension entry point
│   └── README.md           # Extension documentation
└── your-extension/
    ├── index.ts
    └── README.md
```

## Adding a new extension

1. Create a folder with an `index.ts` that exports a default function:
   ```typescript
   import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
   
   export default function (pi: ExtensionAPI) {
     // ...
   }
   ```
2. Add a `README.md` documenting the extension
3. Run `./install.sh` to symlink it into all pi profiles
4. `/reload` in pi
