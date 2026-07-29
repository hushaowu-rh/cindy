import type { Topic } from '@cindy/device-link';
import type { RehydratePlan } from '@/device-link/topicRegistry';
import { isTransientRemoteError } from '@/device-link/remoteRetry';

export interface DeviceLinkRehydrateSendOptions {
  /** 同一设备的一轮补齐共享一个响应性观测 cohort。 */
  responsivenessCohort?: number;
}

export interface DeviceLinkRehydrateDeps {
  createDeviceSendCohort(deviceId: string): number;
  openLink(deviceId: string, opts?: DeviceLinkRehydrateSendOptions): Promise<unknown>;
  subscribe(
    deviceId: string,
    topics: readonly Topic[],
    opts?: DeviceLinkRehydrateSendOptions,
  ): Promise<unknown>;
  requestSessionsReseed(deviceId: string): void;
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
  const track = async (step: Promise<unknown>): Promise<void> => {
    try {
      await step;
    } catch (err) {
      if (isTransientRemoteError(err)) transientFailures += 1;
    }
  };

  for (const plan of plans) {
    const sendOpts: DeviceLinkRehydrateSendOptions = {
      responsivenessCohort: deps.createDeviceSendCohort(plan.deviceId),
    };
    if (plan.openLink) {
      await track(deps.openLink(plan.deviceId, sendOpts));
    }

    if (plan.topics.length === 0) continue;
    await track(deps.subscribe(plan.deviceId, plan.topics, sendOpts));

    for (const topic of plan.topics) {
      if (topic === 'sessions') {
        deps.requestSessionsReseed(plan.deviceId);
        continue;
      }
      const sessionId = readSessionTopic(topic);
      if (sessionId) {
        await track(deps.rebuildSessionSnapshot(plan.deviceId, sessionId, sendOpts));
      }
    }
  }
  return { transientFailures };
}

function readSessionTopic(topic: Topic): string | null {
  if (!topic.startsWith('session:')) return null;
  const sessionId = topic.slice('session:'.length);
  return sessionId || null;
}
