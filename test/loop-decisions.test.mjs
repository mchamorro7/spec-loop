import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideAttemptOutcome,
  detectNeedsScope,
  parseDurationMs,
  buildImplementerPrompt,
  formatEventLine,
} from "../bin/spec-loop.mjs";

test("decideAttemptOutcome: exit 0 is always verified, regardless of attempt count", () => {
  const { status } = decideAttemptOutcome({
    attempt: 1,
    maxAttempts: 3,
    exitCode: 0,
    signature: null,
    previousSignature: null,
  });
  assert.equal(status, "verified");
});

test("decideAttemptOutcome: a failing first attempt with no history continues", () => {
  const { status } = decideAttemptOutcome({
    attempt: 1,
    maxAttempts: 3,
    exitCode: 1,
    signature: "aaa",
    previousSignature: null,
  });
  assert.equal(status, "continue");
});

test("decideAttemptOutcome: the same signature twice in a row is stuck, even with attempts left", () => {
  const { status } = decideAttemptOutcome({
    attempt: 2,
    maxAttempts: 5,
    exitCode: 1,
    signature: "aaa",
    previousSignature: "aaa",
  });
  assert.equal(status, "stuck");
});

test("decideAttemptOutcome: a different signature does not trigger stuck", () => {
  const { status } = decideAttemptOutcome({
    attempt: 2,
    maxAttempts: 5,
    exitCode: 1,
    signature: "bbb",
    previousSignature: "aaa",
  });
  assert.equal(status, "continue");
});

test("decideAttemptOutcome: exhausting attempts without a repeated signature is blocked", () => {
  const { status } = decideAttemptOutcome({
    attempt: 3,
    maxAttempts: 3,
    exitCode: 1,
    signature: "ccc",
    previousSignature: "bbb",
  });
  assert.equal(status, "blocked");
});

test("detectNeedsScope: finds the fixed marker line and returns its text", () => {
  const note = detectNeedsScope("some output\nNEEDS-SCOPE: falta tocar eslint.config.js\nmore text");
  assert.equal(note, "falta tocar eslint.config.js");
});

test("detectNeedsScope: returns null when the marker is absent", () => {
  assert.equal(detectNeedsScope("nothing special here"), null);
  assert.equal(detectNeedsScope(""), null);
  assert.equal(detectNeedsScope(undefined), null);
});

test("parseDurationMs: converts minutes, seconds, hours", () => {
  assert.equal(parseDurationMs("20m"), 20 * 60_000);
  assert.equal(parseDurationMs("30s"), 30_000);
  assert.equal(parseDurationMs("1h"), 3_600_000);
});

test("parseDurationMs: malformed input returns null", () => {
  assert.equal(parseDurationMs("soon"), null);
  assert.equal(parseDurationMs(""), null);
});

test("buildImplementerPrompt: renders the contract fields and prose", () => {
  const task = {
    id: "2.1",
    proves: "FR1",
    files: ["a.ts", "a.test.ts"],
    verify: "pnpm run gate && pnpm test -- a.test.ts",
    needs: ["1.1"],
    redCheck: { mode: "auto" },
    prose: "Notas opcionales.",
  };
  const prompt = buildImplementerPrompt(task);
  assert.match(prompt, /id: 2\.1/);
  assert.match(prompt, /proves: FR1/);
  assert.match(prompt, /- a\.ts/);
  assert.match(prompt, /needs: \["1\.1"\]/);
  assert.match(prompt, /Notas opcionales\./);
  assert.doesNotMatch(prompt, /intento anterior/);
});

test("buildImplementerPrompt: appends the truncated previous error from the second attempt on", () => {
  const task = {
    id: "1.1",
    proves: "FR1",
    files: ["a.ts"],
    verify: "pnpm run gate",
    needs: [],
    redCheck: { mode: "auto" },
    prose: "",
  };
  const prompt = buildImplementerPrompt(task, "error: boom");
  assert.match(prompt, /intento anterior falló/);
  assert.match(prompt, /error: boom/);
});

test("formatEventLine: never includes the full stderr, even when the event carries it", () => {
  const line = formatEventLine({
    ts: "2026-08-20T14:05:47.000Z",
    task: "2.1",
    event: "verify",
    attempt: 2,
    exit: 1,
    sig: "a3f1c9",
    stderr: "a".repeat(5000),
  });
  assert.match(line, /2\.1/);
  assert.match(line, /verify exit 1/);
  assert.match(line, /sig a3f1c9/);
  assert.ok(line.length < 200, "the live line must stay short, not carry the raw stderr");
});

test("formatEventLine: renders a closed/verified line with cost and attempts", () => {
  const line = formatEventLine({
    ts: "2026-08-20T14:09:31.000Z",
    task: "2.1",
    event: "closed",
    status: "verified",
    attempts: 2,
    cost_usd: 0.41,
    wall_s: 186,
  });
  assert.match(line, /verified/);
  assert.match(line, /2 attempts/);
  assert.match(line, /\$0\.41/);
});
