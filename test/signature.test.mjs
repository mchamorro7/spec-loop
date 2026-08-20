import { test } from "node:test";
import assert from "node:assert/strict";
import { errorSignature } from "../bin/spec-loop.mjs";

test("errorSignature: is deterministic for the same input", () => {
  const stderr = "src/auth/session.ts:12:5 - error TS2322: Type 'string' is not assignable.";
  assert.equal(errorSignature(stderr), errorSignature(stderr));
});

test("errorSignature: collapses across different line/column numbers", () => {
  const a = "/repo/src/auth/session.ts:12:5 - error TS2322: Type 'string' is not assignable.";
  const b = "/repo/src/auth/session.ts:40:9 - error TS2322: Type 'string' is not assignable.";
  assert.equal(errorSignature(a), errorSignature(b));
});

test("errorSignature: collapses across different absolute paths", () => {
  const a = "/Users/alice/repo/src/x.ts:1:1 - error TS2322: mismatch";
  const b = "/home/bob/work/repo/src/x.ts:9:9 - error TS2322: mismatch";
  assert.equal(errorSignature(a), errorSignature(b));
});

test("errorSignature: distinguishes genuinely different errors", () => {
  const a = "src/x.ts:1:1 - error TS2322: Type 'string' is not assignable.";
  const b = "src/y.ts:1:1 - error TS2554: Expected 2 arguments, but got 1.";
  assert.notEqual(errorSignature(a), errorSignature(b));
});

test("errorSignature: strips ANSI color codes before comparing", () => {
  const plain = "FAIL src/x.test.ts > it fails";
  const colored = "\x1B[31mFAIL\x1B[0m src/x.test.ts > it fails";
  assert.equal(errorSignature(plain), errorSignature(colored));
});

test("errorSignature: picks the first line that looks like an error out of a noisy blob", () => {
  const noisy = [
    "> spec-loop@0.1.0 test",
    "> node --test",
    "",
    "src/session.ts:5:1 - error TS2322: Type mismatch",
    "    at Object.<anonymous> (/repo/node_modules/x/index.js:10:5)",
  ].join("\n");
  const clean = "src/session.ts:99:1 - error TS2322: Type mismatch";
  assert.equal(errorSignature(noisy), errorSignature(clean));
});

test("errorSignature: does not throw on empty stderr and stays stable", () => {
  assert.equal(errorSignature(""), errorSignature(""));
  assert.equal(errorSignature(undefined), errorSignature(""));
});

test("errorSignature: returns a short hex string", () => {
  const sig = errorSignature("error: boom");
  assert.match(sig, /^[0-9a-f]{8}$/);
});
