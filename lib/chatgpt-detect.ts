/**
 * ChatGPT host detection.
 *
 * Single source of truth for "is this URL a ChatGPT page".
 * Used by the background worker, the side panel, and (indirectly) the
 * content script match patterns in the manifest.
 */

export const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

export const CHATGPT_MATCH_PATTERNS = [
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
];

export function isChatGptUrl(rawUrl: string | undefined | null): boolean {
  if (!rawUrl) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return CHATGPT_HOSTS.has(url.hostname);
}
