import { describe, expect, it } from 'vitest';
import type { ChangeKind, FileChange } from '../../src/shared/branchProtocol';
import {
  allDirs,
  buildTree,
  compileQuery,
  filterFiles,
  globToRegex,
  listRows,
  splitTerms,
  treeRows,
} from '../../webview/fileFilter';

function file(path: string, kind: ChangeKind = 'modified', extra: Partial<FileChange> = {}): FileChange {
  return { path, kind, status: kind === 'added' ? 'A' : kind === 'deleted' ? 'D' : kind.startsWith('renamed') ? 'R' : 'M', added: 1, deleted: 1, ...extra };
}

const paths = (q: string, files: FileChange[], o = { matchCase: false, regex: false }) => {
  const c = compileQuery(q, o);
  return files.filter((f) => c.test(f)).map((f) => f.path);
};

const FILES = [
  file('src/app.ts'),
  file('src/app.test.ts'),
  file('src/core/Parser.tsx'),
  file('packages/web/src/index.ts'),
  file('docs/README.md'),
  file('package-lock.json'),
  file('lib/new/place.js', 'renamed', { oldPath: 'lib/old/place.js' }),
];

describe('globToRegex', () => {
  it('keeps * and ? within a folder and lets ** cross folders', () => {
    expect(globToRegex('*.ts', false).test('src/app.ts')).toBe(true);
    expect(globToRegex('src/*.ts', false).test('src/core/a.ts')).toBe(false);
    expect(globToRegex('src/**/*.ts', false).test('src/a.ts')).toBe(true);
    expect(globToRegex('src/**/*.ts', false).test('src/core/deep/a.ts')).toBe(true);
    expect(globToRegex('a?.md', false).test('ab.md')).toBe(true);
    expect(globToRegex('a?.md', false).test('a/.md')).toBe(false);
  });

  it('supports braces, classes, folder boundaries, root anchors and trailing slashes', () => {
    expect(globToRegex('*.{ts,tsx}', false).test('x/y.tsx')).toBe(true);
    expect(globToRegex('[ab].js', false).test('b.js')).toBe(true);
    expect(globToRegex('[!ab].js', false).test('b.js')).toBe(false);
    expect(globToRegex('src/*.ts', false).test('packages/web/src/index.ts')).toBe(true);
    expect(globToRegex('src/*.ts', false).test('mysrc/index.ts')).toBe(false);
    expect(globToRegex('/src/*.ts', false).test('packages/web/src/index.ts')).toBe(false);
    expect(globToRegex('docs/', false).test('docs/a/b.md')).toBe(true);
    expect(globToRegex('*.TS', true).test('a.ts')).toBe(false);
  });
});

describe('compileQuery', () => {
  it('matches plain text anywhere in the path, ignoring case by default', () => {
    expect(paths('parser', FILES)).toEqual(['src/core/Parser.tsx']);
    expect(paths('parser', FILES, { matchCase: true, regex: false })).toEqual([]);
  });

  it('needs every term to match and drops files matching a !term', () => {
    // Plain text is a substring, so .ts also finds .tsx.
    expect(paths('src .ts', FILES)).toEqual(['src/app.ts', 'src/app.test.ts', 'src/core/Parser.tsx', 'packages/web/src/index.ts']);
    expect(paths('*.ts !*.test.ts', FILES)).toEqual(['src/app.ts', 'packages/web/src/index.ts']);
    expect(paths('-*.json -docs/', FILES)).toHaveLength(5);
    expect(paths('*.ts,*.md', FILES)).toEqual(['src/app.ts', 'src/app.test.ts', 'packages/web/src/index.ts', 'docs/README.md']);
  });

  it('matches renamed files by their old path too', () => {
    expect(paths('lib/old', FILES)).toEqual(['lib/new/place.js']);
    expect(paths('!old/', FILES)).not.toContain('lib/new/place.js');
  });

  it('keeps quoted phrases together', () => {
    expect(splitTerms('a "b c" !"d e"')).toEqual(['a', 'b c', '!d e']);
  });

  it('treats the whole query as one regular expression in regex mode and reports bad ones', () => {
    expect(paths('^src/.*\\.tsx?$', FILES, { matchCase: false, regex: true })).toEqual(['src/app.ts', 'src/app.test.ts', 'src/core/Parser.tsx']);
    const bad = compileQuery('src/(', { matchCase: false, regex: true });
    expect(bad.error).toBeTruthy();
    expect(bad.test(FILES[0])).toBe(true);
  });
});

describe('filterFiles', () => {
  it('counts each kind among the files the query matches, then hides the unwanted kinds', () => {
    const files = [file('a.ts', 'renamed'), file('b.ts', 'renamed'), file('c.ts'), file('d.md', 'added'), file('e.ts', 'whitespace')];
    const r = filterFiles(files, compileQuery('*.ts', { matchCase: false, regex: false }), new Set(['renamed', 'whitespace']));
    expect(r.shown.map((f) => f.path)).toEqual(['c.ts']);
    expect(r.matched).toBe(4);
    expect(r.counts).toMatchObject({ renamed: 2, modified: 1, whitespace: 1, added: 0 });
  });
});

describe('trees', () => {
  const files = [
    file('src/core/parse/a.ts', 'modified', { added: 3, deleted: 1 }),
    file('src/core/parse/b.ts', 'modified', { added: 10, deleted: 0 }),
    file('src/main.ts'),
    file('README.md'),
  ];

  it('compacts folders that only hold one folder and adds up their changes', () => {
    const root = buildTree(files);
    expect(root.dirs.map((d) => d.name)).toEqual(['src']);
    const src = root.dirs[0];
    expect(src.dirs.map((d) => [d.name, d.path])).toEqual([['core/parse', 'src/core/parse']]);
    expect(src).toMatchObject({ fileCount: 3, added: 14, deleted: 2 });
    expect(allDirs(root)).toEqual(['src', 'src/core/parse']);
  });

  it('lists folders before files, and hides what is inside collapsed folders', () => {
    const root = buildTree(files);
    const rows = treeRows(root, new Set(), 'path');
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.type === 'dir' ? r.dir!.name + '/' : r.file!.path}`)).toEqual([
      'src/',
      '  core/parse/',
      '    src/core/parse/a.ts',
      '    src/core/parse/b.ts',
      '  src/main.ts',
      'README.md',
    ]);
    expect(treeRows(root, new Set(['src/core/parse']), 'size').map((r) => r.key)).toEqual(['dir:src', 'dir:src/core/parse', 'src/main.ts', 'README.md']);
    expect(treeRows(root, new Set(), 'size').map((r) => r.key).slice(2, 4)).toEqual(['src/core/parse/b.ts', 'src/core/parse/a.ts']);
  });

  it('sorts a flat list by path, size or kind', () => {
    const mixed = [file('b.ts', 'added', { added: 1, deleted: 0 }), file('a.ts', 'modified', { added: 50, deleted: 2 }), file('c.ts', 'deleted', { added: 0, deleted: 9 })];
    expect(listRows(mixed, 'path').map((r) => r.key)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(listRows(mixed, 'size').map((r) => r.key)).toEqual(['a.ts', 'c.ts', 'b.ts']);
    expect(listRows(mixed, 'kind').map((r) => r.key)).toEqual(['b.ts', 'a.ts', 'c.ts']);
  });
});
