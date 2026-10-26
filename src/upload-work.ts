/** Observes upload-owned promises without changing the operation's error or result. */
export function createUploadWork() {
  const pending = new WeakMap<object, Set<Promise<unknown>>>();
  return {
    track<T>(request: object, operation: Promise<T>): Promise<T> {
      let work = pending.get(request);
      if (work === undefined) {
        work = new Set();
        pending.set(request, work);
      }
      if (work.has(operation)) return operation;
      work.add(operation);
      const settled = () => {
        work.delete(operation);
        if (work.size === 0) pending.delete(request);
      };
      // Observe rejection immediately; the caller still receives the original promise.
      void operation.then(settled, settled);
      return operation;
    },
    async waitForIdle(request: object): Promise<void> {
      for (;;) {
        const work = pending.get(request);
        if (work === undefined) return;
        await Promise.allSettled(work);
        // Unwinding an operation can register a background drain; re-read the map.
      }
    },
  };
}

export type UploadWork = ReturnType<typeof createUploadWork>;
