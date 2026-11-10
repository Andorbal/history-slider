import * as vscode from 'vscode';

/** The small slice of the built-in git extension's API (v1) that we use. */
interface GitRepositoryState {
  readonly HEAD: { readonly commit?: string } | undefined;
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
}

interface GitAPI {
  readonly git: { readonly path: string };
  readonly repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

let apiPromise: Promise<GitAPI | undefined> | undefined;

async function loadApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!ext) return undefined;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.enabled ? exports.getAPI(1) : undefined;
  } catch {
    return undefined;
  }
}

function api(): Promise<GitAPI | undefined> {
  apiPromise ??= loadApi();
  return apiPromise;
}

/** Path of the git executable VS Code is using, falling back to `git` on PATH. */
export async function gitPath(): Promise<string> {
  return (await api())?.git.path || 'git';
}

/**
 * Fires `listener` whenever the git extension reports a change in the
 * repository containing `uri` (commits, checkouts, staging, ...).
 */
export async function onRepositoryChange(uri: vscode.Uri, listener: () => void): Promise<vscode.Disposable> {
  const git = await api();
  if (!git) return new vscode.Disposable(() => undefined);
  const disposables: vscode.Disposable[] = [];
  let attached = false;
  const attach = (repo: GitRepository | null) => {
    if (!repo || attached) return;
    attached = true;
    disposables.push(repo.state.onDidChange(listener));
  };
  attach(git.getRepository(uri));
  if (!attached) {
    // Repositories are discovered asynchronously right after startup.
    disposables.push(git.onDidOpenRepository(() => attach(git.getRepository(uri))));
  }
  return new vscode.Disposable(() => disposables.forEach((d) => d.dispose()));
}

/** Roots of the repositories the git extension has open. */
export async function repositoryRoots(): Promise<vscode.Uri[]> {
  return (await api())?.repositories.map((r) => r.rootUri) ?? [];
}
