export function createRecommendationService(ctx, createEventStore) {
  return {
    latest(sessionId) {
      const domain = ctx.get('storageDomain')?.get?.('dsh_governance_events');
      if (!domain) return null;
      const event = createEventStore(domain).recent(Number.MAX_SAFE_INTEGER)
        .find(item => item.kind === 'judge' && item.router === 'skill-mcp-router' && item.session === sessionId);
      if (!event || event.decision !== 'recommendation' || (!event.skill && !event.mcp)) return null;
      return { id: event.id, skill: event.skill, mcp: event.mcp };
    },
  };
}
