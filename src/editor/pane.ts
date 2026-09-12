// Right-hand pane listing the user's stamps, with delete, add (+), and
// drag-to-reorder.
import Sortable from 'sortablejs';
import {
  listStamps,
  addStamp,
  deleteStamp,
  reorderStamps,
} from '../stamps/service';
import {
  createSvgElement,
  computeBounds,
  translateElements,
  type Stamp,
  type StampElement,
} from '../stamps/render';
import { openStampEditor } from '../stampEditor';
import { confirmDialog, showToast } from '../ui';

// Special, non-persisted stamp that always shows today's date (DD/MM/YY).
const DATE_STAMP_ID = 'date-today';
const DATE_FONT_SIZE = 36;

function makeDateStamp(): Stamp {
  const d = new Date();
  const dd = d.getDate();
  const mm = d.getMonth() + 1;
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  const text = `${dd}/${mm}/${yy}`;
  let elements: StampElement[] = [
    {
      kind: 'text',
      x: 0,
      y: 0,
      text,
      font: 'open-sans',
      fontSize: DATE_FONT_SIZE,
      dir: 'ltr',
    },
  ];
  const b = computeBounds(elements);
  if (!b) return { id: DATE_STAMP_ID, elements, width: 1, height: 1 };
  elements = translateElements(elements, -b.minX, -b.minY);
  return {
    id: DATE_STAMP_ID,
    elements,
    width: b.maxX - b.minX,
    height: b.maxY - b.minY,
  };
}

export interface PaneCallbacks {
  onPick(stamp: Stamp): void;
  onStampsLoaded(stamps: Stamp[]): void;
  // Called right after a new stamp is created and saved.
  onStampAdded(stamp: Stamp): void;
}

export interface StampsPane {
  el: HTMLElement;
  reload(): Promise<void>;
}

export function createStampsPane(uid: string, cb: PaneCallbacks): StampsPane {
  const el = document.createElement('div');
  el.className = 'stamps-pane d-flex flex-column';

  const list = document.createElement('div');
  list.className = 'stamps-list flex-grow-1 p-2 d-flex flex-column gap-2';
  el.appendChild(list);

  // The date stamp is pinned above the reorderable list of the user's stamps.
  const dateHolder = document.createElement('div');
  dateHolder.className = 'd-flex flex-column gap-2';
  const sortableEl = document.createElement('div');
  sortableEl.className = 'stamps-sortable d-flex flex-column gap-2';
  list.append(dateHolder, sortableEl);

  const footer = document.createElement('div');
  footer.className = 'p-2 border-top text-center';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-primary w-100';
  addBtn.title = 'הוספת חותמת';
  addBtn.innerHTML = '<i class="bi bi-plus-lg"></i>';
  footer.appendChild(addBtn);
  el.appendChild(footer);

  function renderStamp(stamp: Stamp, deletable = true): HTMLElement {
    const item = document.createElement('div');
    item.className = 'stamp-item';
    item.title = deletable
      ? 'לחצו כדי להניח את החותמת'
      : 'חותמת תאריך היום — לחצו כדי להניח';

    const thumb = document.createElement('div');
    thumb.className = 'stamp-thumb';
    const svg = createSvgElement(stamp.elements, stamp.width, stamp.height);
    // Let the SVG scale to fit the thumbnail box.
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    thumb.appendChild(svg);
    item.appendChild(thumb);

    if (deletable) {
      item.dataset.id = stamp.id;

      // Drag handle (right/leading edge in RTL) for reordering. Rendered as a
      // full-height dotted strip via CSS.
      const handle = document.createElement('div');
      handle.className = 'stamp-handle';
      handle.title = 'גררו כדי לשנות את הסדר';
      handle.addEventListener('click', (e) => e.stopPropagation());
      item.appendChild(handle);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'stamp-del';
      del.title = 'מחיקת חותמת';
      del.setAttribute('aria-label', 'מחיקת חותמת');
      del.innerHTML = '<i class="bi bi-trash"></i>';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('למחוק חותמת זו?', {
          title: 'מחיקת חותמת',
          okText: 'מחיקה',
          okVariant: 'danger',
        });
        if (!ok) return;
        try {
          await deleteStamp(uid, stamp.id);
          await reload();
        } catch {
          showToast('מחיקת החותמת נכשלה.', 'danger');
        }
      });
      item.appendChild(del);
    }

    item.addEventListener('click', () => cb.onPick(stamp));
    return item;
  }

  async function reload(): Promise<void> {
    sortableEl.innerHTML =
      '<div class="text-muted small text-center py-3">טוען חותמות…</div>';
    let stamps: Stamp[] = [];
    let failed = false;
    try {
      stamps = await listStamps(uid);
    } catch {
      failed = true;
    }

    // The date stamp is always present and always first (not reorderable).
    dateHolder.innerHTML = '';
    const dateStamp = makeDateStamp();
    dateHolder.appendChild(renderStamp(dateStamp, false));

    sortableEl.innerHTML = '';
    if (failed) {
      const err = document.createElement('div');
      err.className = 'text-danger small text-center py-3';
      err.textContent = 'שגיאה בטעינת החותמות.';
      sortableEl.appendChild(err);
    } else {
      for (const s of stamps) sortableEl.appendChild(renderStamp(s));
    }

    cb.onStampsLoaded([dateStamp, ...stamps]);
  }

  // Enable drag-to-reorder on the user's stamps. Persist the new order on drop;
  // if the write fails, reload to fall back to the server's order.
  Sortable.create(sortableEl, {
    handle: '.stamp-handle',
    draggable: '.stamp-item',
    animation: 150,
    onEnd: async () => {
      const ids = Array.from(
        sortableEl.querySelectorAll<HTMLElement>('.stamp-item'),
      )
        .map((elm) => elm.dataset.id)
        .filter((id): id is string => !!id);
      try {
        await reorderStamps(uid, ids);
      } catch {
        showToast('שינוי סדר החותמות נכשל.', 'danger');
        await reload();
      }
    },
  });

  addBtn.addEventListener('click', async () => {
    const result = await openStampEditor();
    if (!result) return;
    let id: string;
    try {
      id = await addStamp(uid, result.elements, result.width, result.height);
    } catch {
      showToast('שמירת החותמת נכשלה.', 'danger');
      return;
    }
    await reload();
    // Reload has refreshed the editor's stamp cache (via onStampsLoaded), so the
    // new stamp can now be placed by id.
    cb.onStampAdded({
      id,
      elements: result.elements,
      width: result.width,
      height: result.height,
    });
  });

  void reload();

  return { el, reload };
}
