import type { Stop } from '../src/shared/protocol';
import { escapeHtml, formatRefs, stopLabel } from './format';
import {
  axisLabels,
  barsFor,
  clampIndex,
  computeLayout,
  indexAt,
  orderSelection,
  shiftSelection,
  xOf,
  type Layout,
} from './sliderModel';

export type Handle = 0 | 1;
export type InspectMode = 'hover' | 'drag' | 'focus';

export interface SliderEvents {
  select(selection: [string, string], source: 'drag' | 'keyboard' | 'click'): void;
  /** `source` says whether the button was clicked or a handle reached the oldest stop. */
  loadMore(all: boolean, source: 'button' | 'auto'): void;
  /** A stop is hovered, dragged or focused; `stop` is undefined when nothing is. */
  inspect(stop: Stop | undefined, anchorClientX: number, mode: InspectMode): void;
  /** Double-click on a stop. */
  activate(stop: Stop): void;
  dragChange(dragging: boolean): void;
}

const MIN_SPACING = 14;
const PAD_LEFT = 30;
const PAD_LEFT_MORE = 112;
const PAD_RIGHT = 44;
const BAR_MAX = 30;
const EDGE = 40;

export class Slider {
  readonly el: HTMLElement;
  private readonly scrollEl: HTMLElement;
  private readonly contentEl: HTMLElement;
  private readonly windowEl: HTMLElement;
  private readonly barsEl: HTMLElement;
  private readonly ticksEl: HTMLElement;
  private readonly axisEl: HTMLElement;
  private readonly hoverEl: HTMLElement;
  private readonly moreEl: HTMLButtonElement;
  private readonly handles: [HTMLElement, HTMLElement];

  private stops: Stop[] = [];
  private selection: [string, string] = ['', ''];
  private layout: Layout = computeLayout(0, 0, { minSpacing: MIN_SPACING, padLeft: PAD_LEFT, padRight: PAD_RIGHT });
  private hasMore = false;
  private loading = false;
  private drag?: { handle: Handle; pointerId: number; clientX: number };
  private autoScrollFrame = 0;
  private hoverIndex = -1;
  private active: Handle = 0;
  /** Why the pending "load more" was requested; decides where to scroll once it arrives. */
  private loadSource?: 'button' | 'auto';
  /**
   * How far the newest end is past the right edge of the view, as of the last
   * scroll. Resizing keeps it, so the handles stay in view when the panel narrows.
   */
  private beyondRight = 0;
  private barEls: (HTMLElement | undefined)[] = [];
  private tickEls: HTMLElement[] = [];
  /** Stops to point out (e.g. the commits that changed the selected file). */
  private marks?: ReadonlySet<string>;
  private moreLabel?: { html: string; title: string };

  constructor(private readonly events: SliderEvents) {
    this.el = document.createElement('section');
    this.el.className = 'timeline';
    this.el.innerHTML = `
      <div class="tl-scroll">
        <div class="tl-content">
          <div class="tl-window"></div>
          <div class="tl-bars"></div>
          <div class="tl-track"></div>
          <div class="tl-ticks"></div>
          <div class="tl-axis"></div>
          <div class="tl-hover"></div>
          <div class="tl-handle" data-handle="0" role="slider" tabindex="0"><div class="tl-handle-line"></div><div class="tl-handle-knob"></div></div>
          <div class="tl-handle" data-handle="1" role="slider" tabindex="0"><div class="tl-handle-line"></div><div class="tl-handle-knob"></div></div>
        </div>
      </div>
      <button class="tl-more" type="button"></button>`;
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;
    this.scrollEl = q('.tl-scroll');
    this.contentEl = q('.tl-content');
    this.windowEl = q('.tl-window');
    this.barsEl = q('.tl-bars');
    this.ticksEl = q('.tl-ticks');
    this.axisEl = q('.tl-axis');
    this.hoverEl = q('.tl-hover');
    this.moreEl = q<HTMLButtonElement>('.tl-more');
    const hs = this.el.querySelectorAll<HTMLElement>('.tl-handle');
    this.handles = [hs[0], hs[1]];

    this.contentEl.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.contentEl.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.contentEl.addEventListener('pointerup', (e) => this.endDrag(e));
    this.contentEl.addEventListener('pointercancel', (e) => this.endDrag(e));
    this.contentEl.addEventListener('lostpointercapture', (e) => this.endDrag(e));
    this.scrollEl.addEventListener('pointerleave', () => this.setHover(-1));
    this.contentEl.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.scrollEl.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.scrollEl.addEventListener('scroll', () => {
      if (!this.drag) this.setHover(-1);
      this.rememberScroll();
    });
    this.moreEl.addEventListener('click', (e) => {
      if (this.loading || !this.hasMore) return;
      this.loadSource = 'button';
      this.events.loadMore(e.shiftKey, 'button');
    });
    this.handles.forEach((h, i) => {
      h.addEventListener('keydown', (e) => this.onHandleKey(e, i as Handle));
      h.addEventListener('focus', () => {
        this.setActive(i as Handle);
        if (!this.drag) this.inspectHandle(i as Handle, 'focus');
      });
      h.addEventListener('blur', () => {
        if (!this.drag) this.events.inspect(undefined, 0, 'focus');
      });
    });
    new ResizeObserver(() => this.relayout()).observe(this.scrollEl);
  }

