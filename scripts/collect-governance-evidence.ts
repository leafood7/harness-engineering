import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunStore } from '../src/state/store.ts';
import { digest } from '../src/util.ts';

const project=resolve('.');
const destination=join(project,'validation','tool-governance');
const demoLines=readFileSync(join(project,'.artifacts/tool-governance/demo.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map((line)=>JSON.parse(line) as Record<string,unknown>);
const final=demoLines.find((line)=>line.status==='completed');
if(!final || typeof final.reportPath!=='string')throw new Error('Successful final demo is missing');
copyFileSync(final.reportPath,join(destination,'demo-report.json'));
const root=join(project,'.artifacts/tool-governance-integration');
const cases=readdirSync(root).map((name)=>join(root,name)).filter((path)=>statSync(path).isDirectory()).sort((a,b)=>statSync(b).birthtimeMs-statSync(a).birthtimeMs);
let approvalEvidence:unknown; let timeoutEvidence:unknown;
for(const folder of cases){
  const state=join(folder,'state');if(!existsSync(join(state,'state.sqlite')))continue;
  const store=new RunStore(state);
  try{
    const rows=store.db.prepare('SELECT id FROM runs').all() as Array<{id:string}>;
    for(const row of rows){
      const report=store.report(row.id);
      if(!approvalEvidence&&report.run.status==='completed'&&report.approvals.length===1&&report.approvals[0].status==='consumed'){
        const events=store.events(row.id);
        approvalEvidence={...report,events};
      }
      if(!timeoutEvidence&&report.run.error?.category==='tool_timeout'&&report.run.usage.toolCalls===2)timeoutEvidence={...report,events:store.events(row.id)};
    }
  }finally{store.close();}
  if(approvalEvidence&&timeoutEvidence)break;
}
if(!approvalEvidence||!timeoutEvidence)throw new Error('M2 evidence is incomplete');
writeFileSync(join(destination,'approval-test-report.json'),JSON.stringify(approvalEvidence,null,2));
writeFileSync(join(destination,'timeout-retry-test-report.json'),JSON.stringify(timeoutEvidence,null,2));
const files=['package.json','package-lock.json','tsconfig.json',...['src','contracts','tests','bin'].flatMap((folder)=>readdirSync(join(project,folder)).filter((name)=>/\.(ts|mjs)$/.test(name)).map((name)=>`${folder}/${name}`))];
const manifest=files.map((path)=>({path,sha256:digest(readFileSync(join(project,path)))}));
writeFileSync(join(destination,'source-manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({demoRunId:final.runId,approvalReport:'validation/tool-governance/approval-test-report.json',retryReport:'validation/tool-governance/timeout-retry-test-report.json',sourceFiles:manifest.length}));
