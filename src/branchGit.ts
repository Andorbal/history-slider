/**
 * Git access for the branch view: branches, where a branch was branched (and
 * where that branch was branched...), the commits along a branch, and what
 * changed in the whole repository between two points. Free of `vscode`
 * imports so it can be tested against real repositories.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitError, LOG_FORMAT, RECORD, parseCommitHeader, runGit, runGitText, runLog } from './git';
import type { BaseLevel, ChangeKind, FileChange, FileTouch } from './shared/branchProtocol';
import type { Stop } from './shared/protocol';

export interface RefEntry {
  /** refs/heads/x or refs/remotes/origin/x */
  ref: string;
  /** x or origin/x */
  name: string;
  sha: string;
  remote: boolean;
  /** Full ref of the upstream (local branches). */
  upstream?: string;
  /** Target of a symbolic ref such as refs/remotes/origin/HEAD. */
  symref?: string;
  /** Committer date of the tip, epoch ms. */
  date: number;
  subject: string;
}

export interface Head {
  /** refs/heads/x, or undefined when HEAD is detached (or there are no commits). */
  ref?: string;
  sha?: string;
}

const NUL = '%00';

/** Local and remote-tracking branches, including symbolic refs like origin/HEAD (marked with `symref`). */
export async function listRefs(git: string, root: string): Promise<RefEntry[]> {
  const format = ['%(refname)', '%(objectname)', '%(upstream)', '%(symref)', '%(committerdate:unix)', '%(contents:subject)'].join(NUL);
  const out = await runGitText(git, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'], root);
  const refs: RefEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, sha, upstream, symref, date, subject] = line.split('\0');
    const remote = ref.startsWith('refs/remotes/');
    refs.push({
      ref,
      name: ref.replace(/^refs\/(heads|remotes)\//, ''),
      sha,
      remote,
      upstream: upstream || undefined,
      symref: symref || undefined,
      date: Number(date) * 1000,
      subject: subject ?? '',
    });
  }
  return refs;
}

export async function readHead(git: string, root: string): Promise<Head> {
  const [ref, sha] = await Promise.all([
    runGitText(git, ['symbolic-ref', '-q', 'HEAD'], root).then((s) => s.trim(), () => undefined),
    runGitText(git, ['rev-parse', '-q', '--verify', 'HEAD'], root).then((s) => s.trim(), () => undefined),
  ]);
  return { ref: ref?.startsWith('refs/heads/') ? ref : undefined, sha: sha || undefined };
}

export async function listRemotes(git: string, root: string): Promise<string[]> {
  const out = await runGitText(git, ['remote'], root).catch(() => '');
  return out.split('\n').filter(Boolean);
}

/** The branch name without its remote: origin/feature → feature. */
export function shortName(ref: Pick<RefEntry, 'name' | 'remote'>, remotes: readonly string[]): string {
  if (!ref.remote) return ref.name;
  const remote = [...remotes].sort((a, b) => b.length - a.length).find((r) => ref.name.startsWith(`${r}/`));
  return remote ? ref.name.slice(remote.length + 1) : ref.name.slice(ref.name.indexOf('/') + 1);
}

/**
 * The repository's main line: what each remote's HEAD points at (origin/main),
 * plus local branches of the same name. Falls back to main or master.
 */
export function defaultRefs(refs: readonly RefEntry[], remotes: readonly string[]): Set<string> {
  const out = new Set<string>();
  const names = new Set<string>();
  for (const r of refs) {
    if (!r.symref || !r.remote) continue;
    const target = refs.find((t) => t.ref === r.symref);
    if (!target) continue;
    out.add(target.ref);
    names.add(shortName(target, remotes));
  }
  if (!names.size) {
    for (const n of ['main', 'master']) if (refs.some((r) => shortName(r, remotes) === n)) names.add(n);
    if (names.has('main')) names.delete('master');
  }
  for (const r of refs) if (!r.symref && names.has(shortName(r, remotes))) out.add(r.ref);
  return out;
}

