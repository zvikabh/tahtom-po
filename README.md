# תחתום־פה (Tahtom-Po)

A small, desktop-only, Hebrew web app for placing reusable **stamps** (signatures, ID
numbers, etc.) onto a pasted or uploaded image, then downloading or copying the signed
result.

Runs entirely on the **Firebase Spark (free) plan** — Hosting + Auth (Google) + Firestore
only. No Cloud Storage and no Cloud Functions. The image you sign never leaves your browser;
only your stamps are stored (privately, per user) in Firestore.

## Tech stack
- Vite + TypeScript + Bootstrap 5
- Firebase Web SDK (Auth + Firestore)
- pdf.js (`pdfjs-dist`) for client-side PDF rasterization

## Local development
```bash
npm install
cp .env.example .env   # then fill in your Firebase web config
npm run dev
```

## One-time Firebase setup (manual)
1. Create a Firebase project (Spark plan is fine).
2. **Authentication** → enable the **Google** sign-in provider.
3. **Firestore Database** → create a database (production mode).
4. Add allowed users: create a collection named **`allowed_users`** and, for each permitted
   person, add a document whose **ID is their email address** (lower-case). The document body
   can be empty (or `{ addedAt: <timestamp> }`). Only these users can sign in and use the app.
5. **Project settings → Your apps → Web app**: copy the SDK config values into your `.env`
   (see `.env.example`).
6. Set the default project id in `.firebaserc` (replace `YOUR_FIREBASE_PROJECT_ID`).

## Deploy
```bash
npx firebase deploy --only firestore:rules,hosting
```

The hosting `predeploy` hook in `firebase.json` runs `npm run build` automatically, so the
deployed `dist/` is always freshly built (deploying stale assets was previously a foot-gun —
`npm run dev` never writes `dist/`).

The Firestore security rules (`firestore.rules`) enforce the whitelist server-side and ensure
each user can read/write **only their own** stamps.

## Browser support
Targets recent **desktop Chromium** browsers (Chrome / Edge). Copy/Paste of images relies on
the async Clipboard API, which is most reliable there.

## Usage notes
- **פתיחה** — open an image or PDF. PDFs are rasterized at ~150 dpi and shown as a scrollable
  vertical stack of pages; stamps can be placed on any page.
- **הדבקה** — paste an image from the clipboard. Opening/pasting replaces the document and
  clears placed stamps (undoable).
- Click a stamp in the right-hand pane to enter **placement mode**: it follows the cursor over
  whichever page it's on; press `=`/`+` to enlarge or `-` to shrink (10% steps, also via the
  הגדלה/הקטנה buttons); click to place; `Esc` cancels.
- **בחירה** — select a placed stamp, drag to move it, press `Delete` to remove it.
- **שמירה** — images save as PNG; PDFs save as a **stamped PDF** (the original pages are kept
  vector-crisp via overlay, falling back to rasterizing any page the original can't provide).
- **העתקה** — copies the page to the clipboard as a PNG. Disabled for multi-page PDFs, since a
  PDF can't be placed on the clipboard (browser limitation) — use שמירה instead.
- Create a new stamp with the **+** button in the pane (pen / text / eraser; two Hebrew fonts).
