import { describe, expect, it } from 'vitest';
import {
  capturePresenceAvailabilityEpoch,
  createPresenceAvailabilityEpochs,
  getOrCreatePresenceTrackedRequest,
  isPresenceAvailabilityEpochCurrent,
  isPresenceEligibleForRemoteRequest,
  markPresenceAvailabilityEpoch,
  resetPresenceAvailabilityEpochs,
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

describe('presence availability epochs', () => {
  it('invalidates an older probe only when that device receives a newer presence delta', () => {
    const epochs = createPresenceAvailabilityEpochs();
    const dev1ProbeEpoch = capturePresenceAvailabilityEpoch(epochs, 'dev-1');
    const dev2ProbeEpoch = capturePresenceAvailabilityEpoch(epochs, 'dev-2');

    markPresenceAvailabilityEpoch(epochs, 'dev-1');

    expect(isPresenceAvailabilityEpochCurrent(epochs, 'dev-1', dev1ProbeEpoch)).toBe(false);
    expect(isPresenceAvailabilityEpochCurrent(epochs, 'dev-2', dev2ProbeEpoch)).toBe(true);
  });

  it('keeps the request-creation epoch when callers share an in-flight request', async () => {
    const epochs = createPresenceAvailabilityEpochs();
    const inFlight = new Map();
    let resolveRequest!: () => void;
    const request = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });

    const first = getOrCreatePresenceTrackedRequest(
      inFlight,
      epochs,
      'dev-1',
      () => request,
    );
    markPresenceAvailabilityEpoch(epochs, 'dev-1');
    const deduped = getOrCreatePresenceTrackedRequest(
      inFlight,
      epochs,
      'dev-1',
      () => Promise.resolve(),
    );

    expect(deduped).toBe(first);
    expect(deduped.capturedPresenceEpoch).toBe(0);
    expect(isPresenceAvailabilityEpochCurrent(
      epochs,
      'dev-1',
      deduped.capturedPresenceEpoch,
    )).toBe(false);

    resolveRequest();
    await request;
  });

  it('resets epochs on logout or account change', () => {
    const epochs = createPresenceAvailabilityEpochs();
    markPresenceAvailabilityEpoch(epochs, 'dev-1');
    resetPresenceAvailabilityEpochs(epochs);

    expect(capturePresenceAvailabilityEpoch(epochs, 'dev-1')).toBe(0);
    expect(epochs.next).toBe(0);
  });
});
