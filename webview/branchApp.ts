/** The branch view: a branch's history on the slider, what changed across the repository, and a linked diff of one file. */
import * as monaco from 'monaco-editor/editor/editor.api';
import {
  CHANGE_KINDS,
  DEFAULT_FILTERS,
  type BranchHostMessage,
  type BranchInitPayload,
  type BranchPanelState,
  type BranchWebviewMessage,
  type ChangeKind,
  type FileChange,
  type FileTouch,
  type FilterState,
  type RepoDiff,
  type SortMode,
} from '../src/shared/branchProtocol';
import { BUILD_ID } from '../src/shared/build';
import type { ContentResult, DiffOptions, Stop } from '../src/shared/protocol';
import { Card, type CardRole } from './card';
import { DiffView, type DiffStats } from './diffView';
import { allDirs, basename, buildTree, compileQuery, dirname, filterFiles, listRows, treeRows } from './fileFilter';
import { FileList, KINDS, badgeHtml, renamedFrom, statsHtml } from './fileList';
import { escapeHtml, plural, relativeTime, stopLabel } from './format';
import { resolveLanguage } from './languages';
import { Slider, type InspectMode } from './slider';
import { orderSelection } from './sliderModel';

export interface BranchHostApi {
  postMessage(message: BranchWebviewMessage): void;
  setState(state: BranchPanelState): void;
}

const MAX_DIFFS = 40;
const MAX_CONTENT = 200;

const DEFAULT_OPTIONS: DiffOptions = {
  renderSideBySide: true,
  ignoreTrimWhitespace: false,
  hideUnchangedRegions: false,
  wordWrap: false,
  contentChangesOnly: true,
};

/** What "Content changes only" hides: changes that leave every line as it was. */
const NOISE: readonly ChangeKind[] = ['renamed', 'whitespace', 'mode'];

const SHORTCUTS: [string, string][] = [
  ['← / →', 'Move the focused handle one commit'],
  ['Shift + ← / → or [ / ]', 'Move both handles together'],
  ['Home / End', 'Move the focused handle to the oldest / newest'],
  ['Double-click a commit', 'Show just the change that commit made'],
  ['U / Shift+U', 'Base one level further up the tree / back down'],
  ['B', 'Show another branch'],
  ['R', 'Reset to base ↔ newest commit'],
  ['/', 'Filter the files'],
  ['↑ / ↓ in the list, or , / .', 'Previous / next file'],
  ['{ / }', 'Previous / next commit that changed this file'],
  ['N / Shift+N', 'Next / previous change in the file'],
  ['H or Shift+Enter', 'Open the file in a new History Slider'],
  ['O', 'Open the file in the VS Code diff editor'],
  ['T', 'Tree / flat list'],
  ['S · W · C · Z', 'Side by side · whitespace · collapse unchanged · word wrap'],
];

interface Sides {
  oldPath?: string;
  newPath?: string;
  entry?: FileChange;
}

export class BranchApp {
  private readonly root: HTMLElement;
  private readonly slider: Slider;
  private readonly card: Card;
  private readonly list: FileList;
  private diff?: DiffView;
  private readonly el: Record<
    | 'chain'
    | 'count'
    | 'notice'
    | 'oldSide'
    | 'newSide'
    | 'stats'
    | 'split'
    | 'query'
    | 'chips'
    | 'filesCount'
    | 'filesEmpty'
    | 'noise'
    | 'sort'
    | 'paneHead'
    | 'paneEmpty'
    | 'diffHost'
    | 'overlay'
    | 'status'
    | 'help'
    | 'toast',
    HTMLElement
  >;

  private payload?: BranchInitPayload;
  private base?: Stop;
  private commits: Stop[] = [];
  private specials: Stop[] = [];
  private stops: Stop[] = [];
  private hasMore = false;
  private loadingMore = false;
  private selection: [string, string] = ['', ''];
  private options: DiffOptions = { ...DEFAULT_OPTIONS };
  private hostOptions = new Set(Object.keys(DEFAULT_OPTIONS));
  private filters: FilterState = { ...DEFAULT_FILTERS };
  private collapsed = new Set<string>();

  private requestSeq = 0;
  /** Finished diffs by "old|new". */
  private readonly diffs = new Map<string, RepoDiff>();
  private inflight?: { key: string; requestId: number };
  private wanted?: string;
  /** The diff the list shows (for the current selection once it has arrived). */
  private current?: RepoDiff;
  private shown: FileChange[] = [];

