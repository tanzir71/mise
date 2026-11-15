import type { CSSProperties } from 'react';
import { Calculator } from 'lucide-react';
const files = import.meta.glob<string>('../../handover/exports/system/Mise icon/*.svg', { eager: true, query: '?url', import: 'default' });
const assets = Object.fromEntries(Object.entries(files).map(([path, url]) => [path.split('/').pop()!.replace('.svg', ''), url]));
export function MiseIcon({ name, size = 20 }: { name: string; size?: number }) {
  if (name === 'calculator') return <Calculator width={size} height={size} strokeWidth={1.5} aria-hidden="true" />;
  if (!assets[name]) throw new Error(`Missing Mise icon: ${name}`);
  return <span aria-hidden="true" className="mise-icon" style={{ display: 'inline-block', flexShrink: 0, width: size, height: size, background: 'currentColor', mask: `url("${assets[name]}") center / contain no-repeat` } as CSSProperties} />;
}
