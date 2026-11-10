import * as monaco from 'monaco-editor/editor/editor.api';
import {
  STAGED_ID,
  WORKING_ID,
  type ContentResult,
  type DiffOptions,
  type HostMessage,
  type InitPayload,
  type PanelState,
  type Stop,
  type WebviewMessage,
} from '../src/shared/protocol';
import { BUILD_ID } from '../src/shared/build';
import { Card, type CardRole } from './card';
import { DiffView, type DiffStats, type Reveal } from './diffView';
import { escapeHtml, plural, relativeTime, stopLabel } from './format';
import { resolveLanguage } from './languages';
import { Slider, type InspectMode } from './slider';
import { nearestVisible, orderSelection, visibleStops } from './sliderModel';

export interface HostApi {
  postMessage(message: WebviewMessage): void;
  setState(state: PanelState): void;
}

const MAX_CACHE = 200;

const DEFAULT_OPTIONS: DiffOptions = {
  renderSideBySide: true,
  ignoreTrimWhitespace: false,
  hideUnchangedRegions: false,
  wordWrap: false,
  contentChangesOnly: true,
};

const SHORTCUTS: [string, string][] = [
  ['← / →', 'Move the focused handle one commit'],
  ['Shift + ← / →', 'Move both handles together'],
  ['[ / ]', 'Step both handles older / newer'],
  ['Home / End', 'Move the focused handle to the oldest / newest'],
  ['Tab', 'Switch between the two handles'],
  ['Double-click a commit', 'Show just the change that commit made'],
  ['N / Shift+N', 'Next / previous change in the diff'],
  ['S', 'Toggle side-by-side / inline'],
  ['W', 'Toggle ignore whitespace'],
  ['C', 'Toggle collapse unchanged regions'],
  ['Z', 'Toggle word wrap'],
  ['R', 'Reset to latest commit ↔ working copy'],
  ['O', 'Open this comparison in the VS Code diff editor'],
  ['Shift+click Older', 'Load the whole history'],
];

export class App {
  private readonly root: HTMLElement;
  private readonly slider: Slider;
  private readonly card: Card;
  private diff?: DiffView;
  private readonly el: Record<
    | 'fileName'
    | 'fileDir'
    | 'fileCount'
    | 'notice'
    | 'oldSide'
    | 'newSide'
    | 'stats'
    | 'diffHost'
    | 'overlay'
    | 'status'
    | 'help'
    | 'toast',
    HTMLElement
  >;

  private payload?: InitPayload;
  /** Every stop the host has sent, oldest first. */
  private allStops: Stop[] = [];
  /** The stops on the timeline: `allStops`, minus hidden commits. */
  private stops: Stop[] = [];
  private selection: [string, string] = [WORKING_ID, WORKING_ID];
  private options: DiffOptions = { ...DEFAULT_OPTIONS };
  /** The options the extension host reported, which are the ones it can save. */
  private hostOptions = new Set(Object.keys(DEFAULT_OPTIONS));
  private hasMore = false;
  private loadingMore = false;
  private requestSeq = 0;
  private readonly pending = new Map<number, (r: ContentResult) => void>();
  private readonly cache = new Map<string, Promise<ContentResult>>();
  private diffToken = 0;
  private pendingReveal?: Reveal;
  private pendingChange?: string;
  private prefetchTimer?: ReturnType<typeof setTimeout>;
  private selectionTimer?: ReturnType<typeof setTimeout>;
  private toastTimer?: ReturnType<typeof setTimeout>;

