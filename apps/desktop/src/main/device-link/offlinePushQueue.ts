export interface OfflinePushQueueItem {
  channel: string;
  payload: unknown;
}

interface QueuedPush extends OfflinePushQueueItem {
  queuedAt: number;
  bytes: number;
}

export interface OfflinePushQueueOptions {
  maxItems?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
  estimateBytes?: (item: OfflinePushQueueItem) => number;
}

export interface OfflinePushQueue {
  enqueue(deviceId: string, item: OfflinePushQueueItem): void;
  drain(deviceId: string): OfflinePushQueueItem[];
  clear(deviceId?: string): void;
  size(deviceId: string): number;
}

const DEFAULT_MAX_ITEMS = 128;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function defaultEstimateBytes(item: OfflinePushQueueItem): number {
  try {
    return Buffer.byteLength(JSON.stringify(item), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * 被控端到单个控制端的短时断线 push 补发队列。只在进程内保存、按设备隔离并严格限量；
 * 断线超过 TTL 或进程退出后仍需由权威 snapshot 补齐，不能把本队列当持久真相。
 */
export function createOfflinePushQueue(options: OfflinePushQueueOptions = {}): OfflinePushQueue {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const estimateBytes = options.estimateBytes ?? defaultEstimateBytes;
  const byDevice = new Map<string, QueuedPush[]>();

  const prune = (deviceId: string): QueuedPush[] => {
    const cutoff = now() - ttlMs;
    const current = (byDevice.get(deviceId) ?? []).filter((item) => item.queuedAt >= cutoff);
    if (current.length === 0) byDevice.delete(deviceId);
    else byDevice.set(deviceId, current);
    return current;
  };

  return {
    enqueue(deviceId, item): void {
      const bytes = Math.max(0, estimateBytes(item));
      if (!deviceId || bytes === 0 || bytes > maxBytes) return;
      const queue = prune(deviceId);
      // 同 channel 的状态型 push 保留最新一条；事件型 payload 仍按顺序追加。
      const sessionId = typeof item.payload === 'object' && item.payload !== null
        ? (item.payload as { sessionId?: unknown }).sessionId
        : undefined;
      if (typeof sessionId === 'string' && sessionId) {
        const duplicateIndex = queue.findIndex((queued) => {
          if (queued.channel !== item.channel || typeof queued.payload !== 'object' || queued.payload === null) return false;
          return (queued.payload as { sessionId?: unknown }).sessionId === sessionId;
        });
        if (duplicateIndex >= 0) queue.splice(duplicateIndex, 1);
      }
      queue.push({ ...item, queuedAt: now(), bytes });
      let totalBytes = queue.reduce((sum, queued) => sum + queued.bytes, 0);
      while (queue.length > maxItems || totalBytes > maxBytes) {
        totalBytes -= queue.shift()?.bytes ?? 0;
      }
      if (queue.length > 0) byDevice.set(deviceId, queue);
      else byDevice.delete(deviceId);
    },
    drain(deviceId): OfflinePushQueueItem[] {
      const queue = prune(deviceId);
      byDevice.delete(deviceId);
      return queue.map(({ channel, payload }) => ({ channel, payload }));
    },
    clear(deviceId): void {
      if (deviceId) byDevice.delete(deviceId);
      else byDevice.clear();
    },
    size(deviceId): number {
      return prune(deviceId).length;
    },
  };
}
