// parse.js — original Markdown parser producing marked 18.1.3-compatible HTML
// (GFM defaults: gfm true, breaks false, pedantic false, async false).
// Written from scratch: block lexer -> inline lexer (delimiter runs) -> renderer.
// No dependencies. Deterministic. See BUILD_LOG.md for design notes.
// ---------------------------------------------------------------------------
// Helpers (mirroring marked's semantics; original implementations)
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
  // decode ONLY valid numeric character references (<=7 decimal digits, <=6 hex digits);
  // named entities and over-long refs pass through unchanged
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
function splitRow(row) {
  // split on unescaped pipes; only \| consumes the backslash (other escapes preserved for inline lexing)
  const cells = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\' && i + 1 < row.length && row[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}
function rtrimChar(s, ch) {
  let i = s.length;
  while (i > 0 && s[i - 1] === ch) i--;
  return s.slice(0, i);
}
function trimBlankTail(s) {
  // drop trailing blank lines if more than 1 (keep a single trailing newline)
  const lines = s.split('\n');
  let end = lines.length;
  let blanks = 0;
  while (end > 0 && lines[end - 1].trim() === '') { blanks++; end--; }
  if (blanks > 1) return lines.slice(0, end).join('\n');
  return s;
}
function normLabel(s) {
  // Unicode case folding: capital sharp S (ẞ) and sharp S (ß) fold to "ss"
  return s.trim().replace(/\s+/g, ' ').replace(/[\u1E9E\u00DF]/g, 'ss').toLowerCase();
}
function closeBracket(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}
function expandTabs(s, col) {
  return s.replace(/\t/g, () => {
    const spaces = 4 - (col % 4);
    col += spaces;
    return ' '.repeat(spaces);
  });
}
// ---------------------------------------------------------------------------
// Block patterns
// ---------------------------------------------------------------------------
const BLANK_RUN = /^[ \t]*(?:\n|$)+/;
const INDENT_CODE = /^ {4}[^\n]+(?:\n(?: {4}[^\n]+|\s*(?:\n|$))*)?/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})([^\n]*?)(?:\n|$)/;
const HR = /^ {0,3}((?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})(?:\n|$)/;
const ATX = /^( {0,3})(#{1,6})(?:[ \t]+([^\n]*?))?(?:[ \t]+#+)?[ \t]*(?:\n|$)/;
const TABLE_DELIM = /^ {0,3}\|? *(?:-+:?|:-+:?) *(?:\| *(?:-+:?|:-+:?) *)*\|? *(?:\n|$)/;
const SETEXT_LINE = /^ {0,3}(=+|-+)[ \t]*(?:\n|$)/;
const DEF = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
const HTML_BLOCK = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i;
const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const FRAG_HR = '(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}';
const FRAG_FENCE = '(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)';
const FRAG_HTML_TAG = '(?:<\\/?(?:' + TAG_LIST + ')(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const FRAG_BQ_LIST_ITEM = '(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)';
const FRAG_PARA_LIST_ITEM = '(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
const FRAG_ATX = ' {0,3}#{1,6}(?:\\s|$)';
function paraSrc(withTable) {
  const blockStart = ' {0,3}(' + FRAG_HR + ')(?:\\n+|$)|' + FRAG_ATX + '| {0,3}>| {0,3}' + FRAG_FENCE + '[^\\n]*(?:\\n|$)| {0,3}' + FRAG_PARA_LIST_ITEM + '| {0,3}' + FRAG_HTML_TAG;
  const tablePart = withTable ? '| *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}(' + FRAG_HR + ')(?:\\n+|$)|' + FRAG_ATX + '| {0,3}>|(?: {4}| {0,3}\\t)[^\\n]| {0,3}' + FRAG_FENCE + '[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}' + FRAG_HTML_TAG + ').*(?:\\n|$))*)\\n*|$)' : '';
  return '^([^\\n]+(?:\\n(?!' + blockStart + tablePart + '|[ \\t]+\\n)[^\\n]+)*)';
}
const PARA = new RegExp(paraSrc(true));
const PARA_BQ = new RegExp(paraSrc(false));
const BQ_GRAB = new RegExp('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?! {0,3}(' + FRAG_HR + ')(?:\\n+|$)|' + FRAG_ATX + '| {0,3}>| {0,3}' + FRAG_FENCE + '[^\\n]*(?:\\n|$)| {0,3}' + FRAG_BQ_LIST_ITEM + '| {0,3}' + FRAG_HTML_TAG + '|[ \\t]+\\n)[^\\n]+)*))|[^\\n]*)(?:\\n|$))+');
const LIST_MARKER = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
// ---------------------------------------------------------------------------
// Inline patterns (direct regex literals)
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
// Masking / delimiter patterns
// ---------------------------------------------------------------------------
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]' +
  '\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)' +
  '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>', 'g');
