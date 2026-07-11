import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';

interface DrawerProps {
  title: string;
  open: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}

const focusableSelector = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Drawer({ title, open, onClose, returnFocusRef, children }: DrawerProps) {
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const drawer = drawerRef.current;
    const returnFocus = returnFocusRef.current;
    const focusables = () => Array.from(
      drawer?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
    );
    focusables()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (!drawer?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (drawer?.contains(event.target as Node)) return;
      focusables()[0]?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', containFocus);
      returnFocus?.focus();
    };
  }, [onClose, open, returnFocusRef]);

  if (!open) return null;
  return (
    <aside
      ref={drawerRef}
      className="edge-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-title"
    >
      <header className="drawer-header">
        <h2 id="drawer-title">{title}</h2>
        <button className="icon-button" type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} title={`Close ${title.toLowerCase()}`}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="drawer-content">{children}</div>
    </aside>
  );
}
