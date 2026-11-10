import { expect, test, type Page } from '@playwright/test';
import type { BranchPanelState, BranchWebviewMessage } from '../../src/shared/branchProtocol';
import { WORKING_ID } from '../../src/shared/protocol';
import { buildBranchFixture } from './branchFixture';
import { startHarness, type Scenario } from './harness';

let harness: Awaited<ReturnType<typeof startHarness>>;

test.beforeAll(async () => {
  harness = await startHarness();
});

test.afterAll(async () => {
  await harness.close();
});

const fx = buildBranchFixture();
const base = fx.init.base!;
const commits = fx.init.commits; // b1..b12
const tip = commits[commits.length - 1];
// Timeline: base, b1..b12, working copy.
const at = (i: number) => (i === 0 ? base.id : i === 13 ? WORKING_ID : commits[i - 1].id);

interface Debug {
  selection(): [string, string];
  ordered(): [string, string];
  shownFiles(): string[];
  selectedPath(): string | undefined;
  sides(): { oldPath?: string; newPath?: string };
  original(): string | undefined;
  modified(): string | undefined;
  stopCount(): number;
  stopIds(): string[];
}

async function open(page: Page, scenario: Scenario = {}): Promise<string[]> {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(harness.url({ view: 'branch', ...scenario }));
  if (!scenario.error) await expect(page.locator('.app')).toHaveClass(/state-ready/);
  return problems;
}

const debug = <T,>(page: Page, fn: (d: Debug) => T) =>
  page.evaluate((src) => {
    const d = (window as unknown as { __historySlider: Debug }).__historySlider;
    return new Function('d', `return (${src})(d)`)(d);
  }, fn.toString()) as Promise<T>;

const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: BranchWebviewMessage[] }).__sent);

async function settled(page: Page) {
  await expect(page.locator('.stats')).not.toContainText('comparing');
}

