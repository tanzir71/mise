import type {Page} from '@playwright/test';
export function startStaffDeviceService():Promise<Awaited<ReturnType<typeof import('./staff-device-service').startStaffDeviceService>>>;
export function installStaffDevice(page:Page):Promise<void>;
export function captureStaffDevice(page:Page,mode:'board'|'shift'):Promise<void>;
export function closeStaffDeviceVisual():Promise<void>;
