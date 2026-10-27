import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPERIMENT_NAMES,
  EXPERIMENTS,
  ExperimentRegistry,
  resolveMaxParallelTools,
} from "../dist/experiments.js";

test("defaults use the recommended arms without randomization", () => {
  const registry = new ExperimentRegistry("unit-a", { env: {} });
  assert.equal(registry.arm("parallel_prompt"), "batch");
  assert.equal(registry.arm("parallel_allowlist"), "dynamic");
  assert.equal(registry.arm("parallel_max"), "5");
  assert.equal(registry.arm("subagent_access"), "role");
  assert.equal(registry.arm("subagent_batch"), "batched");
  assert.equal(registry.arm("tool_batching"), "batch_first");
  assert.equal(registry.arm("scope_discipline"), "baseline");
  assert.equal(registry.arm("read_budget"), "batch_only");
  assert.equal(registry.arm("read_outline"), "outline");
  assert.equal(registry.arm("read_symbol"), "baseline");
  assert.equal(registry.arm("experience_recall"), "message");
  for (const assignment of registry.all()) assert.equal(assignment.source, "default");
});

test("HAJI_EXPERIMENTS overrides individual arms and all=control", () => {
  const individual = new ExperimentRegistry("unit-a", {
    env: { HAJI_EXPERIMENTS: "parallel_prompt=control,subagent_access=write" },
  });
  assert.equal(individual.arm("parallel_prompt"), "control");
  assert.equal(individual.arm("subagent_access"), "write");
  assert.equal(individual.arm("parallel_allowlist"), "dynamic");
  assert.equal(individual.assignment("parallel_prompt").source, "env");

  const allControl = new ExperimentRegistry("unit-a", {
    env: { HAJI_EXPERIMENTS: "all=control" },
  });
  for (const name of EXPERIMENT_NAMES) {
    assert.equal(allControl.arm(name), EXPERIMENTS[name].control, name);
  }
});

test("HAJI_AB assigns deterministically per unit and splits both arms", () => {
  const first = new ExperimentRegistry("unit-42", { env: { HAJI_AB: "1" } });
  const second = new ExperimentRegistry("unit-42", { env: { HAJI_AB: "1" } });
  assert.deepEqual(first.record(), second.record());
  assert.equal(first.assignment("parallel_prompt").source, "hash");

  const arms = new Set();
  for (let index = 0; index < 200; index += 1) {
    const registry = new ExperimentRegistry(`unit-${index}`, { env: { HAJI_AB: "1" } });
    arms.add(registry.arm("parallel_prompt"));
  }
  assert.deepEqual([...arms].sort(), ["batch", "control"]);
});

test("HAJI_MAX_PARALLEL_TOOLS wins over the experiment arm and is clamped", () => {
  const control = new ExperimentRegistry("unit-a", {
    env: { HAJI_EXPERIMENTS: "parallel_max=3" },
  });
  assert.equal(resolveMaxParallelTools(control, {}), 3);
  assert.equal(resolveMaxParallelTools(control, { HAJI_MAX_PARALLEL_TOOLS: "6" }), 6);
  assert.equal(resolveMaxParallelTools(control, { HAJI_MAX_PARALLEL_TOOLS: "99" }), 3);
  assert.equal(resolveMaxParallelTools(control, { HAJI_MAX_PARALLEL_TOOLS: "0" }), 3);
});
