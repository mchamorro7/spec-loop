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

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// PURE CORE — each function here takes plain data and returns plain data; no
// I/O. Validation failures are returned as data (`errors`), never thrown —
// throwing is reserved for programmer error, not for a malformed input the
// caller is expected to report to a human.
// ---------------------------------------------------------------------------

const REQUIRED_CONFIG_KEYS = ["gate", "test", "max-spend"];

/**
 * Read and validate spec-loop.yaml (task 2.1). `availableCpus` is injected
 * by the caller (`os.cpus().length`) so this stays a pure function of its
 * arguments instead of reading the machine itself.
 */
export function loadConfig(configText, availableCpus = 4) {
  const errors = [];
  let doc;
  try {
    doc = parseYaml(configText ?? "");
  } catch (err) {
    return { config: null, errors: [`spec-loop.yaml no es YAML válido: ${err.message}`] };
  }

  if (doc === null || doc === undefined || typeof doc !== "object" || Array.isArray(doc)) {
    return { config: null, errors: ["spec-loop.yaml debe ser un mapa de claves"] };
  }

  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!(key in doc) || doc[key] === null || doc[key] === undefined || doc[key] === "") {
      errors.push(`falta la clave obligatoria "${key}"`);
    }
  }

  const gate = typeof doc.gate === "string" ? doc.gate : undefined;
  const test = typeof doc.test === "string" ? doc.test : undefined;
  if ("gate" in doc && gate === undefined) errors.push(`"gate" debe ser un string`);
  if ("test" in doc && test === undefined) errors.push(`"test" debe ser un string`);

  const maxSpend = doc["max-spend"];
  if ("max-spend" in doc && !(typeof maxSpend === "number" && maxSpend > 0)) {
    errors.push(`"max-spend" debe ser un número mayor a cero`);
  }

  const jobs = doc.jobs ?? Math.max(1, Math.min(3, availableCpus - 1));
  if (doc.jobs !== undefined && !(Number.isInteger(doc.jobs) && doc.jobs > 0)) {
    errors.push(`"jobs" debe ser un entero mayor a cero`);
  }

  const maxAttempts = doc["max-attempts"] ?? 3;
  if (doc["max-attempts"] !== undefined && !(Number.isInteger(maxAttempts) && maxAttempts > 0)) {
    errors.push(`"max-attempts" debe ser un entero mayor a cero`);
  }

  const timeout = doc.timeout ?? "20m";
  if (typeof timeout !== "string" || timeout === "") {
    errors.push(`"timeout" debe ser un string no vacío`);
  }

  const model = doc.model ?? "sonnet";
  if (typeof model !== "string" || model === "") {
    errors.push(`"model" debe ser un string no vacío`);
  }

  // D15: opt-in model diversity for the checker. Defaults to `model`, so an
  // unconfigured repo behaves exactly as it did before this key existed.
  const checkerModel = doc["checker-model"] ?? model;
  if (typeof checkerModel !== "string" || checkerModel === "") {
    errors.push(`"checker-model" debe ser un string no vacío`);
  }

  const barrier = doc.barrier ?? null;
  if (barrier !== null && (typeof barrier !== "string" || barrier === "")) {
    errors.push(`"barrier" debe ser un string no vacío cuando está declarado`);
  }

  if (errors.length > 0) return { config: null, errors };

  return {
    config: { gate, test, maxSpend, jobs, maxAttempts, timeout, model, checkerModel, barrier },
    errors: [],
  };
}

