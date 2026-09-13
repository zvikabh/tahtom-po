// Main editor: a paged document (image = 1 page, PDF = N pages) shown as a
// scrollable vertical stack. Handles placement/select modes, undo/redo,
// PNG/PDF export, clipboard, image/PDF loading, and the unsaved-changes guard.
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { signOut } from '../auth';
import { createToolbar } from './toolbar';
import { createStampsPane } from './pane';
import { createSvgElement, drawElementsToCanvas, type Stamp } from '../stamps/render';
import { buildStampedPdf } from '../export/pdf';
import { showToast } from '../ui';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const DEFAULT_SCALE = 0.75; // initial placement = 75% of drawn size
const SCALE_STEP = 1.1; // 10% per step
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
const PDF_DPI = 150;
const CANVAS_PADDING = 48; // px reserved around pages when fitting width

interface Page {
  canvas: HTMLCanvasElement; // rasterized page at PDF_DPI
  width: number; // device px
  height: number;
}
interface DocModel {
  kind: 'image' | 'pdf';
  pages: Page[];
  pdfBytes: Uint8Array | null; // original PDF for overlay export (pdf only)
}
interface PlacedStamp {
  stampId: string;
  pageIndex: number;
  x: number; // page px (top-left origin)
  y: number;
  scale: number;
}
interface DocState {
  doc: DocModel | null;
  stamps: PlacedStamp[];
}

type Mode = 'idle' | 'placement' | 'select';

// Global listeners are de-registered before a remount (e.g. sign-out then
// sign-in) so they don't stack up on stale editor instances.
let activeKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let activeBeforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
let activeResizeHandler: (() => void) | null = null;

