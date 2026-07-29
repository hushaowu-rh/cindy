import type { PresenceSnapshot } from '@cindy/device-link';

type PresenceAvailabilitySnapshot = Pick<PresenceSnapshot, 'deviceId' | 'online' | 'remoteControlEnabled'>;

export interface PresenceAvailabilityUpdate {
  available: boolean;
  recovered: boolean;
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
