// A fast drop-in for makefun-site 1.0.0: build(input) turns one site's sources
// into its output tree, byte for byte as the reference does, only faster.
// Written from the reference's README and its behaviour, in my own structure:
// one pass per phase, no token objects, manual scanners instead of regexes
// on the hot paths, and a slug cache shared by a whole build.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SLUG_MAX = 64;
const RESERVED = ['posts', 'tags', 'page'];

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isSpaceTab = (c) => c === 32 || c === 9;

// ---------------------------------------------------------------- text

const ESC_ANY = /[&<>"']/;

/** `text` with & < > " and ' escaped, in one scan, no allocation when clean. */
function escapeHtml(text) {
  if (!ESC_ANY.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += text.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? text : out + text.slice(start);
}

/** The slug of `text`, per the reference rule; ASCII text takes a direct scan. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (isAscii(text)) {
    out = slugAscii(text);
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = cutSlug(out);
  }
  cache.set(text, out);
  return out;
}

function isAscii(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}

function slugAscii(s) {
  let out = '';
  let gap = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep < 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  return cutSlug(out);
}

function cutSlug(out) {
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = false;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45) {
        const digits = (a, b) => {
          let v = 0;
          for (let i = a; i < b; i++) {
            const c = raw.charCodeAt(i);
            if (c < 48 || c > 57) return -1;
            v = v * 10 + (c - 48);
          }
          return v;
        };
        y = digits(0, 4);
        mo = digits(5, 7);
        d = digits(8, 10);
        ok = y >= 0 && mo >= 0 && d >= 0 && y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else if (c === 45 && !prevDash) prevDash = true;
        else ok = false;
      }
      if (prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Split one front-matter line into { key, raw }, or null when it is not "key: value". */
function fmLine(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 97 && c <= 122) || c === 95) i++;
    else break;
  }
  if (i === 0 || line.charCodeAt(i) !== 58) return null;
  const key = line.slice(0, i);
  i++;
  let raw;
  if (i === line.length) raw = '';
  else if (line.charCodeAt(i) === 32) raw = line.slice(i + 1);
  else return null;
  let e = raw.length;
  while (e > 0 && isSpaceTab(raw.charCodeAt(e - 1))) e--;
  return { key, raw: raw.slice(0, e) };
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    const p = fmLine(line);
    if (p === null) return { error: `line ${i + 1} is not "key: value"` };
    if (!FM_KEYS.has(p.key)) return { error: `unknown key "${p.key}"` };
    if (hasOwn(data, p.key)) return { error: `key "${p.key}" is given twice` };
    if (p.raw === '') return { error: `key "${p.key}" has no value` };
    const v = valueOf(p.key, p.raw);
    if ('error' in v) return v;
    data[p.key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line.charCodeAt(a))) a++;
  while (b > a && isSpaceTab(line.charCodeAt(b - 1))) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence-open line: the language after ```, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length && isSpaceTab(line.charCodeAt(i))) i++;
  return i === line.length ? lang : null;
}

/** A fence-close line (``` plus spaces/tabs only)? */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** A heading line: { depth, text }, or null. */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d >= line.length || !isSpaceTab(line.charCodeAt(d))) return null;
  const text = trimLine(line.slice(d));
  return text === '' ? null : { depth: d, text };
}

/** A horizontal-rule line? */
function isHr(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line.charCodeAt(i))) return false;
  return true;
}

/** A list-start line under the list's own marker kind: { ordered, start, text } or null. */
function listStart(line, ordered) {
  if (ordered) {
    let i = 0;
    while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i === 0 || i > 9) return null;
    if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
    return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
  }
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  return null;
}

/** A list continuation line (two or more spaces, then a non-space)? */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i === line.length) return false;
  return !/\s/.test(line[i]);
}

