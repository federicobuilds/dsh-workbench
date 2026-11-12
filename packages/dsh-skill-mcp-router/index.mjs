import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolvePolicy } from '@dsh-workbench/dsh-governance/policy';
import { trackPolicyReader } from '@dsh-workbench/dsh-governance/tracks';
import { createEventStore } from '@dsh-workbench/dsh-governance/events';
import { redactText } from '@dsh-workbench/dsh-governance/redaction';
import { applyRouter } from './runner.mjs';
import { createRecommendationService } from './recommendation.mjs';
import { registerRecommendationRemote } from './remote.mjs';

export const name = 'dsh-skill-mcp-router';
export const inject = ['dshJudge', 'typert'];
export function apply(ctx, config = {}) {
  ctx.provide('routerRecommendation', createRecommendationService(ctx, createEventStore));
  registerRecommendationRemote(ctx);
  return applyRouter(ctx, { createUserMessage, resolvePolicy, trackPolicyReader, createEventStore, redactText, routingConfig: config });
}
