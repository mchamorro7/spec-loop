import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveState,
  estimateRunWallS,
  computeContractHash,
  projectCheckboxes,
  formatReport,
  computeExitCode,
  unverifiedTaskIds,
} from "../bin/spec-loop.mjs";

test("estimateRunWallS: the span between the earliest and latest timestamp, in seconds", () => {
  const events = [
    { ts: "2026-08-21T10:00:00.000Z" },
    { ts: "2026-08-21T10:02:30.000Z" },
    { ts: "2026-08-21T10:01:00.000Z" },
  ];
  assert.equal(estimateRunWallS(events), 150);
});

test("estimateRunWallS: an empty log is zero, not NaN or a crash", () => {
  assert.equal(estimateRunWallS([]), 0);
});

test("deriveState: an empty log derives an empty, zero-cost state", () => {
  const state = deriveState([]);
  assert.deepEqual(state.tasks, {});
  assert.equal(state.totalCostUsd, 0);
  assert.deepEqual(state.proposedRules, []);
  assert.equal(state.lastRunStart, null);
});

test("deriveState: a task's status comes from its one closed event", () => {
  const state = deriveState([
    { event: "attempt_start", task: "1.1", attempt: 1 },
    { event: "verify", task: "1.1", attempt: 1, exit: 0 },
    { event: "closed", task: "1.1", status: "verified", attempts: 1, cost_usd: 0.4, wall_s: 60 },
  ]);
  assert.equal(state.tasks["1.1"].status, "verified");
  assert.equal(state.tasks["1.1"].attempts, 1);
  assert.equal(state.tasks["1.1"].costUsd, 0.4);
});

test("deriveState: totalCostUsd sums closed events and checker_spend, never double-counted", () => {
  const state = deriveState([
    { event: "closed", task: "1.1", status: "verified", cost_usd: 0.4 },
    { event: "closed", task: "1.2", status: "verified", cost_usd: 0.3 },
    { event: "checker_spend", cost_usd: 0.05 },
  ]);
  assert.equal(state.totalCostUsd, 0.75);
});

test("deriveState: checker_verdict events with a rule feed proposedRules", () => {
  const state = deriveState([
    { event: "checker_verdict", id: "1.1", refuted: false, rule: { ruleSource: "no-x", rationale: "y" } },
    { event: "checker_verdict", id: "1.2", refuted: false }, // no rule -- not proposed
  ]);
  assert.equal(state.proposedRules.length, 1);
  assert.equal(state.proposedRules[0].taskId, "1.1");
});

test("deriveState: the latest run_start is exposed for the retry-delta check", () => {
  const state = deriveState([
    { event: "run_start", contract_hash: "aaa", base_sha: "sha1" },
    { event: "closed", task: "1.1", status: "blocked" },
    { event: "run_start", contract_hash: "bbb", base_sha: "sha2" },
  ]);
  assert.deepEqual(state.lastRunStart, { contractHash: "bbb", baseSha: "sha2" });
});

test("deriveState: change_started exposes the change's original base (D16)", () => {
  const state = deriveState([{ event: "change_started", base_sha: "sha-original" }]);
  assert.equal(state.changeOriginalBase, "sha-original");
});

test("deriveState: without a change_started event, changeOriginalBase is null, not a crash", () => {
  assert.equal(deriveState([]).changeOriginalBase, null);
});

test("deriveState: change_review findings accumulate across multiple events", () => {
  const state = deriveState([
    { event: "change_review", findings: [{ description: "a", evidence: "e1" }] },
    { event: "change_review", findings: [{ description: "b", evidence: "e2" }] },
  ]);
  assert.equal(state.changeReviewFindings.length, 2);
});

function task(overrides = {}) {
  return {
    id: "1.1",
    proves: "FR1",
    files: ["a.ts"],
    verify: "pnpm run gate",
    needs: [],
    redCheck: { mode: "auto" },
    prose: "",
    checked: false,
    line: 1,
    ...overrides,
  };
}

test("computeContractHash: deterministic for the same contract", () => {
  const a = computeContractHash([task()]);
  const b = computeContractHash([task()]);
  assert.equal(a, b);
});

test("computeContractHash: ignores checked and line -- only the contract matters", () => {
  const a = computeContractHash([task({ checked: false, line: 3 })]);
  const b = computeContractHash([task({ checked: true, line: 99 })]);
  assert.equal(a, b, "marking a checkbox must never look like a plan change");
});

test("computeContractHash: changes when verify changes", () => {
  const a = computeContractHash([task({ verify: "pnpm run gate && pnpm test -- a.test.ts" })]);
  const b = computeContractHash([task({ verify: "pnpm run gate && pnpm test -- b.test.ts" })]);
  assert.notEqual(a, b);
});