  // ---- public API ----

  setData(stops: Stop[], hasMore: boolean): void {
    const fromRight = this.contentEl.scrollWidth - this.scrollEl.scrollLeft;
    const previousCount = this.stops.length;
    this.stops = stops;
    this.hasMore = hasMore;
    this.renderAll();
    if (!previousCount) {
      this.scrollEl.scrollLeft = this.contentEl.scrollWidth;
    } else {
      // Keep the newest end anchored so prepending older commits does not move what you were
      // looking at (or the handle you are dragging).
      this.scrollEl.scrollLeft = this.contentEl.scrollWidth - fromRight;
      const added = stops.length - previousCount;
      if (added > 0 && this.loadSource === 'button') {
        // Asked for explicitly: bring the newly loaded commits into view.
        this.scrollEl.scrollLeft = Math.max(0, xOf(this.layout, added) - this.scrollEl.clientWidth * 0.7);
      }
      if (added > 0) this.loadSource = undefined;
    }
    this.rememberScroll();
    if (this.drag) this.updateFromPointer(this.drag.clientX);
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.renderMore();
  }

  setSelection(selection: [string, string], reveal = true): void {
    this.selection = [selection[0], selection[1]];
    this.renderSelection();
    if (reveal) this.reveal(this.active);
  }

  /** Replaces the "‹ Older" button's text, e.g. to name what clicking it extends the range to. */
  setMoreButton(label: { html: string; title: string } | undefined): void {
    this.moreLabel = label;
    this.renderMore();
  }

  /** Highlights these stops' ticks and dims the other bars; undefined clears it. */
  setMarks(ids: ReadonlySet<string> | undefined): void {
    this.marks = ids;
    this.renderMarks();
  }

  getSelection(): [string, string] {
    return [this.selection[0], this.selection[1]];
  }

  getActive(): Handle {
    return this.active;
  }

  setActive(handle: Handle): void {
    this.active = handle;
    this.renderSelection();
  }

  focusHandle(handle: Handle): void {
    this.handles[handle].focus();
  }

  isDragging(): boolean {
    return !!this.drag;
  }

  /** Moves the active handle by `delta` stops. */
  moveActive(delta: number): void {
    const i = this.indexOf(this.selection[this.active]);
    this.moveHandle(this.active, i + delta, 'keyboard');
  }

  /** Moves both handles by `delta`, keeping the distance between them. */
  shift(delta: number): void {
    const next = shiftSelection(this.stops, this.selection, delta);
    if (next[0] === this.selection[0] && next[1] === this.selection[1]) {
      if (delta < 0) this.maybeLoadMore();
      return;
    }
    this.selection = next;
    this.renderSelection();
    this.reveal(0);
    this.reveal(1);
    this.events.select(this.getSelection(), 'keyboard');
    if (Math.min(this.indexOf(next[0]), this.indexOf(next[1])) === 0) this.maybeLoadMore();
  }

  /** Client x coordinate of a stop, for anchoring popups. */
  clientXOf(stopId: string): number {
    const i = this.indexOf(stopId);
    return this.contentEl.getBoundingClientRect().left + xOf(this.layout, Math.max(0, i));
  }

