/**
 * dispatchActivityBuffer.test.ts — dispatch 层对 `sessions:activity` 的收编契约(L2+L3)。
 * -------------------------------------------------------------------------------------
 * 生产取证(2026-08-02,单 iPhone 配对):重连窗口 forwardPush 失败 466 次中
 * sessions:activity 占 113;activity replay 是重连窗口秒满 per-peer 64 槽 pending
 * 的主要载体,挤掉 invoke-result(#1375 病根链)。本文件钉死两层修复的 dispatch 行为:
 *  [L2] forwardPush 把 sessions:activity 分流进键控 latest-wins 缓冲:洪峰坍缩成
 *       O(会话数)、每窗口 ≤8 帧自钟控;真事件流(maker:event / sessions:patched 等)
 *       路径零改动,逐帧直发。
 *  [L3] pushSessionActivityToController 只发给指定控制端(定向 replay 出口),
 *       其它控制端零帧;非 sessions 订阅者丢弃。
 *  清理钩子:掉线 / 撤权 / 退订 sessions → 该 peer 暂存区清空,不给幽灵设备留定时器。
 * 只 mock electron(app)+ settings-store;subscriptions 用真实模块。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeviceLinkError, SESSION_ACTIVITY_CHANNEL } from '@cindy/device-link';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/xdt-maker-test/app',
    getPath: () => '/tmp/xdt-maker-test',
    getVersion: () => '0.0.0-test',
  },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
const deviceLinkSettings = vi.hoisted(() => ({
  value: {
    remoteControlEnabled: true,
    revokedControllers: [] as string[],
  },
}));

vi.mock('../settings-store', () => ({
  readDeviceLinkSettings: () => deviceLinkSettings.value,
}));

import {
  __testing,
  handleControllerOffline,
  pushSessionActivityToController,
  setSessionsSubscribedListener,
} from '../dispatch';
import * as subscriptions from '../subscriptions';

interface PushCall {
  dst: string;
  channel: string;
  payload: unknown;
}

function mkClient() {
  const pushes: PushCall[] = [];
  const client = {
    getStatus: vi.fn(() => 'online'),
    sendInvokeResult: vi.fn(),
    sendLinkAccept: vi.fn(),
    closeLink: vi.fn(),
    onFrame: vi.fn(),
    sendPush: vi.fn((dst: string, channel: string, payload: unknown) => {
      pushes.push({ dst, channel, payload });
    }),
  };
  return { client, pushes };
}

const activity = (sessionId: string, detail: string) => ({
  sessionId,
  phase: 'running',
  compactDetail: detail,
  attention: false,
});

const activityFor = (pushes: PushCall[], dst: string) =>
  pushes.filter((p) => p.dst === dst && p.channel === SESSION_ACTIVITY_CHANNEL);

beforeEach(() => {
  vi.useFakeTimers();
  deviceLinkSettings.value = {
    remoteControlEnabled: true,
    revokedControllers: [],
  };
  __testing.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('[L2] forwardPush — sessions:activity 走键控 latest-wins 缓冲', () => {
  it('collapses an activity storm to one latest frame per session per controller', () => {
    const { client, pushes } = mkClient();
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-a', ['sessions']);
    subscriptions.subscribe('ctrl-b', ['sessions']);

    // 60 帧洪峰打散在 3 个会话上(接收端 last-write-wins,中间帧无交付价值)
    for (let i = 0; i < 60; i++) {
      const sessionId = `s${i % 3}`;
      __testing.forwardPush(SESSION_ACTIVITY_CHANNEL, activity(sessionId, `u${i}`));
    }
    vi.advanceTimersByTime(2_000);

    for (const dst of ['ctrl-a', 'ctrl-b']) {
      const got = activityFor(pushes, dst);
      expect(got).toHaveLength(3); // O(事件数) → O(会话数)
      const s2 = got.find((p) => (p.payload as { sessionId: string }).sessionId === 's2');
      expect((s2?.payload as { compactDetail: string }).compactDetail).toBe('u59'); // 只发最新值
    }
  });

  it('hands the transport at most 8 activity frames per pump window per controller', () => {
    const { client, pushes } = mkClient();
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-a', ['sessions']);

    for (let i = 0; i < 20; i++) {
      __testing.forwardPush(SESSION_ACTIVITY_CHANNEL, activity(`s${i}`, 'x'));
    }
    vi.advanceTimersByTime(0);
    // 单窗口 ≤8:对 64 槽 per-peer pending 的侵占有硬上限,invoke-result 永远有余量
    expect(activityFor(pushes, 'ctrl-a')).toHaveLength(8);
    vi.advanceTimersByTime(250);
    expect(activityFor(pushes, 'ctrl-a')).toHaveLength(16);
    vi.advanceTimersByTime(250);
    expect(activityFor(pushes, 'ctrl-a')).toHaveLength(20);
  });

  it('keeps real event channels on the direct per-frame path (zero behavior change)', () => {
    const { client, pushes } = mkClient();
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-a', ['sessions', 'session:s1']);

    __testing.forwardPush('maker:event', { sessionId: 's1', seq: 1 });
    __testing.forwardPush('maker:event', { sessionId: 's1', seq: 2 });
    __testing.forwardPush('local-db:sessions:patched', { sessionId: 's1', patch: {} });

    // 不经缓冲、不等定时器、逐帧直发,帧序与到达序一致
    expect(pushes.map((p) => p.channel)).toEqual([
      'maker:event',
      'maker:event',
      'local-db:sessions:patched',
    ]);
  });

  it('retains frames under BACKPRESSURE and delivers the latest value after backoff', () => {
    const { client, pushes } = mkClient();
    let pressured = true;
    client.sendPush.mockImplementation((dst: string, channel: string, payload: unknown) => {
      if (pressured) throw new DeviceLinkError('BACKPRESSURE', 'reliable transport buffer is full');
      pushes.push({ dst, channel, payload });
    });
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-a', ['sessions']);

    __testing.forwardPush(SESSION_ACTIVITY_CHANNEL, activity('s1', 'v1'));
    vi.advanceTimersByTime(0);
    expect(pushes).toHaveLength(0);
    // 退避期间状态继续演进:同 key 覆盖,不堆积
    __testing.forwardPush(SESSION_ACTIVITY_CHANNEL, activity('s1', 'v2'));
    pressured = false;
    vi.advanceTimersByTime(250);
    expect(activityFor(pushes, 'ctrl-a')).toHaveLength(1);
    expect((pushes[0].payload as { compactDetail: string }).compactDetail).toBe('v2');
  });
});

describe('[L3] pushSessionActivityToController — 定向 replay 出口', () => {
  it('delivers replay frames only to the subscribing controller; others get zero frames', () => {
    const { client, pushes } = mkClient();
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-a', ['sessions']);
    subscriptions.subscribe('ctrl-b', ['sessions']);

    pushSessionActivityToController('ctrl-a', activity('s1', 'replay') as never);
    pushSessionActivityToController('ctrl-a', activity('s2', 'replay') as never);
    vi.advanceTimersByTime(2_000);

    expect(activityFor(pushes, 'ctrl-a')).toHaveLength(2);
    expect(activityFor(pushes, 'ctrl-b')).toHaveLength(0); // 三端场景:B 不再陪吃 A 的 replay
  });

  it('compresses a replay burst through the same keyed buffer', () => {
    const { client, pushes } = mkClient();
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-a', ['sessions']);

    // 200 条 replay(terminalReplayPayloads 上限)只压成 ≤ 会话数帧
    for (let i = 0; i < 200; i++) {
      pushSessionActivityToController('ctrl-a', activity(`s${i % 3}`, `r${i}`) as never);
    }
    vi.advanceTimersByTime(2_000);
    expect(activityFor(pushes, 'ctrl-a')).toHaveLength(3);
  });

  it('coalesces replay with concurrent live publish for the same session (signature dedup)', () => {
    const { client, pushes } = mkClient();
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-a', ['sessions']);

    // 订阅触发的 replay 与紧随的 live publish 同帧同 key → 只出一帧
    pushSessionActivityToController('ctrl-a', activity('s1', 'same') as never);
    __testing.forwardPush(SESSION_ACTIVITY_CHANNEL, activity('s1', 'same'));
    vi.advanceTimersByTime(2_000);
    expect(activityFor(pushes, 'ctrl-a')).toHaveLength(1);
  });

  it('drops frames for controllers without a sessions subscription', () => {
    const { client, pushes } = mkClient();
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-heavy', ['session:s1']); // 只订了单会话流

    pushSessionActivityToController('ctrl-heavy', activity('s1', 'x') as never);
    pushSessionActivityToController('ctrl-unknown', activity('s1', 'x') as never);
    vi.advanceTimersByTime(2_000);
    expect(pushes).toHaveLength(0);
  });

  it('still passes the subscribing controller id to the replay listener', () => {
    const { client } = mkClient();
    __testing.setActiveClient(client as never);
    const seen: string[] = [];
    setSessionsSubscribedListener((controllerDeviceId) => {
      seen.push(controllerDeviceId);
    });
    __testing.handleSubscriptionFrame('ctrl-a', {
      channel: 'device-link:subscribe',
      args: [{ topics: ['sessions'] }],
    } as never);
    expect(seen).toEqual(['ctrl-a']); // L3 链路的第一跳:src 一路透传到 replay
    setSessionsSubscribedListener(null);
  });
});

describe('清理钩子 — 幽灵设备不留缓冲与定时器', () => {
  it('clears buffered frames when the controller goes offline / is revoked / unsubscribes', () => {
    const { client, pushes } = mkClient();
    client.sendPush.mockImplementation(() => {
      throw new DeviceLinkError('BACKPRESSURE', 'full'); // 压住,让帧滞留暂存区
    });
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('ctrl-a', ['sessions']);
    subscriptions.subscribe('ctrl-b', ['sessions']);
    subscriptions.subscribe('ctrl-c', ['sessions']);

    for (const dst of ['ctrl-a', 'ctrl-b', 'ctrl-c']) {
      pushSessionActivityToController(dst, activity('s1', 'x') as never);
    }
    vi.advanceTimersByTime(0);
    expect(__testing.sessionActivityOutbox.pendingCount('ctrl-a')).toBe(1);

    handleControllerOffline('ctrl-a');
    __testing.purgeRevokedController('ctrl-b');
    __testing.handleSubscriptionFrame('ctrl-c', {
      channel: 'device-link:unsubscribe',
      args: [{ topics: ['sessions'] }],
    } as never);

    expect(__testing.sessionActivityOutbox.pendingCount('ctrl-a')).toBe(0);
    expect(__testing.sessionActivityOutbox.pendingCount('ctrl-b')).toBe(0);
    expect(__testing.sessionActivityOutbox.pendingCount('ctrl-c')).toBe(0);

    client.sendPush.mockImplementation((dst: string, channel: string, payload: unknown) => {
      pushes.push({ dst, channel, payload });
    });
    vi.advanceTimersByTime(10_000);
    expect(pushes).toHaveLength(0); // 清理后没有任何残留定时器再出帧
  });
});
