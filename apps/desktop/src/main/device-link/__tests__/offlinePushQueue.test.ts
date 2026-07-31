import { describe, expect, it } from 'vitest';
import { createOfflinePushQueue } from '../offlinePushQueue';

describe('offline push queue', () => {
  it('coalesces session state by channel and preserves event order', () => {
    let now = 1_000;
    const queue = createOfflinePushQueue({ now: () => now });

    queue.enqueue('dev-1', { channel: 'maker:activity', payload: { sessionId: 's1', phase: 'running' } });
    now += 1;
    queue.enqueue('dev-1', { channel: 'local-db:messages:created', payload: { sessionId: 's1', id: 'm1' } });
    now += 1;
    queue.enqueue('dev-1', { channel: 'maker:activity', payload: { sessionId: 's1', phase: 'completed' } });

    expect(queue.drain('dev-1')).toEqual([
      { channel: 'local-db:messages:created', payload: { sessionId: 's1', id: 'm1' } },
      { channel: 'maker:activity', payload: { sessionId: 's1', phase: 'completed' } },
    ]);
  });

  it('bounds queue length and bytes by evicting the oldest items', () => {
    const queue = createOfflinePushQueue({
      maxItems: 2,
      maxBytes: 20,
      estimateBytes: (item) => String((item.payload as { text: string }).text).length,
    });

    queue.enqueue('dev-1', { channel: 'a', payload: { text: '11111111' } });
    queue.enqueue('dev-1', { channel: 'b', payload: { text: '22222222' } });
    queue.enqueue('dev-1', { channel: 'c', payload: { text: '33333333' } });

    expect(queue.drain('dev-1').map((item) => item.channel)).toEqual(['b', 'c']);
  });

  it('expires items and isolates devices', () => {
    let now = 1_000;
    const queue = createOfflinePushQueue({ now: () => now, ttlMs: 100 });
    queue.enqueue('dev-1', { channel: 'a', payload: { value: 1 } });
    queue.enqueue('dev-2', { channel: 'b', payload: { value: 2 } });

    now += 101;
    expect(queue.drain('dev-1')).toEqual([]);
    expect(queue.drain('dev-2')).toEqual([]);
  });

  it('drops single entries that exceed the byte budget', () => {
    const queue = createOfflinePushQueue({ maxBytes: 4, estimateBytes: () => 5 });
    queue.enqueue('dev-1', { channel: 'big', payload: { value: 1 } });
    expect(queue.size('dev-1')).toBe(0);
  });
});