/** A line that ends a paragraph: blank, fence-open, heading or rule. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Inline markup (the custom subset) of `s`, with links resolved by `env.link`, pushed into `parts`. */
function inlineInto(s, env, parts) {
  let lit = 0;
  let i = 0;
  const flush = (to) => {
    if (to > lit) parts.push(escapeHtml(s.slice(lit, to)));
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      parts.push(escapeHtml(s[i + 1]));
      i += 2;
      lit = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        parts.push(`<code>${escapeHtml(s.slice(i + 1, j))}</code>`);
        i = j + 1;
        lit = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          parts.push('<strong>');
          inlineInto(s.slice(i + 2, j), env, parts);
          parts.push('</strong>');
          i = j + 2;
          lit = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        parts.push('<em>');
        inlineInto(s.slice(i + 1, j), env, parts);
        parts.push('</em>');
        i = j + 1;
        lit = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        parts.push(`<a href="${escapeHtml(env.link(target))}">`);
        inlineInto(s.slice(i + 1, k), env, parts);
        parts.push('</a>');
        i = m + 1;
        lit = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(s.length);
}

/** Inline markup (the custom subset) of `s`, with links resolved by `env.link`. */
function inline(s, env) {
  const parts = [];
  inlineInto(s, env, parts);
  return parts.join('');
}

/** One source body rendered: { html, toc, excerpt }. Reads lines straight off `src`. */
function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let pos = 0;
  const N = src.length;

  const lineAt = (p) => {
    const nl = src.indexOf('\n', p);
    return nl === -1 ? [src.slice(p), N + 1] : [src.slice(p, nl), nl + 1];
  };

  while (pos < N) {
    let [line, next] = lineAt(pos);
    if (isBlankLine(line)) {
      pos = next;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      let code = '';
      pos = next;
      while (pos < N) {
        [line, next] = lineAt(pos);
        if (isFenceClose(line)) {
          pos = next;
          break;
        }
        code += `${escapeHtml(line)}\n`;
        pos = next;
      }
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text, slugCache), ids);
      const html = inline(h.text, env);
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      pos = next;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      pos = next;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const qlines = [];
      while (pos < N) {
        [line, next] = lineAt(pos);
        if (line.charCodeAt(0) !== 62) break;
        qlines.push(trimLine(line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1)));
        pos = next;
      }
      const kept = qlines.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const first = listStart(line, false) || listStart(line, true);
    if (first !== null) {
      const ordered = first.ordered;
      const items = [[trimLine(first.text)]];
      pos = next;
      while (pos < N) {
        [line, next] = lineAt(pos);
        const m = listStart(line, ordered);
        if (m !== null) {
          items.push([trimLine(m.text)]);
          pos = next;
          continue;
        }
        if (isContinued(line)) {
          items[items.length - 1].push(trimLine(line));
          pos = next;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>`);
      continue;
    }
    const plines = [trimLine(line)];
    pos = next;
    while (pos < N) {
      [line, next] = lineAt(pos);
      if (endsParagraph(line)) break;
      plines.push(trimLine(line));
      pos = next;
    }
    const html = inline(plines.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13
    || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233
    || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWs(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const n = src[open + 1];
    if (n !== '{' && n !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (n === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const before = src.slice(lineStart, open);
    const after = src.slice(end, lineEnd);
    let standalone = true;
    for (let j = 0; j < before.length; j++) if (!isSpaceTab(before.charCodeAt(j))) { standalone = false; break; }
    if (standalone) for (let j = 0; j < after.length; j++) if (!isSpaceTab(after.charCodeAt(j))) { standalone = false; break; }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const tokens = tokenize(name, src);
  const root = { kind: 'root', body: [] };
  const stack = [root];
  const current = () => {
    const top = stack[stack.length - 1];
    if (top.kind === 'if') return top.else ?? top.then;
    return top.body;
  };
  for (const tok of tokens) {
    if (tok.t !== 'tag') {
      current().push(tok);
      continue;
    }
    const tag = tok.tag;
    let m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/.exec(tag);
    if (m !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      current().push(node);
      stack.push(node);
      continue;
    }
    m = /^if (not )?(\S+)$/.exec(tag);
    if (m !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      current().push(node);
      stack.push(node);
      continue;
    }
    m = /^include "([a-z0-9-]+)"$/.exec(tag);
    if (m !== null) {
      current().push({ kind: 'include', name: m[1] });
      continue;
    }
    if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const top = stack[stack.length - 1];
      if (top.kind !== tag.slice(3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      continue;
    }
    throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let v;
  for (let s = scope; s !== null; s = s.parent) {
    if (hasOwn(s.vars, path[0])) {
      v = s.vars[path[0]];
      break;
    }
  }
  if (v === undefined) return undefined;
  for (let i = 1; i < path.length; i++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[i])) return undefined;
    v = v[path[i]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, parts) {
  for (const node of nodes) {
    if (node.t === 'text') parts.push(node.text);
    else if (node.t === 'var') parts.push(escapeHtml(textOf(lookup(scope, node.path))));
    else if (node.t === 'raw') parts.push(textOf(lookup(scope, node.path)));
    else if (node.kind === 'if') {
      const branch = truthy(lookup(scope, node.path)) !== node.not ? node.then : node.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, parts);
    } else if (node.kind === 'for') {
      const xs = lookup(scope, node.path);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          const vars = { [node.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(node.body, { vars, parent: scope }, ctx, depth, parts);
        }
      }
    } else if (node.kind === 'include') {
      const t = ctx.templates.get(node.name);
      if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, parts);
    }
  }
}

// ---------------------------------------------------------------- build

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  const output = {};

  const names = Object.keys(input.templates ?? {}).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (e) {
      if (e instanceof TemplateError) report.push(e.message);
      else throw e;
    }
  }

  const files = [...(input.files ?? [])].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    s.layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(s.layout)) {
      report.push(`refused ${s.path}: layout "${s.layout}" is no template that parses`);
      continue;
    }
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const taken = new Map();
  taken.set('', new Set(RESERVED));
  for (const s of kept) {
    s.dir = s.post ? 'posts' : dirOf(s.path);
    if (!taken.has(s.dir)) taken.set(s.dir, new Set());
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), taken.get(s.dir));
    s.outDir = s.dir === '' ? s.slug : `${s.dir}/${s.slug}`;
    s.url = `${input.site.base_url}/${s.outDir}/`;
  }
  const bySource = new Map(kept.map((s) => [s.path, s]));
  const staticPaths = new Set(statics.map((s) => s.path));

  const broken = new Set();
  const base = input.site.base_url.replace(/\/+$/, '');
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link }, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const bySlug = new Map();
  const ownTags = (s) => {
    const out = [];
    const seen = new Set();
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let t = bySlug.get(slug);
      if (t === undefined) {
        t = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, t);
      }
      t.posts.push(p);
      p.tagRefs.push(t);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const ctx = { templates };
  const cards = new Map();
  const cardOf = (s) => {
    let card = cards.get(s);
    if (card !== undefined) return card;
    card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cards.set(s, card);
    return card;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map(cardOf);
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    const parts = [];
    renderNodes(t, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, parts);
    return parts.join('');
  };

  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map(cardOf),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(cardOf) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (const s of statics) {
    if (hasOwn(output, s.path)) report.push(`shadowed ${s.path}: a built page has its path`);
    else output[s.path] = s.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${kept.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
