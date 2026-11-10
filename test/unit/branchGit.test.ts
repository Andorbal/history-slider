import * as fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkingIndex,
  commitStop,
  defaultRefs,
  fileTrack,
  findBaseLevels,
  listRefs,
  listRemotes,
  logRange,
  readHead,
  repoDiff,
  workingStatus,
  type DiffSide,
} from '../../src/branchGit';
import type { FileChange } from '../../src/shared/branchProtocol';
import { TestRepo } from './gitRepo';

const GIT = 'git';
let repos: TestRepo[] = [];
let indexes: WorkingIndex[] = [];

function repo(): TestRepo {
  const r = new TestRepo();
  repos.push(r);
  return r;
}

afterEach(() => {
  indexes.forEach((i) => i.dispose());
  repos.forEach((r) => r.dispose());
  repos = [];
  indexes = [];
});

/** Builds main → feature-a → feature-b, the usual stack of PRs. Returns the shas by name. */
function stacked(r: TestRepo) {
  const c: Record<string, string> = {};
  const step = (name: string) => {
    r.write(`${name}.txt`, `${name}\n`);
    c[name] = r.commit(name);
  };
  step('m1');
  step('m2');
  r.git('checkout', '-q', '-b', 'feature-a');
  step('a1');
  step('a2');
  r.git('checkout', '-q', '-b', 'feature-b');
  step('b1');
  step('b2');
  r.git('checkout', '-q', 'main');
  step('m3');
  return c;
}

async function levelsOf(r: TestRepo, ref: string) {
  const refs = await listRefs(GIT, r.root);
  const remotes = await listRemotes(GIT, r.root);
  const target = refs.find((x) => x.ref === ref)!;
  return findBaseLevels(GIT, r.root, target, refs, remotes);
}

describe('findBaseLevels', () => {
  it('finds where a branch was branched, and where that branch was branched', async () => {
    const r = repo();
    const c = stacked(r);
    const levels = await levelsOf(r, 'refs/heads/feature-b');
    expect(levels.map((l) => [l.sha, l.branches])).toEqual([
      [c.a2, ['feature-a']],
      [c.m2, ['main']],
    ]);
    expect(levels.map((l) => l.distance)).toEqual([2, 4]);
  });

  it('keeps the base where it was when the parent branch moves on', async () => {
    const r = repo();
    const c = stacked(r);
    r.git('checkout', '-q', 'feature-a');
    r.write('a3.txt', 'a3\n');
    r.commit('a3: review fixes');
    const levels = await levelsOf(r, 'refs/heads/feature-b');
    expect(levels.map((l) => l.sha)).toEqual([c.a2, c.m2]);
  });

  it('does not mistake a branch stacked on top for the base', async () => {
    const r = repo();
    const c = stacked(r);
    // feature-a gets more commits after feature-b was started from it: topologically
    // the two look alike, but feature-a's reflog says it started at m2.
    r.git('checkout', '-q', 'feature-a');
    r.write('a3.txt', 'a3\n');
    r.commit('a3');
    const levels = await levelsOf(r, 'refs/heads/feature-a');
    expect(levels.map((l) => [l.sha, l.branches])).toEqual([[c.m2, ['main']]]);
  });

  it('ignores a branch stacked right on the tip', async () => {
    const r = repo();
    const c = stacked(r);
    r.git('branch', 'on-top', 'feature-b');
    expect((await levelsOf(r, 'refs/heads/feature-b')).map((l) => l.sha)).toEqual([c.a2, c.m2]);
  });

  it('gives the default branch no base', async () => {
    const r = repo();
    stacked(r);
    expect(await levelsOf(r, 'refs/heads/main')).toEqual([]);
  });

  it('skips the branch’s own remote copy and prefers the default branch’s name', async () => {
    const r = repo();
    const c = stacked(r);
    // A pushed feature-b that is behind the local one, and origin/main with origin/HEAD.
    r.git('update-ref', 'refs/remotes/origin/feature-b', c.b1);
    r.git('update-ref', 'refs/remotes/origin/main', c.m2);
    r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    r.git('update-ref', 'refs/remotes/origin/feature-a', c.a2);
    const refs = await listRefs(GIT, r.root);
    const remotes = ['origin'];
    expect([...defaultRefs(refs, remotes)].sort()).toEqual(['refs/heads/main', 'refs/remotes/origin/main']);
    const target = refs.find((x) => x.ref === 'refs/heads/feature-b')!;
    const levels = await findBaseLevels(GIT, r.root, target, refs, remotes);
    // feature-a and origin/feature-a are the same branch; main comes before origin/main.
    expect(levels.map((l) => [l.sha, l.branches])).toEqual([
      [c.a2, ['feature-a']],
      [c.m2, ['main']],
    ]);
  });

  it('finds the base of a branch created from origin/main with that as its upstream', async () => {
    const r = repo();
    const c = stacked(r);
    r.git('remote', 'add', 'origin', 'https://example.invalid/repo.git');
    r.git('update-ref', 'refs/remotes/origin/main', c.m2);
    r.git('checkout', '-q', '--detach');
    r.git('branch', '-D', 'main');
    r.git('checkout', '-q', '-b', 'topic', '--track', 'origin/main');
    r.write('t.txt', 't\n');
    r.commit('t1');
    const levels = await levelsOf(r, 'refs/heads/topic');
    expect(levels[0]).toMatchObject({ sha: c.m2 });
    expect(levels[0].branches).toContain('origin/main');
  });
});

