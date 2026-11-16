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

## Revision (2026-11-17 ~00:00–01:00 WIB, under live recording 01a1e502)

A full rewrite of `parse.js` (and a rewrite of `main.ts`, same behavior) with
file write/edit tools only, fixing the remaining 35 doc failures by porting
marked 18.1.3's exact algorithms instead of hand-rolled heuristics:

- **Tabs**: no eager upfront expansion. Tabs are expanded only where marked
  expands them (blockquote marker whitespace, list marker/continuation
  whitespace via `J()`, indented-code removal) and kept literal everywhere
  else — in paragraph text, in code, and in lazy lines. Fence indent
  compensation applies to backtick fences only and slices characters (a tab
  counts as 1), not spaces.
- **Table rows**: `splitCells` is marked's `de()` exactly — split on unescaped
  pipes, shift the first cell only if empty, pop the last only if empty,
  truncate/pad to the header count; delimiter cells are split after removing
  align characters.
- **Blockquote**: the frame loop plus the Lexer's cross-frame merge rules —
  a frame whose first token is a paragraph/code/def/text merges into the
  previous paragraph/text token, so lazy lines join the paragraph above them
  and indented code after a `>` line becomes paragraph text.
- **List**: `nextBulletRegex`/`hrRegex`/`fencesBeginRegex`/`headingBeginRegex`/
  `htmlBeginRegex`/`blockquoteBeginRegex` use marked's `D` memoizer, which
  builds the regex from the clamped index `min(3, R-1)` — so the break
  regexes test an indent of R−1, not R (a 2-space-indented sub-list nests
  under a `* ` item). Task items now carry `checked`.
- **Emphasis/del**: the scan runs on the MASKED source (marked passes the
  masked full source as `t` to emStrong/del) — escapes become `++` and code
  spans become `[a]`, so a delimiter hidden inside them can never close.
  `EM_R_DELIM_UND` and `DEL_R_DELIM` are marked's real GFM regexes (5 and 6
  groups; a `_` run followed by a letter is not a closer). `lastChar` resets
  to `''` after an escape or a reflink fallback, matching marked's `r`
  tracking. Em/del/link-label inner lexing shares the lexer's `inLink` /
  `inRawBlock` state instead of resetting it.
- **Link state persists across paragraphs**: `inLink`/`inRawBlock` live on
  the InlineLex instance (marked's Lexer state), so an unclosed `<a  />` tag
  in one paragraph suppresses autolinks in later ones. `outputLink` saves
  and restores the state around a label, as marked's `De` does. Table cells
  are resolved from the inline queue in block order (the old extra table
  loop in `parse()` that re-lexed them with the end-of-document state is
  gone).

| Score | What fixed it |
|---|---|
| 685 → 715 | masked em/del scan, real UND/DEL right-delimiter regexes, blockquote cross-frame paragraph/code merges, `D`-memoizer R−1 list break regexes, task `checked` |
| 715 → 720 | persistent `inLink`/`inRawBlock` lexer state (unclosed `<a>` suppresses later autolinks) |

Final: **720 / 720** — all 680 spec examples and all 40 generated README
documents match marked 18.1.3 byte-for-byte on the practice set.

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

## Timing (practice set, 720 cases, this VM, cold `node main.ts` runs)

- Entry: 1.71 s / 1.40 s / 1.77 s (mean ≈ 1.63 s).
- House baseline (marked itself, same driver shape): 1.52 s / 1.32 s / 1.77 s
  (mean ≈ 1.54 s).
- The entry is essentially at parity with marked (within run-to-run noise,
  ±0.2 s); the earlier ~1.95 s vs ~2.09 s figures were the same noise. The
  gate (720/720 identical) is now met, so the entry is eligible; speed is
  roughly equal to the reference, not clearly faster.

## Determinism

Two runs over the practice set produce byte-identical `/output/html.json`
(re-verified after the revision).

## Kit check

Run from the kit dir (2026-11-17 ~01:00 WIB, worktree as it stands):
`node cli/makefun.mjs check --kit . --repo ~/workspace/makefun/entries/markdown-render-speed-02 --worktree`
→ **5 passed, 0 failed, 15 skipped, 5 checked at submission** ("ok: every check
run here passes; the rest are the site's at submission"). The 5 at-submission
checks (repo_public, repo_owner, repo_created_after_open, commit_in_repo,
duplicate_snapshot) are resolved when the parent commits, pushes, and submits.

## Grade-local (process driver, worktree)

`node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun/entries/markdown-render-speed-02 --driver process --worktree`
→ **scores {"cases_passed":720,"cases_total":720,"passed":1}**, 720 of 720
points over 71 checks, L1 regrade reproduced byte for byte.
"eligible: ranked yes, prize no, efficiency no (no_transcripts,
coverage_below_gate, cost_unpriced)" — the local run had no transcripts
attached; the sealed recording 01a1e502 is what the site's transcript gate
evaluates at submission. Note: the server's harness runs Node v26.13.1, this
VM v24.22.1, so the local result_sha256 cannot equal the server's.

## Known remaining gaps

None on the practice set: 720/720. The hidden grading set is a different
sample of the same generator, so the same marked-faithful algorithms apply;
the main residual risk is a construct the practice set never exercised.