/**
 * Where a local branch pointed when it was created, from its reflog, if that
 * commit is still in the branch's history. Undefined for remote branches,
 * expired reflogs and branches that were rebased since.
 */
export async function creationPoint(git: string, root: string, ref: string, tip: string): Promise<string | undefined> {
  if (!ref.startsWith('refs/heads/')) return undefined;
  let out: string;
  try {
    out = await runGitText(git, ['reflog', 'show', '--format=%H', ref, '--'], root);
  } catch {
    return undefined;
  }
  const lines = out.split('\n').filter(Boolean);
  const oldest = lines[lines.length - 1];
  if (!oldest) return undefined;
  return (await isAncestor(git, root, oldest, tip)) ? oldest : undefined;
}

export async function isAncestor(git: string, root: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(git, ['merge-base', '--is-ancestor', ancestor, descendant], root);
    return true;
  } catch {
    return false;
  }
}

async function refsContaining(git: string, root: string, sha: string): Promise<Set<string>> {
  const out = await runGitText(git, ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes'], root);
  return new Set(out.split('\n').filter(Boolean));
}

export interface BranchTarget {
  ref: string;
  name: string;
  sha: string;
  remote: boolean;
}

export interface LevelOptions {
  maxLevels?: number;
  /** Give up looking for a base this many commits back. */
  maxCommits?: number;
}

/**
 * Finds where `target` was branched, then where that branch was branched, and
 * so on: each level is the nearest commit on the target's first-parent line
 * that another branch also reaches, once the branches of the levels before it
 * are set aside.
 *
 * Topology alone can't tell "I branched off X" from "X branched off me", so a
 * branch's reflog (where it pointed when it was created) is used to skip
 * branches that were started from its own commits, like a PR stacked on it.
 * The repository's default branch has no levels: it is the trunk.
 */
export async function findBaseLevels(
  git: string,
  root: string,
  target: BranchTarget,
  refs: readonly RefEntry[],
  remotes: readonly string[],
  options: LevelOptions = {},
): Promise<BaseLevel[]> {
  const maxLevels = options.maxLevels ?? 8;
  const maxCommits = options.maxCommits ?? 10_000;
  const defaults = defaultRefs(refs, remotes);
  if (defaults.has(target.ref)) return [];
  const own = target.ref === 'HEAD' ? undefined : shortName(target, remotes);
  const containsTip = await refsContaining(git, root, target.sha);
  const candidates = refs.filter(
    (r) =>
      !r.symref &&
      r.ref !== target.ref &&
      !containsTip.has(r.ref) &&
      // The same branch elsewhere (origin/feature for feature) is not a base.
      (own === undefined || shortName(r, remotes) !== own),
  );
  const byRef = new Map(candidates.map((r) => [r.ref, r]));
  const excluded = new Set<string>();
  const levels: BaseLevel[] = [];
  let floor = await creationPoint(git, root, target.ref, target.sha);

  while (levels.length < maxLevels) {
    const active = candidates.filter((c) => !excluded.has(c.ref));
    if (!active.length) break;
    const input = [target.sha, ...new Set(active.map((c) => `^${c.sha}`))].join('\n') + '\n';
    const out = await runGitText(git, ['rev-list', '--first-parent', '--parents', `--max-count=${maxCommits + 1}`, '--stdin'], root, input);
    const commits = out.split('\n').filter(Boolean);
    if (!commits.length || commits.length > maxCommits) break;
    const fork = commits[commits.length - 1].split(' ')[1];
    if (!fork) break; // reached the root commit
    const containing = [...(await refsContaining(git, root, fork))].filter((r) => byRef.has(r) && !excluded.has(r));
    if (!containing.length) break;
    containing.forEach((r) => excluded.add(r));
    // Branches that meet the line after the point it was created at grew out of it.
    // The default branch never did; if it reaches that far it merged part of this line.
    const fromTrunk = containing.some((r) => defaults.has(r));
    if (!fromTrunk && floor && floor !== fork && (await isAncestor(git, root, floor, fork))) continue;
    const names = rankBranches(containing.map((r) => byRef.get(r)!), fork, defaults, remotes);
    levels.push({ sha: fork, shortSha: fork.slice(0, 7), branches: names, distance: commits.length });
    // The next level is where this level's branch was branched.
    const parent = containing.map((r) => byRef.get(r)!).find((r) => r.name === names[0]);
    floor = parent ? await creationPoint(git, root, parent.ref, fork) : undefined;
  }
  return levels;
}

/** Display names, most likely parent first: the default branch, a branch that sits right on the fork, locals, then remotes. */
function rankBranches(refs: RefEntry[], fork: string, defaults: Set<string>, remotes: readonly string[]): string[] {
  const locals = refs.filter((r) => !r.remote);
  // A remote branch that a local one tracks (or shares a name with) is the same branch.
  const kept = refs.filter(
    (r) => !r.remote || !locals.some((l) => l.upstream === r.ref || l.name === shortName(r, remotes)),
  );
  const rank = (r: RefEntry) => (defaults.has(r.ref) ? 0 : r.sha === fork ? 1 : r.remote ? 3 : 2);
  return kept.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map((r) => r.name);
}

// ---- commits ----

export interface RangeQuery {
  tip: string;
  /** Leave out this commit and everything before it. */
  base?: string;
  skip: number;
  limit: number;
}

export interface RangePage {
  /** Oldest first. */
  stops: Stop[];
  hasMore: boolean;
}

function logArgs(diffMerges: boolean): string[] {
  const args = ['log', `--format=${LOG_FORMAT}`, '-z', '--raw', '--numstat', '--no-abbrev', '--no-color', '--no-textconv', '--no-ext-diff', '-M'];
  if (diffMerges) args.push('--diff-merges=first-parent');
  return args;
}

/** One page of the first-parent commits from `tip` back to (not including) `base`, oldest first, with change totals. */
export async function logRange(git: string, root: string, q: RangeQuery): Promise<RangePage> {
  const out = await runLog(git, root, (dm) => {
    const args = [...logArgs(dm), '--first-parent'];
    if (q.skip > 0) args.push(`--skip=${q.skip}`);
    if (Number.isFinite(q.limit)) args.push(`--max-count=${q.limit + 1}`);
    args.push(q.tip);
    if (q.base) args.push(`^${q.base}`);
    return [...args, '--'];
  });
  const stops = parseCommits(out);
  return { stops: stops.slice(0, q.limit).reverse(), hasMore: stops.length > q.limit };
}

/** A single commit with its change totals (vs. its first parent). */
export async function commitStop(git: string, root: string, sha: string): Promise<Stop | undefined> {
  const out = await runLog(git, root, (dm) => [...logArgs(dm), '-1', sha, '--']);
  return parseCommits(out)[0];
}

/** Parses `git log` output made with `logArgs`: commit metadata plus totals over all files. Newest first. */
export function parseCommits(output: string): Stop[] {
  const stops: Stop[] = [];
  for (const record of output.split(RECORD)) {
    if (!record.trim()) continue;
    const headerEnd = record.indexOf('\0');
    const stop = parseCommitHeader(headerEnd >= 0 ? record.slice(0, headerEnd) : record);
    if (!stop) continue;
    const { raws, nums } = parseRawNumstat(headerEnd >= 0 ? record.slice(headerEnd + 1) : '');
    const counts: Record<string, number> = {};
    for (const r of raws) counts[r.status] = (counts[r.status] ?? 0) + 1;
    let added = 0;
    let deleted = 0;
    for (const n of nums) {
      added += n.added ?? 0;
      deleted += n.deleted ?? 0;
    }
    stop.fileCount = raws.length;
    stop.statusCounts = counts;
    stop.added = added;
    stop.deleted = deleted;
    stops.push(stop);
  }
  return stops;
}

// ---- raw + numstat parsing ----

export interface RawEntry {
  status: string;
  score?: number;
  srcPath: string;
  dstPath: string;
  srcMode: string;
  dstMode: string;
  srcOid: string;
  dstOid: string;
}

export interface NumEntry {
  path: string;
  oldPath?: string;
  added?: number;
  deleted?: number;
  binary: boolean;
}

/** Parses the `--raw` and `--numstat` entries that `-z` output puts after a commit header (or makes up all of `git diff`). */
export function parseRawNumstat(text: string): { raws: RawEntry[]; nums: NumEntry[] } {
  const raws: RawEntry[] = [];
  const nums: NumEntry[] = [];
  const tokens = text.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].replace(/^\n+/, '');
    if (!token) continue;
    if (token.startsWith(':')) {
      const [srcMode = '', dstMode = '', srcOid = '', dstOid = '', status = ''] = token.slice(1).split(' ');
      const letter = status.charAt(0);
      const score = status.length > 1 ? Number(status.slice(1)) : undefined;
      if (letter === 'R' || letter === 'C') {
        const src = tokens[++i] ?? '';
        const dst = tokens[++i] ?? '';
        raws.push({ status: letter, score, srcPath: src, dstPath: dst, srcMode, dstMode, srcOid, dstOid });
      } else {
        const p = tokens[++i] ?? '';
        raws.push({ status: letter, score, srcPath: p, dstPath: p, srcMode, dstMode, srcOid, dstOid });
      }
      continue;
    }
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token);
    if (!m) continue;
    let p = m[3];
    let oldPath: string | undefined;
    if (p === '') {
      oldPath = tokens[++i] ?? '';
      p = tokens[++i] ?? '';
    }
    const binary = m[1] === '-' || m[2] === '-';
    nums.push({ path: p, oldPath, binary, added: binary ? undefined : Number(m[1]), deleted: binary ? undefined : Number(m[2]) });
  }
  return { raws, nums };
}