const INLINE_TEXT = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;
const EM_L_DELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const EM_R_DELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?![*])(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?![*])(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?![*])(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_R_DELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const DEL_L_DELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const DEL_R_DELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const PUNCT_SINGLE = /^((?![*_])[\s\p{P}\p{S}])/u;
// ---------------------------------------------------------------------------
// Block lexer
// ---------------------------------------------------------------------------
class BlockLex {
  constructor() {
    this.tokens = [];
    this.inlineQueue = []; // {tokens, src, inLink, inRawBlock} — inline lex deferred
    this.links = {};       // normalized label -> {href, title}
    this.state = { top: true, inLink: false, inRawBlock: false };
    this.lastParagraphClipped = false;
  }
  // entry: lex a source string into tokens (top-level or nested)
  lex(src, top) {
    this.state.top = top !== false;
    let s = src;
    while (s) {
      let tok = null;
      // --- space ---
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
      if (m && (!this.state.top || true)) {
        const raw = m[0];
        // must not be interrupted by a paragraph (handled by paragraph rule first)
        const text = trimBlankTail(raw.replace(/^(?: {0,3}\t| {1,4})/gm, ''));
        tok = { type: 'code', raw, text, lang: null };
        if (this.tokens.length > 0) {
          const prev = this.tokens[this.tokens.length - 1];
          if (prev.type === 'paragraph' || prev.type === 'text') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
            // merged code text must not carry a trailing newline into the
            // paragraph/text (trimBlankTail keeps a single trailing newline,
            // which belongs to the code token's own rendering, not the merge)
            prev.text += '\n' + text.replace(/\n$/, '');
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
        const indent = m[1].length;
        const fence = m[2];
        const ch = fence[0];
        const infoRaw = m[3].trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
        // backtick fences: info string must not contain a backtick
        if (ch === '`' && infoRaw.includes('`')) {
          // not a fence; fall through to paragraph/text
        } else {
        const info = infoRaw.split(/\s+/)[0] || '';
        const openLen = fence.length;
        const rest = s.slice(m[0].length);
        // find closer
        let closeIdx = -1, closeLen = 0;
        const lines = rest.split('\n');
        let acc = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const cm = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
          // raw ends at the closing fence (its trailing newline belongs to
          // the following space/newline handling, so a blank line after the
          // fence still produces a space token)
          if (cm && cm[2][0] === ch && cm[2].length >= openLen) { closeIdx = acc; closeLen = line.length; break; }
          acc += line.length + 1;
        }
        let raw, text;
        if (closeIdx >= 0) {
          raw = m[0] + rest.slice(0, closeIdx + closeLen);
          text = rest.slice(0, closeIdx);
        } else {
          raw = s;
          text = rest;
        }
        // indentCodeCompensation: strip up to `indent` spaces from each line
        if (indent > 0) {
          text = text.split('\n').map(l => {
            let n = 0;
            while (n < indent && n < l.length && l[n] === ' ') n++;
            return l.slice(n);
          }).join('\n');
        }
        // trailing newline: the fence text loses exactly one trailing
        // newline (the one before the closing fence); `foo\n\n` -> `foo\n`,
        // `b\n\n\n` -> `b\n\n` (cm-318)
        text = text.replace(/\n$/, '');
        this.tokens.push({ type: 'code', raw, text, lang: info || null });
        s = s.slice(raw.length);
        continue;
        } // end else (valid fence)
      }
      // --- ATX heading ---
      m = ATX.exec(s);
      if (m) {
        let text = m[3] !== undefined ? m[3] : '';
        text = text.trim();
        if (text.endsWith('#')) {
          // strip the trailing '#' run only if what precedes it is empty or
          // ends with space/tab (a '#' preceded by other text is literal)
          const stripped = text.replace(/#+[ \t]*$/, '');
          if (stripped === '' || /[ \t]$/.test(stripped)) {
            text = stripped.trim();
          }
        }
        const raw = m[0].replace(/\n$/, '');
        this.tokens.push({ type: 'heading', raw, depth: m[2].length, text });
        this.inlineQueue.push({ tokens: null, src: text, inLink: false, inRawBlock: false, owner: this.tokens[this.tokens.length - 1] });
        this.tokens[this.tokens.length - 1].tokens = null;
        s = s.slice(m[0].length);
        continue;
      }
      // --- hr ---
      m = HR.exec(s);
      if (m) {
        this.tokens.push({ type: 'hr', raw: m[0] });
        s = s.slice(m[0].length);
        continue;
      }
      // --- blockquote ---
      m = BQ_GRAB.exec(s);
      if (m) {
        let raw = m[0];
        // strip markers (tab-aware); the vendor's blockquote raw ends at the
        // last `>` line, so the inner content has no trailing newline
        let content = raw.split('\n').map(stripBQLine).join('\n');
        if (content.endsWith('\n')) content = content.slice(0, -1);
        // a lazy line (no '>') inside an open fenced code block ends the
        // blockquote: the fence content must carry the marker, so the fence
        // closes (unterminated) at the end of the blockquote content
        {
          const rawLines = raw.split('\n');
          let fCh = '', fLen = 0, cutAt = -1;
          for (let i = 0; i < rawLines.length; i++) {
            const cl = stripBQLine(rawLines[i]);
            const hasMarker = /^ {0,3}>/.test(rawLines[i]);
            if (fCh) {
              if (!hasMarker) { cutAt = i; break; }
              const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(cl);
              if (cm && cm[1][0] === fCh && cm[1].length >= fLen) { fCh = ''; fLen = 0; }
            } else {
              const om = /^ {0,3}(`{3,}|~{3,})[^`\n]*$/.exec(cl);
              if (om) {
                const info = cl.slice(cl.indexOf(om[1]) + om[1].length);
                if (om[1][0] === '`' && info.includes('`')) continue;
                fCh = om[1][0]; fLen = om[1].length;
              }
            }
          }
          if (cutAt >= 0) {
            raw = rawLines.slice(0, cutAt).join('\n');
            content = raw.split('\n').map(stripBQLine).join('\n');
            if (content.endsWith('\n')) content = content.slice(0, -1);
          }
        }
        // setext-replace: indent = / - underlines inside blockquote
        content = content.replace(/^([ \t]*)((?:=+|-+)[ \t]*)$/gm, '$1    $2');
        let inner = new BlockLex();
        inner.links = this.links;
        inner.lex(content, true);
        // if the blockquote's last block cannot absorb a lazy continuation
        // (code/heading/hr/html/table), trailing lazy lines (no '>') do not
        // belong to it; truncate to the last '>' line. A trailing paragraph
        // absorbs lazy lines, so it is kept.
        const lastTok = inner.tokens[inner.tokens.length - 1];
        if (lastTok && (lastTok.type === 'code' || lastTok.type === 'heading' || lastTok.type === 'hr' || lastTok.type === 'html' || lastTok.type === 'table')) {
          const rawLines = raw.split('\n');
          let lastMarker = -1;
          for (let i = 0; i < rawLines.length; i++) {
            if (/^ {0,3}>/.test(rawLines[i])) lastMarker = i;
          }
          if (lastMarker >= 0 && lastMarker < rawLines.length - 1) {
            // drop trailing lazy lines (and the blank line that follows the last marker line, if any)
            let newRaw = rawLines.slice(0, lastMarker + 1).join('\n');
            // keep the trailing newline if the original had one after the last marker line
            if (rawLines[lastMarker + 1] !== undefined) newRaw += '\n';
            raw = newRaw;
            content = raw.split('\n').map(stripBQLine).join('\n');
            if (content.endsWith('\n')) content = content.slice(0, -1);
            content = content.replace(/^([ \t]*)((?:=+|-+)[ \t]*)$/gm, '$1    $2');
            inner = new BlockLex();
            inner.links = this.links;
            inner.lex(content, true);
          }
        }
        // merge links back
        Object.assign(this.links, inner.links);
        // lazy continuation lines keep their indent in the content (so they
        // don't look like block starts), but the rendered paragraph drops the
        // indent when the line is a list marker
        for (const t of inner.tokens) {
          if ((t.type === 'text' || t.type === 'paragraph') && t.text && t.text.includes('\n')) {
            const lines = t.text.split('\n');
            let changed = false;
            for (let li = 1; li < lines.length; li++) {
              const stripped = lines[li].replace(/^ +/, '');
              if (stripped !== lines[li] && /^(?:[*+-]|\d{1,9}[.)])[ \t]/.test(stripped)) {
                lines[li] = stripped;
                changed = true;
              }
            }
            if (changed) {
              t.text = lines.join('\n');
              t.raw = t.text;
              const q = inner.inlineQueue.find(qq => qq.owner === t);
              if (q) q.src = t.text;
            }
          }
        }
        // process inline queue of inner (deferred: share the queue)
        for (const q of inner.inlineQueue) this.inlineQueue.push(q);
        this.tokens.push({ type: 'blockquote', raw, tokens: inner.tokens });
        s = s.slice(raw.length);
        this.lastParagraphClipped = false;
        continue;
      }
      // --- list ---
      const listTok = this.tryList(s);
      if (listTok) {
        this.tokens.push(listTok);
        s = s.slice(listTok.raw.length);
        this.lastParagraphClipped = false;
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
        if (href.indexOf('(') >= 0 || href.indexOf(')') >= 0) {
          // unbalanced parens check (marked rejects if href has unbalanced parens and no angle brackets)
          let depth = 0, ok = true;
          for (let i = 0; i < href.length; i++) {
            if (href[i] === '(') depth++;
            else if (href[i] === ')') { depth--; if (depth < 0) { ok = false; break; } }
          }
          if (!ok || depth !== 0) { /* fall through to paragraph */ }
          else { if (!(label in this.links)) this.links[label] = { href, title }; this.tokens.push({ type: 'def', raw }); s = s.slice(raw.length); continue; }
        } else {
          if (!(label in this.links)) this.links[label] = { href, title };
          // def after paragraph/text merges
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
      }
      // --- table ---
      const tableTok = this.tryTable(s);
      if (tableTok) {
        this.tokens.push(tableTok);
        s = s.slice(tableTok.raw.length);
        this.lastParagraphClipped = false;
        continue;
      }
      // --- setext (lheading) via line scan ---
      const setext = this.trySetext(s);
      if (setext) {
        this.tokens.push(setext.tok);
        s = s.slice(setext.raw.length);
        this.lastParagraphClipped = false;
        continue;
      }
      // --- paragraph (only when top) ---
      if (this.state.top) {
        m = PARA.exec(s);
        if (m) {
          const raw = m[0];
          const text = m[1];
          const tok2 = { type: 'paragraph', raw, text };
          if (this.lastParagraphClipped) {
            // merge into previous paragraph
            const prev = this.tokens[this.tokens.length - 1];
            if (prev && prev.type === 'paragraph') {
              prev.raw += '\n' + raw;
              prev.text += '\n' + text;
              const q = this.inlineQueue[this.inlineQueue.length - 1];
              if (q) q.src = prev.text;
              this.lastParagraphClipped = false;
              s = s.slice(raw.length);
              continue;
            }
          }
          this.tokens.push(tok2);
          this.inlineQueue.push({ tokens: null, src: text, inLink: false, inRawBlock: false, owner: tok2 });
          tok2.tokens = null;
          this.lastParagraphClipped = false;
          s = s.slice(raw.length);
          continue;
        }
      }
      // --- text: single line only (vendor marked block.gfm.text is /^[^\n]+/);
      // the next line is re-lexed, so a nested list marker interrupts the
      // text (e.g. a `49.` list inside a list item), and consecutive text
      // lines merge via the merge branch below
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
      // fallback: consume one char to avoid infinite loop
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
  // --- list ---
  tryList(s) {
    const m = LIST_MARKER.exec(s);
    if (!m) return null;
    const bullet = m[1];
    const markerChar = bullet[bullet.length - 1];
    const ordered = markerChar === '.' || markerChar === ')';
    const start = ordered ? parseInt(bullet.replace(/^[ ]*/, '').replace(/[.)]$/, ''), 10) : null;
    const itemRe = ordered
      ? new RegExp('^( {0,3}\\d{1,9}\\' + markerChar + ')((?:[ \\t][^\\n]*)?(?:\\n|$))')
      : new RegExp('^( {0,3}' + markerChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')((?:[ \\t][^\\n]*)?(?:\\n|$))');
    const items = [];
    let raw = '';
    let rest = s;
    let first = true;
    while (rest) {
      // a thematic break interrupts the list (it is not a list item)
      if (!first && HR.test(rest)) break;
      const im = itemRe.exec(rest);
      if (!im) break;
      // continuation: collect lines belonging to this item
      const markerLen = im[1].length;
      let itemSrc = im[0];
      let after = rest.slice(im[0].length);
      // compute indent R (spaces after marker)
      let R = 0;
      const lineAfterRaw = (im[2] || '').replace(/\n$/, '');
      const lineAfter = lineAfterRaw.trim() === '' ? '' : lineAfterRaw;
      if (lineAfter) {
        const sp = lineAfter.match(/^[ \t]*/)[0];
        if (sp.length >= 5) R = markerLen + 1;
        else R = markerLen + sp.length;
      } else R = markerLen + 1;
      // gather continuation lines
      const lines = after ? after.split('\n') : [];
      let consumed = 0;
      let i = 0;
      let prevBlank = false;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') { itemSrc += line + '\n'; consumed += line.length + 1; i++; prevBlank = true; continue; }
        const ind = line.match(/^( *)/)[1].length;
        // an empty item ends at a blank line: indented content after the
        // blank line is a new block, not part of the empty item
        if (prevBlank && lineAfter === '' && ind >= R) break;
        if (ind >= R) { itemSrc += line.slice(R) + '\n'; consumed += line.length + 1; i++; prevBlank = false; continue; }
        // next item (same bullet)?
        if (itemRe.test(line)) break;
        // a different list marker ends this list
        if (/^( {0,3}(?:[*+-]|\d{1,9}[.)]))[ \t]/.test(line)) break;
        // fences/heading/html/hr/blockquote at indent < R stop
        if (/^( {0,3})(`{3,}|~{3,})/.test(line) || /^( {0,3})#{1,6}(?:\s|$)/.test(line) || /^( {0,3})>/.test(line) || HR.test(line)) break;
        // lazy line (only if item not empty and first line not indented >=4 and not fence/heading/html/hr, and not after a blank line)
        if (!prevBlank && itemSrc.trim() !== '' && !/^( {4}|\t)/.test(im[0])) {
          // setext hack
          if (/^ {0,3}(?:=+|-+) *$/.test(line) && itemSrc.split('\n')[0].trim() !== '') {
            itemSrc += '    ' + line + '\n';
          } else {
            itemSrc += line + '\n';
          }
          consumed += line.length + 1; i++; prevBlank = false; continue;
        }
        break;
      }
      after = after.slice(consumed);
      raw += rest.slice(0, rest.length - after.length);
      // build item tokens: strip the content indent R from the first line
      const firstLineEnd = itemSrc.indexOf('\n');
      const firstLine = firstLineEnd >= 0 ? itemSrc.slice(0, firstLineEnd) : itemSrc;
      const restLines = firstLineEnd >= 0 ? itemSrc.slice(firstLineEnd) : '';
      const itemText = firstLine.slice(Math.min(R, firstLine.length)) + restLines;
      const inner = new BlockLex();
      inner.links = this.links;
      inner.lex(itemText.replace(/\n$/, ''), false);
      Object.assign(this.links, inner.links);
      for (const q of inner.inlineQueue) this.inlineQueue.push(q);
      // task list
      let task = false, checked = false;
      let itemTokens = inner.tokens;
      // strip the item content indent from continuation lines of top-level text
      // tokens (lazy lines keep their indent in itemSrc so they don't look like
      // block starts, but the rendered text drops it)
      for (const t of itemTokens) {
        if (t.type === 'text' && t.text && t.text.includes('\n')) {
          const lines = t.text.split('\n');
          let changed = false;
          for (let li = 1; li < lines.length; li++) {
            const msp = lines[li].match(/^( *)/)[1].length;
            if (msp > 0) { lines[li] = lines[li].slice(Math.min(R, msp)); changed = true; }
          }
          if (changed) {
            t.text = lines.join('\n');
            t.raw = t.text;
            const q = this.inlineQueue.find(qq => qq.owner === t);
            if (q) q.src = t.text;
          }
        }
      }
      if (itemTokens.length > 0) {
        const firstTok = itemTokens[0];
        const txt = firstTok.text || firstTok.raw || '';
        const tm = /^\[([ xX])\] /.exec(txt);
        if (tm) {
          task = true; checked = tm[1] !== ' ';
          firstTok.text = txt.slice(4);
          firstTok.raw = firstTok.raw.slice(4);
          const q = this.inlineQueue.find(qq => qq.owner === firstTok);
          if (q) q.src = firstTok.text;
        }
      }
      // loose detection: blank line between top-level blocks of this item only
      // (blank lines inside nested blocks, a leading blank line, or trailing
      // blank lines after the last block do not make it loose)
      const loose = itemTokens.some((t, idx) => t.type === 'space' && t.raw.length > 1 && idx > 0 && idx < itemTokens.length - 1);
      items.push({ type: 'list_item', raw: itemSrc, tokens: itemTokens, task, checked, loose });
      rest = after;
      first = false;
      if (!rest) break;
      // next item must match itemRe at start
      if (!itemRe.test(rest)) break;
    }
    if (items.length === 0) return null;
    // loose: if any item loose, all loose; also loose if a blank line separates items
    let anyLoose = items.some(it => it.loose);
    for (let idx = 0; idx < items.length - 1; idx++) {
      if (/\n[ \t]*\n\s*$/.test(items[idx].raw)) { anyLoose = true; break; }
    }
    if (anyLoose) {
      for (const it of items) {
        it.loose = true;
        for (const t of it.tokens) {
          if (t.type === 'text') { t.type = 'paragraph'; }
        }
      }
    }
    // trailing blank lines belong to the enclosing level (they separate this
    // list from the next block), not to the list itself — otherwise a blank
    // line after a nested list never produces a space token at the outer level
    raw = raw.replace(/\n+$/, '');
    return { type: 'list', raw, ordered, start, items, loose: anyLoose };
  }
  // --- table ---
  tryTable(s) {
    const m = /^ *([^\n].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}(?:#{1,6}[ \t]|>|`{3,}|~~~|\d{1,9}[.)][ \t]|[*+-][ \t]|<(?:!--|\?|![A-Za-z]|!\[CDATA\[|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$))| {4}).*(?:\n|$))*)\n*|$)/.exec(s);
    if (!m) return null;
    if (!/[|:]/.test(m[2])) return null;
    const headerCells = splitRow(m[1].replace(/^\|/, '').replace(/\|$/, ''));
    const delimCells = splitRow(m[2].replace(/^\|/, '').replace(/\|$/, ''));
    if (headerCells.length !== delimCells.length) return null;
    const align = delimCells.map(c => {
      c = c.trim();
      if (/^:-+:$/.test(c)) return 'center';
      if (/^-+:$/.test(c)) return 'right';
      if (/^:-+$/.test(c)) return 'left';
      return null;
    });
    const rows = [];
    if (m[3]) {
      for (const line of m[3].split('\n')) {
        if (!line.trim()) continue;
        if (/^ {0,3}(?:#{1,6}\s|>|\* *\* *\*|_ *_ *_|- *- *-|`{3,}|~~~|\d{1,9}[.)]\s|[*+-]\s|<(?:!--|\?|![A-Za-z]|!\[CDATA\[|address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$))/.test(line)) break;
        if (/^ {4}/.test(line)) break;
        const cells = splitRow(line.replace(/^\|/, '').replace(/\|$/, ''));
        // truncate to header column count (extra cells ignored); pad short
        // rows with empty cells
        while (cells.length < headerCells.length) cells.push('');
        rows.push(cells.slice(0, headerCells.length));
      }
    }
    const raw = m[0];
    const header = headerCells.map((c, i) => ({ text: c.trim(), align: align[i] }));
    const body = rows.map(r => r.map((c, i) => ({ text: (c || '').trim(), align: align[i] })));
    // queue inline for header + cells
    const tok = { type: 'table', raw, header, rows: body };
    const queueCell = (cell) => {
      const owner = { type: 'tablecell', text: cell.text, tokens: null };
      cell.tokens = null;
      this.inlineQueue.push({ tokens: null, src: cell.text, inLink: false, inRawBlock: false, owner });
      cell._owner = owner;
    };
    for (const h of header) queueCell(h);
    for (const r of body) for (const c of r) queueCell(c);
    return tok;
  }
  // --- setext heading via line scan (multi-line text) ---
  trySetext(s) {
    const lines = s.split('\n');
    if (lines.length < 2) return null;
    const isBlockStart = (line) => {
      if (!line.trim()) return true;
      if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]/.test(line)) return true;
      if (/^ {4}/.test(line)) return true;
      if (/^( {0,3})(`{3,}|~{3,})/.test(line)) return true;
      if (/^ {0,3}>/.test(line)) return true;
      if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
      if (/^ {0,3}<[^\n>]+>$/.test(line)) return true;
      if (TABLE_DELIM.test(line)) return true;
      return false;
    };
    // first line must be a valid text line
    if (isBlockStart(lines[0])) return null;
    // collect text lines until the underline (or a block start / blank line)
    const textLines = [lines[0]];
    let ui = -1;
    for (let i = 1; i < lines.length; i++) {
      if (SETEXT_LINE.test(lines[i])) { ui = i; break; }
      if (isBlockStart(lines[i])) return null;
      textLines.push(lines[i]);
    }
    if (ui < 0) return null;
    const um = SETEXT_LINE.exec(lines[ui]);
    const depth = um[1][0] === '=' ? 1 : 2;
    const raw = textLines.join('\n') + '\n' + lines[ui];
    const text = textLines.join('\n').trim();
    const tok = { type: 'heading', raw, depth, text };
    this.inlineQueue.push({ tokens: null, src: text, inLink: false, inRawBlock: false, owner: tok });
    tok.tokens = null;
    return { tok, raw };
  }
}
// ---------------------------------------------------------------------------
// Inline lexer
// ---------------------------------------------------------------------------
class InlineLex {
  constructor(links) {
    this.links = links || {};
    this.maskedCache = new WeakMap();
  }
  // masked source for emphasis closer lookup
  emStrongMask(src) {
    // 1. mask reflinks (label content of a reflink whose ref is a known link
    // -> a's, keeping the brackets, so a `*` inside the label cannot close
    // an outer emphasis)
    let masked = src;
    REFLINK_SEARCH.lastIndex = 0;
    let m;
    const repl = [];
    while ((m = REFLINK_SEARCH.exec(src)) !== null) {
      const label = m[1] || m[3];
      const ref = m[2] || m[3];
      if (label && this.links[normLabel(ref)]) {
        // mask only the label text (between the first `[` and its `]`),
        // keeping the brackets themselves
        const start = m.index + 1;
        const end = start + label.length;
        repl.push([start, end]);
      }
    }
    if (repl.length) {
      let out = '', last = 0;
      for (const [a, b] of repl) {
        out += masked.slice(last, a) + 'a'.repeat(b - a);
        last = b;
      }
      out += masked.slice(last);
      masked = out;
    }
    // 2. anyPunctuationOutsideCode -> '+'
    masked = masked.replace(ANY_PUNCT_OUTSIDE_CODE, (mm, code, punct) => {
      if (code !== undefined) return mm;
      return '+'.repeat(mm.length);
    });
    // 3. blockSkip -> mask links/code/html
    BLOCK_SKIP.lastIndex = 0;
    masked = masked.replace(BLOCK_SKIP, (mm) => 'a'.repeat(mm.length));
    return masked;
  }
  // last possible closer index (fe)
  lastCloserIndex(src, masked, from, closerChar) {
    // find last run of closerChar whose preceding char is not space/tab/newline/CR/FF
    let last = -1;
    for (let i = from; i < masked.length; i++) {
      if (masked[i] === closerChar) {
        const prev = i > 0 ? masked[i - 1] : '';
        if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') last = i;
      }
    }
    return last;
  }
  lexInline(src, inLink, inRawBlock) {
    const tokens = [];
    let s = src;
    let lastChar = '';
    const linkParenPossible = s.includes(')');
    let masked = null;
    let maskedFor = null;
    const getMasked = () => {
      if (maskedFor !== s) {
        masked = /[*_~]/.test(s) ? this.emStrongMask(s) : null;
        maskedFor = s;
      }
      return masked;
    };
    while (s) {
      let tok = null;
      // escape
      let m = INLINE_ESC.exec(s);
      if (m) {
        const text = m[1];
        tok = { type: 'escape', raw: m[0], text };
        s = s.slice(m[0].length);
        tokens.push(tok);
        lastChar = text[text.length - 1] || '';
        continue;
      }
      // tag (html)
      m = INLINE_TAG.exec(s);
      if (m) {
        tok = { type: 'html', raw: m[0], text: m[0] };
        s = s.slice(m[0].length);
        tokens.push(tok);
        lastChar = m[0][m[0].length - 1] || '';
        continue;
      }
      // link
      m = LINK.exec(s);
      if (m) {
        const isImage = s[0] === '!';
        const labelText = m[1];
        let href = m[2];
        let title = m[3] || null;
        let matchLen = m[0].length;
        // validate href: angle-bracket hrefs must be well-formed; bare href parens must balance
        let hrefOk = true;
        if (href.startsWith('<')) {
          if (!/^<(?:\\.|[^\n<>\\])*>$/.test(href)) hrefOk = false;
        } else {
          let depth = 0;
          let cutIdx = -1;
          for (let i = 0; i < href.length; i++) {
            if (href[i] === '\\') { i++; continue; }
            if (href[i] === '(') depth++;
            else if (href[i] === ')') { depth--; if (depth < 0) { cutIdx = i; break; } }
          }
          if (cutIdx >= 0) {
            // greedy regex over-matched: truncate href at first unbalanced ')' and
            // end the link right after it (e.g. [bar](/uri)](/uri) -> [bar](/uri))
            const labelCloseIdx = (isImage ? 2 : 1) + m[1].length;
            href = href.slice(0, cutIdx);
            title = null;
            matchLen = labelCloseIdx + 2 + cutIdx + 1;
          } else if (depth !== 0) hrefOk = false;
        }
        if (hrefOk) {
        if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
        href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
        if (title) {
          if ((title.startsWith('"') && title.endsWith('"')) || (title.startsWith("'") && title.endsWith("'")) || (title.startsWith('(') && title.endsWith(')'))) title = title.slice(1, -1);
          title = title.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
        }
        // Be check: a '<' starting a tag/autolink that extends past the label end invalidates
        const labelEnd = closeBracket(s, 0);
        let invalid = false;
        if (labelEnd > 0) {
          const ltIdx = labelText.indexOf('<');
          if (ltIdx >= 0) {
            const ltPos = (isImage ? 2 : 1) + ltIdx; // position of '<' in s
            const after = s.slice(ltPos);
            if (/^<(?:[a-zA-Z][a-zA-Z0-9-]*\s|\/[a-zA-Z]|[a-zA-Z][a-zA-Z0-9+.-]{1,31}:|!|\?)/.test(after)) {
              // if the tag/autolink extends past labelEnd, invalid
              const tagM = INLINE_TAG.exec(after) || AUTOLINK.exec(after);
              if (tagM && ltPos + tagM[0].length > labelEnd) invalid = true;
              // unterminated tag/autolink (no match but looks like a tag start) also extends past
              else if (!tagM && /^<[a-zA-Z\/!?]/.test(after)) {
                // a '<' followed by a tag-like start with no closing '>' before labelEnd
                const gtIdx = after.indexOf('>');
                if (gtIdx < 0 || ltPos + gtIdx > labelEnd) invalid = true;
              }
            }
          }
        }
        if (!invalid) {
          const out = this.outputLink(labelText, href, title, isImage, inLink, inRawBlock);
          if (out) {
            tok = out;
            s = s.slice(matchLen);
            tokens.push(tok);
            lastChar = '';
            continue;
          }
        }
        } // end hrefOk
        // fall through to text
      }
      // reflink
      m = REFLINK.exec(s);
      if (m) {
        const isImage = s[0] === '!';
        const labelText = m[1];
        const ref = m[2] ? normLabel(m[2]) : normLabel(labelText);
        const link = this.links[ref];
        if (link && !this.labelInvalid(s, labelText, isImage)) {
          const out = this.outputLink(labelText, link.href, link.title, isImage, inLink, inRawBlock);
          if (out) {
            tok = out;
            s = s.slice(m[0].length);
            tokens.push(tok);
            lastChar = '';
            continue;
          }
        }
        // pattern matched but no link: the '[' is literal text; do NOT fall
        // through to the shortcut (nolink) — the rest is re-lexed from after '['
        const prefix = isImage ? '![' : '[';
        tokens.push({ type: 'text', raw: prefix, text: prefix });
        s = s.slice(prefix.length);
        lastChar = '[';
        continue;
      }
      // nolink (shortcut reference)
      m = NOLINK.exec(s);
      if (m) {
        const isImage = s[0] === '!';
        const labelText = m[1];
        const link = this.links[normLabel(labelText)];
        if (link && !this.labelInvalid(s, labelText, isImage)) {
          const out = this.outputLink(labelText, link.href, link.title, isImage, inLink, inRawBlock);
          if (out) {
            tok = out;
            s = s.slice(m[0].length);
            tokens.push(tok);
            lastChar = '';
            continue;
          }
        }
      }
      // emStrong
      if ((s[0] === '*' || s[0] === '_')) {
        const em = this.tryEmStrongV(s, getMasked(), lastChar);
        if (em === 'NO_CLOSER') {
          // opener valid but no closer: emit ONE delimiter as literal text
          // and retry the tail (the vendor's lexer does the same — this is
          // how `**foo*` becomes `*` + <em>foo</em>)
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
        // no match: the whole delimiter run is literal text (do not re-try
        // its tail as a new run — its flanking belongs to the whole run)
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
      // del
      if (s[0] === '~') {
        const del = this.tryDel(s, getMasked(), lastChar);
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
      // url (only when not inLink)
      if (!inLink) {
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
          // backpedal: loop until stable (the vendor repeats it, so
          // `https://github.com..` loses both trailing dots, not just one)
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
          // strip trailing punctuation handled by backpedal; also strip trailing ) if unbalanced
          let open = 0, close = 0;
          for (const ch of text) { if (ch === '(') open++; else if (ch === ')') close++; }
          while (close > open && text.endsWith(')')) { text = text.slice(0, -1); href = href.slice(0, -1); close--; }
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
        const text = m[1] !== undefined && m[1] !== '' ? m[1] : raw;
        // merge into previous text token
        if (tokens.length > 0 && tokens[tokens.length - 1].type === 'text') {
          const prev = tokens[tokens.length - 1];
          prev.raw += raw;
          prev.text += raw;
        } else {
          tokens.push({ type: 'text', raw, text: raw });
        }
        lastChar = raw[raw.length - 1] || '';
        if (!lastChar || lastChar === '_') lastChar = '';
        s = s.slice(raw.length);
        continue;
      }
      // fallback: single char as text
      const ch = s[0];
      if (tokens.length > 0 && tokens[tokens.length - 1].type === 'text') {
        const prev = tokens[tokens.length - 1];
        prev.raw += ch;
        prev.text += ch;
      } else {
        tokens.push({ type: 'text', raw: ch, text: ch });
      }
      lastChar = ch;
      s = s.slice(1);
    }
    return tokens;
  }
  // Be check: a '<' in the label starting a tag/autolink that extends past the label end invalidates the link
  labelInvalid(s, labelText, isImage) {
    const labelEnd = closeBracket(s, 0);
    if (labelEnd <= 0) return false;
    const ltIdx = labelText.indexOf('<');
    if (ltIdx < 0) return false;
    const ltPos = (isImage ? 2 : 1) + ltIdx;
    const after = s.slice(ltPos);
    if (!/^<(?:[a-zA-Z][a-zA-Z0-9-]*\s|\/[a-zA-Z]|[a-zA-Z][a-zA-Z0-9+.-]{1,31}:|!|\?)/.test(after)) return false;
    const tagM = INLINE_TAG.exec(after) || AUTOLINK.exec(after);
    if (tagM && ltPos + tagM[0].length > labelEnd) return true;
    if (!tagM && /^<[a-zA-Z\/!?]/.test(after)) {
      const gtIdx = after.indexOf('>');
      if (gtIdx < 0 || ltPos + gtIdx > labelEnd) return true;
    }
    return false;
  }
  outputLink(labelText, href, title, isImage, inLink, inRawBlock) {
    // unescape \[ and \] in link text
    const text = labelText.replace(/\\\[/g, '[').replace(/\\\]/g, ']');
    // lex link text inline (save/restore inLink, linkEmitted, inRawBlock)
    const saveInLink = inLink;
    const inner = new InlineLex(this.links);
    const innerToks = inner.lexInline(text, true, inRawBlock);
    // a non-image link whose text contained a (non-autolink) link returns
    // undefined; a nested autolink <...> inside the label is allowed
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
  tryEmStrong(s, masked, lastChar, chars) {
    const m = EM_L_DELIM.exec(s);
    if (!m) return null;
    const delim = s[0];
    // count run
    let run = 0;
    while (run < s.length && s[run] === delim) run++;
    if (run === 0) return null;
    // --- flanking: can this run open? ---
    const nextCh = s[run] || '';
    // start/end of line counts as whitespace for flanking purposes
    const isWS = (c) => c === '' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
    const isPunct = (c) => c !== '' && /[\p{P}\p{S}]/u.test(c);
    const isAlnum = (c) => c !== '' && /[\p{L}\p{N}]/u.test(c);
    const nextIsPunct = isPunct(nextCh);
    const nextIsWS = isWS(nextCh);
    const prevIsWS = isWS(lastChar);
    const prevIsPunct = isPunct(lastChar);
    // left-flanking: not followed by WS AND (not followed by punct OR (followed by punct AND preceded by WS/punct))
    const leftFlanking = !nextIsWS && (!nextIsPunct || prevIsWS || prevIsPunct);
    if (!leftFlanking) return null;
    // '_' intraword: cannot open if preceded AND followed by alnum
    if (delim === '_' && isAlnum(lastChar) && isAlnum(nextCh)) return null;
    // opener can close? (right-flanking; '_' additionally needs following punct since it is left-flanking)
    const openerRightFlanking = !prevIsWS && (!prevIsPunct || nextIsWS || nextIsPunct);
    const openerCanBoth = delim === '*' ? openerRightFlanking : (openerRightFlanking && nextIsPunct);
    // use masked source for closer lookup
    const src = masked !== null ? masked : s;
    const lastIdx = this.lastCloserIndex(s, src, 1, delim);
    if (lastIdx < 0) return null;
    // scan right-delim regex over masked slice; collect all hits
    const re = delim === '*' ? EM_R_DELIM_AST : EM_R_DELIM_UND;
    re.lastIndex = 0;
    const slice = src.slice(1, lastIdx + 1);
    let rm;
    const hits = [];
    while ((rm = re.exec(slice)) !== null) {
      const runLen = rm.slice(1).find(g => g !== undefined);
      if (runLen !== undefined) {
        const runStartInMatch = rm.index + rm[0].length - runLen.length;
        hits.push({ index: runStartInMatch, len: runLen.length });
      }
      if (rm[0].length === 0) re.lastIndex++;
    }
    if (hits.length === 0) return null;
    // filter to closers that can close (right-flanking, intraword, rule of 3)
    const isWS2 = (c) => c === '' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
    const isPunct2 = (c) => c !== '' && /[\p{P}\p{S}]/u.test(c);
    const valid = [];
    for (const h of hits) {
      const closerRun = h.len;
      const use = Math.min(run, closerRun);
      if (use === 0) continue;
      const closerStart = 1 + h.index;
      const prevCh = s[closerStart - 1] || '';
      const afterCh = s[closerStart + closerRun] || '';
      const rightFlanking = !isWS2(prevCh) && (!isPunct2(prevCh) || isWS2(afterCh) || isPunct2(afterCh));
      if (!rightFlanking) continue;
      if (delim === '_' && isAlnum(prevCh) && isAlnum(afterCh)) continue;
      // closer can open? (left-flanking; '_' additionally needs preceding punct since it is right-flanking)
      const closerLeftFlanking = !isWS2(afterCh) && (!isPunct2(afterCh) || isWS2(prevCh) || isPunct2(prevCh));
      const closerCanClose = delim === '*' ? true : (!closerLeftFlanking || isPunct2(afterCh));
      const closerCanOpen = delim === '*' ? closerLeftFlanking : (closerLeftFlanking && isPunct2(prevCh));
      const closerCanBoth = closerCanOpen && closerCanClose;
      // rule of 3 applies only when a delimiter can both open and close
      if ((openerCanBoth || closerCanBoth) && (run + closerRun) % 3 === 0 && !(run % 3 === 0 && closerRun % 3 === 0)) continue;
      valid.push({ index: h.index, len: h.len, canOpen: closerCanOpen });
    }
    if (valid.length === 0) return null;
    // if the content up to the first valid closer contains an unmatched opener
    // of the same delimiter, the first closer pairs with that inner opener,
    // so the outer opener must use the last valid closer instead
    const closerStart1 = 1 + valid[0].index;
    const closerRun1 = valid[0].len;
    let depth = 0;
    let innerRun = 0;
    let innerCanBoth = false;
    let ci = run;
    const contentEnd = closerStart1;
    // cross-delimiter: track the OTHER delimiter too — a same-delimiter
    // opener that sits inside an unmatched other-delimiter span (cm-470:
    // the `*` at `*baz` inside `__...__`) is consumed by that inner
    // strong/em and must not claim the outer closer
    const other = delim === '*' ? '_' : '*';
    let otherDepth = 0;
    const isAlnumD = (c) => c !== '' && /[\p{L}\p{N}]/u.test(c);
    // scan the MASKED source: escaped delimiters and delimiters inside code
    // spans / links are masked out and must not count as openers
    while (ci < contentEnd) {
      if (src[ci] === other) {
        let cj = ci;
        while (cj < contentEnd && src[cj] === other) cj++;
        const pCh = ci > 0 ? src[ci - 1] : '';
        const nCh = cj < src.length ? src[cj] : '';
        const canOpenO = !isWS2(nCh) && (!isPunct2(nCh) || isWS2(pCh) || isPunct2(pCh)) && !(other === '_' && isAlnumD(pCh) && isAlnumD(nCh));
        const canCloseO = !isWS2(pCh) && (!isPunct2(pCh) || isWS2(nCh) || isPunct2(nCh)) && !(other === '_' && isAlnumD(pCh) && isAlnumD(nCh));
        if (canCloseO && otherDepth > 0) otherDepth--;
        else if (canOpenO) otherDepth++;
        ci = cj;
      } else if (src[ci] === delim) {
        let cj = ci;
        while (cj < contentEnd && src[cj] === delim) cj++;
        // inside an unmatched other-delimiter span: this opener is consumed
        // by the inner strong/em, ignore it for the outer closer
        if (otherDepth === 0) {
          const pCh = ci > 0 ? src[ci - 1] : '';
          const nCh = cj < src.length ? src[cj] : '';
          const canOpen = !isWS2(nCh) && (!isPunct2(nCh) || isWS2(pCh) || isPunct2(pCh)) && !(delim === '_' && isAlnumD(pCh) && isAlnumD(nCh));
          const canClose = !isWS2(pCh) && (!isPunct2(pCh) || isWS2(nCh) || isPunct2(nCh)) && !(delim === '_' && isAlnumD(pCh) && isAlnumD(nCh));
          if (canClose && depth > 0) depth--;
          else if (canOpen) {
            if (depth === 0) {
              innerRun = cj - ci;
              // inner opener can both open and close (for the rule of 3):
              // for '*', canClose as computed; for '_', canClose needs following punct
              innerCanBoth = delim === '*' ? canClose : (canClose && isPunct2(nCh));
            }
            depth++;
          }
        }
        ci = cj;
      } else ci++;
    }
    const insideOther = otherDepth > 0;
    let sharedTake = 0;
    let best = valid[0];
    if (depth > 0) {
      // an unmatched opener sits inside the content: the first closer may
      // pair with it. If the first closer can be shared (close both the
      // inner opener and the outer opener) the outer opener uses the first
      // closer; otherwise the first closer pairs with the inner opener and
      // the outer opener takes the last closer — unless there is only one
      // closer, in which case it is shared if possible, else outer is literal
      let takeInner = Math.min(innerRun, closerRun1);
      const closerCanBoth1 = valid[0].canOpen;
      if ((innerCanBoth || closerCanBoth1) && (innerRun + closerRun1) % 3 === 0 && !(innerRun % 3 === 0 && closerRun1 % 3 === 0)) takeInner = 0;
      if (depth === 1 && takeInner > 0 && Math.min(run, closerRun1 - takeInner) > 0) {
        // first closer closes both: share its first `takeInner` delimiters
        sharedTake = takeInner;
        best = valid[0];
      } else if (valid.length === 1) {
        // only one closer: it is shared if possible, else outer is literal
        if (Math.min(run, closerRun1 - takeInner) <= 0) return null;
        sharedTake = takeInner;
        best = valid[0];
      } else {
        best = valid[valid.length - 1];
      }
    }
    // if the first closer can also open AND sits inside an unmatched opener
    // of the other delimiter, it serves as an inner opener, so the outer
    // opener uses the last closer (letting the inner em form inside)
    else if (valid.length > 1 && valid[0].canOpen && insideOther) best = valid[valid.length - 1];
    // if the opener run has excess delimiters over the first closer and
    // there are multiple closers, the excess openers pair with later closers
    // (nested em/strong), so the outer opener uses the last closer
    else if (valid.length > 1 && run > valid[0].len) best = valid[valid.length - 1];
    const closerRun = best.len;
    const use = sharedTake > 0 ? Math.min(run, closerRun - sharedTake) : Math.min(run, closerRun);
    if (use === 0) return null;
    // rule of 3 applies only when a delimiter can both open and close
    {
      const bStart = 1 + best.index;
      const bPrev = s[bStart - 1] || '';
      const bAfter = s[bStart + closerRun] || '';
      const bRF = !isWS2(bPrev) && (!isPunct2(bPrev) || isWS2(bAfter) || isPunct2(bAfter));
      const bLF = !isWS2(bAfter) && (!isPunct2(bAfter) || isWS2(bPrev) || isPunct2(bPrev));
      const bCanClose = delim === '*' ? bRF : (bRF && (!bLF || isPunct2(bAfter)));
      const bCanOpen = delim === '*' ? bLF : (bLF && isPunct2(bPrev));
      if ((openerCanBoth || (bCanOpen && bCanClose)) && (run + closerRun) % 3 === 0 && !(run % 3 === 0 && closerRun % 3 === 0)) return null;
    }
    // --- flanking: can this run close? ---
    const closerStart = 1 + best.index;
    const prevCh = s[closerStart - 1] || '';
    const afterCh = s[closerStart + closerRun] || '';
    const prevIsWS2 = prevCh === '' || prevCh === ' ' || prevCh === '\t' || prevCh === '\n' || prevCh === '\r' || prevCh === '\f';
    const prevIsPunct2 = prevCh !== '' && /[\p{P}\p{S}]/u.test(prevCh);
    const afterIsWS = afterCh === '' || afterCh === ' ' || afterCh === '\t' || afterCh === '\n' || afterCh === '\r' || afterCh === '\f';
    const afterIsPunct = afterCh !== '' && /[\p{P}\p{S}]/u.test(afterCh);
    const rightFlanking = !prevIsWS2 && (!prevIsPunct2 || afterIsWS || afterIsPunct);
    if (!rightFlanking) return null;
    // '_' intraword: cannot close if preceded AND followed by alnum
    if (delim === '_' && /[\p{L}\p{N}]/u.test(prevCh) && /[\p{L}\p{N}]/u.test(afterCh)) return null;
    // compute inner content: from end of opener run to start of closer run
    // when the outer em uses the last closer, excess delimiters on either side
    // pair with earlier/later closers/openers and form inner em/strong:
    // excess opener delimiters are prepended to the content, and excess closer
    // delimiters are included at the end of the content (the outer em then
    // consumes the whole closer run)
    const nestOpener = best !== valid[0] && valid.length > 1 && run > use;
    const nestCloser = best !== valid[0] && valid.length > 1 && closerRun > use;
    const leading = nestOpener ? 0 : run - use;
    const closerExt = sharedTake > 0 ? sharedTake : (nestCloser ? closerRun - use : 0);
    const content = (nestOpener ? delim.repeat(run - use) : '') + s.slice(run, closerStart + closerExt);
    if (!content) return null;
    const inner = new InlineLex(this.links);
    const innerToks = inner.lexInline(content, false, false);
    // only `use` delimiters are consumed on each side; excess opener delimiters
    // are literal text before the em/strong (unless nested, see above),
    // excess closer delimiters stay in the source (unless nested, see above)
    const raw = s.slice(leading, closerStart + closerExt + use);
    // build nested token: pairs -> strong, leftover single -> em
    let tok;
    if (use === 1) {
      tok = { type: 'em', raw, text: content, tokens: innerToks };
    } else {
      tok = { type: 'strong', raw, text: content, tokens: innerToks };
      let remaining = use - 2;
      while (remaining >= 2) {
        tok = { type: 'strong', raw, text: content, tokens: [tok] };
        remaining -= 2;
      }
      if (remaining === 1) {
        tok = { type: 'em', raw, text: content, tokens: [tok] };
      }
    }
    return { raw, tok, leading, delim };
  }
  // vendor-faithful emStrong: single left-to-right scan over the right-delim
  // regex with an m counter (skip-groups add, closers subtract) and the f
  // (rule-of-3) counter — no depth scan, no last-closer selection. This is
  // marked 18.1.3's emStrong translated directly.
  tryEmStrongV(s, masked, lastChar) {
    const m = EM_L_DELIM.exec(s);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
    const delim = s[0];
    if (delim !== '*' && delim !== '_') return null;
    const o = lastChar === delim;
    let run = 0;
    while (run < s.length && s[run] === delim) run++;
    if (run === 0) return null;
    const isPunct = (c) => c !== '' && /[\p{P}\p{S}]/u.test(c);
    // vendor `punctuation` = ^((?![*_])[\s\p{P}\p{S}]) — whitespace counts too,
    // and `*`/`_` are excluded from it (but h ORs them back in explicitly)
    const isPunctWS = (c) => c !== '' && c !== '*' && c !== '_' && /[\s\p{P}\p{S}]/u.test(c);
    const p = lastChar;
    const h = p === '*' || p === '_' || isPunctWS(p);
    const n = lastChar;
    const u = isPunctWS(n);
    // '_' intraword: following non-space char (group 4) + preceding alnum
    if (m[4] && /[\p{L}\p{N}]/u.test(n)) return null;
    const d = m[1] || m[3] || '';
    if (!d || !n || u) {
      const k = run;
      const y = run;
      const R = p !== '' && p.trim() !== '' && (!!d || (delim === '*' && !h));
      const src = masked !== null ? masked : s;
      const lastIdx = this.lastCloserIndex(s, src, 1, delim);
      if (lastIdx < 0 || lastIdx < run) return 'NO_CLOSER';
      const re = delim === '*' ? EM_R_DELIM_AST : EM_R_DELIM_UND;
      re.lastIndex = 0;
      const slice = src.slice(run);
      const ee = lastIdx - run;
      let mm = k, f = 0;
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
        const runStartInMatch = rm.index + rm[0].length - g.length;
        const closerStart = run + runStartInMatch;
        const raw = s.slice(0, closerStart + b);
        const use = Math.min(k, b);
        let content, tok;
        if (use % 2 === 1) {
          content = raw.slice(1, -1);
          if (!content) return null;
          const inner = new InlineLex(this.links);
          const innerToks = inner.lexInline(content, false, false);
          tok = { type: 'em', raw, text: content, tokens: innerToks };
        } else {
          content = raw.slice(2, -2);
          if (!content) return null;
          const inner = new InlineLex(this.links);
          const innerToks = inner.lexInline(content, false, false);
          tok = { type: 'strong', raw, text: content, tokens: innerToks };
        }
        return { raw, tok, leading: 0, delim };
      }
      // opener valid but no closer satisfied the scan: retry the tail
      return 'NO_CLOSER';
    }
    return null;
  }
  tryDel(s, masked, lastChar) {
    const m = DEL_L_DELIM.exec(s);
    if (!m) return null;
    let run = 0;
    while (run < s.length && s[run] === '~') run++;
    if (run < 1) return null;
    // flanking: can this run open? (`~` is non-punctuation for GFM)
    const isWS = (c) => c === '' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
    const isPunct = (c) => c !== '' && c !== '~' && /[\p{P}\p{S}]/u.test(c);
    const nextCh = s[run] || '';
    const leftFlanking = !isWS(nextCh) && (!isPunct(nextCh) || isWS(lastChar) || isPunct(lastChar));
    if (!leftFlanking) return null;
    const src = masked !== null ? masked : s;
    const lastIdx = this.lastCloserIndex(s, src, 1, '~');
    if (lastIdx < 0) return null;
    DEL_R_DELIM.lastIndex = 0;
    const slice = src.slice(1, lastIdx + 1);
    let rm;
    const hits = [];
    while ((rm = DEL_R_DELIM.exec(slice)) !== null) {
      const runLen = rm.slice(1).find(g => g !== undefined);
      if (runLen !== undefined) {
        const runStartInMatch = rm.index + rm[0].length - runLen.length;
        hits.push({ index: runStartInMatch, len: runLen.length });
      }
      if (rm[0].length === 0) DEL_R_DELIM.lastIndex++;
    }
    if (hits.length === 0) return null;
    // filter to closers that can close (right-flanking) and note canOpen
    const valid = [];
    for (const h of hits) {
      const closerRun = h.len;
      const use = Math.min(run, closerRun);
      if (use === 0) continue;
      const closerStart = 1 + h.index;
      const prevCh = s[closerStart - 1] || '';
      const afterCh = s[closerStart + closerRun] || '';
      const rightFlanking = !isWS(prevCh) && (!isPunct(prevCh) || isWS(afterCh) || isPunct(afterCh));
      if (!rightFlanking) continue;
      const closerCanOpen = !isWS(afterCh) && (!isPunct(afterCh) || isWS(prevCh) || isPunct(prevCh));
      valid.push({ index: h.index, len: h.len, canOpen: closerCanOpen });
    }
    if (valid.length === 0) return null;
    let best = valid[0];
    // depth scan: unmatched `~` opener inside the content up to the first closer
    const closerStart1 = 1 + valid[0].index;
    const closerRun1 = valid[0].len;
    let depth = 0;
    let innerRun = 0;
    let ci = run;
    while (ci < closerStart1) {
      if (src[ci] === '~') {
        let cj = ci;
        while (cj < closerStart1 && src[cj] === '~') cj++;
        const pCh = ci > 0 ? src[ci - 1] : '';
        const nCh = cj < src.length ? src[cj] : '';
        const canOpen = !isWS(nCh) && (!isPunct(nCh) || isWS(pCh) || isPunct(pCh));
        const canClose = !isWS(pCh) && (!isPunct(pCh) || isWS(nCh) || isPunct(nCh));
        if (canClose && depth > 0) depth--;
        else if (canOpen) { if (depth === 0) innerRun = cj - ci; depth++; }
        ci = cj;
      } else ci++;
    }
    let sharedTake = 0;
    if (depth > 0) {
      // first closer may be shared with the single inner opener (depth 1);
      // otherwise the first closer pairs with the inner opener and the outer
      // opener takes the last closer (or is literal if only one closer)
      const takeInner = Math.min(innerRun, closerRun1);
      if (depth === 1 && takeInner > 0 && Math.min(run, closerRun1 - takeInner) > 0) {
        sharedTake = takeInner;
        best = valid[0];
      } else if (valid.length === 1) {
        if (Math.min(run, closerRun1 - takeInner) <= 0) return null;
        sharedTake = takeInner;
        best = valid[0];
      } else {
        best = valid[valid.length - 1];
      }
    } else if (valid.length > 1 && valid[0].canOpen) best = valid[valid.length - 1];
    else if (valid.length > 1 && run > valid[0].len) best = valid[valid.length - 1];
    const closerRun = best.len;
    const use = sharedTake > 0 ? Math.min(run, closerRun - sharedTake) : Math.min(run, closerRun);
    if (use < 1) return null;
    const closerStart = 1 + best.index;
    // when the outer del uses the last closer, excess delimiters on either side
    // pair with earlier/later closers/openers and form inner del
    const nestOpener = best !== valid[0] && valid.length > 1 && run > use;
    const nestCloser = best !== valid[0] && valid.length > 1 && closerRun > use;
    const leading = nestOpener ? 0 : run - use;
    const closerExt = sharedTake > 0 ? sharedTake : (nestCloser ? closerRun - use : 0);
    const content = (nestOpener ? '~'.repeat(run - use) : '') + s.slice(run, closerStart + closerExt);
    if (!content) return null;
    const inner = new InlineLex(this.links);
    const innerToks = inner.lexInline(content, false, false);
    const raw = s.slice(leading, closerStart + closerExt + use);
    return { raw, tok: { type: 'del', raw, text: content, tokens: innerToks }, leading };
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
        let text = t.text || '';
        if (text && !text.endsWith('\n')) text += '\n';
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
            // loose task item: the checkbox sits inside the first paragraph
            const p = item.tokens[0];
            out += '<p><input' + (item.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ' + (p.tokens ? renderInline(p.tokens) : escHtml(p.text, false)) + '</p>\n';
            out += renderBlock(item.tokens.slice(1));
          } else {
            if (item.task) {
              out += '<input' + (item.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ';
            }
            out += renderBlock(item.tokens);
          }
          // list items render without wrapping <p> when tight; renderBlock adds <p> for paragraph tokens
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
function expandLeadingTabsFrom(line, startCol) {
  // expand tabs in leading whitespace only, starting at the given column
  let out = '';
  let col = startCol;
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ' ';
      col++;
    }
    i++;
  }
  return out + line.slice(i);
}
function stripBQLine(line) {
  // strip one blockquote marker, expanding a following tab column-aware
  // (1 space of the expansion is the marker separator)
  const m = /^( {0,3})>/.exec(line);
  if (!m) return line;
  let col = m[1].length + 1; // column just after '>'
  let i = m[0].length;
  let content = '';
  // optional single space/tab separator after '>'
  if (line[i] === ' ') { i++; col++; }
  else if (line[i] === '\t') {
    const n = 4 - (col % 4);
    content += ' '.repeat(Math.max(0, n - 1)); // 1 of the tab's spaces is the separator
    col += n;
    i++;
  }
  // expand any further leading whitespace in the content, column-aware
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') {
      const n = 4 - (col % 4);
      content += ' '.repeat(n);
      col += n;
    } else {
      content += ' ';
      col++;
    }
    i++;
  }
  return content + line.slice(i);
}
function expandLeadingTabs(line) {
  // expand tabs in leading whitespace only, column-aware (tab -> next multiple of 4)
  // a tab is preserved (not expanded) only when it is indented-code content:
  // preceded by exactly 4 literal spaces at column 4 (the code indent); a
  // tab after any other indent (e.g. fenced-code content indented by 7 or 8)
  // is part of the leading whitespace and must expand column-aware
  let out = '';
  let col = 0;
  let litSpaces = 0;
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t' && litSpaces === 4 && col === 4) break;
    if (line[i] === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
      litSpaces = 0;
    } else {
      out += ' ';
      col++;
      litSpaces++;
    }
    i++;
  }
  return out + line.slice(i);
}
function expandMarkerTabs(line) {
  // expand tabs in the whitespace immediately after a list marker at line start
  const m = /^((?: {0,3})(?:[*+-]|\d{1,9}[.)]))([ \t]*)/.exec(line);
  if (!m || !m[2].includes('\t')) return line;
  const markerEndCol = m[1].length;
  let col = markerEndCol;
  let expanded = '';
  for (const ch of m[2]) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      expanded += ' '.repeat(n);
      col += n;
    } else {
      expanded += ' ';
      col++;
    }
  }
  return m[1] + expanded + line.slice(m[0].length);
}
function parse(markdown) {
  // expand leading/marker tabs, except inside top-level fenced code blocks
  // (fenced code content is literal: a tab there is preserved, e.g. doc-10's
  // `\tindented with a tab` inside ```diff). Fences inside lists/blockquotes
  // are not tracked here (their content tabs expand column-aware, doc-06).
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  let fenceCh = '';
  let fenceLen = 0;
  const outLines = new Array(lines.length);
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (fenceCh) {
      const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
      if (cm && cm[1][0] === fenceCh && cm[1].length >= fenceLen) { fenceCh = ''; fenceLen = 0; }
      outLines[li] = l;
      continue;
    }
    const om = /^ {0,3}(`{3,}|~{3,})[^`\n]*$/.exec(l);
    if (om && (om[1][0] === '`' ? !om[0].includes('`', 3) : true)) {
      // backtick fence info must not contain a backtick; tilde fence any info
      const info = l.slice(om[0].indexOf(om[1]) + om[1].length);
      if (om[1][0] === '`' && info.includes('`')) { outLines[li] = expandMarkerTabs(expandLeadingTabs(l)); continue; }
      fenceCh = om[1][0];
      fenceLen = om[1].length;
    }
    outLines[li] = expandMarkerTabs(expandLeadingTabs(l));
  }
  const src = outLines.join('\n');
  const lex = new BlockLex();
  const tokens = lex.lex(src, true);
  // resolve deferred inline tokens (after full block pass, so later defs resolve)
  const il = new InlineLex(lex.links);
  for (const q of lex.inlineQueue) {
    if (q.owner) {
      q.owner.tokens = il.lexInline(q.src, q.inLink, q.inRawBlock);
    }
  }
  // table cells: owner tokens
  for (const t of tokens) {
    if (t.type === 'table') {
      const all = [...t.header, ...t.rows.flat()];
      for (const c of all) {
        if (c._owner) c._owner.tokens = il.lexInline(c.text, false, false);
      }
    }
  }
  return renderBlock(tokens);
}
export { parse };
export default parse;