const CHECKBOX_RE = /^-\s\[([ xX])\]\s+(\S+)\s+(.*)$/;
const HEADING_RE = /^#{1,6}\s+/;
const FENCE_OPEN_RE = /^```ya?ml\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const ALLOWED_TASK_FIELDS = new Set(["proves", "files", "verify", "needs", "red-check"]);

/** Parse tasks.md (OpenSpec checkboxes extended with a yaml block) into tasks. See task 2.2, D14. */
export function parseTasks(tasksMdText) {
  const lines = (tasksMdText ?? "").split("\n");
  const tasks = [];
  const errors = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const m = CHECKBOX_RE.exec(line);
    if (!m) {
      i++;
      continue;
    }

    const checkboxLine = i + 1;
    const checked = m[1].toLowerCase() === "x";
    const id = m[2];
    const description = m[3].trim();
    i++;

    while (i < lines.length && lines[i].trim() === "") i++;

    if (i >= lines.length || !FENCE_OPEN_RE.test(lines[i])) {
      errors.push({ line: checkboxLine, message: `la tarea "${id}" no tiene un bloque yaml a continuación` });
      continue;
    }

    const fenceLine = i + 1;
    i++;
    const yamlLines = [];
    let closed = false;
    while (i < lines.length) {
      if (FENCE_CLOSE_RE.test(lines[i])) {
        closed = true;
        i++;
        break;
      }
      yamlLines.push(lines[i]);
      i++;
    }
    if (!closed) {
      errors.push({ line: fenceLine, message: `el bloque yaml de la tarea "${id}" no está cerrado` });
      continue;
    }

    // A second yaml block before the next checkbox/heading is a duplicate.
    let j = i;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j < lines.length && FENCE_OPEN_RE.test(lines[j])) {
      errors.push({ line: j + 1, message: `la tarea "${id}" tiene más de un bloque yaml` });
      i = j + 1;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) i++;
      if (i < lines.length) i++;
    }

    let obj;
    try {
      obj = parseYaml(yamlLines.join("\n")) ?? {};
    } catch (err) {
      errors.push({ line: fenceLine, message: `yaml inválido en la tarea "${id}": ${err.message}` });
      obj = null;
    }

    // Prose runs until the next checkbox or heading, whichever comes first.
    const proseLines = [];
    while (i < lines.length && !CHECKBOX_RE.test(lines[i]) && !HEADING_RE.test(lines[i])) {
      proseLines.push(lines[i]);
      i++;
    }
    const prose = proseLines.join("\n").trim();

    if (obj === null) continue;
    if (typeof obj !== "object" || Array.isArray(obj)) {
      errors.push({ line: fenceLine, message: `el bloque yaml de la tarea "${id}" debe ser un mapa de claves` });
      continue;
    }

    let fieldsOk = true;
    for (const key of Object.keys(obj)) {
      if (key === "id") {
        errors.push({ line: fenceLine, message: `la tarea "${id}" declara "id" dentro del bloque yaml; el identificador sale del checkbox` });
        fieldsOk = false;
      } else if (!ALLOWED_TASK_FIELDS.has(key)) {
        errors.push({ line: fenceLine, message: `la tarea "${id}" declara un campo desconocido: "${key}"` });
        fieldsOk = false;
      }
    }
    for (const required of ["proves", "files", "verify"]) {
      if (!(required in obj)) {
        errors.push({ line: fenceLine, message: `a la tarea "${id}" le falta el campo obligatorio "${required}"` });
        fieldsOk = false;
      }
    }
    if (!fieldsOk) continue;

    const filesVal = obj.files;
    if (!Array.isArray(filesVal) || filesVal.length === 0 || !filesVal.every((f) => typeof f === "string")) {
      errors.push({ line: fenceLine, message: `"files" de la tarea "${id}" debe ser una lista de rutas` });
      continue;
    }

    const needsVal = obj.needs ?? [];
    if (!Array.isArray(needsVal) || !needsVal.every((n) => typeof n === "string")) {
      errors.push({ line: fenceLine, message: `"needs" de la tarea "${id}" debe ser una lista de ids` });
      continue;
    }

    const verifyVal = obj.verify;
    if (typeof verifyVal !== "string" || verifyVal.trim() === "") {
      errors.push({ line: fenceLine, message: `"verify" de la tarea "${id}" debe ser un string no vacío` });
      continue;
    }

    const provesVal = obj.proves;
    if (typeof provesVal !== "string" || provesVal.trim() === "") {
      errors.push({ line: fenceLine, message: `"proves" de la tarea "${id}" debe ser un string no vacío` });
      continue;
    }

    const rcVal = obj["red-check"] ?? "auto";
    let redCheck;
    if (rcVal === "auto") {
      redCheck = { mode: "auto" };
    } else if (typeof rcVal === "string" && /^skip\b/.test(rcVal)) {
      const reasonMatch = /^skip:?\s*(.*)$/.exec(rcVal);
      const reason = reasonMatch && reasonMatch[1].trim() !== "" ? reasonMatch[1].trim() : null;
      redCheck = { mode: "skip", reason };
    } else {
      errors.push({ line: fenceLine, message: `"red-check" de la tarea "${id}" debe ser "auto" o "skip: <razón>"` });
      continue;
    }

    tasks.push({
      id,
      description,
      checked,
      line: checkboxLine,
      proves: provesVal,
      files: filesVal,
      verify: verifyVal,
      needs: needsVal,
      redCheck,
      prose,
    });
  }

  return { tasks, errors };
}

/** Whole-word match, used to keep small text-matching helpers honest. */
function includesWholeWord(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

function startsWithCommand(verify, command) {
  if (!verify.startsWith(command)) return false;
  const next = verify[command.length];
  return next === undefined || /\W/.test(next);
}

const TEST_FILE_RE = /\.test\.[A-Za-z0-9]+$/;

/**
 * Detect a cycle reachable from `startId` via `needs` edges, tracking the
 * current path explicitly so the returned cycle is the actual loop (e.g.
 * `[1.1, 1.2, 1.1]`), not a reconstruction from recursive return values.
 */
function findCycle(startId, byId) {
  const path = [];
  const onPath = new Set();
  const done = new Set();

  function visit(id) {
    if (done.has(id)) return null;
    const task = byId.get(id);
    if (!task) return null; // dangling reference: not this function's concern
    if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];

    onPath.add(id);
    path.push(id);
    for (const dep of task.needs) {
      const found = visit(dep);
      if (found) return found;
    }
    path.pop();
    onPath.delete(id);
    done.add(id);
    return null;
  }

  return visit(startId);
}

/** Validate the eight checkable contract rules. Returns every violation, not just the first. See task 2.4. */
export function preflight(tasks, ctx) {
  const errors = [];
  const { gateCommand, specDeltaText } = ctx;

  for (const t of tasks) {
    if (!startsWithCommand(t.verify, gateCommand)) {
      errors.push(`la tarea "${t.id}": "verify" no empieza con el comando de gate ("${gateCommand}")`);
    }
  }

  for (const t of tasks) {
    for (const f of t.files) {
      if (TEST_FILE_RE.test(f) && !t.verify.includes(f)) {
        errors.push(`la tarea "${t.id}": el archivo de test "${f}" no está nombrado dentro de "verify"`);
      }
    }
  }

  for (const t of tasks) {
    if (t.redCheck.mode === "skip" && !t.redCheck.reason) {
      errors.push(`la tarea "${t.id}": "red-check: skip" no lleva razón escrita`);
    }
  }

  if (tasks.length > 15) {
    errors.push(`el change declara ${tasks.length} tareas; el alcance corresponde a roadmap, no a un change (máximo 15)`);
  }

  const seenIds = new Map();
  for (const t of tasks) {
    seenIds.set(t.id, (seenIds.get(t.id) ?? 0) + 1);
  }
  for (const [id, count] of seenIds) {
    if (count > 1) errors.push(`el identificador "${id}" está duplicado`);
  }

  const allIds = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const dep of t.needs) {
      if (!allIds.has(dep)) {
        errors.push(`la tarea "${t.id}": "needs" referencia "${dep}", que no existe`);
      }
    }
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const reportedCycles = new Set();
  for (const t of tasks) {
    const cycle = findCycle(t.id, byId);
    if (cycle) {
      const key = [...new Set(cycle)].sort().join(","); // drop the repeated closing id before dedup
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        errors.push(`ciclo en needs: ${cycle.join(" -> ")}`);
      }
    }
  }

  for (const t of tasks) {
    const tokenMatch = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(t.proves.trim());
    const token = tokenMatch ? tokenMatch[1] : null;
    if (!token || !includesWholeWord(specDeltaText ?? "", token)) {
      errors.push(`la tarea "${t.id}": "proves" referencia "${token ?? t.proves}", que no aparece en el spec delta`);
    }
  }

  return { errors };
}

function compareIds(a, b) {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    const bothNumeric = Number.isFinite(na) && Number.isFinite(nb);
    if (bothNumeric && na !== nb) return na - nb;
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

function ownsPath(pattern, path) {
  if (!pattern.endsWith("/**")) return pattern === path;
  const prefix = pattern.slice(0, -2); // keep the trailing "/"
  return path.startsWith(prefix);
}

function filesIntersect(a, b) {
  for (const fa of a) {
    for (const fb of b) {
      if (fa === fb) return true;
      if (fa.endsWith("/**") && ownsPath(fa, fb)) return true;
      if (fb.endsWith("/**") && ownsPath(fb, fa)) return true;
    }
  }
  return false;
}

/**
 * Partition tasks into disjoint, dependency-respecting waves. Pure: no
 * mutable state in or out. `preSatisfiedIds` seeds already-closed ids from
 * waves that ran in an earlier call — without it, recalculating the
 * remaining waves after a barrier (task 6.5) would treat a need pointing at
 * an already-merged earlier task as a dangling reference. See task 2.5.
 */
export function planWaves(tasks, preSatisfiedIds = []) {
  const sorted = [...tasks].sort((a, b) => compareIds(a.id, b.id));
  const preSatisfied = new Set(preSatisfiedIds);
  const allIds = new Set([...sorted.map((t) => t.id), ...preSatisfied]);
  const closedIds = new Set(preSatisfied);
  let remaining = sorted;
  const waves = [];

  while (remaining.length > 0) {
    const wave = [];
    const takenFiles = [];
    const stillRemaining = [];

    for (const t of remaining) {
      const needsMet = t.needs.every((n) => closedIds.has(n));
      if (!needsMet) {
        stillRemaining.push(t);
        continue;
      }
      const conflicts = takenFiles.some((f) => filesIntersect(t.files, f));
      if (conflicts) {
        stillRemaining.push(t);
        continue;
      }
      wave.push(t);
      takenFiles.push(t.files);
    }

    if (wave.length === 0) {
      const dangling = [];
      for (const t of stillRemaining) {
        for (const n of t.needs) {
          if (!allIds.has(n)) dangling.push(`la tarea "${t.id}" depende de "${n}", que no existe`);
        }
      }
      if (dangling.length > 0) return { waves: null, errors: dangling };
      const ids = stillRemaining.map((t) => t.id).join(", ");
      return { waves: null, errors: [`ciclo en needs entre las tareas: ${ids}`] };
    }

    waves.push(wave);
    for (const t of wave) closedIds.add(t.id);
    remaining = stillRemaining;
  }

  return { waves, errors: [] };
}

const ERROR_LINE_RE = /error|Error|✕|FAIL/;
// eslint-disable-next-line no-control-regex -- stripping real ANSI color codes needs \x1B
const ANSI_RE = /\x1B\[[0-9;]*m/g;
const ABS_PATH_RE = /(?:[A-Za-z]:\\|\/)\S+/g;
const LINE_COL_RE = /:\d+:\d+/g;
const PAREN_LINE_COL_RE = /\(\d+,\s*\d+\)/g;

/** Normalize stderr to a stable signature: same underlying failure -> same signature. See task 2.6. */
export function errorSignature(stderrText) {
  const lines = (stderrText ?? "").split("\n").map((l) => l.replace(ANSI_RE, ""));
  const target = lines.find((l) => ERROR_LINE_RE.test(l)) ?? lines.find((l) => l.trim() !== "") ?? "";
  const normalized = target
    .replace(LINE_COL_RE, "")
    .replace(PAREN_LINE_COL_RE, "")
    .replace(ABS_PATH_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

/** Extract the change order roadmap.md declares, filtered to known change names. */
function extractRoadmapOrder(roadmapText, knownNames) {
  const order = [];
  const seen = new Set();
  const nameRe = /`?([a-z0-9]+(?:-[a-z0-9]+)+)`?/g;
  for (const line of (roadmapText ?? "").split("\n")) {
    let m;
    while ((m = nameRe.exec(line)) !== null) {
      const name = m[1];
      if (knownNames.includes(name) && !seen.has(name)) {
        seen.add(name);
        order.push(name);
      }
    }
  }
  return order;
}

/**
 * Pick the current change without it being passed in. `activeChanges` is
 * `[{ name, hasTasks, complete }]`, computed by the caller from the
 * filesystem. See task 2.3.
 */
export function resolveChange(roadmapText, activeChanges) {
  const eligible = activeChanges.filter((c) => c.hasTasks && !c.complete);

  if (eligible.length === 0) {
    return {
      change: null,
      message: "no hay ningún change activo con tasks.md — corré /spec-loop:propose",
      errors: [],
    };
  }

  if (roadmapText) {
    const order = extractRoadmapOrder(roadmapText, activeChanges.map((c) => c.name));
    for (const name of order) {
      const found = eligible.find((c) => c.name === name);
      if (found) return { change: found.name, message: null, errors: [] };
    }
  }

  if (eligible.length === 1) {
    return { change: eligible[0].name, message: null, errors: [] };
  }

  return {
    change: null,
    message: null,
    errors: [
      `hay ${eligible.length} changes activos y ninguno figura en roadmap.md: ${eligible.map((c) => c.name).join(", ")}`,
    ],
  };
}

/** Derive run state from the events log. See task 7.1. */
export function deriveState(_events) {
  throw new Error("deriveState: not yet implemented (task 7.1)");
}

/**
 * Render the wave plan the way `spec-loop` prints it: readable, and honest
 * about a layer cut (one task per wave) so that's visible for free, before
 * spending a token. See task 3.2.
 */
export function formatWaves(changeName, waves) {
  const lines = [`spec-loop · ${changeName}`, ""];

  waves.forEach((wave, idx) => {
    lines.push(`Ola ${idx + 1}`);
    for (const t of wave) {
      const needs = t.needs.length > 0 ? `   (needs: ${t.needs.join(", ")})` : "";
      lines.push(`  ${t.id}  ${t.description}${needs}`);
    }
    lines.push("");
  });

  const isLayerCut = waves.length > 1 && waves.every((w) => w.length === 1);
  if (isLayerCut) {
    lines.push(
      "aviso: cada ola tiene una sola tarea. Puede ser un corte por capa, no por",
      "feature vertical -- revisá tasks.md antes de correr.",
      "",
    );
  }

  lines.push(`spec-loop run       ejecuta ${changeName}`);
  lines.push(`spec-loop status    imprime el estado`);
  return lines.join("\n") + "\n";
}

const MAX_TRUNCATED_BYTES = 4096;
const FIRST_BLOCK_LINES = 20;
const LAST_BLOCK_LINES = 20;

/**
 * First error block + last 20 lines, capped at 4 KB — what gets reinjected
 * into the next attempt. Without this, attempt 3 starts with the context
 * already poisoned by a multi-thousand-line stderr dump. See task 4.4.
 */
export function truncateError(stderrText) {
  const text = stderrText ?? "";
  if (text === "") return "";
  const lines = text.split("\n");
  const firstErrorIdx = Math.max(0, lines.findIndex((l) => ERROR_LINE_RE.test(l)));
  const firstBlockEnd = Math.min(lines.length, firstErrorIdx + FIRST_BLOCK_LINES);
  const tailStart = Math.max(0, lines.length - LAST_BLOCK_LINES);

  const selected =
    tailStart <= firstBlockEnd
      ? lines.slice(firstErrorIdx)
      : [...lines.slice(firstErrorIdx, firstBlockEnd), "…", ...lines.slice(tailStart)];

  const joined = selected.join("\n");
  const bytes = Buffer.from(joined, "utf8");
  return bytes.length <= MAX_TRUNCATED_BYTES
    ? joined
    : bytes.subarray(0, MAX_TRUNCATED_BYTES).toString("utf8");
}

const NEEDS_SCOPE_RE = /^NEEDS-SCOPE:\s*(.+)$/m;

/** The implementer's only way to ask for scope: a fixed line, never a mid-turn question. See task 4.6. */
export function detectNeedsScope(implementerOutputText) {
  const m = NEEDS_SCOPE_RE.exec(implementerOutputText ?? "");
  return m ? m[1].trim() : null;
}

const DURATION_RE = /^(\d+)([smh])$/;
const DURATION_UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };

/** Parse a config duration ("20m") into milliseconds, or null if malformed. */
export function parseDurationMs(text) {
  const m = DURATION_RE.exec((text ?? "").trim());
  return m ? Number(m[1]) * DURATION_UNIT_MS[m[2]] : null;
}

/**
 * The prompt an implementer spawn receives: the task contract, its prose,
 * and — from the second attempt on — the previous attempt's truncated
 * error. Nothing else; see "Presupuesto de contexto por spawn".
 */
export function buildImplementerPrompt(task, previousErrorTruncated = null) {
  const lines = [
    `id: ${task.id}`,
    `proves: ${task.proves}`,
    `files:`,
    ...task.files.map((f) => `  - ${f}`),
    `verify: ${task.verify}`,
  ];
  if (task.needs.length > 0) lines.push(`needs: ${JSON.stringify(task.needs)}`);
  if (task.redCheck.mode === "skip") lines.push(`red-check: skip: ${task.redCheck.reason}`);

  let out = lines.join("\n");
  if (task.prose) out += `\n\n${task.prose}`;
  if (previousErrorTruncated) {
    out += `\n\n--- el intento anterior falló con ---\n${previousErrorTruncated}`;
  }
  return out;
}

/**
 * The loop's only decision, isolated from the I/O around it: given this
 * attempt's verify result and the signature history, what happens next.
 * See task 4.5.
 */
export function decideAttemptOutcome({ attempt, maxAttempts, exitCode, signature, previousSignature }) {
  if (exitCode === 0) return { status: "verified" };
  if (previousSignature !== null && signature === previousSignature) return { status: "stuck" };
  if (attempt >= maxAttempts) return { status: "blocked" };
  return { status: "continue" };
}

const STATUS_ICON = {
  verified: "✅",
  stuck: "⚠️",
  blocked: "❌",
  "needs-scope": "⚠️",
  "test-lint-failed": "❌",
  "red-check-failed": "❌",
  "out-of-scope": "❌",
};

/**
 * Render one events.jsonl record as the live stdout line for it. Most
 * events belong to one task; a few (merge, suite, barrier_check) are
 * wave/change-level and carry no `task`, so the head falls back to just the
 * timestamp instead of printing "undefined". See task 4.8.
 */
export function formatEventLine(event) {
  const time = new Date(event.ts).toISOString().slice(11, 19);
  const head = event.task ? `${time}  ${event.task}` : time;
  switch (event.event) {
    case "attempt_start":
      return `${head}  attempt ${event.attempt}`;
    case "verify": {
      const sig = event.sig ? `  sig ${event.sig}` : "";
      return `${head}  verify exit ${event.exit}${sig}`;
    }
    case "needs_scope":
      return `${head}  NEEDS-SCOPE: ${event.note}`;
    case "commit":
      return `${head}  commit ${event.sha.slice(0, 7)}`;
    case "test_lint":
      return `${head}  test lint ${event.ok ? "ok" : "FAILED"}`;
    case "freeze":
      return `${head}  freeze ${event.fingerprint.slice(0, 8)}`;
    case "freeze_check":
      return `${head}  freeze check ${event.ok ? "ok" : "FAILED (test file changed)"}`;
    case "red_check":
      return event.skipped
        ? `${head}  red-check skip: ${event.reason}`
        : `${head}  red-check ${event.ok ? "ok" : "FAILED"}`;
    case "scope_check":
      return `${head}  scope-check ${event.ok ? "ok" : "FAILED"}`;
    case "checker_verdict":
      return `${head}  checker ${event.id}: ${event.refuted ? "REFUTED" : "ok"}${event.missing ? " (sin veredicto)" : ""}`;
    case "merge":
      return `${head}  merge ${event.ok ? "ok" : `FAILED (${event.failedTask})`}`;
    case "suite":
      return `${head}  suite ${event.ok ? "ok" : "FAILED"}`;
    case "barrier_check":
      return `${head}  barrier check ${event.ok ? "ok" : "FAILED"}`;
    case "closed": {
      const icon = STATUS_ICON[event.status] ?? "";
      const attempts = typeof event.attempts === "number" ? `  ${event.attempts} attempts` : "";
      const cost = typeof event.cost_usd === "number" ? `  $${event.cost_usd.toFixed(2)}` : "";
      return `${head}  ${icon} ${event.status}${attempts}${cost}`;
    }
    default:
      return `${head}  ${event.event}`;
  }
}

/** Test files declared among `files` that are also named inside `verify` — the set lint/freeze/red check operate on. */
export function testFilesFrom(files, verify) {
  return files.filter((f) => TEST_FILE_RE.test(f) && verify.includes(f));
}

const ASSERTION_RE = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\.should\./;
const WEAK_ASSERTION_PATTERNS = [
  /\.toBeDefined\s*\(\s*\)/,
  /\.toBeTruthy\s*\(\s*\)/,
  /\.toBeFalsy\s*\(\s*\)/,
  /\.not\.toBeNull\s*\(\s*\)/,
  /\.not\.toBeUndefined\s*\(\s*\)/,
  /assert\.ok\s*\(\s*[^,)]+\)/,
];
const SNAPSHOT_RE = /\.toMatchSnapshot\s*\(|\.toMatchInlineSnapshot\s*\(/;
const MOCK_CALL_RE = /\b(?:vi|jest)\.mock\s*\(\s*["'`]([^"'`]+)["'`]/g;

/**
 * The mechanical half of the lint del test requirement: does this content
 * look like a test that could catch anything? `ownFiles` are the task's
 * other declared files (everything but the test file itself), used to
 * detect a test that mocks the module it's supposed to be exercising.
 * `content === null` means the file doesn't exist. See task 5.2.
 */
export function lintTestContent(content, ownFiles) {
  if (content === null) return ["el archivo de test no existe"];

  const errors = [];
  const lines = content.split("\n");
  const assertionLines = lines.filter((l) => ASSERTION_RE.test(l));

  if (assertionLines.length === 0) {
    errors.push("el archivo de test no contiene ninguna aserción");
  } else if (assertionLines.every((l) => WEAK_ASSERTION_PATTERNS.some((re) => re.test(l)))) {
    errors.push("el archivo de test solo tiene aserciones de mera existencia (toBeDefined/toBeTruthy/assert.ok)");
  }

  if (SNAPSHOT_RE.test(content)) {
    errors.push("el archivo de test se apoya en un snapshot regenerable");
  }

  let m;
  MOCK_CALL_RE.lastIndex = 0;
  while ((m = MOCK_CALL_RE.exec(content)) !== null) {
    const spec = m[1].replace(/^\.\//, "");
    const mocksOwnFile = ownFiles.some((f) => {
      const base = f.replace(/\.[A-Za-z0-9]+$/, "");
      return f.includes(spec) || base.endsWith(spec) || spec.endsWith(base.split("/").pop());
    });
    if (mocksOwnFile) {
      errors.push(`el test mockea "${m[1]}", que está en los files de la propia tarea`);
    }
  }

  return errors;
}

/**
 * A stable fingerprint over one or more test files' content, keyed by path
 * so key order never affects the result. This is what the runner compares
 * across a refutation retry to make sure the loop didn't edit its own
 * feedback. See task 5.3, D2.
 */
export function computeTestFingerprint(fileContentsByPath) {
  const sortedPaths = Object.keys(fileContentsByPath).sort();
  const combined = sortedPaths.map((p) => `${p}:${fileContentsByPath[p].length}:${fileContentsByPath[p]}`).join("|");
  return createHash("sha256").update(combined).digest("hex");
}

/** Files touched by the diff that aren't covered by any declared path, honoring `/**` ownership. See task 5.6. */
export function findUndeclaredFiles(touchedFiles, declaredFiles) {
  return touchedFiles.filter(
    (f) => !declaredFiles.some((d) => d === f || (d.endsWith("/**") && ownsPath(d, f))),
  );
}

/**
 * What the checker receives as its `-p` prompt. The diffs themselves go in
 * separately, over stdin (see "El diff se entrega, no se busca") — this is
 * everything else it needs to answer its four questions: the spec delta,
 * the registered architecture decisions, and which task claims which
 * `proves`, so it can tell an implementation from something adjacent to it.
 */
export function buildCheckerPrompt(waveTasks, specDeltaText, architectureText) {
  const lines = ["## Spec delta", specDeltaText?.trim() || "(vacío)", ""];
  lines.push("## Decisiones de arquitectura registradas");
  lines.push(architectureText?.trim() || "(vacío — todavía no hay decisiones tomadas)");
  lines.push("", "## Tareas de esta ola (id -> proves)");
  for (const t of waveTasks) lines.push(`- ${t.id}: ${t.proves}`);
  return lines.join("\n");
}

/**
 * Validate the checker's raw output against "Evidencia obligatoria": a
 * `refuted: true` with no evidence doesn't count as a founded refutation —
 * downgraded to non-refuting, but the reason is kept so the report can still
 * show it. A task the checker said nothing about is treated as not refuted
 * (a malformed/incomplete verdict shouldn't block a merge on its own) but
 * flagged `missing` so that's visible rather than silently assumed clean.
 */
export function validateCheckerVerdicts(rawVerdicts, waveTaskIds) {
  const byId = new Map();
  for (const v of rawVerdicts ?? []) {
    if (!v || typeof v.id !== "string" || !waveTaskIds.includes(v.id)) continue;
    const hasEvidence = typeof v.evidence === "string" && v.evidence.trim() !== "";
    byId.set(v.id, {
      id: v.id,
      refuted: v.refuted === true && hasEvidence,
      unfoundedRefutation: v.refuted === true && !hasEvidence,
      reason: typeof v.reason === "string" ? v.reason : "",
      evidence: hasEvidence ? v.evidence : null,
      rule: v.rule && typeof v.rule === "object" ? v.rule : null,
      missing: false,
    });
  }
  return waveTaskIds.map(
    (id) =>
      byId.get(id) ?? {
        id,
        refuted: false,
        unfoundedRefutation: false,
        reason: "sin veredicto del checker",
        evidence: null,
        rule: null,
        missing: true,
      },
  );
}

/**
 * After a wave closes with some tasks red, mark every remaining task whose
 * `needs` closure touches one of them as blocked-by-dep (transitively — a
 * task blocked by a red id can itself block others), then re-partition
 * whatever's left. Pure: the caller supplies the full remaining task list,
 * the red ids, and which ids from earlier waves already merged. See task 6.5.
 */
export function propagateBlockedByDep(remainingTasks, redIds, mergedIds = []) {
  const red = new Set(redIds);
  const blocked = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of remainingTasks) {
      if (blocked.has(t.id)) continue;
      if (t.needs.some((n) => red.has(n) || blocked.has(n))) {
        blocked.add(t.id);
        changed = true;
      }
    }
  }

  const blockedByDep = remainingTasks.filter((t) => blocked.has(t.id));
  const stillEligible = remainingTasks.filter((t) => !blocked.has(t.id));
  const { waves, errors } = planWaves(stillEligible, mergedIds);
  return { blockedByDep, waves: waves ?? [], errors };
}

// ---------------------------------------------------------------------------
// EFFECTS — worktrees, spawns, git, the filesystem, and the CLI dispatch
// below are the only places allowed to do those things. The task pipeline
// (group 4), the barrier (group 6), and the report printer (task 7.7) land
// here once the tasks that own them exist — nothing is pre-declared before
// it has a caller.
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const CHANGES_DIR = join(REPO_ROOT, "openspec", "changes");
const ROADMAP_PATH = join(REPO_ROOT, "openspec", "roadmap.md");
const CONFIG_PATH = join(REPO_ROOT, "spec-loop.yaml");

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Concatenate every .md file under `dir`, recursively — the spec delta text preflight checks `proves` against. */
function collectMarkdown(dir) {
  if (!existsSync(dir)) return "";
  const parts = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) parts.push(collectMarkdown(full));
    else if (entry.name.endsWith(".md")) parts.push(readFileSync(full, "utf8"));
  }
  return parts.join("\n");
}

