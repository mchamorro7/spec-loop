import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskPipeline } from "../bin/spec-loop.mjs";

function git(args, cwd) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A throwaway git repo with one commit, per task 5.7's own testing pattern applied to group 4. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "spec-loop-pipeline-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "spec-loop tests"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "initial"], dir);
  return dir;
}

function baseTask(overrides = {}) {
  return {
    id: "1.1",
    proves: "FR1",
    files: ["a.ts"],
    verify: "true",
    needs: [],
    redCheck: { mode: "auto" },
    prose: "",
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return { maxAttempts: 3, timeout: "20m", model: "sonnet", ...overrides };
}

test("runTaskPipeline: verifies on the first attempt when the implementer's work makes verify pass", () => {
  const repoRoot = makeRepo();
  try {
    const eventsPath = join(repoRoot, ".spec-loop", "add-x", "events.jsonl");
    const task = baseTask({ verify: "test -f ok.txt" });

    const spawnImplementer = (_prompt, ctx) => {
      writeFileSync(join(ctx.worktreeDir, "ok.txt"), "done\n");
      return { resultText: "done", costUsd: 0.05 };
    };

    const result = runTaskPipeline(task, {
      changeName: "add-x",
      baseRef: "HEAD",
      config: baseConfig(),
      eventsPath,
      repoRoot,
      spawnImplementer,
      emit: () => {},
    });

    assert.equal(result.status, "verified");
    assert.equal(result.attempts, 1);
    assert.ok(existsSync(result.worktree.dir), "the worktree must exist for later checks (group 5) to run in");

    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.event), ["attempt_start", "verify", "closed"]);
    assert.equal(events[1].exit, 0);
    assert.equal(events[2].status, "verified");
    assert.equal(events[2].cost_usd, 0.05);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runTaskPipeline: the same failure twice in a row cuts to stuck, not to blocked", () => {
  const repoRoot = makeRepo();
  try {
    const eventsPath = join(repoRoot, ".spec-loop", "add-x", "events.jsonl");
    const task = baseTask({ verify: "exit 1" }); // deterministic, identical (empty) output every time

    const result = runTaskPipeline(task, {
      changeName: "add-x",
      baseRef: "HEAD",
      config: baseConfig({ maxAttempts: 5 }),
      eventsPath,
      repoRoot,
      spawnImplementer: () => ({ resultText: "trying", costUsd: 0 }),
      emit: () => {},
    });

    assert.equal(result.status, "stuck");
    assert.equal(result.attempts, 2, "must cut on the second identical failure, not run all 5 attempts");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runTaskPipeline: exhausting distinct failures is blocked, not stuck", () => {
  const repoRoot = makeRepo();
  try {
    const eventsPath = join(repoRoot, ".spec-loop", "add-x", "events.jsonl");
    // Each run echoes an incrementing counter, so every attempt's signature differs.
    const task = baseTask({
      verify: "n=$(cat counter.txt 2>/dev/null || echo 0); n=$((n+1)); echo $n > counter.txt; echo \"error: fail $n\"; exit 1",
    });

    const result = runTaskPipeline(task, {
      changeName: "add-x",
      baseRef: "HEAD",
      config: baseConfig({ maxAttempts: 3 }),
      eventsPath,
      repoRoot,
      spawnImplementer: () => ({ resultText: "trying", costUsd: 0 }),
      emit: () => {},
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.attempts, 3);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runTaskPipeline: NEEDS-SCOPE short-circuits without ever running verify", () => {
  const repoRoot = makeRepo();
  try {
    const eventsPath = join(repoRoot, ".spec-loop", "add-x", "events.jsonl");
    const task = baseTask({ verify: "false" }); // would fail if it ever ran

    const result = runTaskPipeline(task, {
      changeName: "add-x",
      baseRef: "HEAD",
      config: baseConfig(),
      eventsPath,
      repoRoot,
      spawnImplementer: () => ({
        resultText: "NEEDS-SCOPE: hace falta tocar eslint.config.js",
        costUsd: 0.02,
      }),
      emit: () => {},
    });

    assert.equal(result.status, "needs-scope");
    assert.equal(result.note, "hace falta tocar eslint.config.js");
    assert.equal(result.attempts, 1);

    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.event), ["attempt_start", "needs_scope", "closed"]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runTaskPipeline: the full stderr survives in events.jsonl even though only 4KB gets reinjected", () => {
  const repoRoot = makeRepo();
  try {
    const eventsPath = join(repoRoot, ".spec-loop", "add-x", "events.jsonl");
    const bigLine = "x".repeat(6000);
    const task = baseTask({ verify: `echo "error: ${bigLine}" 1>&2; exit 1` });

    runTaskPipeline(task, {
      changeName: "add-x",
      baseRef: "HEAD",
      config: baseConfig({ maxAttempts: 1 }),
      eventsPath,
      repoRoot,
      spawnImplementer: () => ({ resultText: "trying", costUsd: 0 }),
      emit: () => {},
    });

    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const verifyEvent = events.find((e) => e.event === "verify");
    assert.ok(verifyEvent.stderr.length > 4096, "the persisted record keeps the full text, not the truncated one");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runTaskPipeline: a stray worktree/branch from an earlier interrupted run is cleaned before retrying", () => {
  const repoRoot = makeRepo();
  try {
    const eventsPath = join(repoRoot, ".spec-loop", "add-x", "events.jsonl");
    const task = baseTask({ verify: "test -f ok.txt" });

    const run = () =>
      runTaskPipeline(task, {
        changeName: "add-x",
        baseRef: "HEAD",
        config: baseConfig({ maxAttempts: 1 }),
        eventsPath,
        repoRoot,
        spawnImplementer: (_p, ctx) => {
          writeFileSync(join(ctx.worktreeDir, "ok.txt"), "done\n");
          return { resultText: "done", costUsd: 0 };
        },
        emit: () => {},
      });

    const first = run();
    assert.equal(first.status, "verified");
    // Running the same task again (as if the run had been interrupted and
    // retried) must not fail because the worktree/branch already exist.
    const second = run();
    assert.equal(second.status, "verified");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
