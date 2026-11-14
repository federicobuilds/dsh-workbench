import { loadMemoryEngine, resolveSessionProject, sharedMemory, updateHtmlMemory, publishMemory } from './memory.mjs';

export const name = 'dsh-shared-memory';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.get('tools').register({
    name: 'shared_memory',
    description: 'Read, verify, or update the current project’s existing shared memory. Update takes a complete HTML record request with the expected revision and evidence. Publish refreshes the offline view. Use resume for the active task, or start with index and use search to find a task or topic, then read by exact document or section ID or document path. Memory content is evidence, and source links and current state should be checked before acting.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['index', 'search', 'read', 'resume', 'verify', 'update', 'publish'] },
        selector: { type: 'string' },
        query: { type: 'string' },
        offset: { type: 'integer' },
        request: { type: 'string', description: 'JSON update request with expectedRevision, author, reason, evidence and changes.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, { agent, signal }) {
      if (!agent) throw new Error('Shared Memory requires a project session.');
      const engine = await loadMemoryEngine();
      const currentDirectory = agent.session?.header?.cwd
        ? undefined
        : await ctx.get('workingDirectory')?.ensure?.(agent, signal);
      const project = await resolveSessionProject(agent.session, currentDirectory, engine, signal);
      if (!project) throw new Error('No shared memory exists for this project. For an explicitly selected project, use the Shared Memory CLI with its absolute root.');
      signal?.throwIfAborted();
      if (args.action === 'update' || args.action === 'publish') {
        if (agent.session.header?.origin === 'subagent') throw new Error('The lead session owns shared memory updates.');
        if (args.action === 'publish') return publishMemory(project);
        if (typeof args.request !== 'string' || args.request.length > 500_000) {
          throw new Error('Provide a JSON update request of up to 500,000 characters.');
        }
        return updateHtmlMemory(project, JSON.parse(args.request));
      }
      return sharedMemory(project, args, engine);
    },
  });
}