/** Scan openspec/changes/* for resolveChange()'s `activeChanges` input. */
function listActiveChanges() {
  if (!existsSync(CHANGES_DIR)) return [];
  return readdirSync(CHANGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const tasksPath = join(CHANGES_DIR, e.name, "tasks.md");
      const hasTasks = existsSync(tasksPath);
      let complete = false;
      if (hasTasks) {
        const { tasks, errors } = parseTasks(readFileSync(tasksPath, "utf8"));
        // A file that fails to parse, or has zero tasks, is not "complete" —
        // `.every()` on an empty array is vacuously true, which would wrongly
        // hide a broken tasks.md from ever being selected as the current change.
        complete = errors.length === 0 && tasks.length > 0 && tasks.every((t) => t.checked);
      }
      return { name: e.name, hasTasks, complete };
    });
}

function loadRepoConfig() {
  const text = readIfExists(CONFIG_PATH);
  if (text === null) {
    return { config: null, errors: ["no existe spec-loop.yaml en la raíz del repo"] };
  }
  return loadConfig(text, cpus().length);
}

/**
 * Every subprocess env, minus Node's own test-runner-internal variables.
 * Without this, a `verify:` command that itself runs `node --test` (a
 * common case, and exactly what group 11 does when spec-loop tests itself)
 * inherits `NODE_TEST_CONTEXT` from whatever `node --test` is running
 * spec-loop's own suite, and its exit-code semantics silently break.
 */
function subprocessEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runShell(command, cwd) {
  const result = spawnSync(command, { shell: true, cwd, encoding: "utf8", env: subprocessEnv() });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Preflight per specs/wave-execution/spec.md: gate on the base, parse,
 * validate the eight rules, partition into waves — in that order, before
 * creating any worktree or spawning any agent. Shared by `bare` and (once
 * group 4 wires up execution) `run`.
 */
function preflightCurrentChange(config) {
  const gateResult = runShell(config.gate, REPO_ROOT);
  if (gateResult.code !== 0) {
    return {
      ok: false,
      errors: [`el gate está rojo antes de empezar:\n${gateResult.stderr || gateResult.stdout}`],
    };
  }

  const roadmapText = readIfExists(ROADMAP_PATH);
  const activeChanges = listActiveChanges();
  const resolved = resolveChange(roadmapText, activeChanges);
  if (resolved.errors.length > 0) return { ok: false, errors: resolved.errors };
  if (resolved.change === null) return { ok: false, message: resolved.message };

  const changeDir = join(CHANGES_DIR, resolved.change);
  const tasksText = readFileSync(join(changeDir, "tasks.md"), "utf8");
  const { tasks, errors: parseErrors } = parseTasks(tasksText);
  if (parseErrors.length > 0) {
    return { ok: false, errors: parseErrors.map((e) => `tasks.md:${e.line}: ${e.message}`) };
  }

  const specDeltaText = collectMarkdown(join(changeDir, "specs"));
  const { errors: ruleErrors } = preflight(tasks, { gateCommand: config.gate, specDeltaText });
  if (ruleErrors.length > 0) return { ok: false, errors: ruleErrors };

  const { waves, errors: waveErrors } = planWaves(tasks);
  if (waveErrors.length > 0) return { ok: false, errors: waveErrors };

  return { ok: true, change: resolved.change, waves };
}

function printErrors(errors) {
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: subprocessEnv() });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function worktreeDir(repoRoot, taskId) {
  return join(repoRoot, ".spec-loop", "wt", taskId);
}

