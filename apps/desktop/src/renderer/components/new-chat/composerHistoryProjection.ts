import type { ComposerHistoryEntry } from '@/lib/composerQuoteDocument';

export type ComposerHistoryMessage = {
  role: string;
  content: string;
  quotesEncoded?: boolean;
};

/**
 * Builds a stable user-message projection. If assistant streaming replaces the
 * parent messages array without changing user rows, the previous array is
 * returned so ChatInput's history consumers do not receive new identities.
 */
export function deriveStableComposerHistory(
  messages: ComposerHistoryMessage[] | undefined,
  previous: readonly ComposerHistoryEntry[],
): ComposerHistoryEntry[] {
  const next = (messages ?? [])
    .filter((message) => message.role === 'user' && message.content.trim())
    .map((message): ComposerHistoryEntry => ({
      content: message.content,
      ...(message.quotesEncoded === true ? { quotesEncoded: true } : {}),
    }))
    .reverse();

  if (
    next.length === previous.length &&
    next.every(
      (entry, index) =>
        entry.content === previous[index]?.content &&
        entry.quotesEncoded === previous[index]?.quotesEncoded,
    )
  ) {
    return previous as ComposerHistoryEntry[];
  }
  return next;
}
