import { describe, expect, it, vi } from 'vitest';
import { rehydrateDeviceLinkTopics } from '@/device-link/rehydrate';
import type { DeviceLinkRehydrateDeps } from '@/device-link/rehydrate';

function deps() {
  const calls: string[] = [];
  const cohorts = new Map<string, number>();
  let nextCohort = 0;
  const harness: DeviceLinkRehydrateDeps = {
    createDeviceSendCohort: vi.fn((deviceId: string) => {
      const cohort = ++nextCohort;
      cohorts.set(deviceId, cohort);
      return cohort;
    }),
    openLink: vi.fn(async (deviceId: string) => {
      calls.push(`open:${deviceId}`);
    }),
    subscribe: vi.fn(async (deviceId: string, topics) => {
      calls.push(`subscribe:${deviceId}:${topics.join(',')}`);
    }),
    requestSessionsReseed: vi.fn((deviceId: string) => {
      calls.push(`reseed:${deviceId}`);
    }),
    rebuildSessionSnapshot: vi.fn(async (deviceId: string, sessionId: string) => {
      calls.push(`rebuild:${deviceId}:${sessionId}`);
    }),
  };
  return { calls, harness };
}

describe('rehydrateDeviceLinkTopics', () => {
  it('replays open links, subscriptions, and host-authoritative snapshots in order', async () => {
    const { calls, harness } = deps();

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1', 'sessions'] },
      { deviceId: 'dev-2', openLink: false, topics: ['session:s2'] },
    ], harness);

    expect(calls).toEqual([
      'open:dev-1',
      'subscribe:dev-1:session:s1,sessions',
      'rebuild:dev-1:s1',
      'reseed:dev-1',
      'subscribe:dev-2:session:s2',
      'rebuild:dev-2:s2',
    ]);
  });

  it('shares one responsiveness cohort across every step for a device', async () => {
    const { harness } = deps();

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1', 'session:s2'] },
      { deviceId: 'dev-2', openLink: true, topics: ['session:s3'] },
    ], harness);

    expect(harness.createDeviceSendCohort).toHaveBeenCalledWith('dev-1');
    expect(harness.createDeviceSendCohort).toHaveBeenCalledWith('dev-2');
    expect(harness.createDeviceSendCohort).toHaveBeenCalledTimes(2);
    const dev1Cohort = vi.mocked(harness.openLink).mock.calls[0][1]?.responsivenessCohort;
    expect(dev1Cohort).toBeDefined();
    expect(vi.mocked(harness.subscribe).mock.calls[0][2]?.responsivenessCohort).toBe(dev1Cohort);
    expect(vi.mocked(harness.rebuildSessionSnapshot).mock.calls[0][2]?.responsivenessCohort).toBe(dev1Cohort);
    expect(vi.mocked(harness.rebuildSessionSnapshot).mock.calls[1][2]?.responsivenessCohort).toBe(dev1Cohort);
    expect(vi.mocked(harness.rebuildSessionSnapshot).mock.calls[2][2]?.responsivenessCohort).not.toBe(dev1Cohort);
  });

  it('continues rebuilding other devices and sessions when one replay step fails', async () => {
    const { calls, harness } = deps();
    vi.mocked(harness.openLink).mockRejectedValueOnce(new Error('open failed'));
    vi.mocked(harness.subscribe).mockRejectedValueOnce(new Error('subscribe failed'));
    vi.mocked(harness.rebuildSessionSnapshot).mockRejectedValueOnce(new Error('rebuild failed'));

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1', 'session:s2'] },
      { deviceId: 'dev-2', openLink: true, topics: ['sessions'] },
    ], harness);

    expect(calls).toEqual([
      'rebuild:dev-1:s2',
      'open:dev-2',
      'subscribe:dev-2:sessions',
      'reseed:dev-2',
    ]);
    expect(harness.openLink).toHaveBeenCalledTimes(2);
    expect(harness.subscribe).toHaveBeenCalledTimes(2);
    expect(harness.rebuildSessionSnapshot).toHaveBeenCalledTimes(2);
  });

  it('counts transient failures so the caller can schedule a backoff re-run', async () => {
    const { harness } = deps();
    vi.mocked(harness.subscribe).mockRejectedValueOnce(
      Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }),
    );
    vi.mocked(harness.rebuildSessionSnapshot).mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'INVOKE_TIMEOUT' }),
    );

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: false, topics: ['session:s1'] },
      { deviceId: 'dev-2', openLink: false, topics: ['session:s2'] },
    ], harness);

    expect(result.transientFailures).toBe(2);
  });

  it('does not count permanent failures (retrying them is pointless)', async () => {
    const { harness } = deps();
    vi.mocked(harness.openLink).mockRejectedValueOnce(
      Object.assign(new Error('disabled'), { code: 'REMOTE_DISABLED' }),
    );
    vi.mocked(harness.rebuildSessionSnapshot).mockRejectedValueOnce(new Error('unexpected'));

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1'] },
    ], harness);

    expect(result.transientFailures).toBe(0);
  });

  it('reports a clean pass with zero transient failures', async () => {
    const { harness } = deps();
    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1'] },
    ], harness);
    expect(result.transientFailures).toBe(0);
  });
});
