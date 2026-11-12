import Schema from '@deepseek-ai/schemastery';
import { defaults, startRefresh } from './refresh.mjs';

export const name = 'dsh-chat-search';
export const Config = Schema.object({
  dbPath: Schema.string().default(defaults.dbPath).description('DSH chat index database.'),
  sessionsRoot: Schema.string().default(defaults.sessionsRoot).description('DSH sessions directory.'),
  mcpDir: Schema.string().default(defaults.mcpDir).description('Absolute path to the separate DSH chat search server.'),
  pythonPath: Schema.string().default(defaults.pythonPath).description('Absolute path to its Python interpreter.'),
  embedBackend: Schema.string().default(defaults.embedBackend).description('Legacy setting, unused by keyword refresh.'),
  embedBaseUrl: Schema.string().default(defaults.embedBaseUrl).description('Legacy setting, unused by keyword refresh.'),
  embedModel: Schema.string().default(defaults.embedModel).description('Legacy setting, unused by keyword refresh.'),
  timeoutMs: Schema.number().min(1).max(2_147_483_647).default(defaults.timeoutMs).description('Maximum refresh runtime in milliseconds.'),
  autoUpdateOnTurnEnd: Schema.boolean().default(false).description('Run the incremental DSH index update after a turn ends.'),
});

export function apply(ctx, config = {}) {
  return startRefresh(ctx, { ...defaults, ...config });
}
