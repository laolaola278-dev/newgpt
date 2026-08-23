/**
 * Minimal ChatGPT-shaped DOM fixtures for adapter tests.
 *
 * They mirror the structural features the probe layer relies on
 * (data-testid, data-message-author-role, contenteditable) without copying
 * ChatGPT's real markup wholesale.
 */

export interface FixtureMessage {
  role: 'user' | 'assistant';
  id: string;
  text: string;
}

export const COMPOSER_HTML = `
<form>
  <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
  <button data-testid="send-button" type="button" aria-label="Send prompt"></button>
</form>
`;

/** Escape so protocol fences survive DOM insertion as literal text. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function messageHtml({ role, id, text }: FixtureMessage): string {
  return `<div data-message-author-role="${role}" data-message-id="${id}"><div class="whitespace-pre-wrap">${escapeHtml(text)}</div></div>`;
}

export function mountPage(options: {
  messages?: FixtureMessage[];
  withComposer?: boolean;
  withStopButton?: boolean;
} = {}): void {
  const { messages = [], withComposer = true, withStopButton = false } = options;
  document.body.innerHTML = `
    <main>
      <div id="thread">
        ${messages.map(messageHtml).join('\n')}
        ${withStopButton ? '<button data-testid="stop-button" aria-label="Stop streaming"></button>' : ''}
      </div>
      ${withComposer ? COMPOSER_HTML : ''}
    </main>
  `;
}

/** Append a single message element to the thread (simulates a new turn). */
export function appendMessage(msg: FixtureMessage): HTMLElement {
  const thread = document.getElementById('thread');
  if (!thread) throw new Error('fixture thread missing');
  thread.insertAdjacentHTML('beforeend', messageHtml(msg));
  return thread.lastElementChild as HTMLElement;
}

/** Replace an existing message's text content (simulates a streaming token). */
export function setMessageText(id: string, text: string): void {
  const el = document.querySelector(`[data-message-id="${id}"] .whitespace-pre-wrap`);
  if (!el) throw new Error(`message ${id} missing`);
  el.textContent = text;
}

export function setGenerating(on: boolean): void {
  const stop = document.querySelector('[data-testid="stop-button"]');
  if (on && !stop) {
    document.getElementById('thread')?.insertAdjacentHTML(
      'beforeend',
      '<button data-testid="stop-button" aria-label="Stop streaming"></button>',
    );
  } else if (!on && stop) {
    stop.remove();
  }
}

/** Fire the root observer by touching an irrelevant corner of the page. */
export function pulseObserver(): void {
  const nudge = document.createElement('span');
  document.body.appendChild(nudge);
  nudge.remove();
}
