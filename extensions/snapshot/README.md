# Snapshot

Filesystem checkpoint extension for pi. Takes shadow-git snapshots at session start and after each agent run. On `/fork`, walks back from the user message to find the nearest snapshot and offers to restore files.

## How It Works

### Shadow Git Repository

A separate git repo at `<config-dir>/data/snapshot/<project-hash>/` — completely independent of the project's `.git`. Uses git plumbing commands for lightweight **tree objects** (no commits, no history graph):

- `git add .` — stages all work-tree files into the shadow index
- `git write-tree` — writes the index as a tree object, returns its SHA hash
- `git read-tree` + `git checkout-index` — restores files from a tree hash

### Session Tree Layout

Snapshot entries are appended via `appendEntry` and sit between the last tool result and the next user message:

```
[snapshot₀] → [user 1] → [assistant 1] → [tool results...] → [snapshot₁] → [user 2] → ...
```

- `snapshot₀` — baseline from `session_start` (covers the first user message)
- `snapshot₁` — from `agent_end` after the first turn

Fork always targets a user message. Walking one hop back finds the snapshot:

```
/fork from [user 2]
  └─ parent is [snapshot₁] → hash → changedFiles → confirm → restore
```

### Timing

| Event | What happens |
|-------|-------------|
| `session_start` | Baseline snapshot (covers first message) + background GC |
| `session_switch` | Baseline snapshot for the new session |
| `session_fork` | Baseline snapshot for the forked session |
| `agent_end` | Post-agent snapshot (latency hidden while user reads results) |
| `session_before_fork` | Walk back → find snapshot → offer restore |

No external state files. Everything lives in the session tree via `appendEntry`, so it survives fork, resume, and reload automatically.

### Cleanup

On session start, `git gc --prune=7.days` runs in the background (fire-and-forget). Since snapshots are unreferenced tree objects (no commits), GC reclaims them after 7 days.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point — event hooks for snapshot/restore |
| `lib.ts` | Shadow git operations |

## Restore Details

1. Reverts modified/deleted files to their snapshot state
2. **Deletes files created after the snapshot** (agent-generated artifacts)
3. If the snapshot hash expired (GC'd), shows a warning and lets the fork proceed

## Limitations

- Respects `.gitignore` and `info/exclude` — untracked-and-ignored files are not snapshotted
- Binary files are stored but not diffed
- The shadow repo can grow; GC runs automatically but large repos may need monitoring

## Credits

Design and implementation heavily inspired by the snapshot system in [opencode](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/snapshot/index.ts).
