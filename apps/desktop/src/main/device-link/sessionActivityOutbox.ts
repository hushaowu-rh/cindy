/**
 * sessionActivityOutbox —— `sessions:activity` 状态通道的键控 latest-wins 出站缓冲。
 * ---------------------------------------------------------------------------
 * 动机(PR #1375 取证的结构性病根之一):活动摘要是**状态镜像**而非事件流——
 * 接收端(mobile remoteSessionStore.applySessionActivity / desktop
 * remoteSessionActivityStore)对同一 sessionId 严格 last-write-wins,中间帧没有
 * 任何交付价值。把它按事件逐帧塞进 per-peer 可靠传输缓冲(64 槽),爆发期(重连
 * replay / 多会话并发翻状态)会挤占 invoke-result 与真事件流的位置,是「push 洪流
 * 塞死 pending → invoke-result could not be queued → 手机熔断」链路的主要载荷。
 *
 * 本缓冲把出站量从 O(事件数) 收敛到 O(会话数),并自钟控:
 *  - 键控暂存:key = `channel:sessionId`,同 key 新帧**覆盖**旧帧(latest-wins),
 *    任意长的同会话更新风暴至多占一个槽;签名相同的重复入队自然合并。
 *  - 泵循环:每 peer 每个泵窗口最多 {@link DEFAULT_MAX_BURST} 帧交给传输层,
 *    剩余条目按 {@link DEFAULT_PACING_MS} 间隔续泵——单次爆发对 64 槽 pending
 *    的最大侵占恒为 maxBurst,给 invoke-result / maker:event 留出绝对余量。
 *  - BACKPRESSURE / 瞬态发送失败:条目**保留**在暂存区,指数退避重试
 *    (初始 {@link DEFAULT_BACKOFF_INITIAL_MS},上限 {@link DEFAULT_BACKOFF_MAX_MS});
 *    退避期间新帧照常覆盖同 key,恢复后只发每个 key 的最新值。
 *  - PAYLOAD_TOO_LARGE:丢弃该 key(活动帧是固定小结构,重试永不可能成功,
 *    不能让毒帧卡死整个 peer 的泵)。
 *  - peer link 断开/重建:缓冲保留(重连后自动续发最新值);peer 被移除
 *    (link-close / 撤权 / presence 离线清订阅 / 显式退订 sessions)时由 dispatch
 *    调 {@link SessionActivityOutbox.clear} 清理。
 *
 * 只收编 `sessions:activity` 这一个通道:maker:event 等真事件流每帧都有语义,
 * 绝不能 latest-wins,继续走原 forwardPush 直发路径。
 */

import { DeviceLinkError } from '@cindy/device-link';
import { createLogger } from '../logger';

const log = createLogger('device-link-activity-outbox');

/** 每 peer 单个泵窗口最多交给传输层的帧数(64 槽 pending 的侵占上限)。 */
const DEFAULT_MAX_BURST = 8;
/** 一个泵窗口发满后,续泵的间隔(自钟控节奏)。 */
const DEFAULT_PACING_MS = 250;
/** BACKPRESSURE / 瞬态失败后的首次重试延迟。 */
const DEFAULT_BACKOFF_INITIAL_MS = 250;
/** 指数退避上限。 */
const DEFAULT_BACKOFF_MAX_MS = 2_000;

type Timer = ReturnType<typeof setTimeout>;

export interface SessionActivityOutboxOptions {
  /** 把一帧交给传输层;失败以 DeviceLinkError 抛出(BACKPRESSURE 等)。 */
  send: (dst: string, channel: string, payload: unknown) => void;
  /**
   * 泵之前的可发送判定(activeClient 存在且 relay online)。false → 条目保留、
   * 按退避节奏轮询——覆盖 client.sendPush 在离线时**静默 no-op** 的空洞:若不
   * 预判,离线期的"成功"会错误清掉 key,断开/重建就丢了最新值。
   */
  canSend: () => boolean;
  maxBurst?: number;
  pacingMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

interface PeerOutboxState {
  /** key → 最新帧。Map 保序 = 先入队的 key 先泵出;覆盖不改变位置,无饥饿。 */
  entries: Map<string, { channel: string; payload: unknown }>;
  timer: Timer | null;
  /** 0 = 健康;>0 = 当前退避档位(毫秒)。 */
  backoffMs: number;
}

export class SessionActivityOutbox {
  private readonly send: (dst: string, channel: string, payload: unknown) => void;
  private readonly canSend: () => boolean;
  private readonly maxBurst: number;
  private readonly pacingMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly peers = new Map<string, PeerOutboxState>();

