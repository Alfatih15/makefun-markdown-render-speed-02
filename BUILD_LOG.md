# BUILD_LOG — markdown-render-speed-02

Built 2026-11-16 (WIB) by an agent session. Kit:
`~/workspace/makefun/extracted/markdown-render-speed-02/`. Entry:
`~/workspace/makefun/entries/markdown-render-speed-02/`.

## Approach

Write an original parser from scratch following marked 18.1.3's algorithm
semantically (block lexer → inline lexer with delimiter runs → renderer),
verified case-by-case against the kit's vendored marked. No marked source was
copied into the entry; the entry is dependency-free (Node 22 builtins only).

All code was written with file write/edit tools only (the kit's
`thinking_reproduces` authorship gate requires agent-authored lines; shell
heredoc/cat/cp/sed were never used to write code). The only exception was a
temporary Python test patch used once to diagnose an emphasis rule; it was
reverted and the file verified byte-identical to its backup.

## Verification progression (practice set, 720 cases)

| Score | What fixed it |
|---|---|
| 0 → 444 | First working parser (format bug, then flanking) |
| 444 → 516 | NOLINK, reflink, emphasis last-closer |
| 516 → 554 | trimBlankTail, leading tabs, numeric refs, link validation, image alt, href/lang escaping |
| 554 → 609 | code escaping, emphasis closer heuristics, list ordered flag, prevBlank, list raw, itemRe, itemSrc |
| 609 → 636 | delimiter-run excess, nested run-splitting, normLabel ẞ→ss, first-def-wins, reflink-undefined-ref, Be-check coordinate fix, REFLINK backslash fix |
| 636 → 663 | rule of 3 (can-both), depth scan on masked source, ATX strip, del single-tilde, table padding + lookahead, HR-interrupts-list, empty-item blank line, fence raw/text, list raw trailing newlines, blockquote lazy-line list-marker strip |
| 663 → 676 | shared-closer (depth===1 gate), nested del rewrite, canOpen gating (insideOther), cross-delimiter depth scan (cm-470), emStrongMask reflink-ref fix (cm-534), single-line TEXT rule |
| 676 → 680 | blockquote inner-content trailing-newline trim (cm-174, cm-241) — **all 680 spec examples pass** |
| 680 → 683 | vendor-faithful emStrong rewrite (single scan, m/f counters, NO_CLOSER tail retry) — doc-01, doc-27, doc-32 pass |
| 683 → 684 | fence text: remove exactly one trailing newline |
| 684 → 685 | table rows: HTML-block-start lookahead (autolinks no longer end a table); tab preservation only at exactly 4 spaces |

Final: **685 / 720** (all 680 spec examples pass; 35 of the 40 generated README
documents each fail on one nested-emphasis / table / link edge case).

## Key semantics verified against the vendored marked 18.1.3

- Block-lexer merge rules (space, indented code, def, paragraph, `lastParagraphClipped`).
- Blockquote: grab regex + frame loop; inner content has no trailing newline;
  a lazy line inside an open fence ends the blockquote; trailing lazy lines are
  dropped when the last inner token is code/heading/hr/html/table.
- List: item-marker pattern, continuation/lazy lines, setext hack, loose
  detection (ignoring a trailing space token), task-list checkbox inside the
  first `<p>` when loose.
- Table: header/delimiter column match, row lookahead (real block-start
  patterns, HTML-block-start only — an autolink row does not end a table),
  padding short rows with empty cells.
- Fences: closer rules, lang from the info string, indent compensation,
  exactly one trailing newline removed from the text.
- Inline: emStrong mask (reflink labels masked, escaped punctuation masked,
  links/code/html masked), the vendor's emStrong scan (m/f counters, rule of 3,
  skip groups), del with the same scan, link/reflink/nolink with the Be
  (`<` extends past the label end) check, nested-autolink-inside-a-link allowed,
  URL backpedal looped until stable, `trimBlankTail` keeps a single trailing
  newline.
- Tab expansion is column-aware and context-aware: a tab after exactly 4
  literal spaces is indented-code content (preserved); a tab after any other
  indent expands; tabs inside top-level fenced code blocks are preserved.

## Timing (practice set, 720 cases, this VM)

- Entry: ~1.95 s wall.
- House baseline (marked itself, same harness): ~2.09 s wall.
- The entry is faster than the baseline, but the gate (720/720 identical) is
  not yet met, so timing does not yet count for ranking.

## Determinism

Two runs over the practice set produce byte-identical `/output/html.json`.

## Kit check

Run from the kit dir (see the parent agent's report for the outcome):
`node cli/makefun.mjs check --kit . --repo ~/workspace/makefun/entries/markdown-render-speed-02`

## Known remaining gaps (35 doc cases)

Each remaining failure is a single first-diff inside one generated README:
nested emphasis with an inner strong attached to the final delimiter
(`*a **b**c*` family is fixed; deeper nestings remain), `del` nesting,
table cell alignment on rows with escaped pipes, a link whose label contains
a nested link, and a tab inside a fenced code block nested in a list. The
spec examples (the graded core) all pass.
