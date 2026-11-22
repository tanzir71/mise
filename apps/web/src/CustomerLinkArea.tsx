import { lazy, Suspense } from 'react';
import type { SetupSnapshot } from '@mise/core/models';
import type { CustomerLinkKind } from '@mise/core/customer-links';
import { useCustomerLinks } from './customer-links-context';
const Controls = lazy(() =>
  import('./CustomerLinkControls').then((module) => ({
    default: module.CustomerLinkControls,
  })),
);
export interface CustomerLinkAreaProps {
  setup: SetupSnapshot;
  kind: CustomerLinkKind;
  resourceId: string;
  phone?: string;
  label: string;
}
export function CustomerLinkArea(props: CustomerLinkAreaProps) {
  return useCustomerLinks() &&
    ['owner', 'manager'].includes(props.setup.owner.role) ? (
    <Suspense fallback={<p aria-busy="true">Opening customer links…</p>}>
      <Controls key={props.kind + ':' + props.resourceId} {...props} />
    </Suspense>
  ) : null;
}
