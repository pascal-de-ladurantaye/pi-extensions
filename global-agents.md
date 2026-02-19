# Global Pi Agent Context

## Extensions

Custom pi extensions are developed and maintained in:
`~/src/github.com/pascal-de-ladurantaye/pi-extensions`

When building or modifying extensions, always work in that repository. Run `./install.sh` after adding new extensions to symlink them into all pi agent profiles.

## Extension Development

- Each extension is a folder with `index.ts` + `README.md`
- Test changes with `/reload` (hot-reload without restarting pi)
- Extensions must not expose tools that let the LLM disable security features
- Use `ctx.modelRegistry.find()` (not `getModel()`) to respect user's proxy/key config
- Use `{ ...model, reasoning: false }` when making utility LLM calls to avoid thinking overhead
