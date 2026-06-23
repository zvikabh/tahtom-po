import {
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db, googleProvider } from './firebase';

export type { User };

/** Sign in with Google (popup). Throws on failure. */
export async function signIn(): Promise<void> {
  await signInWithPopup(auth, googleProvider);
}

export async function signOut(): Promise<void> {
  await fbSignOut(auth);
}

/**
 * Whether the signed-in user is on the whitelist. Mirrors the server-side
 * Firestore rule: an `allowed_users/{email}` document must exist. The read is
 * itself permitted by the rules only for the user's own email, so a denied read
 * also means "not allowed".
 */
export async function isUserAllowed(user: User): Promise<boolean> {
  if (!user.email || !user.emailVerified) return false;
  try {
    const snap = await getDoc(doc(db, 'allowed_users', user.email));
    return snap.exists();
  } catch {
    return false;
  }
}

/** Subscribe to auth state changes. Returns the unsubscribe function. */
export function watchAuth(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, cb);
}
