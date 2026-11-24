import { createContext, useContext } from 'react';
import type { UrgentInboxSnapshot } from './data/urgent-inbox-cache';
import type { UrgentInboxSession } from './data/urgent-inbox-session';
export interface UrgentInboxView {
  scopeKey: string;
  snapshot: UrgentInboxSnapshot | null;
  session: UrgentInboxSession | null;
  online: boolean;
  effective: boolean;
  canEnable: boolean;
  pending: number;
  registerPending: boolean;
  error: string;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  retry: () => Promise<void>;
}
export const UrgentInboxContext = createContext<UrgentInboxView | null>(null);
export const useUrgentInbox = () => useContext(UrgentInboxContext);