  // ---- rendering ----

  private indexOf(id: string): number {
    return this.stops.findIndex((s) => s.id === id);
  }

  private relayout(): void {
    // By now the view already has its new width, so measure from before the resize.
    this.renderAll();
    this.scrollEl.scrollLeft = this.contentEl.scrollWidth - this.scrollEl.clientWidth - this.beyondRight;
    this.rememberScroll();
  }

  private rememberScroll(): void {
    this.beyondRight = Math.max(0, this.contentEl.scrollWidth - this.scrollEl.scrollLeft - this.scrollEl.clientWidth);
  }

  private renderAll(): void {
    const width = this.scrollEl.clientWidth;
    this.layout = computeLayout(this.stops.length, width, {
      minSpacing: MIN_SPACING,
      padLeft: this.hasMore ? PAD_LEFT_MORE : PAD_LEFT,
      padRight: PAD_RIGHT,
    });
    this.contentEl.style.width = `${this.layout.contentWidth}px`;
    const barWidth = Math.max(2, Math.min(8, Math.round(this.layout.spacing * 0.5) || 8));

    const bars = barsFor(this.stops, BAR_MAX);
    let barsHtml = '';
    let ticksHtml = '';
    this.stops.forEach((s, i) => {
      const x = xOf(this.layout, i);
      const b = bars[i];
      if (s.kind === 'commit') {
        const pct = Math.round(b.addedFraction * 100);
        const style = b.unknown
          ? ''
          : `background:linear-gradient(to top,var(--hs-added) 0 ${pct}%,var(--hs-deleted) ${pct}% 100%);`;
        barsHtml += `<div class="tl-bar${b.unknown ? ' unknown' : ''}" data-i="${i}" style="left:${x - barWidth / 2}px;width:${barWidth}px;height:${b.height.toFixed(1)}px;${style}"></div>`;
        if (s.forkOf?.length) {
          barsHtml += `<span class="tl-fork hsi hsi-git-branch" style="left:${x}px"></span>`;
        } else if (formatRefs(s.refs).some((r) => r.tag)) {
          barsHtml += `<span class="tl-tag hsi hsi-tag" style="left:${x}px"></span>`;
        }
      }
      const cls = s.kind === 'commit' ? (s.missing ? 'tl-tick deleted' : s.forkOf?.length ? 'tl-tick fork' : 'tl-tick') : `tl-tick ${s.kind}`;
      ticksHtml += `<div class="${cls}${s.dirty ? ' dirty' : ''}" style="left:${x}px"></div>`;
    });
    this.barsEl.innerHTML = barsHtml;
    this.barEls = [];
    this.barsEl.querySelectorAll<HTMLElement>('.tl-bar').forEach((el) => (this.barEls[Number(el.dataset.i)] = el));
    this.ticksEl.innerHTML = ticksHtml;
    this.tickEls = [...this.ticksEl.querySelectorAll<HTMLElement>('.tl-tick')];
    this.renderMarks();
    this.axisEl.innerHTML = axisLabels(this.stops, this.layout)
      .map(
        (l) =>
          `<span class="tl-label ${l.kind} ${l.align}" style="left:${l.x}px">${escapeHtml(l.text)}${
            l.kind === 'special' && this.stops[l.index].dirty ? ' •' : ''
          }</span>`,
      )
      .join('');
    this.renderMore();
    this.renderSelection();
    this.setHover(-1);
  }

  private renderMore(): void {
    this.moreEl.hidden = !this.hasMore;
    this.moreEl.disabled = this.loading;
    this.moreEl.innerHTML = this.loading
      ? '<span class="hsi hsi-loading hsi-modifier-spin"></span> Loading'
      : `<span class="hsi hsi-chevron-left"></span> ${this.moreLabel?.html ?? 'Older'}`;
    this.moreEl.title = this.moreLabel?.title ?? 'Load older commits (Shift+click loads the entire history)';
  }

  private renderMarks(): void {
    const marks = this.marks;
    this.el.classList.toggle('has-marks', !!marks);
    this.stops.forEach((s, i) => {
      const on = !!marks?.has(s.id);
      this.tickEls[i]?.classList.toggle('mark', on);
      this.barEls[i]?.classList.toggle('mark', on);
    });
  }

