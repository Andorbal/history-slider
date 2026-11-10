import * as path from 'path';
import * as vscode from 'vscode';
import { repoRoot } from './branchGit';
import { BRANCH_VIEW_TYPE, BranchPanel } from './branchPanel';
import { gitPath, repositoryRoots } from './gitExtension';
import { HistoryPanel, VIEW_TYPE, type OpenOptions } from './historyPanel';
import { REVISION_SCHEME, RevisionContentProvider } from './revisionProvider';
import type { BranchPanelState } from './shared/branchProtocol';
import type { PanelState } from './shared/protocol';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('historySlider.showHistory', (...args: unknown[]) => showHistory(context, args)),
    vscode.commands.registerCommand('historySlider.showBranchHistory', (...args: unknown[]) => showBranchHistory(context, args)),
    vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, new RevisionContentProvider()),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PanelState | undefined) {
        HistoryPanel.revive(panel, context.extensionUri, state);
      },
    }),
    vscode.window.registerWebviewPanelSerializer(BRANCH_VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: BranchPanelState | undefined) {
        BranchPanel.revive(panel, context, state);
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('historySlider')) return;
      const historyKeys = ['pageSize', 'followRenames', 'firstParentOnly', 'showStaged', 'maxFileSizeMB'];
      if (historyKeys.some((k) => e.affectsConfiguration(`historySlider.${k}`))) {
        HistoryPanel.reloadAll();
        BranchPanel.reloadAll();
      } else {
        HistoryPanel.broadcastOptions();
        BranchPanel.broadcastOptions();
      }
    }),
  );
}

export function deactivate(): void {}

function isUri(value: unknown): value is vscode.Uri {
  return value instanceof vscode.Uri;
}

/** Works out which file (and optionally which commit) a command invocation refers to. */
function resolveTarget(args: unknown[]): { uri?: vscode.Uri; options: OpenOptions } {
  const [first, second] = args;
  const options: OpenOptions = {};

  // Timeline item: (item, uri, source). Git timeline items use the commit sha as their id.
  if (isUri(second) && first && typeof first === 'object' && !isUri(first)) {
    const item = first as { id?: unknown; ref?: unknown };
    const sha = [item.ref, item.id].find((v): v is string => typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v));
    if (sha) options.sha = sha;
    return { uri: second, options };
  }
  // Explorer / editor title: (uri, selectedUris?)
  if (isUri(first)) return { uri: first, options };
  // SCM resource state
  if (first && typeof first === 'object' && isUri((first as { resourceUri?: unknown }).resourceUri)) {
    return { uri: (first as { resourceUri: vscode.Uri }).resourceUri, options };
  }

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    options.line = editor.selection.active.line + 1;
    return { uri: editor.document.uri, options };
  }
  // A diff editor or other tab that wraps a file.
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) return { uri: input.uri, options };
  if (input instanceof vscode.TabInputTextDiff) return { uri: input.modified, options };
  return { options };
}

function showHistory(context: vscode.ExtensionContext, args: unknown[]): void {
  const { uri, options } = resolveTarget(args);
  if (!uri) {
    void vscode.window.showInformationMessage('History Slider: open a file first, then run this command.');
    return;
  }
  if (uri.scheme !== 'file') {
    void vscode.window.showInformationMessage('History Slider only works with files on disk.');
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (options.line === undefined && editor?.document.uri.toString() === uri.toString()) {
    options.line = editor.selection.active.line + 1;
  }
  HistoryPanel.show(context.extensionUri, uri, options);
}

/**
 * Works out which repository the branch command refers to: the Source Control
 * repository it was invoked on, the file it was invoked on, the active
 * editor's file, the only open repository, or one the user picks.
 */
async function resolveRepository(args: unknown[]): Promise<string | undefined> {
  const [first] = args;
  const git = await gitPath();
  const rootOf = (uri: vscode.Uri, isFile: boolean) => repoRoot(git, isFile ? path.dirname(uri.fsPath) : uri.fsPath);
  const scm = first as { rootUri?: unknown } | undefined;
  if (scm && isUri(scm.rootUri)) return rootOf(scm.rootUri, false);
  if (isUri(first) && first.scheme === 'file') return rootOf(first, true);
  const editor = vscode.window.activeTextEditor?.document.uri;
  if (editor?.scheme === 'file') {
    try {
      return await rootOf(editor, true);
    } catch {
      // Not in a repository; look at the open ones instead.
    }
  }
  const roots = await repositoryRoots();
  if (roots.length === 1) return rootOf(roots[0], false);
  if (roots.length > 1) {
    const picked = await vscode.window.showQuickPick(
      roots.map((r) => ({ label: path.basename(r.fsPath), description: r.fsPath, uri: r })),
      { title: 'Show the branch history of which repository?' },
    );
    return picked ? rootOf(picked.uri, false) : undefined;
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder?.scheme === 'file' ? rootOf(folder, false) : undefined;
}

async function showBranchHistory(context: vscode.ExtensionContext, args: unknown[]): Promise<void> {
  let root: string | undefined;
  try {
    root = await resolveRepository(args);
  } catch (err) {
    void vscode.window.showInformationMessage(`History Slider: ${(err as Error).message}`);
    return;
  }
  if (!root) {
    void vscode.window.showInformationMessage('History Slider: open a folder or file in a git repository first.');
    return;
  }
  BranchPanel.show(context, root);
}
