import { useEffect, useId, useRef, type ReactNode } from 'react';
export function Modal({ open, title, closeLabel, onClose, children }: { open: boolean; title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => { if (open && !ref.current?.open) ref.current?.showModal(); else if (!open && ref.current?.open) ref.current.close(); }, [open]);
  return <dialog ref={ref} className="app-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}><header><h2 id={titleId}>{title}</h2><button type="button" className="button button-secondary" onClick={onClose}>{closeLabel}</button></header>{children}</dialog>;
}
