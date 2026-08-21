import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWaveTasksConcurrently } from "../bin/spec-loop.mjs";

function git(args, cwd) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "spec-loop-pool-"));
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "spec-loop tests"], root);
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(["add", "README.md"], root);
  git(["commit", "-q", "-m", "initial"], root);
  const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, baseRef };
}

// The worker dynamically imports this from disk (a function can't cross the
// worker boundary via postMessage) -- every task gets the same fixed
// filenames, which is fine since each task runs in its own worktree.
function writeFakeImplementerModule(dir) {
  const modPath = join(dir, "fake-implementer.mjs");
  const source = `
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export default function fakeImplementer(_prompt, ctx) {
  const implPath = join(ctx.worktreeDir, "src/impl.mjs");
  const testPath = join(ctx.worktreeDir, "src/impl.test.mjs");
  mkdirSync(dirname(implPath), { recursive: true });
  writeFileSync(implPath, "export const value = 42;\\n");
  writeFileSync(
    testPath,
    "import assert from 'node:assert/strict';\\nimport { test } from 'node:test';\\nimport { value } from './impl.mjs';\\ntest('x', () => { assert.equal(value, 42); });\\n",
  );
  return { resultText: "done", costUsd: 0.01 };
}
`;
  writeFileSync(modPath, source);
  return modPath;
}

function poolTask(id) {
  return {
    id,
    proves: "FR1",
    files: ["src/impl.mjs", "src/impl.test.mjs"],
    verify: "node --test src/impl.test.mjs",
    needs: [],
    redCheck: { mode: "auto" },
    prose: "",
  };
}

test("runWaveTasksConcurrently: runs every task and each reaches checks-passed", async () => {
  const { root, baseRef } = makeRepo();
  try {
    const modPath = writeFakeImplementerModule(root);
    const eventsPath = join(root, "events.jsonl");
    const tasks = [poolTask("1.1"), poolTask("1.2"), poolTask("1.3")];

    const results = await runWaveTasksConcurrently(tasks, {
      changeName: "add-x",
      baseRef,
      config: { maxAttempts: 2, timeout: "20m", model: "sonnet" },
      eventsPath,
      repoRoot: root,
      spawnImplementerModulePath: modPath,
    }, 2);

    assert.equal(results.length, 3);
    for (const t of tasks) {
      const r = results.find((x) => x.taskId === t.id);
      assert.ok(r, `expected a result for ${t.id}`);
      assert.ok(r.candidate, `expected ${t.id} to reach checks-passed, got ${JSON.stringify(r)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A fake implementer that logs [start, end] to a shared file, holding each
 * worker's OS thread busy for ~150ms in between -- long enough that if the
 * pool ever exceeded `jobs` concurrent workers, their intervals would
 * measurably overlap more than the cap allows.
 */
function writeTimingImplementerModule(dir, logPath) {
  const modPath = join(dir, "timing-implementer.mjs");
  const source = `
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export default function timingImplementer(_prompt, ctx) {
  const start = Date.now();
  const until = start + 150;
  while (Date.now() < until) { /* busy-wait: blocks only this worker's thread */ }
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ start, end: Date.now() }) + "\\n");

  const implPath = join(ctx.worktreeDir, "src/impl.mjs");
  const testPath = join(ctx.worktreeDir, "src/impl.test.mjs");
  mkdirSync(dirname(implPath), { recursive: true });
  writeFileSync(implPath, "export const value = 42;\\n");
  writeFileSync(
    testPath,
    "import assert from 'node:assert/strict';\\nimport { test } from 'node:test';\\nimport { value } from './impl.mjs';\\ntest('x', () => { assert.equal(value, 42); });\\n",
  );
  return { resultText: "done", costUsd: 0.01 };
}
`;
  writeFileSync(modPath, source);
  return modPath;
}

function maxOverlap(intervals) {
  const events = intervals.flatMap((i) => [
    { t: i.start, delta: 1 },
    { t: i.end, delta: -1 },
  ]);
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let current = 0;
  let max = 0;
  for (const e of events) {
    current += e.delta;
    max = Math.max(max, current);
  }
  return max;
}

test("runWaveTasksConcurrently: never runs more than `jobs` workers at once", async () => {
  const { root, baseRef } = makeRepo();
  try {
    const logPath = join(root, "timing.jsonl");
    const modPath = writeTimingImplementerModule(root, logPath);
    const eventsPath = join(root, "events.jsonl");
    const tasks = [poolTask("1.1"), poolTask("1.2"), poolTask("1.3"), poolTask("1.4"), poolTask("1.5")];
    const jobs = 2;

    const results = await runWaveTasksConcurrently(
      tasks,
      {
        changeName: "add-x",
        baseRef,
        config: { maxAttempts: 2, timeout: "20m", model: "sonnet" },
        eventsPath,
        repoRoot: root,
        spawnImplementerModulePath: modPath,
      },
      jobs,
    );

    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.candidate), "every task must still reach checks-passed under a bounded pool");

    const intervals = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(intervals.length, 5);
    assert.ok(maxOverlap(intervals) <= jobs, `observed more than ${jobs} concurrent workers`);
    assert.ok(maxOverlap(intervals) > 1, "the pool ran fully sequentially -- concurrency isn't real");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWaveTasksConcurrently: each worker's events land in the shared events.jsonl, one valid JSON object per line", async () => {
  const { root, baseRef } = makeRepo();
  try {
    const modPath = writeFakeImplementerModule(root);
    const eventsPath = join(root, "events.jsonl");

    await runWaveTasksConcurrently(
      [poolTask("1.1"), poolTask("1.2")],
      {
        changeName: "add-x",
        baseRef,
        config: { maxAttempts: 2, timeout: "20m", model: "sonnet" },
        eventsPath,
        repoRoot: root,
        spawnImplementerModulePath: modPath,
      },
      2,
    );

    const lines = readFileSync(eventsPath, "utf8").trim().split("\n");
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `every line must parse as JSON, got: ${line.slice(0, 80)}`);
    }
    const taskIds = new Set(lines.map((l) => JSON.parse(l).task).filter(Boolean));
    assert.deepEqual([...taskIds].sort(), ["1.1", "1.2"]);

    assert.equal(existsSync(`${eventsPath}.worker-1.1.jsonl`), false, "consolidation must remove the temp file");
    assert.equal(existsSync(`${eventsPath}.worker-1.2.jsonl`), false, "consolidation must remove the temp file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWaveTasksConcurrently: an empty task list resolves immediately with no workers", async () => {
  const { root, baseRef } = makeRepo();
  try {
    const results = await runWaveTasksConcurrently(
      [],
      { changeName: "add-x", baseRef, config: { maxAttempts: 2, timeout: "20m", model: "sonnet" }, eventsPath: join(root, "events.jsonl"), repoRoot: root },
      2,
    );
    assert.deepEqual(results, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
