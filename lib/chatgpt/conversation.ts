/**
 * Conversation identity helpers.
 *
 * The conversation id lives in the URL (`/c/<uuid>`); SPA navigations change
 * it without reloads, which is why the adapter re-checks on every mutation.
 */

const CONVERSATION_ID_RE =
  /\/c\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

export function conversationIdFromPath(pathname: string): string | null {
  const m = CONVERSATION_ID_RE.exec(pathname);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Strip app suffixes from the document title; empty results become null. */
export function conversationTitleFromDoc(doc: Document): string | null {
  const raw = doc.title ?? '';
  const cleaned = raw
    .replace(/\s*[|·—-]\s*(new\s+)?chat(gpt)?\s*$/i, '')
    .replace(/\s*[|·—-]\s*ChatGPT\s*$/i, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}
