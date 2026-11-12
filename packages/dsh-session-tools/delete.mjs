import { randomUUID } from 'node:crypto';
import { lstat, realpath, readdir, unlink, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';

const ID = /^(?:session-)?[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const CURRENT = /^session\.v4\.jsonl(?:\.zstd)?$/;
const GENERATION = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/;
const refused = reason => Object.assign(new Error(reason), { reason });

export function createDeleteOperations({ persistence, registry, sessions, agents, activity, cache, now = Date.now, io = { lstat, realpath, readdir, unlink, open }, onRefusal = () => {} }) {
  const confirmations = new Map();
  const busy = new Set();
  let disposed = false;

  function validate(id) {
    if (disposed) throw refused('unavailable');
    if (typeof id !== 'string' || !ID.test(id)) throw refused('invalid');
  }
  function notLive(id) {
    if (sessions.get(id) !== undefined || agents.get(id) !== undefined) throw refused('live');
  }
  async function idle(id) {
    notLive(id);
    const work = await activity(id);
    if (!Array.isArray(work)) throw refused('unavailable');
    if (work.length) throw refused('active');
    notLive(id);
  }
  async function saved(id, signal) {
    const snapshot = await persistence.stat(id, { signal });
    if (!snapshot) throw refused('missing');
    if (snapshot.header.id !== id || snapshot.header.version !== 4 || snapshot.formatStatus === 'migration-required') throw refused('format');
    const path = snapshot.location?.path;
    if (snapshot.location?.kind !== 'jsonl' || typeof path !== 'string' || !isAbsolute(path) || !CURRENT.test(basename(path)) || basename(dirname(path)) !== id) throw refused('format');
    const dir = dirname(path);
    if (await io.realpath(path) !== path || await io.realpath(dir) !== dir || !(await io.lstat(path)).isFile()) throw refused('format');
    const files = await io.readdir(dir);
    const generations = files.filter(name => GENERATION.test(name));
    if (generations.length !== 1 || generations[0] !== basename(path)) throw refused('generations');
    return snapshot;
  }
  const reasonOf = error => error?.reason ?? (error?.name === 'SessionAlreadyOwnedError' || error?.name === 'WorkspaceActiveSessionError' ? 'active' : error?.name === 'SessionPersistenceNotFoundError' || error?.name === 'WorkspaceUnknownSessionError' || error?.code === 'ENOENT' ? 'missing' : 'storage');
  const reportRefusal = (stage, error) => {
    const sanitize = value => typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) : '';
    const diagnostic = { stage: sanitize(stage), name: sanitize(error?.name), code: sanitize(error?.code) };
    try {
      onRefusal({ ...diagnostic });
    } catch {}
    return diagnostic;
  };

  return {
    async prepare(id, peer, signal) {
      let stage = 'validate';
      try {
        validate(id);
        stage = 'idle';
        await idle(id);
        signal?.throwIfAborted();
        stage = 'saved';
        const snapshot = await saved(id, signal);
        for (const [token, entry] of confirmations) if (entry.expiresAt <= now() || entry.id === id && entry.peer === peer) confirmations.delete(token);
        if (confirmations.size >= 128) throw refused('busy');
        const token = randomUUID();
        const expiresAt = now() + 120_000;
        confirmations.set(token, { id, peer, revision: snapshot.revision, path: snapshot.location.path, expiresAt });
        return { ok: true, token, expiresAt, reason: '' };
      } catch (error) {
        const diagnostic = reportRefusal(stage, error);
        const reason = reasonOf(error);
        return { ok: false, token: '', expiresAt: 0, reason, ...(reason === 'storage' ? { diagnostic } : {}) };
      }
    },

    async commit(id, token, peer, signal) {
      let handle;
      let ownsBusy = false;
      let deleted = false;
      let wasArchived = true;
      let wasPinned = false;
      let archiveChanged = false;
      let reason = '';
      let diagnostic;
      let stage = 'validate';
      const warnings = [];
      try {
        validate(id);
        stage = 'confirmation';
        const confirmation = confirmations.get(token);
        if (!confirmation || confirmation.id !== id || confirmation.peer !== peer || confirmation.expiresAt <= now()) throw refused('confirmation');
        confirmations.delete(token); // Never reuse even after a failed attempt.
        if (busy.has(id)) throw refused('busy');
        busy.add(id);
        ownsBusy = true;
        stage = 'idle';
        await idle(id);
        stage = 'saved';
        let snapshot = await saved(id, signal);
        if (snapshot.revision !== confirmation.revision || snapshot.location.path !== confirmation.path) throw refused('changed');
        signal?.throwIfAborted();
        stage = 'open-write';
        handle = await persistence.open(id, 'write', { signal });
        stage = 'saved-after-open';
        snapshot = await saved(id, signal); // Read again under the kernel lease.
        if (snapshot.revision !== confirmation.revision || snapshot.location.path !== confirmation.path) throw refused('changed');
        stage = 'idle-after-open';
        await idle(id);
        if (disposed) throw refused('unavailable');
        stage = 'archive';
        wasArchived = registry.archivedSessionIds.includes(id);
        wasPinned = registry.pinnedSessionIds.includes(id);
        await registry.archiveSession(id); // Denies new turns through the host's archive gate.
        archiveChanged = !wasArchived;
        signal?.throwIfAborted();
        notLive(id);
        // Delete only the verified transcript. The stable session.lock inode stays.
        stage = 'unlink';
        await io.unlink(snapshot.location.path);
        deleted = true; // Irreversible commit point; cancellation no longer interrupts cleanup.
        try {
          const directory = await io.open(dirname(snapshot.location.path), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        } catch { warnings.push('durability'); }
        try {
          for (const workspace of registry.list()) if (workspace.sessionIds.includes(id)) await workspace.detachSession(id);
        } catch { warnings.push('workspace'); }
        try { if (cache) await cache.delete(id); } catch { warnings.push('cache'); }
        try { if (await persistence.stat(id) !== undefined) warnings.push('verification'); } catch { warnings.push('verification'); }
      } catch (error) {
        const refusal = reportRefusal(stage, error);
        reason = reasonOf(error);
        if (!deleted && reason === 'storage') diagnostic = refusal;
        if (!deleted && archiveChanged) {
          try {
            await registry.unarchiveSession(id);
            if (wasPinned) await registry.pinSession(id);
          } catch { warnings.push('restore'); }
        }
      } finally {
        try { await handle?.close(); } catch { warnings.push('lock'); }
        if (ownsBusy) busy.delete(id);
      }
      return { deleted, reason, warnings, ...(diagnostic ? { diagnostic } : {}) };
    },

    dispose() { disposed = true; confirmations.clear(); },
  };
}
