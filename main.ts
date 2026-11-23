// mend — one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote to a tree of text files, as SPEC.md (version 1)
// prescribes. Four patch formats: unified diffs, SEARCH/REPLACE blocks, V4A patches
// and JSON text-editor calls. Every file is changed or nothing is.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// Node 22, standard library alone. In a trial the grader runs `node /bot/main.ts`
// with MAKEFUN_ENV_URL set, and this file hands over to runner.ts (the last lines
// below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A syntax fault in the patch: `error: parse <line>`. */
class ParseError extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

interface Fail {
  code: string;
  path: string;
}

/** One line of a hunk or chunk body: context, old or new, with whether a `\` line follows it. */
interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  bs: boolean;
}

interface Hunk {
  a: number;
  body: BodyEntry[];
}

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

/** One parsed edit, ready to apply to the tree. */
type ParsedEdit =
  | { f: 'uni'; oldPath: string | null; newPath: string | null; newFile: boolean; delFile: boolean; hunks: Hunk[] }
  | { f: 'sr'; path: string; old: string[]; nw: string[] }
  | { f: 'v4a-add'; path: string; lines: string[] }
  | { f: 'v4a-del'; path: string }
  | { f: 'v4a-upd'; path: string; moveTo: string | null; chunks: Chunk[] }
  | { f: 'json-create'; path: string; text: string }
  | { f: 'json-replace'; path: string; oldStr: string; newStr: string }
  | { f: 'json-insert'; path: string; line: number; newStr: string };

/* ------------------------------------------------------------------ */
/* Text, lines and paths (SPEC.md section 3)                          */
/* ------------------------------------------------------------------ */

type Br = '\r\n' | '\n';

/** A file as lines: its break, its lines, and whether it ends with a break. */
interface Doc {
  br: Br;
  lines: string[];
  trail: boolean;
}

function parseDoc(text: string): Doc {
  const firstLf = text.indexOf('\n');
  const br: Br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], trail: false };
  const parts = text.split(br);
  const trail = parts[parts.length - 1] === '';
  if (trail) parts.pop();
  return { br, lines: parts, trail };
}

function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.trail ? d.br : '');
}

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/* ------------------------------------------------------------------ */
/* The tree as the edits leave it (SPEC.md sections 2 and 10)         */
/* ------------------------------------------------------------------ */

type Slot = { k: 'file'; doc: Doc } | { k: 'dir' } | { k: 'absent' };

class Tree {
  private readonly origText = new Map<string, string | null>();
  private readonly origExists = new Map<string, boolean>();
  private readonly now = new Map<string, Doc | null>();

  private disk(p: string): { text: string | null; exists: boolean } {
    if (!this.origText.has(p)) {
      let text: string | null = null;
      let exists = false;
      try {
        const st = statSync(p);
        exists = true;
        if (st.isFile()) text = readFileSync(p, 'utf8');
      } catch {
        exists = false;
      }
      this.origText.set(p, text);
      this.origExists.set(p, exists);
    }
    return { text: this.origText.get(p)!, exists: this.origExists.get(p)! };
  }

  /** The path's state now: the file, a directory, or absent. */
  read(p: string): Slot {
    if (this.now.has(p)) {
      const v = this.now.get(p)!;
      return v === null ? { k: 'absent' } : { k: 'file', doc: v };
    }
    const d = this.disk(p);
    if (d.text !== null) return { k: 'file', doc: parseDoc(d.text) };
    if (d.exists) return { k: 'dir' };
    return { k: 'absent' };
  }

  /** The path's bytes before the patch, or null when it held no file. */
  orig(p: string): string | null {
    return this.disk(p).text;
  }

  /** The path's bytes now, or null when it holds no file. */
  currentText(p: string): string | null {
    const s = this.read(p);
    return s.k === 'file' ? renderDoc(s.doc) : null;
  }

  set(p: string, doc: Doc | null): void {
    this.now.set(p, doc);
  }

