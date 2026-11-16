// parse.js — Markdown renderer compatible with marked 18.1.3 (GFM defaults:
// gfm true, breaks false, pedantic false). Block lexer -> inline lexer
// (delimiter runs, masked-source closer bounds) -> renderer. Dependency-free,
// deterministic, Node 22 stdlib only. See BUILD_LOG.md for design notes.
//
// This file was rewritten in-session (2026-11-16) from the marked 18.1.3
// algorithm: tab handling follows marked's targeted expansion (tabs are only
// expanded where the spec expands them), tables use marked's splitCells,
// emphasis/del use marked's scan with the masked-source closer bound, and
// blockquotes/lists use marked's frame/item algorithms. All code below was
// written with file write/edit tools in this session.
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escHtml(s, encode) {
  if (encode) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  return s.replace(/&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]*);)/g, '&amp;')
          .replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', laquo: '\u00ab', raquo: '\u00bb', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', deg: '\u00b0', micro: '\u00b5', para: '\u00b6', sect: '\u00a7', dagger: '\u2020', Dagger: '\u2021', bull: '\u2022', permil: '\u2030', prime: '\u2032', Prime: '\u2033', oline: '\u203e', frasl: '\u2044', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', curren: '\u00a4' };
function decodeNumRefs(s) {
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g, (m, body) => {
    let n;
    if (body[1] === 'x' || body[1] === 'X') n = parseInt(body.slice(2), 16);
    else n = parseInt(body.slice(1), 10);
    if (!n || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}
function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) { return null; }
}
// expand tabs to the next multiple of 4, tracking the column from `col`
function expandTab(s, col = 0) {
  let out = '';
  let c = col;
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += ' '.repeat(n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}
// strip trailing chars equal to `ch` (or, with `invert`, trailing chars NOT equal to `ch`)
function stripTail(s, ch, invert) {
  let n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const r = s.charAt(n - k - 1);
    if (r === ch && !invert) k++;
    else if (r !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}
// drop trailing blank lines when there are more than one (keep at most one)
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').replace(/[\u1E9E\u00DF]/g, 'ss').toLowerCase();
}
// paren balance in `a`: index of the first close paren that goes negative,
// -2 when opens are left unclosed, -1 when there are no parens / balanced
function parenBalance(a, pair) {
  if (a.indexOf(pair[0]) === -1 && a.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '\\') { i++; continue; }
    if (a[i] === pair[0]) depth++;
    else if (a[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}
// split a table row on unescaped pipes (marked's splitCells): every `|`
// becomes ` |` unless escaped by an odd run of backslashes (then the pipe
// stays and the backslashes stay); cells are split on ` |`, the first cell
// is dropped only if empty after trim, the last only if empty, then each
// cell is trimmed and `\|` is unescaped to `|`
function splitCells(row, colCount) {
  const t = row.replace(FIND_PIPE, (m, off, str) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && str[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(SPLIT_PIPE);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (colCount) {
    if (cells.length > colCount) cells.splice(colCount);
    else for (; cells.length < colCount;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
  return cells;
}
// last possible closer index in a masked source: for `*`/`_` the start index
// of the last run whose preceding char is not space/tab/newline/CR/FF; for
// `~` the same, returned separately
function lastCloserBounds(masked) {
  const bounds = { '*': -1, _: -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === r;) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') bounds[r] = s;
    s = i - 1;
  }
  return bounds;
}
// ---------------------------------------------------------------------------
// Shared "other" rules (marked's T)
// ---------------------------------------------------------------------------
const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const INDENT_CODE_COMP = /^(\s+)(?:```)/;
const BEGINNING_SPACE = /^\s+/;
const ENDING_HASH = /#$/;
const ENDING_SPACE_TAB = /[ \t]$/;
const NON_SPACE = /[^ ]/;
const LEADING_SPACE_TAB = /^[ \t]+/;
const BLANK_LINE = /^[ \t]*$/;
const DOUBLE_BLANK_LINE = /\n[ \t]*\n[ \t]*$/;
const BQ_START = /^ {0,3}>/;
const BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const ANY_LINE = /\n.*\n/;
const TABLE_DELIM_TEST = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE = /^</;
const END_ANGLE = />$/;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const TAB_GLOBAL = /\t/g;
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
const MULTI_SPACE = /\s+/g;
const CARRIAGE_RETURN = /\r\n|\r/g;
const PUNCT_CLASS = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
function memoRegex(fn) {
  // marked's D: the cache index is clamp(R-1, 0, 3) and the regex is built
  // from THAT index, so the break regexes test an indent of R-1 (capped
  // at 3), not R
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = fn(i));
  };
}
const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const listItemRegex = (bullet) => new RegExp(`^( {0,3}${bullet})((?:[\t ][^\n]*)?(?:\n|$))`);
const nextBulletRegex = memoRegex((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrRegex = memoRegex((n) => new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = memoRegex((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRegex = memoRegex((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = memoRegex((n) => new RegExp(`^ {0,${n}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = memoRegex((n) => new RegExp(`^ {0,${n}}>`));
// ---------------------------------------------------------------------------
// Block patterns (marked's V.gfm, built with the same replacements)
// ---------------------------------------------------------------------------
const BLANK_RUN = /^(?:[ \t]*(?:\n|$))+/;
const INDENT_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const ATX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const TABLE_DELIM = /^ {0,3}\|? *(?:-+:?|:-+:?) *(?:\| *(?:-+:?|:-+:?) *)*\|? *(?:\n|$)/;
const SETEXT_LINE = /^ {0,3}(=+|-+)[ \t]*(?:\n|$)/;
const DEF = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const HTML_BLOCK = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i;
const FRAG_HR = '(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}';
const FRAG_FENCE = '(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)';
const FRAG_HTML_TAG = '(?:<\\/?(?:' + TAG_LIST + ')(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const FRAG_BQ_LIST_ITEM = '(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)';
const FRAG_PARA_LIST_ITEM = '(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
const FRAG_ATX = ' {0,3}#{1,6}(?:\\s|$)';
const BQ_GRAB = new RegExp('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?! {0,3}(' + FRAG_HR + ')(?:\\n+|$)|' + FRAG_ATX + '| {0,3}>| {0,3}' + FRAG_FENCE + '[^\\n]*(?:\\n|$)| {0,3}' + FRAG_BQ_LIST_ITEM + '| {0,3}' + FRAG_HTML_TAG + '|[ \\t]+\\n)[^\\n]+)*))|[^\\n]*)(?:\\n|$))+');
const LIST_MARKER = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
// paragraph: a run of lines that does not start a block (hr/heading/lheading/
// blockquote/fence/list/html/table) and is not a blank line
const PARA = /^([^\n]+(?:\n(?! {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/;
// setext heading: text lines (not block starts) followed by an underline
const LHEADING = /^(?!(?: {0,3}(?:[*+-]|\d{1,9}[.)])|(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)])| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
// table: header line, delimiter line, body rows (stops at blank line or a block start)
const TABLE_RE = /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/;
// ---------------------------------------------------------------------------
// Inline patterns (marked's G.gfm)
// ---------------------------------------------------------------------------
const INLINE_ESC = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|[\\])\n(?!\s*$)[ \t]*/;
const INLINE_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const LINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const REFLINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const NOLINK = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\\]|\\[\s\S]|[^\[\]\\])*\\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const URL_EXT = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
// ---------------------------------------------------------------------------
// Masking / delimiter patterns (marked's #n / fe / blockSkip)
// ---------------------------------------------------------------------------
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]' +
  '\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)' +
  '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>', 'g');
// inline text: stops before a delimiter that can open, before a link/image
// start, before an autolink/email start, and at a hard break / end
const INLINE_TEXT = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;
// emphasis left-delimiter (GFM: `~` does not count as punctuation here)
const EM_L_DELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
// emphasis right-delimiters (GFM: `~` counts as a non-punctuation char)
const EM_R_DELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?![*])(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?![*])(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?![*])(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
// emphasis right-delimiter for `_` (marked's GFM emStrongRDelimUnd: 5
// groups, no `~` handling — a `_` run followed by a letter is NOT a closer)
const EM_R_DELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
// strikethrough delimiters (marked's GFM delRDelim: 6 groups)
const DEL_L_DELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const DEL_R_DELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const PUNCT_SINGLE = /^((?![*_])[\s\p{P}\p{S}])/u;
// a tag/autolink inside a link label that extends past the label end
// invalidates the link (marked's Be)
function linkExtendsPastLabel(full, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = full.slice(labelStart + i);
    const tag = INLINE_TAG.exec(rest) || AUTOLINK.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}
// does `text` contain a link (used by the mask's reflink step)
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(BLOCK_SKIP)) {
    if (LINK.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Block lexer
// ---------------------------------------------------------------------------
class BlockLex {
  constructor() {
    this.tokens = [];
    this.inlineQueue = []; // {tokens, src, inLink, inRawBlock, owner} — inline lex deferred
    this.links = {};       // normalized label -> {href, title}
    this.state = { top: true, inLink: false, inRawBlock: false };
  }
  lex(src, top) {
    this.state.top = top !== false;
    let s = src;
    while (s) {
      let tok = null;
      // --- blank lines ---
      let m = BLANK_RUN.exec(s);
      if (m) {
        const raw = m[0];
        if (raw.length === 1 && this.tokens.length > 0) {
          this.tokens[this.tokens.length - 1].raw += '\n';
        } else if (raw.length > 1) {
          this.tokens.push({ type: 'space', raw });
        }
        s = s.slice(raw.length);
        continue;
      }
      // --- indented code ---
      m = INDENT_CODE.exec(s);
      if (m) {
        const raw = trimBlankTail(m[0]);
        const text = raw.replace(CODE_REMOVE_INDENT, '');
        tok = { type: 'code', raw, text, lang: null };
        if (this.tokens.length > 0) {
          const prev = this.tokens[this.tokens.length - 1];
          if (prev.type === 'paragraph' || prev.type === 'text') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
            prev.text += '\n' + text;
            const q = this.inlineQueue[this.inlineQueue.length - 1];
            if (q) q.src = prev.text;
            s = s.slice(raw.length);
            continue;
          }
        }
        this.tokens.push(tok);
        s = s.slice(raw.length);
        continue;
      }
      // --- fences ---
      m = FENCE_OPEN.exec(s);
      if (m) {
        const fence = m[1];
        const ch = fence[0];
        const info = (m[2] || '').trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1').split(/\s+/)[0] || '';
        let text = m[3] || '';
        // indent compensation (backtick fences only): strip up to the fence
        // indent's character length from each content line's leading space
        const comp = INDENT_CODE_COMP.exec(m[0]);
        if (comp) {
          const indentLen = comp[1].length;
          text = text.split('\n').map((line) => {
            const lead = BEGINNING_SPACE.exec(line);
            if (!lead) return line;
            return line.slice(Math.min(lead[0].length, indentLen));
          }).join('\n');
        }
        this.tokens.push({ type: 'code', raw: m[0], text, lang: info || null });
        s = s.slice(m[0].length);
        continue;
      }
      // --- ATX heading ---
      m = ATX.exec(s);
      if (m) {
        let text = m[2].trim();
        if (ENDING_HASH.test(text)) {
          const stripped = stripTail(text, '#');
          if (!stripped || ENDING_SPACE_TAB.test(stripped)) text = stripped.trim();
        }
        const raw = stripTail(m[0], '\n');
        this.tokens.push({ type: 'heading', raw, depth: m[1].length, text });
        this.inlineQueue.push({ tokens: null, src: text, inLink: false, inRawBlock: false, owner: this.tokens[this.tokens.length - 1] });
        this.tokens[this.tokens.length - 1].tokens = null;
        s = s.slice(m[0].length);
        continue;
      }
      // --- hr ---
      m = HR.exec(s);
      if (m) {
        this.tokens.push({ type: 'hr', raw: stripTail(m[0], '\n') });
        s = s.slice(m[0].length);
        continue;
      }
      // --- blockquote ---
      const bqTok = this.tokenizeBlockquote(s);
      if (bqTok) {
        this.tokens.push(bqTok);
        s = s.slice(bqTok.raw.length);
        continue;
      }
      // --- list ---
      const listTok = this.tryList(s);
      if (listTok) {
        this.tokens.push(listTok);
        s = s.slice(listTok.raw.length);
        continue;
      }
      // --- html ---
      m = HTML_BLOCK.exec(s);
      if (m) {
        const raw = trimBlankTail(m[0]);
        const pre = /<(?:script|pre|style)/i.test(m[0].slice(0, 20));
        this.tokens.push({ type: 'html', raw, text: raw, pre });
        s = s.slice(m[0].length);
        continue;
      }
      // --- def ---
      m = DEF.exec(s);
      if (m) {
        const label = normLabel(m[1]);
        let href = m[2];
        if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
        href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
        let title = null;
        if (m[3]) {
          let t = m[3];
          if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('(') && t.endsWith(')'))) t = t.slice(1, -1);
          title = t.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
        }
        const raw = m[0];
        if (!(label in this.links)) this.links[label] = { href, title };
        if (this.tokens.length > 0) {
          const prev = this.tokens[this.tokens.length - 1];
          if (prev.type === 'paragraph' || prev.type === 'text') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
            prev.text += '\n' + raw;
            const q = this.inlineQueue[this.inlineQueue.length - 1];
            if (q) q.src = prev.text;
            s = s.slice(raw.length);
            continue;
          }
        }
        this.tokens.push({ type: 'def', raw });
        s = s.slice(raw.length);
        continue;
      }
      // --- table ---
      const tableTok = this.tryTable(s);
      if (tableTok) {
        this.tokens.push(tableTok);
        s = s.slice(tableTok.raw.length);
        continue;
      }
      // --- setext heading ---
      m = LHEADING.exec(s);
      if (m) {
        const text = m[1].trim();
        const depth = m[2][0] === '=' ? 1 : 2;
        const raw = stripTail(m[0], '\n');
        const tok2 = { type: 'heading', raw, depth, text };
        this.inlineQueue.push({ tokens: null, src: text, inLink: false, inRawBlock: false, owner: tok2 });
        tok2.tokens = null;
        this.tokens.push(tok2);
        s = s.slice(m[0].length);
        continue;
      }
      // --- paragraph (only when top) ---
      if (this.state.top) {
        m = PARA.exec(s);
        if (m) {
          const raw = m[0];
          const text = raw.charAt(raw.length - 1) === '\n' ? raw.slice(0, -1) : raw;
          const tok2 = { type: 'paragraph', raw, text };
          this.tokens.push(tok2);
          this.inlineQueue.push({ tokens: null, src: text, inLink: false, inRawBlock: false, owner: tok2 });
          tok2.tokens = null;
          s = s.slice(raw.length);
          continue;
        }
      }
      // --- text: a single line (the next line is re-lexed, so a nested
      // block start interrupts it); consecutive text lines merge
      m = /^[^\n]+/.exec(s);
      if (m) {
        const raw = m[0];
        const tok3 = { type: 'text', raw, text: raw };
        if (this.tokens.length > 0 && this.tokens[this.tokens.length - 1].type === 'text') {
          const prev = this.tokens[this.tokens.length - 1];
          prev.raw += '\n' + raw;
          prev.text += '\n' + raw;
          const q = this.inlineQueue[this.inlineQueue.length - 1];
          if (q) q.src = prev.text;
        } else {
          this.tokens.push(tok3);
          this.inlineQueue.push({ tokens: null, src: raw, inLink: false, inRawBlock: false, owner: tok3 });
          tok3.tokens = null;
        }
        s = s.slice(raw.length);
        continue;
      }
      // fallback: consume one char to avoid an infinite loop
      if (s) {
        const ch = s[0];
        const tok4 = { type: 'text', raw: ch, text: ch };
        this.tokens.push(tok4);
        this.inlineQueue.push({ tokens: null, src: ch, inLink: false, inRawBlock: false, owner: tok4 });
        tok4.tokens = null;
        s = s.slice(1);
      }
    }
    return this.tokens;
  }
  // --- blockquote (marked's frame loop) ---
  tokenizeBlockquote(s) {
    const m = BQ_GRAB.exec(s);
    if (!m) return null;
    let lines = stripTail(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      // one frame: `>` lines, plus lazy lines before the first `>` line
      let seenMarker = false;
      const frame = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (BQ_START.test(lines[p])) { frame.push(lines[p]); seenMarker = true; }
        else if (!seenMarker) frame.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const h = frame.join('\n');
      // strip markers: expand the whitespace after `>` column-aware, turn a
      // setext underline into an indented one, then drop `>` + one space
      const u = h.replace(BQ_MARKER_WS, (g, b, ws) => b + expandTab(ws, b.length))
                 .replace(BQ_SETEXT, '\n    $1')
                 .replace(BQ_SETEXT2, '');
      raw = raw ? raw + '\n' + h : h;
      text = text ? text + '\n' + u : u;
      const inner = new BlockLex();
      inner.links = this.links;
      inner.lex(u, true);
      Object.assign(this.links, inner.links);
      // marked lexes every frame into ONE shared token list, so a frame
      // whose first token is a paragraph/code/def/text merges into the
      // previous paragraph/text token — this is what makes lazy blockquote
      // lines join the paragraph above them, and indented code after a `>`
      // line become paragraph text
      let skipQueue = 0;
      if (inner.tokens.length > 0 && tokens.length > 0) {
        const first = inner.tokens[0];
        const prev = tokens[tokens.length - 1];
        const mergePara = first.type === 'paragraph' && prev.type === 'paragraph';
        const mergeCode = first.type === 'code' && (prev.type === 'paragraph' || prev.type === 'text');
        const mergeDef = first.type === 'def' && (prev.type === 'paragraph' || prev.type === 'text');
        const mergeText = first.type === 'text' && prev.type === 'text';
        if (mergePara || mergeCode || mergeDef || mergeText) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + first.raw;
          prev.text += '\n' + (first.type === 'def' ? first.raw : first.text);
          const q = this.inlineQueue[this.inlineQueue.length - 1];
          if (q) q.src = prev.text;
          inner.tokens.shift();
          // a paragraph/text first token carries a queue entry (the first
          // one); a code/def token does not
          if (first.type === 'paragraph' || first.type === 'text') skipQueue = 1;
        }
      }
      for (const q of inner.inlineQueue.slice(skipQueue)) this.inlineQueue.push(q);
      for (const t of inner.tokens) tokens.push(t);
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
      if (last && last.type === 'blockquote') {
        // the inner blockquote may absorb the following lazy lines: re-run
        // it on its raw plus the remaining lines with markers stripped
        const combined = last.raw + '\n' + lines.join('\n').replace(BQ_SETEXT2, '');
        const reTok = this.tokenizeBlockquote(combined);
        tokens[tokens.length - 1] = reTok;
        const rest = combined.substring(reTok.raw.length).replace(/^\n/, '');
        const restLines = rest ? rest.split('\n').length : 0;
        const kept = restLines ? lines.slice(0, -restLines) : lines;
        if (kept.length > 0) raw += '\n' + kept.join('\n');
        text = text.substring(0, text.length - last.text.length) + reTok.text;
        lines = lines.slice(kept.length);
        if (lines.length > 0 && BQ_START.test(lines[0])) continue;
        break;
      } else if (last && last.type === 'list') {
        // the inner list may absorb following lazy lines as continuations
        const combined = last.raw + '\n' + lines.join('\n');
        const reTok = this.tryList(combined);
        tokens[tokens.length - 1] = reTok;
        const extra = reTok.raw.length > last.raw.length
          ? combined.slice(last.raw.length + 1, reTok.raw.length).split('\n').length : 0;
        if (extra > 0) {
          const y = lines.slice(0, extra).join('\n');
          raw += '\n' + y;
          text += '\n' + y;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }
  // --- list (marked's list tokenizer) ---
  tryList(s) {
    const m = LIST_MARKER.exec(s);
    if (!m) return null;
    const bullet = m[1].trim();
    const ordered = bullet.length > 1;
    const start = ordered ? +bullet.slice(0, -1) : null;
    const bulletRe = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = listItemRegex(bulletRe);
    const items = [];
    let rest = s;
    let loose = false;
    let sawDoubleBlank = false;
    while (rest) {
      const im = itemRe.exec(rest);
      if (!im || HR.test(rest)) break;
      const itemStart = s.length - rest.length;
      rest = rest.substring(im[0].length);
      const g = im[2].split('\n', 1)[0];
      const b = im[1].length;
      // whitespace after the marker, expanded from the marker's column
      const markerLine = expandTab(g, b);
      const nextLine = rest.split('\n', 1)[0];
      const emptyItem = !markerLine.trim();
      let R = 0;
      let d = '';
      if (emptyItem) {
        R = b + 1;
      } else {
        R = markerLine.search(NON_SPACE);
        R = R > 4 ? 1 : R;
        d = markerLine.slice(R);
        R += b;
      }
      let consumedBlank = false;
      if (emptyItem && BLANK_LINE.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        consumedBlank = true;
      }
      if (!consumedBlank) {
        const nextBullet = nextBulletRegex(R);
        const hrR = hrRegex(R);
        const fencesR = fencesBeginRegex(R);
        const headingR = headingBeginRegex(R);
        const htmlR = htmlBeginRegex(R);
        const bqR = blockquoteBeginRegex(R);
        let line = markerLine;
        let isEmpty = emptyItem;
        while (rest) {
          const U = rest.split('\n', 1)[0];
          const f = U;
          const Z = f.replace(LEADING_SPACE_TAB, (ws) => expandTab(ws));
          if (fencesR.test(f) || headingR.test(f) || htmlR.test(f) || bqR.test(f) || nextBullet.test(f) || hrR.test(f)) break;
          if (Z.search(NON_SPACE) >= R || !f.trim()) {
            d += '\n' + Z.slice(R);
          } else {
            if (isEmpty || line.replace(TAB_GLOBAL, '    ').search(NON_SPACE) >= 4 || fencesR.test(line) || headingR.test(line) || htmlR.test(line) || hrR.test(line)) break;
            const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && LHEADING.test(`${line}\n${f}`)
              ? `    ${Z.replace(/^ {0,3}/, '')}` : f;
            d += '\n' + qe;
          }
          isEmpty = !f.trim();
          rest = rest.substring(U.length + 1);
          line = Z.slice(R);
        }
      }
      const itemRaw = s.slice(itemStart, s.length - rest.length);
      if (!loose) {
        if (sawDoubleBlank) loose = true;
        else if (DOUBLE_BLANK_LINE.test(itemRaw)) sawDoubleBlank = true;
      }
      items.push({ type: 'list_item', raw: itemRaw, task: LIST_IS_TASK.test(d), checked: /^\[[xX]\]/.test(d), loose: false, text: d, tokens: [] });
    }
    if (items.length === 0) return null;
    const lastItem = items[items.length - 1];
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    const raw = s.slice(0, s.length - rest.length).trimEnd();
    // lex each item's text as non-top blocks; a space token holding a blank
    // line between blocks makes the list loose
    for (const item of items) {
      const inner = new BlockLex();
      inner.links = this.links;
      inner.lex(item.text, false);
      Object.assign(this.links, inner.links);
      for (const q of inner.inlineQueue) this.inlineQueue.push(q);
      item.tokens = inner.tokens;
      if (!loose) {
        const spaces = inner.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => ANY_LINE.test(t.raw))) loose = true;
      }
    }
    // task list: strip the checkbox from the item text and its first token
    for (const item of items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(LIST_REPLACE_TASK, '');
        first.raw = first.raw.replace(LIST_REPLACE_TASK, '');
        first.text = first.text.replace(LIST_REPLACE_TASK, '');
        const q = this.inlineQueue.find((qq) => qq.owner === first);
        if (q) q.src = first.text;
      }
    }
    if (loose) {
      for (const item of items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return { type: 'list', raw, ordered, start, items, loose };
  }
  // --- table (marked's table tokenizer) ---
  tryTable(s) {
    const m = TABLE_RE.exec(s);
    if (!m) return null;
    if (!TABLE_DELIM_TEST.test(m[2])) return null;
    const headerCells = splitCells(m[1]);
    const delimCells = splitCells(m[2].replace(TABLE_ALIGN_CHARS, ''));
    if (headerCells.length !== delimCells.length) return null;
    const align = delimCells.map((c) => {
      if (TABLE_ALIGN_RIGHT.test(c)) return 'right';
      if (TABLE_ALIGN_CENTER.test(c)) return 'center';
      if (TABLE_ALIGN_LEFT.test(c)) return 'left';
      return null;
    });
    const header = headerCells.map((c, i) => ({ text: c, align: align[i] }));
    const rows = [];
    if (m[3] && m[3].trim()) {
      for (const line of m[3].replace(/\n[ \t]*$/, '').split('\n')) {
        rows.push(splitCells(line, header.length).map((c, i) => ({ text: c, align: align[i] })));
      }
    }
    const tok = { type: 'table', raw: stripTail(m[0], '\n'), header, rows };
    const queueCell = (cell) => {
      const owner = { type: 'tablecell', text: cell.text, tokens: null };
      cell.tokens = null;
      this.inlineQueue.push({ tokens: null, src: cell.text, inLink: false, inRawBlock: false, owner });
      cell._owner = owner;
    };
    for (const h of header) queueCell(h);
    for (const r of rows) for (const c of r) queueCell(c);
    return tok;
  }
}
// ---------------------------------------------------------------------------
// Inline lexer
// ---------------------------------------------------------------------------
class InlineLex {
  constructor(links, state) {
    this.links = links || {};
    // link/raw-block state is shared across inline lexing calls on one
    // instance (marked's Lexer state): an unclosed `<a>` tag in one
    // paragraph suppresses autolinks in the next one
    this.state = state || { inLink: false, inRawBlock: false };
  }
  // masked source for the emphasis closer bound (marked's #n): reflink
  // labels of known links are hidden, escaped punctuation becomes `+`,
  // code spans keep their backticks but lose inner backticks, and whole
  // links / code spans / html are hidden behind `[aaa]` — so a delimiter
  // inside a link label cannot close an emphasis that starts before it
  maskSource(src) {
    let masked = src;
    if (src.includes('[')) {
      const maskReflink = (text) => text.replace(REFLINK_SEARCH, (match) => {
        const lastBracket = match.lastIndexOf('[');
        if (!Object.hasOwn(this.links, normLabel(match.slice(lastBracket + 1, -1)))) return match;
        if (lastBracket > 1 && match.charAt(0) !== '!') {
          const label = match.slice(1, lastBracket - 1);
          if (linkInText(label, this.links)) {
            return '[' + maskReflink(label) + '][' + 'a'.repeat(match.length - lastBracket - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match.length - 2) + ']';
      });
      masked = maskReflink(src);
    }
    masked = masked.replace(ANY_PUNCT_OUTSIDE_CODE, (n, code, punct) =>
      punct ? '+'.repeat(n.length) : code ? code + n.slice(code.length, -code.length).replace(/`/g, '+') + code : n);
    BLOCK_SKIP.lastIndex = 0;
    masked = masked.replace(BLOCK_SKIP, (n, s, r) => {
      const keep = r ? r.length : 0;
      return n.slice(0, keep) + '[' + 'a'.repeat(n.length - keep - 2) + ']';
    });
    return masked;
  }
  lexInline(src) {
    const tokens = [];
    const full = src;
    let s = src;
    let lastChar = '';
    let masked = null;
    let bounds = null;
    const getBounds = () => {
      if (bounds === null) {
        masked = /[*_~]/.test(full) ? this.maskSource(full) : full;
        bounds = lastCloserBounds(masked);
      }
      return bounds;
    };
    const linkParenPossible = s.includes(')');
    while (s) {
      let tok = null;
      // escape
      let m = INLINE_ESC.exec(s);
      if (m) {
        const text = m[1];
        tok = { type: 'escape', raw: m[0], text };
        s = s.slice(m[0].length);
        tokens.push(tok);
        // an escape is not a text token: marked's lastChar resets to ''
        lastChar = '';
        continue;
      }
      // tag (html); an <a> tag opens a link context, </a> closes it, and
      // <pre>/<code>/<kbd>/<script> opens a raw block
      m = INLINE_TAG.exec(s);
      if (m) {
        if (!this.state.inLink && START_A_TAG.test(m[0])) this.state.inLink = true;
        else if (this.state.inLink && END_A_TAG.test(m[0])) this.state.inLink = false;
        if (!this.state.inRawBlock && START_PRE_TAG.test(m[0])) this.state.inRawBlock = true;
        else if (this.state.inRawBlock && END_PRE_TAG.test(m[0])) this.state.inRawBlock = false;
        tok = { type: 'html', raw: m[0], text: m[0] };
        s = s.slice(m[0].length);
        tokens.push(tok);
        lastChar = '';
        continue;
      }
      // link
      if (linkParenPossible) {
        m = LINK.exec(s);
        if (m) {
          const isImage = s[0] === '!';
          const labelStart = isImage ? 2 : 1;
          let matchLen = m[0].length;
          let ok = !linkExtendsPastLabel(s, m[1], labelStart);
          if (ok) {
            const hrefRaw = m[2].trim();
            if (START_ANGLE.test(hrefRaw)) {
              if (!END_ANGLE.test(hrefRaw)) ok = false;
              else {
                const stripped = stripTail(hrefRaw.slice(0, -1), '\\');
                if ((hrefRaw.length - stripped.length) % 2 === 0) ok = false;
              }
            } else {
              const cut = parenBalance(hrefRaw, '()');
              if (cut === -2) ok = false;
              else if (cut > -1) {
                const h = (isImage ? 5 : 4) + m[1].length + cut;
                m[2] = m[2].substring(0, cut);
                m[0] = m[0].substring(0, h).trim();
                m[3] = '';
                matchLen = m[0].length;
              }
            }
          }
          if (ok) {
            const closing = stripTail(m[0].slice(0, -1), '\\');
            if ((m[0].length - closing.length) % 2 === 0) ok = false;
          }
          if (ok) {
            let href = m[2].trim();
            if (START_ANGLE.test(href)) href = href.slice(1, -1);
            href = href.replace(ANY_PUNCT, '$1');
            let title = null;
            if (m[3]) title = m[3].slice(1, -1).replace(ANY_PUNCT, '$1');
            const out = this.outputLink(m[1], href, title, isImage);
            if (out) {
              out.raw = m[0];
              tok = out;
              s = s.slice(matchLen);
              tokens.push(tok);
              lastChar = '';
              continue;
            }
          }
        }
      }
      // reflink / nolink (shortcut reference)
      m = REFLINK.exec(s) || NOLINK.exec(s);
      if (m) {
        const isImage = s[0] === '!';
        const labelStart = isImage ? 2 : 1;
        if (!linkExtendsPastLabel(s, m[1], labelStart)) {
          const link = this.links[normLabel(m[2] || m[1])];
          if (!link) {
            // no such link: the `[` (or `!`) is literal text; the rest is
            // re-lexed, so `[foo]` after a `!` can still form a link.
            // marked does not count this fallback text for lastChar.
            const prefix = s[0];
            tokens.push({ type: 'text', raw: prefix, text: prefix });
            s = s.slice(1);
            lastChar = '';
            continue;
          }
          const out = this.outputLink(m[1], link.href, link.title, isImage);
          if (out) {
            out.raw = m[0];
            tok = out;
            s = s.slice(m[0].length);
            tokens.push(tok);
            lastChar = '';
            continue;
          }
        }
      }
      // emStrong (the scan runs on the masked source: getBounds fills
      // `masked` first, and tryEmStrong scans `masked`)
      if (s[0] === '*' || s[0] === '_') {
        const gb = getBounds();
        const em = this.tryEmStrong(s, masked, lastChar, gb);
        if (em === 'NO_CLOSER') {
          const lit = s[0];
          tokens.push({ type: 'text', raw: lit, text: lit });
          s = s.slice(1);
          lastChar = lit;
          continue;
        }
        if (em) {
          if (em.leading > 0) {
            const lit = em.delim.repeat(em.leading);
            tokens.push({ type: 'text', raw: lit, text: lit });
          }
          s = s.slice(em.leading + em.raw.length);
          tokens.push(em.tok);
          lastChar = '';
          continue;
        }
        // opener cannot open: the whole delimiter run is literal text
        let runLen = 0;
        while (runLen < s.length && s[runLen] === s[0]) runLen++;
        const lit = s.slice(0, runLen);
        tokens.push({ type: 'text', raw: lit, text: lit });
        s = s.slice(runLen);
        lastChar = lit[lit.length - 1];
        continue;
      }
      // codespan
      m = INLINE_CODE.exec(s);
      if (m) {
        let text = m[2].replace(/\n/g, ' ');
        if (text.length > 1 && text.startsWith(' ') && text.endsWith(' ') && !/^\s+$/.test(text)) text = text.slice(1, -1);
        tok = { type: 'codespan', raw: m[0], text };
        s = s.slice(m[0].length);
        tokens.push(tok);
        lastChar = '';
        continue;
      }
      // br
      m = INLINE_BR.exec(s);
      if (m) {
        tok = { type: 'br', raw: m[0] };
        s = s.slice(m[0].length);
        tokens.push(tok);
        lastChar = '';
        continue;
      }
      // del (same masked-scan rule as emStrong)
      if (s[0] === '~') {
        const gb = getBounds();
        const del = this.tryDel(s, masked, lastChar, gb);
        if (del) {
          if (del.leading > 0) {
            const lit = '~'.repeat(del.leading);
            tokens.push({ type: 'text', raw: lit, text: lit });
          }
          s = s.slice((del.leading || 0) + del.raw.length);
          tokens.push(del.tok);
          lastChar = '';
          continue;
        }
      }
      // autolink
      m = AUTOLINK.exec(s);
      if (m) {
        let href, text;
        if (m[2] === '@') {
          href = 'mailto:' + m[1];
          text = m[1];
        } else {
          href = m[1];
          text = m[1];
        }
        tok = { type: 'link', raw: m[0], href, title: null, text, tokens: null, autolink: true };
        s = s.slice(m[0].length);
        tokens.push(tok);
        lastChar = '';
        continue;
      }
      // url (only when not inside a link)
      if (!this.state.inLink) {
        m = URL_EXT.exec(s);
        if (m) {
          let href, text;
          if (m[2] === '@') {
            href = 'mailto:' + m[0];
            text = m[0];
          } else if (m[1] === 'www.') {
            href = 'http://' + m[0];
            text = m[0];
          } else {
            href = m[0];
            text = m[0];
          }
          // backpedal: strip trailing punctuation until the match is stable
          let prev;
          do {
            prev = text;
            const bp = BACKPEDAL.exec(text);
            if (bp) {
              const keep = bp[0];
              const cut = text.length - keep.length;
              if (cut > 0) {
                text = keep;
                href = href.slice(0, href.length - cut);
              }
            }
          } while (text !== prev && text.length > 0);
          if (text) {
            tok = { type: 'link', raw: m[0].slice(0, text.length), href, title: null, text, tokens: null, autolink: true };
            s = s.slice(text.length);
            tokens.push(tok);
            lastChar = '';
            continue;
          }
        }
      }
      // text
      m = INLINE_TEXT.exec(s);
      if (m) {
        const raw = m[0];
        const text = raw;
        if (tokens.length > 0 && tokens[tokens.length - 1].type === 'text') {
          const prev = tokens[tokens.length - 1];
          prev.raw += raw;
          prev.text += raw;
        } else {
          tokens.push({ type: 'text', raw, text, escaped: this.state.inRawBlock });
        }
        lastChar = raw[raw.length - 1] || '';
        if (!lastChar || lastChar === '_') lastChar = '';
        s = s.slice(raw.length);
        continue;
      }
      // fallback: a single char as text
      const ch = s[0];
      if (tokens.length > 0 && tokens[tokens.length - 1].type === 'text') {
        const prev = tokens[tokens.length - 1];
        prev.raw += ch;
        prev.text += ch;
      } else {
        tokens.push({ type: 'text', raw: ch, text: ch, escaped: this.state.inRawBlock });
      }
      lastChar = ch === '_' ? '' : ch;
      s = s.slice(1);
    }
    return tokens;
  }
  outputLink(labelText, href, title, isImage) {
    const text = labelText.replace(OUTPUT_LINK_REPLACE, '$1');
    // marked's De: the label is lexed with inLink=true, then the state is
    // restored — a tag inside the label must not leak out
    const savedLink = this.state.inLink, savedRaw = this.state.inRawBlock;
    this.state.inLink = true;
    const inner = new InlineLex(this.links, this.state);
    const innerToks = inner.lexInline(text);
    this.state.inLink = savedLink;
    this.state.inRawBlock = savedRaw;
    // a non-image link whose label contained a (non-autolink) link is dropped
    const hasLink = (toks) => {
      for (const t of toks) {
        if (t.type === 'link' && !t.autolink) return true;
        if (t.tokens && hasLink(t.tokens)) return true;
      }
      return false;
    };
    if (!isImage && hasLink(innerToks)) return undefined;
    if (isImage) {
      return { type: 'image', raw: '', href, title, text, tokens: innerToks };
    }
    return { type: 'link', raw: '', href, title, text, tokens: innerToks };
  }
  // emphasis / strong: marked's emStrong, translated directly — a single
  // left-to-right scan over the right-delimiter regex with an m counter
  // (skip groups add, closers subtract) and the f (rule-of-3) counter.
  // The scan runs over the REAL source; only the closer bound comes from
  // the masked source (the last run of the delimiter whose preceding char
  // is not whitespace, in the full inline source).
  tryEmStrong(s, full, lastChar, bounds) {
    const m = EM_L_DELIM.exec(s);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
    const delim = s[0];
    if (delim !== '*' && delim !== '_') return null;
    const o = lastChar === delim;
    const i = full.length - s.length;
    let l = i;
    for (; l > 0 && full[l - 1] === delim;) l--;
    const p = l > 0 ? [...full.slice(Math.max(0, l - 2), l)].at(-1) ?? '' : '';
    const h = p === '*' || p === '_' || PUNCT_SINGLE.test(p);
    let n = lastChar;
    if (l < i) n = p;
    const u = l < i ? h : PUNCT_SINGLE.test(n);
    if (m[4] && UNICODE_ALNUM.test(n)) return null;
    const d = m[1] || m[3] || '';
    if (!d || !n || u) {
      const k = [...m[0]].length - 1;
      let mm = k;
      let f = 0;
      const y = i - l + k;
      const R = p !== '' && p.trim() !== '' && (!!d || (delim === '*' && !h));
      const v = bounds[delim];
      const Q = i + k;
      if (v < Q) return 'NO_CLOSER';
      // the scan runs on the MASKED source (marked passes the masked full
      // source as `t`): escapes become `++` and code spans become `[a]`,
      // so a delimiter hidden inside them can never close. `full` here is
      // the masked source; `s` is the real remaining source (same length,
      // so the scan indices apply to both)
      const slice = full.slice(i + k);
      const ee = v - Q;
      const re = delim === '*' ? EM_R_DELIM_AST : EM_R_DELIM_UND;
      re.lastIndex = 0;
      let rm;
      while ((rm = re.exec(slice)) !== null && !(rm.index > ee)) {
        const g = rm[1] || rm[2] || rm[3] || rm[4] || rm[5] || rm[6];
        if (!g) {
          if (rm[0].length === 0) re.lastIndex++;
          continue;
        }
        let b = [...g].length;
        if (rm[3] || rm[4]) { mm += b; continue; }
        else if (rm[5] || rm[6] || R) {
          if (o && (rm[5] || rm[6])) break;
          if (y % 3 && !((y + b) % 3)) { f += b; continue; }
        }
        mm -= b;
        if (mm > 0) continue;
        b = Math.min(b, b + mm + f);
        const te = [...rm[0]][0].length;
        const raw = s.slice(0, k + rm.index + te + b);
        const use = Math.min(k, b);
        let content, tok;
        if (use % 2 === 1) {
          content = raw.slice(1, -1);
          if (!content) return null;
          // the em content is lexed with the same (shared) lexer state
          const inner = new InlineLex(this.links, this.state);
          const innerToks = inner.lexInline(content);
          tok = { type: 'em', raw, text: content, tokens: innerToks };
        } else {
          content = raw.slice(2, -2);
          if (!content) return null;
          const inner = new InlineLex(this.links, this.state);
          const innerToks = inner.lexInline(content);
          tok = { type: 'strong', raw, text: content, tokens: innerToks };
        }
        return { raw, tok, leading: 0, delim };
      }
      return 'NO_CLOSER';
    }
    return null;
  }
  // strikethrough: marked's del, translated directly — the closer must be
  // exactly the opener's run length, with the same m/f-style counter
  tryDel(s, full, lastChar, bounds) {
    const m = DEL_L_DELIM.exec(s);
    if (!m) return null;
    if (!(m[1] || '') || !lastChar || PUNCT_SINGLE.test(lastChar)) {
      const o = [...m[0]].length - 1;
      const u = bounds['~'];
      const i = full.length - s.length;
      const d = i + o;
      if (u < d) return null;
      const slice = full.slice(i + o);
      const k = u - d;
      const re = DEL_R_DELIM;
      re.lastIndex = 0;
      let rm;
      let p = o;
      while ((rm = re.exec(slice)) !== null && !(rm.index > k)) {
        const g = rm[1] || rm[2] || rm[3] || rm[4] || rm[5] || rm[6];
        if (!g) {
          if (rm[0].length === 0) re.lastIndex++;
          continue;
        }
        let l = [...g].length;
        if (l !== o) continue;
        if (rm[3] || rm[4]) { p += l; continue; }
        p -= l;
        if (p > 0) continue;
        l = Math.min(l, l + p);
        const te = [...rm[0]][0].length;
        const raw = s.slice(0, o + rm.index + te + l);
        const content = raw.slice(o, -o);
        if (!content) return null;
        const inner = new InlineLex(this.links, this.state);
        const innerToks = inner.lexInline(content);
        return { raw, tok: { type: 'del', raw, text: content, tokens: innerToks }, leading: 0 };
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
function plainText(tokens) {
  let out = '';
  for (const t of tokens) {
    if (t.type === 'text' || t.type === 'escape' || t.type === 'codespan') out += t.text || '';
    else if (t.type === 'image') out += t.text || '';
    else if (t.tokens) out += plainText(t.tokens);
    else if (t.text) out += t.text;
  }
  return out;
}
function renderInline(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape':
      case 'text': {
        if (t.tokens) { out += renderInline(t.tokens); break; }
        if (t.escaped) { out += t.text; break; }
        out += escHtml(decodeNumRefs(t.text || t.raw), false);
        break;
      }
      case 'html': out += t.text; break;
      case 'link': {
        const href = cleanHref(t.href || '');
        if (href === null) { out += t.tokens ? renderInline(t.tokens) : escHtml(t.text, true); break; }
        const title = t.title ? ' title="' + escHtml(t.title, false) + '"' : '';
        const inner = t.autolink ? escHtml(t.text, true) : (t.tokens ? renderInline(t.tokens) : escHtml(t.text, true));
        out += '<a href="' + escHtml(href, false) + '"' + title + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const href = cleanHref(t.href || '');
        const alt = t.tokens ? plainText(t.tokens) : (t.text || '');
        if (href === null) { out += escHtml(alt, true); break; }
        const title = t.title ? ' title="' + escHtml(t.title, false) + '"' : '';
        out += '<img src="' + escHtml(href, false) + '" alt="' + escHtml(alt, true) + '"' + title + '>';
        break;
      }
      case 'strong': out += '<strong>' + renderInline(t.tokens || []) + '</strong>'; break;
      case 'em': out += '<em>' + renderInline(t.tokens || []) + '</em>'; break;
      case 'codespan': out += '<code>' + escHtml(t.text, true) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'del': out += '<del>' + renderInline(t.tokens || []) + '</del>'; break;
      default: out += escHtml(t.raw || '', false); break;
    }
  }
  return out;
}
function renderBlock(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': {
        const inner = t.tokens ? renderInline(t.tokens) : escHtml(t.text, false);
        out += '<h' + t.depth + '>' + inner + '</h' + t.depth + '>\n';
        break;
      }
      case 'code': {
        // code text loses exactly one trailing newline, then gains one back
        let text = t.text || '';
        if (text) text = text.replace(/\n$/, '') + '\n';
        const esc = escHtml(text, true);
        if (t.lang) out += '<pre><code class="language-' + escHtml(t.lang, false) + '">' + esc + '</code></pre>\n';
        else out += '<pre><code>' + esc + '</code></pre>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (const h of t.header) {
          const inner = h._owner && h._owner.tokens ? renderInline(h._owner.tokens) : escHtml(h.text, false);
          out += h.align ? '<th align="' + h.align + '">' + inner + '</th>\n' : '<th>' + inner + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (t.rows.length > 0) {
          out += '<tbody>';
          for (const row of t.rows) {
            out += '<tr>\n';
            for (const c of row) {
              const inner = c._owner && c._owner.tokens ? renderInline(c._owner.tokens) : escHtml(c.text, false);
              out += c.align ? '<td align="' + c.align + '">' + inner + '</td>\n' : '<td>' + inner + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      case 'blockquote': out += '<blockquote>\n' + renderBlock(t.tokens) + '</blockquote>\n'; break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const startAttr = (t.ordered && t.start !== null && t.start !== 1) ? ' start="' + t.start + '"' : '';
        out += '<' + tag + startAttr + '>\n';
        for (const item of t.items) {
          out += '<li>';
          if (item.task && item.loose && item.tokens.length > 0 && item.tokens[0].type === 'paragraph') {
            const p = item.tokens[0];
            out += '<p><input' + (item.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ' + (p.tokens ? renderInline(p.tokens) : escHtml(p.text, false)) + '</p>\n';
            out += renderBlock(item.tokens.slice(1));
          } else {
            if (item.task) {
              out += '<input' + (item.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ';
            }
            out += renderBlock(item.tokens);
          }
          out += '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 'list_item': out += renderBlock(t.tokens); break;
      case 'html': out += t.text; break;
      case 'def': break;
      case 'paragraph': {
        const inner = t.tokens ? renderInline(t.tokens) : escHtml(t.text, false);
        out += '<p>' + inner + '</p>\n';
        break;
      }
      case 'text': {
        if (t.tokens) out += renderInline(t.tokens);
        else if (t.escaped) out += t.text;
        else out += escHtml(t.text, false);
        break;
      }
      default: break;
    }
  }
  return out;
}
// ---------------------------------------------------------------------------
// parse(markdown) -> HTML (marked 18.1.3-compatible, GFM defaults)
// ---------------------------------------------------------------------------
// Tabs are NOT expanded up front: marked only expands them at the spots the
// spec expands them (blockquote markers, list markers and continuations,
// indented-code removal, fence compensation). Everywhere else a tab stays
// literal — in paragraph text, in code, and in a lazy line.
function parse(markdown) {
  const src = String(markdown).replace(CARRIAGE_RETURN, '\n');
  const lex = new BlockLex();
  const tokens = lex.lex(src, true);
  // resolve deferred inline tokens (after the full block pass, so later
  // link definitions resolve)
  const il = new InlineLex(lex.links);
  for (const q of lex.inlineQueue) {
    if (q.owner) {
      q.owner.tokens = il.lexInline(q.src);
    }
  }
  // (table cells are already in the inline queue, in block order, so they
  // are resolved above with the lexer state at their position)
  return renderBlock(tokens);
}
export { parse };
export default parse;
