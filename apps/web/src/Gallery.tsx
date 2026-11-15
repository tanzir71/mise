import { Button, Card, Chip, Eyebrow, Icon, Section, StatusWord } from '@mise/ui/primitives.tsx';

export function Gallery() {
  return <main className="coming-soon"><h1>Mise UI</h1><Section><Eyebrow>FOUNDATIONS</Eyebrow><div className="actions"><Button>Primary <Icon name="arrowRight" /></Button><Button kind="secondary">Secondary</Button><Button kind="ghost">Ghost</Button></div><Card><h2>Shared card</h2><p lang="bn">আপনার দোকান · ৳১,১২,৮৪০</p><div className="actions"><Chip>Outline</Chip><Chip selected>Selected</Chip></div><StatusWord tone="positive">Ready</StatusWord></Card></Section></main>;
}
