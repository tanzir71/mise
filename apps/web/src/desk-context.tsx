import { createContext, useContext } from 'react';
import type { DeskSnapshot } from './data/desk-cache';
import type { DeskAlarmSettings } from '@mise/core/desk-tasks';
export interface DeskNotificationsView {
  snapshot: DeskSnapshot | null;
  online: boolean;
  fresh: boolean;
  loading: boolean;
  error: string;
  permission: NotificationPermission | 'unsupported';
  canEnable: boolean;
  canSave: boolean;
  pending: number;
  registerPending: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  retry: () => Promise<void>;
  saveSettings: (value: DeskAlarmSettings) => Promise<void>;
}
export const DeskNotificationsContext =
  createContext<DeskNotificationsView | null>(null);
export const useDeskNotifications = () => useContext(DeskNotificationsContext);
