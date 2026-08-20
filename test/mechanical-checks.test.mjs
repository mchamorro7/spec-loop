import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runMechanicalChecks } from "../bin/spec-loop.mjs";

function git(args, cwd) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A throwaway git repo, one worktree already checked out on a task branch — the shape group 4 hands to group 5. */
function makeRepoWithTaskBranch() {
  const root = mkdtempSync(join(tmpdir(), "spec-loop-checks-"));
  git(["init", "-q"], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "spec-loop tests"], root);
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(["add", "README.md"], root);
  git(["commit", "-q", "-m", "initial"], root);
  // Captured once, like a real wave's base (D6) -- not "HEAD", which would
  // keep moving with the task's own commits inside its own worktree.
  const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  const wtDir = join(root, "wt");
  git(["worktree", "add", "-b", "spec-loop/add-x/1.1", wtDir, baseRef], root);
  return { root, wtDir, baseRef };
}

function writeFile(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// .mjs, not .ts: real TypeScript syntax needs a loader/transpiler, and a
// bare ".ts" file with `import` in a throwaway repo (no package.json "type":
// "module") gets parsed as CommonJS and blows up on syntax alone -- a false
// failure that has nothing to do with the implementation being tested.
function baseTask(overrides = {}) {
  return {
    id: "1.1",
    proves: "FR1",
    files: ["src/refresh.mjs", "src/refresh.test.mjs"],
    verify: "node --test src/refresh.test.mjs",
    needs: [],
    redCheck: { mode: "auto" },
    prose: "",
    ...overrides,
  };
}

test("runMechanicalChecks: a real implementation with a real test passes every check", () => {
  const { root, wtDir, baseRef } = makeRepoWithTaskBranch();
  try {
    writeFile(
      wtDir,
      "src/refresh.mjs",
      `export function refreshToken(s) { return { token: "brand-new-" + s.id }; }\n`,
    );
    writeFile(
      wtDir,
      "src/refresh.test.mjs",
      `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { refreshToken } from "./refresh.mjs";\ntest("renueva", () => {\n  assert.equal(refreshToken({ id: "s1" }).token, "brand-new-s1");\n});\n`,
    );

    const eventsPath = join(root, "events.jsonl");
    const result = runMechanicalChecks(baseTask(), {
      worktree: { dir: wtDir },
      baseRef,
      eventsPath,
      emit: () => {},
    });

    assert.equal(result.status, "checks-passed");
    assert.ok(result.commitSha);
    assert.ok(result.testFingerprint);

    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.event), ["commit", "test_lint", "freeze", "red_check", "scope_check"]);
    assert.equal(events[3].ok, true);
    assert.equal(events[4].ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMechanicalChecks: a test that passes without the implementation fails red check", () => {
  const { root, wtDir, baseRef } = makeRepoWithTaskBranch();
  try {
    writeFile(wtDir, "src/refresh.mjs", `export function refreshToken(s) { return { token: "x" }; }\n`);
    // This test never actually calls refreshToken -- it would pass even with no implementation.
    writeFile(
      wtDir,
      "src/refresh.test.mjs",
      `import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("renueva", () => {\n  assert.equal(1, 1);\n});\n`,
    );

    const eventsPath = join(root, "events.jsonl");
    const result = runMechanicalChecks(baseTask(), {
      worktree: { dir: wtDir },
      baseRef,
      eventsPath,
      emit: () => {},
    });

    assert.equal(result.status, "red-check-failed");

    // The worktree must be restored to the full committed state after red check ran.
    const restored = readFileSync(join(wtDir, "src/refresh.mjs"), "utf8");
    assert.match(restored, /token: "x"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMechanicalChecks: red check restores implementation files it removed", () => {
  const { root, wtDir, baseRef } = makeRepoWithTaskBranch();
  try {
    writeFile(
      wtDir,
      "src/refresh.mjs",
      `export function refreshToken(s) { return { token: "brand-new-" + s.id }; }\n`,
    );
    writeFile(
      wtDir,
      "src/refresh.test.mjs",
      `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { refreshToken } from "./refresh.mjs";\ntest("renueva", () => {\n  assert.equal(refreshToken({ id: "s1" }).token, "brand-new-s1");\n});\n`,
    );

    runMechanicalChecks(baseTask(), {
      worktree: { dir: wtDir },
      baseRef,
      eventsPath: join(root, "events.jsonl"),
      emit: () => {},
    });

    const restored = readFileSync(join(wtDir, "src/refresh.mjs"), "utf8");
    assert.match(restored, /brand-new-/, "the implementation must be back after red check's remove/restore dance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMechanicalChecks: a test with no assertions fails lint before red check ever runs", () => {
  const { root, wtDir, baseRef } = makeRepoWithTaskBranch();
  try {
    writeFile(wtDir, "src/refresh.mjs", `export function refreshToken(s) { return s; }\n`);
    writeFile(wtDir, "src/refresh.test.mjs", `console.log("not actually a test");\n`);

    const eventsPath = join(root, "events.jsonl");
    const result = runMechanicalChecks(baseTask(), {
      worktree: { dir: wtDir },
      baseRef,
      eventsPath,
      emit: () => {},
    });

    assert.equal(result.status, "test-lint-failed");
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.event), ["commit", "test_lint", "closed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMechanicalChecks: touching an undeclared file fails scope check", () => {
  const { root, wtDir, baseRef } = makeRepoWithTaskBranch();
  try {
    writeFile(
      wtDir,
      "src/refresh.mjs",
      `export function refreshToken(s) { return { token: "brand-new-" + s.id }; }\n`,
    );
    writeFile(
      wtDir,
      "src/refresh.test.mjs",
      `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { refreshToken } from "./refresh.mjs";\ntest("renueva", () => {\n  assert.equal(refreshToken({ id: "s1" }).token, "brand-new-s1");\n});\n`,
    );
    writeFile(wtDir, "src/unrelated.mjs", "export const oops = true;\n");

    const result = runMechanicalChecks(baseTask(), {
      worktree: { dir: wtDir },
      baseRef,
      eventsPath: join(root, "events.jsonl"),
      emit: () => {},
    });

    assert.equal(result.status, "out-of-scope");
    assert.deepEqual(result.extraFiles, ["src/unrelated.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMechanicalChecks: red-check: skip records the reason and never runs the check", () => {
  const { root, wtDir, baseRef } = makeRepoWithTaskBranch();
  try {
    writeFile(wtDir, "src/refresh.mjs", `export function refreshToken(s) { return s; }\n`);
    // A trivially weak test would normally be fine to fail red check on, but
    // skip must bypass it entirely -- this test file asserts nothing.
    writeFile(wtDir, "src/refresh.test.mjs", `import { test } from "node:test";\ntest("noop", () => {});\n`);

    const eventsPath = join(root, "events.jsonl");
    const result = runMechanicalChecks(
      baseTask({ redCheck: { mode: "skip", reason: "refactor, el comportamiento no cambia" } }),
      { worktree: { dir: wtDir }, baseRef, eventsPath, emit: () => {} },
    );

    // Lint still runs and still fails on this task on its own merits (no
    // assertions) -- skip only exempts red check, not the other checks.
    assert.equal(result.status, "test-lint-failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMechanicalChecks: verify passing with zero changes fails red check without a commit", () => {
  const { root, wtDir, baseRef } = makeRepoWithTaskBranch();
  try {
    const eventsPath = join(root, "events.jsonl");
    const result = runMechanicalChecks(baseTask({ verify: "true" }), {
      worktree: { dir: wtDir },
      baseRef,
      eventsPath,
      emit: () => {},
    });

    assert.equal(result.status, "red-check-failed");
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.event), ["red_check", "closed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMechanicalChecks: a /** glob-owning task resolves to its concrete touched files", () => {
  const { root, wtDir, baseRef } = makeRepoWithTaskBranch();
  try {
    writeFile(wtDir, "src/auth/session.mjs", `export function makeSession() { return { id: "s1" }; }\n`);
    writeFile(
      wtDir,
      "src/auth/session.test.mjs",
      `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { makeSession } from "./session.mjs";\ntest("crea sesion", () => {\n  assert.equal(makeSession().id, "s1");\n});\n`,
    );

    const task = baseTask({
      files: ["src/auth/**"],
      verify: "node --test src/auth/session.test.mjs",
    });

    const result = runMechanicalChecks(task, {
      worktree: { dir: wtDir },
      baseRef,
      eventsPath: join(root, "events.jsonl"),
      emit: () => {},
    });

    assert.equal(result.status, "checks-passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
