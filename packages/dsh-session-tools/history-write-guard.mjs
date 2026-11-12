const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const guarded = new WeakMap();

/**
 * Prevent the native late-first-system append that makes imported histories unreadable.
 * Only the session instance is wrapped; the host SDK and saved events are not modified.
 */
export function guardSessionSystemHead(session) {
  if (typeof session?.append !== 'function' || typeof session?.snapshotEvents !== 'function') throw new TypeError('A native Session is required for history integrity guarding');
  let entry = guarded.get(session);
  if (!entry) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(session, 'append');
    const original = session.append;
    /** Refuse only the known invalid native write, before delegating to Session.append. */
    function guardedAppend(type, ...args) {
      if (type === 'system/message') {
        const first = this.snapshotEvents().find(event => SURFACE_TYPES.has(event.type) && event.surfaceOp);
        if (first && first.type !== 'system/message') {
          const error = new Error('This imported history needs system-head recovery before continuing. Its saved messages were not changed.');
          error.name = 'HistoryRecoveryRequiredError';
          error.code = 'HISTORY_SYSTEM_HEAD_REQUIRED';
          throw error;
        }
      }
      return Reflect.apply(original, this, [type, ...args]);
    }
    entry = { originalDescriptor, guardedAppend, users: 0 };
    Object.defineProperty(session, 'append', { value: guardedAppend, writable: true, configurable: true });
    guarded.set(session, entry);
  }
  entry.users += 1;
  const reference = new WeakRef(session);
  let released = false;
  /** Release this guard owner without retaining an unloaded session or undoing another wrapper. */
  return function release() {
    if (released) return;
    released = true;
    entry.users -= 1;
    const target = reference.deref();
    if (!target || entry.users !== 0) return;
    if (target.append === entry.guardedAppend) {
      if (entry.originalDescriptor) Object.defineProperty(target, 'append', entry.originalDescriptor);
      else delete target.append;
    }
    guarded.delete(target);
  };
}
