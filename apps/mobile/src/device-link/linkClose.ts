import type { Envelope } from '@cindy/device-link';

type DeviceScopedState = Pick<Map<string, unknown>, 'delete'>;

export function invalidatePeerLinkState(
  deviceId: string,
  openLinks: DeviceScopedState,
  remoteTopicAcks: DeviceScopedState,
): void {
  openLinks.delete(deviceId);
  remoteTopicAcks.delete(deviceId);
}

export function handlePeerLinkCloseFrame(
  env: Envelope,
  onLinkClosed: (deviceId: string) => void,
): boolean {
  if (env.kind !== 'link-close' || !env.src) return false;
  onLinkClosed(env.src);
  return true;
}
