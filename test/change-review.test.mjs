import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runMechanicalChecks,
  ensureChangeWorktree,
  runWaveBarrier,
  currentWaveBase,
  runChangeReview,
} from "../bin/spec-loop.mjs";

function git(args, cwd) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

function writeFile(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "spec-loop-review-"));
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "spec-loop tests"], root);
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(["add", "README.md"], root);
  git(["commit", "-q", "-m", "initial"], root);
  return root;
}

function makeCandidate(root, changeName, baseRef, taskId) {
  const wtDir = join(root, "wt-" + taskId);
  git(["worktree", "add", "-b", `spec-loop/${changeName}/${taskId}`, wtDir, baseRef], root);
  const implPath = `src/${taskId}.mjs`;
  const testPath = `src/${taskId}.test.mjs`;
  writeFile(wtDir, implPath, `export const value = "${taskId}";\n`);
  writeFile(
    wtDir,
    testPath,
    `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { value } from "./${taskId}.mjs";\ntest("x", () => { assert.equal(value, "${taskId}"); });\n`,
  );
  const task = {
    id: taskId,
    proves: "FR1",
    files: [implPath, testPath],
    verify: `node --test src/${taskId}.test.mjs`,
    needs: [],
    redCheck: { mode: "auto" },
    prose: "",
  };
  const result = runMechanicalChecks(task, {
    worktree: { dir: wtDir, branch: `spec-loop/${changeName}/${taskId}` },
    baseRef,
    eventsPath: join(root, "events.jsonl"),
    emit: () => {},
  });
  assert.equal(result.status, "checks-passed");
  return {
    task,
    worktree: { dir: wtDir, branch: `spec-loop/${changeName}/${taskId}` },
    attemptsUsed: 1,
    testFingerprint: result.testFingerprint,
    costUsd: 0.01,
    wallS: 5,
  };
}

function okChecker() {
  return (_prompt, diffText) => ({
    verdicts: [...diffText.matchAll(/=== (\S+) ===/g)].map((m) => ({
      id: m[1],
      refuted: false,
      reason: "ok",
      evidence: "reviewed",
    })),
    costUsd: 0.01,
  });
}

function mergeWave(root, changeName, changeWorktree, taskId, eventsPath) {
  const baseRef = currentWaveBase(changeWorktree);
  const candidate = makeCandidate(root, changeName, baseRef, taskId);
  const result = runWaveBarrier([candidate], {
    changeWorktree,
    baseRef,
    config: { test: "true", checkerModel: "sonnet", barrier: null, maxAttempts: 3 },
    eventsPath,
    specDeltaText: "FR1",
    architectureText: "",
    spawnChecker: okChecker(),
    emit: () => {},
  });
  assert.equal(result.barrierStatus, "ok");
}

test("runChangeReview: sees the FULL accumulated diff across two waves the wave checker never saw together", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const changeOriginalBase = currentWaveBase(changeWorktree);
    const eventsPath = join(root, "events.jsonl");

    mergeWave(root, changeName, changeWorktree, "1.1", eventsPath);
    mergeWave(root, changeName, changeWorktree, "1.2", eventsPath);

    let seenDiff = null;
    const result = runChangeReview({
      changeWorktree,
      changeOriginalBase,
      config: { checkerModel: "sonnet" },
      eventsPath,
      proposalText: "Add x and y",
      spawnChangeReviewer: (_prompt, diffText) => {
        seenDiff = diffText;
        return {
          findings: [{ description: "1.1 and 1.2 both export a bare value", evidence: "src/1.1.mjs:1, src/1.2.mjs:1" }],
          costUsd: 0.02,
        };
      },
      emit: () => {},
    });

    assert.match(seenDiff, /1\.1\.mjs/);
    assert.match(seenDiff, /1\.2\.mjs/, "the reviewer must see BOTH waves' diffs together, not just the latest");
    assert.equal(result.findings.length, 1);

    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const reviewEvent = events.find((e) => e.event === "change_review");
    assert.ok(reviewEvent);
    assert.equal(reviewEvent.findings.length, 1);
    const spendEvents = events.filter((e) => e.event === "checker_spend");
    assert.ok(spendEvents.some((e) => e.cost_usd === 0.02));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChangeReview: never touches any task's status -- it has no way to", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const changeOriginalBase = currentWaveBase(changeWorktree);
    const eventsPath = join(root, "events.jsonl");
    mergeWave(root, changeName, changeWorktree, "1.1", eventsPath);

    const beforeEvents = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const closedBefore = beforeEvents.filter((e) => e.event === "closed");

    runChangeReview({
      changeWorktree,
      changeOriginalBase,
      config: { checkerModel: "sonnet" },
      eventsPath,
      proposalText: "x",
      spawnChangeReviewer: () => ({ findings: [{ description: "bad code", evidence: "src/1.1.mjs:1" }], costUsd: 0 }),
      emit: () => {},
    });

    const afterEvents = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const closedAfter = afterEvents.filter((e) => e.event === "closed");
    assert.deepEqual(closedBefore, closedAfter, "no new closed event, no change to any existing one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChangeReview: an empty diff (nothing merged since the original base) is a no-op, no spawn", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const changeOriginalBase = currentWaveBase(changeWorktree);
    const eventsPath = join(root, "events.jsonl");

    let called = false;
    const result = runChangeReview({
      changeWorktree,
      changeOriginalBase,
      config: { checkerModel: "sonnet" },
      eventsPath,
      proposalText: "x",
      spawnChangeReviewer: () => {
        called = true;
        return { findings: [], costUsd: 0 };
      },
      emit: () => {},
    });

    assert.equal(called, false);
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChangeReview: a missing changeOriginalBase (older change, pre-D16) is a graceful no-op", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const eventsPath = join(root, "events.jsonl");

    let called = false;
    const result = runChangeReview({
      changeWorktree,
      changeOriginalBase: null,
      config: { checkerModel: "sonnet" },
      eventsPath,
      proposalText: "x",
      spawnChangeReviewer: () => {
        called = true;
        return { findings: [], costUsd: 0 };
      },
      emit: () => {},
    });

    assert.equal(called, false);
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
