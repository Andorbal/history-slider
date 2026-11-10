/** Pure filtering, sorting and tree logic for the branch view's file list. No DOM access. */
import { CHANGE_KINDS, type ChangeKind, type FileChange, type SortMode } from '../src/shared/branchProtocol';

export interface CompiledQuery {
  /** True when the query has no terms, so everything matches. */
  empty: boolean;
  /** Why the query can't be used (an invalid regular expression). */
  error?: string;
  test(file: Pick<FileChange, 'path' | 'oldPath'>): boolean;
}

export interface QueryOptions {
  matchCase: boolean;
  regex: boolean;
}

const GLOB_CHARS = /[*?[\]{}]/;

/** Splits a query into terms on whitespace, keeping "quoted phrases" together. */
export function splitTerms(query: string): string[] {
  const terms: string[] = [];
  const re = /(!|-)?"([^"]*)"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) terms.push(m[2] !== undefined ? `${m[1] ?? ''}${m[2]}` : m[0]);
  return terms.filter((t) => t && t !== '!' && t !== '-');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns a glob into a regular expression over repo-relative paths.
 * `*` and `?` stay within a path segment, `**` crosses them, `{a,b}` and
 * `[abc]` work as usual. A glob matches the whole path or any tail of it that
 * starts at a folder boundary, so `*.ts` matches `src/app.ts` and `src/*.ts`
 * matches `packages/web/src/app.ts`; a leading `/` anchors it at the root and
 * a trailing `/` matches everything inside a folder.
 */
