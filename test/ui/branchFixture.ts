/**
 * A pretend repository for the branch view's UI tests: feature-b, stacked on
 * feature-a, stacked on main. mockBranchHost.js replays the events below to
 * answer diffs, contents and file tracks.
 */
import type { BaseLevel, BranchInitPayload } from '../../src/shared/branchProtocol';
import { WORKING_ID, type Stop } from '../../src/shared/protocol';

export type FileEvent =
  | { type: 'add'; path: string; lines?: number }
  | { type: 'modify'; path: string }
  | { type: 'ws'; path: string }
  | { type: 'mode'; path: string }
  | { type: 'rename'; path: string; to: string; modify?: boolean }
  | { type: 'delete'; path: string };

export interface BranchFixture {
  init: BranchInitPayload;
  /** Every stop, oldest first, as they line up once the base is main. */
  order: string[];
  /** Files at the oldest stop (main's fork point). */
  initial: string[];
  /** File events by stop id. */
  events: Record<string, FileEvent[]>;
  /** What the panel shows with main as the base. */
  upper: { base: Stop; commits: Stop[] };
  /** Another branch, for testing that picking one resets everything. */
  other: BranchInitPayload;
}

const MODS = Array.from({ length: 40 }, (_, i) => `src/mod${String(i).padStart(2, '0')}.ts`);
const moved = (p: string) => p.replace('src/mod', 'packages/core/src/mod');

function sha(n: number): string {
  return (n * 2654435761 >>> 0).toString(16).padStart(8, '0').repeat(5);
}

export function buildBranchFixture(): BranchFixture {
  let date = Date.UTC(2026, 9, 1, 9, 0);
  let n = 1;
  const commit = (subject: string, events: FileEvent[], extra: Partial<Stop> = {}): { stop: Stop; events: FileEvent[] } => {
    date += 5 * 3600_000;
    const id = sha(n++);
    const counts: Record<string, number> = {};
    for (const e of events) {
      const letter = { add: 'A', modify: 'M', ws: 'M', mode: 'M', rename: 'R', delete: 'D' }[e.type];
      counts[letter] = (counts[letter] ?? 0) + 1;
    }
    return {
      stop: {
        id,
        kind: 'commit',
        sha: id,
        shortSha: id.slice(0, 7),
        parents: [sha(n + 1000)],
        path: '',
        subject,
        authorName: n % 2 ? 'Ada Lovelace' : 'Grace Hopper',
        authorEmail: n % 2 ? 'ada@example.com' : 'grace@example.com',
        authorDate: date,
        commitDate: date,
        fileCount: events.length,
        statusCounts: counts,
        added: events.length * 2,
        deleted: events.length,
        ...extra,
      },
      events,
    };
  };

  const main = commit('Release 1.4', []);
  const a = [
    commit('Add string helpers', [{ type: 'modify', path: 'src/util/strings.ts' }]),
    commit('Write a guide', [{ type: 'add', path: 'docs/guide.md', lines: 12 }]),
    commit('Explain the setup', [{ type: 'modify', path: 'README.md' }]),
    commit('Bump dependencies', [{ type: 'modify', path: 'package.json' }]),
    commit('Fix mod01 edge case', [{ type: 'modify', path: 'src/mod01.ts' }]),
    commit('Tidy mod02', [{ type: 'modify', path: 'src/mod02.ts' }]),
    commit('Handle empty input', [{ type: 'modify', path: 'src/mod01.ts' }]),
    commit('Prepare for the move', [{ type: 'modify', path: 'src/mod02.ts' }]),
  ];
  const b = [
    commit('Move sources into packages/core', MODS.map((p) => ({ type: 'rename' as const, path: p, to: moved(p) }))),
    commit('Parse flags in mod03', [{ type: 'modify', path: moved(MODS[3]) }]),
    commit('Reformat', [{ type: 'ws', path: moved(MODS[4]) }, { type: 'ws', path: 'README.md' }]),
    commit('Make the build script executable', [{ type: 'mode', path: 'scripts/build.sh' }]),
    commit('Add an index', [{ type: 'add', path: 'packages/core/src/index.ts', lines: 8 }]),
    commit('Remove the legacy entry point', [{ type: 'delete', path: 'src/legacy.ts' }]),
    commit('Move string helpers next to their users', [
      { type: 'rename', path: 'src/util/strings.ts', to: 'packages/core/src/strings.ts', modify: true },
      { type: 'modify', path: moved(MODS[3]) },
    ]),
    commit('Bump dependencies again', [{ type: 'modify', path: 'package.json' }]),
    commit('Speed up mod05', [{ type: 'modify', path: moved(MODS[5]) }]),
    commit('Add tests', [{ type: 'add', path: 'packages/core/test/a.test.ts', lines: 20 }]),
    commit('Validate mod03 options', [{ type: 'modify', path: moved(MODS[3]) }]),
    commit('Update the guide', [{ type: 'modify', path: 'docs/guide.md' }], { refs: ['HEAD -> feature-b', 'origin/feature-b'] }),
  ];
  const working: Stop = { id: WORKING_ID, kind: 'working', path: '', subject: 'Working copy' };
  const workingEvents: FileEvent[] = [
    { type: 'modify', path: 'packages/core/src/index.ts' },
    { type: 'add', path: 'notes.txt', lines: 3 },
  ];

  const featureA = a[a.length - 1].stop;
  featureA.forkOf = ['feature-a', 'origin/feature-a'];
  main.stop.forkOf = ['main', 'origin/main'];
  const levels: BaseLevel[] = [
    { sha: featureA.id, shortSha: featureA.id.slice(0, 7), branches: ['feature-a', 'origin/feature-a'], distance: b.length },
    { sha: main.stop.id, shortSha: main.stop.id.slice(0, 7), branches: ['main', 'origin/main'], distance: b.length + a.length },
  ];

  const events: Record<string, FileEvent[]> = {};
  for (const c of [main, ...a, ...b]) events[c.stop.id] = c.events;
  events[WORKING_ID] = workingEvents;

  const common = {
    resource: 'file:///repo',
    repoName: 'demo-repo',
    hasMore: false,
    options: { renderSideBySide: true, ignoreTrimWhitespace: false, hideUnchangedRegions: false, wordWrap: false, contentChangesOnly: true },
    filters: { hiddenKinds: [], query: '', matchCase: false, regex: false, mode: 'tree' as const, sort: 'path' as const },
  };

  const init: BranchInitPayload = {
    ...common,
    branch: { ref: 'refs/heads/feature-b', name: 'feature-b', sha: b[b.length - 1].stop.id, remote: false, head: true },
    levels,
    level: 0,
    base: featureA,
    commits: b.map((c) => c.stop),
    specials: [working],
  };

  const other: BranchInitPayload = {
    ...common,
    branch: { ref: 'refs/heads/feature-a', name: 'feature-a', sha: featureA.id, remote: false, head: false },
    levels: [levels[1]],
    level: 0,
    base: main.stop,
    commits: a.map((c) => c.stop),
    specials: [],
    reset: true,
  };

  return {
    init,
    order: [main.stop.id, ...a.map((c) => c.stop.id), ...b.map((c) => c.stop.id), WORKING_ID],
    initial: [...MODS, 'README.md', 'package.json', 'src/util/strings.ts', 'scripts/build.sh', 'src/legacy.ts'],
    events,
    upper: { base: main.stop, commits: [...a.map((c) => c.stop), ...b.map((c) => c.stop)] },
    other,
  };
}