  /** Every path whose state may have changed. */
  keys(): string[] {
    return [...new Set([...this.now.keys(), ...this.origText.keys()])];
  }
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                 */
/* ------------------------------------------------------------------ */

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailWs(a) === stripTrailWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

function matchesAt(lines: string[], old: string[], i: number, tier: number): boolean {
  for (let j = 0; j < old.length; j++) {
    if (!tierEq(lines[i + j], old[j], tier)) return false;
  }
  return true;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which old occurs, with every occurrence at that tier. */
function findTier(lines: string[], old: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (const t of tiers(strict)) {
    const pos: number[] = [];
    for (let i = 0; i + old.length <= lines.length; i++) {
      if (matchesAt(lines, old, i, t)) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first occurrence at or after `from`, at the first tier with one. */
function findTierFrom(
  lines: string[],
  old: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; pos: number } | null {
  for (const t of tiers(strict)) {
    for (let i = from; i + old.length <= lines.length; i++) {
      if (eof && i + old.length !== lines.length) continue;
      if (matchesAt(lines, old, i, t)) return { tier: t, pos: i };
    }
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  for (const t of tiers(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (tierEq(lines[i], anchor, t)) return i;
    }
  }
  return null;
}

/** Old lines O and new lines N of a hunk or chunk body, in body order. */
interface NEntry {
  text: string;
  /** Index into O when this is a context line, else -1. */
  ctx: number;
}

function hunkON(body: BodyEntry[]): { O: string[]; N: NEntry[] } {
  const O: string[] = [];
  const N: NEntry[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      O.push(e.text);
      N.push({ text: e.text, ctx: O.length - 1 });
    } else if (e.kind === 'old') {
      O.push(e.text);
    } else {
      N.push({ text: e.text, ctx: -1 });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function bsAfterLastCtxOrNew(body: BodyEntry[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].kind === 'ctx' || body[i].kind === 'new') return body[i].bs;
  }
  return false;
}

/** Render the new lines: a context line is the file's own matched line; at tier 2 the
 *  other lines are re-indented from the old lines' leading whitespace to the file's. */
function renderN(fileLines: string[], pos: number, O: string[], N: NEntry[], tier: number): string[] {
  const P = O.length > 0 ? leadingWs(O[0]) : '';
  const F = leadingWs(fileLines[pos]);
  return N.map((e) => {
    if (e.ctx >= 0) return fileLines[pos + e.ctx];
    if (tier === 2) {
      if (e.text === '' || e.text.trim() === '') return e.text;
      if (e.text.startsWith(P)) return F + e.text.slice(P.length);
      return e.text;
    }
    return e.text;
  });
}

/* ------------------------------------------------------------------ */
/* Applying hunks and chunks (SPEC.md sections 6 and 8)                */
/* ------------------------------------------------------------------ */

type ApplyOut = { doc: Doc } | { fail: 'no-match' };

function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean): ApplyOut {
  let lines = [...doc.lines];
  let trail = doc.trail;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkON(h.body);
    const bs = bsAfterLastCtxOrNew(h.body);
    if (O.length > 0) {
      const found = findTier(lines, O, strict);
      if (found === null) return { fail: 'no-match' };
      const target = h.a - 1 + d;
      let best = found.pos[0];
      let bestDist = Math.abs(best - target);
      for (let k = 1; k < found.pos.length; k++) {
        const p = found.pos[k];
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + O.length === lines.length;
      const newLines = renderN(lines, best, O, N, found.tier);
      lines = [...lines.slice(0, best), ...newLines, ...lines.slice(best + O.length)];
      if (atEnd) trail = !bs;
      d += N.length - O.length;
    } else {
      const ins = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = ins === lines.length;
      const newLines = N.map((e) => e.text);
      lines = [...lines.slice(0, ins), ...newLines, ...lines.slice(ins)];
      if (atEnd && N.length > 0) trail = !bs;
      d += N.length;
    }
  }
  return { doc: { br: doc.br, lines, trail } };
}

function applyChunks(doc: Doc, chunks: Chunk[], strict: boolean): ApplyOut {
  let lines = [...doc.lines];
  const trail = doc.trail;
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const a = findAnchor(lines, c.anchor, cursor, strict);
      if (a === null) return { fail: 'no-match' };
      cursor = a + 1;
    }
    const { O, N } = hunkON(c.body);
    if (O.length === 0) {
      const ins = c.eof ? lines.length : cursor;
      const newLines = N.map((e) => e.text);
      lines = [...lines.slice(0, ins), ...newLines, ...lines.slice(ins)];
      cursor = ins + newLines.length;
      continue;
    }
    const found = findTierFrom(lines, O, cursor, strict, c.eof);
    if (found === null) return { fail: 'no-match' };
    const newLines = renderN(lines, found.pos, O, N, found.tier);
    lines = [...lines.slice(0, found.pos), ...newLines, ...lines.slice(found.pos + O.length)];
    cursor = found.pos + newLines.length;
  }
  return { doc: { br: doc.br, lines, trail } };
}

/* ------------------------------------------------------------------ */
/* Detecting the format (SPEC.md section 4)                           */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (stripTrailWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Reading unified diffs (SPEC.md section 6)                          */
/* ------------------------------------------------------------------ */

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function blankSection(): UniSection {
  return {
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  };
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed. */
function patchPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function parseHunkHeader(l: string, i: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  if (m === null) throw new ParseError(i + 1);
  return parseInt(m[1], 10);
}

/** Consume a hunk header at lines[i] and its body; push the hunk; return the next index. */
function consumeHunk(lines: string[], i: number, section: UniSection): number {
  const a = parseHunkHeader(lines[i], i);
  const body: BodyEntry[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const b = lines[j];
    if (b === '') {
      body.push({ kind: 'ctx', text: '', bs: false });
      j++;
      continue;
    }
    const c = b[0];
    if (c === ' ') {
      body.push({ kind: 'ctx', text: b.slice(1), bs: false });
      j++;
      continue;
    }
    if (c === '-') {
      if (b.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
      body.push({ kind: 'old', text: b.slice(1), bs: false });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: b.slice(1), bs: false });
      j++;
      continue;
    }
    if (c === '\\') {
      if (body.length > 0) body[body.length - 1].bs = true;
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.kind === 'ctx' && last.text === '' && !last.bs) body.pop();
    else break;
  }
  section.hunks.push({ a, body });
  return j;
}

function parseUnified(lines: string[]): ParsedEdit[] {
  const sections: UniSection[] = [];
  let i = 0;
  const n = lines.length;
  let cur: UniSection | null = null;
  let inHeader = false;
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new ParseError(i + 1);
      const s = blankSection();
      s.diffOld = m[1];
      s.diffNew = m[2];
      sections.push(s);
      cur = s;
      inHeader = true;
      i++;
      continue;
    }
    if (cur !== null && !inHeader && l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      const s = blankSection();
      s.pairOld = patchPath(l);
      s.pairNew = patchPath(lines[i + 1]);
      sections.push(s);
      cur = s;
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new ParseError(i + 1);
      if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
        const s = blankSection();
        s.pairOld = patchPath(l);
        s.pairNew = patchPath(lines[i + 1]);
        sections.push(s);
        cur = s;
        inHeader = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('@@')) {
        i = consumeHunk(lines, i, cur);
        inHeader = false;
        continue;
      }
      if (l.startsWith('--- ')) {
        if (i + 1 < n && lines[i + 1].startsWith('+++ ')) {
          // A second pair in the header names the paths again, replacing the first.
          cur.pairOld = patchPath(l);
          cur.pairNew = patchPath(lines[i + 1]);
          i += 2;
          continue;
        }
        throw new ParseError(i + 2);
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      i = consumeHunk(lines, i, cur);
      continue;
    }
    i++;
  }
  return sections.map((s) => {
    const oldPath = s.pairOld ?? s.renameFrom ?? s.diffOld;
    const newPath = s.pairNew ?? s.renameTo ?? s.diffNew;
    return { f: 'uni', oldPath, newPath, newFile: s.newFile, delFile: s.delFile, hunks: s.hunks } as ParsedEdit;
  });
}

/* ------------------------------------------------------------------ */
/* Reading SEARCH/REPLACE blocks (SPEC.md section 7)                  */
/* ------------------------------------------------------------------ */

function parseSR(lines: string[]): ParsedEdit[] {
  const blocks: ParsedEdit[] = [];
  const marker = (l: string, m: string): boolean => stripTrailWs(l) === m;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (!marker(lines[i], '<<<<<<< SEARCH')) {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j];
      if (t.trim() === '') continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = (blocks[blocks.length - 1] as { f: 'sr'; path: string }).path;
      else throw new ParseError(searchLine);
    }
    let k = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (marker(lines[j], '=======')) {
        k = j;
        break;
      }
    }
    if (k === -1) throw new ParseError(searchLine);
    let m = -1;
    for (let j = k + 1; j < lines.length; j++) {
      if (marker(lines[j], '>>>>>>> REPLACE')) {
        m = j;
        break;
      }
    }
    if (m === -1) throw new ParseError(searchLine);
    blocks.push({ f: 'sr', path, old: lines.slice(i + 1, k), nw: lines.slice(k + 1, m) });
    prevEnd = m + 1;
    i = m + 1;
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Reading V4A patches (SPEC.md section 8)                            */
/* ------------------------------------------------------------------ */

function parseV4aUpdate(path: string, raw: { text: string; num: number }[], updLine: number): ParsedEdit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0].text.startsWith('*** Move to: ')) {
    moveTo = raw[0].text.slice(13).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let afterEof = false;
  for (let k = idx; k < raw.length; k++) {
    const r = raw[k];
    const t = r.text;
    if (t.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const a = t.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, body: [] };
      afterEof = false;
      continue;
    }
    if (t === '*** End of File') {
      if (cur === null) throw new ParseError(r.num);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      afterEof = true;
      continue;
    }
    if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      const e: BodyEntry =
        t === ''
          ? { kind: 'ctx', text: '', bs: false }
          : t.startsWith(' ')
            ? { kind: 'ctx', text: t.slice(1), bs: false }
            : t.startsWith('-')
              ? { kind: 'old', text: t.slice(1), bs: false }
              : { kind: 'new', text: t.slice(1), bs: false };
      if (cur !== null) {
        cur.body.push(e);
        continue;
      }
      if (chunks.length === 0 && !afterEof) {
        cur = { anchor: null, eof: false, body: [e] };
        continue;
      }
      if (t === '') continue;
      throw new ParseError(r.num);
    }
    throw new ParseError(r.num);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new ParseError(updLine);
  return { f: 'v4a-upd', path, moveTo, chunks };
}