function branchName(changeName, taskId) {
  return `spec-loop/${changeName}/${taskId}`;
}

/**
 * Clean any stray worktree/branch left by an earlier interrupted run of this
 * exact task, then create a fresh one from `baseRef` — the wave's base, not
 * a fixed ref, per D6: it's re-read at the start of every wave so later
 * waves branch from a tree that contains the earlier ones. `repoRoot`
 * defaults to the real repo but is injectable so this is testable against a
 * throwaway git repo. See task 4.1.
 */
function ensureWorktree(changeName, taskId, baseRef, repoRoot = REPO_ROOT) {
  const dir = worktreeDir(repoRoot, taskId);
  const branch = branchName(changeName, taskId);

  if (existsSync(dir)) runGit(["worktree", "remove", "--force", dir], repoRoot);
  runGit(["branch", "-D", branch], repoRoot); // no-op if the branch doesn't exist

  const add = runGit(["worktree", "add", "-b", branch, dir, baseRef], repoRoot);
  if (add.code !== 0) {
    throw new Error(`no se pudo crear el worktree de "${taskId}": ${add.stderr || add.stdout}`);
  }
  return { dir, branch };
}

function changeWorktreeDir(repoRoot) {
  return join(repoRoot, ".spec-loop", "wt", "_change");
}

// A separate prefix from task branches (`spec-loop/<change>/<id>`) on
// purpose: git's ref namespace is hierarchical, so a branch literally named
// `spec-loop/<change>` cannot coexist with `spec-loop/<change>/<id>` --
// one would have to be both a leaf and a directory in the same tree.
function changeBranchName(changeName) {
  return `spec-loop-change/${changeName}`;
}

/**
 * The change's own integration branch and worktree — where the barrier
 * merges verified tasks and runs the suite. It lives apart from whatever
 * the user has checked out in the main repo, so the barrier never touches
 * their working directory. Idempotent: a second call (resume) reuses what's
 * already there instead of recreating it.
 */
export function ensureChangeWorktree(changeName, repoRoot = REPO_ROOT) {
  const dir = changeWorktreeDir(repoRoot);
  const branch = changeBranchName(changeName);

  if (existsSync(dir)) return { dir, branch };

  const branchExists = runGit(["rev-parse", "--verify", branch], repoRoot).code === 0;
  const add = branchExists
    ? runGit(["worktree", "add", dir, branch], repoRoot)
    : runGit(["worktree", "add", "-b", branch, dir, "HEAD"], repoRoot);
  if (add.code !== 0) {
    throw new Error(`no se pudo crear el worktree del change "${changeName}": ${add.stderr || add.stdout}`);
  }
  return { dir, branch };
}

/** The wave's base: the change branch's current HEAD, re-read at the start of every wave (D6). */
export function currentWaveBase(changeWorktreeInfo) {
  return runGit(["rev-parse", "HEAD"], changeWorktreeInfo.dir).stdout.trim();
}

const ALLOWED_IMPLEMENTER_TOOLS =
  "Bash(git *),Bash(npm *),Bash(npx *),Bash(pnpm *),Bash(yarn *),Read,Edit,Write,Glob,Grep";
const IMPLEMENTER_MD_PATH = join(REPO_ROOT, "agents", "implementer.md");
const DEFAULT_IMPLEMENTER_MAX_TURNS = "30";

/**
 * Production implementer spawn: `claude -p` with the exact context budget
 * from "Presupuesto de contexto por spawn" — no MCP servers, a turn cap, a
 * timeout, and only the tools listed above. Swappable via ctx.spawnImplementer
 * so the loop's wiring is testable without invoking the real CLI.
 */
function spawnImplementer(prompt, { worktreeDir: cwd, config }) {
  const timeoutMs = parseDurationMs(config.timeout) ?? 20 * 60_000;
  const result = spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--append-system-prompt-file",
      IMPLEMENTER_MD_PATH,
      "--model",
      config.model,
      "--max-turns",
      DEFAULT_IMPLEMENTER_MAX_TURNS,
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ALLOWED_IMPLEMENTER_TOOLS,
      "--output-format",
      "json",
    ],
    { cwd, encoding: "utf8", timeout: timeoutMs, env: subprocessEnv() },
  );

  let parsed = {};
  try {
    parsed = JSON.parse(result.stdout ?? "");
  } catch {
    parsed = {};
  }

  return {
    resultText: typeof parsed.result === "string" ? parsed.result : (result.stdout ?? ""),
    costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
  };
}

