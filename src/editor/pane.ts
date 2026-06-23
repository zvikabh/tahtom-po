// Right-hand pane listing the user's stamps, with delete (x) and add (+).
import { listStamps, addStamp, deleteStamp } from '../stamps/service';
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
    { kind: 'text', x: 0, y: 0, text, font: 'open-sans', fontSize: DATE_FONT_SIZE },
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
    item.className = 'stamp-item position-relative';
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
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'stamp-del btn btn-sm btn-danger';
      del.title = 'מחיקת חותמת';
      del.textContent = '×';
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
    list.innerHTML =
      '<div class="text-muted small text-center py-3">טוען חותמות…</div>';
    let stamps: Stamp[] = [];
    let failed = false;
    try {
      stamps = await listStamps(uid);
    } catch {
      failed = true;
    }

    list.innerHTML = '';
    // The date stamp is always present and always first.
    const dateStamp = makeDateStamp();
    list.appendChild(renderStamp(dateStamp, false));

    if (failed) {
      const err = document.createElement('div');
      err.className = 'text-danger small text-center py-3';
      err.textContent = 'שגיאה בטעינת החותמות.';
      list.appendChild(err);
    } else {
      for (const s of stamps) list.appendChild(renderStamp(s));
    }

    cb.onStampsLoaded([dateStamp, ...stamps]);
  }

  addBtn.addEventListener('click', async () => {
    const result = await openStampEditor();
    if (!result) return;
    await addStamp(uid, result.elements, result.width, result.height);
    await reload();
  });

  void reload();

  return { el, reload };
}