function parseV4a(lines: string[]): ParsedEdit[] {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (lines[i].trim() !== '') {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(n + 1);
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: ParsedEdit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (l.trim() === '') {
      i++;
      continue;
    }
    if (!isStart(l)) throw new ParseError(i + 1);
    const raw: { text: string; num: number }[] = [];
    let j = i + 1;
    while (j < last && !isStart(lines[j])) {
      raw.push({ text: lines[j], num: j + 1 });
      j++;
    }
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const out: string[] = [];
      for (const r of raw) {
        if (r.text === '') out.push('');
        else if (r.text.startsWith('+')) out.push(r.text.slice(1));
        else throw new ParseError(r.num);
      }
      edits.push({ f: 'v4a-add', path, lines: out });
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      if (raw.length > 0) throw new ParseError(raw[0].num);
      edits.push({ f: 'v4a-del', path });
    } else {
      const path = l.slice(17).trim();
      edits.push(parseV4aUpdate(path, raw, i + 1));
    }
    i = j;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Reading JSON edits (SPEC.md section 9)                             */
/* ------------------------------------------------------------------ */

function validateJsonEdit(val: unknown, line: number): ParsedEdit {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) throw new ParseError(line);
  const o = val as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseError(line);
  if (typeof o.command !== 'string') throw new ParseError(line);
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseError(line);
    return { f: 'json-create', path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseError(line);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(line);
    return { f: 'json-replace', path, oldStr: o.old_str, newStr: typeof o.new_str === 'string' ? o.new_str : '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseError(line);
    if (typeof o.new_str !== 'string') throw new ParseError(line);
    return { f: 'json-insert', path, line: o.insert_line, newStr: o.new_str };
  }
  throw new ParseError(line);
}

function parseJson(lines: string[], rawText: string): ParsedEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return [];
  const firstChar = lines[first].trimStart()[0];
  if (firstChar === '[') {
    let val: unknown;
    try {
      val = JSON.parse(rawText);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(val)) throw new ParseError(first + 1);
    const edits: ParsedEdit[] = [];
    for (const el of val) edits.push(validateJsonEdit(el, first + 1));
    return edits;
  }
  const edits: ParsedEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    let val: unknown;
    try {
      val = JSON.parse(l);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(validateJsonEdit(val, i + 1));
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Applying the edits (SPEC.md sections 2, 6, 7, 8, 9 and 10)         */
/* ------------------------------------------------------------------ */

function countOcc(text: string, sub: string): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const j = text.indexOf(sub, i);
    if (j < 0) break;
    n++;
    i = j + 1;
  }
  return n;
}

