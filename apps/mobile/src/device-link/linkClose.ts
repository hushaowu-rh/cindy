import type { Envelope } from '@cindy/device-link';

export function handlePeerLinkCloseFrame(
  env: Envelope,
  onLinkClosed: (deviceId: string) => void,
): boolean {
  if (env.kind !== 'link-close' || !env.src) return false;
  onLinkClosed(env.src);
  return true;
}
