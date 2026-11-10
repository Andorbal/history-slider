import * as path from 'path';
import * as vscode from 'vscode';
import { listRefs } from './branchGit';
import { BranchHistory } from './branchHistory';
import { gitPath, onRepositoryChange } from './gitExtension';
import { HistoryPanel, readDiffOptions } from './historyPanel';
import { revisionUri } from './revisionProvider';
import {
  DEFAULT_FILTERS,
  type BranchHostMessage,
  type BranchInitPayload,
  type BranchPanelState,
  type BranchWebviewMessage,
  type FilterState,
} from './shared/branchProtocol';
import { BUILD_ID } from './shared/build';
import { STAGED_ID, WORKING_ID } from './shared/protocol';
import { makeNonce, webviewHtml } from './webviewHtml';

export const BRANCH_VIEW_TYPE = 'historySlider.branch';
const FILTERS_KEY = 'historySlider.branchFilters';

function config() {
  return vscode.workspace.getConfiguration('historySlider');
}

export interface BranchOpenOptions {
  /** Full ref of the branch; the checked-out one when left out. */
  branch?: string;
  /** Sha of the base level to start at. */
  baseSha?: string;
  selection?: [string, string];
  selectedPath?: string;
  query?: string;
}

/** One webview panel per repository showing a branch's history and what it changed. */
export class BranchPanel {
  private static readonly panels = new Map<string, BranchPanel>();

