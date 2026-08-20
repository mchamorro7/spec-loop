#!/usr/bin/env node

// spec-loop — the runner.
//
// Shape (design.md D11): a pure core that decides, and a thin effectful edge
// that acts. The pure functions take data in, return data out, and touch
// neither the filesystem, git, nor a subprocess. Everything below the
// "EFFECTS" marker is the only place allowed to do those things.
//
// Two verbs, zero arguments: `spec-loop` (bare), `spec-loop run`,
// `spec-loop status`. See specs/wave-execution/spec.md.

// ---------------------------------------------------------------------------
// PURE CORE — filled in by tasks 2.1-2.6. Each function here takes plain data
// and returns plain data; no I/O.
// ---------------------------------------------------------------------------

/** Read and validate spec-loop.yaml. See task 2.1. */
export function loadConfig(_configText) {
  throw new Error("loadConfig: not yet implemented (task 2.1)");
}

/** Pick the current change from roadmap.md + the list of active changes. See task 2.3. */
export function resolveChange(_roadmapText, _activeChanges) {
  throw new Error("resolveChange: not yet implemented (task 2.3)");
}

/** Parse tasks.md into a list of tasks. See task 2.2. */
export function parseTasks(_tasksMdText) {
  throw new Error("parseTasks: not yet implemented (task 2.2)");
}

/** Validate the nine checkable contract rules against parsed tasks. See task 2.4. */
export function preflight(_tasks, _specDeltaText) {
  throw new Error("preflight: not yet implemented (task 2.4)");
}

/** Partition tasks into disjoint, dependency-respecting waves. See task 2.5. */
export function planWaves(_tasks) {
  throw new Error("planWaves: not yet implemented (task 2.5)");
}

/** Normalize a stderr blob into a stable signature. See task 2.6. */
export function errorSignature(_stderrText) {
  throw new Error("errorSignature: not yet implemented (task 2.6)");
}

/** Derive run state from the events log. See task 7.1. */
export function deriveState(_events) {
  throw new Error("deriveState: not yet implemented (task 7.1)");
}

// ---------------------------------------------------------------------------
// EFFECTS — worktrees, spawns, git, the filesystem, and the CLI dispatch
// below are the only places allowed to do those things. The task pipeline
// (group 4), the barrier (group 6), and the report printer (task 7.7) land
// here once the tasks that own them exist — nothing is pre-declared before
// it has a caller.
// ---------------------------------------------------------------------------

/** `spec-loop` — preflight, print the waves, exit. Costs zero tokens. */
async function bare() {
  throw new Error("bare invocation: not yet implemented (task 3.1)");
}

/** `spec-loop run` — preflight, print the waves, execute. */
async function run() {
  throw new Error("run: not yet implemented (group 4-7)");
}

/** `spec-loop status` — print state derived from events.jsonl. */
async function status() {
  throw new Error("status: not yet implemented (task 7.2)");
}

async function main(argv) {
  const [verb, ...rest] = argv.slice(2);

  if (rest.length > 0) {
    process.stderr.write(
      `spec-loop takes no arguments or flags. Configure via spec-loop.yaml instead.\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (verb === undefined) return bare();
  if (verb === "run") return run();
  if (verb === "status") return status();

  process.stderr.write(
    `unknown command: ${verb}\nusage: spec-loop | spec-loop run | spec-loop status\n`,
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
