import * as monaco from 'monaco-editor/editor/editor.api';
import type { ContentResult, DiffOptions } from '../src/shared/protocol';
import { applyTheme, editorFont, onThemeChange } from './theme';

export interface Side {
  id: string;
  result: ContentResult;
}

export interface DiffStats {
  added: number;
  removed: number;
  changes: number;
}

/** 'first' reveals the first change; a number reveals that line of the new side. */
export type Reveal = 'first' | number;

const MAX_MODELS = 24;

function diffOptions(o: DiffOptions): monaco.editor.IDiffEditorOptions {
  return {
    renderSideBySide: o.renderSideBySide,
    ignoreTrimWhitespace: o.ignoreTrimWhitespace,
    hideUnchangedRegions: {
      enabled: o.hideUnchangedRegions,
      contextLineCount: 3,
      minimumLineCount: 3,
      revealLineCount: 20,
    },
    wordWrap: o.wordWrap ? 'on' : 'off',
    diffWordWrap: o.wordWrap ? 'on' : 'off',
  };
}

function problemOf(r: ContentResult): string | undefined {
  if (r.binary) return 'This revision is a binary file, so there is no text diff to show.';
  if (r.tooLarge) return 'This revision is larger than the historySlider.maxFileSizeMB setting allows.';
  if (r.error) return `Could not load this revision: ${r.error}`;
  if (r.text === undefined) return 'This revision has no content.';
  return undefined;
}

/** Wraps Monaco's diff editor: caches one model per revision and keeps the scroll position while models swap. */
export class DiffView {
  readonly editor: monaco.editor.IStandaloneDiffEditor;
  private readonly models = new Map<string, monaco.editor.ITextModel>();
  private readonly empty: [monaco.editor.ITextModel, monaco.editor.ITextModel];
  private pending?: { old: Side; new: Side; reveal?: Reveal };
  private frame = 0;
  private generation = 0;
  private afterDiff?: { viewState?: monaco.editor.ICodeEditorViewState | null; reveal?: Reveal };
  private language = 'plaintext';
  private fileName = 'file';

  constructor(
    host: HTMLElement,
    private readonly overlay: HTMLElement,
    options: DiffOptions,
    private readonly onStats: (stats: DiffStats | undefined) => void,
  ) {
    applyTheme(monaco);
    this.editor = monaco.editor.createDiffEditor(host, {
      ...diffOptions(options),
      ...editorFont(),
      readOnly: true,
      domReadOnly: true,
      originalEditable: false,
      automaticLayout: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 600,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      renderMarginRevertIcon: false,
      renderIndicators: true,
      enableSplitViewResizing: true,
      diffAlgorithm: 'advanced',
      maxComputationTime: 5000,
      maxFileSize: 100,
      experimental: { showMoves: true },
      fixedOverflowWidgets: true,
      padding: { top: 4 },
    });
    this.empty = [monaco.editor.createModel(''), monaco.editor.createModel('')];
    this.editor.onDidUpdateDiff(() => this.onDiffUpdated());
    onThemeChange(() => {
      applyTheme(monaco);
      this.editor.updateOptions(editorFont());
    });
  }

  setFile(fileName: string, language: string): void {
    this.fileName = fileName.replace(/[^\w.-]/g, '_') || 'file';
    if (language === this.language) return;
    this.language = language;
    for (const m of this.models.values()) monaco.editor.setModelLanguage(m, language);
  }

  setOptions(options: DiffOptions): void {
    this.editor.updateOptions(diffOptions(options));
  }

