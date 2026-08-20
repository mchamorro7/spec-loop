import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../bin/spec-loop.mjs";

const GATE = "pnpm run gate";
const SPEC_DELTA = `
### Requirement: La sesion se renueva sola
FR1 - un usuario recupera su sesion al reabrir la app.
FR2 - la sesion se renueva sola al reabrir.
`;

function task(overrides = {}) {
  return {
    id: "1.1",
    proves: "FR1",
    files: ["src/a.ts"],
    verify: "pnpm run gate && pnpm test -- src/a.test.ts",
    needs: [],
    redCheck: { mode: "auto" },
    ...overrides,
  };
}

function run(tasks) {
  return preflight(tasks, { gateCommand: GATE, specDeltaText: SPEC_DELTA });
}

test("preflight: a fully compliant task set has no errors", () => {
  const { errors } = run([
    task({ id: "1.1", proves: "FR1", files: ["src/a.ts", "src/a.test.ts"], verify: "pnpm run gate && pnpm test -- src/a.test.ts" }),
  ]);
  assert.deepEqual(errors, []);
});

test("rule 1: verify must start with the configured gate command", () => {
  const { errors } = run([task({ verify: "pnpm test -- src/x.test.ts" })]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /verify.*gate/);
});

test("rule 1: a command that merely starts with the gate string as a prefix of a longer word does not count", () => {
  const { errors } = run([task({ verify: "pnpm run gateway && pnpm test -- src/a.test.ts" })]);
  assert.equal(errors.length, 1);
});

test("rule 2: a declared test file must be named inside verify", () => {
  const { errors } = run([
    task({ files: ["src/a.ts", "src/a.test.ts"], verify: "pnpm run gate" }),
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /src\/a\.test\.ts/);
});

test("rule 3: red-check: skip without a reason is rejected", () => {
  const { errors } = run([task({ redCheck: { mode: "skip", reason: null } })]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /red-check/);
});

test("rule 3: red-check: skip with a reason passes", () => {
  const { errors } = run([task({ redCheck: { mode: "skip", reason: "refactor puro" } })]);
  assert.deepEqual(errors, []);
});

test("rule 4: more than fifteen tasks is rejected", () => {
  const tasks = Array.from({ length: 16 }, (_, i) => task({ id: `1.${i + 1}` }));
  const { errors } = run(tasks);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /15/);
});

test("rule 5: a duplicated id is rejected", () => {
  const { errors } = run([task({ id: "1.1" }), task({ id: "1.1" })]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicado/);
});

test("rule 6: needs referencing a nonexistent id is rejected", () => {
  const { errors } = run([task({ id: "1.1", needs: ["9.9"] })]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /9\.9/);
});

test("rule 6 (implicit cycle): a two-task cycle in needs is rejected", () => {
  const { errors } = run([
    task({ id: "1.1", needs: ["1.2"] }),
    task({ id: "1.2", needs: ["1.1"] }),
  ]);
  assert.equal(errors.filter((e) => e.includes("ciclo en needs")).length, 1);
});

test("rule 7: proves must reference an identifier present in the spec delta", () => {
  const { errors } = run([task({ proves: "FR7 - no existe" })]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /FR7/);
});

test("preflight returns every violation at once, not just the first", () => {
  const { errors } = run([
    task({ id: "1.1", verify: "pnpm test", proves: "FR9", redCheck: { mode: "skip", reason: null } }),
  ]);
  assert.ok(errors.length >= 3, `expected at least 3 errors, got ${errors.length}`);
});
