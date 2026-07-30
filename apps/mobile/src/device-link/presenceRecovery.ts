import type { PresenceSnapshot } from '@cindy/device-link';

type PresenceAvailabilitySnapshot = Pick<PresenceSnapshot, 'deviceId' | 'online' | 'remoteControlEnabled'>;

export interface PresenceAvailabilityUpdate {
  available: boolean;
  recovered: boolean;
}

export interface PresenceAvailabilityEpochs {
  next: number;
  byDevice: Map<string, number>;
}

export function createPresenceAvailabilityEpochs(): PresenceAvailabilityEpochs {
  return { next: 0, byDevice: new Map() };
}

export function markPresenceAvailabilityEpoch(
  epochs: PresenceAvailabilityEpochs,
  deviceId: string,
): void {
  epochs.next += 1;
  epochs.byDevice.set(deviceId, epochs.next);
}

export function capturePresenceAvailabilityEpoch(
  epochs: PresenceAvailabilityEpochs,
  deviceId: string,
): number {
  return epochs.byDevice.get(deviceId) ?? 0;
}

export function isPresenceAvailabilityEpochCurrent(
  epochs: PresenceAvailabilityEpochs,
  deviceId: string,
  capturedEpoch: number,
): boolean {
  return capturePresenceAvailabilityEpoch(epochs, deviceId) === capturedEpoch;
}

export function resetPresenceAvailabilityEpochs(
  epochs: PresenceAvailabilityEpochs,
): void {
  epochs.next = 0;
  epochs.byDevice.clear();
}

export interface PresenceTrackedRequest<T> {
  capturedPresenceEpoch: number;
  request: Promise<T>;
}

export function getOrCreatePresenceTrackedRequest<T>(
  inFlight: Map<string, PresenceTrackedRequest<T>>,
  epochs: PresenceAvailabilityEpochs,
  deviceId: string,
  createRequest: () => Promise<T>,
): PresenceTrackedRequest<T> {
  const existing = inFlight.get(deviceId);
  if (existing) return existing;

  const tracked = {
    capturedPresenceEpoch: capturePresenceAvailabilityEpoch(epochs, deviceId),
    request: createRequest(),
  };
  inFlight.set(deviceId, tracked);
  const cleanup = (): void => {
    if (inFlight.get(deviceId) === tracked) inFlight.delete(deviceId);
  };
  void tracked.request.then(cleanup, cleanup);
  return tracked;
}

export interface PresenceWipeTimerDeps {
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  wipe(deviceId: string): void;
}

export function schedulePresenceWipeTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  availabilityByDevice: ReadonlyMap<string, boolean>,
  deviceId: string,
  delayMs: number,
  deps: PresenceWipeTimerDeps,
): void {
  if (timers.has(deviceId)) return;
  timers.set(deviceId, deps.setTimer(() => {
    timers.delete(deviceId);
    if (shouldWipeUnavailableDeviceMirror(availabilityByDevice, deviceId)) {
      deps.wipe(deviceId);
    }
  }, delayMs));
}

export function clearPresenceWipeTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  deviceId: string,
  clearTimer: PresenceWipeTimerDeps['clearTimer'],
): void {
  const timer = timers.get(deviceId);
  if (!timer) return;
  clearTimer(timer);
  timers.delete(deviceId);
}

export function clearPresenceWipeTimers(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  clearTimer: PresenceWipeTimerDeps['clearTimer'],
): void {
  for (const timer of timers.values()) clearTimer(timer);
  timers.clear();
}

export function shouldWipeUnavailableDeviceMirror(
  availabilityByDevice: ReadonlyMap<string, boolean>,
  deviceId: string,
): boolean {
  // 新连接不会重放全量 presence,因此 reconnect 清掉旧 verdict 后的 unknown
  // 仍需让原宽限计时器按期回收;只有当前代已明确 available 才取消清理。
  return availabilityByDevice.get(deviceId) !== true;
}

export function isPresenceEligibleForRemoteRequest(
  availabilityByDevice: ReadonlyMap<string, boolean>,
  deviceId: string,
): boolean {
  // 首次尚未收到 presence 时保留既有乐观尝试;只有 relay 已明确声明 unavailable
  // 才拦住 rehydrate / half-open probe,避免对离线设备立即重放请求风暴。
  return availabilityByDevice.get(deviceId) !== false;
}

export function resetPresenceAvailabilityForConnection(
  availabilityByDevice: Map<string, boolean>,
  pendingRecoveryDeviceIds: Set<string>,
): string[] {
  // presence-changed 是只发给「当时在线控制端」的增量广播,新连接没有全量重放。
  // 每个连接代际都必须丢弃旧 verdict,否则后台期间漏掉的恢复事件会让 stale false
  // 永久挡住该设备的 rehydrate。上一代明确 unavailable 的设备另存为 pending
  // recovery:当前连接按 unknown 乐观尝试,而它稍后首个 available 快照仍能形成恢复边。
  const unavailableDeviceIds = [...availabilityByDevice.entries()]
    .filter(([, available]) => !available)
    .map(([deviceId]) => deviceId);
  for (const deviceId of unavailableDeviceIds) pendingRecoveryDeviceIds.add(deviceId);
  availabilityByDevice.clear();
  return unavailableDeviceIds;
}

export function updatePresenceAvailability(
  availabilityByDevice: Map<string, boolean>,
  snap: PresenceAvailabilitySnapshot,
  pendingRecoveryDeviceIds?: Set<string>,
): PresenceAvailabilityUpdate {
  const available = snap.online && snap.remoteControlEnabled;
  const wasAvailable = availabilityByDevice.get(snap.deviceId);
  availabilityByDevice.set(snap.deviceId, available);
  const recoveredAcrossConnection = available && pendingRecoveryDeviceIds?.delete(snap.deviceId) === true;
  if (!available) pendingRecoveryDeviceIds?.add(snap.deviceId);
  return {
    available,
    recovered: available && (wasAvailable === false || recoveredAcrossConnection),
  };
}