  constructor(
    container: HTMLElement,
    private readonly host: HostApi,
  ) {
    this.root = container;
    this.root.className = 'app state-loading';
    this.root.innerHTML = `
      <header class="topbar">
        <div class="file">
          <span class="hsi hsi-history"></span>
          <span class="file-name"></span>
          <span class="file-dir"></span>
          <span class="file-count"></span>
        </div>
        <div class="toolbar" role="toolbar">
          <label class="check" title="Hide commits that don't change what the diff shows: pure renames, mode changes and line-ending conversions">
            <input type="checkbox" data-option="contentChangesOnly"><span class="check-box hsi hsi-check"></span><span class="check-text">Content changes only</span>
          </label>
          <span class="sep"></span>
          <button data-cmd="older" title="Step both handles one commit older ( [ )"><span class="hsi hsi-arrow-left"></span></button>
          <button data-cmd="newer" title="Step both handles one commit newer ( ] )"><span class="hsi hsi-arrow-right"></span></button>
          <button data-cmd="reset" title="Reset: latest commit ↔ working copy (R)"><span class="hsi hsi-discard"></span></button>
          <span class="sep"></span>
          <button data-toggle="renderSideBySide" title="Side by side (S)"><span class="hsi hsi-split-horizontal"></span></button>
          <button data-toggle="ignoreTrimWhitespace" title="Ignore leading/trailing whitespace (W)"><span class="hsi hsi-whitespace"></span></button>
          <button data-toggle="hideUnchangedRegions" title="Collapse unchanged regions (C)"><span class="hsi hsi-fold"></span></button>
          <button data-toggle="wordWrap" title="Word wrap (Z)"><span class="hsi hsi-word-wrap"></span></button>
          <span class="sep"></span>
          <button data-cmd="openDiff" title="Open this comparison in the VS Code diff editor (O)"><span class="hsi hsi-go-to-file"></span></button>
          <button data-cmd="refresh" title="Reload history"><span class="hsi hsi-refresh"></span></button>
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
        <div class="nav">
          <button data-cmd="prevChange" title="Previous change (Shift+N)"><span class="hsi hsi-arrow-up"></span></button>
          <button data-cmd="nextChange" title="Next change (N)"><span class="hsi hsi-arrow-down"></span></button>
        </div>
      </div>
      <div class="diff-host"><div class="diff"></div><div class="overlay" hidden></div></div>
      <div class="status"></div>
      <div class="help" hidden>
        <div class="help-head"><strong>Keyboard shortcuts</strong><button data-cmd="help" title="Close"><span class="hsi hsi-close"></span></button></div>
        <table>${SHORTCUTS.map(([k, v]) => `<tr><td><kbd>${escapeHtml(k)}</kbd></td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
        <p>Whichever handle is further left is always the <em>old</em> side of the diff.</p>
      </div>
      <div class="toast" hidden></div>`;
    const q = (sel: string) => this.root.querySelector(sel) as HTMLElement;
    this.el = {
      fileName: q('.file-name'),
      fileDir: q('.file-dir'),
      fileCount: q('.file-count'),
      notice: q('.notice'),
      oldSide: q('.side.old'),
      newSide: q('.side.new'),
      stats: q('.stats'),
      diffHost: q('.diff'),
      overlay: q('.overlay'),
      status: q('.status'),
      help: q('.help'),
      toast: q('.toast'),
    };

    this.slider = new Slider({
      select: (sel) => this.onSliderSelect(sel),
      loadMore: (all) => this.loadMore(all),
      inspect: (stop, x, mode) => this.inspect(stop, x, mode),
      activate: (stop) => this.showChange(stop),
      dragChange: (dragging) => this.root.classList.toggle('dragging', dragging),
    });
    q('.timeline-slot').replaceWith(this.slider.el);

    this.card = new Card({
      showChange: (stop) => this.showChange(stop),
      openRevision: (stop) => this.post({ type: 'openRevision', stopId: stop.id }),
      copy: (text, label) => this.post({ type: 'copy', text, label }),
    });
    document.body.appendChild(this.card.el);

    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
    document.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('message', (e: MessageEvent<HostMessage>) => this.onMessage(e.data));
    window.addEventListener('blur', () => this.card.hide());
    this.renderToggles();
    this.exposeForTests();
    this.post({ type: 'ready' });
  }

  /** Read-only hooks used by the UI tests. */
  private exposeForTests(): void {
    (window as unknown as { __historySlider: unknown }).__historySlider = {
      selection: () => this.selection,
      ordered: () => {
        const { oldStop, newStop } = this.ordered();
        return [oldStop?.id, newStop?.id];
      },
      original: () => this.diff?.editor.getModel()?.original.getValue(),
      modified: () => this.diff?.editor.getModel()?.modified.getValue(),
      cursorLine: () => this.diff?.editor.getModifiedEditor().getPosition()?.lineNumber,
      scrollTop: () => this.diff?.editor.getModifiedEditor().getScrollTop(),
      stopCount: () => this.stops.length,
    };
  }

  // ---- messages ----

  private post(message: WebviewMessage): void {
    this.host.postMessage(message);
  }

  private onMessage(msg: HostMessage): void {
    switch (msg.type) {
      case 'loading':
        if (!this.payload) this.setStatus('loading', msg.message);
        break;
      case 'init':
        this.init(msg.payload);
        break;
      case 'more':
        this.onMore(msg.stops, msg.hasMore);
        break;
      case 'moreFailed':
        this.loadingMore = false;
        this.slider.setLoading(false);
        this.toast(`Could not load more history: ${msg.error}`);
        break;
      case 'content': {
        const resolve = this.pending.get(msg.result.requestId);
        this.pending.delete(msg.result.requestId);
        if (msg.result.error) this.cache.delete(msg.result.stopId);
        resolve?.(msg.result);
        break;
      }
      case 'workingCopyChanged':
        this.onWorkingCopyChanged(msg.stop);
        break;
      case 'options':
        this.applyOptions(msg.options);
        break;
      case 'select':
        this.setSelection(msg.selection);
        break;
    }
  }

  private init(payload: InitPayload): void {
    const sameFile = this.payload?.resource === payload.resource;
    this.payload = payload;
    this.options = { ...DEFAULT_OPTIONS, ...payload.options };
    this.hostOptions = new Set(Object.keys(payload.options));
    this.renderToggles();
    this.renderNotice(payload.build);
    this.el.fileName.textContent = payload.fileName;
    const dir = payload.relPath.includes('/') ? payload.relPath.slice(0, payload.relPath.lastIndexOf('/')) : '';
    this.el.fileDir.textContent = [payload.repoName, dir].filter(Boolean).join(' / ') + (payload.revLabel ? ` · on ${payload.revLabel}` : '');
    this.el.fileDir.title = payload.revLabel ? `${payload.relPath}\nHistory of ${payload.revLabel}` : payload.relPath;

    if (payload.error) {
      this.setStatus('error', payload.error);
      return;
    }
    // Commits never change, but the index and working copy might have.
    if (!sameFile) this.cache.clear();
    this.cache.delete(WORKING_ID);
    this.cache.delete(STAGED_ID);
    this.diff?.forget(WORKING_ID);
    this.diff?.forget(STAGED_ID);

    this.allStops = payload.stops;
    this.stops = visibleStops(this.allStops, this.options.contentChangesOnly);
    this.hasMore = payload.hasMore;
    this.loadingMore = false;
    this.slider.setLoading(false);
    this.selection = this.validSelection(payload.selection ?? this.selection);

    if (!this.allStops.some((s) => s.kind !== 'working')) {
      this.setStatus('empty', 'This file has no git history yet. Commit it (or stage it) and its history will show up here.');
    } else {
      this.setStatus('ready');
    }
    this.ensureDiff();
    this.diff!.setFile(payload.fileName, resolveLanguage(monaco, payload.languageId, payload.fileName));
    this.diff!.setOptions(this.options);
    this.slider.setData(this.stops, this.hasMore);
    this.slider.setSelection(this.selection);
    this.renderHeader();
    if (!sameFile || payload.revealLine) this.pendingReveal = payload.revealLine ?? 'first';
    this.onSelectionChanged(false);
  }

  private ensureDiff(): void {
    this.diff ??= new DiffView(this.el.diffHost, this.el.overlay, this.options, (s) => this.renderStats(s));
  }

  private setStatus(state: 'loading' | 'error' | 'empty' | 'ready', message = ''): void {
    this.root.classList.remove('state-loading', 'state-error', 'state-empty', 'state-ready');
    this.root.classList.add(`state-${state}`);
    if (state === 'loading') {
      this.el.status.innerHTML = `<span class="hsi hsi-loading hsi-modifier-spin"></span> ${escapeHtml(message)}`;
    } else if (state === 'error') {
      this.el.status.innerHTML = `<span class="hsi hsi-error"></span><div><p>${escapeHtml(message)}</p><button data-cmd="refresh">Try again</button></div>`;
    } else if (state === 'empty') {
      this.el.status.innerHTML = `<span class="hsi hsi-info"></span><p>${escapeHtml(message)}</p>`;
    } else {
      this.el.status.textContent = '';
    }
  }

  private onMore(stops: Stop[], hasMore: boolean): void {
    this.loadingMore = false;
    const known = new Set(this.allStops.map((s) => s.id));
    this.allStops = [...stops.filter((s) => !known.has(s.id)), ...this.allStops];
    this.stops = visibleStops(this.allStops, this.options.contentChangesOnly);
    this.hasMore = hasMore;
    this.slider.setLoading(false);
    this.slider.setData(this.stops, hasMore);
    this.renderHeader();
    this.renderCompare();
    const change = this.pendingChange;
    this.pendingChange = undefined;
    if (change) {
      const stop = this.stops.find((s) => s.id === change);
      if (stop) this.showChange(stop);
    }
  }

  private loadMore(all: boolean): void {
    if (this.loadingMore || !this.hasMore) return;
    this.loadingMore = true;
    this.slider.setLoading(true);
    this.post({ type: 'loadMore', all });
  }

  private onWorkingCopyChanged(stop: Stop): void {
    if (!this.allStops.some((s) => s.id === WORKING_ID)) return;
    this.allStops = this.allStops.map((s) => (s.id === WORKING_ID ? stop : s));
    this.stops = visibleStops(this.allStops, this.options.contentChangesOnly);
    this.slider.setData(this.stops, this.hasMore);
    this.cache.delete(WORKING_ID);
    this.renderCompare();
    if (this.selection.includes(WORKING_ID)) this.updateDiff();
  }

  // ---- selection ----

  /** `sel` with hidden commits moved to the nearest visible stop, or the default if a stop is unknown. */
  private validSelection(sel: [string, string]): [string, string] {
    const a = nearestVisible(this.allStops, this.stops, sel[0]);
    const b = nearestVisible(this.allStops, this.stops, sel[1]);
    return a && b ? [a, b] : this.defaultSelection();
  }

  private defaultSelection(): [string, string] {
    const commits = this.stops.filter((s) => s.kind === 'commit');
    if (!this.stops.some((s) => s.id === WORKING_ID) && commits.length) {
      // Another branch's history has no working copy: start on the latest commit's change.
      const n = commits.length;
      return [commits[Math.max(0, n - 2)].id, commits[n - 1].id];
    }
    const latest = commits[commits.length - 1] ?? this.stops.find((s) => s.kind === 'staged');
    return [latest?.id ?? WORKING_ID, WORKING_ID];
  }

  private onSliderSelect(sel: [string, string]): void {
    this.selection = sel;
    this.onSelectionChanged(true);
  }

  private setSelection(sel: [string, string]): void {
    this.selection = this.validSelection(sel);
    this.slider.setSelection(this.selection);
    this.onSelectionChanged(true);
  }

  private onSelectionChanged(notify: boolean): void {
    this.renderCompare();
    this.updateDiff();
    const state: PanelState = { resource: this.payload?.resource ?? '', selection: this.selection };
    if (this.payload?.rev) {
      state.rev = this.payload.rev;
      state.revLabel = this.payload.revLabel;
    }
    this.host.setState(state);
    if (notify) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = setTimeout(() => this.post({ type: 'selectionChanged', selection: this.selection }), 200);
    }
  }

  private ordered(): { oldStop?: Stop; newStop?: Stop; oldIndex: number; newIndex: number } {
    const o = orderSelection(this.stops, this.selection);
    return { oldStop: this.stops[o.oldIndex], newStop: this.stops[o.newIndex], ...o };
  }

  /** Selects exactly the change a stop introduced: the stop before it vs. the stop. */
  private showChange(stop: Stop): void {
    const i = this.stops.findIndex((s) => s.id === stop.id);
    if (i < 0) return;
    if (i === 0 && this.hasMore) {
      this.pendingChange = stop.id;
      this.loadMore(false);
      return;
    }
    const prev = this.stops[Math.max(0, i - 1)];
    // Keep each handle's role: whichever is currently "old" takes the earlier stop.
    const { oldHandle } = orderSelection(this.stops, this.selection);
    const sel: [string, string] = oldHandle === 0 ? [prev.id, stop.id] : [stop.id, prev.id];
    this.setSelection(sel);
    this.pendingReveal = 'first';
    this.updateDiff();
  }

  // ---- diff ----

  private getContent(id: string): Promise<ContentResult> {
    const cached = this.cache.get(id);
    if (cached) {
      this.cache.delete(id);
      this.cache.set(id, cached);
      return cached;
    }
    const requestId = ++this.requestSeq;
    const promise = new Promise<ContentResult>((resolve) => this.pending.set(requestId, resolve));
    this.cache.set(id, promise);
    this.post({ type: 'getContent', requestId, stopId: id });
    if (this.cache.size > MAX_CACHE) {
      for (const key of this.cache.keys()) {
        if (this.cache.size <= MAX_CACHE) break;
        if (!this.selection.includes(key)) this.cache.delete(key);
      }
    }
    return promise;
  }

  private updateDiff(): void {
    const token = ++this.diffToken;
    const { oldStop, newStop } = this.ordered();
    if (!oldStop || !newStop || !this.diff) return;
    this.renderStats('pending');
    void Promise.all([this.getContent(oldStop.id), this.getContent(newStop.id)]).then(([o, n]) => {
      if (token !== this.diffToken || !this.diff) return;
      let reveal = this.pendingReveal;
      this.pendingReveal = undefined;
      if (typeof reveal === 'number' && newStop.kind !== 'working') reveal = 'first';
      this.diff.show({ id: oldStop.id, result: o }, { id: newStop.id, result: n }, reveal);
    });
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => this.prefetch(), 150);
  }

  /** Warms the cache around both handles so the next drag step renders instantly. */
  private prefetch(): void {
    const { oldIndex, newIndex } = this.ordered();
    for (const d of [-1, 1, -2, 2, -3]) {
      for (const i of [oldIndex + d, newIndex + d]) {
        const s = this.stops[i];
        if (s && s.kind !== 'working' && !this.cache.has(s.id)) void this.getContent(s.id);
      }
    }
  }

  // ---- rendering ----

  private renderHeader(): void {
    const commits = this.stops.filter((s) => s.kind === 'commit').length;
    const hidden = this.allStops.length - this.stops.length;
    this.el.fileCount.textContent =
      (commits ? `${plural(commits, 'commit')}${this.hasMore ? ' loaded' : ''}` : 'no commits') +
      (hidden ? ` (${hidden.toLocaleString()} hidden)` : '');
    this.el.fileCount.title = hidden
      ? `${plural(hidden, 'commit')} without a visible change hidden. Uncheck "Content changes only" to show them.`
      : '';
  }

  /**
   * The host comes from another build when the extension was reinstalled over the
   * same version without reloading: VS Code keeps running the old host (and its
   * settings), while this panel loaded the new files.
   */
  private renderNotice(hostBuild: string | undefined): void {
    this.el.notice.hidden = hostBuild === BUILD_ID;
    if (this.el.notice.hidden) return;
    // Hosts that send their build also know how to reload the window.
    const action = hostBuild
      ? '<button data-cmd="reloadWindow">Reload Window</button>'
      : '<span>Run <strong>Developer: Reload Window</strong> to finish.</span>';
    this.el.notice.innerHTML = `<span class="hsi hsi-warning"></span><span class="notice-text">History Slider was updated while this window was open. Reload the window so that everything works.</span>${action}`;
  }

  private sideHtml(stop: Stop | undefined, role: 'old' | 'new'): string {
    const pill = `<span class="pill ${role}">${role.toUpperCase()}</span>`;
    if (!stop) return pill;
    if (stop.kind === 'working') {
      const note = stop.missing ? 'deleted' : stop.dirty ? 'unsaved changes' : 'on disk';
      return `${pill}<span class="side-main">Working copy</span><span class="muted">· ${note}</span>`;
    }
    if (stop.kind === 'staged') return `${pill}<span class="side-main">Staged</span><span class="muted">· index</span>`;
    const when = stop.authorDate ? relativeTime(stop.authorDate) : '';
    return `${pill}<code>${escapeHtml(stopLabel(stop))}</code><span class="side-main">${escapeHtml(stop.subject)}</span><span class="muted">· ${escapeHtml(stop.authorName ?? '')}${when ? ` · ${escapeHtml(when)}` : ''}</span>`;
  }

  private renderCompare(): void {
    const { oldStop, newStop } = this.ordered();
    this.el.oldSide.innerHTML = this.sideHtml(oldStop, 'old');
    this.el.newSide.innerHTML = this.sideHtml(newStop, 'new');
    this.el.oldSide.title = oldStop ? this.sideTitle(oldStop) : '';
    this.el.newSide.title = newStop ? this.sideTitle(newStop) : '';
  }

  private sideTitle(stop: Stop): string {
    if (stop.kind !== 'commit') return `${stopLabel(stop)} — click to focus this handle`;
    return `${stop.sha}\n${stop.subject}\n${stop.authorName} <${stop.authorEmail}>\n\nClick to focus this handle`;
  }

  private renderStats(stats: DiffStats | undefined | 'pending'): void {
    const { oldIndex, newIndex, oldStop, newStop } = this.ordered();
    const commitsBetween = this.stops.slice(oldIndex + 1, newIndex + 1).filter((s) => s.kind === 'commit').length;
    const span = commitsBetween > 1 ? `<span class="muted" title="Commits between the two handles">${plural(commitsBetween, 'commit')}</span>` : '';
    let text: string;
    if (stats === 'pending') text = '<span class="muted">comparing…</span>';
    else if (!stats) text = '';
    else if (oldStop?.id === newStop?.id) text = '<span class="muted">same revision</span>';
    else if (stats.changes === 0) text = '<span class="muted">no changes</span>';
    else {
      text = `<span class="added">+${stats.added.toLocaleString()}</span><span class="deleted">−${stats.removed.toLocaleString()}</span><span class="muted">${plural(stats.changes, 'change')}</span>`;
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
    this.root.querySelectorAll<HTMLInputElement>('input[data-option]').forEach((input) => {
      input.checked = !!this.options[input.dataset.option as keyof DiffOptions];
      input.disabled = !this.hostOptions.has(input.dataset.option!);
    });
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

  // ---- commands ----

  private toggle(key: keyof DiffOptions): void {
    this.setOption(key, !this.options[key]);
  }

  private setOption(key: keyof DiffOptions, value: boolean): void {
    // The host would fail to save an option it doesn't know (see renderNotice).
    if (!this.hostOptions.has(key)) return;
    this.applyOptions({ ...this.options, [key]: value });
    this.post({ type: 'setOption', key, value });
    const commits = this.allStops.filter((s) => s.kind === 'commit');
    if (key === 'contentChangesOnly' && commits.length && !commits.some((s) => s.noVisibleChange)) {
      this.toast(
        `Nothing to ${value ? 'hide' : 'show'}: every ${this.hasMore ? 'loaded ' : ''}commit changes what the diff shows. ` +
          'Only commits that just rename the file, change its mode or convert its line endings are hidden.',
      );
    }
  }

  private applyOptions(options: Partial<DiffOptions>): void {
    const next = { ...this.options, ...options };
    const refilter = next.contentChangesOnly !== this.options.contentChangesOnly;
    this.options = next;
    this.renderToggles();
    this.diff?.setOptions(next);
    if (refilter) this.refilter();
  }

  /** Rebuilds the timeline after the filter changed, moving handles off commits that were hidden. */
  private refilter(): void {
    if (!this.payload || this.payload.error) return;
    this.stops = visibleStops(this.allStops, this.options.contentChangesOnly);
    this.slider.setData(this.stops, this.hasMore);
    this.renderHeader();
    this.setSelection(this.selection);
  }

  private run(cmd: string): void {
    const { oldStop, newStop } = this.ordered();
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
      case 'openDiff':
        if (oldStop && newStop) this.post({ type: 'openDiff', oldId: oldStop.id, newId: newStop.id });
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
    const toggle = target.closest<HTMLElement>('[data-toggle]');
    if (toggle) {
      this.toggle(toggle.dataset.toggle as keyof DiffOptions);
      return;
    }
    const cmd = target.closest<HTMLElement>('[data-cmd]')?.dataset.cmd;
    if (cmd) this.run(cmd);
  }

  private onChange(e: Event): void {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('input[data-option]');
    if (input) this.setOption(input.dataset.option as keyof DiffOptions, input.checked);
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
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onHandle) return; // the handle deals with it
        if (e.shiftKey) this.slider.shift(e.key === 'ArrowLeft' ? -1 : 1);
        else this.slider.moveActive(e.key === 'ArrowLeft' ? -1 : 1);
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
      case 'o':
        this.run('openDiff');
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
