import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ensureChangeWorktree,
  currentWaveBase,
  runMechanicalChecks,
  runWaveBarrier,
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
  const root = mkdtempSync(join(tmpdir(), "spec-loop-barrier-"));
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "spec-loop tests"], root);
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(["add", "README.md"], root);
  git(["commit", "-q", "-m", "initial"], root);
  return root;
}

/** Drive a task all the way through group 4/5 (fake implementer, real git) to a checks-passed candidate. */
function makeAcceptedCandidate(root, changeName, baseRef, taskId, { fileBody, testBody } = {}) {
  const wtDir = join(root, "wt-" + taskId);
  git(["worktree", "add", "-b", `spec-loop/${changeName}/${taskId}`, wtDir, baseRef], root);

  const implPath = `src/${taskId}.mjs`;
  const testPath = `src/${taskId}.test.mjs`;
  writeFile(wtDir, implPath, fileBody ?? `export const value = "${taskId}";\n`);
  writeFile(
    wtDir,
    testPath,
    testBody ??
      `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { value } from "./${taskId}.mjs";\ntest("x", () => {\n  assert.equal(value, "${taskId}");\n});\n`,
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

  const eventsPath = join(root, "events.jsonl");
  const result = runMechanicalChecks(task, {
    worktree: { dir: wtDir, branch: `spec-loop/${changeName}/${taskId}` },
    baseRef,
    eventsPath,
    emit: () => {},
  });
  assert.equal(result.status, "checks-passed", `fixture setup for ${taskId} must reach checks-passed`);

  return {
    task,
    worktree: { dir: wtDir, branch: `spec-loop/${changeName}/${taskId}` },
    attemptsUsed: 1,
    testFingerprint: result.testFingerprint,
    costUsd: 0.05,
    wallS: 12,
  };
}

function okChecker() {
  return (_prompt, diffText) => ({
    verdicts: [...diffText.matchAll(/=== (\S+) ===/g)].map((m) => ({
      id: m[1],
      refuted: false,
      reason: "ok",
      evidence: "diff reviewed",
    })),
    costUsd: 0.01,
  });
}

test("runWaveBarrier: all candidates accepted merge cleanly and the suite passes", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const baseRef = currentWaveBase(changeWorktree);

    const c1 = makeAcceptedCandidate(root, changeName, baseRef, "1.1");
    const c2 = makeAcceptedCandidate(root, changeName, baseRef, "1.2");

    const result = runWaveBarrier([c1, c2], {
      changeWorktree,
      baseRef,
      config: { test: "true", checkerModel: "sonnet", barrier: null, maxAttempts: 3 },
      eventsPath: join(root, "events.jsonl"),
      specDeltaText: "FR1",
      architectureText: "",
      spawnChecker: okChecker(),
      emit: () => {},
    });

    assert.equal(result.barrierStatus, "ok");
    assert.deepEqual(result.accepted.map((c) => c.task.id).sort(), ["1.1", "1.2"]);
    assert.deepEqual(result.closed, []);

    // Both files must exist on the change branch now.
    assert.ok(readFileSync(join(changeWorktree.dir, "src/1.1.mjs"), "utf8").includes("1.1"));
    assert.ok(readFileSync(join(changeWorktree.dir, "src/1.2.mjs"), "utf8").includes("1.2"));

    // "closed: verified" fires here -- at merge time -- not earlier in the
    // pipeline, and it carries the accumulated cost/attempts for deriveState.
    const events = readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const verifiedClosed = events.filter((e) => e.event === "closed" && e.status === "verified");
    assert.deepEqual(verifiedClosed.map((e) => e.task).sort(), ["1.1", "1.2"]);
    assert.ok(verifiedClosed.every((e) => e.cost_usd === 0.05));

    // The checker's own cost is a separate, wave-level event -- never
    // duplicated onto either task's closed event.
    assert.ok(events.some((e) => e.event === "checker_spend"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWaveBarrier: a refutation with a fixable cause is accepted on the retry (second checker pass)", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const baseRef = currentWaveBase(changeWorktree);

    const c1 = makeAcceptedCandidate(root, changeName, baseRef, "1.1");

    let checkerCalls = 0;
    const spawnChecker = (_prompt, diffText) => {
      checkerCalls++;
      const id = diffText.match(/=== (\S+) ===/)[1];
      // Refute the first time, accept the second (post-retry) time.
      const refuted = checkerCalls === 1;
      return { verdicts: [{ id, refuted, reason: refuted ? "revisá el limite" : "ok ahora", evidence: "src/x:1" }], costUsd: 0 };
    };

    const spawnImplementer = (_prompt, ctx) => {
      // A genuinely different write -- an unchanged file leaves the worktree
      // clean, which is its own (correct) red-check-failed path, not what
      // this test is exercising.
      writeFile(ctx.worktreeDir, "src/1.1.mjs", `export const value = "1.1"; // fixed\n`);
      return { resultText: "fixed", costUsd: 0.02 };
    };

    const result = runWaveBarrier([c1], {
      changeWorktree,
      baseRef,
      config: { test: "true", checkerModel: "sonnet", barrier: null, maxAttempts: 3 },
      eventsPath: join(root, "events.jsonl"),
      specDeltaText: "FR1",
      architectureText: "",
      spawnChecker,
      spawnImplementer,
      emit: () => {},
    });

    assert.equal(checkerCalls, 2, "refutation must trigger exactly a second checker pass, not more");
    assert.equal(result.barrierStatus, "ok");
    assert.deepEqual(result.accepted.map((c) => c.task.id), ["1.1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWaveBarrier: refuted twice closes blocked and never merges", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const baseRef = currentWaveBase(changeWorktree);

    const c1 = makeAcceptedCandidate(root, changeName, baseRef, "1.1");

    const spawnChecker = (_prompt, diffText) => {
      const id = diffText.match(/=== (\S+) ===/)[1];
      return { verdicts: [{ id, refuted: true, reason: "sigue mal", evidence: "src/x:1" }], costUsd: 0 };
    };
    const spawnImplementer = (_prompt, ctx) => {
      writeFile(ctx.worktreeDir, "src/1.1.mjs", `export const value = "1.1"; // retry\n`);
      return { resultText: "tried again", costUsd: 0.02 };
    };

    const result = runWaveBarrier([c1], {
      changeWorktree,
      baseRef,
      config: { test: "true", checkerModel: "sonnet", barrier: null, maxAttempts: 3 },
      eventsPath: join(root, "events.jsonl"),
      specDeltaText: "FR1",
      architectureText: "",
      spawnChecker,
      spawnImplementer,
      emit: () => {},
    });

    assert.equal(result.barrierStatus, "nothing-to-merge");
    assert.deepEqual(result.accepted, []);
    assert.equal(result.closed.length, 1);
    assert.equal(result.closed[0].status, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWaveBarrier: a genuine merge conflict stops the change and is reported, not silently resolved", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const baseRef = currentWaveBase(changeWorktree);

    // Both candidates touch the SAME file with divergent content -- the
    // scenario the spec calls "a bug in the harness", since disjoint files:
    // plus a clean scope check should make this impossible in real operation.
    // Forcing it here tests that the mechanism reports it instead of
    // corrupting the tree.
    const c1 = makeAcceptedCandidate(root, changeName, baseRef, "1.1", {
      fileBody: `export const shared = "from-1.1";\n`,
      testBody: `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { shared } from "./1.1.mjs";\ntest("x", () => { assert.equal(shared, "from-1.1"); });\n`,
    });
    // Manually make c2 touch c1's own file to force a real conflict.
    const c2 = makeAcceptedCandidate(root, changeName, baseRef, "1.2");
    execFileSync("git", ["checkout", c2.worktree.branch], { cwd: c2.worktree.dir });
    writeFile(c2.worktree.dir, "src/1.1.mjs", `export const shared = "from-1.2";\n`);
    git(["add", "-A"], c2.worktree.dir);
    git(["commit", "-q", "-m", "conflict"], c2.worktree.dir);

    const result = runWaveBarrier([c1, c2], {
      changeWorktree,
      baseRef,
      config: { test: "true", checkerModel: "sonnet", barrier: null, maxAttempts: 3 },
      eventsPath: join(root, "events.jsonl"),
      specDeltaText: "FR1",
      architectureText: "",
      spawnChecker: okChecker(),
      emit: () => {},
    });

    assert.equal(result.barrierStatus, "merge-conflict");
    // The change worktree must be left clean (merge --abort), not mid-conflict.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: changeWorktree.dir, encoding: "utf8" });
    assert.equal(status.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWaveBarrier: a red suite after a clean merge stops the change without reverting anything", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const baseRef = currentWaveBase(changeWorktree);
    const c1 = makeAcceptedCandidate(root, changeName, baseRef, "1.1");

    const result = runWaveBarrier([c1], {
      changeWorktree,
      baseRef,
      config: { test: "false", checkerModel: "sonnet", barrier: null, maxAttempts: 3 },
      eventsPath: join(root, "events.jsonl"),
      specDeltaText: "FR1",
      architectureText: "",
      spawnChecker: okChecker(),
      emit: () => {},
    });

    assert.equal(result.barrierStatus, "integration-failed");
    // Merged content stays -- nothing auto-reverts.
    assert.ok(readFileSync(join(changeWorktree.dir, "src/1.1.mjs"), "utf8").includes("1.1"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWaveBarrier: an expensive barrier check runs after the suite and its failure also stops the change", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const baseRef = currentWaveBase(changeWorktree);
    const c1 = makeAcceptedCandidate(root, changeName, baseRef, "1.1");

    const result = runWaveBarrier([c1], {
      changeWorktree,
      baseRef,
      config: { test: "true", checkerModel: "sonnet", barrier: "false", maxAttempts: 3 },
      eventsPath: join(root, "events.jsonl"),
      specDeltaText: "FR1",
      architectureText: "",
      spawnChecker: okChecker(),
      emit: () => {},
    });

    assert.equal(result.barrierStatus, "integration-failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWaveBarrier: no expensive check declared costs nothing and does not run", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const baseRef = currentWaveBase(changeWorktree);
    const c1 = makeAcceptedCandidate(root, changeName, baseRef, "1.1");

    const result = runWaveBarrier([c1], {
      changeWorktree,
      baseRef,
      config: { test: "true", checkerModel: "sonnet", barrier: null, maxAttempts: 3 },
      eventsPath: join(root, "events.jsonl"),
      specDeltaText: "FR1",
      architectureText: "",
      spawnChecker: okChecker(),
      emit: () => {},
    });

    assert.equal(result.barrierStatus, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWaveBarrier: no candidates does nothing and spawns no checker", () => {
  const root = makeRepo();
  try {
    const changeName = "add-x";
    const changeWorktree = ensureChangeWorktree(changeName, root);
    const baseRef = currentWaveBase(changeWorktree);

    let called = false;
    const result = runWaveBarrier([], {
      changeWorktree,
      baseRef,
      config: { test: "true", checkerModel: "sonnet", barrier: null, maxAttempts: 3 },
      eventsPath: join(root, "events.jsonl"),
      specDeltaText: "",
      architectureText: "",
      spawnChecker: () => {
        called = true;
        return { verdicts: [], costUsd: 0 };
      },
      emit: () => {},
    });

    assert.equal(result.barrierStatus, "no-candidates");
    assert.equal(called, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureChangeWorktree: resuming an existing change reuses its worktree instead of recreating it", () => {
  const root = makeRepo();
  try {
    const first = ensureChangeWorktree("add-x", root);
    writeFile(first.dir, "marker.txt", "still here\n");
    execFileSync("git", ["add", "-A"], { cwd: first.dir });
    execFileSync("git", ["commit", "-q", "-m", "marker"], { cwd: first.dir });

    const second = ensureChangeWorktree("add-x", root);
    assert.equal(second.dir, first.dir);
    assert.ok(readFileSync(join(second.dir, "marker.txt"), "utf8").includes("still here"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("currentWaveBase: advances as the change worktree gains commits", () => {
  const root = makeRepo();
  try {
    const cw = ensureChangeWorktree("add-x", root);
    const before = currentWaveBase(cw);
    writeFile(cw.dir, "x.txt", "x\n");
    execFileSync("git", ["add", "-A"], { cwd: cw.dir });
    execFileSync("git", ["commit", "-q", "-m", "x"], { cwd: cw.dir });
    const after = currentWaveBase(cw);
    assert.notEqual(before, after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
