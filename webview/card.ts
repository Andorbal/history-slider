import type { Stop } from '../src/shared/protocol';
import { absoluteTime, escapeHtml, formatRefs, relativeTime, stopLabel } from './format';

export interface CardActions {
  /** Select exactly the change this commit made. */
  showChange(stop: Stop): void;
  openRevision(stop: Stop): void;
  copy(text: string, label: string): void;
}

export type CardRole = 'old' | 'new' | 'both' | undefined;

export interface CardOptions {
  /** 'repo' describes commits by what they did to the whole repository (branch view). */
  mode?: 'file' | 'repo';
  /** Extra markup for a stop, shown under its details. */
  extra?(stop: Stop): string;
}

const STATUS_WORDS: [string, string][] = [
  ['A', 'added'],
  ['M', 'modified'],
  ['D', 'deleted'],
  ['R', 'renamed'],
  ['C', 'copied'],
  ['T', 'type changed'],
];

/** "12 files · 3 added · 8 modified · 1 renamed" */
export function fileSummary(stop: Stop): string {
  if (stop.fileCount === undefined) return '';
  const parts = STATUS_WORDS.filter(([k]) => stop.statusCounts?.[k]).map(([k, w]) => `${stop.statusCounts![k]!.toLocaleString()} ${w}`);
  const files = `${stop.fileCount.toLocaleString()} file${stop.fileCount === 1 ? '' : 's'}`;
  return [files, ...parts].join(' · ');
}

const BODY_LINES = 8;

/** The popup with commit details that follows the handle being dragged or the stop being hovered. */
export class Card {
  readonly el: HTMLElement;
  private stop?: Stop;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private hovered = false;

