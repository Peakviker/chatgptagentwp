import 'dotenv/config';
import { Server, Tool, MCPError } from '@modelcontextprotocol/sdk/server';
import { z } from 'zod';
import { fetch } from 'undici';

const N8N_URL = process.env.N8N_URL?.replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY;
if (!N8N_URL || !N8N_API_KEY) {
  throw new Error('Set N8N_URL and N8N_API_KEY in .env');
}

async function n8n<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${N8N_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': N8N_API_KEY!,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new MCPError('server_error', `n8n ${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ===== Модель данных и справочник нод =====
const NodeSpec = z.object({
  display: z.string(),
  type: z.string(), // реальный type из n8n (n8n-nodes-base.httpRequest)
  defaults: z.record(z.any()).default({}),
});

const NODE_SPECS: Record<string, z.infer<typeof NodeSpec>> = {
  'Manual Trigger': { display: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', defaults: {} },
  Cron: { display: 'Cron', type: 'n8n-nodes-base.cron', defaults: {} },
  Webhook: { display: 'Webhook', type: 'n8n-nodes-base.webhook', defaults: { parameters: { path: 'hook', httpMethod: 'POST' } } },
  'HTTP Request': { display: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', defaults: {} },
};

// ===== Схемы аргументов =====
const CreateWorkflowArgs = z.object({
  name: z.string().min(1),
  workflow: z.union([z.string(), z.record(z.any())]).describe('n8n workflow JSON; строка или объект'),
  activate: z.boolean().optional().default(false),
});
const IdArgs = z.object({ id: z.union([z.number().int(), z.string()]) });
const ListArgs = z.object({ limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0) });

// Новый: план → рендер → создание
const PlanArgs = z.object({
  goal: z.string().describe('Что нужно автоматизировать'),
  trigger: z.enum(['manual', 'cron', 'webhook']).default('manual'),
  cron: z.string().optional().describe('CRON-выражение, если trigger=cron'),
  steps: z
    .array(
      z.object({
        id: z.string().optional(),
        type: z.string(), // "HTTP Request" и т.п.
        parameters: z.record(z.any()).default({}),
        dependsOn: z.array(z.string()).optional(),
      })
    )
    .default([]),
});

const RenderArgs = z.object({
  name: z.string(),
  trigger: z.enum(['manual', 'cron', 'webhook']).default('manual'),
  cron: z.string().optional(),
  steps: z.array(
    z.object({
      id: z.string().optional(),
      type: z.string(),
      parameters: z.record(z.any()).default({}),
      dependsOn: z.array(z.string()).optional(),
    })
  ),
});

// ===== Хелперы построения n8n JSON =====
function nextPos(idx: number): [number, number] {
  return [280 + idx * 220, 300];
}

function renderWorkflow(args: z.infer<typeof RenderArgs>) {
  const nodes: any[] = [];
  const connections: any = {};

  // 1) триггер
  const triggerId = '1';
  if (args.trigger === 'manual') {
    nodes.push({ id: triggerId, name: 'Manual Trigger', type: NODE_SPECS['Manual Trigger'].type, typeVersion: 1, position: nextPos(0) });
  } else if (args.trigger === 'cron') {
    nodes.push({ id: triggerId, name: 'Cron', type: NODE_SPECS['Cron'].type, typeVersion: 1, parameters: { triggerFunctions: [{ function: 'everyMinute' }] }, position: nextPos(0) });
    if (args.cron) nodes[nodes.length - 1].parameters = { rule: args.cron };
  } else {
    nodes.push({ id: triggerId, name: 'Webhook', type: NODE_SPECS['Webhook'].type, typeVersion: 1, parameters: NODE_SPECS['Webhook'].defaults.parameters, position: nextPos(0) });
  }

  // 2) шаги
  let order = 1;
  const idByStep: Record<string, string> = {};
  for (const s of args.steps) {
    const spec = NODE_SPECS[s.type] || { type: s.type, display: s.type, defaults: {} };
    const id = String(++order);
    idByStep[s.id || `${s.type}-${order}`] = id;
    nodes.push({ id, name: s.type, type: spec.type, typeVersion: 1, parameters: { ...(spec.defaults.parameters || {}), ...(s.parameters || {}) }, position: nextPos(order - 1) });
  }

  // 3) коннекты (если нет dependsOn — связываем линейно)
  let prev = triggerId;
  for (let i = 0; i < args.steps.length; i++) {
    const s = args.steps[i];
    const current = String(i + 2);
    const parents = s.dependsOn && s.dependsOn.length ? s.dependsOn.map((k) => (k === 'trigger' ? triggerId : idByStep[k] || prev)) : [prev];
    for (const p of parents) {
      connections[p] = connections[p] || { main: [[]] };
      connections[p].main[0].push({ node: current, type: 'main', index: 0 });
    }
    prev = current;
  }

  return { nodes, connections };
}

// ===== Инструменты =====
const tools: Tool[] = [
  // 0) Справочник доступных нод (для подсказок модели)
  {
    name: 'list_node_specs',
    description: 'Краткий список поддерживаемых нод и их внутренних типов',
    inputSchema: z.object({}).optional(),
    async handler() {
      return Object.entries(NODE_SPECS).map(([k, v]) => ({ name: k, type: v.type }));
    },
  },

  // 1) Планирование (LLM заполняет steps этого плана)
  {
    name: 'plan_workflow',
    description: 'Вернуть шаблон плана воркфлоу; LLM должна заполнить steps в ответе пользователю',
    inputSchema: PlanArgs,
    async handler(input) {
      const plan = PlanArgs.parse(input);
      return plan;
    },
  },

  // 2) Рендер плана в n8n JSON
  {
    name: 'render_workflow',
    description: 'Конвертировать план (steps) в валидный n8n JSON {nodes, connections}',
    inputSchema: RenderArgs,
    async handler(input) {
      const args = RenderArgs.parse(input);
      return renderWorkflow(args);
    },
  },

  // 3) Создать воркфлоу; можно сразу активировать
  {
    name: 'create_workflow',
    description: 'Создать воркфлоу из n8n‑JSON. Можно сразу активировать.',
    inputSchema: CreateWorkflowArgs,
    async handler(input) {
      const args = CreateWorkflowArgs.parse(input);
      const payload = typeof args.workflow === 'string' ? JSON.parse(args.workflow) : args.workflow;
      const created = await n8n<any>('/rest/workflows', { method: 'POST', body: JSON.stringify({ name: args.name, ...payload }) });
      if (args.activate) await n8n(`/rest/workflows/${created.id}/activate`, { method: 'POST' });
      return created;
    },
  },

  // 4) Комбо-операция
  {
    name: 'create_and_activate',
    description: 'Создать воркфлоу из n8n JSON и сразу активировать',
    inputSchema: z.object({ name: z.string(), workflow: z.any() }),
    async handler({ name, workflow }) {
      const created = await n8n<any>('/rest/workflows', { method: 'POST', body: JSON.stringify({ name, ...workflow }) });
      await n8n(`/rest/workflows/${created.id}/activate`, { method: 'POST' });
      return created;
    },
  },

  // 5) Стандартные операции
  { name: 'activate_workflow', description: 'Активировать воркфлоу по id', inputSchema: IdArgs, async handler({ id }) { await n8n(`/rest/workflows/${id}/activate`, { method: 'POST' }); return { id, active: true }; } },
  { name: 'deactivate_workflow', description: 'Деактивировать воркфлоу по id', inputSchema: IdArgs, async handler({ id }) { await n8n(`/rest/workflows/${id}/deactivate`, { method: 'POST' }); return { id, active: false }; } },
  { name: 'get_workflow', description: 'Получить воркфлоу по id', inputSchema: IdArgs, async handler({ id }) { return n8n(`/rest/workflows/${id}`); } },
  { name: 'list_workflows', description: 'Список воркфлоу (постранично)', inputSchema: ListArgs, async handler({ limit, offset }) { return n8n(`/rest/workflows?limit=${limit}&offset=${offset}`); } },
  { name: 'delete_workflow', description: 'Удалить воркфлоу по id', inputSchema: IdArgs, async handler({ id }) { await n8n(`/rest/workflows/${id}`, { method: 'DELETE' }); return { id, deleted: true }; } },
];

const server = new Server({ name: 'mcp-n8n', version: '0.2.0' });
for (const tool of tools) server.tool(tool);
server.start();
console.log('MCP n8n server started');

// В server.ts добавьте ещё один Tool
const ComposeArgs = z.object({
  name: z.string(),
  trigger: z.enum(['manual','cron','webhook']).default('manual'),
  cron: z.string().optional(),
  steps: z.array(
    z.object({
      id: z.string().optional(),
      type: z.string(),
      parameters: z.record(z.any()).default({}),
      dependsOn: z.array(z.string()).optional(),
    })
  ),
});

server.tool({
  name: 'compose_workflow',
  description: 'Создать воркфлоу из высокоуровневого описания (плана) и сразу активировать',
  inputSchema: ComposeArgs,
  async handler(input) {
    const args = ComposeArgs.parse(input);
    const workflow = renderWorkflow(args);
    const created = await n8n<any>('/rest/workflows', { method: 'POST', body: JSON.stringify({ name: args.name, ...workflow }) });
    await n8n(`/rest/workflows/${created.id}/activate`, { method: 'POST' });
    return created;
  },
});
