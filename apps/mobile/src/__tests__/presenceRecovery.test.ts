import { describe, expect, it } from 'vitest';
import {
  isPresenceEligibleForRemoteRequest,
  resetPresenceAvailabilityForConnection,
  updatePresenceAvailability,
} from '@/device-link/presenceRecovery';

describe('updatePresenceAvailability', () => {
  it('does not treat the first available snapshot as a recovery', () => {
    const states = new Map<string, boolean>();

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: true,
      remoteControlEnabled: true,
    })).toEqual({
      available: true,
      recovered: false,
    });
  });

  it('marks offline to available as a recovery', () => {
    const states = new Map<string, boolean>();

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: false,
      remoteControlEnabled: true,
    })).toEqual({
      available: false,
      recovered: false,
    });
    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: true,
      remoteControlEnabled: true,
    })).toEqual({
      available: true,
      recovered: true,
    });
  });

  it('tracks devices independently', () => {
    const states = new Map<string, boolean>();

    updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: false,
      remoteControlEnabled: true,
    });

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-2',
      online: true,
      remoteControlEnabled: true,
    })).toEqual({
      available: true,
      recovered: false,
    });
  });

  it('forgets delta-only verdicts at a new connection epoch so stale offline cannot block rehydrate', () => {
    const states = new Map<string, boolean>();
    updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: false,
      remoteControlEnabled: true,
    });
    updatePresenceAvailability(states, {
      deviceId: 'dev-2',
      online: true,
      remoteControlEnabled: true,
    });
    expect(isPresenceEligibleForRemoteRequest(states, 'dev-1')).toBe(false);

    const pendingRecovery = new Set<string>();
    expect(resetPresenceAvailabilityForConnection(states, pendingRecovery)).toEqual(['dev-1']);

    expect(states.size).toBe(0);
    expect(pendingRecovery).toEqual(new Set(['dev-1']));
    expect(isPresenceEligibleForRemoteRequest(states, 'dev-1')).toBe(true);
    expect(isPresenceEligibleForRemoteRequest(states, 'dev-2')).toBe(true);

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: true,
      remoteControlEnabled: true,
    }, pendingRecovery)).toEqual({
      available: true,
      recovered: true,
    });
    expect(pendingRecovery.size).toBe(0);
  });
});
