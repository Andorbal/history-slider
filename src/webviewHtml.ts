/** Builds the webview document. Kept free of `vscode` imports so UI tests can reuse it. */
export interface WebviewHtmlOptions {
  /** `webview.cspSource` */
  cspSource: string;
  /** URL of a file in dist/webview */
  asset(name: string): string;
  nonce: string;
  /** Extra markup injected before the main script (tests use it for a mock host). */
  beforeScript?: string;
  /** Which panel to show: a file's history (the default) or a branch's. */
  view?: 'file' | 'branch';
}

export function webviewHtml(o: WebviewHtmlOptions): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${o.cspSource} data:`,
    `style-src ${o.cspSource} 'unsafe-inline'`,
    `font-src ${o.cspSource} data:`,
    `script-src 'nonce-${o.nonce}'`,
    `connect-src ${o.cspSource}`,
    `worker-src blob:`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.asset('icons.css')}">
<link rel="stylesheet" href="${o.asset('main.css')}">
<title>History Slider</title>
</head>
<body>
<div id="app" data-view="${o.view ?? 'file'}" data-worker="${o.asset('editor.worker.js')}"></div>
${o.beforeScript ?? ''}
<script nonce="${o.nonce}" src="${o.asset('main.js')}"></script>
</body>
</html>`;
}

export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