describe('logRange and commitStop', () => {
  it('lists the commits after the base with totals over all files', async () => {
    const r = repo();
    const c = stacked(r);
    r.git('checkout', '-q', 'feature-b');
    r.write('b1.txt', 'b1\nmore\nlines\n');
    r.write('extra.txt', 'x\n');
    const b3 = r.commit('b3');
    const page = await logRange(GIT, r.root, { tip: b3, base: c.a2, skip: 0, limit: 50 });
    expect(page.hasMore).toBe(false);
    expect(page.stops.map((s) => s.subject)).toEqual(['b1', 'b2', 'b3']);
    expect(page.stops[2]).toMatchObject({ fileCount: 2, statusCounts: { M: 1, A: 1 }, added: 3, deleted: 0 });

    const older = await logRange(GIT, r.root, { tip: b3, base: c.m2, skip: 1, limit: 2 });
    // Pages count back from the tip: skipping b3, the next two are b2 and b1.
    expect(older.stops.map((s) => s.subject)).toEqual(['b1', 'b2']);
    expect(older.hasMore).toBe(true);

    expect(await commitStop(GIT, r.root, c.a2)).toMatchObject({ sha: c.a2, subject: 'a2', fileCount: 1, added: 1 });
  });
});

function byPath(files: FileChange[]): Record<string, Partial<FileChange>> {
  return Object.fromEntries(files.map(({ path, ...rest }) => [path, rest]));
}