  private renderSelection(): void {
    if (!this.stops.length) {
      this.handles.forEach((h) => (h.hidden = true));
      this.windowEl.hidden = true;
      return;
    }
    const ord = orderSelection(this.stops, this.selection);
    const oldX = xOf(this.layout, ord.oldIndex);
    const newX = xOf(this.layout, ord.newIndex);
    // Light up the commits whose changes are part of the diff.
    this.barEls.forEach((el, i) => el?.classList.toggle('in', i > ord.oldIndex && i <= ord.newIndex));
    this.windowEl.hidden = false;
    this.windowEl.style.left = `${oldX}px`;
    this.windowEl.style.width = `${Math.max(0, newX - oldX)}px`;
    this.handles.forEach((el, h) => {
      const i = Math.max(0, this.indexOf(this.selection[h]));
      const stop = this.stops[i];
      const isOld = ord.oldHandle === h;
      el.hidden = false;
      el.style.left = `${xOf(this.layout, i)}px`;
      el.classList.toggle('is-old', isOld);
      el.classList.toggle('is-new', !isOld);
      el.classList.toggle('is-active', this.active === h);
      el.classList.toggle('is-same', ord.oldIndex === ord.newIndex);
      el.setAttribute('aria-label', isOld ? 'Old revision' : 'New revision');
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', String(this.stops.length - 1));
      el.setAttribute('aria-valuenow', String(i));
      el.setAttribute('aria-valuetext', `${stopLabel(stop)} ${stop.kind === 'commit' ? stop.subject : ''}`.trim());
    });
  }

  private setHover(index: number): void {
    const was = this.hoverIndex;
    this.hoverIndex = index;
    if (index < 0 || this.drag) {
      this.hoverEl.hidden = true;
      // Only report the end of a hover; otherwise re-renders and scrolling would hide a
      // card that is showing for the focused handle.
      if (!this.drag && index < 0 && was >= 0) this.events.inspect(undefined, 0, 'hover');
      return;
    }
    this.hoverEl.hidden = false;
    this.hoverEl.style.left = `${xOf(this.layout, index)}px`;
    this.events.inspect(this.stops[index], this.clientXOf(this.stops[index].id), 'hover');
  }

  private reveal(handle: Handle): void {
    const i = this.indexOf(this.selection[handle]);
    if (i < 0) return;
    const x = xOf(this.layout, i);
    const view = this.scrollEl;
    const margin = 60;
    // Keep clear of the pinned "Older" button on the left.
    const left = this.hasMore ? PAD_LEFT_MORE : margin;
    if (x < view.scrollLeft + left) view.scrollLeft = Math.max(0, x - left);
    else if (x > view.scrollLeft + view.clientWidth - margin) view.scrollLeft = x - view.clientWidth + margin;
  }

  // ---- interaction ----

