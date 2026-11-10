import * as path from 'path';
import * as vscode from 'vscode';
import { FileHistory, toContentResult } from './fileHistory';
import { locateFile } from './git';
import { gitPath, onRepositoryChange } from './gitExtension';
import { revisionUri } from './revisionProvider';
import { BUILD_ID } from './shared/build';
import { makeNonce, webviewHtml } from './webviewHtml';
import {
  WORKING_ID,
  type ContentResult,
  type DiffOptions,
  type HostMessage,
  type InitPayload,
  type PanelState,
  type Stop,
  type WebviewMessage,
} from './shared/protocol';

export const VIEW_TYPE = 'historySlider.history';

export interface OpenOptions {
  /** Commit to focus on: the handles select that commit's own change. */
  sha?: string;
  /** Line (1-based) to reveal in the new side. */
  line?: number;
  /** Handles to restore (after a reload); falls back to the default if either is gone. */
  selection?: [string, string];
  /**
   * Handles to start on (from the branch view). Older pages are loaded until
   * both are there; a side that isn't in the history goes to the oldest stop
   * (old) or the default (new).
   */
  start?: [string, string];
  /** Show history from this ref instead of HEAD, without the working copy (see FileHistory). */
  rev?: string;
  /** How to name `rev` in the title, e.g. the branch name. */
  revLabel?: string;
}

function panelKey(uri: vscode.Uri, rev?: string): string {
  return rev ? `${uri.toString()}\0${rev}` : uri.toString();
}

function config() {
  return vscode.workspace.getConfiguration('historySlider');
}

export function readDiffOptions(): DiffOptions {
  const c = config();
  return {
    renderSideBySide: c.get('renderSideBySide', true),
    ignoreTrimWhitespace: c.get('ignoreTrimWhitespace', false),
    hideUnchangedRegions: c.get('hideUnchangedRegions', false),
    wordWrap: c.get('wordWrap', false),
    contentChangesOnly: c.get('contentChangesOnly', true),
  };
}

export class HistoryPanel {
  private static readonly panels = new Map<string, HistoryPanel>();

  private history?: FileHistory;
  private readonly disposables: vscode.Disposable[] = [];
  private selection?: [string, string];
  private pendingOpen: OpenOptions;
  private workingTimer?: ReturnType<typeof setTimeout>;
  private repoTimer?: ReturnType<typeof setTimeout>;
  private initializing?: Promise<void>;
  private workingStale = false;
  private disposed = false;
  private readonly rev?: string;
  private readonly revLabel?: string;

  static show(
    extensionUri: vscode.Uri,
    uri: vscode.Uri,
    options: OpenOptions = {},
    column: vscode.ViewColumn = vscode.ViewColumn.Active,
  ): HistoryPanel {
    const existing = HistoryPanel.panels.get(panelKey(uri, options.rev));
    if (existing) {
      existing.panel.reveal(column === vscode.ViewColumn.Active ? undefined : column);
      existing.focus(options);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      HistoryPanel.title(uri, options.revLabel),
      column,
      HistoryPanel.webviewOptions(extensionUri),
    );
    return new HistoryPanel(panel, extensionUri, uri, options);
  }

  private static title(uri: vscode.Uri, revLabel?: string): string {
    return `History: ${path.basename(uri.fsPath)}${revLabel ? ` (${revLabel})` : ''}`;
  }

