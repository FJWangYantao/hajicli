import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateTask, runProcess, summarize, verifyTask } from "../../../scripts/quality-run.mjs";
import { prepareTask, qualityTasks } from "../../../scripts/quality-tasks.mjs";

const solutions = [
  "exports.sum=(a,b)=>a+b;",
  "exports.clamp=(v,min,max)=>Math.max(min,Math.min(max,v));",
  "exports.median=a=>{if(!a.length)return null; const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2;};",
  "exports.unique=a=>[...new Set(a)];",
  "exports.chunk=(a,n)=>{if(!Number.isInteger(n)||n<=0)throw new RangeError();return Array.from({length:Math.ceil(a.length/n)},(_,i)=>a.slice(i*n,(i+1)*n));};",
  "exports.range=(s,e)=>Array.from({length:Math.max(0,e-s)},(_,i)=>s+i);",
  "exports.parsePort=s=>typeof s==='string'&&/^\\d+$/.test(s)&&+s>=1&&+s<=65535?+s:null;",
  "exports.sum=(a,b)=>a+b;",
];
function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-quality-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("八个任务独立验收：初始产物失败，正确实现通过", async (t) => {
  const dir = root(t);
  for (const [index, task] of qualityTasks.entries()) {
    const cwd = path.join(dir, task.id);
    prepareTask(task, cwd);
    assert.notEqual((await verifyTask(task, cwd)).code, 0, task.id);
    fs.writeFileSync(path.join(cwd, "math.cjs"), solutions[index]);
    if (task.extra)
      fs.writeFileSync(
        path.join(cwd, "consumer.cjs"),
        "const {sum}=require('./math.cjs'); exports.calculate=(a,b)=>sum(a,b);",
      );
    assert.equal((await verifyTask(task, cwd)).code, 0, task.id);
  }
});

test("ok true 与退出0不能替代验收，失败与超时不计成功", async (t) => {
  const dir = root(t);
  const fake = { code: 0, timedOut: false, output: '{"ok":true}', wallMs: 1 };
  const result = await evaluateTask(qualityTasks[0], { root: dir, runner: async () => fake });
  assert.equal(result.passed, false);
  assert.equal(result.validation, "failed");
  for (const execution of [
    { ...fake, code: 1 },
    { ...fake, timedOut: true },
  ]) {
    const r = await evaluateTask(qualityTasks[0], {
      root: dir,
      runner: async (_, cwd) => {
        fs.writeFileSync(path.join(cwd, "math.cjs"), solutions[0]);
        return execution;
      },
    });
    assert.equal(r.passed, false);
    assert.equal(r.validation, "not-run");
  }
  assert.equal(summarize([result]).completionRate, 0);
  assert.equal(summarize([result]).interventions, null);
  assert.equal(summarize([result]).costCny, null);
  const success = await evaluateTask(qualityTasks[0], {
    root: dir,
    interventions: 2,
    runner: async (_, cwd) => {
      fs.writeFileSync(path.join(cwd, "math.cjs"), solutions[0]);
      return {
        ...fake,
        output: JSON.stringify({
          ok: true,
          usage: { estimatedCostCny: 0.25, hasUnpricedModels: false },
        }),
      };
    },
  });
  assert.equal(success.passed, true);
  assert.deepEqual(summarize([success]), {
    total: 1,
    passed: 1,
    completionRate: 1,
    interventions: 2,
    wallMs: success.wallMs,
    costCny: 0.25,
  });
  const failed = await evaluateTask(qualityTasks[0], {
    root: dir,
    runner: async (_, cwd) => {
      fs.writeFileSync(path.join(cwd, "math.cjs"), solutions[0]);
      return { ...fake, output: '{"ok":false}' };
    },
  });
  assert.equal(failed.passed, false);
});

test("挂起进程超时结束，启动失败能返回", async () => {
  const result = await runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeoutMs: 100,
  });
  assert.equal(result.timedOut, true);
  const failure = await runProcess("haji-nonexistent-test-command", [], { timeoutMs: 100 });
  assert.ok(failure.error);
});
