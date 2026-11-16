# dsh-visualizer

Inline SVG visuals for DeepSeek Harness conversations.

Two Host tools and one Client renderer:

- `visual_guide` returns the design contract (canvas, palette, type, spacing, limits).
- `show_visual` validates a complete SVG string and renders it as a card under the tool call.
- The Client registers `tool.call.toolview` with `key: 'show_visual'`, parses the SVG with a strict
  element/attribute whitelist, and builds React elements. No HTML injection, no DOMParser.

## Development

```bash
node scripts/build-client.mjs   # regenerate client.js from src/normalize.js + src/client-template.js
node --test test/               # parser and whitelist tests
```

`src/normalize.js` is the single source of truth: the Host imports it, the Client build inlines it.
Edit it, run the tests, rebuild `client.js`, then reload the page.

## Limits

24 KB and 1500 nodes per SVG, three visuals per turn, fixed light canvas, SVG only.
