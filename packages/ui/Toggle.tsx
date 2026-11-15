import on from './assets/toggle-on.svg?url';
import off from './assets/toggle-off.svg?url';
export function Toggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className="toggle-control"><img src={checked ? on : off} width="36" height="20" alt="" aria-hidden="true" /></button>;
}
