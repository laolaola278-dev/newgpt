/**
 * DOM probing for the ChatGPT web app.
 *
 * Strategy: every landmark is probed through an ordered list of selectors —
 * stable attributes first (data-testid, ids), then structural/semantic
 * fallbacks. No single CSS class is ever load-bearing, because ChatGPT
 * regenerates utility classes between releases.
 */

export const SELECTORS = {
  composerEditable: [
    '#prompt-textarea',
    'form div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  composerTextarea: [
    'textarea[data-testid="prompt-textarea"]',
    'form textarea',
  ],
  sendButton: [
    'button[data-testid="send-button"]',
    'form button[type="submit"]',
    'button[aria-label*="send" i]',
  ],
  stopButton: [
    'button[data-testid="stop-button"]',
    'form button[aria-label*="stop" i]',
    'button[aria-label*="stop" i]',
  ],
  messageElement: ['[data-message-author-role]', '[data-message-id]'],
} as const;

/** First element matching any of the ordered selectors. */
export function firstMatch(scope: ParentNode, selectors: readonly string[]): Element | null {
  for (const sel of selectors) {
    try {
      const el = scope.querySelector(sel);
      if (el) return el;
    } catch {
      // Invalid selector on older browsers — try the next one.
    }
  }
  return null;
}

export function findComposer(doc: Document): HTMLElement | null {
  return (
    (firstMatch(doc, SELECTORS.composerEditable) as HTMLElement | null) ??
    (firstMatch(doc, SELECTORS.composerTextarea) as HTMLElement | null)
  );
}

export function findSendButton(doc: Document): HTMLButtonElement | null {
  return firstMatch(doc, SELECTORS.sendButton) as HTMLButtonElement | null;
}

export function findStopButton(doc: Document): HTMLButtonElement | null {
  return firstMatch(doc, SELECTORS.stopButton) as HTMLButtonElement | null;
}

/**
 * All message elements in document order. Guards against nested matches so a
 * wrapper carrying both attributes never yields duplicate entries.
 */
export function findMessageElements(doc: Document): HTMLElement[] {
  const seen = new Set<Element>();
  for (const sel of SELECTORS.messageElement) {
    for (const el of doc.querySelectorAll(sel)) seen.add(el);
  }
  const all = [...seen];
  return all.filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement &&
      !all.some((other) => other !== el && el.contains(other)),
  );
}
