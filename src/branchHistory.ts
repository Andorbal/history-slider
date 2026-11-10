/**
 * What one branch panel shows: a branch, the levels it can be compared back
 * to, the commits loaded so far, and access to diffs and file contents along
 * the way. Free of `vscode` imports.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  WorkingIndex,
  commitStop,
  fileTrack,
  findBaseLevels,
  listRefs,
  listRemotes,
  logRange,
  readHead,
  repoDiff,
  workingStatus,
  type DiffSide,
  type Head,
  type RefEntry,
  type WorkingStatus,
} from './branchGit';
import { toContentResult } from './fileHistory';
import { CatFileBatch, GitError, runGit, runGitText } from './git';
import type { BaseLevel, BranchInfo, FileChange, FileTouch } from './shared/branchProtocol';
import { STAGED_ID, WORKING_ID, type ContentResult, type Stop } from './shared/protocol';

export interface BranchHistoryOptions {
  git: string;
  root: string;
  pageSize: number;
  maxBytes: number;
}

export class BranchHistory {
  refs: RefEntry[] = [];
  head: Head = {};
  branch!: BranchInfo;
  levels: BaseLevel[] = [];
  /** Index into `levels`, or -1 without a base. */
  level = -1;
  base?: Stop;
  /** Commits after the base, oldest first. */
  commits: Stop[] = [];
  hasMore = false;
  status?: WorkingStatus;
  private readonly batch: CatFileBatch;
  readonly working: WorkingIndex;

  private constructor(readonly options: BranchHistoryOptions) {
    this.batch = new CatFileBatch(options.git, options.root);
    this.working = new WorkingIndex(options.git, options.root);
  }

  /**
   * Loads `branchRef` (the checked-out branch when left out or gone), with the
   * base at the level whose commit is `baseSha` (the nearest level otherwise).
   */
  static async open(options: BranchHistoryOptions, branchRef?: string, baseSha?: string): Promise<BranchHistory> {
    const h = new BranchHistory(options);
    try {
      await h.load(branchRef, baseSha);
    } catch (err) {
      h.dispose();
      throw err;
    }
    return h;
  }

  private async load(branchRef?: string, baseSha?: string): Promise<void> {
    const { git, root } = this.options;
    const [refs, remotes, head] = await Promise.all([listRefs(git, root), listRemotes(git, root), readHead(git, root)]);
    this.refs = refs.filter((r) => !r.symref);
    this.head = head;
    if (!head.sha && !refs.length) throw new GitError('This repository has no commits yet.');
    this.branch = this.resolveBranch(branchRef);
    this.levels = await findBaseLevels(git, root, this.branch, refs, remotes);
    const wanted = baseSha ? this.levels.findIndex((l) => l.sha === baseSha) : -1;
    const level = wanted >= 0 ? wanted : this.levels.length ? 0 : -1;
    await Promise.all([this.setLevel(level), this.refreshStatus()]);
  }

  private resolveBranch(ref?: string): BranchInfo {
    const isHead = (r: RefEntry) => r.ref === this.head.ref;
    const pick = (ref && this.refs.find((r) => r.ref === ref)) || (this.head.ref && this.refs.find(isHead));
    if (pick) return { ref: pick.ref, name: pick.name, sha: pick.sha, remote: pick.remote, head: isHead(pick) };
    if (ref === 'HEAD' || !ref || !this.refs.length) {
      if (!this.head.sha) throw new GitError('This repository has no commits yet.');
      return { ref: 'HEAD', name: 'HEAD', sha: this.head.sha, remote: false, head: true };
    }
    throw new GitError(`Branch ${ref} no longer exists.`);
  }

  /** Puts the base at `level` (-1 for none) and reloads the newest commits after it. */
  async setLevel(level: number): Promise<void> {
    const { git, root } = this.options;
    const target = this.levels[level];
    const limit = Math.max(this.options.pageSize, this.commits.length);
    const [base, page] = await Promise.all([
      target ? commitStop(git, root, target.sha) : undefined,
      logRange(git, root, { tip: this.branch.sha, base: target?.sha, skip: 0, limit }),
    ]);
    this.level = target ? level : -1;
    this.base = base && this.decorate(base);
    this.commits = page.stops.map((s) => this.decorate(s));
    this.hasMore = page.hasMore;
  }

  /** Loads the next page of older commits between the base and the oldest loaded one, oldest first. */
  async loadMore(): Promise<Stop[]> {
    const page = await logRange(this.options.git, this.options.root, {
      tip: this.branch.sha,
      base: this.base?.sha,
      skip: this.commits.length,
      limit: this.options.pageSize,
    });
    const known = new Set(this.commits.map((c) => c.id));
    const fresh = page.stops.filter((s) => !known.has(s.id)).map((s) => this.decorate(s));
    this.commits = [...fresh, ...this.commits];
    this.hasMore = page.hasMore;
    return fresh;
  }

  /** Marks the commits where other levels' branches fork off. */
  private decorate(stop: Stop): Stop {
    const level = this.levels.find((l) => l.sha === stop.sha);
    if (level) stop.forkOf = level.branches;
    return stop;
  }

  /** Re-reads the index and working tree. The staged and working stops only exist on the checked-out branch, and only when they differ. */
  async refreshStatus(): Promise<void> {
    this.working.invalidate();
    this.status = this.branch.head ? await workingStatus(this.options.git, this.options.root) : undefined;
  }

  specials(): Stop[] {
    const out: Stop[] = [];
    if (this.status?.staged) out.push({ id: STAGED_ID, kind: 'staged', path: '', subject: 'Staged changes' });
    if (this.status?.dirty) out.push({ id: WORKING_ID, kind: 'working', path: '', subject: 'Working copy' });
    return out;
  }

  /** Changes whenever what the panel shows would: the branch moved, HEAD moved, or the set of changed files did. */
  async signature(): Promise<string> {
    const { git, root } = this.options;
    const [tip, head, status] = await Promise.all([
      this.branch.ref === 'HEAD'
        ? Promise.resolve(undefined)
        : runGitText(git, ['rev-parse', '-q', '--verify', this.branch.ref], root).then((s) => s.trim(), () => ''),
      readHead(git, root),
      workingStatus(git, root).catch(() => undefined),
    ]);
    return JSON.stringify([tip, head.ref, head.sha, status?.fingerprint]);
  }

  currentSignature(): string {
    return JSON.stringify([this.branch.ref === 'HEAD' ? undefined : this.branch.sha, this.head.ref, this.head.sha, this.status?.fingerprint]);
  }

  sideFor(id: string): DiffSide {
    if (id === STAGED_ID) return { kind: 'staged' };
    if (id === WORKING_ID) return { kind: 'working' };
    return { kind: 'commit', sha: id };
  }

  diff(oldId: string, newId: string): Promise<FileChange[]> {
    return repoDiff(this.options.git, this.options.root, this.sideFor(oldId), this.sideFor(newId), this.working);
  }

  track(file: string): Promise<FileTouch[]> {
    return fileTrack(this.options.git, this.options.root, this.branch.sha, this.base?.sha, file);
  }

  /** The git object spec for a file at a stop; undefined for the working copy. */
  specFor(stopId: string, file: string): string | undefined {
    if (stopId === WORKING_ID) return undefined;
    if (stopId === STAGED_ID) return `:${file}`;
    return `${stopId}:${file}`;
  }

  async content(requestId: number, stopId: string, file: string): Promise<ContentResult> {
    const { maxBytes, root } = this.options;
    if (stopId === WORKING_ID) {
      try {
        const bytes = await fs.promises.readFile(path.join(root, file));
        return toContentResult(requestId, stopId, bytes, maxBytes);
      } catch {
        return { requestId, stopId, text: '', missing: true };
      }
    }
    const spec = this.specFor(stopId, file)!;
    let buf: Buffer | undefined;
    try {
      buf = await this.batch.get(spec);
    } catch {
      buf = await runGit(this.options.git, ['cat-file', 'blob', spec], root).catch(() => undefined);
    }
    if (!buf) return { requestId, stopId, text: '', missing: true };
    return toContentResult(requestId, stopId, buf, maxBytes);
  }

  /** The newest commit at or before `sha` that changed `file`: where a file history would show the file as it is at `sha`. */
  async lastChange(sha: string, file: string): Promise<string | undefined> {
    const out = await runGitText(this.options.git, ['log', '-1', '--format=%H', sha, '--', file], this.options.root).catch(() => '');
    return out.trim() || undefined;
  }

  /** The oldest commit after `sha`, up to `tip`, that changed `file` (for a file that didn't exist at `sha`, the one that added it). */
  async firstChangeAfter(sha: string, tip: string, file: string): Promise<string | undefined> {
    const out = await runGitText(this.options.git, ['rev-list', '--reverse', `${sha}..${tip}`, '--', file], this.options.root).catch(() => '');
    return out.split('\n')[0]?.trim() || undefined;
  }

  /** Every stop the slider shows, oldest first. */
  stops(): Stop[] {
    return [...(this.base ? [this.base] : []), ...this.commits, ...this.specials()];
  }

  dispose(): void {
    this.batch.dispose();
    this.working.dispose();
  }
}
