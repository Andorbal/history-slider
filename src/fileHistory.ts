/**
 * Loaded history for one file plus access to the file's content at each
 * revision. Free of `vscode` imports; the working copy is supplied by the caller.
 */
import { STAGED_ID, WORKING_ID, type ContentResult, type Stop } from './shared/protocol';
import { CatFileBatch, decodeText, getHistory, getStaged, isBinary, runGit, type StopWithBlob } from './git';

export interface FileHistoryOptions {
  git: string;
  root: string;
  relPath: string;
  pageSize: number;
  follow: boolean;
  firstParent: boolean;
  showStaged: boolean;
  maxBytes: number;
  /**
   * Show history from this ref (e.g. refs/heads/feature) instead of HEAD. Such a
   * history has no staged stop, and the caller leaves out the working copy.
   */
  rev?: string;
}

export class FileHistory {
  /** Commits oldest first. */
  commits: StopWithBlob[] = [];
  staged?: { blob: string };
  hasMore = false;
  headSha?: string;
  private readonly batch: CatFileBatch;

  constructor(readonly options: FileHistoryOptions) {
    this.batch = new CatFileBatch(options.git, options.root);
  }

  /** Loads the newest `count` commits (at least one page) and the staged state. */
  async load(count = this.options.pageSize): Promise<void> {
    const [page, staged, head] = await Promise.all([
      getHistory(this.options.git, this.query(0, Math.max(count, this.options.pageSize))),
      this.showStaged() ? getStaged(this.options.git, this.options.root, this.options.relPath) : undefined,
      this.readHead(),
    ]);
    this.commits = page.stops;
    this.hasMore = page.hasMore;
    this.staged = staged;
    this.headSha = head;
  }

  /** Loads the next page of older commits (or all of them) and returns them oldest first. */
  async loadMore(all = false): Promise<Stop[]> {
    const page = await getHistory(
      this.options.git,
      this.query(this.commits.length, all ? Number.POSITIVE_INFINITY : this.options.pageSize),
    );
    const known = new Set(this.commits.map((c) => c.id));
    const fresh = page.stops.filter((s) => !known.has(s.id));
    this.commits = [...fresh, ...this.commits];
    this.hasMore = page.hasMore;
    return fresh;
  }

  /** Cheap fingerprint used to decide whether a repository change affects this file. */
  async signature(): Promise<string> {
    const [head, staged] = await Promise.all([
      this.readHead(),
      this.showStaged()
        ? getStaged(this.options.git, this.options.root, this.options.relPath).catch(() => undefined)
        : undefined,
    ]);
    return `${head ?? ''}|${staged?.blob ?? ''}`;
  }

  currentSignature(): string {
    return `${this.headSha ?? ''}|${this.staged?.blob ?? ''}`;
  }

  /** All git-backed stops (commits, then the staged stop if any). */
  revisionStops(): Stop[] {
    const stops: Stop[] = this.commits.map(({ blob: _blob, ...stop }) => stop);
    if (this.staged) {
      stops.push({
        id: STAGED_ID,
        kind: 'staged',
        path: this.options.relPath,
        subject: 'Staged changes',
      });
    }
    return stops;
  }

  find(id: string): StopWithBlob | undefined {
    return this.commits.find((c) => c.id === id);
  }

  /** The git object spec for a stop, or undefined for the working copy / deleted revisions. */
  specFor(id: string): string | undefined {
    if (id === WORKING_ID) return undefined;
    if (id === STAGED_ID) return this.staged?.blob ?? `:${this.options.relPath}`;
    const stop = this.find(id);
    if (!stop) return /^[0-9a-f]{7,64}$/.test(id) ? `${id}:${this.options.relPath}` : undefined;
    if (stop.missing) return undefined;
    return stop.blob ?? `${stop.sha}:${stop.path}`;
  }

  /** Content of a git-backed stop, ready to send to the webview. */
  async content(requestId: number, id: string): Promise<ContentResult> {
    const stop = this.find(id);
    if (stop?.missing) return { requestId, stopId: id, text: '', missing: true };
    const spec = this.specFor(id);
    if (!spec) return { requestId, stopId: id, error: 'Unknown revision' };
    let buf: Buffer | undefined;
    try {
      buf = await this.batch.get(spec);
    } catch {
      // The batch process can die (e.g. repository moved); fall back to a one-off call.
      buf = await runGit(this.options.git, ['cat-file', 'blob', spec], this.options.root).catch(() => undefined);
    }
    if (!buf) return { requestId, stopId: id, text: '', missing: true };
    return toContentResult(requestId, id, buf, this.options.maxBytes);
  }

  dispose(): void {
    this.batch.dispose();
  }

  private showStaged(): boolean {
    return this.options.showStaged && !this.options.rev;
  }

  private query(skip: number, limit: number) {
    return {
      rev: this.options.rev,
      root: this.options.root,
      relPath: this.options.relPath,
      skip,
      limit,
      follow: this.options.follow,
      firstParent: this.options.firstParent,
    };
  }

  private async readHead(): Promise<string | undefined> {
    try {
      return (await runGit(this.options.git, ['rev-parse', '-q', '--verify', this.options.rev ?? 'HEAD'], this.options.root))
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  }
}

export function toContentResult(requestId: number, stopId: string, buf: Uint8Array, maxBytes: number): ContentResult {
  if (buf.length > maxBytes) return { requestId, stopId, tooLarge: true };
  if (isBinary(buf)) return { requestId, stopId, binary: true };
  return { requestId, stopId, text: decodeText(buf) };
}