function applyUnified(ed: Extract<ParsedEdit, { f: 'uni' }>, tree: Tree, strict: boolean, moves: { from: string; to: string }[]): Fail | null {
  const oldP = ed.oldPath;
  const newP = ed.newPath;
  for (const p of [oldP, newP]) {
    if (p !== null && !isSafe(p)) return { code: 'unsafe', path: p };
  }
  const isCreate = ed.newFile || oldP === null;
  const isDelete = ed.delFile || newP === null;
  if (isCreate) {
    if (newP === null) return { code: 'unsafe', path: '' };
    const cur = tree.read(newP);
    if (cur.k !== 'absent') return { code: 'exists', path: newP };
    const plus: string[] = [];
    let bsLast = false;
    for (const h of ed.hunks) {
      for (const e of h.body) {
        if (e.kind === 'new') {
          plus.push(e.text);
          bsLast = e.bs;
        }
      }
    }
    tree.set(newP, { br: '\n', lines: plus, trail: plus.length > 0 && !bsLast });
    return null;
  }
  if (isDelete) {
    if (oldP === null) return { code: 'unsafe', path: '' };
    const cur = tree.read(oldP);
    if (cur.k !== 'file') return { code: 'missing', path: oldP };
    tree.set(oldP, null);
    return null;
  }
  const op = oldP!;
  const np = newP!;
  if (op !== np) {
    const cur = tree.read(op);
    if (cur.k !== 'file') return { code: 'missing', path: op };
    const curNew = tree.read(np);
    if (curNew.k !== 'absent') return { code: 'exists', path: np };
    const r = applyHunks(cur.doc, ed.hunks, strict);
    if ('fail' in r) return { code: r.fail, path: op };
    tree.set(op, null);
    tree.set(np, r.doc);
    moves.push({ from: op, to: np });
    return null;
  }
  const cur = tree.read(op);
  if (cur.k !== 'file') return { code: 'missing', path: op };
  const r = applyHunks(cur.doc, ed.hunks, strict);
  if ('fail' in r) return { code: r.fail, path: op };
  tree.set(op, r.doc);
  return null;
}

