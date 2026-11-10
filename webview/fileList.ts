/** The branch view's list of changed files: a virtualized tree or flat list with keyboard support. */
import type { ChangeKind, FileChange } from '../src/shared/branchProtocol';
import { basename, dirname, type Row } from './fileFilter';
import { escapeHtml } from './format';

export const ROW_HEIGHT = 22;
const OVERSCAN = 8;

export interface KindInfo {
  label: string;
  /** Shown in the chip; the rows show git's own status letter. */
  letter: string;
  title: string;
}

export const KINDS: Record<ChangeKind, KindInfo> = {
  added: { label: 'Added', letter: 'A', title: 'New files' },
  modified: { label: 'Modified', letter: 'M', title: 'Files whose content changed' },
  deleted: { label: 'Deleted', letter: 'D', title: 'Files that were removed' },
  renamed: { label: 'Renamed', letter: 'R', title: 'Moved or renamed, content unchanged' },
  renamedModified: { label: 'Renamed + edited', letter: 'R', title: 'Moved or renamed, and the content changed too' },
  copied: { label: 'Copied', letter: 'C', title: 'Copies of another file' },
  whitespace: { label: 'Whitespace only', letter: 'W', title: 'Only whitespace or line endings changed (renamed files included)' },
  mode: { label: 'Mode only', letter: 'X', title: 'Only the file mode (like the executable bit) or the file type changed' },
};

export interface FileListEvents {
  /** A file row was clicked or reached with the keyboard. */
  select(file: FileChange, how: 'click' | 'keyboard'): void;
  /** Double-click, Shift+Enter or the row's button: open the file in its own History Slider. */
  openHistory(file: FileChange): void;
  /** The row's button: open in VS Code's diff editor. */
  openDiff(file: FileChange): void;
  toggleDir(path: string): void;
}

/** Short tags that say more than the status letter. */
export function tagsFor(f: FileChange): string[] {
  const tags: string[] = [];
  if (f.kind === 'renamed') tags.push('moved');
  if (f.kind === 'whitespace') tags.push('whitespace');
  if (f.newMode && f.oldMode !== f.newMode) tags.push(f.newMode === '100755' ? '+x' : f.oldMode === '100755' ? '−x' : 'mode');
  if (f.status === 'T') tags.push('type');
  if (f.untracked) tags.push('untracked');
  if (f.binary) tags.push('binary');
  if (f.submodule) tags.push('submodule');
  return tags;
}

/** Where a renamed file came from, as briefly as is still clear: the old name if it stayed in its folder, else the old path. */
export function renamedFrom(f: FileChange): string | undefined {
  if (!f.oldPath) return undefined;
  return dirname(f.oldPath) === dirname(f.path) ? basename(f.oldPath) : f.oldPath;
}

export function statsHtml(added: number | undefined, deleted: number | undefined, binary?: boolean): string {
  if (binary) return '';
  if (added === undefined && deleted === undefined) return '';
  return `${added ? `<span class="added">+${added.toLocaleString()}</span>` : ''}${deleted ? `<span class="deleted">−${deleted.toLocaleString()}</span>` : ''}`;
}

export function badgeHtml(f: FileChange): string {
  const letter = f.untracked && f.status === 'A' ? 'U' : f.status;
  return `<span class="fl-badge k-${f.kind}" title="${escapeHtml(KINDS[f.kind].label)}">${escapeHtml(letter)}</span>`;
}

export class FileList {
  readonly el: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly rowsEl: HTMLElement;
  private rows: Row[] = [];
  private mode: 'tree' | 'list' = 'tree';
  private selectedKey?: string;
  private focusIndex = -1;
  private frame = 0;
  private selectTimer?: ReturnType<typeof setTimeout>;
  /** Bumped whenever the rows change, so render() knows when it must rebuild them. */
  private version = 0;
  private rendered = '';

