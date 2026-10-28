import type { EventEmitter } from 'node:events';
import { expect } from 'vitest';

/** Capture one setup phase's listeners, before downstream consumers add their own. */
export function observeListenerCleanup(emitter: EventEmitter, events: readonly string[]) {
  const before = new Map(events.map((event) => [event, emitter.listeners(event)]));
  const added = new Map<string, ReturnType<EventEmitter['listeners']>>();
  return {
    capture() {
      for (const event of events) {
        const listeners = emitter
          .listeners(event)
          .filter((listener) => !before.get(event)!.includes(listener));
        expect(listeners, `Setup must attach a ${event} listener`).not.toHaveLength(0);
        added.set(event, listeners);
      }
      return added;
    },
    expectDetached() {
      expect(added.size, 'Capture the installed listeners before checking cleanup').toBe(
        events.length,
      );
      for (const [event, listeners] of added) {
        for (const listener of listeners) {
          expect(emitter.listeners(event), `Retained ${event} listener`).not.toContain(listener);
        }
      }
    },
  };
}