function applySR(ed: Extract<ParsedEdit, { f: 'sr' }>, tree: Tree, strict: boolean): Fail | null {
  if (!isSafe(ed.path)) return { code: 'unsafe', path: ed.path };
  if (ed.old.length === 0) {
    const cur = tree.read(ed.path);
    if (cur.k !== 'absent') return { code: 'exists', path: ed.path };
    tree.set(ed.path, { br: '\n', lines: [...ed.nw], trail: ed.nw.length > 0 });
    return null;
  }
  const cur = tree.read(ed.path);
  if (cur.k !== 'file') return { code: 'missing', path: ed.path };
  const doc = cur.doc;
  const found = findTier(doc.lines, ed.old, strict);
  if (found === null) return { code: 'no-match', path: ed.path };
  if (found.pos.length !== 1) return { code: 'ambiguous', path: ed.path };
  const pos = found.pos[0];
  const N: NEntry[] = ed.nw.map((text) => ({ text, ctx: -1 }));
  const newLines = renderN(doc.lines, pos, ed.old, N, found.tier);
  tree.set(ed.path, {
    br: doc.br,
    lines: [...doc.lines.slice(0, pos), ...newLines, ...doc.lines.slice(pos + ed.old.length)],
    trail: doc.trail,
  });
  return null;
}

