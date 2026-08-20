import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateError } from "../bin/spec-loop.mjs";

test("truncateError: empty stderr stays empty", () => {
  assert.equal(truncateError(""), "");
  assert.equal(truncateError(undefined), "");
});

test("truncateError: short stderr passes through untouched", () => {
  const text = "error: boom\n  at somewhere";
  assert.equal(truncateError(text), text);
});

test("truncateError: caps the result at 4 KB", () => {
  const huge = "error: boom\n" + "line of noise\n".repeat(1000);
  const out = truncateError(huge);
  assert.ok(Buffer.byteLength(out, "utf8") <= 4096);
});

test("truncateError: keeps the first error line even when it's far from the end", () => {
  const lines = ["preamble", "error: the real cause", ...Array(100).fill("noise")];
  const out = truncateError(lines.join("\n"));
  assert.match(out, /error: the real cause/);
});

test("truncateError: keeps the tail even when the error is near the top", () => {
  const lines = ["error: cause", ...Array(100).fill("noise"), "final relevant line"];
  const out = truncateError(lines.join("\n"));
  assert.match(out, /final relevant line/);
});

test("truncateError: does not duplicate content when the first block and the tail overlap", () => {
  const lines = ["error: cause", "line 2", "line 3", "line 4", "line 5"];
  const out = truncateError(lines.join("\n"));
  // every line appears exactly once
  for (const l of lines) {
    const occurrences = out.split("\n").filter((x) => x === l).length;
    assert.equal(occurrences, 1, `expected "${l}" exactly once, found ${occurrences}`);
  }
});
