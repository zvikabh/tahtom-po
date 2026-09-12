// CRUD for the current user's private stamp collection: users/{uid}/stamps.
import {
  collection,
  doc,
  addDoc,
  deleteDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Stamp, StampElement, StampFont } from './render';

function stampsCol(uid: string) {
  return collection(db, 'users', uid, 'stamps');
}

// Firestore does not support nested arrays, so stroke points (an array of
// [x, y] pairs) are stored flattened as [x0, y0, x1, y1, ...] and rebuilt on
// read. Other element fields are stored as-is.
type StoredElement =
  | { kind: 'stroke'; points: number[]; strokeWidth: number }
  | {
      kind: 'text';
      x: number;
      y: number;
      text: string;
      font: StampFont;
      fontSize: number;
      dir?: 'rtl' | 'ltr';
    };

function encodeElements(elements: StampElement[]): StoredElement[] {
  return elements.map((el) =>
    el.kind === 'stroke'
      ? { kind: 'stroke', points: el.points.flat(), strokeWidth: el.strokeWidth }
      : el,
  );
}

function decodeElements(stored: StoredElement[]): StampElement[] {
  return (stored ?? []).map((el) => {
    if (el.kind === 'stroke') {
      const points: [number, number][] = [];
      for (let i = 0; i + 1 < el.points.length; i += 2) {
        points.push([el.points[i], el.points[i + 1]]);
      }
      return { kind: 'stroke', points, strokeWidth: el.strokeWidth };
    }
    return el;
  });
}

export async function listStamps(uid: string): Promise<Stamp[]> {
  const q = query(stampsCol(uid), orderBy('createdAt', 'asc'));
  const snap = await getDocs(q);
  const items = snap.docs.map((d) => {
    const data = d.data() as {
      elements: StoredElement[];
      width: number;
      height: number;
      order?: number;
      createdAt?: { toMillis?: () => number };
    };
    // Stamps are ordered by an explicit `order` field once the user has
    // rearranged them; stamps without one (legacy or freshly added) fall back
    // to creation time, which places them after ordered stamps / at the end.
    const sortKey =
      typeof data.order === 'number'
        ? data.order
        : (data.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER);
    return {
      sortKey,
      stamp: {
        id: d.id,
        elements: decodeElements(data.elements),
        width: data.width ?? 0,
        height: data.height ?? 0,
      } as Stamp,
    };
  });
  items.sort((a, b) => a.sortKey - b.sortKey);
  return items.map((i) => i.stamp);
}

/** Persist a new stamp ordering by writing each stamp's index to `order`. */
export async function reorderStamps(
  uid: string,
  orderedIds: string[],
): Promise<void> {
  const batch = writeBatch(db);
  orderedIds.forEach((id, i) => {
    batch.update(doc(db, 'users', uid, 'stamps', id), { order: i });
  });
  await batch.commit();
}

export async function addStamp(
  uid: string,
  elements: StampElement[],
  width: number,
  height: number,
): Promise<string> {
  const ref = await addDoc(stampsCol(uid), {
    elements: encodeElements(elements),
    width,
    height,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function deleteStamp(uid: string, stampId: string): Promise<void> {
  await deleteDoc(doc(db, 'users', uid, 'stamps', stampId));
}