function applyV4aAdd(ed: Extract<ParsedEdit, { f: 'v4a-add' }>, tree: Tree): Fail | null {
  if (!isSafe(ed.path)) return { code: 'unsafe', path: ed.path };
  const cur = tree.read(ed.path);
  if (cur.k !== 'absent') return { code: 'exists', path: ed.path };
  tree.set(ed.path, { br: '\n', lines: [...ed.lines], trail: ed.lines.length > 0 });
  return null;
}

function applyV4aDel(ed: Extract<ParsedEdit, { f: 'v4a-del' }>, tree: Tree): Fail | null {
  if (!isSafe(ed.path)) return { code: 'unsafe', path: ed.path };
  const cur = tree.read(ed.path);
  if (cur.k !== 'file') return { code: 'missing', path: ed.path };
  tree.set(ed.path, null);
  return null;
}

function applyV4aUpd(
  ed: Extract<ParsedEdit, { f: 'v4a-upd' }>,
  tree: Tree,
  strict: boolean,
  moves: { from: string; to: string }[],
): Fail | null {
  if (!isSafe(ed.path)) return { code: 'unsafe', path: ed.path };
  if (ed.moveTo !== null && !isSafe(ed.moveTo)) return { code: 'unsafe', path: ed.moveTo };
  const cur = tree.read(ed.path);
  if (cur.k !== 'file') return { code: 'missing', path: ed.path };
  if (ed.moveTo !== null) {
    const t = tree.read(ed.moveTo);
    if (t.k !== 'absent') return { code: 'exists', path: ed.moveTo };
  }
  const r = applyChunks(cur.doc, ed.chunks, strict);
  if ('fail' in r) return { code: r.fail, path: ed.path };
  if (ed.moveTo !== null) {
    tree.set(ed.path, null);
    tree.set(ed.moveTo, r.doc);
    moves.push({ from: ed.path, to: ed.moveTo });
  } else {
    tree.set(ed.path, r.doc);
  }
  return null;
}

function applyJsonCreate(ed: Extract<ParsedEdit, { f: 'json-create' }>, tree: Tree): Fail | null {
  if (!isSafe(ed.path)) return { code: 'unsafe', path: ed.path };
  const cur = tree.read(ed.path);
  if (cur.k !== 'absent') return { code: 'exists', path: ed.path };
  tree.set(ed.path, parseDoc(ed.text));
  return null;
}

function applyJsonReplace(ed: Extract<ParsedEdit, { f: 'json-replace' }>, tree: Tree): Fail | null {
  if (!isSafe(ed.path)) return { code: 'unsafe', path: ed.path };
  const cur = tree.read(ed.path);
  if (cur.k !== 'file') return { code: 'missing', path: ed.path };
  const doc = cur.doc;
  const raw = renderDoc(doc);
  if (doc.br === '\r\n') {
    const text = raw.replace(/\r\n/g, '\n');
    const oldS = ed.oldStr.replace(/\r\n/g, '\n');
    const newS = ed.newStr.replace(/\r\n/g, '\n');
    const n = countOcc(text, oldS);
    if (n === 0) return { code: 'no-match', path: ed.path };
    if (n > 1) return { code: 'ambiguous', path: ed.path };
    const out = text.replace(oldS, () => newS).replace(/\n/g, '\r\n');
    tree.set(ed.path, parseDoc(out));
    return null;
  }
  const n = countOcc(raw, ed.oldStr);
  if (n === 0) return { code: 'no-match', path: ed.path };
  if (n > 1) return { code: 'ambiguous', path: ed.path };
  tree.set(ed.path, parseDoc(raw.replace(ed.oldStr, () => ed.newStr)));
  return null;
}

