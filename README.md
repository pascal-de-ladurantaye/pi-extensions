# pi-agent

Customizations for [pi](https://github.com/badlogic/pi-mono), the coding agent.

## Extensions

| Extension | Description |
|---|---|
| [bash-guard](./extensions/bash-guard/) | Adversarial security review for bash commands — parallel LLM voters assess safety before execution |
| [hashline](./extensions/hashline/) | Content-anchored line editing — overrides read/grep/edit with `LINE:HASH` references for precise, drift-resistant edits |
| [snapshot](./extensions/snapshot/) | Shadow-git filesystem checkpoints at each turn; offers file restore on `/fork` |

## Skills

| Skill | Description |
|---|---|
| [browser-mcp](./skills/browser-mcp/) | Automates the user's real Chrome browser via the Browser MCP Chrome extension — CLI wrapper + daemon that bridges commands to the extension over WebSocket |

The hashline approach originates from [oh-my-pi](https://github.com/can1357/oh-my-pi) by [can1357](https://github.com/can1357).

## Install

```bash
./install.sh
```

This symlinks each extension folder into all pi agent config directories found in `~/.pi/`.

To also install a global `AGENTS.md` that tells pi where to develop extensions:

```bash
./install.sh --with-agents
```

Then run `/reload` in pi to pick up the changes.

## Uninstall

Remove the symlinks from your pi config directories:

```bash
rm ~/.pi/*/extensions/{bash-guard,hashline,snapshot}
```


## Adding a new extension

1. Create a folder under `extensions/` with an `index.ts` that exports a default function:
   ```typescript
   import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
   
   export default function (pi: ExtensionAPI) {
     // ...
   }
   ```
2. Add a `README.md` documenting the extension
3. Run `./install.sh` to symlink it into all pi profiles
4. `/reload` in pi