async function tickCenter(page: Page, index: number) {
  const box = (await page.locator('.tl-tick').nth(index).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: Page, handle: 'old' | 'new', index: number, opts: { release?: boolean } = {}) {
  const knob = page.locator(`.tl-handle.is-${handle} .tl-handle-knob`);
  const from = (await knob.boundingBox())!;
  const to = await tickCenter(page, index);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(start.x + ((to.x - start.x) * i) / 10, start.y);
  if (opts.release !== false) await page.mouse.up();
}

const row = (page: Page, name: string) => page.locator('.fl-row.file').filter({ has: page.locator('.fl-name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) });
const chip = (page: Page, kind: string) => page.locator(`.chip[data-kind="${kind}"]`);

test('opens on the whole branch: from where it was branched to its newest commit', async ({ page }) => {
  const problems = await open(page);
  await settled(page);
  expect(await debug(page, (d) => d.ordered())).toEqual([base.id, tip.id]);
  // main › feature-a (the base, highlighted) › feature-b
  await expect(page.locator('.chain .level')).toHaveText(['main', 'feature-a']);
  await expect(page.locator('.chain .level.active')).toHaveText('feature-a');
  await expect(page.locator('.branch-name')).toHaveText('feature-b');
  await expect(page.locator('.file-count')).toHaveText('12 commits since feature-a');
  await expect(page.locator('.tl-tick')).toHaveCount(14);
  await expect(page.locator('.tl-more')).toHaveText(/main/);
  await expect(page.locator('.side.old')).toContainText('feature-a');
  await expect(page.locator('.stats')).toContainText('48 files');
  await expect(page.locator('.stats')).toContainText('12 commits');
  await expect(chip(page, 'renamed')).toContainText('Renamed37');
  await expect(chip(page, 'renamedModified')).toContainText('3');
  await expect(chip(page, 'whitespace')).toContainText('2');
  await expect(chip(page, 'mode')).toContainText('1');
  await expect(page.locator('.files-count')).toHaveText('48 files');
  await expect(page.locator('.pane-empty')).toBeVisible();
  // The list only renders the rows in view; the rest come in as it scrolls.
  expect(await page.locator('.fl-row').count()).toBeLessThan(48);
  await page.locator('.file-list').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(row(page, 'legacy.ts').locator('.fl-badge')).toHaveText('D');
  await expect(row(page, 'build.sh')).toContainText('+x');
  await expect(row(page, 'strings.ts')).toContainText('← src/util/strings.ts');
  expect(problems).toEqual([]);
});

test('renames and other changes that leave the lines alone can be filtered out', async ({ page }) => {
  const problems = await open(page);
  await settled(page);
  await chip(page, 'renamed').click();
  await expect(chip(page, 'renamed')).toHaveClass(/off/);
  await expect(page.locator('.files-count')).toContainText('11 of 48 files');
  expect(await debug(page, (d) => d.shownFiles())).not.toContain('packages/core/src/mod00.ts');
  // "Content changes only" also hides whitespace-only and mode-only changes.
  await page.locator('label.check').click();
  await expect(chip(page, 'whitespace')).toHaveClass(/off/);
  await expect(chip(page, 'mode')).toHaveClass(/off/);
  const shown = await debug(page, (d) => d.shownFiles());
  expect(shown.sort()).toEqual(
    [
      'docs/guide.md',
      'package.json',
      'packages/core/src/index.ts',
      'packages/core/src/mod03.ts',
      'packages/core/src/mod05.ts',
      'packages/core/src/strings.ts',
      'packages/core/test/a.test.ts',
      'src/legacy.ts',
    ].sort(),
  );
  // Alt+click shows only one kind; doing it again shows everything.
  await chip(page, 'added').click({ modifiers: ['Alt'] });
  expect((await debug(page, (d) => d.shownFiles())).sort()).toEqual(['packages/core/src/index.ts', 'packages/core/test/a.test.ts']);
  await chip(page, 'added').click({ modifiers: ['Alt'] });
  await expect(page.locator('.files-count')).toHaveText('48 files');
  await expect.poll(async () => (await sent(page)).filter((m) => m.type === 'saveFilters').length).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});

test('the filter box takes globs, exclusions and regular expressions', async ({ page }) => {
  await open(page);
  await settled(page);
  const query = page.locator('input.query');
  await query.fill('*.md');
  await expect.poll(() => debug(page, (d) => d.shownFiles().sort())).toEqual(['README.md', 'docs/guide.md']);
  await query.fill('packages/ !*.test.ts !mod');
  await expect.poll(() => debug(page, (d) => d.shownFiles().sort())).toEqual(['packages/core/src/index.ts', 'packages/core/src/strings.ts']);
  // Renamed files match by their old path too.
  await query.fill('src/util');
  await expect.poll(() => debug(page, (d) => d.shownFiles())).toEqual(['packages/core/src/strings.ts']);
  // The chips count what the text matches.
  await query.fill('mod0');
  await expect(chip(page, 'renamed')).toContainText('7');
  await page.locator('[data-filter="regex"]').click();
  await query.fill('mod0[35]\\.ts$');
  await expect.poll(() => debug(page, (d) => d.shownFiles().sort())).toEqual(['packages/core/src/mod03.ts', 'packages/core/src/mod05.ts']);
  await query.fill('mod(');
  await expect(query).toHaveClass(/invalid/);
  // Escape clears it.
  await query.press('Escape');
  await expect(query).toHaveValue('');
  await expect(page.locator('.files-count')).toHaveText('48 files');
});

test('a file opens beside the list and follows the slider, through renames', async ({ page }) => {
  const problems = await open(page);
  await settled(page);
  await row(page, 'mod03.ts').click();
  await expect(page.locator('.pane-name')).toHaveText('mod03.ts');
  await expect(page.locator('.pane-head')).toContainText('changed in 4 commits');
  // b1 (the move), b2, b7 and b11 changed it; they are pointed out on the timeline.
  await expect(page.locator('.tl-tick.mark')).toHaveCount(4);
  await expect.poll(() => debug(page, (d) => d.original())).toContain('version = 0');
  await expect.poll(() => debug(page, (d) => d.modified())).toContain('version = 3');
  expect(await debug(page, (d) => d.sides())).toMatchObject({ oldPath: 'src/mod03.ts', newPath: 'packages/core/src/mod03.ts' });

  // Locked to the slider: drag the new handle back to b2, after one edit.
  await drag(page, 'new', 2);
  await settled(page);
  await expect.poll(() => debug(page, (d) => d.modified())).toContain('version = 1');
  // The edit is to one of the 40 moved files, so it is a rename with edits now.
  await expect(page.locator('.stats')).toContainText('40 files');
  await expect(chip(page, 'renamedModified')).toContainText('1');
  // Back to before the move: the file is under its old name on both sides, unchanged.
  await drag(page, 'old', 1);
  await drag(page, 'new', 0);
  await settled(page);
  await expect.poll(() => debug(page, (d) => d.sides())).toMatchObject({ oldPath: 'src/mod03.ts', newPath: 'packages/core/src/mod03.ts' });
  expect(problems).toEqual([]);
});

test('steps through the commits that changed the selected file', async ({ page }) => {
  await open(page);
  await settled(page);
  await row(page, 'mod03.ts').click();
  await expect(page.locator('.tl-tick.mark')).toHaveCount(4);
  // From the whole range, "previous" goes to the newest change to the file (b11)...
  await page.locator('[data-cmd="prevTouch"]').click();
  expect(await debug(page, (d) => d.ordered())).toEqual([at(10), at(11)]);
  await expect.poll(() => debug(page, (d) => d.modified())).toContain('version = 3');
  // ...then the one before it (b7), with the keyboard.
  await page.locator('body').press('{');
  expect(await debug(page, (d) => d.ordered())).toEqual([at(6), at(7)]);
  await page.locator('body').press('}');
  expect(await debug(page, (d) => d.ordered())).toEqual([at(10), at(11)]);
  await expect(page.locator('[data-cmd="nextTouch"]')).toBeDisabled();
});

test('the arrow keys and , . move through the files', async ({ page }) => {
  await open(page);
  await settled(page);
  await page.locator('body').press('.');
  await expect.poll(() => debug(page, (d) => d.selectedPath())).toBe('docs/guide.md');
  await page.locator('body').press('.');
  await expect.poll(() => debug(page, (d) => d.selectedPath())).toBe('packages/core/src/index.ts');
  await page.locator('.file-list').focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => debug(page, (d) => d.selectedPath())).toBe('packages/core/src/mod00.ts');
  // Collapsing the folder with the keyboard.
  await page.keyboard.press('ArrowLeft'); // to the folder
  await page.keyboard.press('ArrowLeft'); // collapse it
  await expect(row(page, 'mod00.ts')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'mod00.ts')).toHaveCount(1);
  // "/" jumps to the filter box.
  await page.locator('body').press('/');
  await expect(page.locator('input.query')).toBeFocused();
});

test('going up the tree starts the slider where the parent branch was branched', async ({ page }) => {
  const problems = await open(page);
  await settled(page);
  await row(page, 'mod01.ts').click();
  await page.locator('.tl-more').click();
  await expect(page.locator('.chain .level.active')).toHaveText('main');
  await expect(page.locator('.tl-tick')).toHaveCount(22);
  expect((await sent(page)).find((m) => m.type === 'setLevel')).toEqual({ type: 'setLevel', level: 1, selection: [fx.upper.base.id, tip.id] });
  expect(await debug(page, (d) => d.ordered())).toEqual([fx.upper.base.id, tip.id]);
  await settled(page);
  // feature-a's own changes are part of the comparison now.
  await expect(page.locator('.stats')).toContainText('48 files');
  await expect(row(page, 'guide.md').locator('.fl-badge')).toHaveText('A');
  // The selected file stays, and its track covers feature-a's commits too.
  await expect(page.locator('.pane-name')).toHaveText('mod01.ts');
  await expect(page.locator('.tl-tick.mark')).toHaveCount(3);
  // Nothing further up, and the base where feature-b met feature-a is marked inside the range.
  await expect(page.locator('.tl-more')).toBeHidden();
  await expect(page.locator('.tl-tick.fork')).toHaveCount(2);
  // Back down by clicking feature-a in the chain (or Shift+U).
  await page.locator('.chain .level', { hasText: 'feature-a' }).click();
  await expect(page.locator('.chain .level.active')).toHaveText('feature-a');
  await expect(page.locator('.tl-tick')).toHaveCount(14);
  expect(await debug(page, (d) => d.ordered())).toEqual([base.id, tip.id]);
  await page.locator('body').press('u');
  await expect(page.locator('.chain .level.active')).toHaveText('main');
  expect(problems).toEqual([]);
});

test('picking another branch resets the slider, the file and the base', async ({ page }) => {
  await open(page);
  await settled(page);
  await row(page, 'mod03.ts').click();
  await drag(page, 'old', 4);
  await page.locator('.branch-pick').click();
  expect((await sent(page)).filter((m) => m.type === 'pickBranch')).toHaveLength(1);
  await expect(page.locator('.branch-name')).toHaveText('feature-a');
  await expect(page.locator('.chain .level')).toHaveText(['main']);
  const other = fx.other;
  expect(await debug(page, (d) => d.ordered())).toEqual([other.base!.id, other.commits[other.commits.length - 1].id]);
  await expect(page.locator('.pane-empty')).toBeVisible();
  await expect(page.locator('.tl-tick.mark')).toHaveCount(0);
  await expect(page.locator('.tl-tick')).toHaveCount(9);
});

test('opens a file in its own History Slider or the diff editor, starting from these handles', async ({ page }) => {
  await open(page);
  await settled(page);
  const r = row(page, 'mod03.ts');
  await r.hover();
  await r.locator('[data-row-action="history"]').click();
  expect((await sent(page)).find((m) => m.type === 'openFileHistory')).toEqual({
    type: 'openFileHistory',
    oldId: base.id,
    newId: tip.id,
    oldPath: 'src/mod03.ts',
    newPath: 'packages/core/src/mod03.ts',
  });
  await r.locator('[data-row-action="diff"]').click();
  expect((await sent(page)).find((m) => m.type === 'openDiff')).toMatchObject({ oldPath: 'src/mod03.ts', newPath: 'packages/core/src/mod03.ts' });
  // A new file has no old side; double-click opens it too.
  await row(page, 'index.ts').dblclick();
  expect((await sent(page)).filter((m) => m.type === 'openFileHistory')[1]).toMatchObject({ oldPath: undefined, newPath: 'packages/core/src/index.ts' });
});

test('the working copy is the last stop, untracked files included', async ({ page }) => {
  await open(page);
  await settled(page);
  await drag(page, 'new', 13);
  await settled(page);
  expect(await debug(page, (d) => d.ordered())).toEqual([base.id, WORKING_ID]);
  await page.locator('input.query').fill('notes');
  await expect(row(page, 'notes.txt').locator('.fl-badge')).toHaveText('U');
  await expect(row(page, 'notes.txt')).toContainText('untracked');
  await page.locator('input.query').fill('index');
  await row(page, 'index.ts').click();
  await expect.poll(() => debug(page, (d) => d.modified())).toContain('version = 1');
  // R resets to the whole branch.
  await page.locator('body').press('r');
  expect(await debug(page, (d) => d.ordered())).toEqual([base.id, tip.id]);
});

test('remembers the handles, the base, the file and the filters', async ({ page }) => {
  await open(page);
  await settled(page);
  await drag(page, 'old', 3);
  await row(page, 'package.json').click();
  await page.locator('input.query').fill('json');
  await expect.poll(() => debug(page, (d) => d.shownFiles())).toEqual(['package.json']);
  const state = (await page.evaluate(() => (window as unknown as { __host: { state(): unknown } }).__host.state())) as BranchPanelState;
  expect(state).toMatchObject({
    view: 'branch',
    resource: 'file:///repo',
    branch: 'refs/heads/feature-b',
    baseSha: base.id,
    selection: [at(3), tip.id],
    selectedPath: 'package.json',
    filters: { query: 'json' },
  });
});

test('errors offer a retry and a way to pick another branch', async ({ page }) => {
  await open(page, { error: 'Branch refs/heads/gone no longer exists.' });
  await expect(page.locator('.status')).toContainText('no longer exists');
  await page.locator('.status [data-cmd="pickBranch"]').click();
  expect((await sent(page)).filter((m) => m.type === 'pickBranch')).toHaveLength(1);
});

test('the list keeps up while a handle is dragged, asking for one diff at a time', async ({ page }) => {
  await open(page, { diffDelay: 120 });
  await settled(page);
  await drag(page, 'new', 1, { release: false });
  await page.mouse.up();
  await settled(page);
  expect(await debug(page, (d) => d.ordered())).toEqual([base.id, at(1)]);
  // b1 only moved files.
  await expect(page.locator('.files-count')).toHaveText('40 files');
  await expect(chip(page, 'renamed')).toContainText('40');
  // The drag passed 11 stops, but slow diffs were not all asked for.
  const diffs = (await sent(page)).filter((m) => m.type === 'getDiff');
  expect(diffs.length).toBeLessThan(8);
});
