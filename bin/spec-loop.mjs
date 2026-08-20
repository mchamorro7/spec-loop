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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
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

  const barrier = doc.barrier ?? null;
  if (barrier !== null && (typeof barrier !== "string" || barrier === "")) {
    errors.push(`"barrier" debe ser un string no vacío cuando está declarado`);
  }

  if (errors.length > 0) return { config: null, errors };

  return {
    config: { gate, test, maxSpend, jobs, maxAttempts, timeout, model, barrier },
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

/** Partition tasks into disjoint, dependency-respecting waves. Pure: no mutable state in or out. See task 2.5. */
export function planWaves(tasks) {
  const sorted = [...tasks].sort((a, b) => compareIds(a.id, b.id));
  const allIds = new Set(sorted.map((t) => t.id));
  const closedIds = new Set();
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
};

/** Render one events.jsonl record as the live stdout line for it. See task 4.8. */
export function formatEventLine(event) {
  const time = new Date(event.ts).toISOString().slice(11, 19);
  const head = `${time}  ${event.task}`;
  switch (event.event) {
    case "attempt_start":
      return `${head}  attempt ${event.attempt}`;
    case "verify": {
      const sig = event.sig ? `  sig ${event.sig}` : "";
      return `${head}  verify exit ${event.exit}${sig}`;
    }
    case "needs_scope":
      return `${head}  NEEDS-SCOPE: ${event.note}`;
    case "closed": {
      const icon = STATUS_ICON[event.status] ?? "";
      const cost = typeof event.cost_usd === "number" ? `  $${event.cost_usd.toFixed(2)}` : "";
      return `${head}  ${icon} ${event.status}  ${event.attempts} attempts${cost}`;
    }
    default:
      return `${head}  ${event.event}`;
  }
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

function runShell(command, cwd) {
  const result = spawnSync(command, { shell: true, cwd, encoding: "utf8" });
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
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
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
    { cwd, encoding: "utf8", timeout: timeoutMs },
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
