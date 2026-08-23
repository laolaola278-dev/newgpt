/**
 * Tiny typed event emitter used by the adapter. No external deps.
 */

type Handler<T> = (payload: T) => void;

export class Emitter<E extends object> {
  private handlers = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(event: K, handler: Handler<E[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as Handler<E[K]>)(payload);
      } catch (err) {
        // A broken listener must never kill the observation loop.
        console.error('[GPT++] adapter event handler failed', err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