const ZERO_OID = /^0+$/;

/**
 * Sorts a change into one kind. `ws` is the file's line counts when whitespace
 * is ignored: missing when git left the file out of that diff (it does so when
 * only whitespace changed), or undefined when that pass wasn't run.
 */
export function classify(raw: RawEntry, num: NumEntry | undefined, ws: NumEntry | 'missing' | undefined): ChangeKind {
  const sameBlob = raw.srcOid === raw.dstOid && !ZERO_OID.test(raw.srcOid);
  const noLines = !!num && !num.binary && num.added === 0 && num.deleted === 0;
  const changedLines = !!num && !num.binary && (num.added ?? 0) + (num.deleted ?? 0) > 0;
  const whitespaceOnly =
    changedLines && ws !== undefined && (ws === 'missing' || (!ws.binary && ws.added === 0 && ws.deleted === 0));
  switch (raw.status) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'C':
      return 'copied';
    case 'T':
      return 'mode';
    case 'R':
      if (raw.score === 100 || sameBlob || noLines) return 'renamed';
      return whitespaceOnly ? 'whitespace' : 'renamedModified';
    default:
      if ((sameBlob || noLines) && raw.srcMode !== raw.dstMode) return 'mode';
      return whitespaceOnly ? 'whitespace' : 'modified';
  }
}

