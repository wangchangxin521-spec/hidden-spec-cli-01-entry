// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Line matching and file model (SPEC.md sections 3 and 5). Written for this
// entry: the starter only did sections 1-4, 9 and 10.
// ---------------------------------------------------------------------------

/** Options the three line formats need: exact-only matching, and the list of
 *  moves that succeeded, so the output can print `R` rows for them. */
interface Opts {
  strict: boolean;
  moves: Array<[string, string]>;
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const onlyWs = (s: string): boolean => /^[ \t]+$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions where O occurs in lines at the given tier; occurrences may overlap. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const k = oldLines.length;
  if (k === 0) return out;
  for (let i = 0; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(lines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier at which O occurs at least once, with its positions; null when none. */
function firstTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(lines, oldLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** A file as lines: its line break, its lines, whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** One body line of a unified hunk or a V4A chunk: context, old, new, or the
 *  `\` line (as in `\ No newline at end of file`). */
type BodyOp = { kind: 'ctx' | 'old' | 'new' | 'mark'; text: string };

function oldLinesOf(ops: BodyOp[]): string[] {
  return ops.filter((o) => o.kind === 'ctx' || o.kind === 'old').map((o) => o.text);
}

/**
 * The lines that replace a matched occurrence. A context line is written as the
 * file's own matched line, never the patch's. At tier 2 every other line of N
 * is re-indented: a line that is not empty and not only whitespace, and starts
 * with P (the leading spaces and tabs of O's first line), has that P replaced
 * by F (those of the file's first matched line).
 */
function buildNew(ops: BodyOp[], fileLines: string[], at: number, tier: number): string[] {
  const O = oldLinesOf(ops);
  const out: string[] = [];
  const isCtx: boolean[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[at + oi]!);
      isCtx.push(true);
      oi++;
    } else if (op.kind === 'old') {
      oi++;
    } else if (op.kind === 'new') {
      out.push(op.text);
      isCtx.push(false);
    }
  }
  if (tier === 2 && O.length > 0) {
    const F = leadingWs(fileLines[at]!);
    const P = leadingWs(O[0]!);
    for (let k = 0; k < out.length; k++) {
      if (isCtx[k]) continue;
      const t = out[k]!;
      if (t !== '' && !onlyWs(t) && t.startsWith(P)) out[k] = F + t.slice(P.length);
    }
  }
  return out;
}

/** Same re-indentation as buildNew, for plain old/new line arrays (SEARCH/REPLACE). */
function buildNewFromArrays(O: string[], N: string[], fileLines: string[], at: number, tier: number): string[] {
  if (tier !== 2 || O.length === 0) return [...N];
  const F = leadingWs(fileLines[at]!);
  const P = leadingWs(O[0]!);
  return N.map((t) => (t !== '' && !onlyWs(t) && t.startsWith(P) ? F + t.slice(P.length) : t));
}

/** Whether a `\` line follows the hunk or chunk's last context or `+` line. */
function noEol(ops: BodyOp[]): boolean {
  let last = -1;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === 'ctx' || ops[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return ops[last + 1]?.kind === 'mark';
}

/** Whether a `\` line follows the last `+` line of any of the hunks, in order. */
function createdNoEol(hunks: { ops: BodyOp[] }[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const ops = hunks[h]!.ops;
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i]!.kind === 'new') return ops[i + 1]?.kind === 'mark';
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  ops: BodyOp[];
  oLen: number;
  nLen: number;
}

interface UnifiedSection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  /** `---`/`+++` pair: undefined when no pair, null when `/dev/null`. */
  pmOld: string | null | undefined;
  pmNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

const newSection = (): UnifiedSection => ({
  gitOld: undefined,
  gitNew: undefined,
  pmOld: undefined,
  pmNew: undefined,
  renameFrom: undefined,
  renameTo: undefined,
  isNew: false,
  isDeleted: false,
  hunks: [],
});

const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?=$|[ \t])/;

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the
 *  first tab, with surrounding spaces removed; a leading `a/` or `b/` removed;
 *  `/dev/null` means no file. */
function diffPath(text: string): string | null {
  const t = text.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

const isBodyLine = (l: string): boolean =>
  l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');

function bodyOp(l: string): BodyOp {
  if (l === '') return { kind: 'ctx', text: '' };
  if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (l[0] === '-') return { kind: 'old', text: l.slice(1) };
  if (l[0] === '+') return { kind: 'new', text: l.slice(1) };
  return { kind: 'mark', text: l.slice(1) };
}

/** Apply one hunk to the model; d is the section's length delta so far. */
function applyUnifiedHunk(m: FileModel, hunk: Hunk, d: number, strict: boolean, path: string): void {
  const O = oldLinesOf(hunk.ops);
  if (O.length > 0) {
    const found = firstTier(m.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let at = found.occ[0]!;
    let best = Math.abs(at - target);
    for (const o of found.occ) {
      const dist = Math.abs(o - target);
      if (dist < best) {
        best = dist;
        at = o;
      }
    }
    const touchesEnd = at + O.length === m.lines.length;
    const replacement = buildNew(hunk.ops, m.lines, at, found.tier);
    m.lines.splice(at, O.length, ...replacement);
    if (touchesEnd) m.final = !noEol(hunk.ops);
  } else {
    const pos = Math.max(0, Math.min(hunk.a + d, m.lines.length));
    const atEnd = pos === m.lines.length;
    const replacement = buildNew(hunk.ops, m.lines, pos, 0);
    m.lines.splice(pos, 0, ...replacement);
    if (atEnd) m.final = !noEol(hunk.ops);
  }
}

function unifiedSectionEdit(sec: UnifiedSection, opts: Opts): Edit {
  return (tree) => {
    const oldPath = sec.pmOld !== undefined ? sec.pmOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
    const newPath = sec.pmNew !== undefined ? sec.pmNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
    const isCreation = oldPath === null || sec.isNew;
    const isDeletion = newPath === null || sec.isDeleted;
    if (isCreation) {
      const p = newPath;
      if (p === null || p === undefined) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      for (const h of sec.hunks) {
        for (const op of h.ops) if (op.kind === 'new') lines.push(op.text);
      }
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + (createdNoEol(sec.hunks) ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const p = oldPath;
      if (p === null || p === undefined) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath === undefined || newPath === undefined) return;
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const m = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        applyUnifiedHunk(m, h, d, opts.strict, oldPath);
        d += h.nLen - h.oLen;
      }
      tree.now.set(newPath, serializeFile(m));
      tree.now.set(oldPath, null);
      opts.moves.push([oldPath, newPath]);
      return;
    }
    const p = oldPath;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const m = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      applyUnifiedHunk(m, h, d, opts.strict, p);
      d += h.nLen - h.oLen;
    }
    tree.now.set(p, serializeFile(m));
  };
}

function unifiedEdits(lines: string[], opts: Opts): Edit[] {
  const sections: UnifiedSection[] = [];
  let sec: UnifiedSection | null = null;
  let hunk: Hunk | null = null;
  const finishHunk = (): void => {
    if (hunk === null) return;
    while (hunk.ops.length > 0) {
      const last = hunk.ops[hunk.ops.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') hunk.ops.pop();
      else break;
    }
    hunk.oLen = oldLinesOf(hunk.ops).length;
    hunk.nLen = hunk.ops.filter((o) => o.kind === 'ctx' || o.kind === 'new').length;
    sec!.hunks.push(hunk);
    hunk = null;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (hunk !== null) {
      // A `--- ` line followed by a `+++ ` line ends the body, even though it
      // starts with `-`: it is the next section's header, not an old line.
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishHunk();
        // fall through: this line is handled outside a body
      } else if (isBodyLine(line)) {
        hunk.ops.push(bodyOp(line));
        i++;
        continue;
      } else {
        finishHunk();
        // fall through: this line is handled outside a body
      }
    }
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), ops: [], oLen: 0, nLen: 0 };
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nextIsPlus = (lines[i + 1] ?? '').startsWith('+++ ');
      if (nextIsPlus) {
        const oldP = diffPath(line.slice(4));
        const newP = diffPath(lines[i + 1]!.slice(4));
        if (sec !== null && sec.hunks.length === 0) {
          sec.pmOld = oldP;
          sec.pmNew = newP;
        } else {
          sec = newSection();
          sec.pmOld = oldP;
          sec.pmNew = newP;
          sections.push(sec);
        }
        i += 2;
        continue;
      }
      if (sec !== null && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.isNew = true;
      else if (line.startsWith('deleted file mode')) sec.isDeleted = true;
    }
    i++;
  }
  finishHunk();
  return sections.map((s) => unifiedSectionEdit(s, opts));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], opts: Opts): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const block: SearchBlock = { path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) };
    edits.push(searchReplaceEdit(block, opts));
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(block: SearchBlock, opts: Opts): Edit {
  return (tree) => {
    const p = block.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (block.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const m = parseFile(before);
    const found = firstTier(m.lines, block.oldLines, opts.strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const at = found.occ[0]!;
    const replacement = buildNewFromArrays(block.oldLines, block.newLines, m.lines, at, found.tier);
    m.lines.splice(at, block.oldLines.length, ...replacement);
    tree.now.set(p, serializeFile(m));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** null when the chunk has no anchor. */
  anchor: string | null;
  ops: BodyOp[];
  eof: boolean;
}

function v4aEdits(lines: string[], opts: Opts): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      const addLines: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (l.startsWith('+')) {
          addLines.push(l.slice(1));
          j++;
        } else if (blank(l)) {
          addLines.push('');
          j++;
        } else break;
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') addLines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i;
      let moveTo: string | undefined;
      let j = i + 1;
      if (j < last && lines[j]!.startsWith('*** Move to:')) {
        moveTo = lines[j]!.slice('*** Move to:'.length).trim();
        j++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let started = false;
      let pendingBlanks = 0;
      const finishChunk = (): void => {
        if (cur === null) return;
        while (cur.ops.length > 0) {
          const lastOp = cur.ops[cur.ops.length - 1]!;
          if (lastOp.kind === 'ctx' && lastOp.text === '') cur.ops.pop();
          else break;
        }
        chunks.push(cur);
        cur = null;
      };
      while (j < last) {
        const l = lines[j]!;
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          pendingBlanks = 0;
          finishChunk();
          chunks[chunks.length - 1]!.eof = true;
          j++;
          continue;
        }
        if (l.startsWith('@@')) {
          finishChunk();
          pendingBlanks = 0;
          cur = { anchor: l.slice(2).trim(), ops: [], eof: false };
          started = true;
          j++;
          continue;
        }
        if (isSectionStart(l)) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur !== null) {
            cur.ops.push(bodyOp(l));
            j++;
            continue;
          }
          if (!started) {
            cur = { anchor: null, ops: [], eof: false };
            started = true;
            for (let k = 0; k < pendingBlanks; k++) cur.ops.push({ kind: 'ctx', text: '' });
            pendingBlanks = 0;
            cur.ops.push(bodyOp(l));
            j++;
            continue;
          }
          throw new Exit2(`error: parse ${j + 1}`);
        }
        if (blank(l)) {
          if (cur !== null) cur.ops.push({ kind: 'ctx', text: '' });
          else pendingBlanks++;
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      finishChunk();
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, opts));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | undefined, chunks: V4aChunk[], opts: Opts): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = parseFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        let anchorAt: number | null = null;
        for (const t of tiers(opts.strict)) {
          for (let k = cursor; k < m.lines.length; k++) {
            if (lineEq(m.lines[k]!, chunk.anchor, t)) {
              anchorAt = k;
              break;
            }
          }
          if (anchorAt !== null) break;
        }
        if (anchorAt === null) throw new Fail('no-match', path);
        cursor = anchorAt + 1;
      }
      const O = oldLinesOf(chunk.ops);
      if (O.length === 0) {
        const pos = chunk.eof ? m.lines.length : cursor;
        const replacement = buildNew(chunk.ops, m.lines, pos, 0);
        m.lines.splice(pos, 0, ...replacement);
        cursor = pos + replacement.length;
        continue;
      }
      let found: { at: number; tier: number } | null = null;
      for (const t of tiers(opts.strict)) {
        const occ = occurrences(m.lines, O, t).filter((p) => p >= cursor && (!chunk.eof || p + O.length === m.lines.length));
        if (occ.length > 0) {
          found = { at: occ[0]!, tier: t };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const replacement = buildNew(chunk.ops, m.lines, found.at, found.tier);
      m.lines.splice(found.at, O.length, ...replacement);
      cursor = found.at + replacement.length;
    }
    const out = serializeFile(m);
    if (moveTo !== undefined) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      opts.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  const opts: Opts = { strict, moves };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, opts)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, opts)
            : v4aEdits(lines, opts);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const covered = new Set<string>();
  const rowItems: { key: string; text: string }[] = [];
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rowItems.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rowItems.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowItems.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowItems.map((r) => r.text);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
