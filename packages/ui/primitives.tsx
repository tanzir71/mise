import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { ArrowRight, Check, Globe, Sparkles, type LucideProps } from 'lucide-react';

export function Button({ kind = 'primary', small, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'ghost'; small?: boolean }) {
  return <button className={`button button-${kind} ${small ? 'button-small' : ''} ${className}`} {...props} />;
}
export function Chip({ selected, className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { selected?: boolean }) { return <span className={`chip ${selected ? 'selected' : ''} ${className}`} {...props} />; }
export function Card(props: HTMLAttributes<HTMLDivElement>) { return <div {...props} className={`card ${props.className || ''}`} />; }
export function Section(props: HTMLAttributes<HTMLElement>) { return <section {...props} className={`section ${props.className || ''}`} />; }
export function Eyebrow({ children }: { children: ReactNode }) { return <p className="eyebrow">{children}</p>; }
export function StatusWord({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'positive' | 'warning' | 'negative' | 'info' | 'neutral' }) { return <span className={`status-word status-${tone}`}><span aria-hidden="true">●</span>{children}</span>; }
const icons = { arrowRight: ArrowRight, check: Check, globe: Globe, sparkles: Sparkles };
export function Icon({ name, ...props }: LucideProps & { name: keyof typeof icons }) { const Glyph = icons[name]; return <Glyph size={20} strokeWidth={1.5} aria-hidden="true" {...props} />; }