function applyJsonInsert(ed: Extract<ParsedEdit, { f: 'json-insert' }>, tree: Tree): Fail | null {
  if (!isSafe(ed.path)) return { code: 'unsafe', path: ed.path };
  const cur = tree.read(ed.path);
  if (cur.k !== 'file') return { code: 'missing', path: ed.path };
  const doc = cur.doc;
  if (ed.line < 0 || ed.line > doc.lines.length) return { code: 'no-match', path: ed.path };
  const ins = splitPatch(ed.newStr);
  tree.set(ed.path, {
    br: doc.br,
    lines: [...doc.lines.slice(0, ed.line), ...ins, ...doc.lines.slice(ed.line)],
    trail: doc.trail,
  });
  return null;
}

function applyEdit(ed: ParsedEdit, tree: Tree, strict: boolean, moves: { from: string; to: string }[]): Fail | null {
  switch (ed.f) {
    case 'uni':
      return applyUnified(ed, tree, strict, moves);
    case 'sr':
      return applySR(ed, tree, strict);
    case 'v4a-add':
      return applyV4aAdd(ed, tree);
    case 'v4a-del':
      return applyV4aDel(ed, tree);
    case 'v4a-upd':
      return applyV4aUpd(ed, tree, strict, moves);
    case 'json-create':
      return applyJsonCreate(ed, tree);
    case 'json-replace':
      return applyJsonReplace(ed, tree);
    case 'json-insert':
      return applyJsonInsert(ed, tree);
  }
}

/* ------------------------------------------------------------------ */
/* The command line (SPEC.md sections 1 and 2)                        */
/* ------------------------------------------------------------------ */

interface RunOut {
  code: number;
  out: string[];
}

function usage(): RunOut {
  return { code: 2, out: ['error: usage'] };
}

function run(argv: string[]): RunOut {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let endOpts = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  for (const a of argv) {
    if (!endOpts) {
      if (a === '--') {
        endOpts = true;
        continue;
      }
      if (a.startsWith('--format=')) {
        if (seenFormat) return usage();
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usage();
        format = v;
        continue;
      }
      if (a === '--check') {
        if (seenCheck) return usage();
        seenCheck = true;
        check = true;
        continue;
      }
      if (a === '--strict') {
        if (seenStrict) return usage();
        seenStrict = true;
        strict = true;
        continue;
      }
      if (a.startsWith('-') && a !== '-') return usage();
      positional.push(a);
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) return usage();
  const patchArg = positional[0];

  let patchText: string;
  try {
    patchText = patchArg === undefined || patchArg === '-' ? readFileSync(0, 'utf8') : readFileSync(patchArg, 'utf8');
  } catch {
    return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(patchText);
  const fmt = format ?? detect(lines);
  if (fmt === null) return { code: 2, out: ['error: format'] };
  let edits: ParsedEdit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSR(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };

  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const ed of edits) {
    const f = applyEdit(ed, tree, strict, moves);
    if (f !== null) fails.push(f);
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const changes: { path: string; after: string | null }[] = [];
  for (const p of tree.keys()) {
    const before = tree.orig(p);
    const after = tree.currentText(p);
    if (before !== after) changes.push({ path: p, after });
  }
  const rows: { key: string; line: string }[] = changes.map((c) => ({
    key: c.path,
    line: `${tree.orig(c.path) === null ? 'A' : c.after === null ? 'D' : 'M'} ${c.path}`,
  }));
  for (const m of moves) {
    const bOld = tree.orig(m.from);
    const aOld = tree.currentText(m.from);
    const bNew = tree.orig(m.to);
    const aNew = tree.currentText(m.to);
    if (bOld !== null && aOld === null && bNew === null && aNew !== null) {
      const di = rows.findIndex((r) => r.key === m.from && r.line.startsWith('D '));
      if (di >= 0) rows.splice(di, 1);
      const ai = rows.findIndex((r) => r.key === m.to && r.line.startsWith('A '));
      if (ai >= 0) rows.splice(ai, 1);
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
    }
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  if (!check) {
    for (const c of changes) {
      if (c.after === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.after);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
