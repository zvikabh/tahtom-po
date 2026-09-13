// Copy pdf.js standard font data into public/ so it is served at
// /standard_fonts/ (dev) and bundled into dist/ (build). This lets pdf.js
// render PDFs that use the base-14 fonts (Helvetica/Times/Courier) without
// embedding them. Run automatically by the dev/build npm scripts.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/pdfjs-dist/standard_fonts');
const dest = resolve(root, 'public/standard_fonts');

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log('Copied pdf.js standard fonts -> public/standard_fonts');
