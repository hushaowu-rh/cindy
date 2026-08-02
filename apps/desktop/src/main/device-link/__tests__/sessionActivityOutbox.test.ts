/**
 * sessionActivityOutbox.test.ts — 键控 latest-wins 出站缓冲的行为契约(L2)。
 * ---------------------------------------------------------------------------
 * 核心不变量:
 *  1. 洪峰坍缩:任意长的 activity 更新风暴,出站帧数 = 不同 key 数(O(会话数)),
 *     且每个 key 只发**最新值**(接收端 last-write-wins,中间帧无交付价值)。
 *  2. 自钟控:每 peer 单个泵窗口 ≤ maxBurst 帧,剩余按 pacing 续泵 —— 单次爆发
 *     对 per-peer 可靠传输 pending(64 槽)的侵占有硬上限,invoke-result 与真
 *     事件流永远有余量(与 PR #1375 的 invoke-result 抢占协同)。
 *  3. BACKPRESSURE / 瞬态失败:条目保留,指数退避重试(250ms → 2s 封顶),
 *     恢复后续发的仍是**最新值**;PAYLOAD_TOO_LARGE 丢 key 防毒帧卡泵。
 *  4. relay 离线(canSend=false):缓冲保留、退避轮询,恢复在线自动续发 ——
 *     覆盖 client.sendPush 离线静默 no-op 的假成功空洞。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/xdt-maker-test/app',
    getPath: () => '/tmp/xdt-maker-test',
    getVersion: () => '0.0.0-test',
  },
}));

import { SessionActivityOutbox } from '../sessionActivityOutbox';

interface SentFrame {
  dst: string;
  channel: string;
  payload: unknown;
}

const CH = 'local-db:sessions:activity';
const key = (sessionId: string) => `${CH}:${sessionId}`;
const frame = (sessionId: string, detail: string) => ({ sessionId, phase: 'running', compactDetail: detail });

function makeOutbox(opts: {
  sendImpl?: (dst: string, channel: string, payload: unknown) => void;
  canSend?: () => boolean;
} = {}) {
  const sent: SentFrame[] = [];
  const send = vi.fn((dst: string, channel: string, payload: unknown) => {
    opts.sendImpl?.(dst, channel, payload);
    sent.push({ dst, channel, payload });
  });
  const outbox = new SessionActivityOutbox({
    send,
    canSend: opts.canSend ?? (() => true),
    maxBurst: 8,
    pacingMs: 250,
    backoffInitialMs: 250,
    backoffMaxMs: 2_000,
  });
  return { outbox, send, sent };
}

describe('SessionActivityOutbox — 键控 latest-wins', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a 200-frame mixed-session storm into one latest frame per key', () => {
    const { outbox, sent } = makeOutbox();
    // 200 条更新打散在 10 个会话上(每会话 20 连发)
    for (let i = 0; i < 200; i++) {
      const sessionId = `s${i % 10}`;
      outbox.enqueue('dev-a', key(sessionId), CH, frame(sessionId, `update-${i}`));
    }
    vi.advanceTimersByTime(2_000);
    expect(sent).toHaveLength(10);
    // 每个 key 只出最新值:s3 的末次更新是 i=193
    const s3 = sent.find((f) => (f.payload as { sessionId: string }).sessionId === 's3');
    expect((s3?.payload as { compactDetail: string }).compactDetail).toBe('update-193');
    expect(outbox.pendingCount('dev-a')).toBe(0);
  });

  it('sends only the latest value for rapid same-key updates', () => {
    const { outbox, sent } = makeOutbox();
    outbox.enqueue('dev-a', key('s1'), CH, frame('s1', 'v1'));
    outbox.enqueue('dev-a', key('s1'), CH, frame('s1', 'v2'));
    outbox.enqueue('dev-a', key('s1'), CH, frame('s1', 'v3'));
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(1);
    expect((sent[0].payload as { compactDetail: string }).compactDetail).toBe('v3');
  });

  it('respects the per-window burst cap and drains the rest on pacing ticks', () => {
    const { outbox, sent } = makeOutbox();
    for (let i = 0; i < 20; i++) {
      outbox.enqueue('dev-a', key(`s${i}`), CH, frame(`s${i}`, 'x'));
    }
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(8); // 首窗 ≤ maxBurst,64 槽 pending 永远吃不满
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(16);
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(20);
    expect(outbox.pendingCount('dev-a')).toBe(0);
  });

  it('keeps burst windows independent per peer', () => {
    const { outbox, sent } = makeOutbox();
    for (let i = 0; i < 10; i++) {
      outbox.enqueue('dev-a', key(`s${i}`), CH, frame(`s${i}`, 'a'));
      outbox.enqueue('dev-b', key(`s${i}`), CH, frame(`s${i}`, 'b'));
    }
    vi.advanceTimersByTime(0);
    expect(sent.filter((f) => f.dst === 'dev-a')).toHaveLength(8);
    expect(sent.filter((f) => f.dst === 'dev-b')).toHaveLength(8);
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(20);
  });

  it('retains entries on BACKPRESSURE and retries with the latest value after backoff', () => {
    let pressured = true;
    const { outbox, sent, send } = makeOutbox({
      sendImpl: () => {
        if (pressured) throw new DeviceLinkError('BACKPRESSURE', 'buffer full');
      },
    });
    outbox.enqueue('dev-a', key('s1'), CH, frame('s1', 'v1'));
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(0);
    expect(outbox.pendingCount('dev-a')).toBe(1); // 保留,没有丢
    // 退避期间新值覆盖同 key
    outbox.enqueue('dev-a', key('s1'), CH, frame('s1', 'v2'));
    pressured = false;
    vi.advanceTimersByTime(250); // 首档退避
    expect(sent).toHaveLength(1);
    expect((sent[0].payload as { compactDetail: string }).compactDetail).toBe('v2');
    expect(send).toHaveBeenCalledTimes(2); // 1 次失败 + 1 次成功
  });

  it('grows backoff exponentially up to the cap and resets after success', () => {
    let failures = 0;
    let pressured = true;
    const { outbox, sent } = makeOutbox({
      sendImpl: () => {
        if (pressured) {
          failures += 1;
          throw new DeviceLinkError('BACKPRESSURE', 'buffer full');
        }
      },
    });
    outbox.enqueue('dev-a', key('s1'), CH, frame('s1', 'v'));
    vi.advanceTimersByTime(0); // 失败#1 → 退避 250
    vi.advanceTimersByTime(250); // 失败#2 → 500
    vi.advanceTimersByTime(500); // 失败#3 → 1000
    vi.advanceTimersByTime(1_000); // 失败#4 → 2000
    vi.advanceTimersByTime(2_000); // 失败#5 → 封顶 2000
    expect(failures).toBe(5);
    vi.advanceTimersByTime(1_999);
    expect(failures).toBe(5); // 封顶后仍按 2s 节奏,不提前
    pressured = false;
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(outbox.pendingCount('dev-a')).toBe(0);
  });

  it('drops the key on PAYLOAD_TOO_LARGE and keeps pumping the rest', () => {
    const { outbox, sent } = makeOutbox({
      sendImpl: (_dst, _channel, payload) => {
        if ((payload as { sessionId: string }).sessionId === 's1') {
          throw new DeviceLinkError('PAYLOAD_TOO_LARGE', 'too big');
        }
      },
    });
    outbox.enqueue('dev-a', key('s1'), CH, frame('s1', 'poison'));
    outbox.enqueue('dev-a', key('s2'), CH, frame('s2', 'ok'));
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(1);
    expect((sent[0].payload as { sessionId: string }).sessionId).toBe('s2');
    expect(outbox.pendingCount('dev-a')).toBe(0); // 毒帧被丢弃,不卡泵
  });

  it('holds frames while offline and resends the latest once canSend flips back', () => {
    let online = false;
    const { outbox, sent } = makeOutbox({ canSend: () => online });
    outbox.enqueue('dev-a', key('s1'), CH, frame('s1', 'v1'));
    vi.advanceTimersByTime(3_000);
    expect(sent).toHaveLength(0);
    expect(outbox.pendingCount('dev-a')).toBe(1); // 断开期间缓冲保留
    outbox.enqueue('dev-a', key('s1'), CH, frame('s1', 'v2')); // 断开期间仍可覆盖
    online = true;
    vi.advanceTimersByTime(2_000); // 封顶退避内必然再泵一次
    expect(sent).toHaveLength(1);
    expect((sent[0].payload as { compactDetail: string }).compactDetail).toBe('v2');
  });

  it('clears per-peer state on clear() and everything on clearAll()', () => {
    const { outbox, sent } = makeOutbox({ canSend: () => false });
    outbox.enqueue('dev-a', key('s1'), CH, frame('s1', 'a'));
    outbox.enqueue('dev-b', key('s1'), CH, frame('s1', 'b'));
    outbox.clear('dev-a');
    expect(outbox.pendingCount('dev-a')).toBe(0);
    expect(outbox.pendingCount('dev-b')).toBe(1);
    outbox.clearAll();
    expect(outbox.pendingCount('dev-b')).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(0); // 清理后不再有任何定时器出帧
  });

  it('preserves oldest-first ordering and does not let overwrites starve older keys', () => {
    const { outbox, sent } = makeOutbox();
    for (let i = 0; i < 9; i++) {
      outbox.enqueue('dev-a', key(`s${i}`), CH, frame(`s${i}`, 'v0'));
    }
    // s0 在首窗发出前被反复覆盖:不改变它的队首位置
    outbox.enqueue('dev-a', key('s0'), CH, frame('s0', 'v1'));
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(8);
    expect((sent[0].payload as { sessionId: string }).sessionId).toBe('s0');
    expect((sent[0].payload as { compactDetail: string }).compactDetail).toBe('v1');
    // 第 9 个 key(s8)在下一个 pacing 窗口补上
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(9);
    expect((sent[8].payload as { sessionId: string }).sessionId).toBe('s8');
  });
});