describe('repoDiff', () => {
  const body = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `line ${i}${tag}`).join('\n') + '\n';

  function setup() {
    const r = repo();
    r.write('keep/pure.txt', body(20));
    r.write('edited.txt', body(20));
    r.write('ws.txt', body(20));
    r.write('renamed-ws.txt', body(20));
    r.write('mode.sh', 'echo hi\n');
    r.write('gone.txt', 'bye\n');
    r.write('modified.txt', body(5));
    const base = r.commit('base');
    fs.mkdirSync(r.path('moved'));
    r.git('mv', 'keep/pure.txt', 'moved/pure.txt');
    r.git('mv', 'edited.txt', 'moved/edited.txt');
    r.write('moved/edited.txt', body(20).replace('line 3\n', 'line three\n'));
    r.write('ws.txt', body(20).replace('line 3\n', '  line 3\n').replace('line 7\n', 'line 7  \n'));
    r.git('mv', 'renamed-ws.txt', 'renamed-ws2.txt');
    r.write('renamed-ws2.txt', body(20).replace('line 1\n', '\tline 1\n'));
    fs.chmodSync(r.path('mode.sh'), 0o755);
    r.git('rm', '-q', 'gone.txt');
    r.write('modified.txt', body(5) + 'one more\n');
    r.write('new.txt', 'new\n');
    const tip = r.commit('changes');
    const working = new WorkingIndex(GIT, r.root);
    indexes.push(working);
    return { r, base, tip, working };
  }

  it('sorts every change between two commits into one kind', async () => {
    const { r, base, tip, working } = setup();
    const files = byPath(await repoDiff(GIT, r.root, { kind: 'commit', sha: base }, { kind: 'commit', sha: tip }, working));
    expect(files['moved/pure.txt']).toMatchObject({ kind: 'renamed', status: 'R', score: 100, oldPath: 'keep/pure.txt', added: 0, deleted: 0 });
    expect(files['moved/edited.txt']).toMatchObject({ kind: 'renamedModified', status: 'R', oldPath: 'edited.txt', added: 1, deleted: 1 });
    expect(files['ws.txt']).toMatchObject({ kind: 'whitespace', status: 'M', added: 2, deleted: 2 });
    expect(files['renamed-ws2.txt']).toMatchObject({ kind: 'whitespace', status: 'R', oldPath: 'renamed-ws.txt' });
    expect(files['mode.sh']).toMatchObject({ kind: 'mode', oldMode: '100644', newMode: '100755' });
    expect(files['gone.txt']).toMatchObject({ kind: 'deleted', status: 'D', deleted: 1 });
    expect(files['modified.txt']).toMatchObject({ kind: 'modified', added: 1, deleted: 0 });
    expect(files['new.txt']).toMatchObject({ kind: 'added', status: 'A', added: 1 });
    expect(Object.keys(files)).toHaveLength(8);
  });

  it('compares with the index and the working tree, untracked files and plain renames included', async () => {
    const { r, tip, working } = setup();
    r.write('staged.txt', 'staged\n');
    r.git('add', 'staged.txt');
    fs.renameSync(r.path('moved/pure.txt'), r.path('moved/pure2.txt')); // not git mv
    r.write('untracked.txt', 'hello\n');
    r.write('modified.txt', 'rewritten\n');
    const index = r.git('ls-files', '-s');

    const commit: DiffSide = { kind: 'commit', sha: tip };
    const staged = byPath(await repoDiff(GIT, r.root, commit, { kind: 'staged' }, working));
    expect(staged).toEqual({ 'staged.txt': expect.objectContaining({ kind: 'added' }) });

    const work = byPath(await repoDiff(GIT, r.root, commit, { kind: 'working' }, working));
    expect(work['moved/pure2.txt']).toMatchObject({ kind: 'renamed', oldPath: 'moved/pure.txt', untracked: true });
    expect(work['untracked.txt']).toMatchObject({ kind: 'added', untracked: true, added: 1 });
    expect(work['staged.txt']).toMatchObject({ kind: 'added' });
    expect(work['staged.txt'].untracked).toBeUndefined();
    expect(work['modified.txt']).toMatchObject({ kind: 'modified' });

    const unstaged = byPath(await repoDiff(GIT, r.root, { kind: 'staged' }, { kind: 'working' }, working));
    expect(Object.keys(unstaged).sort()).toEqual(['modified.txt', 'moved/pure2.txt', 'untracked.txt']);

    // The real index is untouched.
    expect(r.git('ls-files', '-s')).toBe(index);
    expect(await workingStatus(GIT, r.root)).toMatchObject({ staged: true, dirty: true });
  });

  it('reports nothing for the same point on both sides', async () => {
    const { r, tip, working } = setup();
    expect(await repoDiff(GIT, r.root, { kind: 'commit', sha: tip }, { kind: 'commit', sha: tip }, working)).toEqual([]);
    expect(await workingStatus(GIT, r.root)).toMatchObject({ staged: false, dirty: false });
  });
});

describe('fileTrack', () => {
  it('follows a file back through a rename within the range', async () => {
    const r = repo();
    r.write('a.txt', 'one\ntwo\nthree\n');
    const base = r.commit('base');
    r.write('a.txt', 'one\n2\nthree\n');
    const edit = r.commit('edit');
    r.git('mv', 'a.txt', 'b.txt');
    const rename = r.commit('rename');
    r.write('other.txt', 'x');
    r.commit('unrelated');
    r.write('b.txt', 'one\n2\n3\n');
    const tip = r.commit('edit again');
    const head = await readHead(GIT, r.root);
    expect(head).toEqual({ ref: 'refs/heads/main', sha: tip });
    expect(await fileTrack(GIT, r.root, tip, base, 'b.txt')).toEqual([
      { id: edit, status: 'M', path: 'a.txt' },
      { id: rename, status: 'R', oldPath: 'a.txt', path: 'b.txt' },
      { id: tip, status: 'M', path: 'b.txt' },
    ]);
  });
});
