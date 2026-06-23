// Small Bootstrap-based replacements for window.alert / window.confirm.
import { Toast, Modal } from 'bootstrap';

export type ToastVariant = 'primary' | 'danger' | 'warning' | 'success' | 'info';

let toastContainer: HTMLElement | null = null;
function getToastContainer(): HTMLElement {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className =
      'toast-container position-fixed top-0 start-50 translate-middle-x p-3';
    toastContainer.style.zIndex = '1090';
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

/** Show a transient toast message. */
export function showToast(
  message: string,
  variant: ToastVariant = 'primary',
  delay = 4000,
): void {
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${variant} border-0`;
  el.setAttribute('role', 'alert');
  el.setAttribute('aria-live', 'assertive');
  el.setAttribute('aria-atomic', 'true');
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white ms-2 m-auto"
              data-bs-dismiss="toast" aria-label="סגירה"></button>
    </div>`;
  getToastContainer().appendChild(el);
  const toast = new Toast(el, { delay });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  toast.show();
}

export interface ConfirmOptions {
  title?: string;
  okText?: string;
  cancelText?: string;
  okVariant?: 'primary' | 'danger';
}

/** Show a Bootstrap confirm dialog. Resolves true if confirmed. */
export function confirmDialog(
  message: string,
  opts: ConfirmOptions = {},
): Promise<boolean> {
  const {
    title = 'אישור',
    okText = 'אישור',
    cancelText = 'ביטול',
    okVariant = 'primary',
  } = opts;

  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'modal fade';
    root.tabIndex = -1;
    root.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${title}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="סגירה"></button>
          </div>
          <div class="modal-body">${message}</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-act="cancel">${cancelText}</button>
            <button type="button" class="btn btn-${okVariant}" data-act="ok">${okText}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);

    const modal = new Modal(root);
    let result = false;
    root
      .querySelector('[data-act="ok"]')!
      .addEventListener('click', () => {
        result = true;
        modal.hide();
      });
    root
      .querySelector('[data-act="cancel"]')!
      .addEventListener('click', () => modal.hide());
    root.addEventListener('hidden.bs.modal', () => {
      root.remove();
      resolve(result);
    });
    modal.show();
  });
}
