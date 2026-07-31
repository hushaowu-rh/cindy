export type ComposerTriggerSnapshot =
  | { kind: 'none' }
  | { kind: 'slash'; sigil: '/' | '$'; query: string; from: number }
  | { kind: 'at'; query: string; from: number };

export interface ComposerRenderSnapshot {
  trigger: ComposerTriggerSnapshot;
  hasMessage: boolean;
}

/**
 * Returns whether a React render is needed after an editor transaction.
 * Ordinary text updates with no active trigger keep the editor mutable outside
 * React; only palette state or the empty/non-empty send state can change.
 */
export function shouldRefreshComposerRender(
  previous: ComposerRenderSnapshot | null,
  next: ComposerRenderSnapshot,
): boolean {
  if (!previous) return true;
  if (previous.hasMessage !== next.hasMessage) return true;
  if (previous.trigger.kind !== next.trigger.kind) return true;
  if (next.trigger.kind === 'none') return false;
  if (previous.trigger.kind !== next.trigger.kind) return true;
  if (previous.trigger.from !== next.trigger.from) return true;
  if (
    next.trigger.kind === 'slash' &&
    previous.trigger.kind === 'slash' &&
    previous.trigger.sigil !== next.trigger.sigil
  ) {
    return true;
  }
  return previous.trigger.query !== next.trigger.query;
}

export function composerRenderSnapshot(
  trigger: ComposerTriggerSnapshot,
  hasMessage: boolean,
): ComposerRenderSnapshot {
  return { trigger, hasMessage };
}

export const __composerRenderGateDefaultsForTest = {
  ordinaryTextUpdatesRefresh: false,
};