/** Append one record to events.jsonl. Only the runner writes here — see task 4.7. */
function appendEvent(eventsPath, event) {
  mkdirSync(dirname(eventsPath), { recursive: true });
  const record = event.ts ? event : { ts: new Date().toISOString(), ...event };
  appendFileSync(eventsPath, JSON.stringify(record) + "\n");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Run one task's full attempt loop inside its own worktree: fresh context
 * per spawn, the runner deciding via `verify`'s exit code (never the
 * agent's own word), and every transition appended to events.jsonl as it
 * happens. `ctx.spawnImplementer` is injectable for testing; production
 * code leaves it as the default, which calls the real `claude` CLI. See
 * group 4 as a whole.
 */
export function runTaskPipeline(task, ctx) {
  const {
    changeName,
    baseRef,
    config,
    eventsPath,
    repoRoot = REPO_ROOT,
    spawnImplementer: spawnFn = spawnImplementer,
    emit = (event) => process.stdout.write(formatEventLine(event) + "\n"),
  } = ctx;

  const record = (event) => {
    const full = { ts: new Date().toISOString(), task: task.id, ...event };
    appendEvent(eventsPath, full);
    emit(full);
    return full;
  };

  const worktree = ensureWorktree(changeName, task.id, baseRef, repoRoot);

  const startedAt = Date.now();
  let previousSignature = null;
  let previousErrorTruncated = null;
  let totalCostUsd = 0;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    record({ event: "attempt_start", attempt });

    const prompt = buildImplementerPrompt(task, previousErrorTruncated);
    const spawned = spawnFn(prompt, { worktreeDir: worktree.dir, config, attempt });
    totalCostUsd += spawned.costUsd ?? 0;

    const scopeNote = detectNeedsScope(spawned.resultText);
    if (scopeNote) {
      record({ event: "needs_scope", attempt, note: scopeNote });
      record({
        event: "closed",
        status: "needs-scope",
        attempts: attempt,
        cost_usd: round2(totalCostUsd),
        wall_s: Math.round((Date.now() - startedAt) / 1000),
      });
      return { status: "needs-scope", attempts: attempt, worktree, note: scopeNote };
    }

    const verifyResult = runShell(task.verify, worktree.dir);
    const passed = verifyResult.code === 0;
    const rawOutput = verifyResult.stderr || verifyResult.stdout;
    const signature = passed ? null : errorSignature(rawOutput);

    // The full output is kept in events.jsonl (durable, for later reading);
    // only the truncated form ever goes back into a prompt or to stdout.
    record({
      event: "verify",
      attempt,
      exit: verifyResult.code,
      ...(passed ? {} : { sig: signature, stderr: rawOutput }),
    });

    const outcome = decideAttemptOutcome({
      attempt,
      maxAttempts: config.maxAttempts,
      exitCode: verifyResult.code,
      signature,
      previousSignature,
    });

    if (outcome.status === "continue") {
      previousSignature = signature;
      previousErrorTruncated = truncateError(rawOutput);
      continue;
    }

    record({
      event: "closed",
      status: outcome.status,
      attempts: attempt,
      cost_usd: round2(totalCostUsd),
      wall_s: Math.round((Date.now() - startedAt) / 1000),
    });
    return { status: outcome.status, attempts: attempt, worktree };
  }
}

/**
 * A task whose `files` is a single `/**` entry owns a whole subtree instead
 * of naming exact paths, so lint/freeze/red check have nothing to iterate
 * over until it's expanded into the concrete files the commit actually
 * touched. The scope check doesn't need this: `findUndeclaredFiles` already
 * understands `/**` ownership directly.
 */
function resolveGlobFiles(task, dir, baseRef) {
  if (!(task.files.length === 1 && task.files[0].endsWith("/**"))) return task.files;
  const diff = runGit(["diff", "--name-only", `${baseRef}..HEAD`], dir);
  return diff.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Remove the task's own implementation (keeping the test files untouched),
 * run `verify`, then restore the committed state regardless of outcome.
 * `verify` still failing means the test is exercising real behavior;
 * `verify` still passing means it isn't. See "Red check".
 */
function runRedCheck(task, dir, baseRef, implFiles) {
  for (const f of implFiles) {
    const existsInBase = runGit(["cat-file", "-e", `${baseRef}:${f}`], dir).code === 0;
    if (existsInBase) {
      runGit(["checkout", baseRef, "--", f], dir);
    } else {
      runGit(["rm", "-f", "--ignore-unmatch", "--", f], dir);
    }
  }
  const verifyResult = runShell(task.verify, dir);
  runGit(["checkout", "HEAD", "--", "."], dir); // restore the full committed state either way
  return { passed: verifyResult.code !== 0 };
}

/**
 * Everything that runs once `verify` has returned exit 0 and the attempt
 * loop has handed the task over: commit → lint → freeze → red check →
 * scope check, in that order (design.md D4/D5 — the commit has to exist
 * before red check can restore from it or scope check can diff against
 * it). Ends either at a terminal failure (`closed` event) or at
 * `checks-passed`, handed off to the wave's checker (group 6). See group 5.
 */
export function runMechanicalChecks(task, ctx) {
  const {
    worktree,
    baseRef,
    eventsPath,
    expectedTestFingerprint = null,
    emit = (e) => process.stdout.write(formatEventLine(e) + "\n"),
  } = ctx;
  const dir = worktree.dir;

  const record = (event) => {
    const full = { ts: new Date().toISOString(), task: task.id, ...event };
    appendEvent(eventsPath, full);
    emit(full);
    return full;
  };

  const dirty = runGit(["status", "--porcelain"], dir).stdout.trim() !== "";
  if (!dirty) {
    // verify passed without the implementer changing anything: exactly the
    // shape of thing red check exists to reject, just caught before there's
    // even a diff to red-check against.
    record({ event: "red_check", ok: false, reason: "verify pasó sin ningún cambio respecto de la base" });
    record({ event: "closed", status: "red-check-failed" });
    return { status: "red-check-failed", reason: "verify pasó sin ningún cambio respecto de la base" };
  }

  runGit(["add", "-A"], dir);
  runGit(
    [
      "commit",
      "-q",
      "-m",
      `spec-loop: ${task.id}`,
      "--trailer",
      `Spec-Loop-Task: ${task.id}`,
      "--trailer",
      `Spec-Loop-Proves: ${task.proves}`,
    ],
    dir,
  );
  const commitSha = runGit(["rev-parse", "HEAD"], dir).stdout.trim();
  record({ event: "commit", sha: commitSha });

  const resolvedFiles = resolveGlobFiles(task, dir, baseRef);
  const testFiles = testFilesFrom(resolvedFiles, task.verify);
  const implFiles = resolvedFiles.filter((f) => !testFiles.includes(f));

  // D2: the loop cannot edit its own feedback. On a refutation retry (the
  // only time expectedTestFingerprint is set), the test file(s) must be
  // byte-identical to what they were the first time verify passed -- checked
  // before lint, because a changed test makes this task out-of-scope
  // outright, not a lint problem.
  if (expectedTestFingerprint !== null) {
    const currentContents = {};
    for (const f of testFiles) {
      const full = join(dir, f);
      currentContents[f] = existsSync(full) ? readFileSync(full, "utf8") : "";
    }
    const currentFingerprint = computeTestFingerprint(currentContents);
    const unchanged = currentFingerprint === expectedTestFingerprint;
    record({ event: "freeze_check", ok: unchanged });
    if (!unchanged) {
      record({ event: "closed", status: "out-of-scope" });
      return { status: "out-of-scope", reason: "el archivo de test cambió respecto de la huella congelada" };
    }
  }

  const lintErrors = [];
  for (const f of testFiles) {
    const full = join(dir, f);
    const content = existsSync(full) ? readFileSync(full, "utf8") : null;
    const ownFiles = resolvedFiles.filter((x) => x !== f);
    lintErrors.push(...lintTestContent(content, ownFiles).map((e) => `${f}: ${e}`));
  }
  record({ event: "test_lint", ok: lintErrors.length === 0, errors: lintErrors });
  if (lintErrors.length > 0) {
    record({ event: "closed", status: "test-lint-failed" });
    return { status: "test-lint-failed", errors: lintErrors };
  }

  const contentsByPath = {};
  for (const f of testFiles) contentsByPath[f] = readFileSync(join(dir, f), "utf8");
  const fingerprint = computeTestFingerprint(contentsByPath);
  record({ event: "freeze", fingerprint });

  if (task.redCheck.mode === "skip") {
    record({ event: "red_check", skipped: true, reason: task.redCheck.reason });
  } else {
    const redResult = runRedCheck(task, dir, baseRef, implFiles);
    record({ event: "red_check", ok: redResult.passed });
    if (!redResult.passed) {
      record({ event: "closed", status: "red-check-failed" });
      return { status: "red-check-failed" };
    }
  }

  const diffResult = runGit(["diff", "--name-only", `${baseRef}..HEAD`], dir);
  const touched = diffResult.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const extraFiles = findUndeclaredFiles(touched, task.files);
  record({ event: "scope_check", ok: extraFiles.length === 0, extra: extraFiles });
  if (extraFiles.length > 0) {
    record({ event: "closed", status: "out-of-scope" });
    return { status: "out-of-scope", extraFiles };
  }

  return { status: "checks-passed", commitSha, testFingerprint: fingerprint };
}

const VERIFIER_MD_PATH = join(REPO_ROOT, "agents", "verifier.md");
const DEFAULT_CHECKER_MAX_TURNS = "10";
// "Sin permiso de exploración": the checker gets no tools at all. It reasons
// over what it's handed (diffs via stdin, spec delta + architecture.md in
// the prompt) and nothing else -- there is nothing for it to go looking for.
const ALLOWED_CHECKER_TOOLS = "";

const CHECKER_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          refuted: { type: "boolean" },
          reason: { type: "string" },
          evidence: { type: "string" },
          rule: {
            type: "object",
            properties: {
              file: { type: "string" },
              ruleSource: { type: "string" },
              rationale: { type: "string" },
            },
          },
        },
        required: ["id", "refuted", "reason", "evidence"],
      },
    },
  },
  required: ["verdicts"],
});