  private indexAtClient(clientX: number): number {
    return indexAt(this.layout, clientX - this.contentEl.getBoundingClientRect().left);
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.stops.length) return;
    const target = e.target as HTMLElement;
    if (target.closest('.tl-more')) return;
    e.preventDefault();
    const handleEl = target.closest<HTMLElement>('.tl-handle');
    let handle: Handle;
    if (handleEl) {
      handle = Number(handleEl.dataset.handle) as Handle;
    } else {
      // Grab whichever handle is closer to the click, then treat it as a drag.
      const i = this.indexAtClient(e.clientX);
      const d0 = Math.abs(this.indexOf(this.selection[0]) - i);
      const d1 = Math.abs(this.indexOf(this.selection[1]) - i);
      handle = d0 === d1 ? this.active : d0 < d1 ? 0 : 1;
    }
    this.drag = { handle, pointerId: e.pointerId, clientX: e.clientX };
    this.contentEl.setPointerCapture(e.pointerId);
    this.el.classList.add('dragging');
    this.hoverEl.hidden = true;
    this.active = handle;
    this.handles[handle].focus({ preventScroll: true });
    this.events.dragChange(true);
    this.updateFromPointer(e.clientX, handleEl ? 'drag' : 'click');
    this.autoScroll();
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.drag) {
      if (e.pointerId !== this.drag.pointerId) return;
      this.drag.clientX = e.clientX;
      this.updateFromPointer(e.clientX, 'drag');
      return;
    }
    if (!this.stops.length || (e.target as HTMLElement).closest('.tl-more')) {
      this.setHover(-1);
      return;
    }
    const i = this.indexAtClient(e.clientX);
    const dx = Math.abs(e.clientX - this.clientXOf(this.stops[i].id));
    const index = dx <= Math.max(10, this.layout.spacing / 2) ? i : -1;
    if (index !== this.hoverIndex) this.setHover(index);
  }

  private endDrag(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const handle = this.drag.handle;
    this.drag = undefined;
    cancelAnimationFrame(this.autoScrollFrame);
    if (this.contentEl.hasPointerCapture(e.pointerId)) this.contentEl.releasePointerCapture(e.pointerId);
    this.el.classList.remove('dragging');
    this.events.dragChange(false);
    this.inspectHandle(handle, 'focus');
  }

  private updateFromPointer(clientX: number, source: 'drag' | 'click' = 'drag'): void {
    if (!this.drag || !this.stops.length) return;
    const handle = this.drag.handle;
    const i = this.indexAtClient(clientX);
    const id = this.stops[i].id;
    if (this.selection[handle] !== id) {
      this.selection[handle] = id;
      this.renderSelection();
      this.events.select(this.getSelection(), source);
    }
    this.inspectHandle(handle, 'drag');
    if (i === 0) this.maybeLoadMore();
  }

  private inspectHandle(handle: Handle, mode: InspectMode): void {
    const id = this.selection[handle];
    const stop = this.stops[this.indexOf(id)];
    if (stop) this.events.inspect(stop, this.clientXOf(id), mode);
  }

  private maybeLoadMore(): void {
    if (!this.hasMore || this.loading) return;
    this.loadSource = 'auto';
    this.events.loadMore(false, 'auto');
  }

  /** While dragging near an edge, keep scrolling the timeline in that direction. */
  private autoScroll(): void {
    cancelAnimationFrame(this.autoScrollFrame);
    const step = () => {
      if (!this.drag) return;
      const rect = this.scrollEl.getBoundingClientRect();
      const x = this.drag.clientX;
      let delta = 0;
      if (x < rect.left + EDGE) delta = -Math.ceil(((rect.left + EDGE - x) / EDGE) * 16);
      else if (x > rect.right - EDGE) delta = Math.ceil(((x - (rect.right - EDGE)) / EDGE) * 16);
      if (delta) {
        const before = this.scrollEl.scrollLeft;
        this.scrollEl.scrollLeft = before + delta;
        if (this.scrollEl.scrollLeft !== before) this.updateFromPointer(x);
      }
      this.autoScrollFrame = requestAnimationFrame(step);
    };
    this.autoScrollFrame = requestAnimationFrame(step);
  }

  private onDoubleClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.tl-more') || !this.stops.length) return;
    this.events.activate(this.stops[this.indexAtClient(e.clientX)]);
  }

  private onWheel(e: WheelEvent): void {
    const view = this.scrollEl;
    if (view.scrollWidth <= view.clientWidth || e.ctrlKey) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    e.preventDefault();
    view.scrollLeft += delta;
  }

  private onHandleKey(e: KeyboardEvent, handle: Handle): void {
    const i = this.indexOf(this.selection[handle]);
    let next: number;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        if (e.shiftKey) {
          e.preventDefault();
          this.shift(-1);
          return;
        }
        next = i - 1;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        if (e.shiftKey) {
          e.preventDefault();
          this.shift(1);
          return;
        }
        next = i + 1;
        break;
      case 'PageDown':
        next = i - 10;
        break;
      case 'PageUp':
        next = i + 10;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = this.stops.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.moveHandle(handle, next, 'keyboard');
  }

  private moveHandle(handle: Handle, index: number, source: 'keyboard' | 'click'): void {
    if (!this.stops.length) return;
    if (index < 0) this.maybeLoadMore();
    const i = clampIndex(this.stops, index);
    this.active = handle;
    const id = this.stops[i].id;
    if (this.selection[handle] !== id) {
      this.selection[handle] = id;
      this.events.select(this.getSelection(), source);
    }
    this.renderSelection();
    this.reveal(handle);
    this.inspectHandle(handle, 'focus');
    if (i === 0) this.maybeLoadMore();
  }
}
