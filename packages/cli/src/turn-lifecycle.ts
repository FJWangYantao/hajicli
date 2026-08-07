import type { ChatMessage } from '@hajicli/core';

export interface PendingUserTurnSplit {
  history: ChatMessage[];
  pendingTurn: ChatMessage[];
}

/**
 * Split the latest user turn from committed history. Messages appended after the
 * user message (for example a locally expanded skill tool exchange) belong to
 * the pending turn and must not be sent to an automatic compaction request.
 */
export function splitPendingUserTurn(messages: readonly ChatMessage[]): PendingUserTurnSplit {
  let pendingTurnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      pendingTurnStart = index;
      break;
    }
  }

  if (pendingTurnStart < 0) {
    return { history: [...messages], pendingTurn: [] };
  }

  return {
    history: messages.slice(0, pendingTurnStart),
    pendingTurn: messages.slice(pendingTurnStart)
  };
}
