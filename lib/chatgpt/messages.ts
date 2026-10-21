/**
 * Message parsing: turn probed elements into ChatGPTMessage values.
 */

import type { ChatGPTMessage, ChatGPTMessageRole } from './types';
import { findMessageElements } from './probe';

/** Normalize extracted text: strip CR, trailing spaces per line, collapse huge gaps. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/**
 * Extract visible text. `innerText` requires layout (absent in jsdom and some
 * embedded contexts), so fall back to `textContent` whenever needed.
 */
export function extractText(el: HTMLElement): string {
  const inner = (el as { innerText?: unknown }).innerText;
  if (typeof inner === 'string' && inner.trim().length > 0) {
    return normalizeText(inner);
  }
  return normalizeText(el.textContent ?? '');
}

function hashContent(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, '0');
}

const KNOWN_ROLES: readonly ChatGPTMessageRole[] = ['user', 'assistant', 'system'];

function resolveAttribute(el: HTMLElement, attr: string): string | null {
  return el.getAttribute(attr) ?? el.closest(`[${attr}]`)?.getAttribute(attr) ?? null;
}

export function parseMessage(el: HTMLElement, index: number, streaming: boolean): ChatGPTMessage {
  const roleAttr = resolveAttribute(el, 'data-message-author-role');
  const role =
    roleAttr !== null && (KNOWN_ROLES as readonly string[]).includes(roleAttr)
      ? (roleAttr as ChatGPTMessageRole)
      : 'unknown';
  const content = extractText(el);
  const domId = resolveAttribute(el, 'data-message-id');
  return {
    id: domId ?? `${role}-${index}-${hashContent(content)}`,
    role,
    content,
    element: el,
    streaming: streaming && role === 'assistant',
  };
}

export function listMessages(doc: Document, streaming: boolean): ChatGPTMessage[] {
  const elements = findMessageElements(doc);
  let lastAssistantIdx = -1;
  if (streaming) {
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      if (el && resolveAttribute(el, 'data-message-author-role') === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
  }
  return elements.map((el, i) =>
    parseMessage(el, i, streaming && i === lastAssistantIdx),
  );
}
