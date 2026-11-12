import { Remote, RemoteError, principalOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { setTrack } from '@dsh-workbench/dsh-governance/tracks';
import { switchSessionRole } from '@dsh-workbench/dsh-governance/bindings';
import { randomUUID } from 'node:crypto';
import Schema from '@deepseek-ai/schemastery';
import { TYPERT } from './remote.mjs';
import { readHarnessStatus, readWorkspaceIndexStatus } from './status.mjs';

export const name = 'dsh-session-controls';
export const inject = ['typert', 'llm'];
export const Config = Schema.object({});
const initializers = [];
class HarnessUiService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'dshSessionControlsUi');
    for (const initialize of initializers) initialize.call(this);
  }
  async status(agent, signal) {
    signal?.throwIfAborted();
    const isOwner = Boolean(this.ctx.invocation) && principalOf(this.ctx.invocation) === undefined;
    const status = readHarnessStatus(this.ctx, agent, { isOwner });
    const workspaceIndex = await readWorkspaceIndexStatus(this.ctx, agent, signal);
    return { ...status, workspaceIndex };
  }
  async setTrack(agent, mode, expectedRevision, signal) {
    signal?.throwIfAborted();
    if (!this.ctx.invocation || principalOf(this.ctx.invocation) !== undefined) throw new RemoteError('gateway/bad-request', 'Only the owner UI may change worker tracks.');
    try { await setTrack(this.ctx, agent.session.id, mode, expectedRevision); }
    catch (error) { throw new RemoteError('gateway/bad-request', error.message); }
    const log = this.ctx.get('storageDomain')?.get?.('dsh_governance_events');
    let selectionLog = 'unavailable';
    if (log) {
      const id = randomUUID();
      try { await log.table('events').put(id, { v: 1, id, ts: Date.now(), kind: 'info', session: agent.session.id, decision: 'track-selected', reason: `Owner selected worker track ${mode}; lead model unchanged.`, permissionGranted: false }); selectionLog = 'recorded'; }
      catch { selectionLog = 'write-failed'; }
    }
    return { ...await this.status(agent, signal), selectionLog };
  }
  async setRole(agent, roleId, signal) {
    signal?.throwIfAborted();
    if (!this.ctx.invocation || principalOf(this.ctx.invocation) !== undefined) throw new RemoteError('gateway/bad-request', 'Only the owner UI may switch session roles.');
    let switched;
    try { switched = await switchSessionRole(this.ctx, agent, roleId); }
    catch (error) { throw new RemoteError('gateway/bad-request', error.message); }
    const log = this.ctx.get('storageDomain')?.get?.('dsh_governance_events');
    let selectionLog = 'unavailable';
    if (log) {
      const id = randomUUID();
      const modelStr = switched?.model?.model ? ` (${switched.model.provider}/${switched.model.model})` : '';
      try { await log.table('events').put(id, { v: 1, id, ts: Date.now(), kind: 'info', session: agent.session.id, decision: 'role-selected', reason: `Owner switched session role to ${roleId}${modelStr}.`, permissionGranted: false }); selectionLog = 'recorded'; }
      catch { selectionLog = 'write-failed'; }
    }
    return { ...await this.status(agent, signal), selectionLog };
  }

}

for (const name of ['status', 'setTrack', 'setRole']) Remote(HarnessUiService.prototype[name], { kind: 'method', name, static: false, private: false,
  addInitializer(fn) { initializers.push(fn); } });

export function apply(ctx) {
  ctx.get('typert').register(TYPERT);
  new HarnessUiService(ctx);
}
