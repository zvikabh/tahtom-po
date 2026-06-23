import 'bootstrap/dist/css/bootstrap.rtl.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './styles.css';

import { watchAuth, signIn, signOut, isUserAllowed, type User } from './auth';
import { mountEditor } from './editor/editor';

const appEl = document.getElementById('app')!;

function renderLoading() {
  appEl.innerHTML = `
    <div class="center-screen">
      <div class="spinner-border text-primary" role="status">
        <span class="visually-hidden">טוען…</span>
      </div>
    </div>`;
}

function renderLogin(error?: string) {
  appEl.innerHTML = `
    <div class="center-screen text-center">
      <div class="login-card card shadow-sm p-4">
        <h1 class="h3 mb-2">תחתום־פה</h1>
        <p class="text-muted mb-4">הוספת חתימות וחותמות על תמונות ומסמכים.</p>
        ${error ? `<div class="alert alert-danger py-2">${error}</div>` : ''}
        <button id="signin-btn" class="btn btn-primary btn-lg">
          <i class="bi bi-google ms-2"></i> התחברות עם Google
        </button>
      </div>
    </div>`;
  document.getElementById('signin-btn')!.addEventListener('click', async () => {
    try {
      await signIn();
    } catch {
      renderLogin('ההתחברות נכשלה. נסו שוב.');
    }
  });
}

function renderUnauthorized(email: string) {
  appEl.innerHTML = `
    <div class="center-screen text-center">
      <div class="login-card card shadow-sm p-4">
        <h1 class="h3 mb-3">תחתום־פה</h1>
        <div class="alert alert-warning">אין לך הרשאה לאפליקציה זו.</div>
        <p class="text-muted small mb-4">מחובר בתור ${email}</p>
        <button id="signout-btn" class="btn btn-outline-secondary">התנתקות</button>
      </div>
    </div>`;
  document
    .getElementById('signout-btn')!
    .addEventListener('click', () => void signOut());
}

let lastUid: string | null = null;

watchAuth(async (user: User | null) => {
  if (!user) {
    lastUid = null;
    renderLogin();
    return;
  }

  renderLoading();
  const allowed = await isUserAllowed(user);
  if (!allowed) {
    lastUid = null;
    renderUnauthorized(user.email ?? '');
    return;
  }

  // Avoid remounting the editor on incidental auth refreshes for the same user.
  if (lastUid === user.uid) return;
  lastUid = user.uid;
  mountEditor(appEl, user.uid);
});
