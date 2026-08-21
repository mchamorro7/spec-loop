import { test } from "node:test";
import assert from "node:assert/strict";
import { planWaves } from "../bin/spec-loop.mjs";

function task(id, files, needs = []) {
  return { id, files, needs };
}

function ids(wave) {
  return wave.map((t) => t.id).sort();
}

test("waves: disjoint files with no needs land in a single wave", () => {
  const { waves, errors } = planWaves([
    task("1.1", ["a.ts"]),
    task("1.2", ["b.ts"]),
    task("1.3", ["c.ts"]),
  ]);
  assert.deepEqual(errors, []);
  assert.equal(waves.length, 1);
  assert.deepEqual(ids(waves[0]), ["1.1", "1.2", "1.3"]);
});

test("waves: two tasks sharing a file land in separate waves, lower id first", () => {
  const { waves, errors } = planWaves([
    task("1.2", ["shared.ts"]),
    task("1.1", ["shared.ts"]),
  ]);
  assert.deepEqual(errors, []);
  assert.equal(waves.length, 2);
  assert.deepEqual(ids(waves[0]), ["1.1"]);
  assert.deepEqual(ids(waves[1]), ["1.2"]);
});

test("waves: needs orders a task into a later wave than its dependency", () => {
  const { waves, errors } = planWaves([
    task("2.1", ["b.ts"], ["1.1"]),
    task("1.1", ["a.ts"]),
  ]);
  assert.deepEqual(errors, []);
  assert.equal(waves.length, 2);
  assert.deepEqual(ids(waves[0]), ["1.1"]);
  assert.deepEqual(ids(waves[1]), ["2.1"]);
});

test("waves: a /** glob owns every file under its prefix for intersection purposes", () => {
  const { waves, errors } = planWaves([
    task("1.1", ["src/auth/**"]),
    task("1.2", ["src/auth/session.ts"]),
  ]);
  assert.deepEqual(errors, []);
  assert.equal(waves.length, 2, "the glob owner and the file it owns must not share a wave");
});

test("waves: a genuine needs cycle is rejected and named", () => {
  const { waves, errors } = planWaves([
    task("1.1", ["a.ts"], ["1.2"]),
    task("1.2", ["b.ts"], ["1.1"]),
  ]);
  assert.equal(waves, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ciclo en needs/);
});

test("waves: needs pointing at a nonexistent id is reported as dangling, not a cycle", () => {
  const { waves, errors } = planWaves([task("1.1", ["a.ts"], ["9.9"])]);
  assert.equal(waves, null);
  assert.match(errors[0], /9\.9/);
  assert.doesNotMatch(errors[0], /ciclo/);
});

test("waves: a fully serialized chain (layer cut) produces one wave per task", () => {
  const { waves, errors } = planWaves([
    task("1.1", ["shared.ts"]),
    task("1.2", ["shared.ts"]),
    task("1.3", ["shared.ts"]),
  ]);
  assert.deepEqual(errors, []);
  assert.equal(waves.length, 3, "layer cuts are visible for free as one wave per task");
  waves.forEach((w) => assert.equal(w.length, 1));
});

test("waves: partitioning does not mutate its input", () => {
  const input = [task("1.2", ["b.ts"]), task("1.1", ["a.ts"])];
  const snapshot = JSON.parse(JSON.stringify(input));
  planWaves(input);
  assert.deepEqual(input, snapshot);
});

test("waves: dotted ids order numerically, not lexically (2.10 after 2.2)", () => {
  const { waves, errors } = planWaves([
    task("2.10", ["shared.ts"]),
    task("2.2", ["shared.ts"]),
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(ids(waves[0]), ["2.2"]);
  assert.deepEqual(ids(waves[1]), ["2.10"]);
});

test("waves: preSatisfiedIds unblocks a need pointing at an already-merged earlier task", () => {
  const { waves, errors } = planWaves([task("2.1", ["b.ts"], ["1.1"])], ["1.1"]);
  assert.deepEqual(errors, []);
  assert.equal(waves.length, 1);
  assert.deepEqual(ids(waves[0]), ["2.1"]);
});

test("waves: without preSatisfiedIds, the same task is a dangling reference, not a false cycle", () => {
  const { waves, errors } = planWaves([task("2.1", ["b.ts"], ["1.1"])]);
  assert.equal(waves, null);
  assert.match(errors[0], /1\.1/);
  assert.doesNotMatch(errors[0], /ciclo/);
});