  /** The file in the side pane: identified by its path when it was picked, then followed through renames. */
  private file?: { path: string; track?: FileTouch[] };
  private readonly pendingContent = new Map<number, (r: ContentResult) => void>();
  private readonly content = new Map<string, Promise<ContentResult>>();
  private paneToken = 0;
  private paneKey = '';
  private pendingLevel = false;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private queryTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    container: HTMLElement,
    private readonly host: BranchHostApi,
  ) {
    this.root = container;
    this.root.className = 'app branch-app state-loading';
    this.root.innerHTML = `
      <header class="topbar">
        <div class="file branch-head">
          <span class="hsi hsi-git-branch"></span>
          <nav class="chain" aria-label="Base"></nav>
          <span class="file-count"></span>
        </div>
        <div class="toolbar" role="toolbar">
          <button data-cmd="older" title="Step both handles one commit older ( [ )"><span class="hsi hsi-arrow-left"></span></button>
          <button data-cmd="newer" title="Step both handles one commit newer ( ] )"><span class="hsi hsi-arrow-right"></span></button>
          <button data-cmd="reset" title="Reset: base ↔ newest commit (R)"><span class="hsi hsi-discard"></span></button>
          <span class="sep"></span>
          <button data-toggle="renderSideBySide" title="Side by side (S)"><span class="hsi hsi-split-horizontal"></span></button>
          <button data-toggle="ignoreTrimWhitespace" title="Ignore leading/trailing whitespace in the file diff (W)"><span class="hsi hsi-whitespace"></span></button>
          <button data-toggle="hideUnchangedRegions" title="Collapse unchanged regions (C)"><span class="hsi hsi-fold"></span></button>
          <button data-toggle="wordWrap" title="Word wrap (Z)"><span class="hsi hsi-word-wrap"></span></button>
          <span class="sep"></span>
          <button data-cmd="pickBranch" title="Show another branch (B)"><span class="hsi hsi-git-branch"></span></button>
          <button data-cmd="refresh" title="Reload"><span class="hsi hsi-refresh"></span></button>
          <button data-cmd="help" title="Keyboard shortcuts (?)"><span class="hsi hsi-keyboard"></span></button>
        </div>
      </header>
      <div class="notice" role="alert" hidden></div>
      <div class="timeline-slot"></div>
      <div class="compare">
        <button class="side old" data-cmd="focusOld" title="Focus the old handle"></button>
        <span class="hsi hsi-arrow-right compare-arrow"></span>
        <button class="side new" data-cmd="focusNew" title="Focus the new handle"></button>
        <div class="stats"></div>
      </div>
      <div class="split">
        <section class="files" aria-label="Changed files">
          <div class="search">
            <span class="hsi hsi-filter"></span>
            <input class="query" type="text" spellcheck="false" placeholder="Filter: src/**/*.ts !*.lock" aria-label="Filter files"
              title="Space-separated terms that must all match the path (or the old path of a rename).&#10;Plain text matches anywhere; * ? ** [abc] {a,b} are globs; a,b matches either.&#10;!term or -term leaves matching files out. /src/ anchors at the root.">
            <button data-filter="matchCase" title="Match case"><span class="hsi hsi-case-sensitive"></span></button>
            <button data-filter="regex" title="Use regular expression"><span class="hsi hsi-regex"></span></button>
          </div>
          <div class="chips" role="group" aria-label="Kinds of change"></div>
          <div class="files-bar">
            <label class="check" title="Hide pure renames, whitespace-only and mode-only changes: everything that leaves the lines as they were">
              <input type="checkbox" class="noise"><span class="check-box hsi hsi-check"></span><span class="check-text">Content changes only</span>
            </label>
            <span class="files-count"></span>
            <select class="sort" title="Sort files" aria-label="Sort files">
              <option value="path">Name</option>
              <option value="size">Lines changed</option>
              <option value="kind">Kind</option>
            </select>
            <button data-cmd="toggleMode" title="Tree / flat list (T)"><span class="hsi hsi-list-tree"></span></button>
            <button data-cmd="collapseAll" title="Collapse all folders"><span class="hsi hsi-collapse-all"></span></button>
          </div>
          <div class="list-slot"></div>
          <div class="files-empty" hidden></div>
        </section>
        <div class="splitter" role="separator" aria-orientation="vertical" title="Drag to resize"></div>
        <section class="pane" aria-label="File diff">
          <div class="pane-head" hidden></div>
          <div class="diff-host" hidden><div class="diff"></div><div class="overlay" hidden></div></div>
          <div class="pane-empty"><span class="hsi hsi-diff"></span><p>Select a file to see how it changed. It follows the handles as you drag them.</p></div>
        </section>
      </div>
      <div class="status"></div>
      <div class="help" hidden>
        <div class="help-head"><strong>Keyboard shortcuts</strong><button data-cmd="help" title="Close"><span class="hsi hsi-close"></span></button></div>
        <table>${SHORTCUTS.map(([k, v]) => `<tr><td><kbd>${escapeHtml(k)}</kbd></td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
        <p>The left end is where the branch was branched. Click a branch name in the title (or the button at the left end) to go further up the tree.</p>
      </div>
      <div class="toast" hidden></div>`;
    const q = (sel: string) => this.root.querySelector(sel) as HTMLElement;
    this.el = {
      chain: q('.chain'),
      count: q('.file-count'),
      notice: q('.notice'),
      oldSide: q('.side.old'),
      newSide: q('.side.new'),
      stats: q('.stats'),
      split: q('.split'),
      query: q('.query'),
      chips: q('.chips'),
      filesCount: q('.files-count'),
      filesEmpty: q('.files-empty'),
      noise: q('input.noise'),
      sort: q('select.sort'),
      paneHead: q('.pane-head'),
      paneEmpty: q('.pane-empty'),
      diffHost: q('.diff'),
      overlay: q('.overlay'),
      status: q('.status'),
      help: q('.help'),
      toast: q('.toast'),
    };

    this.slider = new Slider({
      select: (sel) => this.onSliderSelect(sel),
      loadMore: (_all, source) => this.onLoadMore(source),
      inspect: (stop, x, mode) => this.inspect(stop, x, mode),
      activate: (stop) => this.showChange(stop),
      dragChange: (dragging) => this.root.classList.toggle('dragging', dragging),
    });
    q('.timeline-slot').replaceWith(this.slider.el);

    this.card = new Card(
      {
        showChange: (stop) => this.showChange(stop),
        openRevision: () => undefined,
        copy: (text, label) => this.post({ type: 'copy', text, label }),
      },
      { mode: 'repo', extra: (stop) => this.cardExtra(stop) },
    );
    document.body.appendChild(this.card.el);

    this.list = new FileList({
      select: (file) => this.selectFile(file),
      openHistory: (file) => this.openHistory(file),
      openDiff: (file) => this.openDiff(file),
      toggleDir: (p) => this.toggleDir(p),
    });
    q('.list-slot').replaceWith(this.list.el);

    this.root.addEventListener('click', (e) => this.onClick(e));
    this.el.query.addEventListener('input', () => this.onQueryInput());
    this.el.query.addEventListener('keydown', (e) => this.onQueryKey(e));
    this.el.noise.addEventListener('change', () => this.setNoiseHidden((this.el.noise as HTMLInputElement).checked));
    this.el.sort.addEventListener('change', () => this.updateFilters({ sort: (this.el.sort as HTMLSelectElement).value as SortMode }));
    this.setupSplitter(q('.splitter'));
    document.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('message', (e: MessageEvent<BranchHostMessage>) => this.onMessage(e.data));
    window.addEventListener('blur', () => this.card.hide());
    this.renderToggles();
    this.exposeForTests();
    this.post({ type: 'ready' });
  }

  private exposeForTests(): void {
    (window as unknown as { __historySlider: unknown }).__historySlider = {
      selection: () => this.selection,
      ordered: () => {
        const { oldStop, newStop } = this.ordered();
        return [oldStop?.id, newStop?.id];
      },
      shownFiles: () => this.shown.map((f) => f.path),
      selectedPath: () => this.file?.path,
      sides: () => this.resolveSides(),
      original: () => this.diff?.editor.getModel()?.original.getValue(),
      modified: () => this.diff?.editor.getModel()?.modified.getValue(),
      stopCount: () => this.stops.length,
      stopIds: () => this.stops.map((s) => s.id),
    };
  }

  // ---- messages ----

  private post(message: BranchWebviewMessage): void {
    this.host.postMessage(message);
  }

  private onMessage(msg: BranchHostMessage): void {
    switch (msg.type) {
      case 'loading':
        if (!this.payload || this.pendingLevel) this.setStatus(this.payload && !this.payload.error ? 'ready' : 'loading', msg.message);
        if (this.pendingLevel) this.slider.setLoading(true);
        break;
      case 'init':
        this.init(msg.payload);
        break;
      case 'more':
        this.onMore(msg.commits, msg.hasMore);
        break;
      case 'moreFailed':
        this.loadingMore = false;
        this.slider.setLoading(false);
        this.toast(`Could not load more history: ${msg.error}`);
        break;
      case 'diff':
        this.onDiff(msg.result);
        break;
      case 'content': {
        const resolve = this.pendingContent.get(msg.result.requestId);
        this.pendingContent.delete(msg.result.requestId);
        if (msg.result.error) this.content.delete(`${msg.result.stopId}\0${msg.result.path}`);
        resolve?.(msg.result);
        break;
      }
      case 'track':
        if (this.file?.path === msg.path) {
          this.file.track = msg.touches;
          this.renderMarks();
          this.updatePane();
        }
        break;
      case 'workingChanged':
        this.forgetSpecials();
        this.updateDiff();
        this.updatePane();
        break;
      case 'options':
        this.applyOptions(msg.options);
        break;
    }
  }

  private init(p: BranchInitPayload): void {
    const first = !this.payload;
    const sameBranch = !first && !p.reset && this.payload!.resource === p.resource && this.payload!.branch.ref === p.branch.ref;
    const sameBase = sameBranch && this.base?.id === p.base?.id;
    this.payload = p;
    this.pendingLevel = false;
    this.options = { ...DEFAULT_OPTIONS, ...p.options };
    this.hostOptions = new Set(Object.keys(p.options));
    if (first) {
      this.filters = { ...DEFAULT_FILTERS, ...p.filters };
      (this.el.query as HTMLInputElement).value = this.filters.query;
    }
    this.renderToggles();
    this.renderFilterControls();
    this.renderNotice(p.build);
    if (p.error) {
      this.renderChain();
      this.setStatus('error', p.error);
      return;
    }
    this.base = p.base;
    this.commits = p.commits;
    this.specials = p.specials;
    this.hasMore = p.hasMore;
    this.loadingMore = false;
    this.rebuildStops();
    this.forgetSpecials();
    if (!sameBranch) {
      this.diffs.clear();
      this.current = undefined;
      this.file = p.selectedPath ? { path: p.selectedPath } : undefined;
      this.paneKey = '';
      this.diff?.clear();
      this.collapsed.clear();
    }
    const keep = sameBranch && !p.selection ? this.selection : p.selection;
    this.selection = this.validSelection(keep);
    this.setStatus(this.stops.length ? 'ready' : 'empty', 'This branch has no commits to show.');
    this.slider.setLoading(false);
    this.updateSlider();
    this.slider.setSelection(this.selection);
    this.renderHeader();
    // The file's track is bounded by the base, so it changes with it.
    if (this.file && (!sameBase || !this.file.track)) this.requestTrack(this.file.path);
    this.renderMarks();
    this.onSelectionChanged();
  }

  private rebuildStops(): void {
    this.stops = [...(this.base ? [this.base] : []), ...this.commits, ...this.specials];
  }

  private canExtend(): boolean {
    const p = this.payload;
    return !!p && !this.hasMore && p.level >= 0 && p.level + 1 < p.levels.length;
  }

  private updateSlider(): void {
    const p = this.payload!;
    const next = p.levels[p.level + 1];
    this.slider.setMoreButton(
      this.hasMore
        ? { html: 'Older', title: 'Load older commits on this line' }
        : next
          ? {
              html: escapeHtml(next.branches[0] ?? next.shortSha),
              title: `Go up the tree: start from where ${p.levels[p.level]?.branches[0] ?? 'this'} was branched from ${next.branches.join(', ')} (U)`,
            }
          : undefined,
    );
    this.slider.setData(this.stops, this.hasMore || this.canExtend());
  }

  private onMore(commits: Stop[], hasMore: boolean): void {
    this.loadingMore = false;
    const known = new Set(this.commits.map((s) => s.id));
    this.commits = [...commits.filter((s) => !known.has(s.id)), ...this.commits];
    this.hasMore = hasMore;
    this.rebuildStops();
    this.slider.setLoading(false);
    this.updateSlider();
    this.renderHeader();
    this.renderMarks();
    this.renderCompare();
  }

  private onLoadMore(source: 'button' | 'auto'): void {
    if (this.hasMore) {
      if (this.loadingMore) return;
      this.loadingMore = true;
      this.slider.setLoading(true);
      this.post({ type: 'loadMore' });
    } else if (source === 'button') {
      // Going up the tree changes what's compared, so it takes a click rather than a drag.
      this.goUp(1);
    }
  }

  /** Moves the base `delta` levels up the tree (or down, when negative), keeping the new handle where it is. */
  private goUp(delta: number): void {
    const p = this.payload;
    if (!p || p.error) return;
    const level = p.level + delta;
    if (level < 0 || level >= p.levels.length || level === p.level) return;
    this.setLevel(level);
  }

  private setLevel(level: number): void {
    const p = this.payload!;
    const target = p.levels[level];
    if (!target) return;
    const { oldHandle } = orderSelection(this.stops, this.selection);
    const sel: [string, string] = [...this.selection];
    sel[oldHandle] = target.sha;
    this.pendingLevel = true;
    this.post({ type: 'setLevel', level, selection: sel });
  }

  // ---- selection ----

  private validSelection(sel: [string, string] | undefined): [string, string] {
    const has = (id: string) => this.stops.some((s) => s.id === id);
    return sel && has(sel[0]) && has(sel[1]) ? [sel[0], sel[1]] : this.defaultSelection();
  }

  /** The whole branch: from the base to the newest commit. Without a base, the newest commit's own change. */
  private defaultSelection(): [string, string] {
    const tip = this.commits[this.commits.length - 1] ?? this.base;
    if (this.base && tip) return [this.base.id, tip.id];
    const special = this.specials[this.specials.length - 1];
    if (tip && special) return [tip.id, special.id];
    const before = this.commits[this.commits.length - 2] ?? tip;
    return [before?.id ?? special?.id ?? '', tip?.id ?? special?.id ?? ''];
  }

  private onSliderSelect(sel: [string, string]): void {
    this.selection = sel;
    this.onSelectionChanged();
  }

  private setSelection(sel: [string, string]): void {
    this.selection = this.validSelection(sel);
    this.slider.setSelection(this.selection);
    this.onSelectionChanged();
  }

  private onSelectionChanged(): void {
    this.renderCompare();
    this.updateDiff();
    this.updatePane();
    this.saveState();
  }

  private ordered(): { oldStop?: Stop; newStop?: Stop; oldIndex: number; newIndex: number; oldHandle: 0 | 1 } {
    const o = orderSelection(this.stops, this.selection);
    return { oldStop: this.stops[o.oldIndex], newStop: this.stops[o.newIndex], ...o };
  }

  private showChange(stop: Stop): void {
    const i = this.stops.findIndex((s) => s.id === stop.id);
    if (i < 0) return;
    const prev = this.stops[Math.max(0, i - 1)];
    const { oldHandle } = orderSelection(this.stops, this.selection);
    this.setSelection(oldHandle === 0 ? [prev.id, stop.id] : [stop.id, prev.id]);
  }

  // ---- repository diff ----

  private selectionKey(): string | undefined {
    const { oldStop, newStop } = this.ordered();
    return oldStop && newStop ? `${oldStop.id}|${newStop.id}` : undefined;
  }

  private updateDiff(): void {
    const key = this.selectionKey();
    if (!key) return;
    const done = this.diffs.get(key);
    if (done) {
      this.diffs.delete(key);
      this.diffs.set(key, done);
      this.showDiff(done);
      return;
    }
    this.wanted = key;
    this.renderStats();
    this.renderFiles();
    this.pump();
  }

  /** Keeps one diff in flight: while dragging, only the latest selection is asked for next. */
  private pump(): void {
    if (this.inflight || !this.wanted) return;
    const key = this.wanted;
    this.wanted = undefined;
    if (this.diffs.has(key)) {
      if (key === this.selectionKey()) this.showDiff(this.diffs.get(key)!);
      return;
    }
    const [oldId, newId] = key.split('|');
    const requestId = ++this.requestSeq;
    this.inflight = { key, requestId };
    this.post({ type: 'getDiff', requestId, oldId, newId });
  }

  private onDiff(result: RepoDiff): void {
    const key = `${result.oldId}|${result.newId}`;
    if (this.inflight?.requestId === result.requestId) this.inflight = undefined;
    if (!result.error) {
      this.diffs.set(key, result);
      while (this.diffs.size > MAX_DIFFS) this.diffs.delete(this.diffs.keys().next().value!);
    }
    if (key === this.selectionKey()) this.showDiff(result);
    this.pump();
  }

  private showDiff(result: RepoDiff): void {
    this.current = result;
    this.renderStats();
    this.renderFiles();
    this.updatePane();
    if (result.error) this.toast(`Could not compare: ${result.error}`);
  }

  private isCurrent(): boolean {
    return !!this.current && `${this.current.oldId}|${this.current.newId}` === this.selectionKey();
  }

  private forgetSpecials(): void {
    for (const key of [...this.diffs.keys()]) if (key.includes('::')) this.diffs.delete(key);
    for (const key of [...this.content.keys()]) if (key.startsWith('::')) this.content.delete(key);
    if (this.current && `${this.current.oldId}|${this.current.newId}`.includes('::')) this.current = undefined;
  }

  // ---- file list ----

  private renderFiles(): void {
    const files = this.current?.files ?? [];
    const query = compileQuery(this.filters.query, this.filters);
    this.el.query.classList.toggle('invalid', !!query.error);
    this.el.query.title = query.error ? `Invalid regular expression: ${query.error}` : this.el.query.getAttribute('title') ?? '';
    const hidden = new Set(this.filters.hiddenKinds);
    const result = filterFiles(files, query, hidden);
    this.shown = result.shown;
    this.renderChips(result.counts, hidden);
    const rows = this.filters.mode === 'tree' ? treeRows(buildTree(result.shown), this.collapsed, this.filters.sort) : listRows(result.shown, this.filters.sort);
    this.list.setRows(rows, this.filters.mode);
    this.list.setSelected(this.selectedRowKey());
    const filtered = files.length - result.shown.length;
    this.el.filesCount.innerHTML = !this.current
      ? ''
      : filtered
        ? `${result.shown.length.toLocaleString()} of ${plural(files.length, 'file')} <button class="link" data-cmd="clearFilters" title="Show every changed file">Show all</button>`
        : plural(files.length, 'file');
    this.root.classList.toggle('files-pending', !this.isCurrent());
    let empty = '';
    if (!this.current) empty = '<span class="hsi hsi-loading hsi-modifier-spin"></span> Comparing…';
    else if (this.current.error) empty = escapeHtml(`Could not compare: ${this.current.error}`);
    else if (!files.length) empty = this.ordered().oldIndex === this.ordered().newIndex ? 'Both handles are on the same revision.' : 'No files changed between these revisions.';
    else if (!result.shown.length) empty = `All ${plural(files.length, 'changed file')} are hidden by the filters. <button class="link" data-cmd="clearFilters">Show all</button>`;
    this.el.filesEmpty.innerHTML = empty;
    this.el.filesEmpty.hidden = !empty;
    this.list.el.hidden = !!empty;
  }

  /** The list row of the file in the pane, under its path between these handles. */
  private selectedRowKey(): string | undefined {
    if (!this.file) return undefined;
    return this.resolveSides().entry?.path ?? this.file.path;
  }

  private renderChips(counts: Record<ChangeKind, number>, hidden: Set<ChangeKind>): void {
    this.el.chips.innerHTML = CHANGE_KINDS.filter((k) => counts[k] || hidden.has(k))
      .map((k) => {
        const info = KINDS[k];
        const off = hidden.has(k);
        return `<button class="chip k-${k}${off ? ' off' : ''}" data-kind="${k}" aria-pressed="${!off}" title="${escapeHtml(`${info.title}. Click to ${off ? 'show' : 'hide'} them; Alt+click to show only these.`)}"><span class="chip-letter">${info.letter}</span>${escapeHtml(info.label)}<span class="chip-count">${counts[k].toLocaleString()}</span></button>`;
      })
      .join('');
    (this.el.noise as HTMLInputElement).checked = NOISE.every((k) => hidden.has(k));
  }

  private renderFilterControls(): void {
    this.root.querySelectorAll<HTMLButtonElement>('button[data-filter]').forEach((b) => {
      const on = !!this.filters[b.dataset.filter as 'matchCase' | 'regex'];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    (this.el.sort as HTMLSelectElement).value = this.filters.sort;
    const mode = this.root.querySelector('[data-cmd="toggleMode"] .hsi')!;
    mode.className = `hsi ${this.filters.mode === 'tree' ? 'hsi-list-tree' : 'hsi-list-flat'}`;
    this.root.querySelector<HTMLButtonElement>('[data-cmd="collapseAll"]')!.disabled = this.filters.mode !== 'tree';
  }

  private updateFilters(patch: Partial<FilterState>): void {
    this.filters = { ...this.filters, ...patch };
    this.renderFilterControls();
    this.renderFiles();
    this.saveState();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.post({ type: 'saveFilters', filters: this.filters }), 300);
  }

  private toggleKind(kind: ChangeKind, solo: boolean): void {
    const hidden = new Set(this.filters.hiddenKinds);
    if (solo) {
      const only = CHANGE_KINDS.filter((k) => k !== kind);
      const already = only.every((k) => hidden.has(k)) && !hidden.has(kind);
      this.updateFilters({ hiddenKinds: already ? [] : only });
      return;
    }
    if (hidden.has(kind)) hidden.delete(kind);
    else hidden.add(kind);
    this.updateFilters({ hiddenKinds: CHANGE_KINDS.filter((k) => hidden.has(k)) });
  }

  private setNoiseHidden(hide: boolean): void {
    const hidden = new Set(this.filters.hiddenKinds);
    NOISE.forEach((k) => (hide ? hidden.add(k) : hidden.delete(k)));
    this.updateFilters({ hiddenKinds: CHANGE_KINDS.filter((k) => hidden.has(k)) });
  }

  private onQueryInput(): void {
    clearTimeout(this.queryTimer);
    this.queryTimer = setTimeout(() => this.updateFilters({ query: (this.el.query as HTMLInputElement).value }), 120);
  }

  private onQueryKey(e: KeyboardEvent): void {
    const input = this.el.query as HTMLInputElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (input.value) {
        input.value = '';
        this.updateFilters({ query: '' });
      } else {
        this.list.focus();
      }
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      this.list.focus();
      if (!this.file && this.shown.length) this.list.step(1);
    }
  }

  private toggleDir(p: string): void {
    if (this.collapsed.has(p)) this.collapsed.delete(p);
    else this.collapsed.add(p);
    this.renderFiles();
  }

  // ---- the file pane ----

  private selectFile(file: FileChange): void {
    if (this.file?.path === file.path) {
      this.updatePane();
      return;
    }
    this.file = { path: file.path };
    this.list.setSelected(file.path);
    this.requestTrack(file.path);
    this.renderMarks();
    this.updatePane();
    this.saveState();
  }

  private requestTrack(p: string): void {
    this.post({ type: 'track', path: p });
  }

  private renderMarks(): void {
    const track = this.file?.track;
    this.slider.setMarks(track ? new Set(track.map((t) => t.id)) : undefined);
  }

  /** Where the file is at a stop, from its track: undefined when it doesn't exist there. */
  private pathAt(index: number): string | undefined {
    const f = this.file!;
    const touches = (f.track ?? [])
      .map((t) => ({ t, i: this.stops.findIndex((s) => s.id === t.id) }))
      .filter((x) => x.i >= 0);
    if (!touches.length) return f.path;
    // The staged and working stops come after every commit on the line.
    let last: FileTouch | undefined;
    for (const x of touches) if (x.i <= index) last = x.t;
    if (last) return last.status === 'D' ? undefined : last.path;
    const firstTouch = touches[0].t;
    return firstTouch.status === 'A' ? undefined : (firstTouch.oldPath ?? firstTouch.path);
  }

  /** The file's path on each side, from the diff between the handles when it has arrived, else from its track. */
  private resolveSides(): Sides {
    if (!this.file) return {};
    const { oldIndex, newIndex } = this.ordered();
    const oldPath = this.pathAt(oldIndex);
    const newPath = this.pathAt(newIndex);
    if (this.isCurrent()) {
      const files = this.current!.files;
      const entry =
        files.find((f) => f.status !== 'D' && newPath !== undefined && f.path === newPath) ??
        files.find((f) => oldPath !== undefined && (f.oldPath ?? f.path) === oldPath) ??
        files.find((f) => f.path === this.file!.path);
      if (entry) {
        return {
          entry,
          oldPath: entry.status === 'A' ? undefined : (entry.oldPath ?? entry.path),
          newPath: entry.status === 'D' ? undefined : entry.path,
        };
      }
    }
    return { oldPath, newPath };
  }

  private getContent(stopId: string, p: string | undefined): Promise<ContentResult> {
    if (p === undefined) return Promise.resolve({ requestId: 0, stopId, text: '', missing: true });
    const key = `${stopId}\0${p}`;
    const cached = this.content.get(key);
    if (cached) {
      this.content.delete(key);
      this.content.set(key, cached);
      return cached;
    }
    const requestId = ++this.requestSeq;
    const promise = new Promise<ContentResult>((resolve) => this.pendingContent.set(requestId, resolve));
    this.content.set(key, promise);
    this.post({ type: 'getContent', requestId, stopId, path: p });
    while (this.content.size > MAX_CONTENT) this.content.delete(this.content.keys().next().value!);
    return promise;
  }

  private ensureDiff(): DiffView {
    this.diff ??= new DiffView(this.el.diffHost, this.el.overlay, this.options, (s) => this.renderPaneStats(s));
    return this.diff;
  }

  private updatePane(): void {
    const file = this.file;
    const has = !!file;
    this.el.paneEmpty.hidden = has;
    this.el.paneHead.hidden = !has;
    this.el.diffHost.parentElement!.hidden = !has;
    this.root.classList.toggle('has-file', has);
    if (!file) return;
    const { oldStop, newStop } = this.ordered();
    if (!oldStop || !newStop) return;
    const sides = this.resolveSides();
    this.renderPaneHead(sides);
    this.list.setSelected(this.selectedRowKey());
    const diff = this.ensureDiff();
    if (this.paneKey !== file.path) {
      this.paneKey = file.path;
      diff.clear();
      const name = basename(sides.newPath ?? sides.oldPath ?? file.path);
      diff.setFile(name, resolveLanguage(monaco, '', name));
    }
    const token = ++this.paneToken;
    void Promise.all([this.getContent(oldStop.id, sides.oldPath), this.getContent(newStop.id, sides.newPath)]).then(([o, n]) => {
      if (token !== this.paneToken) return;
      if (o.missing && n.missing) {
        this.el.overlay.textContent = `${basename(file.path)} doesn't exist at either of these revisions.`;
        this.el.overlay.hidden = false;
        return;
      }
      diff.show({ id: `${oldStop.id}\0${sides.oldPath ?? ''}`, result: o }, { id: `${newStop.id}\0${sides.newPath ?? ''}`, result: n }, 'first');
    });
  }

  private renderPaneHead(sides: Sides): void {
    const file = this.file!;
    const e = sides.entry;
    const shownPath = sides.newPath ?? sides.oldPath ?? file.path;
    const dir = dirname(shownPath);
    let status: string;
    if (e) status = `${badgeHtml(e)}${e.oldPath ? `<span class="fl-from">← ${escapeHtml(renamedFrom(e)!)}</span>` : ''}<span class="fl-stats">${statsHtml(e.added, e.deleted, e.binary)}</span>`;
    else if (!this.isCurrent()) status = '<span class="muted">comparing…</span>';
    else if (!sides.oldPath && !sides.newPath) status = '<span class="muted">not here at these revisions</span>';
    else status = '<span class="muted">unchanged between the handles</span>';
    const touches = this.touchIndexes();
    const { newIndex } = this.ordered();
    const inRange = touches.filter((i) => i > this.ordered().oldIndex && i <= newIndex).length;
    const track = this.file?.track
      ? `<span class="muted" title="Commits on the timeline that changed this file (highlighted on the timeline)">changed in ${plural(touches.length, 'commit')}${inRange && inRange !== touches.length ? `, ${inRange} between the handles` : ''}</span>`
      : '';
    this.el.paneHead.innerHTML = `
      <div class="pane-title" title="${escapeHtml(shownPath)}">
        <span class="pane-name">${escapeHtml(basename(shownPath))}</span>
        <span class="pane-dir">${escapeHtml(dir)}</span>
        ${status}
      </div>
      <div class="pane-tools">
        ${track}
        <button data-cmd="prevTouch" title="Previous commit that changed this file ( { )" ${this.touchTarget(-1) === undefined ? 'disabled' : ''}><span class="hsi hsi-chevron-left"></span></button>
        <button data-cmd="nextTouch" title="Next commit that changed this file ( } )" ${this.touchTarget(1) === undefined ? 'disabled' : ''}><span class="hsi hsi-chevron-right"></span></button>
        <span class="sep"></span>
        <button data-cmd="prevChange" title="Previous change (Shift+N)"><span class="hsi hsi-arrow-up"></span></button>
        <button data-cmd="nextChange" title="Next change (N)"><span class="hsi hsi-arrow-down"></span></button>
        <span class="pane-stats"></span>
        <span class="sep"></span>
        <button data-cmd="openHistory" title="Open in a new History Slider, independent of this one (H)"><span class="hsi hsi-history"></span></button>
        <button data-cmd="openDiff" title="Open in the VS Code diff editor (O)"><span class="hsi hsi-go-to-file"></span></button>
        <button data-cmd="openFile" title="Open the file as it is on the new side"><span class="hsi hsi-file"></span></button>
        <button data-cmd="closeFile" title="Close"><span class="hsi hsi-close"></span></button>
      </div>`;
  }

  private renderPaneStats(stats: DiffStats | undefined): void {
    const el = this.el.paneHead.querySelector('.pane-stats');
    if (!el) return;
    el.innerHTML = stats ? (stats.changes ? `<span class="muted">${plural(stats.changes, 'change')}</span>` : '<span class="muted">no changes</span>') : '';
  }

  /** Timeline indexes of the commits that changed the file. */
  private touchIndexes(): number[] {
    const ids = new Set((this.file?.track ?? []).map((t) => t.id));
    const out: number[] = [];
    this.stops.forEach((s, i) => ids.has(s.id) && out.push(i));
    return out;
  }

  /**
   * The commit to jump to for the previous/next change of this file. From a
   * single commit's change it steps to the neighbouring one; from a wider range
   * it goes to the newest (previous) or oldest (next) change inside it.
   */
  private touchTarget(dir: 1 | -1): number | undefined {
    const touches = this.touchIndexes();
    const { oldIndex, newIndex } = this.ordered();
    const single = newIndex - oldIndex === 1;
    if (dir < 0) return [...touches].reverse().find((i) => (single ? i < newIndex : i <= newIndex));
    return touches.find((i) => (single ? i > newIndex : i > oldIndex));
  }

  private stepTouch(dir: 1 | -1): void {
    const i = this.touchTarget(dir);
    if (i !== undefined) this.showChange(this.stops[i]);
  }

  private cardExtra(stop: Stop): string {
    if (!this.file?.track?.some((t) => t.id === stop.id)) return '';
    return `<div class="card-meta card-touch"><span class="hsi hsi-file"></span><span>Changes <code>${escapeHtml(basename(this.file.path))}</code></span></div>`;
  }

  private sidesMessage(file?: FileChange): { oldId: string; newId: string; oldPath?: string; newPath?: string } | undefined {
    const { oldStop, newStop } = this.ordered();
    if (!oldStop || !newStop) return undefined;
    let sides: Sides;
    if (file) sides = { oldPath: file.status === 'A' ? undefined : (file.oldPath ?? file.path), newPath: file.status === 'D' ? undefined : file.path };
    else if (this.file) sides = this.resolveSides();
    else return undefined;
    return { oldId: oldStop.id, newId: newStop.id, oldPath: sides.oldPath, newPath: sides.newPath };
  }

  private openHistory(file?: FileChange): void {
    const m = this.sidesMessage(file);
    if (m && (m.oldPath || m.newPath)) this.post({ type: 'openFileHistory', ...m });
  }

  private openDiff(file?: FileChange): void {
    const m = this.sidesMessage(file);
    if (m && (m.oldPath || m.newPath)) this.post({ type: 'openDiff', ...m });
  }

  // ---- rendering ----

  private renderHeader(): void {
    this.renderChain();
    const p = this.payload!;
    const n = this.commits.length;
    const base = p.levels[p.level];
    this.el.count.textContent = `${plural(n, 'commit')}${this.hasMore ? ' loaded' : ''}${base ? ` since ${base.branches[0] ?? base.shortSha}` : ''}`;
    this.el.count.title = base ? `First-parent commits after ${base.shortSha}, where this line meets ${base.branches.join(', ')}` : 'No base found, so this is the branch’s history';
  }

  /** "main › feature-a › feature-b ▾": the levels up the tree, the base in use highlighted, then the branch. */
  private renderChain(): void {
    const p = this.payload;
    if (!p) return;
    const parts: string[] = [];
    for (let i = p.levels.length - 1; i >= 0; i--) {
      const l = p.levels[i];
      const name = l.branches[0] ?? l.shortSha;
      const cls = i === p.level ? 'level active' : i > p.level ? 'level above' : 'level inside';
      const title = `${l.branches.join(', ')}\nFork point ${l.shortSha}, ${plural(l.distance, 'commit')} back\n${i === p.level ? 'The base on the left end' : 'Click to compare from here'}`;
      parts.push(`<button class="${cls}" data-level="${i}" title="${escapeHtml(title)}" ${i === p.level ? 'aria-current="true"' : ''}>${escapeHtml(name)}</button><span class="chain-sep hsi hsi-chevron-right"></span>`);
    }
    const b = p.branch;
    const note = !p.levels.length && !p.error ? '<span class="muted chain-note" title="This is the default branch, or no other branch shares its history">no base · history</span>' : '';
    parts.push(
      `<button class="branch-pick" data-cmd="pickBranch" title="${escapeHtml(`${b.ref}${b.head ? ' (checked out)' : ''}\nShow another branch (B)`)}"><span class="branch-name">${escapeHtml(b.name || 'Branch')}</span><span class="hsi hsi-chevron-down"></span></button>${note}`,
    );
    this.el.chain.innerHTML = parts.join('');
  }

  private renderNotice(hostBuild: string | undefined): void {
    this.el.notice.hidden = hostBuild === BUILD_ID;
    if (this.el.notice.hidden) return;
    this.el.notice.innerHTML = `<span class="hsi hsi-warning"></span><span class="notice-text">History Slider was updated while this window was open. Reload the window so that everything works.</span><button data-cmd="reloadWindow">Reload Window</button>`;
  }

  private sideHtml(stop: Stop | undefined, role: 'old' | 'new'): string {
    const pill = `<span class="pill ${role}">${role.toUpperCase()}</span>`;
    if (!stop) return pill;
    if (stop.kind === 'working') return `${pill}<span class="side-main">Working copy</span><span class="muted">· on disk</span>`;
    if (stop.kind === 'staged') return `${pill}<span class="side-main">Staged</span><span class="muted">· index</span>`;
    const when = stop.authorDate ? relativeTime(stop.authorDate) : '';
    const fork = stop.forkOf?.length ? `<span class="fork-tag" title="${escapeHtml(stop.forkOf.join(', '))}"><span class="hsi hsi-git-branch"></span>${escapeHtml(stop.forkOf[0])}</span>` : '';
    return `${pill}<code>${escapeHtml(stopLabel(stop))}</code>${fork}<span class="side-main">${escapeHtml(stop.subject)}</span><span class="muted">· ${escapeHtml(stop.authorName ?? '')}${when ? ` · ${escapeHtml(when)}` : ''}</span>`;
  }

  private renderCompare(): void {
    const { oldStop, newStop } = this.ordered();
    this.el.oldSide.innerHTML = this.sideHtml(oldStop, 'old');
    this.el.newSide.innerHTML = this.sideHtml(newStop, 'new');
    const title = (s?: Stop) => (s?.kind === 'commit' ? `${s.sha}\n${s.subject}\n${s.authorName} <${s.authorEmail}>\n\nClick to focus this handle` : s ? `${stopLabel(s)} — click to focus this handle` : '');
    this.el.oldSide.title = title(oldStop);
    this.el.newSide.title = title(newStop);
  }

  private renderStats(): void {
    const { oldIndex, newIndex } = this.ordered();
    const between = this.stops.slice(oldIndex + 1, newIndex + 1).filter((s) => s.kind === 'commit').length;
    const span = between > 1 ? `<span class="muted" title="Commits between the two handles">${plural(between, 'commit')}</span>` : '';
    let text = '';
    if (!this.isCurrent()) text = '<span class="muted">comparing…</span>';
    else if (this.current!.error) text = '<span class="muted">could not compare</span>';
    else if (oldIndex === newIndex) text = '<span class="muted">same revision</span>';
    else {
      const files = this.current!.files;
      const added = files.reduce((s, f) => s + (f.added ?? 0), 0);
      const deleted = files.reduce((s, f) => s + (f.deleted ?? 0), 0);
      text = `<span class="muted">${plural(files.length, 'file')}</span><span class="added">+${added.toLocaleString()}</span><span class="deleted">−${deleted.toLocaleString()}</span>`;
    }
    this.el.stats.innerHTML = [text, span].filter(Boolean).join('<span class="muted">·</span>');
  }

  private renderToggles(): void {
    this.root.querySelectorAll<HTMLButtonElement>('button[data-toggle]').forEach((b) => {
      const key = b.dataset.toggle as keyof DiffOptions;
      b.setAttribute('aria-pressed', String(!!this.options[key]));
      b.classList.toggle('on', !!this.options[key]);
      b.disabled = !this.hostOptions.has(key);
    });
  }

  private setStatus(state: 'loading' | 'error' | 'empty' | 'ready', message = ''): void {
    this.root.classList.remove('state-loading', 'state-error', 'state-empty', 'state-ready');
    this.root.classList.add(`state-${state}`);
    if (state === 'loading') this.el.status.innerHTML = `<span class="hsi hsi-loading hsi-modifier-spin"></span> ${escapeHtml(message)}`;
    else if (state === 'error')
      this.el.status.innerHTML = `<span class="hsi hsi-error"></span><div><p>${escapeHtml(message)}</p><button data-cmd="refresh">Try again</button> <button data-cmd="pickBranch">Pick a branch</button></div>`;
    else if (state === 'empty') this.el.status.innerHTML = `<span class="hsi hsi-info"></span><p>${escapeHtml(message)}</p>`;
    else this.el.status.textContent = '';
  }

  private inspect(stop: Stop | undefined, anchorX: number, mode: InspectMode): void {
    if (!stop) {
      if (!this.slider.isDragging()) this.card.hide(mode === 'hover' ? 300 : 150);
      return;
    }
    const top = this.slider.el.getBoundingClientRect().bottom + 2;
    const role = this.roleOf(stop.id);
    if (mode === 'drag') this.card.show(stop, role, anchorX, top, false);
    else if (mode === 'hover') this.card.show(stop, role, anchorX, top, true);
    else this.card.show(stop, role, anchorX, top, true, 2500);
  }

  private roleOf(id: string): CardRole {
    const { oldStop, newStop } = this.ordered();
    if (oldStop?.id === id && newStop?.id === id) return 'both';
    if (oldStop?.id === id) return 'old';
    if (newStop?.id === id) return 'new';
    return undefined;
  }

  private toast(message: string): void {
    this.el.toast.textContent = message;
    this.el.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.el.toast.hidden = true), 5000);
  }

  private saveState(): void {
    const p = this.payload;
    if (!p || p.error) return;
    this.host.setState({
      view: 'branch',
      resource: p.resource,
      branch: p.branch.ref,
      baseSha: this.base?.sha,
      selection: this.selection,
      selectedPath: this.file?.path,
      filters: this.filters,
    });
  }

  // ---- options ----

  private toggle(key: keyof DiffOptions): void {
    if (!this.hostOptions.has(key)) return;
    const value = !this.options[key];
    this.applyOptions({ ...this.options, [key]: value });
    this.post({ type: 'setOption', key, value });
  }

  private applyOptions(options: Partial<DiffOptions>): void {
    this.options = { ...this.options, ...options };
    this.renderToggles();
    this.diff?.setOptions(this.options);
  }

  // ---- layout ----

  private setupSplitter(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const split = this.el.split;
      const stacked = getComputedStyle(split).flexDirection === 'column';
      const rect = split.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        if (stacked) {
          const h = Math.min(rect.height - 120, Math.max(80, ev.clientY - rect.top));
          split.style.setProperty('--files-height', `${h}px`);
        } else {
          const w = Math.min(rect.width - 240, Math.max(180, ev.clientX - rect.left));
          split.style.setProperty('--files-width', `${w}px`);
        }
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.root.classList.remove('resizing');
      };
      this.root.classList.add('resizing');
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  // ---- commands ----

  private run(cmd: string): void {
    switch (cmd) {
      case 'older':
        this.slider.shift(-1);
        break;
      case 'newer':
        this.slider.shift(1);
        break;
      case 'reset':
        this.setSelection(this.defaultSelection());
        this.slider.setActive(0);
        break;
      case 'pickBranch':
        this.post({ type: 'pickBranch' });
        break;
      case 'refresh':
        this.post({ type: 'refresh' });
        break;
      case 'reloadWindow':
        this.post({ type: 'reloadWindow' });
        break;
      case 'help':
        this.el.help.hidden = !this.el.help.hidden;
        break;
      case 'prevChange':
        this.diff?.goToChange(-1);
        break;
      case 'nextChange':
        this.diff?.goToChange(1);
        break;
      case 'prevTouch':
        this.stepTouch(-1);
        break;
      case 'nextTouch':
        this.stepTouch(1);
        break;
      case 'openHistory':
        this.openHistory();
        break;
      case 'openDiff':
        this.openDiff();
        break;
      case 'openFile': {
        const { newStop, oldStop } = this.ordered();
        const sides = this.resolveSides();
        if (sides.newPath && newStop) this.post({ type: 'openFile', stopId: newStop.id, path: sides.newPath });
        else if (sides.oldPath && oldStop) this.post({ type: 'openFile', stopId: oldStop.id, path: sides.oldPath });
        break;
      }
      case 'closeFile':
        this.file = undefined;
        this.paneKey = '';
        this.diff?.clear();
        this.renderMarks();
        this.list.setSelected(undefined);
        this.updatePane();
        this.saveState();
        break;
      case 'toggleMode':
        this.updateFilters({ mode: this.filters.mode === 'tree' ? 'list' : 'tree' });
        break;
      case 'collapseAll': {
        const root = buildTree(this.shown);
        const dirs = allDirs(root);
        const allCollapsed = dirs.every((d) => this.collapsed.has(d));
        this.collapsed = allCollapsed ? new Set() : new Set(dirs);
        this.renderFiles();
        break;
      }
      case 'clearFilters':
        (this.el.query as HTMLInputElement).value = '';
        this.updateFilters({ query: '', hiddenKinds: [] });
        break;
      case 'focusOld':
        this.slider.focusHandle(orderSelection(this.stops, this.selection).oldHandle);
        break;
      case 'focusNew':
        this.slider.focusHandle(orderSelection(this.stops, this.selection).oldHandle === 0 ? 1 : 0);
        break;
    }
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('.file-list')) return; // the list handles its own clicks
    const toggle = target.closest<HTMLElement>('[data-toggle]');
    if (toggle) {
      this.toggle(toggle.dataset.toggle as keyof DiffOptions);
      return;
    }
    const filter = target.closest<HTMLElement>('[data-filter]')?.dataset.filter as 'matchCase' | 'regex' | undefined;
    if (filter) {
      this.updateFilters({ [filter]: !this.filters[filter] });
      return;
    }
    const kind = target.closest<HTMLElement>('[data-kind]')?.dataset.kind as ChangeKind | undefined;
    if (kind) {
      this.toggleKind(kind, e.altKey);
      return;
    }
    const level = target.closest<HTMLElement>('[data-level]')?.dataset.level;
    if (level !== undefined) {
      const p = this.payload;
      if (p && Number(level) !== p.level) this.setLevel(Number(level));
      return;
    }
    const cmd = target.closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
    if (cmd) this.run(cmd);
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('.monaco-editor, input:not([type="checkbox"]), textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onHandle = !!target.closest('.tl-handle');
    let handled = true;
    switch (e.key) {
      case '[':
        this.slider.shift(-1);
        break;
      case ']':
        this.slider.shift(1);
        break;
      case '{':
        this.stepTouch(-1);
        break;
      case '}':
        this.stepTouch(1);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onHandle) return;
        if (e.shiftKey) this.slider.shift(e.key === 'ArrowLeft' ? -1 : 1);
        else this.slider.moveActive(e.key === 'ArrowLeft' ? -1 : 1);
        break;
      case '/':
        (this.el.query as HTMLInputElement).focus();
        (this.el.query as HTMLInputElement).select();
        break;
      case '.':
        this.list.step(1);
        break;
      case ',':
        this.list.step(-1);
        break;
      case 'n':
      case 'j':
        this.run('nextChange');
        break;
      case 'N':
      case 'k':
      case 'p':
        this.run('prevChange');
        break;
      case 'u':
        this.goUp(1);
        break;
      case 'U':
        this.goUp(-1);
        break;
      case 'b':
        this.run('pickBranch');
        break;
      case 'h':
        this.run('openHistory');
        break;
      case 'o':
        this.run('openDiff');
        break;
      case 't':
        this.run('toggleMode');
        break;
      case 's':
        this.toggle('renderSideBySide');
        break;
      case 'w':
        this.toggle('ignoreTrimWhitespace');
        break;
      case 'c':
        this.toggle('hideUnchangedRegions');
        break;
      case 'z':
        this.toggle('wordWrap');
        break;
      case 'r':
        this.run('reset');
        break;
      case '?':
        this.run('help');
        break;
      case 'Escape':
        this.card.hide();
        this.el.help.hidden = true;
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }
}

