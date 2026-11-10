import * as fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { BranchHistory } from '../../src/branchHistory';
import { STAGED_ID, WORKING_ID } from '../../src/shared/protocol';
import { TestRepo } from './gitRepo';

let repos: TestRepo[] = [];
let histories: BranchHistory[] = [];

afterEach(() => {
  histories.forEach((h) => h.dispose());
  repos.forEach((r) => r.dispose());
  histories = [];
  repos = [];
});

/** main → feature-a → feature-b (checked out), with `n` commits on feature-b. */
function setup(n = 3) {
  const r = new TestRepo();
  repos.push(r);
  const c: Record<string, string> = {};
  const step = (name: string, file = `${name}.txt`) => {
    r.write(file, `${name}\n`);
    c[name] = r.commit(name);
  };
  step('m1');
  step('m2');
  r.git('checkout', '-q', '-b', 'feature-a');
  step('a1');
  r.git('checkout', '-q', '-b', 'feature-b');
  for (let i = 1; i <= n; i++) step(`b${i}`, 'b.txt');
  return { r, c };
}

async function open(r: TestRepo, branch?: string, baseSha?: string, pageSize = 50) {
  const h = await BranchHistory.open({ git: 'git', root: r.root, pageSize, maxBytes: 1 << 20 }, branch, baseSha);
  histories.push(h);
  return h;
}

describe('BranchHistory', () => {
  it('opens the checked-out branch from its nearest base, and can go up a level', async () => {
    const { r, c } = setup();
    const h = await open(r);
    expect(h.branch).toMatchObject({ ref: 'refs/heads/feature-b', name: 'feature-b', head: true, sha: c.b3 });
    expect(h.levels.map((l) => l.branches[0])).toEqual(['feature-a', 'main']);
    expect(h.base).toMatchObject({ sha: c.a1, forkOf: ['feature-a'] });
    expect(h.commits.map((s) => s.subject)).toEqual(['b1', 'b2', 'b3']);
    expect(h.specials()).toEqual([]);

    await h.setLevel(1);
    expect(h.base?.sha).toBe(c.m2);
    // The old base is now a commit on the line, still marked as a fork point.
    expect(h.commits.map((s) => s.subject)).toEqual(['a1', 'b1', 'b2', 'b3']);
    expect(h.commits[0].forkOf).toEqual(['feature-a']);

    // Reopening with that base's sha keeps the level.
    const again = await open(r, undefined, c.m2);
    expect(again.level).toBe(1);
  });

  it('pages through a long line, keeping the base on the left end', async () => {
    const { r, c } = setup(7);
    const h = await open(r, undefined, undefined, 3);
    expect(h.commits.map((s) => s.subject)).toEqual(['b5', 'b6', 'b7']);
    expect(h.hasMore).toBe(true);
    expect((await h.loadMore()).map((s) => s.subject)).toEqual(['b2', 'b3', 'b4']);
    await h.loadMore();
    expect(h.commits.map((s) => s.subject)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']);
    expect(h.hasMore).toBe(false);
    expect(h.stops()[0].sha).toBe(c.a1);
  });

  it('shows the default branch as plain history, and other branches without a working copy', async () => {
    const { r, c } = setup();
    const main = await open(r, 'refs/heads/main');
    expect(main.levels).toEqual([]);
    expect(main.level).toBe(-1);
    expect(main.base).toBeUndefined();
    expect(main.commits.map((s) => s.sha)).toEqual([c.m1, c.m2]);
    expect(main.branch.head).toBe(false);

    r.write('dirty.txt', 'x');
    expect((await open(r, 'refs/heads/feature-a')).specials()).toEqual([]);
  });

  it('adds staged and working copy stops when they differ, and reads files at every kind of stop', async () => {
    const { r, c } = setup();
    r.write('b.txt', 'staged\n');
    r.git('add', 'b.txt');
    r.write('b.txt', 'working\n');
    const h = await open(r);
    expect(h.specials().map((s) => s.id)).toEqual([STAGED_ID, WORKING_ID]);
    const text = async (id: string) => (await h.content(1, id, 'b.txt')).text;
    expect(await text(c.b1)).toBe('b1\n');
    expect(await text(STAGED_ID)).toBe('staged\n');
    expect(await text(WORKING_ID)).toBe('working\n');
    expect(await h.content(1, c.m1, 'b.txt')).toMatchObject({ missing: true });

    const files = await h.diff(c.a1, WORKING_ID);
    expect(files.find((f) => f.path === 'b.txt')).toMatchObject({ kind: 'added', status: 'A' });

    // Finding the commits a file history should start from.
    expect(await h.lastChange(c.b3, 'b.txt')).toBe(c.b3);
    expect(await h.lastChange(c.m2, 'b.txt')).toBeUndefined();
    expect(await h.firstChangeAfter(c.a1, c.b3, 'b.txt')).toBe(c.b1);
  });

  it('notices commits and working tree changes through its signature', async () => {
    const { r } = setup();
    const h = await open(r);
    expect(await h.signature()).toBe(h.currentSignature());
    r.write('new.txt', 'x');
    expect(await h.signature()).not.toBe(h.currentSignature());
    await h.refreshStatus();
    expect(await h.signature()).toBe(h.currentSignature());
    r.commit('b4');
    expect(await h.signature()).not.toBe(h.currentSignature());
  });

  it('explains an empty repository', async () => {
    const r = new TestRepo();
    repos.push(r);
    fs.writeFileSync(r.path('a.txt'), 'x');
    await expect(BranchHistory.open({ git: 'git', root: r.root, pageSize: 50, maxBytes: 1 << 20 })).rejects.toThrow(/no commits yet/);
  });
});