  constructor(options: SessionActivityOutboxOptions) {
    this.send = options.send;
    this.canSend = options.canSend;
    this.maxBurst = Math.max(1, options.maxBurst ?? DEFAULT_MAX_BURST);
    this.pacingMs = Math.max(0, options.pacingMs ?? DEFAULT_PACING_MS);
    this.backoffInitialMs = Math.max(1, options.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS);
    this.backoffMaxMs = Math.max(this.backoffInitialMs, options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS);
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /**
   * 入队(同 key 覆盖)。已有定时器时不抢跑:pacing 定时器代表节奏配额已用完,
   * 退避定时器代表传输层拥塞——两种情况下插队都只会放大洪峰。
   */
  enqueue(dst: string, key: string, channel: string, payload: unknown): void {
    let peer = this.peers.get(dst);
    if (!peer) {
      peer = { entries: new Map(), timer: null, backoffMs: 0 };
      this.peers.set(dst, peer);
    }
    // Map.set 对已存在 key 保持插入位置:覆盖不插队、不饥饿更早入队的 key。
    peer.entries.set(key, { channel, payload });
    if (!peer.timer) this.schedulePump(dst, peer, 0);
  }

  /** peer 被移除(link-close / 撤权 / 掉线清订阅 / 退订 sessions)时清理。 */
  clear(dst: string): void {
    const peer = this.peers.get(dst);
    if (!peer) return;
    if (peer.timer) this.clearTimer(peer.timer);
    this.peers.delete(dst);
  }

  clearAll(): void {
    for (const dst of [...this.peers.keys()]) this.clear(dst);
  }

  /** 测试/诊断:该 peer 暂存区当前缓冲的帧数(= 不同 key 数)。 */
  pendingCount(dst: string): number {
    return this.peers.get(dst)?.entries.size ?? 0;
  }

  private schedulePump(dst: string, peer: PeerOutboxState, delayMs: number): void {
    peer.timer = this.setTimer(() => {
      peer.timer = null;
      this.pump(dst, peer);
    }, delayMs);
  }

  private pump(dst: string, peer: PeerOutboxState): void {
    if (this.peers.get(dst) !== peer) return;
    if (peer.entries.size === 0) {
      this.peers.delete(dst);
      return;
    }
    if (!this.canSend()) {
      // relay 离线:保留全部条目,退避轮询等恢复(不能靠 send 的静默 no-op)。
      this.backoffAndReschedule(dst, peer);
      return;
    }
    let sent = 0;
    for (const [key, entry] of peer.entries) {
      if (sent >= this.maxBurst) break;
      try {
        this.send(dst, entry.channel, entry.payload);
      } catch (err) {
        if (err instanceof DeviceLinkError && err.code === 'PAYLOAD_TOO_LARGE') {
          // 固定小结构不可能超限;真发生只能是异常帧,重试永不收敛 → 丢弃防毒帧卡泵。
          log.warn(`dropping oversized activity frame for ${dst.slice(0, 8)} (${key})`);
          peer.entries.delete(key);
          continue;
        }
        // BACKPRESSURE / NOT_CONNECTED / socket 竞态:条目保留(含当前 key),退避重试。
        this.backoffAndReschedule(dst, peer);
        return;
      }
      peer.entries.delete(key);
      sent += 1;
    }
    peer.backoffMs = 0;
    if (peer.entries.size === 0) {
      this.peers.delete(dst);
      return;
    }
    this.schedulePump(dst, peer, this.pacingMs);
  }

  private backoffAndReschedule(dst: string, peer: PeerOutboxState): void {
    peer.backoffMs = peer.backoffMs === 0
      ? this.backoffInitialMs
      : Math.min(peer.backoffMs * 2, this.backoffMaxMs);
    this.schedulePump(dst, peer, peer.backoffMs);
  }
}
