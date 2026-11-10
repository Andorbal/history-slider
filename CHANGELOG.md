# Changelog

## 0.4.0

- **Branch History Slider**: a slider over a whole branch, from where it was branched to its newest commit (and the working copy), showing every file that changed between the two handles. Run **History Slider: Show Branch History Slider**, use the branch button in the Source Control view, or press `Ctrl+Alt+Shift+H` (`⌃⇧⌘H` on macOS).
  - Go up the tree for stacked branches: start the slider from where the parent branch was branched instead, and back.
  - Filter the files by kind of change (added, modified, deleted, pure renames, renamed and edited, copied, whitespace only, mode only), with **Content changes only** to hide everything that leaves the lines as they were, and by name with globs, exclusions or a regular expression.
  - Click a file to see its diff beside the list, locked to the slider and followed through renames, with the commits that changed it marked on the timeline. Or open it in its own History Slider, starting on the same commits.
- A file's History Slider can show another branch's history, without a working copy. The branch view uses this when you open a file from a branch that isn't checked out.

## 0.3.0

- Published on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AndrewBenz.history-slider), so VS Code installs and updates it for you.
- Renamed from Diff Slider to **History Slider**, since it shows a file's history rather than a single diff. The extension ID is now `AndrewBenz.history-slider`, so VS Code treats it as a new extension: uninstall Diff Slider after installing it. Settings moved from `diffSlider.*` to `historySlider.*` and the command from `diffSlider.showHistory` to `historySlider.showHistory`. Copy over any settings or keybindings you changed.

## 0.2.1

- Fixed the **Content changes only** checkbox doing nothing, and clicking it failing with "diffSlider.contentChangesOnly is not a registered configuration", after the extension was reinstalled over the same version while VS Code was open. VS Code keeps running the previous build until the window is reloaded, but a panel opened in the meantime loads the new one. The panel now notices this and asks you to reload the window, and it disables any control the running build can't save instead of failing.
- Toggling **Content changes only** when no loaded commit is a pure rename, mode change or line-ending conversion now says there is nothing to hide, instead of seeming to do nothing.
- The commit card shows **renamed from …**, **file added**, **file deleted** and **merge commit** again. A style meant for the panel's loading and error messages was hiding them.
- Making the panel narrower, for example by opening the file beside it, keeps the newest end of the timeline and its handles in view instead of jumping to the oldest commits.
- The dates along the timeline follow when each commit landed (its commit date) rather than when it was written, so they no longer jump back and forth in histories with merged or rebased branches.
- The README, which is also the extension's page in VS Code, shows the slider in action.

## 0.2.0

- Commits that don't change what the diff shows (renaming the file, changing its mode, or converting its line endings) are hidden from the timeline. Uncheck **Content changes only** in the toolbar, or set `diffSlider.contentChangesOnly` to `false`, to show them.
- A commit that only converts line endings shows no changed lines on the timeline and commit card, matching the diff.

## 0.1.0

First release.

- A timeline of the commits that changed a file, with the working copy (and staged changes) at the right end.
- Two independent handles select the two sides of the diff; the leftmost one is always the old side. The diff updates live while dragging.
- A commit card follows the handle (message, author, date, line counts, tags) and has actions to show that commit's change, open the file at that revision, or copy the SHA.
- Change-size histogram, tag markers and date labels on the timeline.
- Loads older history on demand: drag to the left end, or click **Older** (Shift+click loads everything).
- Follows renames, includes merge commits (diffed against the first parent), and has an optional first-parent-only mode.
- The working copy side updates as you type; the panel refreshes after commits and staging.
- Keyboard control, including stepping both handles through history together.
- Side-by-side/inline, ignore whitespace, collapse unchanged regions and word wrap toggles; moved-code detection.
- Opens the current comparison in VS Code's diff editor.
- Available from the editor title bar, Explorer, editor tabs, Source Control and Timeline context menus, and `Ctrl+Alt+H` / `⌃⌘H`.
- Panels are restored after a window reload.
