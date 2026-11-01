import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  type AgentSession, type AgentSessionEvent, type ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
import type { JsonObject } from '@earendil-works/pi-ai';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import type { PreparedTask } from './task.ts';
import { ToolGovernor, governedTool } from './tool-governor.ts';
import { HarnessError } from './util.ts';

export interface AdapterHooks {
  event(event: AgentSessionEvent): void;
  beforeTool(event: ToolCallEvent): { block: true; reason: string } | undefined;
  fault(error: unknown): void;
}
export class PiAdapter {
  session?: AgentSession;
  unsubscribe?: () => void;
  async initialize(prepared: PreparedTask, runDir: string, hooks: AdapterHooks, governor: ToolGovernor, runSignal: AbortSignal,restore?:{modelCursor:number;sessionSnapshot?:string}): Promise<void> {
    if (VERSION !== '1.4.0') throw new HarnessError('sdk_version_mismatch', `Expected Pi 1.4.0, got ${VERSION}`);
    const modelRuntime = await ModelRuntime.create({ authPath: join(runDir, 'agent', 'auth.json'), modelsPath: null,
      modelsStorePath: join(runDir, 'model-cache.json'), allowModelNetwork: false, refreshOnCreate: false });
    const selection = prepared.input.model;
    let model;
    if (selection.mode === 'scripted') {
      const faux = fauxProvider({ provider: 'harness-scripted', models: [{ id: 'scripted-1', input: ['text'] }], tokensPerSecond: 1000000 });
      faux.setResponses(selection.responses.slice(restore?.modelCursor??0).map((step) => {
        const content = step.calls?.map((call) => fauxToolCall(call.name, call.arguments as JsonObject));
        return fauxAssistantMessage(content ?? step.text ?? '', { stopReason: content ? 'toolUse' : 'stop' });
      }));
      modelRuntime.registerNativeProvider(faux.provider);
      model = faux.getModel();
    } else {
      const key = process.env[selection.apiKeyEnv];
      if (!key) throw new HarnessError('missing_api_key', `Environment variable ${selection.apiKeyEnv} is not set`);
      await modelRuntime.setRuntimeApiKey(selection.provider, key);
      model = modelRuntime.getModel(selection.provider, selection.id);
      if (!model) throw new HarnessError('model_not_found', 'Selected model is absent from the pinned Pi catalog');
    }
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
    const loader = new DefaultResourceLoader({ cwd: prepared.workspace, agentDir: join(runDir, 'agent'), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: 'Complete the requested task using the available tools. Work only inside the task workspace. The host independently verifies your result.',
      extensionFactories: [(pi) => {
        pi.on('tool_call', (event) => {
          try { return hooks.beforeTool(event); }
          catch (error) { hooks.fault(error); throw error; }
        });
        pi.registerTool(governedTool(createReadToolDefinition(prepared.workspace), governor, runSignal, hooks.fault));
        pi.registerTool(governedTool(createWriteToolDefinition(prepared.workspace), governor, runSignal, hooks.fault));
        pi.registerTool(governedTool(createEditToolDefinition(prepared.workspace), governor, runSignal, hooks.fault));
        pi.registerTool(governedTool({ name: 'wait', label: 'Wait', description: 'Wait for a bounded duration; supports cancellation.',
          parameters: Type.Object({ durationMs: Type.Integer({ minimum: 0, maximum: 120000 }) }),
          execute: async (_id, args, signal) => {
            await sleep(args.durationMs, undefined, { signal });
            return { content: [{ type: 'text', text: 'Wait finished' }], details: {} };
          }
        }, governor, runSignal, hooks.fault));
      }] });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new HarnessError('extension_load_failed', 'Harness extension failed to load');
    const { session } = await createAgentSession({ cwd: prepared.workspace, agentDir: join(runDir, 'agent'),
      modelRuntime, model, thinkingLevel: 'off', resourceLoader: loader, settingsManager: settings,
      sessionManager: restore?.sessionSnapshot?SessionManager.forkFrom(restore.sessionSnapshot,prepared.workspace,join(runDir,'sessions')):SessionManager.create(prepared.workspace, join(runDir, 'sessions')), tools: prepared.input.tools });
    this.session = session;
    this.unsubscribe = session.subscribe((event) => { try { hooks.event(event); } catch (error) { hooks.fault(error); } });
    await session.bindExtensions({ mode: 'json', onError: (error) => hooks.fault(new HarnessError('extension_failed', error.error)) });
  }
  async prompt(input: string): Promise<void> {
    if (!this.session) throw new Error('Adapter not initialized');
    await this.session.prompt(input);
    await this.session.waitForIdle();
  }
  async abort(): Promise<void> { await this.session?.abort(); }
  dispose(): void { this.unsubscribe?.(); this.session?.dispose(); }
}
