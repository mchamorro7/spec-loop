import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCheckerPrompt, validateCheckerVerdicts, propagateBlockedByDep } from "../bin/spec-loop.mjs";

test("buildCheckerPrompt: includes the spec delta, architecture decisions, and each task's proves", () => {
  const prompt = buildCheckerPrompt(
    [{ id: "2.1", proves: "FR1" }, { id: "2.2", proves: "FR2" }],
    "FR1 - el usuario recupera su sesion",
    "## AD-001\ndecision: x",
  );
  assert.match(prompt, /FR1 - el usuario recupera su sesion/);
  assert.match(prompt, /AD-001/);
  assert.match(prompt, /2\.1: FR1/);
  assert.match(prompt, /2\.2: FR2/);
});

test("buildCheckerPrompt: an empty architecture registry says so explicitly, not silently blank", () => {
  const prompt = buildCheckerPrompt([{ id: "1.1", proves: "FR1" }], "delta", "");
  assert.match(prompt, /todavía no hay decisiones tomadas/);
});

test("validateCheckerVerdicts: a founded refutation (with evidence) passes through", () => {
  const [v] = validateCheckerVerdicts(
    [{ id: "1.1", refuted: true, reason: "no prueba nada", evidence: "src/x.test.ts:10" }],
    ["1.1"],
  );
  assert.equal(v.refuted, true);
  assert.equal(v.unfoundedRefutation, false);
});

test("validateCheckerVerdicts: refuted:true with no evidence is downgraded, not trusted", () => {
  const [v] = validateCheckerVerdicts(
    [{ id: "1.1", refuted: true, reason: "me parece raro", evidence: "" }],
    ["1.1"],
  );
  assert.equal(v.refuted, false);
  assert.equal(v.unfoundedRefutation, true);
  assert.equal(v.reason, "me parece raro"); // kept for the report even though it doesn't block
});

test("validateCheckerVerdicts: a task the checker said nothing about is not refuted, but flagged missing", () => {
  const [v] = validateCheckerVerdicts([], ["1.1"]);
  assert.equal(v.refuted, false);
  assert.equal(v.missing, true);
});

test("validateCheckerVerdicts: a verdict for an id outside the wave is ignored", () => {
  const verdicts = validateCheckerVerdicts(
    [{ id: "9.9", refuted: true, reason: "x", evidence: "y" }],
    ["1.1"],
  );
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].id, "1.1");
  assert.equal(verdicts[0].missing, true);
});

test("validateCheckerVerdicts: carries a proposed lint rule through when present", () => {
  const [v] = validateCheckerVerdicts(
    [{ id: "1.1", refuted: false, reason: "ok", evidence: "src/a.ts:1", rule: { file: "eslint.config.js", ruleSource: "no-restricted-imports", rationale: "x" } }],
    ["1.1"],
  );
  assert.equal(v.rule.ruleSource, "no-restricted-imports");
});

function task(id, files, needs = []) {
  return { id, files, needs };
}

test("propagateBlockedByDep: a task needing a red task becomes blocked-by-dep", () => {
  const { blockedByDep, waves } = propagateBlockedByDep(
    [task("2.1", ["a.ts"], ["1.1"])],
    ["1.1"],
  );
  assert.deepEqual(blockedByDep.map((t) => t.id), ["2.1"]);
  assert.deepEqual(waves, []);
});

test("propagateBlockedByDep: transitively blocks a task depending on an already-blocked one", () => {
  const { blockedByDep } = propagateBlockedByDep(
    [task("2.1", ["a.ts"], ["1.1"]), task("3.1", ["b.ts"], ["2.1"])],
    ["1.1"],
  );
  assert.deepEqual(blockedByDep.map((t) => t.id).sort(), ["2.1", "3.1"]);
});

test("propagateBlockedByDep: a task independent of the red id is not blocked and gets waved", () => {
  const { blockedByDep, waves, errors } = propagateBlockedByDep(
    [task("2.1", ["a.ts"], ["1.1"]), task("2.2", ["b.ts"])],
    ["1.1"],
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedByDep.map((t) => t.id), ["2.1"]);
  assert.deepEqual(waves.flat().map((t) => t.id), ["2.2"]);
});

test("propagateBlockedByDep: mergedIds lets a survivor depending on an earlier-wave task through", () => {
  const { blockedByDep, waves, errors } = propagateBlockedByDep(
    [task("3.1", ["c.ts"], ["1.1"])],
    ["2.1"], // 2.1 is red, unrelated to 3.1
    ["1.1"], // 1.1 already merged in an earlier wave
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedByDep, []);
  assert.deepEqual(waves.flat().map((t) => t.id), ["3.1"]);
});
