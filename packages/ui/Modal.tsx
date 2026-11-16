import { useEffect, useId, useRef, type ReactNode } from 'react';
import { MiseIcon } from './MiseIcon';
export function Modal({ open, title, closeLabel, onClose, children, variant = 'modal', focusTitle = false }: { open: boolean; title: string; closeLabel: string; onClose: () => void; children: ReactNode; variant?: 'modal'|'sheet'; focusTitle?:boolean }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const dialog = ref.current, opener = document.activeElement;
    if (open && !dialog?.open) dialog?.showModal(); else if (!open && dialog?.open) dialog.close();
    if(open && focusTitle) dialog?.querySelector('h2')?.focus();
    return () => { if (open) { dialog?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); } };
  }, [open,focusTitle]);
  return <dialog ref={ref} className={`app-dialog${variant === 'sheet' ? ' app-sheet' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}><header><h2 id={titleId} tabIndex={focusTitle?-1:undefined}>{title}</h2><button type="button" className="button button-secondary" aria-label={closeLabel} onClick={onClose}>{variant === 'sheet' ? <MiseIcon name="x" size={20} /> : closeLabel}</button></header>{children}</dialog>;
}
