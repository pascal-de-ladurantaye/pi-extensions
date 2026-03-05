# Dynamic Context

Injects dynamic shell command output into prompts at expansion time, using the `!`command`` syntax from [Claude Code skills](https://code.claude.com/docs/en/skills#inject-dynamic-context).

## Syntax

Place `` !`command` `` anywhere in a prompt template, skill, or direct prompt. Before the LLM sees the text, each placeholder is replaced with the command's stdout.

```markdown
---
description: Summarize changes in a pull request
---

## Pull request context

- PR diff: !`gh pr diff`
- PR comments: !`gh pr view --comments`
- Changed files: !`gh pr diff --name-only`

Summarize this pull request.
```

When you invoke `/pr-summary`, the three `gh` commands run in parallel and their output is spliced into the prompt. A notification shows the diff:

```
⚡ Dynamic context · 3 commands resolved

  - !`gh pr diff`
  + diff --git a/src/auth.ts b/src/auth.ts
  + index abc123..def456 100644
  … (142 lines total)

  - !`gh pr view --comments`
  + @reviewer: LGTM
  + @author: Thanks!

  - !`gh pr diff --name-only`
  + src/auth.ts
```

## How it works

Everything runs in a single `context` hook (fires before each LLM call):

1. **Scan** user messages for `` !`…` `` patterns
2. **Execute** uncached commands via `bash -c` (30 s timeout)
3. **Replace** patterns in the message copy the LLM will see
4. **Notify** with a `-/+` diff for newly resolved commands

### Per-message caching

Results are keyed by **message identity** — a composite of the message timestamp and a [djb2 hash](http://www.cse.yorku.ca/~oz/hash.html) of its text content (pi's `UserMessage` has no entry ID in the `context` hook, so this is the most robust stable key). The same `` !`date` `` in two different prompts executes twice and captures each invocation's output independently. Within a single message, results are stable — subsequent turns reuse the cached output.

Cache entries are persisted as session entries (`appendEntry`) so `/fork` and `/resume` restore the correct results for each branch.

## Commands

| Command | Description |
|---------|-------------|
| `/dynamic-context` | Show the current cache (message key → command → line count) |

## Error handling

- Non-zero exit codes: output is prefixed with `[exit N]`
- Execution failures: replaced with `[error: message]`
- 30-second timeout per command