/**
 * Production checker spawn: read-only, fresh context, the wave's diffs
 * delivered over stdin rather than fetched, structured output validated
 * against a schema so the verdict is data, never prose to interpret.
 * Swappable via ctx for testing, exactly like spawnImplementer.
 */
function spawnChecker(promptText, diffText, checkerModel, repoRoot = REPO_ROOT) {
  const result = spawnSync(
    "claude",
    [
      "-p",
      promptText,
      "--append-system-prompt-file",
      VERIFIER_MD_PATH,
      "--model",
      checkerModel,
      "--max-turns",
      DEFAULT_CHECKER_MAX_TURNS,
      "--strict-mcp-config",
      "--allowedTools",
      ALLOWED_CHECKER_TOOLS,
      "--output-format",
      "json",
      "--json-schema",
      CHECKER_JSON_SCHEMA,
    ],
    { cwd: repoRoot, input: diffText, encoding: "utf8", env: subprocessEnv() },
  );

  let parsed = {};
  try {
    parsed = JSON.parse(result.stdout ?? "");
  } catch {
    parsed = {};
  }
  const structured = parsed.structured_output ?? parsed;
  return {
    verdicts: Array.isArray(structured?.verdicts) ? structured.verdicts : [],
    costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
  };
}

/** One task's diff against the wave's base, labeled for the checker's combined stdin. */
function taskDiffBlock(task, worktreeDir, baseRef) {
  const diff = runGit(["diff", `${baseRef}..HEAD`], worktreeDir).stdout;
  return `=== ${task.id} ===\n${diff}`;
}

/**
 * One checker spawn over N tasks' diffs together (never one spawn per
 * task) -- the pregunta (c)/(d) about cross-task supuestos and
 * architecture violations only make sense read this way. See task 6.1.
 */
function runCheckerPass(candidates, ctx) {
  const { baseRef, specDeltaText, architectureText, config, eventsPath, spawnChecker: spawnFn = spawnChecker, emit = (e) => process.stdout.write(formatEventLine(e) + "\n") } = ctx;

  const tasks = candidates.map((c) => c.task);
  const promptText = buildCheckerPrompt(tasks, specDeltaText, architectureText);
  const diffText = candidates.map((c) => taskDiffBlock(c.task, c.worktree.dir, baseRef)).join("\n\n");

  const { verdicts: raw, costUsd } = spawnFn(promptText, diffText, config.checkerModel);
  const verdicts = validateCheckerVerdicts(raw, tasks.map((t) => t.id));

  for (const v of verdicts) {
    const full = { ts: new Date().toISOString(), event: "checker_verdict", ...v };
    appendEvent(eventsPath, full);
    emit(full);
  }

  return { verdicts, costUsd };
}

/**
 * The one re-implementation a refuted task gets: one more spawn in the same
 * worktree (never a fresh one -- the accepted commit stays), one more
 * `verify`, then the mechanical checks again with the frozen fingerprint
 * enforced so the retry can't quietly weaken its own test. Counts against
 * the task's total attempt budget; if none is left, it's blocked outright.
 */
function runRefutationRetry(task, ctx) {
  const {
    worktree,
    baseRef,
    config,
    eventsPath,
    attemptsUsed,
    refutedReason,
    testFingerprint,
    spawnImplementer: spawnFn = spawnImplementer,
    emit = (e) => process.stdout.write(formatEventLine(e) + "\n"),
  } = ctx;

  const record = (event) => {
    const full = { ts: new Date().toISOString(), task: task.id, ...event };
    appendEvent(eventsPath, full);
    emit(full);
    return full;
  };

  if (attemptsUsed >= config.maxAttempts) {
    record({ event: "closed", status: "blocked", attempts: attemptsUsed, reason: "refutado, sin intentos disponibles para reintentar" });
    return { status: "blocked" };
  }

  const attempt = attemptsUsed + 1;
  record({ event: "attempt_start", attempt });

  const prompt = buildImplementerPrompt(task, `El checker refutó el intento anterior: ${refutedReason}`);
  const spawned = spawnFn(prompt, { worktreeDir: worktree.dir, config, attempt });

  const scopeNote = detectNeedsScope(spawned.resultText);
  if (scopeNote) {
    record({ event: "needs_scope", attempt, note: scopeNote });
    record({ event: "closed", status: "needs-scope", attempts: attempt });
    return { status: "needs-scope", note: scopeNote };
  }

  const verifyResult = runShell(task.verify, worktree.dir);
  const passed = verifyResult.code === 0;
  const rawOutput = verifyResult.stderr || verifyResult.stdout;
  record({
    event: "verify",
    attempt,
    exit: verifyResult.code,
    ...(passed ? {} : { sig: errorSignature(rawOutput), stderr: rawOutput }),
  });

  if (!passed) {
    record({ event: "closed", status: "blocked", attempts: attempt });
    return { status: "blocked" };
  }

  return runMechanicalChecks(task, {
    worktree,
    baseRef,
    eventsPath,
    expectedTestFingerprint: testFingerprint,
    emit,
  });
}

/**
 * Merge every accepted task's branch into the change branch, in id order.
 * A conflict here is impossible if the waves were truly disjoint and every
 * task's scope check passed — so it's reported as a harness bug (a
 * particionado or scope-check defect), never as something the code did.
 */
function mergeAcceptedTasks(accepted, changeWorktree) {
  const sorted = [...accepted].sort((a, b) => compareIds(a.task.id, b.task.id));
  for (const c of sorted) {
    const merge = runGit(
      ["merge", "--no-ff", "-m", `spec-loop: merge ${c.task.id}`, c.worktree.branch],
      changeWorktree.dir,
    );
    if (merge.code !== 0) {
      runGit(["merge", "--abort"], changeWorktree.dir);
      return { status: "merge-conflict", failedTask: c.task.id, stderr: merge.stderr };
    }
  }
  return { status: "merged" };
}

/**
 * The barrier for one wave, in the order mechanical-verification's "Barrier
 * y política ante fallo parcial" requires: checker (up to two passes) →
 * merge → suite → the optional expensive check. `candidates` are the tasks
 * that already reached `checks-passed` in group 5 — anything that closed
 * earlier (stuck/blocked/needs-scope/test-lint-failed/red-check-failed/
 * out-of-scope) isn't this function's concern; it's already terminal.
 */
