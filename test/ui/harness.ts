import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import type { DiffOptions } from '../../src/shared/protocol';
import { webviewHtml } from '../../src/webviewHtml';
import { buildBranchFixture } from './branchFixture';
import { buildFixture, type FixtureOptions } from './fixture';
import { THEMES } from './themes';

export interface Scenario {
  /** Show the branch view (with the fixture in branchFixture.ts) instead of a file's history. */
  view?: 'branch';
  /** Branch view: milliseconds the host takes to answer a diff. */
  diffDelay?: number;
  theme?: keyof typeof THEMES;
  fixture?: FixtureOptions;
  /** Makes the host answer init with this error. */
  error?: string;
  /** Stop id whose content is reported as binary. */
  binary?: string;
  contentDelay?: number;
  /** The build the host reports: by default the webview's own; null leaves it out, like hosts before 0.2.1. */
  build?: string | null;
  /** Options the host leaves out of init, like a host from a build that doesn't know them. */
  unknownOptions?: (keyof DiffOptions)[];
}

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/**
 * Serves the webview the way VS Code does: the page on one origin, its assets on
 * another (so CSP and cross-origin worker loading are exercised), with the
 * same Content-Security-Policy the extension uses and a mock extension host.
 */
export async function startHarness() {
  const dist = path.resolve(__dirname, '../../dist/webview');
  const buildId = fs.readFileSync(path.resolve(__dirname, '../../dist/build-id.txt'), 'utf8');
  const mockHost = fs.readFileSync(path.join(__dirname, 'mockHost.js'), 'utf8');
  const mockBranchHost = fs.readFileSync(path.join(__dirname, 'mockBranchHost.js'), 'utf8');

  const assets = http.createServer((req, res) => {
    const file = path.join(dist, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    if (!file.startsWith(dist) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(file).pipe(res);
  });
  const assetOrigin = `http://127.0.0.1:${await listen(assets)}`;

  const pages = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const scenario: Scenario = JSON.parse(url.searchParams.get('s') ?? '{}');
    const branch = scenario.view === 'branch';
    const fixture = branch ? buildBranchFixture() : buildFixture(scenario.fixture);
    const build = scenario.build === null ? undefined : (scenario.build ?? buildId);
    fixture.init.build = build;
    if ('other' in fixture) fixture.other.build = build;
    const options: Partial<DiffOptions> = fixture.init.options;
    for (const key of scenario.unknownOptions ?? []) delete options[key];
    const theme = THEMES[scenario.theme ?? 'dark'];
    const nonce = 'harnessnonce';
    const script = `const __FIXTURE__ = ${JSON.stringify(fixture)};\nconst __SCENARIO__ = ${JSON.stringify(scenario)};\n${branch ? mockBranchHost : mockHost}`;
    const html = webviewHtml({
      view: branch ? 'branch' : 'file',
      cspSource: assetOrigin,
      nonce,
      asset: (name) => `${assetOrigin}/${name}`,
      beforeScript: `<script nonce="${nonce}">${script.replace(/<\/script/g, '<\\/script')}</script>`,
    })
      .replace('<html lang="en">', `<html lang="en" style="${theme.style}">`)
      .replace('<body>', `<body class="${theme.bodyClass}">`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  });
  // "localhost" vs "127.0.0.1" makes the page and its assets different origins.
  const pagePort = await listen(pages);

  return {
    url: (scenario: Scenario = {}) => `http://localhost:${pagePort}/?s=${encodeURIComponent(JSON.stringify(scenario))}`,
    close: async () => {
      await new Promise((r) => assets.close(r));
      await new Promise((r) => pages.close(r));
    },
  };
}
