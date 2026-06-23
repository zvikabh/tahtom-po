// Main editor: document canvas, placement/select modes, undo/redo, export,
// clipboard, PDF/image loading, and the unsaved-changes guard.
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { signOut } from '../auth';
import { createToolbar } from './toolbar';
import { createStampsPane } from './pane';
import {
  createSvgElement,
  drawElementsToCanvas,
  type Stamp,
} from '../stamps/render';
import { showToast } from '../ui';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const DEFAULT_SCALE = 0.75; // initial placement = 75% of drawn size
const SCALE_STEP = 1.1; // 10% per step
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
const PDF_DPI = 150;

interface PlacedStamp {
  stampId: string;
  x: number;
  y: number;
  scale: number;
}
interface Background {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}
interface DocState {
  background: Background | null;
  stamps: PlacedStamp[];
}

type Mode = 'idle' | 'placement' | 'select';

// Global listeners are de-registered before a remount (e.g. sign-out then
// sign-in) so they don't stack up on stale editor instances.
let activeKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let activeBeforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

export function mountEditor(container: HTMLElement, uid: string): void {
  // ---- State ----
  let current: DocState = { background: null, stamps: [] };
  const undoStack: DocState[] = [];
  const redoStack: DocState[] = [];
  let isDirty = false;

  let mode: Mode = 'idle';
  let placement: { stamp: Stamp; scale: number } | null = null;
  let lastCursor: [number, number] = [0, 0];
  let selectedIndex = -1;

  const stampCache = new Map<string, Stamp>();
  const overlayNodes: SVGSVGElement[] = [];

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

  const docInner = document.createElement('div');
  docInner.className = 'editor-doc';
  docInner.style.display = 'none';
  canvasArea.appendChild(docInner);

  const pane = createStampsPane(uid, {
    onPick: enterPlacement,
    onStampsLoaded: (stamps) => {
      for (const s of stamps) stampCache.set(s.id, s);
      render();
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
    return { background: s.background, stamps: s.stamps.map((p) => ({ ...p })) };
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
  }

  function setBackground(canvas: HTMLCanvasElement) {
    cancelPlacement();
    selectedIndex = -1;
    if (mode === 'select') mode = 'idle';
    applyChange(() => {
      current.background = { canvas, width: canvas.width, height: canvas.height };
      current.stamps = [];
    });
  }

  // ---- Rendering ----
  function makeStampSvg(stamp: Stamp, scale: number): SVGSVGElement {
    const svg = createSvgElement(stamp.elements, stamp.width, stamp.height);
    svg.setAttribute('width', String(stamp.width * scale));
    svg.setAttribute('height', String(stamp.height * scale));
    return svg;
  }

  function render() {
    overlayNodes.length = 0;
    docInner.innerHTML = '';

    if (!current.background) {
      docInner.style.display = 'none';
      emptyState.style.display = 'flex';
      return;
    }
    emptyState.style.display = 'none';
    docInner.style.display = 'block';
    docInner.style.width = `${current.background.width}px`;
    docInner.style.height = `${current.background.height}px`;
    docInner.appendChild(current.background.canvas);

    current.stamps.forEach((ps, i) => {
      const stamp = stampCache.get(ps.stampId);
      if (!stamp) return;
      const node = makeStampSvg(stamp, ps.scale);
      node.classList.add('placed-stamp');
      node.style.position = 'absolute';
      node.style.left = `${ps.x}px`;
      node.style.top = `${ps.y}px`;
      node.style.pointerEvents = mode === 'select' ? 'auto' : 'none';
      if (i === selectedIndex) node.classList.add('selected');
      if (mode === 'select') attachDrag(node, i);
      overlayNodes[i] = node;
      docInner.appendChild(node);
    });

    if (placement) {
      const preview = makeStampSvg(placement.stamp, placement.scale);
      preview.classList.add('stamp-preview');
      preview.style.position = 'absolute';
      preview.style.pointerEvents = 'none';
      preview.style.display = 'none';
      docInner.appendChild(preview);
      previewEl = preview;
      positionPreview();
    } else {
      previewEl = null;
    }
  }

  function updateSelectionClasses() {
    overlayNodes.forEach((node, i) => {
      if (node) node.classList.toggle('selected', i === selectedIndex);
    });
  }

  // ---- Placement mode ----
  let previewEl: SVGSVGElement | null = null;

  function enterPlacement(stamp: Stamp) {
    if (!current.background) {
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
  function positionPreview() {
    if (!previewEl || !placement) return;
    const w = placement.stamp.width * placement.scale;
    const h = placement.stamp.height * placement.scale;
    previewEl.style.left = `${lastCursor[0] - w / 2}px`;
    previewEl.style.top = `${lastCursor[1] - h / 2}px`;
    previewEl.style.display = 'block';
  }
  function enlarge() {
    if (mode !== 'placement' || !placement) return;
    placement.scale = Math.min(MAX_SCALE, placement.scale * SCALE_STEP);
    render();
  }
  function shrink() {
    if (mode !== 'placement' || !placement) return;
    placement.scale = Math.max(MIN_SCALE, placement.scale / SCALE_STEP);
    render();
  }

  docInner.addEventListener('pointermove', (e) => {
    if (mode !== 'placement' || !placement) return;
    const r = docInner.getBoundingClientRect();
    lastCursor = [e.clientX - r.left, e.clientY - r.top];
    positionPreview();
  });

  docInner.addEventListener('click', (e) => {
    if (mode === 'placement' && placement) {
      const r = docInner.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const sw = placement.stamp.width * placement.scale;
      const sh = placement.stamp.height * placement.scale;
      const stampId = placement.stamp.id;
      const scale = placement.scale;
      const x = cx - sw / 2;
      const y = cy - sh / 2;
      cancelPlacement();
      applyChange(() => current.stamps.push({ stampId, x, y, scale }));
    } else if (mode === 'select' && e.target === current.background?.canvas) {
      selectedIndex = -1;
      updateSelectionClasses();
    }
  });

  // ---- Select / drag ----
  function attachDrag(node: SVGSVGElement, index: number) {
    node.addEventListener('pointerdown', (e) => {
      if (mode !== 'select') return;
      e.preventDefault();
      selectedIndex = index;
      updateSelectionClasses();

      const pre = cloneState(current);
      const r = docInner.getBoundingClientRect();
      const startPx = e.clientX - r.left;
      const startPy = e.clientY - r.top;
      const startX = current.stamps[index].x;
      const startY = current.stamps[index].y;
      let moved = false;
      node.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - r.left - startPx;
        const dy = ev.clientY - r.top - startPy;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
        current.stamps[index].x = startX + dx;
        current.stamps[index].y = startY + dy;
        node.style.left = `${current.stamps[index].x}px`;
        node.style.top = `${current.stamps[index].y}px`;
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

    // Ctrl (Windows/Linux) or Cmd (Mac) shortcuts.
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
    setBackground(c);
  }

  async function loadPdf(file: File) {
    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: PDF_DPI / 72 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(viewport.width);
    c.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: c.getContext('2d')!, viewport }).promise;
    setBackground(c);
    if (pdf.numPages > 1) {
      showToast('הקובץ מכיל כמה עמודים; נטען העמוד הראשון בלבד.', 'info');
    }
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
          setBackground(c);
          return;
        }
      }
      showToast('הלוח אינו מכיל תמונה.', 'warning');
    } catch {
      showToast('לא ניתן לקרוא מהלוח. ודאו שאישרתם גישה ללוח.', 'danger');
    }
  }

  // ---- Export ----
  async function flatten(): Promise<HTMLCanvasElement | null> {
    if (!current.background) {
      showToast('אין תמונה לשמירה.', 'warning');
      return null;
    }
    await document.fonts.ready;
    const c = document.createElement('canvas');
    c.width = current.background.width;
    c.height = current.background.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(current.background.canvas, 0, 0);
    for (const ps of current.stamps) {
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
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
  }

  async function save() {
    const c = await flatten();
    if (!c) return;
    const blob = await canvasToBlob(c);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tahtom-po.png';
    a.click();
    URL.revokeObjectURL(url);
    isDirty = false;
  }

  async function copy() {
    if (!navigator.clipboard?.write) {
      showToast('הדפדפן אינו תומך בהעתקה ללוח.', 'danger');
      return;
    }
    const c = await flatten();
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
    if (current.background && isDirty) {
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
