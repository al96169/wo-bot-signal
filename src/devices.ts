import { logger } from "./logger.js";

export interface DeviceInfo {
  deviceId: string;
  connectedAt: number;
  lastSeen: number;
}

// 设备在线状态：deviceId → DeviceInfo
const onlineDevices = new Map<string, DeviceInfo>();

// 设备状态变更回调
type PresenceCallback = (deviceId: string, online: boolean) => void;
const presenceCallbacks: PresenceCallback[] = [];

export function onPresenceChange(cb: PresenceCallback): void {
  presenceCallbacks.push(cb);
}

/** 机器人上线 */
export function deviceOnline(deviceId: string): void {
  const info: DeviceInfo = {
    deviceId,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
  };
  onlineDevices.set(deviceId, info);
  logger.info(`[Devices] Online: ${deviceId}`);
  presenceCallbacks.forEach((cb) => cb(deviceId, true));
}

/** 机器人离线 */
export function deviceOffline(deviceId: string): void {
  if (onlineDevices.delete(deviceId)) {
    logger.info(`[Devices] Offline: ${deviceId}`);
    presenceCallbacks.forEach((cb) => cb(deviceId, false));
  }
}

/** 更新最后心跳时间 */
export function updateLastSeen(deviceId: string): void {
  const info = onlineDevices.get(deviceId);
  if (info) {
    info.lastSeen = Date.now();
  }
}

/** 查询设备是否在线 */
export function isDeviceOnline(deviceId: string): boolean {
  return onlineDevices.has(deviceId);
}

/** 获取在线设备数量 */
export function getOnlineCount(): number {
  return onlineDevices.size;
}

/** 获取所有在线设备列表 */
export function getOnlineDevices(): string[] {
  return Array.from(onlineDevices.keys());
}
