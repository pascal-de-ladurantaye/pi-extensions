# hashline

A pi extension that overrides the built-in `read`, `grep`, and `edit` tools with content-anchored line references (`LINE:HASH|content`).

Hashline anchors let the LLM target exact lines by content hash rather than fragile text matching, reducing edit drift and incorrect replacements.

## How It Works

### Read

The `read` tool outputs each line with a unique identifier: `LINE:HASH|content`.

- **LINE**: The current line number
- **HASH**: A 2-char hex digest (FNV-1a 32-bit, whitespace-stripped)

```text
10:d2|function hello() {
11:e5|  console.log("world");
12:f8|}
```

### Edit

The `edit` tool uses these anchors to perform surgical modifications:

```json
{
  "path": "src/main.ts",
  "edits": [
    {
      "set_line": {
        "anchor": "11:e5",
        "new_text": "  console.log('hashline');"
      }
    }
  ]
}
```

### Grep

The `grep` tool also emits hashline references (`path:>>LINE:HASH|content`), enabling a seamless Search → Edit workflow:

```text
src/main.ts:>>5:72|  const x = 42;
src/main.ts:  6:a1|  const y = x + 1;
```

- `>>` marks actual matches; context lines use `  `
- Hashes are computed from the actual file content (not grep's potentially truncated output)

#### Edit Operations

| Operation | Purpose |
|---|---|
| `set_line` | Replace a single anchored line |
| `replace_lines` | Replace a range between `start_anchor` and `end_anchor` |
| `insert_after` | Insert new content after an anchor |
| `replace` | Fallback fuzzy substring replacement (no hashes needed) |

## Smart Heuristics

- **Auto-relocation**: If a line number drifts, treats `LINE` as a hint and relocates by `HASH` within ±20 lines (only when unambiguous)
- **Merge detection**: Handles cases where the model merges continuation lines into one
- **Echo stripping**: Removes accidental echoes of anchor lines in replacement text
- **Wrapped line restoration**: Detects unintentional line wrapping and restores original form
- **Indentation recovery**: Preserves original indentation when replacement content matches modulo whitespace
- **Conflict diagnostics**: On hash mismatch, shows diff-like error with updated `LINE:HASH` references

## Legacy Compatibility

Falls back to `oldText`/`newText` style edits when the model doesn't use the `edits[]` array format.

## Environment Variables

- `PI_HASHLINE_DEBUG=1` — Show notification on session start

## Credits

Based on the hashline concept and heuristics from [oh-my-pi](https://github.com/can1357/oh-my-pi) by [can1357](https://github.com/can1357).
