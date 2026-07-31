import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@cindy/device-link';
import { handlePeerLinkCloseFrame } from '@/device-link/linkClose';

describe('handlePeerLinkCloseFrame', () => {
  it.each(['user', 'toggle-off', 'shutdown', 'revoked'] as const)(
    'invalidates retained links on peer link-close (%s)',
    (reason) => {
      const onLinkClosed = vi.fn();
      const handled = handlePeerLinkCloseFrame({
        v: 1,
        kind: 'link-close',
        src: 'desktop-a',
        payload: { reason },
      } as Envelope, onLinkClosed);

      expect(handled).toBe(true);
      expect(onLinkClosed).toHaveBeenCalledWith('desktop-a');
    },
  );

  it('ignores unrelated frames', () => {
    const onLinkClosed = vi.fn();
    expect(handlePeerLinkCloseFrame({ v: 1, kind: 'push', src: 'desktop-a' } as Envelope, onLinkClosed)).toBe(false);
    expect(onLinkClosed).not.toHaveBeenCalled();
  });
});
