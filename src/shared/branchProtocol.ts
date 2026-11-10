/**
 * Messages and types for the branch view, shared by the extension host and the webview.
 * Keep this file free of runtime imports other than types.
 */
import type { ContentResult, DiffOptions, Stop } from './protocol';

/** A branch the branch view can show. */
export interface BranchInfo {
  /** Full ref: refs/heads/x, refs/remotes/origin/x, or HEAD when detached. */
  ref: string;
  /** Display name: x, origin/x, or "HEAD". */
  name: string;
  sha: string;
  remote: boolean;
  /** Checked out in this worktree, so it has a working copy. */
  head: boolean;
}

/**
 * One step up the tree: the commit where the line being shown meets another
 * branch. The first level is where the branch was branched; the next is where
 * that branch was branched, and so on.
 */
export interface BaseLevel {
  sha: string;
  shortSha: string;
  /** Branches that contain this commit, best guess at "the parent" first. */
  branches: string[];
  /** First-parent commits between this level and the branch tip. */
  distance: number;
}

/**
 * How a file changed between the two handles. Every file gets exactly one
 * kind, so each can be filtered on its own.
 */
export type ChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'renamedModified'
  | 'copied'
  | 'whitespace'
  | 'mode';

export const CHANGE_KINDS: readonly ChangeKind[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'renamedModified',
  'copied',
  'whitespace',
  'mode',
];

export interface FileChange {
  /** Repo-relative path on the new side (the old path for deletions). */
  path: string;
  /** Path on the old side when it differs (renames and copies). */
  oldPath?: string;
  /** git's status letter: A, M, D, R, C, T, U. */
  status: string;
  /** Similarity percentage for renames and copies. */
  score?: number;
  kind: ChangeKind;
  added?: number;
  deleted?: number;
  binary?: boolean;
  /** File mode on each side, e.g. 100644; differs for chmod changes. */
  oldMode?: string;
  newMode?: string;
  /** Not tracked by git yet (working copy only). */
  untracked?: boolean;
  /** A submodule (gitlink) rather than a file. */
  submodule?: boolean;
}

export interface RepoDiff {
  requestId: number;
  oldId: string;
  newId: string;
  files: FileChange[];
  error?: string;
}

/** Where a selected file was at each commit that changed it, for tracking it through renames. */
export interface FileTouch {
  /** Commit id (a stop id). */
  id: string;
  status: string;
  /** Path after the commit. */
  path: string;
  /** Path before the commit, when it was renamed or copied. */
  oldPath?: string;
}

export interface BranchInitPayload {
  /** The repository root's file URI, stored in webview state so the panel can be restored. */
  resource: string;
  repoName: string;
  branch: BranchInfo;
  /** Every level found, nearest first. Empty when the branch has no base (a default branch, or no other branches). */
  levels: BaseLevel[];
  /** Index into `levels` of the base on the left end, or -1 for plain history without a base. */
  level: number;
  /** The base commit on the left end of the timeline (missing without a base). */
  base?: Stop;
  /** Commits after the base, oldest first. */
  commits: Stop[];
  /** More commits between the base and the oldest loaded commit (or older history without a base). */
  hasMore: boolean;
  /** Staged and working copy stops, when the branch is checked out and they differ. */
  specials: Stop[];
  options: DiffOptions;
  filters: FilterState;
  build?: string;
  /**
   * Stop ids the two handles start on. Without it the panel keeps its handles
   * where they are, if those stops still exist.
   */
  selection?: [string, string];
  /** Forget the current handles and file: a different branch is showing. */
  reset?: boolean;
  /** File to show in the side pane after loading (restoring a panel). */
  selectedPath?: string;
  error?: string;
}

export type ListMode = 'tree' | 'list';
export type SortMode = 'path' | 'size' | 'kind';

/** The file list's filters. Kinds, mode and sort are remembered across panels. */
export interface FilterState {
  hiddenKinds: ChangeKind[];
  query: string;
  matchCase: boolean;
  regex: boolean;
  mode: ListMode;
  sort: SortMode;
}

export const DEFAULT_FILTERS: FilterState = {
  hiddenKinds: [],
  query: '',
  matchCase: false,
  regex: false,
  mode: 'tree',
  sort: 'path',
};

export type BranchHostMessage =
  | { type: 'init'; payload: BranchInitPayload }
  | { type: 'more'; commits: Stop[]; hasMore: boolean }
  | { type: 'moreFailed'; error: string }
  | { type: 'diff'; result: RepoDiff }
  | { type: 'content'; result: ContentResult & { path: string } }
  | { type: 'track'; path: string; touches: FileTouch[] }
  | { type: 'options'; options: DiffOptions }
  /** The index or working tree changed: anything cached for the staged and working stops is stale. */
  | { type: 'workingChanged' }
  | { type: 'loading'; message: string };

export type BranchWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'loadMore' }
  | { type: 'setLevel'; level: number; selection?: [string, string] }
  | { type: 'pickBranch' }
  | { type: 'getDiff'; requestId: number; oldId: string; newId: string }
  | { type: 'getContent'; requestId: number; stopId: string; path: string }
  | { type: 'track'; path: string }
  | { type: 'openDiff'; oldId: string; newId: string; oldPath?: string; newPath?: string }
  | { type: 'openFile'; stopId: string; path: string }
  | { type: 'openFileHistory'; oldId: string; newId: string; oldPath?: string; newPath?: string }
  | { type: 'copy'; text: string; label?: string }
  | { type: 'setOption'; key: keyof DiffOptions; value: boolean }
  | { type: 'saveFilters'; filters: FilterState }
  | { type: 'reloadWindow' };

/** What the branch webview persists, used to restore the panel after a reload. */
export interface BranchPanelState {
  view: 'branch';
  resource: string;
  branch?: string;
  /** Sha of the base level in use, so the same level comes back. */
  baseSha?: string;
  selection?: [string, string];
  selectedPath?: string;
  filters?: FilterState;
}