test("computeContractHash: independent of task array order", () => {
  const a = computeContractHash([task({ id: "1.1" }), task({ id: "1.2" })]);
  const b = computeContractHash([task({ id: "1.2" }), task({ id: "1.1" })]);
  assert.equal(a, b);
});

const TASKS_MD = `## 1. Grupo

- [ ] 1.1 Primera

\`\`\`yaml
proves: "FR1"
files: ["a.ts"]
verify: "pnpm run gate"
\`\`\`

- [ ] 1.2 Segunda

\`\`\`yaml
proves: "FR2"
files: ["b.ts"]
verify: "pnpm run gate"
\`\`\`
`;

test("projectCheckboxes: marks only the ids given, leaves everything else untouched", () => {
  const out = projectCheckboxes(TASKS_MD, ["1.1"]);
  assert.match(out, /- \[x\] 1\.1 Primera/);
  assert.match(out, /- \[ \] 1\.2 Segunda/);
});

test("projectCheckboxes: the yaml block and prose are byte-for-byte unchanged", () => {
  const out = projectCheckboxes(TASKS_MD, ["1.1", "1.2"]);
  for (const line of ['proves: "FR1"', 'files: ["a.ts"]', 'proves: "FR2"']) {
    assert.ok(out.includes(line), `expected "${line}" to survive unchanged`);
  }
});

test("projectCheckboxes: an id not in the list stays unmarked", () => {
  const out = projectCheckboxes(TASKS_MD, []);
  assert.equal(out, TASKS_MD);
});

test("projectCheckboxes: marking an already-marked task is a no-op, not an error", () => {
  const already = TASKS_MD.replace("- [ ] 1.1", "- [x] 1.1");
  const out = projectCheckboxes(already, ["1.1"]);
  assert.match(out, /- \[x\] 1\.1 Primera/);
});

function stateWith(tasksMap, overrides = {}) {
  return { tasks: tasksMap, totalCostUsd: 0, proposedRules: [], lastRunStart: null, ...overrides };
}

test("formatReport: opens with red, not with green", () => {
  const state = stateWith({
    "1.1": { status: "blocked", attempts: 3, costUsd: 0.3, wallS: 90, reason: null },
    "1.2": { status: "verified", attempts: 1, costUsd: 0.1, wallS: 30, reason: null },
  });
  const out = formatReport("add-x", [task({ id: "1.1" }), task({ id: "1.2" })], state, { maxAttempts: 3 }, 60);
  const redIdx = out.indexOf("## Rojo");
  const greenIdx = out.indexOf("## Verde");
  assert.ok(redIdx >= 0 && greenIdx >= 0 && redIdx < greenIdx);
  assert.match(out, /1\.1\s+blocked/);
  assert.match(out, /destraba:/);
});

test("formatReport: a red-check: skip task appears in residual risk with its reason", () => {
  const state = stateWith({});
  const tasks = [task({ id: "1.1", redCheck: { mode: "skip", reason: "refactor puro" } })];
  const out = formatReport("add-x", tasks, state, { maxAttempts: 3 }, 10);
  assert.match(out, /1\.1\s+red-check: skip — refactor puro/);
});

test("formatReport: a proposed lint rule appears in residual risk", () => {
  const state = stateWith({}, {
    proposedRules: [{ taskId: "2.1", rule: { ruleSource: "no-restricted-imports", rationale: "UI no debe importar db" } }],
  });
  const out = formatReport("add-x", [], state, { maxAttempts: 3 }, 10);
  assert.match(out, /no-restricted-imports/);
  assert.match(out, /UI no debe importar db/);
});

test("formatReport: change-reviewer findings appear in residual risk, with their evidence", () => {
  const state = stateWith({}, {
    changeReviewFindings: [
      { description: "wave 1 and wave 3 both define a Session type", evidence: "src/a.ts:3, src/b.ts:9", rule: null },
    ],
  });
  const out = formatReport("add-x", [], state, { maxAttempts: 3 }, 10);
  const riskIdx = out.indexOf("## Riesgo residual");
  const nextSection = out.indexOf("## Advertencias");
  const block = out.slice(riskIdx, nextSection);
  assert.match(block, /wave 1 and wave 3 both define a Session type/);
  assert.match(block, /src\/a\.ts:3, src\/b\.ts:9/);
});

test("formatReport: a change-reviewer finding never appears in Rojo or changes the totals", () => {
  const state = stateWith(
    { "1.1": { status: "verified", attempts: 1, costUsd: 0.1, wallS: 30, reason: null } },
    { changeReviewFindings: [{ description: "x", evidence: "y", rule: null }], totalCostUsd: 0.1 },
  );
  const out = formatReport("add-x", [task({ id: "1.1" })], state, { maxAttempts: 3 }, 30);
  const redIdx = out.indexOf("## Rojo");
  const riskIdx = out.indexOf("## Riesgo residual");
  assert.doesNotMatch(out.slice(redIdx, riskIdx), /description|evidence/);
  assert.match(out, /costo: \$0\.10/);
});