  constructor(private readonly events: FileListEvents) {
    this.el = document.createElement('div');
    this.el.className = 'file-list';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'tree');
    this.el.setAttribute('aria-label', 'Changed files');
    this.el.innerHTML = '<div class="fl-spacer"></div><div class="fl-rows"></div>';
    this.spacer = this.el.querySelector('.fl-spacer')!;
    this.rowsEl = this.el.querySelector('.fl-rows')!;
    this.el.addEventListener('scroll', () => this.schedule());
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('focus', () => {
      if (this.focusIndex < 0 && this.rows.length) this.setFocus(Math.max(0, this.indexOfKey(this.selectedKey)), false);
      this.schedule();
    });
    this.el.addEventListener('blur', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.el);
  }

  setRows(rows: Row[], mode: 'tree' | 'list'): void {
    const focusedKey = this.rows[this.focusIndex]?.key;
    this.rows = rows;
    this.mode = mode;
    this.version++;
    this.el.classList.toggle('flat', mode === 'list');
    this.focusIndex = this.indexOfKey(focusedKey ?? this.selectedKey);
    this.spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
    this.render();
  }

  setSelected(key: string | undefined, reveal = false): void {
    this.selectedKey = key;
    if (reveal) {
      const i = this.indexOfKey(key);
      if (i >= 0) {
        this.focusIndex = i;
        this.reveal(i);
      }
    }
    this.render();
  }

  /** Moves the selection to the next (1) or previous (-1) file. */
  step(delta: 1 | -1): void {
    const files = this.rows.map((r, i) => [r, i] as const).filter(([r]) => r.type === 'file');
    if (!files.length) return;
    const at = files.findIndex(([r]) => r.key === this.selectedKey);
    const next = at < 0 ? (delta > 0 ? 0 : files.length - 1) : Math.min(files.length - 1, Math.max(0, at + delta));
    const [row, index] = files[next];
    this.setFocus(index, true);
    this.events.select(row.file!, 'keyboard');
  }

  focus(): void {
    this.el.focus();
  }

  private indexOfKey(key: string | undefined): number {
    return key === undefined ? -1 : this.rows.findIndex((r) => r.key === key);
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const top = this.el.scrollTop;
    const height = this.el.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    const focused = document.activeElement === this.el;
    const key = `${this.version}:${first}:${last}`;
    if (key !== this.rendered) {
      // Only rebuild when the rows or the window onto them changed. Rebuilding on a mere
      // focus or selection change would swap the element under a click in progress.
      this.rendered = key;
      let html = '';
      for (let i = first; i < last; i++) html += this.rowHtml(this.rows[i], i);
      this.rowsEl.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
      this.rowsEl.innerHTML = html;
    }
    for (const el of this.rowsEl.children as HTMLCollectionOf<HTMLElement>) {
      const i = Number(el.dataset.i);
      const selected = this.rows[i]?.key === this.selectedKey;
      el.classList.toggle('selected', selected);
      el.classList.toggle('focused', focused && i === this.focusIndex);
      if (this.rows[i]?.type === 'file') el.setAttribute('aria-selected', String(selected));
    }
    const active = this.rows[this.focusIndex];
    if (active && focused) this.el.setAttribute('aria-activedescendant', this.rowId(this.focusIndex));
    else this.el.removeAttribute('aria-activedescendant');
  }

  private rowId(i: number): string {
    return `fl-row-${i}`;
  }

  private rowHtml(row: Row, i: number): string {
    const indent = this.mode === 'tree' ? row.depth * 12 : 0;
    const cls = `fl-row ${row.type}`;
    const common = `id="${this.rowId(i)}" class="${cls}" data-i="${i}" role="treeitem" aria-level="${row.depth + 1}" style="padding-left:${indent + 4}px"`;
    if (row.type === 'dir') {
      const d = row.dir!;
      return `<div ${common} aria-expanded="${row.expanded}" title="${escapeHtml(d.path)}">
        <span class="fl-twisty hsi ${row.expanded ? 'hsi-chevron-down' : 'hsi-chevron-right'}"></span>
        <span class="hsi hsi-folder fl-icon"></span>
        <span class="fl-name">${escapeHtml(d.name)}</span>
        <span class="fl-count">${d.fileCount.toLocaleString()}</span>
        <span class="fl-stats">${statsHtml(d.added, d.deleted)}</span>
      </div>`;
    }
    const f = row.file!;
    const from = renamedFrom(f);
    const dir = this.mode === 'list' ? dirname(f.path) : '';
    const tags = tagsFor(f)
      .map((t) => `<span class="fl-tag">${escapeHtml(t)}</span>`)
      .join('');
    const title = [f.path, f.oldPath ? `from ${f.oldPath}${f.score !== undefined && f.score < 100 ? ` (${f.score}% similar)` : ''}` : '', KINDS[f.kind].label].filter(Boolean).join('\n');
    return `<div ${common} title="${escapeHtml(title)}">
      <span class="fl-twisty"></span>
      ${badgeHtml(f)}
      <span class="fl-name${f.status === 'D' ? ' gone' : ''}">${escapeHtml(basename(f.path))}</span>
      ${dir ? `<span class="fl-dir">${escapeHtml(dir)}</span>` : ''}
      ${from ? `<span class="fl-from">← ${escapeHtml(from)}</span>` : ''}
      ${tags}
      <span class="fl-stats">${statsHtml(f.added, f.deleted, f.binary)}</span>
      <span class="fl-actions">
        <button data-row-action="history" title="Open in a new History Slider (Shift+Enter)"><span class="hsi hsi-history"></span></button>
        <button data-row-action="diff" title="Open in the VS Code diff editor"><span class="hsi hsi-go-to-file"></span></button>
      </span>
    </div>`;
  }

  private rowAt(e: Event): { row: Row; index: number } | undefined {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.fl-row');
    if (!el) return undefined;
    const index = Number(el.dataset.i);
    const row = this.rows[index];
    return row ? { row, index } : undefined;
  }

  private onClick(e: MouseEvent): void {
    const hit = this.rowAt(e);
    if (!hit) return;
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-row-action]')?.dataset.rowAction;
    this.setFocus(hit.index, false);
    if (hit.row.type === 'dir') {
      this.events.toggleDir(hit.row.dir!.path);
      return;
    }
    const file = hit.row.file!;
    if (action === 'history') this.events.openHistory(file);
    else if (action === 'diff') this.events.openDiff(file);
    else this.events.select(file, 'click');
  }

  private onDoubleClick(e: MouseEvent): void {
    const hit = this.rowAt(e);
    if (!hit || hit.row.type !== 'file' || (e.target as HTMLElement).closest('[data-row-action]')) return;
    this.events.openHistory(hit.row.file!);
  }

  private setFocus(index: number, reveal = true): void {
    this.focusIndex = Math.min(this.rows.length - 1, Math.max(0, index));
    if (reveal) this.reveal(this.focusIndex);
    this.render();
  }

  private reveal(index: number): void {
    const top = index * ROW_HEIGHT;
    const view = this.el;
    if (top < view.scrollTop) view.scrollTop = top;
    else if (top + ROW_HEIGHT > view.scrollTop + view.clientHeight) view.scrollTop = top + ROW_HEIGHT - view.clientHeight;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey || !this.rows.length) return;
    const page = Math.max(1, Math.floor(this.el.clientHeight / ROW_HEIGHT) - 1);
    const row = this.rows[this.focusIndex];
    let next = this.focusIndex;
    switch (e.key) {
      case 'ArrowDown':
        next++;
        break;
      case 'ArrowUp':
        next--;
        break;
      case 'PageDown':
        next += page;
        break;
      case 'PageUp':
        next -= page;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = this.rows.length - 1;
        break;
      case 'ArrowRight':
        if (row?.type === 'dir' && !row.expanded) this.events.toggleDir(row.dir!.path);
        else if (row?.type === 'dir') next++;
        else break;
        e.preventDefault();
        e.stopPropagation();
        if (next === this.focusIndex) return;
        break;
      case 'ArrowLeft': {
        e.preventDefault();
        e.stopPropagation();
        if (row?.type === 'dir' && row.expanded) {
          this.events.toggleDir(row.dir!.path);
          return;
        }
        // Up to the folder this row is in.
        for (let i = this.focusIndex - 1; i >= 0; i--) {
          if (this.rows[i].type === 'dir' && this.rows[i].depth < (row?.depth ?? 0)) {
            this.setFocus(i);
            return;
          }
        }
        return;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        e.stopPropagation();
        if (!row) return;
        if (row.type === 'dir') this.events.toggleDir(row.dir!.path);
        else if (e.shiftKey && e.key === 'Enter') this.events.openHistory(row.file!);
        else this.events.select(row.file!, 'click');
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (next === this.focusIndex && e.key !== 'ArrowRight') return;
    this.setFocus(next);
    const target = this.rows[this.focusIndex];
    if (target?.type === 'file') {
      // Follow the keyboard without loading every file passed on the way.
      clearTimeout(this.selectTimer);
      this.selectedKey = target.key;
      this.render();
      this.selectTimer = setTimeout(() => this.events.select(target.file!, 'keyboard'), 60);
    }
  }
}
