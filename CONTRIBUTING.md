# Contributing

## Layout

| Path | What lives there |
| --- | --- |
| `src/extension.ts` | Activation, the `historySlider.showHistory` command, working out which file (and commit) it was invoked on |
| `src/historyPanel.ts` | One webview panel per file: loads history, serves file contents, watches the file and repository |
| `src/fileHistory.ts`, `src/git.ts` | Git access (`git log --follow`, a long-lived `git cat-file --batch`). No `vscode` imports, so they are tested against real repositories |
| `src/branchPanel.ts` | One webview panel per repository for the branch view: picks the branch, opens files in the diff editor or their own History Slider, refreshes on repository changes |
| `src/branchHistory.ts`, `src/branchGit.ts` | The branch view's git access, also without `vscode`: where a branch was branched (and where that branch was, for stacked branches), the commits along it, what changed in the whole repository between two points and how each file changed (pure rename, whitespace only, mode only...). Diffs against the working tree use a throwaway copy of the index with untracked files added as intent-to-add, so they count and pair up as renames without touching the real index |
| `src/shared/branchProtocol.ts` | Messages between the extension and the branch view |
| `src/shared/protocol.ts` | Messages between the extension and the webview |
| `webview/` | The panel UI: `slider.ts` (timeline and handles), `sliderModel.ts` (pure layout/selection logic), `diffView.ts` (Monaco diff editor), `card.ts` (commit popup), `app.ts` (wiring). The branch view adds `branchApp.ts` (its wiring), `fileList.ts` (the virtualized file tree) and `fileFilter.ts` (pure filtering, globs and tree building); `main.ts` starts one or the other from the page's `data-view` |
| `test/demo/` | Records the animations in the README (`npm run demos`) |
| `esbuild.mjs` | Bundles the extension, the webview (with Monaco) and Monaco's diff worker into `dist/`, stamping the extension and webview with the same build id (`src/shared/build.ts`) so a panel notices when VS Code is still running another build |

## Build and run

```sh
npm install
npm run build        # or: npm run watch
```

Press **F5** in VS Code ("Run Extension") to start an Extension Development Host.

## Tests

```sh
npm run typecheck
npm test             # unit tests: git layer against temporary repos, slider logic, file filters, formatting
npm run test:ui      # the webview in headless Chromium with a mock extension host
npm run check        # all of the above
```

The UI tests (`test/ui`) serve the built webview the way VS Code does: the page and its assets on different origins, under the same Content-Security-Policy the extension sets. They fail on any console error or CSP violation, and they check that Monaco's diff worker really starts. The branch view's tests (`branch.spec.ts`) run against `mockBranchHost.js`, which replays the pretend repository in `branchFixture.ts`: a stack of three branches with a big rename, edits, whitespace and mode changes.

### End-to-end tests in VS Code

`test/e2e` drives the real extension inside [code-server](https://github.com/coder/code-server) (VS Code in a browser). They are skipped unless `HISTORY_SLIDER_CODE_SERVER` is set.

```sh
# code-server needs Node 24 and, on Linux, libkrb5-dev to build.
npm install --prefix /tmp/cs code-server

# Point an extensions directory at this checkout.
mkdir -p /tmp/cs-ext && ln -sfn "$PWD" /tmp/cs-ext/AndrewBenz.history-slider-0.3.0

npm run build
/tmp/cs/node_modules/.bin/code-server --auth none --bind-addr 127.0.0.1:8123 \
  --extensions-dir /tmp/cs-ext --user-data-dir /tmp/cs-data --disable-workspace-trust &

HISTORY_SLIDER_CODE_SERVER=http://127.0.0.1:8123 npm run test:e2e
```

Each run creates a throwaway repository and checks: the keybinding, dragging across a rename, saving the **Content changes only** setting, opening VS Code's diff editor, live updates while typing, refreshing after an outside `git commit`, restoring after a window reload, and the Timeline and Explorer context menus.

### Recording the README animations

The GIFs in `media/demo` are recordings of the real extension in code-server, made by `test/demo/demos.spec.ts` on the history of [Express](https://github.com/expressjs/express) (MIT License). Record them again when the UI changes:

```sh
# code-server as for the end-to-end tests, and ffmpeg with the palettegen filter
# (apt install ffmpeg, brew install ffmpeg, or set FFMPEG to its path).
CODE_SERVER=/tmp/cs/node_modules/.bin/code-server npm run demos

# Just one of them (scrub-history, follow-renames, step-through-commits, live-working-copy):
CODE_SERVER=/tmp/cs/node_modules/.bin/code-server npm run demos -- -g follow-renames
```

The first run clones Express into `.demos/express` and checks out a pinned commit, so the timelines stay the same. Each run builds the extension, starts its own code-server on a free port (a fresh profile in `.demos/vscode`, with a dark theme and this checkout as the extension), records each scene with Chromium's screencast and overwrites `media/demo/<scene>.gif`. The scenes check what they show, such as the commit counts at that commit and the rename on the commit card, so a run fails rather than recording something broken. Look at the GIFs before committing them, and keep each one to a few MB. They aren't packaged: `.vscodeignore` includes only the files directly in `media`, and `vsce` points the README's images at GitHub. The branch view's pictures (`media/demo/branch-*`) aren't a `npm run demos` scene yet: they were taken from the branch panel's webview, answered by `BranchHistory` on a real repository, rather than in code-server.

## Packaging and releases

```sh
npm run package      # history-slider-<version>.vsix
```

The **Build** workflow (`.github/workflows/build.yml`) runs the typecheck, unit tests and UI tests on every push to `main` and every pull request, then packages the extension. The `.vsix` is attached to the run as an artifact named `history-slider-<version>-<sha>`.

To publish a release, bump the version (`npm version <x.y.z> --no-git-tag-version` updates `package.json` and `package-lock.json`), add a `CHANGELOG.md` entry, and once that is on `main`, push a matching tag:

```sh
git tag v0.3.0
git push origin v0.3.0
```

Give every release its own version. VS Code keeps running an installed build until the window reloads, and installing another build of the same version replaces its files in place; the panel then asks for a reload. The Marketplace also refuses a version it already has.

The workflow checks that the tag matches `package.json`, creates a GitHub release with the `.vsix` attached, then publishes that same `.vsix` to the VS Code Marketplace. Publishing is a separate job, so if it fails you can re-run just that job once the problem is fixed; the GitHub release is already in place.

Follow [Semantic Versioning](https://semver.org/). Command IDs and setting names (`historySlider.*`) are the public surface: renaming or removing one is a breaking change, which bumps the minor version while the version is `0.x`.

### Marketplace publishing

The publish job signs in with Microsoft Entra ID; there is no personal access token. It needs:

- A GitHub environment named `vscode-marketplace` whose deployment policy allows `main` and `v*` tags, with the **variables** (not secrets) `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`.
- The user-assigned managed identity `andrewbenz-marketplace` (that client ID) with a federated credential for GitHub Actions: organization `Andorbal`, repository `history-slider`, entity type *Environment*, environment `vscode-marketplace`. In the Azure portal it's under **Managed Identities** → `andrewbenz-marketplace` → **Settings** → **Federated credentials**, not App registrations. What the Test publishes with the same identity, so the credential's subject is the only thing specific to this repo. Renaming the repo breaks it.
- That identity added as a member (role Contributor or higher) of the `AndrewBenz` publisher at <https://marketplace.visualstudio.com/manage/publishers/AndrewBenz>.

To check all three without publishing anything, run the **Marketplace check** workflow (`.github/workflows/marketplace-check.yml`) from the Actions tab.