test("formatReport: a task that closed on the last attempt is a warning", () => {
  const state = stateWith({ "1.1": { status: "verified", attempts: 3, costUsd: 0.2, wallS: 60, reason: null } });
  const out = formatReport("add-x", [task({ id: "1.1" })], state, { maxAttempts: 3 }, 60);
  const warnIdx = out.indexOf("## Advertencias");
  const nextSection = out.indexOf("## Verde");
  const warnBlock = out.slice(warnIdx, nextSection);
  assert.match(warnBlock, /1\.1/);
});

test("formatReport: a task accepted after a refutation is a warning", () => {
  const state = stateWith({
    "1.1": { status: "verified", attempts: 1, costUsd: 0.2, wallS: 60, reason: "refutado y aceptado tras reintento" },
  });
  const out = formatReport("add-x", [task({ id: "1.1" })], state, { maxAttempts: 5 }, 60);
  const warnIdx = out.indexOf("## Advertencias");
  const nextSection = out.indexOf("## Verde");
  assert.match(out.slice(warnIdx, nextSection), /1\.1/);
});

test("formatReport: a clean first-attempt task is not a warning", () => {
  const state = stateWith({ "1.1": { status: "verified", attempts: 1, costUsd: 0.2, wallS: 60, reason: null } });
  const out = formatReport("add-x", [task({ id: "1.1" })], state, { maxAttempts: 3 }, 60);
  const warnIdx = out.indexOf("## Advertencias");
  const nextSection = out.indexOf("## Verde");
  assert.doesNotMatch(out.slice(warnIdx, nextSection), /1\.1/);
});

test("formatReport: totals include cost, an estimated speedup, and first-attempt pass rate", () => {
  const state = stateWith({
    "1.1": { status: "verified", attempts: 1, costUsd: 0.2, wallS: 60, reason: null },
    "1.2": { status: "verified", attempts: 2, costUsd: 0.3, wallS: 90, reason: null },
  }, { totalCostUsd: 0.5 });
  const out = formatReport("add-x", [task({ id: "1.1" }), task({ id: "1.2" })], state, { maxAttempts: 3 }, 100);
  assert.match(out, /costo: \$0\.50/);
  assert.match(out, /aceleración.*1\.5x/); // (60+90)/100
  assert.match(out, /primer intento: 50%/); // 1 of 2 verified tasks had attempts===1
});

test("formatReport: a task the change never got to (stopped early) is red as 'no llegó a correr'", () => {
  const state = stateWith({ "1.1": { status: "verified", attempts: 1, costUsd: 0.1, wallS: 30, reason: null } });
  const tasks = [task({ id: "1.1" }), task({ id: "2.1" })]; // 2.1 has no entry in state.tasks at all
  const out = formatReport("add-x", tasks, state, { maxAttempts: 3 }, 30);
  const redIdx = out.indexOf("## Rojo");
  const nextSection = out.indexOf("## Riesgo residual");
  assert.match(out.slice(redIdx, nextSection), /2\.1\s+no lleg[oó] a correr/);
});

test("unverifiedTaskIds: excludes verified, includes red and never-started", () => {
  const state = stateWith({
    "1.1": { status: "verified", attempts: 1, costUsd: 0, wallS: 0, reason: null },
    "1.2": { status: "blocked", attempts: 3, costUsd: 0, wallS: 0, reason: null },
  });
  const tasks = [task({ id: "1.1" }), task({ id: "1.2" }), task({ id: "1.3" })];
  assert.deepEqual(unverifiedTaskIds(tasks, state).sort(), ["1.2", "1.3"]);
});

test("computeExitCode: everything verified is 0", () => {
  assert.equal(computeExitCode({}), 0);
});

test("computeExitCode: preflight failure is 2, checked before anything else", () => {
  assert.equal(computeExitCode({ preflightFailed: true, hasRedTasks: true, spendExceeded: true }), 2);
});

test("computeExitCode: spend exceeded is 4", () => {
  assert.equal(computeExitCode({ spendExceeded: true, hasRedTasks: true }), 4);
});

test("computeExitCode: a stopped change (merge conflict / red suite) is 3", () => {
  assert.equal(computeExitCode({ changeStopped: true, hasRedTasks: true }), 3);
});

test("computeExitCode: red tasks with nothing else wrong is 1", () => {
  assert.equal(computeExitCode({ hasRedTasks: true }), 1);
});
