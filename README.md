# markdown-render-speed-02 — a fast marked-compatible Markdown renderer

A dependency-free JavaScript module (`parse.js`) whose `parse(markdown)` returns
exactly the HTML that [marked 18.1.3](https://github.com/markedjs/marked)
`marked.parse(markdown)` returns with its defaults (GFM on, breaks off, pedantic
off, async off), plus `main.ts`, the driver the harness runs: it reads
`/input/cases.json` and writes `/output/html.json`.

This is an original parser written from scratch, following marked's algorithm
semantically (block lexer → inline lexer with delimiter runs → renderer). It
does not copy marked's source: no marked code is vendored in the entry, and the
entry is dependency-free (Node 22 builtins only).

## Files

| File | What it is |
|---|---|
| `parse.js` | The renderer. `export function parse(markdown) -> string`. ~84 KB. |
| `main.ts` | Driver: reads `cases.json`, renders each case alone, writes `html.json`. |
| `LICENSE` | MIT. |
| `README.md` | This file. |
| `BUILD_LOG.md` | How it was built and verified. |
| `.makefun/owner.json` | `{"wallet":"Cfdgeggmd6ij5dLpqwmqAaGExTbi4JPZJYcRdi4iSjSW"}` |

## How it works

- **Block lexer** (`BlockLex`): space, indented code, fences, ATX/setext headings,
  hr, blockquote, list, HTML block, link-reference definitions, tables,
  paragraph, text — in marked's order, with marked's merge rules (space merging
  into the previous token, indented-code/def/paragraph merging, `lastParagraphClipped`).
- **Inline lexer** (`InlineLex`): escape, tag, link, reflink, em/strong, code span,
  br, del, autolink, URL, text — in marked's order, with the masked source
  (`emStrongMask`) used for delimiter-closer lookup, the exact `emStrong` scan
  (single left-to-right pass with the `m`/`f` counters and the rule of 3), and
  deferred inline resolution so link-reference definitions anywhere in the
  document resolve.
- **Renderer**: byte-exact marked output strings for every block and inline token.

Speed comes from sticky (`y`-flag) patterns over a single cursor instead of
re-slicing the source, and from plain-text fast paths — not from caching (there
is no cache: `parse` returns for each case what it returns for that case alone).

## Verification (practice set, 720 cases)

- **All 680 spec examples pass** (CommonMark 0.31.2 cm-001–cm-652 + 28 GFM 0.29
  examples gfm-198–gfm-657).
- **685 / 720 total** on the practice set (the 35 remaining failures are all in
  the 40 generated README documents, each on a single nested-emphasis / table /
  link edge case).
- **Deterministic**: two runs over the practice set produce byte-identical output.
- **Faster than the house baseline**: ~1.95 s wall for the full practice set on
  this VM vs ~2.09 s for marked itself (same harness).

## Usage

```bash
node main.ts   # reads /input/cases.json (or $MAKEFUN_INPUT_DIR), writes /output/html.json
```

Or from JavaScript:

```js
import { parse } from './parse.js';
parse('# Hello\n\nHello *world*.');
// '<h1>Hello</h1>\n<p>Hello <em>world</em>.</p>\n'
```

## License

MIT. See `LICENSE`. The parser is original work; marked is a separate project
(MIT) and is not included here.
