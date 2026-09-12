// Modal for drawing a new stamp. Resolves to the normalized stamp data
// (elements translated so the bounding box starts at 0,0) or null if cancelled.
import { Modal } from 'bootstrap';
import {
  STAMP_COLOR,
  type StampElement,
  type StampFont,
  fontFamily,
  createSvgElement,
  computeBounds,
  translateElements,
} from './stamps/render';
import { showToast } from './ui';

const W = 600;
const H = 400;
const PEN_WIDTH = 3;
const TEXT_SIZE = 36;
const ERASER_RADIUS = 12;

type Tool = 'pen' | 'text' | 'eraser';

export interface NewStamp {
  elements: StampElement[];
  width: number;
  height: number;
}

export function openStampEditor(): Promise<NewStamp | null> {
  return new Promise((resolve) => {
    const elements: StampElement[] = [];
    let tool: Tool = 'pen';
    let font: StampFont = 'open-sans';
    let settled = false;

    // --- Build modal DOM ---
    const root = document.createElement('div');
    root.className = 'modal fade';
    root.tabIndex = -1;
    root.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-lg">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">חותמת חדשה</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="סגירה"></button>
          </div>
          <div class="modal-body">
            <div class="se-tools btn-toolbar mb-3 gap-2" role="toolbar">
              <div class="btn-group" role="group">
                <button type="button" class="btn btn-outline-primary" data-tool="pen">עט</button>
                <button type="button" class="btn btn-outline-primary" data-tool="text">טקסט</button>
                <button type="button" class="btn btn-outline-primary" data-tool="eraser">מחק</button>
              </div>
              <div class="btn-group se-fonts" role="group">
                <button type="button" class="btn btn-outline-secondary" data-font="open-sans"
                  style="font-family:'Open Sans',sans-serif;font-size:1.3rem;">א</button>
                <button type="button" class="btn btn-outline-secondary" data-font="gveret-levin"
                  style="font-family:'Gveret Levin',cursive;font-size:1.5rem;">א</button>
              </div>
            </div>
            <div class="se-surface-wrap">
              <div class="se-surface" style="width:${W}px;height:${H}px;"></div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-act="cancel">ביטול</button>
            <button type="button" class="btn btn-primary" data-act="save">שמירה</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);

    const surface = root.querySelector('.se-surface') as HTMLDivElement;
    let svg = createSvgElement([], W, H);
    surface.appendChild(svg);

    const toolButtons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-tool]'),
    );
    const fontButtons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-font]'),
    );

    function refreshToolUI() {
      for (const b of toolButtons) {
        b.classList.toggle('active', b.dataset.tool === tool);
      }
      const fontsEnabled = tool === 'text';
      for (const b of fontButtons) {
        b.classList.toggle('active', fontsEnabled && b.dataset.font === font);
        b.disabled = !fontsEnabled;
      }
      surface.style.cursor =
        tool === 'eraser' ? 'cell' : tool === 'text' ? 'text' : 'crosshair';
    }

    function redraw() {
      const next = createSvgElement(elements, W, H);
      surface.replaceChild(next, svg);
      svg = next;
    }

    for (const b of toolButtons) {
      b.addEventListener('click', () => {
        tool = b.dataset.tool as Tool;
        refreshToolUI();
      });
    }
    for (const b of fontButtons) {
      b.addEventListener('click', () => {
        if (tool !== 'text') return;
        font = b.dataset.font as StampFont;
        refreshToolUI();
      });
    }

    // --- Pointer coordinates relative to the surface ---
    function toLocal(e: PointerEvent): [number, number] {
      const r = surface.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    // --- Drawing state ---
    let activeStroke: StampElement | null = null;
    let activePolyline: SVGPolylineElement | null = null;
    let erasing = false;

    function distToSegment(
      px: number,
      py: number,
      ax: number,
      ay: number,
      bx: number,
      by: number,
    ): number {
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      return Math.hypot(px - cx, py - cy);
    }

    function eraseAt(x: number, y: number) {
      let changed = false;
      for (let i = elements.length - 1; i >= 0; i--) {
        const el = elements[i];
        let hit = false;
        if (el.kind === 'stroke') {
          const tol = ERASER_RADIUS + el.strokeWidth / 2;
          if (el.points.length === 1) {
            hit = Math.hypot(x - el.points[0][0], y - el.points[0][1]) <= tol;
          } else {
            for (let j = 1; j < el.points.length && !hit; j++) {
              const [ax, ay] = el.points[j - 1];
              const [bx, by] = el.points[j];
              if (distToSegment(x, y, ax, ay, bx, by) <= tol) hit = true;
            }
          }
        } else {
          const b = computeBounds([el]);
          if (b) {
            hit =
              x >= b.minX - ERASER_RADIUS &&
              x <= b.maxX + ERASER_RADIUS &&
              y >= b.minY - ERASER_RADIUS &&
              y <= b.maxY + ERASER_RADIUS;
          }
        }
        if (hit) {
          elements.splice(i, 1);
          changed = true;
        }
      }
      if (changed) redraw();
    }

    surface.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const [x, y] = toLocal(e);
      if (x < 0 || y < 0 || x > W || y > H) return;

      if (tool === 'pen') {
        surface.setPointerCapture(e.pointerId);
        activeStroke = { kind: 'stroke', points: [[x, y]], strokeWidth: PEN_WIDTH };
        activePolyline = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'polyline',
        );
        activePolyline.setAttribute('fill', 'none');
        activePolyline.setAttribute('stroke', STAMP_COLOR);
        activePolyline.setAttribute('stroke-width', String(PEN_WIDTH));
        activePolyline.setAttribute('stroke-linecap', 'round');
        activePolyline.setAttribute('stroke-linejoin', 'round');
        activePolyline.setAttribute('points', `${x},${y}`);
        svg.appendChild(activePolyline);
      } else if (tool === 'eraser') {
        surface.setPointerCapture(e.pointerId);
        erasing = true;
        eraseAt(x, y);
      } else if (tool === 'text') {
        // Prevent the default mousedown focus handling, which would otherwise
        // immediately steal focus back from the text input we are about to add.
        e.preventDefault();
        startTextInput(x, y);
      }
    });

    surface.addEventListener('pointermove', (e) => {
      const [x, y] = toLocal(e);
      if (tool === 'pen' && activeStroke && activePolyline) {
        (activeStroke as { points: [number, number][] }).points.push([x, y]);
        const pts = (activeStroke as { points: [number, number][] }).points;
        activePolyline.setAttribute(
          'points',
          pts.map(([px, py]) => `${px},${py}`).join(' '),
        );
      } else if (tool === 'eraser' && erasing) {
        eraseAt(x, y);
      }
    });

    function endStroke(e: PointerEvent) {
      if (activeStroke) {
        elements.push(activeStroke);
        activeStroke = null;
        activePolyline = null;
        redraw();
      }
      if (erasing) erasing = false;
      try {
        surface.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    surface.addEventListener('pointerup', endStroke);
    surface.addEventListener('pointercancel', endStroke);

    // --- Inline text entry ---
    let textInput: HTMLInputElement | null = null;
    function startTextInput(x: number, y: number) {
      if (textInput) commitTextInput();
      const input = document.createElement('input');
      input.type = 'text';
      // RTL base direction so neutral characters (e.g. "-") resolve as RTL,
      // matching how the committed text is rendered. It is right-anchored and
      // grows left.
      input.dir = 'rtl';
      input.className = 'se-text-input';
      input.style.position = 'absolute';
      input.style.right = `${W - x}px`;
      input.style.top = `${y}px`;
      input.style.textAlign = 'right';
      input.style.font = `${TEXT_SIZE}px ${fontFamily(font)}`;
      input.style.color = STAMP_COLOR;
      input.dataset.x = String(x);
      input.dataset.y = String(y);
      input.dataset.font = font;
      surface.appendChild(input);
      textInput = input;
      // Defer focus so it survives the pointerdown's default focus handling.
      // setTimeout (rather than rAF) also fires when the tab is backgrounded.
      setTimeout(() => input.focus(), 0);

      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commitTextInput();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          cancelTextInput();
        }
      });
      input.addEventListener('blur', () => commitTextInput());
    }

    function commitTextInput() {
      if (!textInput) return;
      const input = textInput;
      textInput = null;
      const text = input.value.trim();
      const x = Number(input.dataset.x);
      const y = Number(input.dataset.y);
      const f = input.dataset.font as StampFont;
      input.remove();
      if (text.length > 0) {
        elements.push({
          kind: 'text',
          x,
          y,
          text,
          font: f,
          fontSize: TEXT_SIZE,
          dir: 'rtl',
        });
        redraw();
      }
    }

    function cancelTextInput() {
      if (!textInput) return;
      const input = textInput;
      textInput = null;
      input.remove();
    }

    // --- Modal lifecycle ---
    const modal = new Modal(root, { backdrop: 'static', keyboard: true });

    function finish(result: NewStamp | null) {
      if (settled) return;
      settled = true;
      resolve(result);
      modal.hide();
    }

    root.querySelector('[data-act="cancel"]')!.addEventListener('click', () =>
      finish(null),
    );
    root.querySelector('[data-act="save"]')!.addEventListener('click', () => {
      commitTextInput();
      const bounds = computeBounds(elements);
      if (!bounds) {
        showToast('החותמת ריקה. ציירו או הוסיפו טקסט לפני השמירה.', 'warning');
        return;
      }
      const normalized = translateElements(elements, -bounds.minX, -bounds.minY);
      finish({
        elements: normalized,
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY,
      });
    });

    // Closing via the X / backdrop / Esc counts as cancel.
    root.addEventListener('hidden.bs.modal', () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
      root.remove();
    });

    refreshToolUI();
    modal.show();
  });
}
