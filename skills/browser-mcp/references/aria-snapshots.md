# ARIA Snapshots

Browser MCP uses ARIA (Accessible Rich Internet Applications) accessibility snapshots to represent the page state. These are YAML files that describe the page structure as a tree of accessible elements.

## Reading Snapshots

After each navigation or interaction command, the daemon captures a snapshot and saves it to `.browser-mcp/snapshot-<timestamp>.yaml`. Use `read` to view the full tree.

## Snapshot Format

The snapshot is a YAML tree where each node represents an accessible element:

```yaml
- document "Example Page":
  - banner:
    - navigation "Main":
      - link "Home" [ref1]
      - link "Products" [ref2]
      - link "About" [ref3]
  - main:
    - heading "Welcome" [level=1]
    - textbox "Search" [ref4]
    - button "Search" [ref5]
    - list:
      - listitem:
        - link "Item One" [ref6]
      - listitem:
        - link "Item Two" [ref7]
  - contentinfo:
    - link "Privacy Policy" [ref8]
```

## Element References

Elements that can be interacted with have **refs** — short identifiers in square brackets like `[ref1]`. Use these refs in interaction commands:

```bash
browser-mcp click "Home link" ref1
browser-mcp type "Search box" ref4 "my query" --submit
browser-mcp click "Search button" ref5
```

The first argument (`element`) is a human-readable description — it's used for logging and confirmation, not matching. The second argument (`ref`) is the exact ref from the snapshot — this is what identifies the element.

## Common Element Types

| ARIA Role | Description | Interactable? |
|-----------|-------------|---------------|
| `link` | Hyperlink | click |
| `button` | Button | click |
| `textbox` | Text input | type |
| `checkbox` | Checkbox | click |
| `radio` | Radio button | click |
| `combobox` | Dropdown/autocomplete | select, type |
| `listbox` | Selection list | select |
| `menuitem` | Menu option | click |
| `tab` | Tab control | click |
| `slider` | Range slider | type value |
| `heading` | Section heading | read-only |
| `img` | Image | read-only |
| `table` | Data table | read-only |
| `row` / `cell` | Table row/cell | read-only |

## Tips

1. **Always snapshot first** — before interacting, capture a snapshot to get current refs.
2. **Refs change** — after any interaction, refs may change. Use the new snapshot's refs.
3. **Scroll context** — the snapshot includes only visible elements. If an element isn't in the snapshot, scroll down first.
4. **Forms** — use `type` with `--submit` to type and press Enter in one step.
5. **Dropdowns** — use `select` for `<select>` elements, `click` then `click` for custom dropdowns.
6. **Multiple values** — `select` accepts multiple values: `browser-mcp select "Tags" ref1 "a" "b"`.
