/**
 * Types shared between the extension host and the webview.
 * Keep this file free of any runtime imports so both bundles can use it.
 */

export const WORKING_ID = '::working';
export const STAGED_ID = '::staged';

export type StopKind = 'commit' | 'staged' | 'working';

/** One selectable point on the slider: a commit, the index, or the working copy. */
export interface Stop {
  id: string;
  kind: StopKind;
  /** Repo-relative path of the file at this stop (forward slashes). */
  path: string;
  /** Previous path when this commit renamed the file. */
  oldPath?: string;
  /** git status letter for the file in this commit (A, M, D, R, C, T...). */
  status?: string;
  sha?: string;
  shortSha?: string;
  parents?: string[];
  subject: string;
  body?: string;
  authorName?: string;
  authorEmail?: string;
  /** Epoch milliseconds. */
  authorDate?: number;
  committerName?: string;
  /** Epoch milliseconds. */
  commitDate?: number;
  /** Ref decorations (branches, tags) pointing at this commit. */
  refs?: string[];
  /** Lines added/deleted in this file by this commit; undefined when unknown or binary. */
  added?: number;
  deleted?: number;
  binary?: boolean;
  /** True when the working copy has unsaved editor changes. */
  dirty?: boolean;
  /** True when the file does not exist at this stop (deleted). */
  missing?: boolean;
  /**
   * True when the commit touched the file without changing anything the diff
   * shows: a pure rename, a mode change, or line endings only.
   */
  noVisibleChange?: boolean;
  /** Branch view: how many files the commit changed (vs. its first parent). */
  fileCount?: number;
  /** Branch view: how many of those files were added, modified, deleted, renamed... by git status letter. */
  statusCounts?: Partial<Record<string, number>>;
  /** Branch view: branches that forked off the line at this commit (it is their merge base). */
  forkOf?: string[];
}

export interface DiffOptions {
  renderSideBySide: boolean;
  ignoreTrimWhitespace: boolean;
  hideUnchangedRegions: boolean;
  wordWrap: boolean;
  /** Leave commits with no visible change (see `Stop.noVisibleChange`) off the timeline. */
  contentChangesOnly: boolean;
}

export interface InitPayload {
  /** The file's URI, stored in webview state so the panel can be restored. */
  resource: string;
  fileName: string;
  relPath: string;
  repoName: string;
  languageId: string;
  /** Oldest first, working copy last. */
  stops: Stop[];
  hasMore: boolean;
  /**
   * The options this host can save. A host from an older build may leave some
   * out; the panel then disables their controls rather than sending them.
   */
  options: DiffOptions;
  pageSize: number;
  /** The host's `BUILD_ID`. Hosts from before 0.2.1 leave it out. */
  build?: string;
  /** Stop ids the two handles start on. */
  selection?: [string, string];
  /** 1-based line to reveal in the new side after the first render. */
  revealLine?: number;
  /** Set when history could not be read; the panel shows it instead of a slider. */
  error?: string;
  /** History starts at this ref rather than HEAD (and has no working copy). */
  rev?: string;
  /** What to call `rev`, e.g. the branch name. */
  revLabel?: string;
}

export interface ContentResult {
  requestId: number;
  stopId: string;
  text?: string;
  binary?: boolean;
  tooLarge?: boolean;
  /** The file does not exist at this revision. */
  missing?: boolean;
  error?: string;
}

export type HostMessage =
  | { type: 'init'; payload: InitPayload }
  | { type: 'more'; stops: Stop[]; hasMore: boolean }
  | { type: 'moreFailed'; error: string }
  | { type: 'content'; result: ContentResult }
  | { type: 'workingCopyChanged'; stop: Stop }
  | { type: 'options'; options: DiffOptions }
  | { type: 'select'; selection: [string, string] }
  | { type: 'loading'; message: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'getContent'; requestId: number; stopId: string }
  | { type: 'loadMore'; all?: boolean }
  | { type: 'refresh' }
  | { type: 'openDiff'; oldId: string; newId: string }
  | { type: 'openRevision'; stopId: string; line?: number }
  | { type: 'copy'; text: string; label?: string }
  | { type: 'setOption'; key: keyof DiffOptions; value: boolean }
  | { type: 'reloadWindow' }
  | { type: 'selectionChanged'; selection: [string, string] };

/** What the webview persists with `setState`, used to restore panels after a reload. */
export interface PanelState {
  resource: string;
  selection?: [string, string];
  rev?: string;
  revLabel?: string;
}
