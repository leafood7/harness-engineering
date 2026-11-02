import { Type, type Static } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { readFileSync, realpathSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { digest, snapshot, inside, HarnessError, now } from './util.ts';
import { toolMetadata } from './execution/tool-policy.ts';
import type { Task } from '../contracts/index.ts';

const object = { additionalProperties: false };
const text = Type.String({ minLength: 1 });
const call = Type.Object({ name: text, arguments: Type.Record(Type.String(), Type.Unknown()) }, object);
const rule = Type.Object({
  permission: Type.Optional(Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Literal('ask')])),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 10, maximum: 120000 })),
  retry: Type.Optional(Type.Object({ maxAttempts: Type.Integer({ minimum: 1, maximum: 5 }),
    initialDelayMs: Type.Integer({ minimum: 1, maximum: 5000 }), maxDelayMs: Type.Integer({ minimum: 1, maximum: 30000 }) }, object))
}, object);
export const TaskSchema = Type.Object({
  schemaVersion: Type.Literal(1), taskId: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' }),
  input: text, workspace: text,
  tools: Type.Array(Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('edit'), Type.Literal('wait')]), { uniqueItems: true }),
  budget: Type.Object({
    maxDurationMs: Type.Integer({ minimum: 50, maximum: 3600000 }),
    maxToolCalls: Type.Integer({ minimum: 0, maximum: 10000 }),
    maxTokens: Type.Integer({ minimum: 1, maximum: 10000000 }),
    maxCostUsd: Type.Optional(Type.Number({ minimum: 0 }))
  }, object),
  policy: Type.Optional(Type.Object({ version: text,
    approvalTimeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 300000 })),
    settleGraceMs: Type.Optional(Type.Integer({ minimum: 10, maximum: 10000 })),
    tools: Type.Optional(Type.Object({ read: Type.Optional(rule), write: Type.Optional(rule), edit: Type.Optional(rule), wait: Type.Optional(rule) }, object))
  }, object)),
  context: Type.Optional(Type.Object({
    projection: Type.Optional(Type.Union([Type.Literal('bounded'),Type.Literal('none')])),
    compaction: Type.Optional(Type.Union([Type.Literal('evidence'),Type.Literal('off')])),
    maxInputTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 1000000 })),
    outputReserveTokens: Type.Optional(Type.Integer({ minimum: 64, maximum: 128000 })),
    toolResultMaxChars: Type.Optional(Type.Integer({ minimum: 256, maximum: 65536 })),
    compactAtTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 1000000 })),
    keepRecentTokens: Type.Optional(Type.Integer({ minimum: 64, maximum: 64000 }))
  }, object)),
  memory: Type.Optional(Type.Object({ query: Type.String({ maxLength: 2048 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })) }, object)),
  model: Type.Union([
    Type.Object({ mode: Type.Literal('scripted'), responses: Type.Array(Type.Object({
      text: Type.Optional(Type.String()), calls: Type.Optional(Type.Array(call, { minItems: 1, maxItems: 32 }))
    }, object), { minItems: 1, maxItems: 1000 }) }, object),
    Type.Object({ mode: Type.Literal('live'), provider: text, id: text,
      temperature: Type.Optional(Type.Number({minimum:0,maximum:2})),
      apiKeyEnv: Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }) }, object)
  ]),
  verification: Type.Object({ version: text, checks: Type.Array(Type.Union([
    Type.Object({ kind: Type.Literal('file'), name: text, path: text, equals: Type.String() }, object),
    Type.Object({ kind: Type.Literal('node'), name: text, script: Type.String({ pattern: '\\.cjs$' }), args: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
      timeoutMs: Type.Integer({ minimum: 50, maximum: 120000 }) }, object)
  ]), { minItems: 1, maxItems: 32 }) }, object)
}, object);
export type TaskInput = Static<typeof TaskSchema>;
export interface PreparedTask { input: TaskInput; workspace: string; task: Task; verifierScripts: Record<string, string>; }

export function loadTask(file: string): TaskInput {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new HarnessError('invalid_task', 'Task must be a readable JSON file'); }
  return validateTask(parsed);
}
export function validateTask(parsed:unknown):TaskInput {
  if (!Check(TaskSchema, parsed)) {
    const paths = [...Errors(TaskSchema, parsed)].slice(0, 6).map((error) => error.instancePath);
    throw new HarnessError('invalid_task', `Task schema validation failed: ${paths.join(', ')}`);
  }
  for (const [name, rule] of Object.entries(parsed.policy?.tools ?? {})) {
    if (rule.retry && rule.retry.initialDelayMs > rule.retry.maxDelayMs) throw new HarnessError('invalid_task', 'Retry initial delay exceeds maximum delay');
    if ((rule.retry?.maxAttempts ?? 1) > 1 && !toolMetadata(name)?.retryable) throw new HarnessError('invalid_task', `${name} has side effects and cannot automatically retry`);
  }
  return parsed;
}
export function prepareTask(input: TaskInput, file: string, runDir: string, stateRoot: string, restore?: {workspace:string;verifierScripts:Record<string,string>}): PreparedTask {
  const workspace = realpathSync(restore?.workspace ?? resolve(dirname(file), input.workspace));
  if (inside(workspace, stateRoot)) throw new HarnessError('invalid_task', 'State directory must be outside the workspace; use --state');
  const manifest = snapshot(workspace);
  writeFileSync(join(runDir, 'initial-workspace.json'), JSON.stringify(manifest, null, 2));
  const verifierScripts: Record<string, string> = {};
  mkdirSync(join(runDir, 'verification'), { recursive: true });
  for (const [index, check] of input.verification.checks.entries()) {
    if (check.kind === 'node') {
      const target = join(runDir, 'verification', `check-${index}.cjs`);
      copyFileSync(restore?.verifierScripts[String(index)] ?? resolve(dirname(file), check.script), target);
      verifierScripts[String(index)] = target;
    }
  }
  const frozen = { verification: input.verification, scripts: Object.fromEntries(Object.entries(verifierScripts).map(([key, path]) => [key, digest(readFileSync(path))])) };
  const task: Task = { schemaVersion: 1, taskId: input.taskId, input: input.input,
    workspace: { path: workspace, initialSnapshot: manifest.digest }, toolAllowlist: input.tools,
    budget: input.budget, verificationSpec: { id: `${input.taskId}:verification`, version: input.verification.version, digest: digest(JSON.stringify(frozen)) }, createdAt: now() };
  writeFileSync(join(runDir, 'task.json'), JSON.stringify({ task, config: input, frozen }, null, 2));
  return { input, workspace, task, verifierScripts };
}