  /** Shows a diff. Coalesced to one update per animation frame so dragging stays smooth. */
  show(oldSide: Side, newSide: Side, reveal?: Reveal): void {
    this.pending = { old: oldSide, new: newSide, reveal: reveal ?? this.pending?.reveal };
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.apply();
      });
    }
  }

  /** Updates a cached revision's text in place (used for the live working copy). */
  updateText(id: string, text: string): void {
    const model = this.models.get(id);
    if (model) replaceText(model, text);
  }

  /** Drops every cached model, e.g. before showing a different file. */
  clear(): void {
    this.pending = undefined;
    this.afterDiff = undefined;
    this.editor.setModel({ original: this.empty[0], modified: this.empty[1] });
    for (const m of this.models.values()) m.dispose();
    this.models.clear();
  }

  /** Drops cached models for revisions whose content can change. */
  forget(id: string): void {
    const model = this.models.get(id);
    const current = this.editor.getModel();
    if (!model || current?.original === model || current?.modified === model) return;
    model.dispose();
    this.models.delete(id);
  }

  goToChange(direction: 1 | -1): boolean {
    const changes = this.editor.getLineChanges();
    if (!changes?.length) return false;
    const editor = this.editor.getModifiedEditor();
    const current = editor.getPosition()?.lineNumber ?? 0;
    const starts = changes.map((c) => Math.max(1, c.modifiedStartLineNumber));
    const target =
      direction > 0
        ? (starts.find((s) => s > current) ?? starts[0])
        : ([...starts].reverse().find((s) => s < current) ?? starts[starts.length - 1]);
    editor.setPosition({ lineNumber: target, column: 1 });
    editor.revealLineInCenter(target, monaco.editor.ScrollType.Smooth);
    return true;
  }

  /** 1-based line at the top of the new side's viewport. */
  visibleLine(): number {
    return this.editor.getModifiedEditor().getVisibleRanges()[0]?.startLineNumber ?? 1;
  }

  focus(): void {
    this.editor.getModifiedEditor().focus();
  }

  private apply(): void {
    const p = this.pending;
    this.pending = undefined;
    if (!p) return;
    const problem = problemOf(p.old.result) ?? problemOf(p.new.result);
    if (problem) {
      this.overlay.textContent = problem;
      this.overlay.hidden = false;
      this.editor.setModel({ original: this.empty[0], modified: this.empty[1] });
      this.onStats(undefined);
      return;
    }
    this.overlay.hidden = true;
    // Monaco needs two distinct models, so the same revision on both sides gets a twin.
    const originalKey = p.old.id === p.new.id ? `${p.old.id}#twin` : p.old.id;
    const original = this.model(originalKey, p.old.result.text!);
    const modified = this.model(p.new.id, p.new.result.text!);
    const current = this.editor.getModel();
    if (current?.original === original && current.modified === modified) {
      if (p.reveal) this.reveal(p.reveal);
      // Nothing to recompute unless the text changed (then onDidUpdateDiff follows), so
      // report the current result straight away.
      this.emitStats();
      return;
    }
    const editor = this.editor.getModifiedEditor();
    const hadModel = !!current && current.modified !== this.empty[1];
    const viewState = hadModel ? editor.saveViewState() : null;
    this.editor.setModel({ original, modified });
    if (viewState) editor.restoreViewState(viewState);
    // Restore again once the diff (and its padding for removed lines) is in place.
    this.afterDiff = { viewState, reveal: p.reveal };
    this.evict(new Set([original, modified]));
  }

  private onDiffUpdated(): void {
    const after = this.afterDiff;
    this.afterDiff = undefined;
    if (after?.viewState) this.editor.getModifiedEditor().restoreViewState(after.viewState);
    if (after?.reveal) this.reveal(after.reveal);
    this.emitStats();
  }

  private emitStats(): void {
    const model = this.editor.getModel();
    if (!model || model.modified === this.empty[1]) return;
    const changes = this.editor.getLineChanges();
    if (!changes) {
      this.onStats(undefined);
      return;
    }
    let added = 0;
    let removed = 0;
    for (const c of changes) {
      if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
      if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
    }
    this.onStats({ added, removed, changes: changes.length });
  }

  private reveal(reveal: Reveal): void {
    const editor = this.editor.getModifiedEditor();
    if (reveal === 'first') {
      const first = this.editor.getLineChanges()?.[0];
      if (!first) return;
      const line = Math.max(1, first.modifiedStartLineNumber);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.revealLineInCenterIfOutsideViewport(line);
    } else {
      const line = Math.min(Math.max(1, reveal), editor.getModel()?.getLineCount() ?? 1);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.revealLineInCenter(line);
    }
  }

  private model(key: string, text: string): monaco.editor.ITextModel {
    const existing = this.models.get(key);
    if (existing) {
      // Revisions starting with "::" (working copy, staged) can change; commits never do.
      if (key.startsWith('::')) replaceText(existing, text);
      this.models.delete(key);
      this.models.set(key, existing);
      return existing;
    }
    const uri = monaco.Uri.from({
      scheme: 'history-slider',
      path: `/${++this.generation}/${this.fileName}`,
    });
    const model = monaco.editor.createModel(text, this.language, uri);
    this.models.set(key, model);
    return model;
  }

  private evict(keep: Set<monaco.editor.ITextModel>): void {
    for (const [key, model] of this.models) {
      if (this.models.size <= MAX_MODELS) break;
      if (keep.has(model)) continue;
      model.dispose();
      this.models.delete(key);
    }
  }
}

/** Replaces a model's text with a single minimal edit so cursor and scroll position survive. */
export function replaceText(model: monaco.editor.ITextModel, text: string): void {
  const current = model.getValue();
  if (current === text) return;
  let start = 0;
  const max = Math.min(current.length, text.length);
  while (start < max && current.charCodeAt(start) === text.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    current.charCodeAt(current.length - 1 - end) === text.charCodeAt(text.length - 1 - end)
  ) {
    end++;
  }
  // Never split a surrogate pair or a CRLF.
  const splits = (s: string, i: number) =>
    i > 0 && i < s.length && ((s.charCodeAt(i - 1) & 0xfc00) === 0xd800 || (s[i - 1] === '\r' && s[i] === '\n'));
  while (start > 0 && (splits(current, start) || splits(text, start))) start--;
  while (end > 0 && (splits(current, current.length - end) || splits(text, text.length - end))) end--;
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(current.length - end);
  model.applyEdits([
    {
      range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
      text: text.slice(start, text.length - end),
    },
  ]);
}
