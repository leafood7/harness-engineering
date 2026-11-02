import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  type AgentSession, type AgentSessionEvent, type ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
import type { JsonObject } from '@earendil-works/pi-ai';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import type { PreparedTask } from '../task.ts';
import { ToolGovernor, governedTool } from '../execution/tool-governor.ts';
import { readContext, contextEnvelope, compressToolResults, estimateContext, evidenceSummary } from '../context/manager.ts';
import { HarnessError } from '../util.ts';

export interface AdapterHooks {
  beforeRequest?(request:{estimatedInputTokens:number;maxOutputTokens:number;estimatedMaxCostUsd:number}):void;
  record?(kind:string,payload:Record<string,unknown>):void;
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
    const context = readContext(runDir);
    const config = prepared.input.context;
    const reserve = config?.outputReserveTokens ?? Math.min(4096,model.maxTokens);
    const inputLimit = Math.min(config?.maxInputTokens ?? 64000, model.contextWindow-reserve);
    if(inputLimit < 256 || reserve >= model.contextWindow)throw new HarnessError('invalid_context_budget','No room remains for input context');
    const threshold = Math.min(config?.compactAtTokens ?? Math.floor(model.contextWindow*0.75), model.contextWindow-reserve);
    const settings = SettingsManager.inMemory({ compaction: { enabled: config?.compaction !== 'off', reserveTokens: model.contextWindow-threshold, keepRecentTokens: config?.keepRecentTokens ?? 2048 }, retry: { enabled: false }, cacheWarming: 'off' });
    const loader = new DefaultResourceLoader({ cwd: prepared.workspace, agentDir: join(runDir, 'agent'), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: 'Complete the requested task using the available tools. Work only inside the task workspace. The host independently verifies your result.',
      extensionFactories: [(pi) => {
        pi.on('before_agent_start',()=>({message:{customType:'harness-context',content:contextEnvelope(context),display:false}}));
        pi.on('context',event=>{
          if(config?.projection==='none')return;
          const result=compressToolResults(event.messages,config?.toolResultMaxChars ?? 8192);
          if(result.omitted.length)hooks.record?.('context.projected',{omitted:result.omitted,source:'native-session',method:'bounded-tool-text'});
          return {messages:result.messages};
        });
        pi.on('context_with_system',(event,ctx)=>{
          const estimatedTokens=estimateContext(event.messages);
          hooks.record?.('context.measured',{estimatedTokens,method:'utf8-bytes-pessimistic-heuristic',inputLimit,outputReserveTokens:reserve,modelWindow:model.contextWindow,providerUsage:ctx.getContextUsage()});
          if(estimatedTokens>inputLimit)hooks.fault(new HarnessError('context_budget_exceeded','Projected request exceeds the configured context budget'));
        });
        pi.on('session_before_compact',event=>{
          if(runSignal.aborted)return {cancel:true};
          // Host evidence index avoids a hidden, unmetered summarization-model request.
          return {compaction:{summary:evidenceSummary(context,this.session?.sessionManager.getSessionFile(),[...event.preparation.messagesToSummarize,...event.preparation.turnPrefixMessages]),firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:event.preparation.tokensBefore,details:{method:'host-evidence-index.v1',contextDigest:context.digest}}};
        });
        pi.on('session_compact',event=>hooks.record?.('context.compacted',{entryId:event.compactionEntry.id,reason:event.reason,method:'host-evidence-index.v1',contextDigest:context.digest}));
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
    const stream=session.agent.streamFunction;
    session.agent.streamFunction=(model,request,options)=>{
      // Extension errors are swallowed by Pi; this final public stream boundary fails closed.
      runSignal.throwIfAborted();
      if(estimateContext(request.messages)>inputLimit){
        const error=new HarnessError('context_budget_exceeded','Final provider request exceeds context budget');hooks.fault(error);throw error;
      }
      const maxOutputTokens=Math.min(options?.maxTokens??reserve,reserve);
      const estimatedInputTokens=estimateContext(request.messages);
      const estimatedMaxCostUsd=(estimatedInputTokens*model.cost.input+maxOutputTokens*model.cost.output)/1000000;
      try{hooks.beforeRequest?.({estimatedInputTokens,maxOutputTokens,estimatedMaxCostUsd});}
      catch(error){hooks.fault(error);throw error;}
      runSignal.throwIfAborted();
      return stream(model,request,{...options,maxTokens:maxOutputTokens,...(selection.mode==='live'&&selection.temperature!==undefined?{temperature:selection.temperature}:{})});
    };
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