  constructor(
    private readonly actions: CardActions,
    private readonly options: CardOptions = {},
  ) {
    this.el = document.createElement('div');
    this.el.className = 'card';
    this.el.hidden = true;
    this.el.setAttribute('role', 'tooltip');
    this.el.addEventListener('pointerenter', () => {
      this.hovered = true;
      clearTimeout(this.hideTimer);
    });
    this.el.addEventListener('pointerleave', () => {
      this.hovered = false;
      this.hide(250);
    });
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  isVisible(): boolean {
    return !this.el.hidden;
  }

  /**
   * @param anchorX client x of the stop the card points at
   * @param top client y of the card's top edge
   * @param interactive whether the card can be hovered and clicked
   * @param autoHideMs hide automatically after this long (unless hovered)
   */
  show(stop: Stop, role: CardRole, anchorX: number, top: number, interactive: boolean, autoHideMs = 0): void {
    clearTimeout(this.hideTimer);
    if (this.stop !== stop || this.el.hidden) {
      this.stop = stop;
      this.el.innerHTML = this.render(stop, role);
    } else {
      this.el.querySelector('.card-role')?.replaceWith(this.roleChip(role));
    }
    this.el.hidden = false;
    this.el.classList.toggle('interactive', interactive);
    const width = this.el.offsetWidth;
    const maxLeft = window.innerWidth - width - 8;
    const left = Math.max(8, Math.min(maxLeft, anchorX - width / 2));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.setProperty('--arrow-x', `${Math.max(12, Math.min(width - 12, anchorX - left))}px`);
    if (autoHideMs > 0) this.hide(autoHideMs);
  }

  hide(delayMs = 0): void {
    clearTimeout(this.hideTimer);
    const doHide = () => {
      if (this.hovered) return;
      this.el.hidden = true;
      this.stop = undefined;
    };
    if (delayMs > 0) this.hideTimer = setTimeout(doHide, delayMs);
    else doHide();
  }

  private roleChip(role: CardRole): HTMLElement {
    const span = document.createElement('span');
    span.className = `card-role ${role ?? ''}`;
    span.textContent = role === 'both' ? 'OLD = NEW' : role ? role.toUpperCase() : '';
    span.hidden = !role;
    return span;
  }

  private render(stop: Stop, role: CardRole): string {
    const chip = this.roleChip(role).outerHTML;
    if (stop.kind !== 'commit') {
      const title = stop.kind === 'working' ? 'Working copy' : 'Staged changes';
      const detail =
        stop.kind === 'staged'
          ? 'The version in the git index, ready to be committed.'
          : stop.missing
            ? 'The file does not exist on disk.'
            : this.options.mode === 'repo'
            ? 'The files as they are on disk, including untracked ones. Updates when they are saved.'
            : stop.dirty
              ? 'Includes unsaved changes from the editor. Updates live as you type.'
              : 'The file as it is on disk. Updates live as it changes.';
      const icon = stop.kind === 'working' ? 'hsi-edit' : 'hsi-diff-added';
      return `
        <div class="card-head"><span class="hsi ${icon}"></span><strong>${title}</strong>${chip}</div>
        <div class="card-body">${escapeHtml(detail)}</div>
        ${this.actionsHtml(stop)}`;
    }
    const refs = formatRefs(stop.refs)
      .map((r) => `<span class="ref ${r.tag ? 'tag' : ''}">${r.tag ? '<span class="hsi hsi-tag"></span>' : ''}${escapeHtml(r.text)}</span>`)
      .join('');
    const bodyLines = (stop.body ?? '').split('\n');
    const body =
      bodyLines.slice(0, BODY_LINES).join('\n') + (bodyLines.length > BODY_LINES ? '\n…' : '');
    const stats =
      stop.binary
        ? '<span class="muted">binary</span>'
        : stop.added !== undefined
          ? `<span class="added">+${stop.added}</span> <span class="deleted">−${stop.deleted}</span>`
          : '';
    const repo = this.options.mode === 'repo';
    const file = (repo
      ? [
          stop.forkOf?.length ? `<span class="card-fork"><span class="hsi hsi-git-branch"></span> where this line meets <strong>${escapeHtml(stop.forkOf.join(', '))}</strong></span>` : '',
          stop.fileCount !== undefined ? `<span>${escapeHtml(fileSummary(stop))}</span>` : '',
          (stop.parents?.length ?? 0) > 1 ? '<span>merge commit (diff vs. first parent)</span>' : '',
        ]
      : [
      stop.status === 'A' ? '<span>file added</span>' : '',
      stop.status === 'D' ? '<span class="deleted">file deleted</span>' : '',
      stop.oldPath ? `<span>renamed from <code>${escapeHtml(stop.oldPath)}</code></span>` : '',
      (stop.parents?.length ?? 0) > 1 ? '<span>merge commit (diff vs. first parent)</span>' : '',
    ])
      .filter(Boolean)
      .join(' · ');
    const committer =
      stop.committerName && stop.committerName !== stop.authorName
        ? ` <span class="muted">(committed by ${escapeHtml(stop.committerName)})</span>`
        : '';
    return `
      <div class="card-head">
        <span class="hsi hsi-git-commit"></span>
        <code class="sha" title="${escapeHtml(stop.sha ?? '')}">${escapeHtml(stopLabel(stop))}</code>
        ${refs}
        ${chip}
      </div>
      <div class="card-subject">${escapeHtml(stop.subject)}</div>
      ${stop.body ? `<div class="card-body">${escapeHtml(body)}</div>` : ''}
      <div class="card-meta">
        <span class="hsi hsi-account"></span><span title="${escapeHtml(stop.authorEmail ?? '')}">${escapeHtml(stop.authorName ?? '')}</span>${committer}
      </div>
      <div class="card-meta">
        <span class="hsi hsi-clock"></span><span>${stop.authorDate ? `${relativeTime(stop.authorDate)} · ${absoluteTime(stop.authorDate)}` : ''}</span>
        ${stats ? `<span class="card-stats">${stats}</span>` : ''}
      </div>
      ${file ? `<div class="card-meta card-file">${file}</div>` : ''}
      ${this.options.extra?.(stop) ?? ''}
      ${this.actionsHtml(stop)}`;
  }

  private actionsHtml(stop: Stop): string {
    const buttons = [
      stop.kind === 'commit' ? '<button data-action="change" title="Compare this commit with the one before it">Show this change</button>' : '',
      this.options.mode === 'repo' ? '' : '<button data-action="open" title="Open this version in an editor tab">Open file</button>',
      stop.kind === 'commit' ? '<button data-action="copy" title="Copy the full commit SHA">Copy SHA</button>' : '',
    ];
    return `<div class="card-actions">${buttons.join('')}</div>`;
  }

  private onClick(e: MouseEvent): void {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    const stop = this.stop;
    if (!action || !stop) return;
    if (action === 'change') this.actions.showChange(stop);
    else if (action === 'open') this.actions.openRevision(stop);
    else if (action === 'copy' && stop.sha) this.actions.copy(stop.sha, `commit ${stop.shortSha}`);
    this.hovered = false;
    this.hide();
  }
}
