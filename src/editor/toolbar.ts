// Top toolbar for the editor.
export interface ToolbarCallbacks {
  open(): void;
  save(): void;
  undo(): void;
  redo(): void;
  copy(): void;
  paste(): void;
  toggleSelect(): void;
  enlarge(): void;
  shrink(): void;
  signOut(): void;
}

interface ButtonDef {
  action: keyof ToolbarCallbacks;
  label: string;
  icon: string;
}

const BUTTONS: ButtonDef[] = [
  { action: 'open', label: 'פתיחה', icon: 'bi-folder2-open' },
  { action: 'save', label: 'שמירה', icon: 'bi-download' },
  { action: 'undo', label: 'ביטול', icon: 'bi-arrow-counterclockwise' },
  { action: 'redo', label: 'החזרה', icon: 'bi-arrow-clockwise' },
  { action: 'copy', label: 'העתקה', icon: 'bi-clipboard' },
  { action: 'paste', label: 'הדבקה', icon: 'bi-clipboard-plus' },
  { action: 'toggleSelect', label: 'בחירה', icon: 'bi-cursor' },
  { action: 'enlarge', label: 'הגדלה', icon: 'bi-zoom-in' },
  { action: 'shrink', label: 'הקטנה', icon: 'bi-zoom-out' },
];

export interface Toolbar {
  el: HTMLElement;
  setUndoEnabled(v: boolean): void;
  setRedoEnabled(v: boolean): void;
  setResizeEnabled(v: boolean): void;
  setSelectActive(v: boolean): void;
}

export function createToolbar(cb: ToolbarCallbacks): Toolbar {
  const el = document.createElement('div');
  el.className = 'editor-toolbar d-flex align-items-center gap-2 p-2 border-bottom';

  const buttons = new Map<string, HTMLButtonElement>();
  for (const def of BUTTONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-outline-secondary d-flex flex-column align-items-center';
    b.title = def.label;
    b.innerHTML = `<i class="bi ${def.icon}"></i><span class="tb-label">${def.label}</span>`;
    b.addEventListener('click', () => (cb[def.action] as () => void)());
    buttons.set(def.action, b);
    el.appendChild(b);
  }

  // Push sign-out to the far (left, in RTL) end.
  const spacer = document.createElement('div');
  spacer.className = 'flex-grow-1';
  el.appendChild(spacer);

  const signOutBtn = document.createElement('button');
  signOutBtn.type = 'button';
  signOutBtn.className = 'btn btn-outline-danger d-flex flex-column align-items-center';
  signOutBtn.title = 'התנתקות';
  signOutBtn.innerHTML =
    '<i class="bi bi-box-arrow-right"></i><span class="tb-label">התנתקות</span>';
  signOutBtn.addEventListener('click', () => cb.signOut());
  el.appendChild(signOutBtn);

  return {
    el,
    setUndoEnabled: (v) => (buttons.get('undo')!.disabled = !v),
    setRedoEnabled: (v) => (buttons.get('redo')!.disabled = !v),
    setResizeEnabled: (v) => {
      buttons.get('enlarge')!.disabled = !v;
      buttons.get('shrink')!.disabled = !v;
    },
    setSelectActive: (v) => buttons.get('toggleSelect')!.classList.toggle('active', v),
  };
}
