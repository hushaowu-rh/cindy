import { describe, expect, it, vi } from 'vitest';
import {
  capturePresenceAvailabilityEpoch,
  clearPresenceWipeTimer,
  createPresenceAvailabilityEpochs,
  getOrCreatePresenceTrackedRequest,
  isPresenceAvailabilityEpochCurrent,
  isPresenceEligibleForRemoteRequest,
  markPresenceAvailabilityEpoch,
  resetPresenceAvailabilityEpochs,
  resetPresenceAvailabilityForConnection,
  schedulePresenceWipeTimer,
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

describe('unavailable mirror wipe timer', () => {
  function timerHarness() {
    vi.useFakeTimers();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const states = new Map<string, boolean>([['dev-1', false]]);
    const wipe = vi.fn();
    const deps = {
      setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
      clearTimer: clearTimeout,
      wipe,
    };
    schedulePresenceWipeTimer(timers, states, 'dev-1', 5_000, deps);
    return { deps, states, timers, wipe };
  }

  it('preserves the original deadline across reconnect and then cleans an unconfirmed device', () => {
    const { states, wipe } = timerHarness();
    vi.advanceTimersByTime(2_000);

    resetPresenceAvailabilityForConnection(states, new Set());
    expect(wipe).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_999);
    expect(wipe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(wipe).toHaveBeenCalledWith('dev-1');
    vi.useRealTimers();
  });

  it('cancels the original cleanup when the new connection proves the device reachable', () => {
    const { deps, states, timers, wipe } = timerHarness();
    vi.advanceTimersByTime(2_000);
    resetPresenceAvailabilityForConnection(states, new Set());

    clearPresenceWipeTimer(timers, 'dev-1', deps.clearTimer);
    vi.advanceTimersByTime(3_000);

    expect(wipe).not.toHaveBeenCalled();
    vi.useRealTimers();
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
