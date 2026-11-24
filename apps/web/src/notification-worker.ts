import {
  createDeskNotificationWorker,
  type DeskWorkerPorts,
  type DeskNotificationView,
} from './desk-notification-worker';
import { createUrgentInboxWorker } from './urgent-inbox-worker';

/** Both purposes use the actual browser capability, but each must prove its
 * own consent. An unknown payload never selects a destination or action. */
export function createNotificationWorker(ports: DeskWorkerPorts) {
  const kitchen = createDeskNotificationWorker(ports),
    urgent = createUrgentInboxWorker(ports);
  const general = (value: unknown) =>
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'urgent-inbox';
  return {
    push: (data: unknown) =>
      general(data) ? urgent.push(data) : kitchen.push(data),
    async click(notification: DeskNotificationView) {
      notification.close();
      if (general(notification.data)) await urgent.click(notification);
      else await kitchen.click(notification);
    },
    async recheck() {
      await kitchen.recheck();
      await urgent.recheck();
    },
  };
}
