import { describe, expect, it, vi } from 'vitest';

import {
  __composerInputLatencyProbeDefaultsForTest,
  createComposerInputLatencyProbe,
} from '@/lib/composerInputLatencyProbe';

type ScheduledFrame = {
  handle: number;
  callback: FrameRequestCallback;
};

function harness(options?: { thresholdMs?: number; maxLogsPerWindow?: number }) {
  let now = 0;
  let nextHandle = 1;
  const frames: ScheduledFrame[] = [];
  const cancelled: number[] = [];
  const debug = vi.fn();
  const probe = createComposerInputLatencyProbe({
    now: () => now,
    requestFrame: (callback) => {
      const handle = nextHandle++;
      frames.push({ handle, callback });
      return handle;
    },
    cancelFrame: (handle) => cancelled.push(handle),
    log: { debug },
    thresholdMs: options?.thresholdMs ?? 100,
    windowMs: 1_000,
    maxLogsPerWindow: options?.maxLogsPerWindow ?? 2,
  });

  return {
    probe,
    debug,
    frames,
    cancelled,
    setNow(value: number) {
      now = value;
    },
    runNextFrame(timestamp: number) {
      const frame = frames.shift();
      expect(frame).toBeDefined();
      frame?.callback(timestamp);
    },
  };
}

describe('createComposerInputLatencyProbe', () => {
  it('logs only slow frames and never includes editor content', () => {
    const h = harness();

    h.probe.markUpdate({ kind: 'document', composing: false, docSize: 42 });
    h.runNextFrame(80);
    expect(h.debug).not.toHaveBeenCalled();

    h.setNow(100);
    h.probe.markUpdate({ kind: 'document', composing: false, docSize: 57 });
    h.runNextFrame(250);
    expect(h.debug).toHaveBeenCalledWith('composer:input-slow kind=document dur=150ms docSize=57');
  });

  it('coalesces updates in one frame and ignores IME composition', () => {
    const h = harness();

    h.probe.markUpdate({ kind: 'document', composing: true, docSize: 10 });
    expect(h.frames).toHaveLength(0);

    h.probe.markUpdate({ kind: 'document', composing: false, docSize: 20 });
    h.setNow(25);
    h.probe.markUpdate({ kind: 'document', composing: false, docSize: 99 });
    expect(h.frames).toHaveLength(1);

    h.runNextFrame(125);
    expect(h.debug).toHaveBeenCalledWith('composer:input-slow kind=document dur=125ms docSize=99');
  });

  it('rate-limits slow logs within a window', () => {
    const h = harness({ maxLogsPerWindow: 2 });

    for (let i = 0; i < 3; i += 1) {
      h.setNow(i * 200);
      h.probe.markUpdate({ kind: 'document', composing: false, docSize: i + 1 });
      h.runNextFrame(i * 200 + 150);
    }
    expect(h.debug).toHaveBeenCalledTimes(2);

    h.setNow(1_200);
    h.probe.markUpdate({ kind: 'document', composing: false, docSize: 4 });
    h.runNextFrame(1_350);
    expect(h.debug).toHaveBeenCalledTimes(3);
  });

  it('cancels a pending frame on dispose', () => {
    const h = harness();
    h.probe.markUpdate({ kind: 'document', composing: false, docSize: 8 });

    h.probe.dispose();
    expect(h.cancelled).toEqual([1]);

    h.probe.markUpdate({ kind: 'document', composing: false, docSize: 9 });
    expect(h.frames).toHaveLength(1);
    h.runNextFrame(200);
    expect(h.debug).not.toHaveBeenCalled();
  });

  it('keeps conservative production defaults', () => {
    expect(__composerInputLatencyProbeDefaultsForTest).toEqual({
      thresholdMs: 100,
      windowMs: 10_000,
      maxLogsPerWindow: 20,
    });
  });
});
