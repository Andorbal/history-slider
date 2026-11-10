import './monacoFeatures';
import 'monaco-editor/languages/definitions/register.all';
import type { BranchPanelState, BranchWebviewMessage } from '../src/shared/branchProtocol';
import type { PanelState, WebviewMessage } from '../src/shared/protocol';
import { App } from './app';
import { BranchApp } from './branchApp';
import './styles.css';

interface VsCodeApi {
  postMessage(message: WebviewMessage | BranchWebviewMessage): void;
  setState(state: PanelState | BranchPanelState): void;
  getState(): PanelState | BranchPanelState | undefined;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker | Promise<Worker> };
  }
}

const container = document.getElementById('app')!;
const workerUrl = container.dataset.worker ?? '';
let workerSource: Promise<string> | undefined;

// Webview resources live on another origin, so the worker script is fetched and
// started from a blob URL. If that fails Monaco falls back to diffing on the main thread.
window.MonacoEnvironment = {
  getWorker() {
    workerSource ??= fetch(workerUrl).then((r) => {
      if (!r.ok) throw new Error(`Failed to load ${workerUrl}: ${r.status}`);
      return r.text();
    });
    return workerSource.then((src) => new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))));
  },
};

const vscode = acquireVsCodeApi();
if (container.dataset.view === 'branch') new BranchApp(container, vscode);
else new App(container, vscode);
