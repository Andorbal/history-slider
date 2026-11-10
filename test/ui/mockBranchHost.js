// Stands in for the extension host of a branch panel inside the UI test harness.
// Expects `__FIXTURE__` (see branchFixture.ts) and `__SCENARIO__` before this runs.
// It replays the fixture's file events to answer diffs, contents and file tracks.
(() => {
  const fx = __FIXTURE__;
  const scenario = __SCENARIO__;
  const sent = [];
  let state;
  let current = fx.init;
  const reply = (msg, delay = 0) => setTimeout(() => window.postMessage(msg, '*'), delay);

  /** Files after the events up to and including stop `k` of `fx.order`, each with a stable identity. */
  function stateAt(k) {
    const files = fx.initial.map((path, id) => ({ id, path, exists: true, version: 0, ws: 0, mode: 0, lines: 10 }));
    const touches = [];
    for (let i = 0; i <= k; i++) {
      const stopId = fx.order[i];
      for (const e of fx.events[stopId] || []) {
        let f = files.find((x) => x.exists && x.path === e.path);
        if (e.type === 'add') {
          f = { id: files.length, path: e.path, exists: true, version: 0, ws: 0, mode: 0, lines: e.lines || 5 };
          files.push(f);
          touches.push({ id: stopId, file: f.id, status: 'A', path: f.path });
          continue;
        }
        if (!f) continue;
        if (e.type === 'modify') f.version++;
        if (e.type === 'ws') f.ws++;
        if (e.type === 'mode') f.mode++;
        if (e.type === 'delete') f.exists = false;
        if (e.type === 'rename') {
          touches.push({ id: stopId, file: f.id, status: 'R', oldPath: f.path, path: e.to });
          f.path = e.to;
          if (e.modify) f.version++;
          continue;
        }
        touches.push({ id: stopId, file: f.id, status: e.type === 'delete' ? 'D' : 'M', path: f.path });
      }
    }
    return { files: files.map((f) => ({ ...f })), touches };
  }

  const indexOf = (id) => fx.order.indexOf(id);

  function diff(oldId, newId) {
    const a = stateAt(indexOf(oldId)).files;
    const b = stateAt(indexOf(newId)).files;
    const out = [];
    for (const nb of b) {
      const na = a.find((x) => x.id === nb.id);
      const before = na && na.exists ? na : undefined;
      const after = nb.exists ? nb : undefined;
      if (!before && !after) continue;
      if (!before) {
        out.push({ path: after.path, status: 'A', kind: 'added', added: after.lines, deleted: 0, untracked: newId === '::working' && after.path === 'notes.txt' ? true : undefined });
        continue;
      }
      if (!after) {
        out.push({ path: before.path, status: 'D', kind: 'deleted', added: 0, deleted: before.lines });
        continue;
      }
      const renamed = before.path !== after.path;
      const dv = after.version - before.version;
      const dws = after.ws - before.ws;
      const dm = after.mode !== before.mode;
      if (!renamed && !dv && !dws && !dm) continue;
      const change = { path: after.path, status: renamed ? 'R' : 'M', added: dv * 2 + dws, deleted: dv + dws };
      if (renamed) {
        change.oldPath = before.path;
        change.score = dv || dws ? 90 : 100;
      }
      if (dm) {
        change.oldMode = '100644';
        change.newMode = '100755';
      }
      change.kind = renamed ? (dv ? 'renamedModified' : dws ? 'whitespace' : 'renamed') : dv ? 'modified' : dws ? 'whitespace' : 'mode';
      out.push(change);
    }
    return out;
  }

  function text(f) {
    const lines = [`// module ${f.id}`, `export const version = ${f.version};`];
    for (let i = 0; i < f.lines; i++) lines.push(`${f.ws % 2 && i === 2 ? '    ' : '  '}line(${i});`);
    return lines.join('\n') + '\n';
  }

  function content(stopId, path) {
    const f = stateAt(indexOf(stopId)).files.find((x) => x.exists && x.path === path);
    return f ? { text: text(f) } : { text: '', missing: true };
  }

  function track(path) {
    const last = fx.order.length - 1;
    const all = stateAt(last);
    // The file that is at `path` at some stop: look newest first.
    let id;
    for (let k = last; k >= 0 && id === undefined; k--) {
      const f = stateAt(k).files.find((x) => x.path === path);
      if (f) id = f.id;
    }
    const inView = new Set([current.base && current.base.id, ...current.commits.map((c) => c.id)]);
    return all.touches
      .filter((t) => t.file === id && inView.has(t.id) && t.id !== (current.base && current.base.id))
      .map(({ file: _file, ...t }) => t);
  }

  function levelPayload(level, selection) {
    if (level === 0) return { ...fx.init, selection };
    return { ...fx.init, level: 1, base: fx.upper.base, commits: fx.upper.commits, selection };
  }

  window.__sent = sent;
  window.__host = {
    fixture: fx,
    send: (msg) => reply(msg),
    state: () => state,
  };

  window.acquireVsCodeApi = () => ({
    postMessage(m) {
      sent.push(m);
      switch (m.type) {
        case 'ready':
        case 'refresh':
          reply({ type: 'loading', message: 'Loading branch history…' });
          reply({ type: 'init', payload: scenario.error ? { ...current, error: scenario.error } : current }, 30);
          break;
        case 'setLevel':
          current = levelPayload(m.level, m.selection);
          reply({ type: 'loading', message: 'Loading branch history…' });
          reply({ type: 'init', payload: current }, 40);
          break;
        case 'pickBranch':
          current = fx.other;
          reply({ type: 'init', payload: current }, 40);
          break;
        case 'getDiff':
          reply({ type: 'diff', result: { requestId: m.requestId, oldId: m.oldId, newId: m.newId, files: diff(m.oldId, m.newId) } }, scenario.diffDelay ?? 10);
          break;
        case 'getContent':
          reply({ type: 'content', result: { requestId: m.requestId, stopId: m.stopId, path: m.path, ...content(m.stopId, m.path) } }, 5);
          break;
        case 'track':
          reply({ type: 'track', path: m.path, touches: track(m.path) }, 5);
          break;
      }
    },
    setState(s) {
      state = s;
    },
    getState() {
      return state;
    },
  });
})();
