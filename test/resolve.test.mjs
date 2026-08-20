import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChange } from "../bin/spec-loop.mjs";

test("resolveChange: with no active change with tasks.md, says nothing to run", () => {
  const { change, message, errors } = resolveChange(null, [
    { name: "add-billing", hasTasks: false, complete: false },
  ]);
  assert.equal(change, null);
  assert.deepEqual(errors, []);
  assert.match(message, /propose/);
});

test("resolveChange: a single eligible change is picked without a roadmap", () => {
  const { change, errors } = resolveChange(null, [
    { name: "add-billing", hasTasks: true, complete: false },
  ]);
  assert.equal(change, "add-billing");
  assert.deepEqual(errors, []);
});

test("resolveChange: completed changes are not eligible even if they appear first", () => {
  const { change } = resolveChange(null, [
    { name: "add-billing", hasTasks: true, complete: true },
    { name: "add-dashboard", hasTasks: true, complete: false },
  ]);
  assert.equal(change, "add-dashboard");
});

test("resolveChange: roadmap order picks the first eligible change it names", () => {
  const roadmap = "1. add-auth\n2. add-billing\n3. add-dashboard\n";
  const { change } = resolveChange(roadmap, [
    { name: "add-dashboard", hasTasks: true, complete: false },
    { name: "add-billing", hasTasks: true, complete: false },
  ]);
  assert.equal(change, "add-billing");
});

test("resolveChange: chains across runs as earlier changes complete", () => {
  const roadmap = "1. add-auth\n2. add-billing\n";
  const afterFirstRun = resolveChange(roadmap, [
    { name: "add-auth", hasTasks: true, complete: true },
    { name: "add-billing", hasTasks: true, complete: false },
  ]);
  assert.equal(afterFirstRun.change, "add-billing");
});

test("resolveChange: two active changes with no roadmap.md is an unresolved ambiguity", () => {
  const { change, errors } = resolveChange(null, [
    { name: "add-auth", hasTasks: true, complete: false },
    { name: "add-billing", hasTasks: true, complete: false },
  ]);
  assert.equal(change, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /add-auth/);
  assert.match(errors[0], /add-billing/);
});

test("resolveChange: two active changes where neither is named in roadmap.md is still ambiguous", () => {
  const roadmap = "1. add-dashboard\n";
  const { change, errors } = resolveChange(roadmap, [
    { name: "add-auth", hasTasks: true, complete: false },
    { name: "add-billing", hasTasks: true, complete: false },
  ]);
  assert.equal(change, null);
  assert.equal(errors.length, 1);
});
