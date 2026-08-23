import { describe, expect, it } from 'vitest';
import { isChatGptUrl } from '@/lib/chatgpt-detect';

describe('isChatGptUrl', () => {
  it('accepts chatgpt.com on any path', () => {
    expect(isChatGptUrl('https://chatgpt.com/')).toBe(true);
    expect(isChatGptUrl('https://chatgpt.com/c/abc123')).toBe(true);
    expect(isChatGptUrl('https://chatgpt.com/g/g-123/model')).toBe(true);
  });

  it('accepts the legacy chat.openai.com host', () => {
    expect(isChatGptUrl('https://chat.openai.com/')).toBe(true);
    expect(isChatGptUrl('https://chat.openai.com/c/abc')).toBe(true);
  });

  it('rejects other hosts and schemes', () => {
    expect(isChatGptUrl('https://evil.example/chatgpt.com')).toBe(false);
    expect(isChatGptUrl('http://chatgpt.com/')).toBe(false);
    expect(isChatGptUrl('file:///tmp/x.html')).toBe(false);
    expect(isChatGptUrl('chrome://extensions')).toBe(false);
  });

  it('rejects missing or malformed input', () => {
    expect(isChatGptUrl(undefined)).toBe(false);
    expect(isChatGptUrl('')).toBe(false);
    expect(isChatGptUrl('not a url')).toBe(false);
  });
});
