import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { runVerifier,killOwnedProcessTree } from '../src/verifier.ts';
import { workerAlive } from '../src/recovery.ts';
import { setTimeout as sleep } from 'node:timers/promises';

test('verifier pipe cleanup is not mistaken for confirmed process settlement',async()=>{
 const root=resolve('.artifacts','m3-verifier');mkdirSync(root,{recursive:true});const folder=mkdtempSync(join(root,'case-'));const marker=join(folder,'owned-child.pid');const script=join(folder,'parent.cjs');
 const payload=`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`;
 writeFileSync(script,`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(payload)}],{detached:true,stdio:'inherit',windowsHide:true});c.unref();process.exit(0);`);
 let pid:number|undefined;
 try{const result=await runVerifier(script,[],folder,500,new AbortController().signal);assert(existsSync(marker));pid=Number(readFileSync(marker,'utf8'));assert.equal(result.interrupted,true);assert.equal(result.settled,false);assert(workerAlive(pid));}
 finally{if(!pid&&existsSync(marker))pid=Number(readFileSync(marker,'utf8'));if(pid){killOwnedProcessTree(pid);for(let i=0;i<100&&workerAlive(pid);i++)await sleep(10);assert.equal(workerAlive(pid),false);}}
});