export function runWaveBarrier(candidates, ctx) {
  const {
    changeWorktree,
    baseRef,
    config,
    eventsPath,
    specDeltaText,
    architectureText,
    spawnChecker: spawnCheckerFn,
    spawnImplementer: spawnImplementerFn,
    emit = (e) => process.stdout.write(formatEventLine(e) + "\n"),
  } = ctx;

  const record = (event) => {
    const full = { ts: new Date().toISOString(), ...event };
    appendEvent(eventsPath, full);
    emit(full);
    return full;
  };

  if (candidates.length === 0) {
    return { accepted: [], closed: [], proposedRules: [], barrierStatus: "no-candidates" };
  }

  const closed = [];
  const proposedRules = [];
  const checkerCtx = {
    baseRef,
    specDeltaText,
    architectureText,
    config,
    eventsPath,
    spawnChecker: spawnCheckerFn,
    emit,
  };

  const pass1 = runCheckerPass(candidates, checkerCtx);
  proposedRules.push(...pass1.verdicts.filter((v) => v.rule).map((v) => v.rule));

  let accepted = [];
  const toRetry = [];
  for (const c of candidates) {
    const v = pass1.verdicts.find((v) => v.id === c.task.id);
    if (v.refuted) toRetry.push({ ...c, refutedReason: v.reason });
    else accepted.push(c);
  }

  if (toRetry.length > 0) {
    const retried = toRetry.map((c) => ({
      c,
      result: runRefutationRetry(c.task, {
        worktree: c.worktree,
        baseRef,
        config,
        eventsPath,
        attemptsUsed: c.attemptsUsed,
        refutedReason: c.refutedReason,
        testFingerprint: c.testFingerprint,
        spawnImplementer: spawnImplementerFn,
        emit,
      }),
    }));

    for (const r of retried) {
      if (r.result.status !== "checks-passed") closed.push({ task: r.c.task, status: r.result.status });
    }
    const readyForPass2 = retried
      .filter((r) => r.result.status === "checks-passed")
      .map((r) => ({ ...r.c, testFingerprint: r.result.testFingerprint }));

    if (readyForPass2.length > 0) {
      // Second and last pass — "máximo dos pasadas de checker por ola".
      // Whatever this says is final, no third attempt either way.
      const pass2 = runCheckerPass(readyForPass2, checkerCtx);
      proposedRules.push(...pass2.verdicts.filter((v) => v.rule).map((v) => v.rule));
      for (const c of readyForPass2) {
        const v = pass2.verdicts.find((v) => v.id === c.task.id);
        if (v.refuted) {
          record({ task: c.task.id, event: "closed", status: "blocked", reason: `refutado dos veces: ${v.reason}` });
          closed.push({ task: c.task, status: "blocked" });
        } else {
          accepted.push(c);
        }
      }
    }
  }

  if (accepted.length === 0) {
    return { accepted: [], closed, proposedRules, barrierStatus: "nothing-to-merge" };
  }

  const mergeResult = mergeAcceptedTasks(accepted, changeWorktree);
  record({ event: "merge", ok: mergeResult.status === "merged", failedTask: mergeResult.failedTask });
  if (mergeResult.status !== "merged") {
    return { accepted, closed, proposedRules, barrierStatus: "merge-conflict", failedTask: mergeResult.failedTask };
  }

  const suiteResult = runShell(config.test, changeWorktree.dir);
  record({ event: "suite", ok: suiteResult.code === 0 });
  if (suiteResult.code !== 0) {
    return {
      accepted,
      closed,
      proposedRules,
      barrierStatus: "integration-failed",
      stderr: suiteResult.stderr || suiteResult.stdout,
    };
  }

  if (config.barrier) {
    const expensiveResult = runShell(config.barrier, changeWorktree.dir);
    record({ event: "barrier_check", ok: expensiveResult.code === 0 });
    if (expensiveResult.code !== 0) {
      return {
        accepted,
        closed,
        proposedRules,
        barrierStatus: "integration-failed",
        stderr: expensiveResult.stderr || expensiveResult.stdout,
      };
    }
  }

  return { accepted, closed, proposedRules, barrierStatus: "ok" };
}

// ---------------------------------------------------------------------------
// CONCURRENCY (task 6.6) — every child_process call in this file is
// spawnSync (blocking), which is correct *within* one task's pipeline but
// means a plain loop over N tasks can never run them at the same time no
// matter how it's structured. Real concurrency needs separate OS threads:
// each worker runs its own synchronous pipeline+checks (unchanged, group
// 4/5 code), and the OS schedules their underlying subprocesses in
// parallel. Kept in this one file per D11 — a worker is just this same
// module loaded with `isMainThread === false`, not a second file.
// ---------------------------------------------------------------------------

const WORKER_ENTRYPOINT = fileURLToPath(import.meta.url);

/**
 * Runs inside a worker thread: one task's full pipeline (group 4) then, if
 * it verified, the mechanical checks (group 5). `spawnImplementerOverride`
 * exists only for tests — a real run always uses the production default,
 * since a function can't cross the worker boundary via postMessage.
 */
function runTaskInWorker(data, spawnImplementerOverride) {
  const { task, changeName, baseRef, config, eventsPath, repoRoot } = data;
  try {
    const pipelineCtx = { changeName, baseRef, config, eventsPath, repoRoot };
    if (spawnImplementerOverride) pipelineCtx.spawnImplementer = spawnImplementerOverride;
    const pipelineResult = runTaskPipeline(task, pipelineCtx);

    if (pipelineResult.status !== "verified") {
      return { taskId: task.id, terminal: pipelineResult.status };
    }

    const checksResult = runMechanicalChecks(task, {
      worktree: pipelineResult.worktree,
      baseRef,
      eventsPath,
    });

    return checksResult.status === "checks-passed"
      ? {
          taskId: task.id,
          candidate: {
            task,
            worktree: pipelineResult.worktree,
            attemptsUsed: pipelineResult.attempts,
            testFingerprint: checksResult.testFingerprint,
          },
        }
      : { taskId: task.id, terminal: checksResult.status };
  } catch (err) {
    return { taskId: task.id, terminal: "error", error: err.message };
  }
}

/**
 * Run a wave's tasks with real concurrency, up to `jobs` workers at once.
 * Each worker writes its events to a private temp file — concurrent
 * appends to the shared events.jsonl from separate OS threads aren't
 * guaranteed atomic once a line grows past a few KB (exactly the case for a
 * verify failure's full, untruncated stderr), so the main thread stays the
 * only writer to it, consolidating each worker's temp file as it exits.
 * See task 6.6.
 */
export function runWaveTasksConcurrently(tasks, ctx, jobs) {
  const { changeName, baseRef, config, eventsPath, repoRoot, spawnImplementerModulePath } = ctx;

  return new Promise((resolve) => {
    if (tasks.length === 0) {
      resolve([]);
      return;
    }

    const results = [];
    let nextIndex = 0;
    let active = 0;

    function consolidate(tempPath) {
      if (!existsSync(tempPath)) return;
      const lines = readFileSync(tempPath, "utf8");
      if (lines) appendFileSync(eventsPath, lines);
      rmSync(tempPath, { force: true });
    }

    function launchNext() {
      while (active < jobs && nextIndex < tasks.length) {
        const task = tasks[nextIndex++];
        const tempEventsPath = `${eventsPath}.worker-${task.id}.jsonl`;
        active++;

        const worker = new Worker(WORKER_ENTRYPOINT, {
          workerData: {
            task,
            changeName,
            baseRef,
            config,
            eventsPath: tempEventsPath,
            repoRoot,
            spawnImplementerModulePath,
          },
        });

        const finish = (message) => {
          consolidate(tempEventsPath);
          results.push(message);
          active--;
          if (active === 0 && nextIndex >= tasks.length) resolve(results);
          else launchNext();
        };

        worker.on("message", finish);
        worker.on("error", (err) => finish({ taskId: task.id, terminal: "error", error: err.message }));
      }
    }

    launchNext();
  });
}

if (!isMainThread) {
  // Worker mode: run exactly one task and post the result back.
  // spawnImplementerModulePath is a test-only seam — a real run never sets
  // it, and the dynamic import only ever happens with a path this same
  // process constructed, never with untrusted input.
  const data = workerData;
  const loadOverride = data.spawnImplementerModulePath
    ? import(pathToFileURL(data.spawnImplementerModulePath).href).then((m) => m.default)
    : Promise.resolve(undefined);
  loadOverride.then((override) => {
    parentPort.postMessage(runTaskInWorker(data, override));
  });
}

/** `spec-loop` — preflight, print the waves, exit. Costs zero tokens. */
async function bare() {
  const { config, errors: configErrors } = loadRepoConfig();
  if (configErrors.length > 0) {
    printErrors(configErrors);
    process.exitCode = 2;
    return;
  }

  const result = preflightCurrentChange(config);
  if (result.message) {
    process.stdout.write(result.message + "\n");
    return;
  }
  if (!result.ok) {
    printErrors(result.errors);
    process.exitCode = 2;
    return;
  }

  process.stdout.write(formatWaves(result.change, result.waves));
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

if (isMainThread && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