export function mountEditor(container: HTMLElement, uid: string): void {
  // ---- State ----
  let current: DocState = { doc: null, stamps: [] };
  const undoStack: DocState[] = [];
  const redoStack: DocState[] = [];
  let isDirty = false;

  let mode: Mode = 'idle';
  let placement: { stamp: Stamp; scale: number } | null = null;
  let selectedIndex = -1;

  // Display scale (fit-to-width); page-space px * dispScale = on-screen px.
  let dispScale = 1;
  // render() rebuilds the page DOM (resetting scroll); it preserves the scroll
  // position unless this flag asks for a reset (a fresh document).
  let resetScrollOnNextRender = false;

  const stampCache = new Map<string, Stamp>();
  const overlayNodes: (SVGSVGElement | undefined)[] = [];
  const pageEls: HTMLElement[] = [];

  // Placement preview.
  let previewEl: SVGSVGElement | null = null;
  let hoverPageIndex = -1;
  let hoverCursorDisp: [number, number] = [0, 0]; // display px within page

  // ---- Layout ----
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'editor-root d-flex flex-column';
  container.appendChild(wrap);

  const toolbar = createToolbar({
    open: openFile,
    save: save,
    undo: undo,
    redo: redo,
    copy: copy,
    paste: paste,
    toggleSelect: toggleSelect,
    enlarge: enlarge,
    shrink: shrink,
    signOut: () => void signOut(),
  });
  wrap.appendChild(toolbar.el);

  const body = document.createElement('div');
  body.className = 'editor-body d-flex flex-grow-1';
  wrap.appendChild(body);

  const canvasArea = document.createElement('div');
  canvasArea.className = 'editor-canvas-area flex-grow-1';
  body.appendChild(canvasArea);

  const emptyState = document.createElement('div');
  emptyState.className = 'editor-empty';
  emptyState.textContent = 'העלו או הדביקו כאן תמונה כדי להתחיל';
  canvasArea.appendChild(emptyState);

  const pagesContainer = document.createElement('div');
  pagesContainer.className = 'editor-pages';
  pagesContainer.style.display = 'none';
  canvasArea.appendChild(pagesContainer);

  const pane = createStampsPane(uid, {
    onPick: enterPlacement,
    onStampsLoaded: (stamps) => {
      for (const s of stamps) stampCache.set(s.id, s);
      render();
    },
    onStampAdded: (stamp) => {
      if (current.doc) enterPlacement(stamp);
    },
  });
  // Insert the pane before the canvas area so that, under RTL, it sits on the
  // right (the first flex item is at the start = right edge in RTL).
  body.insertBefore(pane.el, canvasArea);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*,application/pdf';
  fileInput.style.display = 'none';
  container.appendChild(fileInput);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void loadFile(f);
  });

  // ---- State helpers ----
  function cloneState(s: DocState): DocState {
    return { doc: s.doc, stamps: s.stamps.map((p) => ({ ...p })) };
  }
  function applyChange(mutate: () => void) {
    undoStack.push(cloneState(current));
    redoStack.length = 0;
    mutate();
    isDirty = true;
    afterChange();
  }
  function afterChange() {
    if (selectedIndex >= current.stamps.length) selectedIndex = -1;
    render();
    updateToolbar();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(cloneState(current));
    current = undoStack.pop()!;
    isDirty = true;
    selectedIndex = -1;
    afterChange();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(cloneState(current));
    current = redoStack.pop()!;
    isDirty = true;
    selectedIndex = -1;
    afterChange();
  }
  function updateToolbar() {
    toolbar.setUndoEnabled(undoStack.length > 0);
    toolbar.setRedoEnabled(redoStack.length > 0);
    toolbar.setResizeEnabled(mode === 'placement');
    toolbar.setSelectActive(mode === 'select');
    const multiPage = !!current.doc && current.doc.pages.length > 1;
    toolbar.setCopyEnabled(
      !!current.doc && !multiPage,
      multiPage
        ? "לא ניתן להעתיק PDF מרובה עמודים; השתמשו בכפתור 'שמירה'"
        : 'העתקה',
    );
  }

  function setDocument(doc: DocModel) {
    cancelPlacement();
    selectedIndex = -1;
    if (mode === 'select') mode = 'idle';
    resetScrollOnNextRender = true; // a new document starts scrolled to the top
    applyChange(() => {
      current.doc = doc;
      current.stamps = [];
    });
  }

  // ---- Rendering ----
  function computeDispScale(): number {
    if (!current.doc || current.doc.pages.length === 0) return 1;
    const maxW = Math.max(...current.doc.pages.map((p) => p.width));
    const avail = canvasArea.clientWidth - CANVAS_PADDING;
    if (avail <= 0 || maxW <= 0) return 1;
    return Math.min(1, avail / maxW);
  }

  function makeStampSvg(stamp: Stamp, scale: number): SVGSVGElement {
    const svg = createSvgElement(stamp.elements, stamp.width, stamp.height);
    svg.setAttribute('width', String(stamp.width * scale * dispScale));
    svg.setAttribute('height', String(stamp.height * scale * dispScale));
    return svg;
  }

  function render() {
    const savedScrollTop = canvasArea.scrollTop;
    const savedScrollLeft = canvasArea.scrollLeft;
    overlayNodes.length = 0;
    pageEls.length = 0;
    pagesContainer.innerHTML = '';

    if (!current.doc) {
      pagesContainer.style.display = 'none';
      emptyState.style.display = 'flex';
      return;
    }
    emptyState.style.display = 'none';
    pagesContainer.style.display = 'flex';
    dispScale = computeDispScale();

    current.doc.pages.forEach((page, pageIndex) => {
      const pageEl = document.createElement('div');
      pageEl.className = 'editor-page';
      pageEl.style.width = `${page.width * dispScale}px`;
      pageEl.style.height = `${page.height * dispScale}px`;

      const canvas = page.canvas;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      pageEl.appendChild(canvas);

      if (current.doc!.pages.length > 1) {
        const num = document.createElement('div');
        num.className = 'editor-page-num';
        num.textContent = `${pageIndex + 1} / ${current.doc!.pages.length}`;
        pageEl.appendChild(num);
      }

      attachPageHandlers(pageEl, pageIndex);
      pageEls[pageIndex] = pageEl;
      pagesContainer.appendChild(pageEl);
    });

    // Placed stamp overlays.
    current.stamps.forEach((ps, i) => {
      const stamp = stampCache.get(ps.stampId);
      const pageEl = pageEls[ps.pageIndex];
      if (!stamp || !pageEl) return;
      const node = makeStampSvg(stamp, ps.scale);
      node.classList.add('placed-stamp');
      node.style.position = 'absolute';
      node.style.left = `${ps.x * dispScale}px`;
      node.style.top = `${ps.y * dispScale}px`;
      node.style.pointerEvents = mode === 'select' ? 'auto' : 'none';
      if (i === selectedIndex) node.classList.add('selected');
      if (mode === 'select') attachDrag(node, i);
      overlayNodes[i] = node;
      pageEl.appendChild(node);
    });

    // Recreate the placement preview (its parent page was just rebuilt).
    if (placement) {
      previewEl = makeStampSvg(placement.stamp, placement.scale);
      previewEl.classList.add('stamp-preview');
      previewEl.style.position = 'absolute';
      previewEl.style.pointerEvents = 'none';
      previewEl.style.display = 'none';
      updatePreview();
    } else {
      previewEl = null;
    }

    // Keep the viewport where it was (a rebuild otherwise jumps to the top),
    // unless a fresh document asked to reset.
    if (resetScrollOnNextRender) {
      canvasArea.scrollTop = 0;
      canvasArea.scrollLeft = 0;
      resetScrollOnNextRender = false;
    } else {
      canvasArea.scrollTop = savedScrollTop;
      canvasArea.scrollLeft = savedScrollLeft;
    }
  }

  function updateSelectionClasses() {
    overlayNodes.forEach((node, i) => {
      if (node) node.classList.toggle('selected', i === selectedIndex);
    });
  }

  // ---- Placement mode ----
  function enterPlacement(stamp: Stamp) {
    if (!current.doc) {
      showToast('פתחו או הדביקו תמונה לפני הוספת חותמת.', 'warning');
      return;
    }
    if (mode === 'select') mode = 'idle';
    selectedIndex = -1;
    mode = 'placement';
    placement = { stamp, scale: DEFAULT_SCALE };
    render();
    updateToolbar();
  }
  function cancelPlacement() {
    if (mode !== 'placement') return;
    mode = 'idle';
    placement = null;
    render();
    updateToolbar();
  }
  function updatePreview() {
    if (!placement || !previewEl) return;
    const pageEl = pageEls[hoverPageIndex];
    if (hoverPageIndex < 0 || !pageEl) {
      previewEl.style.display = 'none';
      return;
    }
    const w = placement.stamp.width * placement.scale * dispScale;
    const h = placement.stamp.height * placement.scale * dispScale;
    previewEl.setAttribute('width', String(w));
    previewEl.setAttribute('height', String(h));
    if (previewEl.parentElement !== pageEl) pageEl.appendChild(previewEl);
    previewEl.style.left = `${hoverCursorDisp[0] - w / 2}px`;
    previewEl.style.top = `${hoverCursorDisp[1] - h / 2}px`;
    previewEl.style.display = 'block';
  }
  function enlarge() {
    if (mode !== 'placement' || !placement) return;
    placement.scale = Math.min(MAX_SCALE, placement.scale * SCALE_STEP);
    updatePreview();
  }
  function shrink() {
    if (mode !== 'placement' || !placement) return;
    placement.scale = Math.max(MIN_SCALE, placement.scale / SCALE_STEP);
    updatePreview();
  }

  function attachPageHandlers(pageEl: HTMLElement, pageIndex: number) {
    pageEl.addEventListener('pointermove', (e) => {
      if (mode !== 'placement' || !placement) return;
      const r = pageEl.getBoundingClientRect();
      hoverPageIndex = pageIndex;
      hoverCursorDisp = [e.clientX - r.left, e.clientY - r.top];
      updatePreview();
    });
    pageEl.addEventListener('click', (e) => {
      if (mode === 'placement' && placement) {
        const r = pageEl.getBoundingClientRect();
        const px = (e.clientX - r.left) / dispScale;
        const py = (e.clientY - r.top) / dispScale;
        const sw = placement.stamp.width * placement.scale;
        const sh = placement.stamp.height * placement.scale;
        const stampId = placement.stamp.id;
        const scale = placement.scale;
        const x = px - sw / 2;
        const y = py - sh / 2;
        cancelPlacement();
        applyChange(() =>
          current.stamps.push({ stampId, pageIndex, x, y, scale }),
        );
      } else if (mode === 'select' && e.target instanceof HTMLCanvasElement) {
        selectedIndex = -1;
        updateSelectionClasses();
      }
    });
  }

  // ---- Select / drag ----
  function attachDrag(node: SVGSVGElement, index: number) {
    node.addEventListener('pointerdown', (e) => {
      if (mode !== 'select') return;
      e.preventDefault();
      selectedIndex = index;
      updateSelectionClasses();

      const pre = cloneState(current);
      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const startX = current.stamps[index].x;
      const startY = current.stamps[index].y;
      let moved = false;
      node.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dxDisp = ev.clientX - startClientX;
        const dyDisp = ev.clientY - startClientY;
        if (Math.abs(dxDisp) > 1 || Math.abs(dyDisp) > 1) moved = true;
        current.stamps[index].x = startX + dxDisp / dispScale;
        current.stamps[index].y = startY + dyDisp / dispScale;
        node.style.left = `${current.stamps[index].x * dispScale}px`;
        node.style.top = `${current.stamps[index].y * dispScale}px`;
      };
      const onUp = (ev: PointerEvent) => {
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        try {
          node.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        if (moved) {
          undoStack.push(pre);
          redoStack.length = 0;
          isDirty = true;
          updateToolbar();
        }
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
    });
  }

  function toggleSelect() {
    if (mode === 'placement') cancelPlacement();
    mode = mode === 'select' ? 'idle' : 'select';
    if (mode !== 'select') selectedIndex = -1;
    render();
    updateToolbar();
  }

  function deleteSelected() {
    if (mode !== 'select' || selectedIndex < 0) return;
    const i = selectedIndex;
    selectedIndex = -1;
    applyChange(() => current.stamps.splice(i, 1));
  }

  // ---- Keyboard ----
  if (activeKeydownHandler) {
    window.removeEventListener('keydown', activeKeydownHandler);
  }
  const onKeydown = (e: KeyboardEvent) => {
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    const accel = e.ctrlKey || e.metaKey;
    if (accel && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      if (key === 'c') {
        e.preventDefault();
        void copy();
        return;
      } else if (key === 'v') {
        e.preventDefault();
        void paste();
        return;
      } else if (key === 's') {
        e.preventDefault();
        void save();
        return;
      } else if (key === 'o') {
        e.preventDefault();
        openFile();
        return;
      }
    }

    if (mode === 'placement') {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        enlarge();
      } else if (e.key === '-') {
        e.preventDefault();
        shrink();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelPlacement();
      }
    } else if (mode === 'select') {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected();
      }
    }
  };
  window.addEventListener('keydown', onKeydown);
  activeKeydownHandler = onKeydown;

  // Re-fit pages to the available width when the window resizes.
  if (activeResizeHandler) window.removeEventListener('resize', activeResizeHandler);
  const onResize = () => {
    if (current.doc) render();
  };
  window.addEventListener('resize', onResize);
  activeResizeHandler = onResize;

  // ---- Loading images / PDFs ----
  function openFile() {
    fileInput.click();
  }

  async function loadFile(file: File) {
    try {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        await loadPdf(file);
      } else {
        await loadImageFile(file);
      }
    } catch {
      showToast('טעינת הקובץ נכשלה.', 'danger');
    }
  }

  async function loadImageFile(file: File) {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    setDocument({
      kind: 'image',
      pages: [{ canvas: c, width: c.width, height: c.height }],
      pdfBytes: null,
    });
  }

  async function loadPdf(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // pdf.js may detach the buffer it's given, so hand it a copy and keep the
    // pristine bytes for export. disableFontFace renders glyph outlines directly
    // to the canvas, avoiding font-loading stalls during rasterization.
    const pdf = await pdfjsLib.getDocument({
      data: bytes.slice(),
      disableFontFace: true,
      // base-14 standard font data (served from public/), so PDFs that don't
      // embed their fonts still render correctly.
      standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
    }).promise;
    const pages: Page[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: PDF_DPI / 72 });
      const c = document.createElement('canvas');
      c.width = Math.ceil(viewport.width);
      c.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: c.getContext('2d')!, viewport }).promise;
      pages.push({ canvas: c, width: c.width, height: c.height });
    }
    setDocument({ kind: 'pdf', pages, pdfBytes: bytes });
  }

  async function paste() {
    if (!navigator.clipboard?.read) {
      showToast('הדפדפן אינו תומך בהדבקה מהלוח.', 'danger');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          const bmp = await createImageBitmap(blob);
          const c = document.createElement('canvas');
          c.width = bmp.width;
          c.height = bmp.height;
          c.getContext('2d')!.drawImage(bmp, 0, 0);
          bmp.close();
          setDocument({
            kind: 'image',
            pages: [{ canvas: c, width: c.width, height: c.height }],
            pdfBytes: null,
          });
          return;
        }
      }
      showToast('הלוח אינו מכיל תמונה.', 'warning');
    } catch {
      showToast('לא ניתן לקרוא מהלוח. ודאו שאישרתם גישה ללוח.', 'danger');
    }
  }

  // ---- Export ----
  // Flatten one page (its raster + stamps) to a new canvas at native px.
  function flattenPage(i: number): HTMLCanvasElement | null {
    if (!current.doc) return null;
    const page = current.doc.pages[i];
    const c = document.createElement('canvas');
    c.width = page.width;
    c.height = page.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(page.canvas, 0, 0);
    for (const ps of current.stamps) {
      if (ps.pageIndex !== i) continue;
      const stamp = stampCache.get(ps.stampId);
      if (!stamp) continue;
      ctx.save();
      ctx.translate(ps.x, ps.y);
      ctx.scale(ps.scale, ps.scale);
      drawElementsToCanvas(ctx, stamp.elements);
      ctx.restore();
    }
    return c;
  }

  function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      c.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
        'image/png',
      );
    });
  }

  function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function save() {
    if (!current.doc) {
      showToast('אין מסמך לשמירה.', 'warning');
      return;
    }
    await document.fonts.ready;
    if (current.doc.kind === 'pdf') {
      try {
        const blob = await buildStampedPdf(
          current.doc.pages,
          current.doc.pdfBytes ? current.doc.pdfBytes.slice() : null,
          current.stamps,
          (id) => stampCache.get(id),
          PDF_DPI,
        );
        downloadBlob(blob, 'tahtom-po.pdf');
      } catch {
        showToast('יצירת קובץ ה-PDF נכשלה.', 'danger');
        return;
      }
    } else {
      const c = flattenPage(0);
      if (!c) return;
      downloadBlob(await canvasToBlob(c), 'tahtom-po.png');
    }
    isDirty = false;
  }

  async function copy() {
    if (!current.doc) {
      showToast('אין מסמך להעתקה.', 'warning');
      return;
    }
    if (current.doc.pages.length > 1) {
      showToast(
        "לא ניתן להעתיק PDF מרובה עמודים ללוח; השתמשו בכפתור 'שמירה'.",
        'warning',
      );
      return;
    }
    if (!navigator.clipboard?.write) {
      showToast('הדפדפן אינו תומך בהעתקה ללוח.', 'danger');
      return;
    }
    await document.fonts.ready;
    const c = flattenPage(0);
    if (!c) return;
    try {
      const blob = await canvasToBlob(c);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      isDirty = false;
      showToast('התמונה הועתקה ללוח.', 'success');
    } catch {
      showToast('ההעתקה ללוח נכשלה.', 'danger');
    }
  }

  // ---- Unsaved-changes guard ----
  if (activeBeforeUnloadHandler) {
    window.removeEventListener('beforeunload', activeBeforeUnloadHandler);
  }
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (current.doc && isDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  activeBeforeUnloadHandler = onBeforeUnload;

  // Initial paint.
  render();
  updateToolbar();
}