  static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, state: PanelState | undefined): void {
    if (!state?.resource) {
      panel.dispose();
      return;
    }
    const uri = vscode.Uri.parse(state.resource);
    panel.webview.options = HistoryPanel.webviewOptions(extensionUri);
    new HistoryPanel(panel, extensionUri, uri, { selection: state.selection, rev: state.rev, revLabel: state.revLabel });
  }

  static broadcastOptions(): void {
    const options = readDiffOptions();
    for (const p of HistoryPanel.panels.values()) p.post({ type: 'options', options });
  }

  static reloadAll(): void {
    for (const p of HistoryPanel.panels.values()) void p.initialize();
  }

  private static webviewOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
    };
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly uri: vscode.Uri,
    options: OpenOptions,
  ) {
    this.pendingOpen = options;
    this.rev = options.rev;
    this.revLabel = options.revLabel;
    HistoryPanel.panels.set(panelKey(uri, options.rev), this);
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'history-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'history-dark.svg'),
    };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(() => {
        if (panel.visible && this.workingStale) this.scheduleWorkingCopyUpdate();
      }),
      panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === uri.toString()) this.scheduleWorkingCopyUpdate();
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.toString() === uri.toString()) this.scheduleWorkingCopyUpdate();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (d.uri.toString() === uri.toString()) this.scheduleWorkingCopyUpdate();
      }),
    );
    // Glob characters in the name would be misread by the pattern; edits made in
    // VS Code are still picked up through the document events above.
    if (uri.scheme === 'file' && !/[[\]{}*?]/.test(path.basename(uri.fsPath))) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)),
      );
      watcher.onDidChange(() => this.scheduleWorkingCopyUpdate());
      watcher.onDidCreate(() => this.scheduleWorkingCopyUpdate());
      watcher.onDidDelete(() => this.scheduleWorkingCopyUpdate());
      this.disposables.push(watcher);
    }
    void onRepositoryChange(uri, () => this.scheduleRepositoryCheck()).then((d) => {
      if (this.disposed) d.dispose();
      else this.disposables.push(d);
    });
  }

  private focus(options: OpenOptions): void {
    if (options.sha) {
      this.pendingOpen = options;
      void this.selectCommit(options.sha);
    } else if (options.start) {
      this.pendingOpen = options;
      void this.selectRange(options.start);
    }
  }

  private post(message: HostMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          await this.initialize();
          break;
        case 'refresh':
          await this.initialize();
          break;
        case 'getContent':
          this.post({ type: 'content', result: await this.content(m.requestId, m.stopId) });
          break;
        case 'loadMore':
          await this.loadMore(!!m.all);
          break;
        case 'selectionChanged':
          this.selection = m.selection;
          break;
        case 'openDiff':
          await this.openDiff(m.oldId, m.newId);
          break;
        case 'openRevision':
          await this.openRevision(m.stopId, m.line);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage(`Copied ${m.label ?? 'to clipboard'}`, 2000);
          break;
        case 'setOption':
          await config().update(m.key, m.value, vscode.ConfigurationTarget.Global);
          break;
        case 'reloadWindow':
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          break;
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`History Slider: ${(err as Error).message}`);
    }
  }

  /** (Re)loads history and sends the full state to the webview. */
  private initialize(): Promise<void> {
    this.initializing ??= this.doInitialize().finally(() => (this.initializing = undefined));
    return this.initializing;
  }

  private async doInitialize(): Promise<void> {
    const fileName = path.basename(this.uri.fsPath);
    const previousCount = this.history?.commits.length ?? 0;
    this.post({ type: 'loading', message: 'Loading history…' });
    const base: InitPayload = {
      resource: this.uri.toString(),
      fileName,
      relPath: fileName,
      repoName: '',
      languageId: await this.languageId(),
      stops: [],
      hasMore: false,
      options: readDiffOptions(),
      pageSize: config().get('pageSize', 50),
      build: BUILD_ID,
      rev: this.rev,
      revLabel: this.revLabel,
    };
    let history: FileHistory;
    try {
      if (this.uri.scheme !== 'file') throw new Error('Only files on disk have git history.');
      const git = await gitPath();
      const loc = await locateFile(git, this.uri.fsPath);
      history = new FileHistory({
        git,
        root: loc.root,
        relPath: loc.relPath,
        pageSize: Math.max(5, config().get('pageSize', 50)),
        follow: config().get('followRenames', true),
        firstParent: config().get('firstParentOnly', false),
        showStaged: config().get('showStaged', true),
        maxBytes: Math.round(config().get('maxFileSizeMB', 5) * 1024 * 1024),
        rev: this.rev,
      });
      await history.load(previousCount);
    } catch (err) {
      this.post({ type: 'init', payload: { ...base, error: (err as Error).message } });
      return;
    }
    if (this.disposed) {
      history.dispose();
      return;
    }
    this.history?.dispose();
    this.history = history;

    const open = this.pendingOpen;
    this.pendingOpen = {};
    if (open.sha) await this.loadUntil(open.sha);
    for (const id of open.start ?? []) await this.loadUntil(id);

    const stops = await this.allStops();
    const payload: InitPayload = {
      ...base,
      relPath: history.options.relPath,
      repoName: path.basename(history.options.root),
      stops,
      hasMore: history.hasMore,
      selection: this.initialSelection(stops, open),
      revealLine: open.line,
    };
    this.selection = payload.selection;
    this.post({ type: 'init', payload });
  }

  private initialSelection(stops: Stop[], open: OpenOptions): [string, string] {
    const has = (id: string) => stops.some((s) => s.id === id);
    if (open.sha) {
      const sel = this.changeOf(stops, open.sha);
      if (sel) return sel;
    }
    if (open.start) {
      // Keep whichever side is here; the old handle otherwise goes to the oldest stop.
      const fallback = this.initialSelection(stops, {});
      const oldest = stops.find((s) => s.kind === 'commit')?.id ?? fallback[0];
      return [has(open.start[0]) ? open.start[0] : oldest, has(open.start[1]) ? open.start[1] : fallback[1]];
    }
    const keep = open.selection ?? this.selection;
    if (keep && has(keep[0]) && has(keep[1])) return keep;
    const commits = stops.filter((s) => s.kind === 'commit');
    if (this.rev) {
      // No working copy: start on the latest commit's own change.
      const n = commits.length;
      return [commits[Math.max(0, n - 2)]?.id ?? WORKING_ID, commits[n - 1]?.id ?? WORKING_ID];
    }
    const latest = commits[commits.length - 1] ?? stops.find((s) => s.kind === 'staged');
    return [latest?.id ?? WORKING_ID, WORKING_ID];
  }

  /** Every stop the slider shows: the commits, staged changes, and the working copy unless this is another branch's history. */
  private async allStops(): Promise<Stop[]> {
    const stops = this.history?.revisionStops() ?? [];
    return this.rev ? stops : [...stops, await this.workingStop()];
  }

  /** Selection showing just the change a commit made: its predecessor on the slider vs. the commit. */
  private changeOf(stops: Stop[], sha: string): [string, string] | undefined {
    const i = stops.findIndex((s) => s.sha === sha || (s.sha && sha.length >= 7 && s.sha.startsWith(sha)));
    if (i < 0) return undefined;
    return [stops[Math.max(0, i - 1)].id, stops[i].id];
  }

  /** Loads older pages until `sha` is present (bounded, to keep a bad sha from loading everything). */
  private async loadUntil(sha: string): Promise<void> {
    const history = this.history;
    if (!history || !/^[0-9a-f]{7,64}$/i.test(sha)) return;
    for (let i = 0; i < 20 && history.hasMore; i++) {
      if (history.commits.some((c) => c.sha?.startsWith(sha))) return;
      await history.loadMore();
    }
  }

  private async selectCommit(sha: string): Promise<void> {
    if (!this.history) return; // Initialization will pick up pendingOpen.
    await this.loadUntil(sha);
    const stops = await this.allStops();
    const sel = this.changeOf(stops, sha);
    if (!sel) return;
    this.pendingOpen = {};
    await this.resend(stops, sel);
  }

  private async selectRange(start: [string, string]): Promise<void> {
    if (!this.history) return; // Initialization will pick up pendingOpen.
    for (const id of start) await this.loadUntil(id);
    const stops = await this.allStops();
    const sel = this.initialSelection(stops, { start });
    this.pendingOpen = {};
    await this.resend(stops, sel);
  }

  /** Resends everything so any newly loaded pages show up, with the handles on `sel`. */
  private async resend(stops: Stop[], sel: [string, string]): Promise<void> {
    if (!this.history) return;
    this.post({
      type: 'init',
      payload: {
        resource: this.uri.toString(),
        fileName: path.basename(this.uri.fsPath),
        relPath: this.history.options.relPath,
        repoName: path.basename(this.history.options.root),
        languageId: await this.languageId(),
        stops,
        hasMore: this.history.hasMore,
        options: readDiffOptions(),
        pageSize: this.history.options.pageSize,
        build: BUILD_ID,
        rev: this.rev,
        revLabel: this.revLabel,
        selection: sel,
      },
    });
    this.selection = sel;
  }

  private async loadMore(all: boolean): Promise<void> {
    const history = this.history;
    if (!history) return;
    try {
      const stops = await history.loadMore(all);
      if (history === this.history) this.post({ type: 'more', stops, hasMore: history.hasMore });
    } catch (err) {
      this.post({ type: 'moreFailed', error: (err as Error).message });
    }
  }

  private openDocument(): vscode.TextDocument | undefined {
    const key = this.uri.toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }

  /** VS Code's language for the file when it is open; otherwise the webview guesses from the extension. */
  private async languageId(): Promise<string> {
    return this.openDocument()?.languageId ?? '';
  }

  private async workingStop(): Promise<Stop> {
    const doc = this.openDocument();
    let missing = false;
    if (!doc?.isDirty) {
      try {
        await vscode.workspace.fs.stat(this.uri);
      } catch {
        missing = true;
      }
    }
    return {
      id: WORKING_ID,
      kind: 'working',
      path: this.history?.options.relPath ?? path.basename(this.uri.fsPath),
      subject: 'Working copy',
      dirty: doc?.isDirty || undefined,
      missing: missing || undefined,
    };
  }

  private async content(requestId: number, stopId: string): Promise<ContentResult> {
    if (stopId === WORKING_ID) return this.workingContent(requestId);
    if (!this.history) return { requestId, stopId, error: 'History is not loaded yet' };
    return this.history.content(requestId, stopId);
  }

  private async workingContent(requestId: number): Promise<ContentResult> {
    const doc = this.openDocument();
    const maxBytes = this.history?.options.maxBytes ?? 5 * 1024 * 1024;
    if (doc) {
      const text = doc.getText();
      if (text.length > maxBytes) return { requestId, stopId: WORKING_ID, tooLarge: true };
      return { requestId, stopId: WORKING_ID, text };
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      return toContentResult(requestId, WORKING_ID, bytes, maxBytes);
    } catch {
      return { requestId, stopId: WORKING_ID, text: '', missing: true };
    }
  }

  private scheduleWorkingCopyUpdate(): void {
    clearTimeout(this.workingTimer);
    this.workingTimer = setTimeout(async () => {
      if (this.disposed || !this.history) return;
      // No need to stream edits into a panel nobody is looking at; catch up when it is shown.
      this.workingStale = !this.panel.visible;
      if (this.workingStale) return;
      this.post({ type: 'workingCopyChanged', stop: await this.workingStop() });
    }, 250);
  }

  private scheduleRepositoryCheck(): void {
    clearTimeout(this.repoTimer);
    this.repoTimer = setTimeout(async () => {
      const history = this.history;
      if (this.disposed || !history || this.initializing) return;
      try {
        if ((await history.signature()) !== history.currentSignature()) await this.initialize();
      } catch {
        // Ignore transient failures (e.g. index.lock); the next change retries.
      }
    }, 500);
  }

  private stopFor(id: string): Stop | undefined {
    if (id === WORKING_ID) return { id, kind: 'working', path: '', subject: 'Working copy' };
    return this.history?.revisionStops().find((s) => s.id === id);
  }

  private label(stop: Stop): string {
    if (stop.kind === 'working') return 'Working Copy';
    if (stop.kind === 'staged') return 'Staged';
    return stop.shortSha ?? stop.id.slice(0, 7);
  }

  private uriFor(stop: Stop): vscode.Uri {
    if (stop.kind === 'working') return this.uri;
    const h = this.history!;
    return revisionUri(h.options.root, stop.path, h.specFor(stop.id), this.label(stop));
  }

  private async openDiff(oldId: string, newId: string): Promise<void> {
    const oldStop = this.stopFor(oldId);
    const newStop = this.stopFor(newId);
    if (!oldStop || !newStop || !this.history) return;
    const title = `${path.basename(this.uri.fsPath)} (${this.label(oldStop)} ↔ ${this.label(newStop)})`;
    await vscode.commands.executeCommand('vscode.diff', this.uriFor(oldStop), this.uriFor(newStop), title, {
      preview: true,
    });
  }

  private async openRevision(stopId: string, line?: number): Promise<void> {
    const stop = this.stopFor(stopId);
    if (!stop || !this.history) return;
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (line && line > 0) {
      const pos = new vscode.Position(line - 1, 0);
      options.selection = new vscode.Range(pos, pos);
    }
    await vscode.window.showTextDocument(this.uriFor(stop), options);
  }

  private html(): string {
    const webview = this.panel.webview;
    return webviewHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      asset: (name) =>
        webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', name)).toString(),
    });
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.workingTimer);
    clearTimeout(this.repoTimer);
    HistoryPanel.panels.delete(this.uri.toString());
    this.history?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
