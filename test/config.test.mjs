import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../bin/spec-loop.mjs";

test("loadConfig: accepts the three required keys and fills defaults", () => {
  const { config, errors } = loadConfig(
    `gate: "pnpm run gate"\ntest: "pnpm test --"\nmax-spend: 15\n`,
    4,
  );
  assert.deepEqual(errors, []);
  assert.equal(config.gate, "pnpm run gate");
  assert.equal(config.test, "pnpm test --");
  assert.equal(config.maxSpend, 15);
  assert.equal(config.jobs, 3); // min(3, cpus-1) with cpus=4
  assert.equal(config.maxAttempts, 3);
  assert.equal(config.timeout, "20m");
  assert.equal(config.model, "sonnet");
  assert.equal(config.checkerModel, "sonnet"); // D15: defaults to `model`, unconfigured behaves as before
  assert.equal(config.barrier, null);
});

test("loadConfig: checker-model defaults to model, not to a hardcoded value", () => {
  const { config } = loadConfig(
    `gate: "g"\ntest: "t"\nmax-spend: 1\nmodel: "haiku"\n`,
    4,
  );
  assert.equal(config.checkerModel, "haiku");
});

test("loadConfig: checker-model can be set independently of model", () => {
  const { config } = loadConfig(
    `gate: "g"\ntest: "t"\nmax-spend: 1\nmodel: "sonnet"\nchecker-model: "opus"\n`,
    4,
  );
  assert.equal(config.model, "sonnet");
  assert.equal(config.checkerModel, "opus");
});

test("loadConfig: honors an explicit jobs override instead of the cpu default", () => {
  const { config } = loadConfig(
    `gate: "g"\ntest: "t"\nmax-spend: 1\njobs: 6\n`,
    4,
  );
  assert.equal(config.jobs, 6);
});

test("loadConfig: jobs default is min(3, cpus-1)", () => {
  const { config } = loadConfig(`gate: "g"\ntest: "t"\nmax-spend: 1\n`, 2);
  assert.equal(config.jobs, 1);
});

test("loadConfig: reports every missing required key, not just the first", () => {
  const { config, errors } = loadConfig(`gate: "g"\n`, 4);
  assert.equal(config, null);
  assert.equal(errors.length, 2);
  assert.match(errors.join("\n"), /"test"/);
  assert.match(errors.join("\n"), /"max-spend"/);
});

test("loadConfig: rejects a non-positive max-spend", () => {
  const { config, errors } = loadConfig(
    `gate: "g"\ntest: "t"\nmax-spend: 0\n`,
    4,
  );
  assert.equal(config, null);
  assert.match(errors.join("\n"), /max-spend/);
});

test("loadConfig: rejects malformed YAML", () => {
  const { config, errors } = loadConfig(`gate: [unclosed\n`, 4);
  assert.equal(config, null);
  assert.equal(errors.length, 1);
});

test("loadConfig: rejects a document that is not a map", () => {
  const { config, errors } = loadConfig(`- just\n- a list\n`, 4);
  assert.equal(config, null);
  assert.equal(errors.length, 1);
});

test("loadConfig: accepts an optional barrier command", () => {
  const { config, errors } = loadConfig(
    `gate: "g"\ntest: "t"\nmax-spend: 1\nbarrier: "npx jscpd src"\n`,
    4,
  );
  assert.deepEqual(errors, []);
  assert.equal(config.barrier, "npx jscpd src");
});
