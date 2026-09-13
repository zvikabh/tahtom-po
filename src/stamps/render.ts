// Stamp data model + rendering helpers.
//
// A stamp is a list of vector elements stored in its own coordinate space,
// normalized so the content bounding box starts at (0,0) and spans
// (width x height). On screen we render to inline SVG (so the page's loaded
// fonts apply); for PNG/clipboard export we draw directly to a <canvas> 2D
// context (also using the loaded fonts), which avoids the limitation that an
// SVG rendered via <img> cannot reach external/document fonts.

export const STAMP_COLOR = '#0d47a1';

export type StampFont = 'gveret-levin' | 'open-sans';

export type StampElement =
  | { kind: 'stroke'; points: [number, number][]; strokeWidth: number }
  | {
      kind: 'text';
      x: number; // right edge of the text (text is right-anchored)
      y: number; // top edge of the text
      text: string;
      font: StampFont;
      fontSize: number;
      // Base direction for bidi resolution of neutral characters. Defaults to
      // 'ltr' when absent (older stamps). Typed stamps use 'rtl'.
      dir?: 'rtl' | 'ltr';
    };

export interface Stamp {
  id: string;
  elements: StampElement[];
  width: number;
  height: number;
}

export function fontFamily(font: StampFont): string {
  return font === 'gveret-levin'
    ? "'Gveret Levin', cursive"
    : "'Open Sans', sans-serif";
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Shared offscreen canvas used only for measuring text.
let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')!;
  }
  return measureCtx;
}

export function measureTextWidth(
  text: string,
  font: StampFont,
  fontSize: number,
): number {
  const ctx = getMeasureCtx();
  ctx.font = `${fontSize}px ${fontFamily(font)}`;
  return ctx.measureText(text).width;
}

// Approximate full line height for a given font size (ascent + descent + a bit).
function textLineHeight(fontSize: number): number {
  return fontSize * 1.3;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of all elements, or null if there is no drawable content. */
export function computeBounds(elements: StampElement[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let has = false;

  for (const el of elements) {
    if (el.kind === 'stroke') {
      const r = el.strokeWidth / 2;
      for (const [x, y] of el.points) {
        has = true;
        minX = Math.min(minX, x - r);
        minY = Math.min(minY, y - r);
        maxX = Math.max(maxX, x + r);
        maxY = Math.max(maxY, y + r);
      }
    } else {
      if (el.text.length === 0) continue;
      has = true;
      // Text is anchored by its top-right corner (el.x, el.y) and extends left.
      const w = measureTextWidth(el.text, el.font, el.fontSize);
      const h = textLineHeight(el.fontSize);
      minX = Math.min(minX, el.x - w);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x);
      maxY = Math.max(maxY, el.y + h);
    }
  }

  if (!has) return null;
  return { minX, minY, maxX, maxY };
}

/** Return a copy of elements translated by (dx, dy). */
export function translateElements(
  elements: StampElement[],
  dx: number,
  dy: number,
): StampElement[] {
  return elements.map((el) => {
    if (el.kind === 'stroke') {
      return {
        ...el,
        points: el.points.map(([x, y]) => [x + dx, y + dy] as [number, number]),
      };
    }
    return { ...el, x: el.x + dx, y: el.y + dy };
  });
}

/** Build an inline <svg> element for on-screen rendering (thumbnails/preview). */
export function createSvgElement(
  elements: StampElement[],
  width: number,
  height: number,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  for (const el of elements) {
    if (el.kind === 'stroke') {
      if (el.points.length === 1) {
        const [x, y] = el.points[0];
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', String(x));
        c.setAttribute('cy', String(y));
        c.setAttribute('r', String(el.strokeWidth / 2));
        c.setAttribute('fill', STAMP_COLOR);
        svg.appendChild(c);
      } else if (el.points.length > 1) {
        const p = document.createElementNS(SVG_NS, 'polyline');
        p.setAttribute('points', el.points.map(([x, y]) => `${x},${y}`).join(' '));
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', STAMP_COLOR);
        p.setAttribute('stroke-width', String(el.strokeWidth));
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(p);
      }
    } else if (el.text.length > 0) {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', String(el.x));
      t.setAttribute('y', String(el.y));
      t.setAttribute('fill', STAMP_COLOR);
      t.setAttribute('font-family', fontFamily(el.font));
      t.setAttribute('font-size', String(el.fontSize));
      t.setAttribute('dominant-baseline', 'hanging');
      // Anchor by the top-right corner so positioning is deterministic. With
      // RTL, the anchor "start" is the right edge; with LTR, "end" is.
      const isRtl = el.dir === 'rtl';
      t.setAttribute('text-anchor', isRtl ? 'start' : 'end');
      t.setAttribute('direction', isRtl ? 'rtl' : 'ltr');
      t.textContent = el.text;
      svg.appendChild(t);
    }
  }
  return svg;
}

/**
 * Draw a stamp's elements onto a canvas 2D context. The caller is responsible
 * for setting up translation/scaling via ctx.setTransform/translate/scale
 * before calling; elements are drawn in their own (0,0)-based coordinates.
 */
export function drawElementsToCanvas(
  ctx: CanvasRenderingContext2D,
  elements: StampElement[],
): void {
  ctx.save();
  ctx.fillStyle = STAMP_COLOR;
  ctx.strokeStyle = STAMP_COLOR;

  for (const el of elements) {
    if (el.kind === 'stroke') {
      if (el.points.length === 1) {
        const [x, y] = el.points[0];
        ctx.beginPath();
        ctx.arc(x, y, el.strokeWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (el.points.length > 1) {
        ctx.beginPath();
        ctx.lineWidth = el.strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.moveTo(el.points[0][0], el.points[0][1]);
        for (let i = 1; i < el.points.length; i++) {
          ctx.lineTo(el.points[i][0], el.points[i][1]);
        }
        ctx.stroke();
      }
    } else if (el.text.length > 0) {
      ctx.font = `${el.fontSize}px ${fontFamily(el.font)}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'right';
      ctx.direction = el.dir === 'rtl' ? 'rtl' : 'ltr';
      ctx.fillText(el.text, el.x, el.y);
    }
  }
  ctx.restore();
}

/**
 * Render a stamp to its own transparent canvas at `pxScale` device pixels per
 * stamp unit. Used to overlay stamps onto exported pages (PNG or embedded in a
 * PDF). Returns null for a degenerate (zero-size) stamp.
 */
export function stampToCanvas(
  stamp: { elements: StampElement[]; width: number; height: number },
  pxScale: number,
): HTMLCanvasElement | null {
  const w = Math.max(1, Math.round(stamp.width * pxScale));
  const h = Math.max(1, Math.round(stamp.height * pxScale));
  if (stamp.width <= 0 || stamp.height <= 0) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.scale(pxScale, pxScale);
  drawElementsToCanvas(ctx, stamp.elements);
  return c;
}
