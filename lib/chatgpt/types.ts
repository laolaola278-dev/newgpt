/**
 * Shared types for the ChatGPT adapter layer.
 *
 * Keep this minimal: only what Phase 1 actually consumes. Tool calling,
 * agent state, etc. arrive in later phases and will extend from here.
 */

export type ChatGPTMessageRole = 'user' | 'assistant' | 'system' | 'unknown';

export interface ChatGPTMessage {
  id: string;
  role: ChatGPTMessageRole;
  content: string;
  /** Live element reference — stripped before crossing the RPC boundary. */
  element?: HTMLElement;
  timestamp?: number;
  streaming?: boolean;
}

export interface ChatGPTAdapterEvents {
  'ready': undefined;
  'navigation': { conversationId: string | null };
  'message-added': { message: ChatGPTMessage };
  'message-updated': { message: ChatGPTMessage };
  'stream-start': { message: ChatGPTMessage | null };
  'stream-update': { message: ChatGPTMessage | null };
  'stream-end': { message: ChatGPTMessage | null };
  'composer-changed': { text: string };
}

/** Serializable snapshot used in RPC responses (no element references). */
export type ChatGPTMessageSnapshot = Omit<ChatGPTMessage, 'element'>;

export function toSnapshot(message: ChatGPTMessage): ChatGPTMessageSnapshot {
  const { element: _element, ...rest } = message;
  return rest;
}
