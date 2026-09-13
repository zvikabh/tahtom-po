// Build a stamped PDF from the editor's rasterized pages + placed stamps.
//
// Strategy: overlay-on-original. For each page we embed the ORIGINAL PDF page
// as a vector XObject (preserving crisp, selectable text) into a fresh output
// page whose size matches the on-screen viewport, then draw the stamps on top
// as PNG overlays. If the original can't be embedded for a page (encrypted or
// corrupt source, or a rotated page whose transform we don't reproduce), we
// fall back to rasterizing that page's rendered canvas — so no input is ever
// unexportable, worst case producing a larger image-based page.
import { PDFDocument } from 'pdf-lib';
import { stampToCanvas, type Stamp } from '../stamps/render';

export interface ExportPage {
  canvas: HTMLCanvasElement;
  width: number; // device px (at the render DPI)
  height: number;
}

export interface ExportPlaced {
  stampId: string;
  pageIndex: number;
  x: number;
  y: number;
  scale: number;
}

// Supersample stamp rasters so overlays stay crisp when the PDF is zoomed.
const STAMP_SUPERSAMPLE = 2;

function canvasToPngBytes(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    c.toBlob(async (blob) => {
      if (!blob) return reject(new Error('toBlob failed'));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}

export async function buildStampedPdf(
  pages: ExportPage[],
  pdfBytes: Uint8Array | null,
  placed: ExportPlaced[],
  resolveStamp: (id: string) => Stamp | undefined,
  dpi: number,
): Promise<Blob> {
  const k = 72 / dpi; // PDF points per device pixel
  const outDoc = await PDFDocument.create();

  let srcDoc: PDFDocument | null = null;
  if (pdfBytes) {
    try {
      srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    } catch {
      srcDoc = null; // fall back to rasterizing every page
    }
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const wPts = page.width * k;
    const hPts = page.height * k;
    const outPage = outDoc.addPage([wPts, hPts]);

    let vectorOK = false;
    if (srcDoc && i < srcDoc.getPageCount()) {
      const srcPage = srcDoc.getPage(i);
      const rotation = (((srcPage.getRotation().angle % 360) + 360) % 360);
      if (rotation === 0) {
        try {
          const embedded = await outDoc.embedPage(srcPage);
          outPage.drawPage(embedded, { x: 0, y: 0, width: wPts, height: hPts });
          vectorOK = true;
        } catch {
          vectorOK = false;
        }
      }
    }
    if (!vectorOK) {
      const bg = await outDoc.embedPng(await canvasToPngBytes(page.canvas));
      outPage.drawImage(bg, { x: 0, y: 0, width: wPts, height: hPts });
    }

    // Draw this page's stamps on top, in placement order.
    for (const ps of placed) {
      if (ps.pageIndex !== i) continue;
      const stamp = resolveStamp(ps.stampId);
      if (!stamp) continue;
      const sc = stampToCanvas(stamp, ps.scale * STAMP_SUPERSAMPLE);
      if (!sc) continue;
      const img = await outDoc.embedPng(await canvasToPngBytes(sc));
      const w = stamp.width * ps.scale * k;
      const h = stamp.height * ps.scale * k;
      const x = ps.x * k;
      const y = hPts - ps.y * k - h; // flip: PDF origin is bottom-left
      outPage.drawImage(img, { x, y, width: w, height: h });
    }
  }

  const bytes = await outDoc.save();
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer], { type: 'application/pdf' });
}