  private history?: BranchHistory;
  private readonly disposables: vscode.Disposable[] = [];
  private branchRef?: string;
  private baseSha?: string;
  private pending: { selection?: [string, string]; selectedPath?: string; reset?: boolean; query?: string };
  private initializing?: Promise<void>;
  private repoTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  static show(context: vscode.ExtensionContext, root: string, options: BranchOpenOptions = {}): BranchPanel {
    const existing = BranchPanel.panels.get(root);
    if (existing) {
      existing.panel.reveal();
      if (options.branch && options.branch !== existing.history?.branch.ref) {
        existing.branchRef = options.branch;
        existing.baseSha = undefined;
        existing.pending = { reset: true };
        void existing.initialize();
      }
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      BRANCH_VIEW_TYPE,
      `Branch: ${path.basename(root)}`,
      vscode.ViewColumn.Active,
      BranchPanel.webviewOptions(context.extensionUri),
    );
    return new BranchPanel(panel, context, root, options);
  }

  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, state: BranchPanelState | undefined): void {
    if (!state?.resource) {
      panel.dispose();
      return;
    }
    const root = vscode.Uri.parse(state.resource).fsPath;
    if (BranchPanel.panels.has(root)) {
      panel.dispose();
      return;
    }
    panel.webview.options = BranchPanel.webviewOptions(context.extensionUri);
    new BranchPanel(panel, context, root, {
      branch: state.branch,
      baseSha: state.baseSha,
      selection: state.selection,
      selectedPath: state.selectedPath,
      query: state.filters?.query,
    });
  }

  static broadcastOptions(): void {
    const options = readDiffOptions();
    for (const p of BranchPanel.panels.values()) p.post({ type: 'options', options });
  }

  static reloadAll(): void {
    for (const p of BranchPanel.panels.values()) void p.initialize();
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
    private readonly context: vscode.ExtensionContext,
    private readonly root: string,
    options: BranchOpenOptions,
  ) {
    this.branchRef = options.branch;
    this.baseSha = options.baseSha;
    this.pending = { selection: options.selection, selectedPath: options.selectedPath, query: options.query };
    BranchPanel.panels.set(root, this);
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'history-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'history-dark.svg'),
    };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: BranchWebviewMessage) => this.onMessage(m)),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.scheme === 'file' && !path.relative(root, d.uri.fsPath).startsWith('..')) this.scheduleRepositoryCheck();
      }),
    );
    void onRepositoryChange(vscode.Uri.file(root), () => this.scheduleRepositoryCheck()).then((d) => {
      if (this.disposed) d.dispose();
      else this.disposables.push(d);
    });
  }

  private post(message: BranchHostMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private async onMessage(m: BranchWebviewMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
        case 'refresh':
          await this.initialize();
          break;
        case 'loadMore':
          await this.loadMore();
          break;
        case 'setLevel':
          await this.setLevel(m.level, m.selection);
          break;
        case 'pickBranch':
          await this.pickBranch();
          break;
        case 'getDiff':
          await this.sendDiff(m.requestId, m.oldId, m.newId);
          break;
        case 'getContent': {
          const h = this.history;
          if (!h) break;
          const result = await h.content(m.requestId, m.stopId, m.path);
          this.post({ type: 'content', result: { ...result, path: m.path } });
          break;
        }
        case 'track': {
          const h = this.history;
          if (!h) break;
          this.post({ type: 'track', path: m.path, touches: await h.track(m.path) });
          break;
        }
        case 'openDiff':
          await this.openDiff(m.oldId, m.newId, m.oldPath, m.newPath);
          break;
        case 'openFile':
          await this.openFile(m.stopId, m.path);
          break;
        case 'openFileHistory':
          await this.openFileHistory(m.oldId, m.newId, m.oldPath, m.newPath);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage(`Copied ${m.label ?? 'to clipboard'}`, 2000);
          break;
        case 'setOption':
          await config().update(m.key, m.value, vscode.ConfigurationTarget.Global);
          break;
        case 'saveFilters': {
          // The text query belongs to this panel; the rest is remembered for new ones.
          const { query: _query, ...rest } = m.filters;
          await this.context.globalState.update(FILTERS_KEY, rest);
          break;
        }
        case 'reloadWindow':
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          break;
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`History Slider: ${(err as Error).message}`);
    }
  }

  private filters(): FilterState {
    const saved = this.context.globalState.get<Partial<FilterState>>(FILTERS_KEY) ?? {};
    return { ...DEFAULT_FILTERS, ...saved, query: this.pending.query ?? '' };
  }

  private initialize(): Promise<void> {
    this.initializing ??= this.doInitialize().finally(() => (this.initializing = undefined));
    return this.initializing;
  }

  private async doInitialize(): Promise<void> {
    this.post({ type: 'loading', message: 'Loading branch history…' });
    const repoName = path.basename(this.root);
    const pending = this.pending;
    this.pending = {};
    const base: BranchInitPayload = {
      resource: vscode.Uri.file(this.root).toString(),
      repoName,
      branch: { ref: this.branchRef ?? '', name: this.branchRef?.replace(/^refs\/(heads|remotes)\//, '') ?? '', sha: '', remote: false, head: false },
      levels: [],
      level: -1,
      commits: [],
      hasMore: false,
      specials: [],
      options: readDiffOptions(),
      filters: this.filters(),
      build: BUILD_ID,
    };
    let history: BranchHistory;
    try {
      history = await BranchHistory.open(
        {
          git: await gitPath(),
          root: this.root,
          pageSize: Math.max(100, config().get('pageSize', 50) * 2),
          maxBytes: Math.round(config().get('maxFileSizeMB', 5) * 1024 * 1024),
        },
        this.branchRef,
        // Keep the level in use across refreshes, but start a newly picked branch at its nearest base.
        this.baseSha ?? (pending.reset ? undefined : this.history?.base?.sha),
      );
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
    this.branchRef = history.branch.ref;
    this.baseSha = undefined;
    this.panel.title = `Branch: ${history.branch.name}`;
    this.post({
      type: 'init',
      payload: {
        ...base,
        branch: history.branch,
        levels: history.levels,
        level: history.level,
        base: history.base,
        commits: history.commits,
        hasMore: history.hasMore,
        specials: history.specials(),
        selection: pending.selection,
        selectedPath: pending.selectedPath,
        reset: pending.reset,
      },
    });
  }

  private async setLevel(level: number, selection?: [string, string]): Promise<void> {
    const h = this.history;
    if (!h || !h.levels[level]) return;
    this.post({ type: 'loading', message: 'Loading branch history…' });
    await h.setLevel(level);
    if (h !== this.history) return;
    this.pending = { selection };
    // Same history, so no need to read the branches again: just send everything.
    this.post({
      type: 'init',
      payload: {
        resource: vscode.Uri.file(this.root).toString(),
        repoName: path.basename(this.root),
        branch: h.branch,
        levels: h.levels,
        level: h.level,
        base: h.base,
        commits: h.commits,
        hasMore: h.hasMore,
        specials: h.specials(),
        options: readDiffOptions(),
        filters: this.filters(),
        build: BUILD_ID,
        selection,
      },
    });
    this.pending = {};
  }

  private async loadMore(): Promise<void> {
    const h = this.history;
    if (!h) return;
    try {
      const commits = await h.loadMore();
      if (h === this.history) this.post({ type: 'more', commits, hasMore: h.hasMore });
    } catch (err) {
      this.post({ type: 'moreFailed', error: (err as Error).message });
    }
  }

  private async sendDiff(requestId: number, oldId: string, newId: string): Promise<void> {
    const h = this.history;
    if (!h) return;
    try {
      const files = await h.diff(oldId, newId);
      this.post({ type: 'diff', result: { requestId, oldId, newId, files } });
    } catch (err) {
      this.post({ type: 'diff', result: { requestId, oldId, newId, files: [], error: (err as Error).message } });
    }
  }

  private async pickBranch(): Promise<void> {
    const git = await gitPath();
    const refs = (await listRefs(git, this.root)).filter((r) => !r.symref);
    const current = this.history?.branch.ref;
    const headRef = this.history?.head.ref;
    type Item = vscode.QuickPickItem & { ref?: string };
    const toItem = (r: (typeof refs)[number]): Item => ({
      label: `${r.remote ? '$(cloud)' : '$(git-branch)'} ${r.name}`,
      description: [r.sha.slice(0, 8), r.ref === headRef ? 'checked out' : '', r.ref === current ? 'showing' : ''].filter(Boolean).join(' · '),
      detail: r.subject,
      ref: r.ref,
    });
    const byDate = (a: (typeof refs)[number], b: (typeof refs)[number]) => b.date - a.date;
    const locals = refs.filter((r) => !r.remote).sort(byDate);
    const remotes = refs.filter((r) => r.remote).sort(byDate);
    const items: Item[] = [];
    if (this.history && !this.history.head.ref && this.history.head.sha) {
      items.push({ label: '$(git-commit) HEAD', description: `detached at ${this.history.head.sha.slice(0, 8)}`, ref: 'HEAD' });
    }
    if (locals.length) items.push({ label: 'Branches', kind: vscode.QuickPickItemKind.Separator }, ...locals.map(toItem));
    if (remotes.length) items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator }, ...remotes.map(toItem));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Show the history of a branch',
      placeHolder: 'The slider runs from where the branch was branched to its newest commit',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked?.ref) return;
    this.branchRef = picked.ref;
    this.baseSha = undefined;
    this.pending = { reset: true };
    await this.initialize();
  }

  private label(stopId: string): string {
    if (stopId === WORKING_ID) return 'Working Copy';
    if (stopId === STAGED_ID) return 'Staged';
    return stopId.slice(0, 7);
  }

  private uriFor(stopId: string, file: string | undefined): vscode.Uri {
    const h = this.history!;
    if (stopId === WORKING_ID && file) return vscode.Uri.file(path.join(this.root, file));
    // No file on this side: an empty document.
    return revisionUri(this.root, file ?? 'file', file ? h.specFor(stopId, file) : undefined, this.label(stopId));
  }

  private async openDiff(oldId: string, newId: string, oldPath?: string, newPath?: string): Promise<void> {
    if (!this.history) return;
    const name = path.basename(newPath ?? oldPath ?? '');
    const title = `${name} (${this.label(oldId)} ↔ ${this.label(newId)})`;
    await vscode.commands.executeCommand('vscode.diff', this.uriFor(oldId, oldPath), this.uriFor(newId, newPath), title, { preview: true });
  }

  private async openFile(stopId: string, file: string): Promise<void> {
    if (!this.history) return;
    await vscode.window.showTextDocument(this.uriFor(stopId, file), { preview: true });
  }

  /**
   * Opens the file in its own History Slider, independent of this panel. Its
   * handles start where this panel's are: on the newest commits that changed
   * the file at or before each handle.
   */
  private async openFileHistory(oldId: string, newId: string, oldPath?: string, newPath?: string): Promise<void> {
    const h = this.history;
    const file = newPath ?? oldPath;
    if (!h || !file) return;
    const special = (id: string) => id === STAGED_ID || id === WORKING_ID;
    const map = async (id: string, p: string | undefined) => {
      if (special(id)) return id;
      return p ? h.lastChange(id, p) : undefined;
    };
    let [from, to] = await Promise.all([map(oldId, oldPath), map(newId, newPath)]);
    if (!from && to) {
      // The file didn't exist yet on the old side: start on the commit that added it.
      const tip = special(newId) ? h.branch.sha : newId;
      from = (await h.firstChangeAfter(oldId, tip, file)) ?? to;
    }
    if (!to && from) to = from; // deleted on the new side
    const rev = h.branch.head ? undefined : h.branch.ref;
    HistoryPanel.show(
      this.context.extensionUri,
      vscode.Uri.file(path.join(this.root, file)),
      { start: from && to ? [from, to] : undefined, rev, revLabel: rev ? h.branch.name : undefined },
      vscode.ViewColumn.Beside,
    );
  }

  private scheduleRepositoryCheck(): void {
    clearTimeout(this.repoTimer);
    this.repoTimer = setTimeout(async () => {
      const h = this.history;
      if (this.disposed || !h || this.initializing) return;
      try {
        if ((await h.signature()) !== h.currentSignature()) {
          await this.initialize();
        } else if (h.specials().length) {
          // Same files changed, but maybe not the same way.
          h.working.invalidate();
          this.post({ type: 'workingChanged' });
        }
      } catch {
        // Ignore transient failures (e.g. index.lock); the next change retries.
      }
    }, 500);
  }

  private html(): string {
    const webview = this.panel.webview;
    return webviewHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      view: 'branch',
      asset: (name) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', name)).toString(),
    });
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.repoTimer);
    BranchPanel.panels.delete(this.root);
    this.history?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