export function globToRegex(glob: string, matchCase: boolean): RegExp {
  let g = glob;
  const anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  if (g.endsWith('/')) g += '**';
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // "**/" may match no folders at all.
        if (g[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end < 0) {
        out += '\\[';
        continue;
      }
      let cls = g.slice(i + 1, end);
      if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
      out += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else if (c === '{') {
      const end = g.indexOf('}', i + 1);
      if (end < 0) {
        out += '\\{';
        continue;
      }
      const alternatives = g.slice(i + 1, end).split(',').map((a) => globToRegex(`/${a}`, true).source.slice(1, -1));
      out += `(?:${alternatives.join('|')})`;
      i = end;
    } else {
      out += escapeRegex(c);
    }
  }
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${out}$`, matchCase ? '' : 'i');
}

type PathTest = (p: string) => boolean;

function termTest(term: string, matchCase: boolean): PathTest {
  // Commas give alternatives: "*.ts,*.tsx".
  const parts = term.split(',').filter(Boolean);
  const tests = parts.map((part): PathTest => {
    if (GLOB_CHARS.test(part) || part.startsWith('/')) {
      const re = globToRegex(part, matchCase);
      return (p) => re.test(p);
    }
    const needle = matchCase ? part : part.toLowerCase();
    return (p) => (matchCase ? p : p.toLowerCase()).includes(needle);
  });
  return (p) => tests.some((t) => t(p));
}

/**
 * Compiles the filter box. Without regex: space-separated terms that must all
 * match (path or old path), `!term` (or `-term`) to exclude, each term a glob
 * or plain text. With regex: the whole query is one regular expression.
 */
export function compileQuery(query: string, o: QueryOptions): CompiledQuery {
  const trimmed = query.trim();
  if (!trimmed) return { empty: true, test: () => true };
  const paths = (f: Pick<FileChange, 'path' | 'oldPath'>) => (f.oldPath ? [f.path, f.oldPath] : [f.path]);
  if (o.regex) {
    let re: RegExp;
    try {
      re = new RegExp(trimmed, o.matchCase ? '' : 'i');
    } catch (err) {
      return { empty: false, error: (err as Error).message, test: () => true };
    }
    return { empty: false, test: (f) => paths(f).some((p) => re.test(p)) };
  }
  const include: PathTest[] = [];
  const exclude: PathTest[] = [];
  for (const term of splitTerms(trimmed)) {
    if (term.startsWith('!') || term.startsWith('-')) exclude.push(termTest(term.slice(1), o.matchCase));
    else include.push(termTest(term, o.matchCase));
  }
  return {
    empty: !include.length && !exclude.length,
    test: (f) => {
      const ps = paths(f);
      return include.every((t) => ps.some(t)) && !exclude.some((t) => ps.some(t));
    },
  };
}

export type KindCounts = Record<ChangeKind, number>;

export function countKinds(files: readonly FileChange[]): KindCounts {
  const counts = Object.fromEntries(CHANGE_KINDS.map((k) => [k, 0])) as KindCounts;
  for (const f of files) counts[f.kind]++;
  return counts;
}

export interface FilterResult {
  /** Files that pass the query and the kind filters. */
  shown: FileChange[];
  /** Files that pass the query, per kind (what each kind's chip counts). */
  counts: KindCounts;
  /** Files the query matched, before kind filters. */
  matched: number;
}

export function filterFiles(files: readonly FileChange[], query: CompiledQuery, hidden: ReadonlySet<ChangeKind>): FilterResult {
  const matched = query.empty || query.error ? [...files] : files.filter((f) => query.test(f));
  return { shown: matched.filter((f) => !hidden.has(f.kind)), counts: countKinds(matched), matched: matched.length };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const KIND_ORDER = new Map(CHANGE_KINDS.map((k, i) => [k, i]));

export function size(f: FileChange): number {
  return (f.added ?? 0) + (f.deleted ?? 0);
}

export function compareFiles(sort: SortMode): (a: FileChange, b: FileChange) => number {
  const byPath = (a: FileChange, b: FileChange) => collator.compare(a.path, b.path);
  if (sort === 'size') return (a, b) => size(b) - size(a) || byPath(a, b);
  if (sort === 'kind') return (a, b) => KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! || byPath(a, b);
  return byPath;
}

export interface DirNode {
  /** Path from the root, without a trailing slash ('' for the root). */
  path: string;
  /** What the row shows: one folder, or several when single-child folders are compacted ("src/core"). */
  name: string;
  dirs: DirNode[];
  files: FileChange[];
  /** Totals over everything inside. */
  fileCount: number;
  added: number;
  deleted: number;
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Builds a folder tree of the files, compacting chains of folders that only hold one folder. */
export function buildTree(files: readonly FileChange[]): DirNode {
  const root: DirNode = { path: '', name: '', dirs: [], files: [], fileCount: 0, added: 0, deleted: 0 };
  const index = new Map<string, DirNode>([['', root]]);
  const dirFor = (dir: string): DirNode => {
    const existing = index.get(dir);
    if (existing) return existing;
    const parent = dirFor(dirname(dir));
    const node: DirNode = { path: dir, name: basename(dir), dirs: [], files: [], fileCount: 0, added: 0, deleted: 0 };
    parent.dirs.push(node);
    index.set(dir, node);
    return node;
  };
  for (const f of files) dirFor(dirname(f.path)).files.push(f);
  const total = (n: DirNode): void => {
    n.dirs.forEach(total);
    n.fileCount = n.files.length + n.dirs.reduce((s, d) => s + d.fileCount, 0);
    n.added = n.files.reduce((s, f) => s + (f.added ?? 0), 0) + n.dirs.reduce((s, d) => s + d.added, 0);
    n.deleted = n.files.reduce((s, f) => s + (f.deleted ?? 0), 0) + n.dirs.reduce((s, d) => s + d.deleted, 0);
  };
  total(root);
  const compact = (n: DirNode): DirNode => {
    n.dirs = n.dirs.map(compact);
    while (n !== root && n.dirs.length === 1 && n.files.length === 0) {
      const child = n.dirs[0];
      n = { ...child, name: `${n.name}/${child.name}` };
    }
    return n;
  };
  return compact(root);
}

export interface Row {
  type: 'dir' | 'file';
  /** Unique: the folder path, or the file path. */
  key: string;
  depth: number;
  dir?: DirNode;
  file?: FileChange;
  expanded?: boolean;
}

/** The rows of a tree with some folders collapsed: folders first, then files, each sorted. */
export function treeRows(root: DirNode, collapsed: ReadonlySet<string>, sort: SortMode): Row[] {
  const rows: Row[] = [];
  const cmp = compareFiles(sort);
  const walk = (n: DirNode, depth: number) => {
    for (const d of [...n.dirs].sort((a, b) => collator.compare(a.name, b.name))) {
      const expanded = !collapsed.has(d.path);
      rows.push({ type: 'dir', key: `dir:${d.path}`, depth, dir: d, expanded });
      if (expanded) walk(d, depth + 1);
    }
    for (const f of [...n.files].sort(cmp)) rows.push({ type: 'file', key: f.path, depth, file: f });
  };
  walk(root, 0);
  return rows;
}

export function listRows(files: readonly FileChange[], sort: SortMode): Row[] {
  return [...files].sort(compareFiles(sort)).map((f) => ({ type: 'file' as const, key: f.path, depth: 0, file: f }));
}

/** Every folder path in a tree, for collapsing them all. */
export function allDirs(root: DirNode): string[] {
  const out: string[] = [];
  const walk = (n: DirNode) => n.dirs.forEach((d) => (out.push(d.path), walk(d)));
  walk(root);
  return out;
}
