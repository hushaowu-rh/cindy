import type { Topic } from '@cindy/device-link';
import type { RehydratePlan } from '@/device-link/topicRegistry';
import { isTransientRemoteError } from '@/device-link/remoteRetry';

export interface DeviceLinkRehydrateSendOptions {
  /** 同一设备的一轮快照 fan-out 共享一个响应性观测 cohort。 */
  responsivenessCohort?: number;
}

export interface DeviceLinkRehydrateDeps {
  createDeviceSendCohort(deviceId: string): number;
  openLink(deviceId: string): Promise<unknown>;
  subscribe(deviceId: string, topics: readonly Topic[]): Promise<unknown>;
  requestSessionsReseed(deviceId: string): void;
  onDeviceUnavailable?(deviceId: string): void;
  rebuildSessionSnapshot(
    deviceId: string,
    sessionId: string,
    opts?: DeviceLinkRehydrateSendOptions,
  ): Promise<unknown>;
}

export interface DeviceLinkRehydrateResult {
  /**
   * 瞬时失败的步骤数(网络 / 超时 / 未连接一类可重试失败)。永久失败(远控关闭 /
   * 权限撤销 / 通道不支持)不计入——重试它们没有意义。调用方据此安排退避重跑:
   * 补齐是 push 断档的唯一回填手段,一次性 best-effort 吞错等于把断连窗口内的
   * 消息静默丢在镜像外。
   */
  transientFailures: number;
}

/**
 * Replays controller intent after mobile foreground/background or relay
 * reconnect. Every step is best-effort because the host remains authoritative:
 * a failed topic must not block the next device/session from healing. The
 * caller is expected to re-run the plan (with backoff) while
 * `transientFailures > 0` — see DeviceLinkContext.
 */
export async function rehydrateDeviceLinkTopics(
  plans: readonly RehydratePlan[],
  deps: DeviceLinkRehydrateDeps,
): Promise<DeviceLinkRehydrateResult> {
  let transientFailures = 0;
  const track = async (
    deviceId: string,
    step: Promise<unknown>,
  ): Promise<'continue' | 'unavailable'> => {
    try {
      await step;
      return 'continue';
    } catch (err) {
      const unavailable = isDeviceOfflineError(err);
      if (unavailable) {
        deps.onDeviceUnavailable?.(deviceId);
      }
      if (!unavailable && isTransientRemoteError(err)) transientFailures += 1;
      return unavailable ? 'unavailable' : 'continue';
    }
  };

  for (const plan of plans) {
    if (
      plan.openLink
      && await track(plan.deviceId, deps.openLink(plan.deviceId)) === 'unavailable'
    ) {
      continue;
    }

    if (plan.topics.length === 0) continue;
    if (
      await track(plan.deviceId, deps.subscribe(plan.deviceId, plan.topics))
      === 'unavailable'
    ) {
      continue;
    }

    for (const topic of plan.topics) {
      if (topic === 'sessions') {
        deps.requestSessionsReseed(plan.deviceId);
        continue;
      }
      const sessionId = readSessionTopic(topic);
      if (sessionId) {
        // 每个 session snapshot 自身包含四路 Promise.allSettled fan-out;只把
        // 同一批真正并发的请求合并,不要把多个串行 session 的超时压成一次观测。
        if (await track(plan.deviceId, deps.rebuildSessionSnapshot(plan.deviceId, sessionId, {
          responsivenessCohort: deps.createDeviceSendCohort(plan.deviceId),
        })) === 'unavailable') {
          break;
        }
      }
    }
  }
  return { transientFailures };
}

function isDeviceOfflineError(error: unknown): boolean {
  if (typeof error === 'string') return error.includes('DEVICE_OFFLINE');
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'DEVICE_OFFLINE') return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('DEVICE_OFFLINE');
}

function readSessionTopic(topic: Topic): string | null {
  if (!topic.startsWith('session:')) return null;
  const sessionId = topic.slice('session:'.length);
  return sessionId || null;
}