/** Joins raw entries with their line counts (and the whitespace-blind counts) into file changes. */
export function toFileChanges(raws: RawEntry[], nums: NumEntry[], wsNums: NumEntry[] | undefined, untracked?: Set<string>): FileChange[] {
  const numBy = new Map(nums.map((n) => [n.path, n]));
  const wsBy = wsNums && new Map(wsNums.map((n) => [n.path, n]));
  const seen = new Set<string>();
  const files: FileChange[] = [];
  for (const raw of raws) {
    // Unmerged paths can appear more than once.
    const key = `${raw.status}\0${raw.dstPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const num = numBy.get(raw.dstPath);
    const ws = wsBy ? (wsBy.get(raw.dstPath) ?? 'missing') : undefined;
    const kind = classify(raw, num, ws);
    const submodule = raw.srcMode === '160000' || raw.dstMode === '160000';
    const file: FileChange = {
      path: raw.status === 'D' ? raw.srcPath : raw.dstPath,
      status: raw.status,
      kind,
      added: num?.added,
      deleted: num?.deleted,
    };
    if (raw.srcPath !== raw.dstPath) file.oldPath = raw.srcPath;
    if (raw.score !== undefined && (raw.status === 'R' || raw.status === 'C')) file.score = raw.score;
    if (num?.binary) file.binary = true;
    if (raw.srcMode !== raw.dstMode && raw.status !== 'A' && raw.status !== 'D') {
      file.oldMode = raw.srcMode;
      file.newMode = raw.dstMode;
    }
    if (untracked?.has(raw.dstPath) && raw.status !== 'D') file.untracked = true;
    if (submodule) file.submodule = true;
    files.push(file);
  }
  return files;
}

// ---- diffs between two points ----

/** One end of a comparison: a commit, the index, or the working tree. */
export type DiffSide = { kind: 'commit'; sha: string } | { kind: 'staged' } | { kind: 'working' };

const DIFF_ARGS = ['diff', '-z', '--no-abbrev', '-M', '--no-color', '--no-ext-diff', '--no-textconv'];

/**
 * A copy of the index with untracked files added as intent-to-add, so a diff
 * against the working tree includes new files and pairs them up with deleted
 * ones as renames, the way `git add -A` would, without touching the real index.
 */
export class WorkingIndex {
  private prepared?: Promise<{ env: Record<string, string>; untracked: Set<string> }>;
  private file?: string;
  private static counter = 0;

  constructor(
    private readonly git: string,
    private readonly root: string,
  ) {}

  /** Call when the working tree or index may have changed. */
  invalidate(): void {
    const old = this.file;
    this.prepared = undefined;
    this.file = undefined;
    if (old) setTimeout(() => removeQuietly(old), 5000); // let diffs still using it finish
  }

  dispose(): void {
    const old = this.file;
    this.prepared = undefined;
    this.file = undefined;
    if (old) removeQuietly(old);
  }

  get(): Promise<{ env: Record<string, string>; untracked: Set<string> }> {
    this.prepared ??= this.prepare().catch((err) => {
      this.prepared = undefined;
      throw err;
    });
    return this.prepared;
  }

  private async prepare(): Promise<{ env: Record<string, string>; untracked: Set<string> }> {
    const { git, root } = this;
    const indexPath = path.resolve(root, (await runGitText(git, ['rev-parse', '--git-path', 'index'], root)).trim());
    const file = path.join(os.tmpdir(), `history-slider-index-${process.pid}-${++WorkingIndex.counter}`);
    if (fs.existsSync(indexPath)) await fs.promises.copyFile(indexPath, file);
    this.file = file;
    const env = { GIT_INDEX_FILE: file };
    const listed = await runGitText(git, ['ls-files', '--others', '--exclude-standard', '-z'], root);
    const untracked = listed.split('\0').filter(Boolean);
    if (untracked.length) {
      try {
        await runGit(git, ['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], root, untracked.join('\0'), env);
      } catch {
        // git before 2.26 has no --pathspec-from-file; add them in batches instead.
        for (let i = 0; i < untracked.length; i += 200) {
          await runGit(git, ['add', '--intent-to-add', '--', ...untracked.slice(i, i + 200)], root, undefined, env);
        }
      }
    }
    return { env, untracked: new Set(untracked) };
  }
}

function removeQuietly(file: string): void {
  for (const f of [file, `${file}.lock`]) fs.promises.rm(f, { force: true }).catch(() => undefined);
}

/** What changed in the repository from `old` to `new` (old must not be newer than new). */
export async function repoDiff(git: string, root: string, oldSide: DiffSide, newSide: DiffSide, working: WorkingIndex): Promise<FileChange[]> {
  let sides: string[];
  let env: Record<string, string> | undefined;
  let untracked: Set<string> | undefined;
  if (newSide.kind === 'commit') {
    if (oldSide.kind !== 'commit') throw new GitError('The old side must be a commit when the new side is.');
    if (oldSide.sha === newSide.sha) return [];
    sides = [oldSide.sha, newSide.sha];
  } else if (newSide.kind === 'staged') {
    if (oldSide.kind === 'staged') return [];
    if (oldSide.kind !== 'commit') throw new GitError('The old side must be a commit.');
    sides = ['--cached', oldSide.sha];
  } else {
    if (oldSide.kind === 'working') return [];
    ({ env, untracked } = await working.get());
    sides = oldSide.kind === 'commit' ? [oldSide.sha] : [];
  }
  const [full, ws] = await Promise.all([
    runGitText(git, [...DIFF_ARGS, '--raw', '--numstat', ...sides, '--'], root, undefined, env),
    // Only a refinement (spotting whitespace-only changes), so a failure is not fatal.
    runGitText(git, [...DIFF_ARGS, '--numstat', '--ignore-all-space', ...sides, '--'], root, undefined, env).catch(() => undefined),
  ]);
  const { raws, nums } = parseRawNumstat(full);
  const wsNums = ws === undefined ? undefined : parseRawNumstat(ws).nums;
  return toFileChanges(raws, nums, wsNums, untracked);
}

export interface WorkingStatus {
  /** The index differs from HEAD. */
  staged: boolean;
  /** The working tree differs from the index, or there are untracked files. */
  dirty: boolean;
  /** Changes whenever the set of changed paths does. */
  fingerprint: string;
}

export async function workingStatus(git: string, root: string): Promise<WorkingStatus> {
  const out = await runGitText(git, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root);
  let staged = false;
  let dirty = false;
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 3) continue;
    const x = t[0];
    const y = t[1];
    if (x === 'R' || x === 'C') i++; // the old path follows
    if (x === '?') dirty = true;
    else {
      if (x !== ' ' && x !== '!') staged = true;
      if (y !== ' ' && y !== '!') dirty = true;
    }
  }
  return { staged, dirty, fingerprint: out };
}

/**
 * The commits along the line from `tip` back to `base` that changed a file,
 * following it through renames, with its path after each one. Oldest first.
 */
export async function fileTrack(git: string, root: string, tip: string, base: string | undefined, file: string, limit = 2000): Promise<FileTouch[]> {
  const args = ['log', '--first-parent', '--follow', '-M', '--name-status', '-z', `--format=${RECORD}%H`, `--max-count=${limit}`, tip];
  if (base) args.push(`^${base}`);
  let out: string;
  try {
    out = await runGitText(git, [...args, '--', file], root);
  } catch {
    return [];
  }
  const touches: FileTouch[] = [];
  for (const record of out.split(RECORD)) {
    const tokens = record.split('\0').map((t) => t.replace(/^\n+/, ''));
    const sha = tokens[0]?.trim();
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const status = tokens[1]?.charAt(0);
    if (!status) continue;
    if (status === 'R' || status === 'C') touches.push({ id: sha, status, oldPath: tokens[2], path: tokens[3] ?? '' });
    else touches.push({ id: sha, status, path: tokens[2] ?? '' });
  }
  return touches.reverse();
}

/** The top of the repository containing `dir` (which must exist), with symlinks resolved. */
export async function repoRoot(git: string, dir: string): Promise<string> {
  let top: string;
  try {
    top = (await runGitText(git, ['rev-parse', '--show-toplevel'], dir)).trim();
  } catch (err) {
    throw new GitError(`${dir} is not inside a git repository.`, (err as GitError).stderr);
  }
  try {
    return fs.realpathSync.native(path.resolve(top));
  } catch {
    return path.resolve(top);
  }
}
