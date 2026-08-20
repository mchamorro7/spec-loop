import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lintTestContent,
  computeTestFingerprint,
  findUndeclaredFiles,
  testFilesFrom,
} from "../bin/spec-loop.mjs";

test("lintTestContent: a missing file is its own single error", () => {
  const errors = lintTestContent(null, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no existe/);
});

test("lintTestContent: no assertions at all is flagged", () => {
  const content = `import { refreshToken } from "./refresh";\nconsole.log(refreshToken);\n`;
  const errors = lintTestContent(content, ["src/refresh.ts"]);
  assert.ok(errors.some((e) => /ninguna aserción/.test(e)));
});

test("lintTestContent: only toBeDefined()/toBeTruthy() is flagged as mere-existence", () => {
  const content = `test("renueva", () => {\n  expect(refreshToken(session)).toBeDefined();\n});\n`;
  const errors = lintTestContent(content, []);
  assert.ok(errors.some((e) => /mera existencia/.test(e)));
});

test("lintTestContent: a real assertion (toEqual) is not flagged as weak", () => {
  const content = `test("renueva", () => {\n  expect(refreshToken(session)).toEqual({ token: "new" });\n});\n`;
  const errors = lintTestContent(content, []);
  assert.ok(!errors.some((e) => /mera existencia/.test(e)));
});

test("lintTestContent: node:assert with a real comparison is not flagged", () => {
  const content = `assert.equal(refreshToken(session).token, "new");\n`;
  const errors = lintTestContent(content, []);
  assert.deepEqual(errors, []);
});

test("lintTestContent: mocking a module in the task's own files is flagged", () => {
  const content = `vi.mock("./refresh");\ntest("x", () => { expect(1).toEqual(1); });\n`;
  const errors = lintTestContent(content, ["src/auth/refresh.ts"]);
  assert.ok(errors.some((e) => /mockea/.test(e)));
});

test("lintTestContent: mocking a module NOT in the task's own files is not flagged", () => {
  const content = `vi.mock("node-fetch");\ntest("x", () => { expect(1).toEqual(1); });\n`;
  const errors = lintTestContent(content, ["src/auth/refresh.ts"]);
  assert.ok(!errors.some((e) => /mockea/.test(e)));
});

test("lintTestContent: a snapshot assertion is flagged", () => {
  const content = `test("x", () => { expect(render()).toMatchSnapshot(); });\n`;
  const errors = lintTestContent(content, []);
  assert.ok(errors.some((e) => /snapshot/.test(e)));
});

test("lintTestContent: a well-formed test has no errors", () => {
  const content = `test("renueva", () => {\n  const s = refreshToken(expiredSession);\n  assert.equal(s.token, "brand-new-token");\n});\n`;
  const errors = lintTestContent(content, ["src/auth/refresh.ts"]);
  assert.deepEqual(errors, []);
});

test("computeTestFingerprint: deterministic for the same content", () => {
  const a = computeTestFingerprint({ "x.test.ts": "content" });
  const b = computeTestFingerprint({ "x.test.ts": "content" });
  assert.equal(a, b);
});

test("computeTestFingerprint: independent of key order", () => {
  const a = computeTestFingerprint({ "a.test.ts": "1", "b.test.ts": "2" });
  const b = computeTestFingerprint({ "b.test.ts": "2", "a.test.ts": "1" });
  assert.equal(a, b);
});

test("computeTestFingerprint: changes when content changes", () => {
  const a = computeTestFingerprint({ "x.test.ts": "before" });
  const b = computeTestFingerprint({ "x.test.ts": "after" });
  assert.notEqual(a, b);
});

test("computeTestFingerprint: does not collide across a shifted path/content boundary", () => {
  const a = computeTestFingerprint({ "ab.test.ts": "cd" });
  const b = computeTestFingerprint({ "a.test.ts": "bcd" });
  assert.notEqual(a, b, "naive concatenation without a real separator would collide here");
});

test("findUndeclaredFiles: an exact declared file is not extra", () => {
  const extra = findUndeclaredFiles(["src/a.ts"], ["src/a.ts", "src/a.test.ts"]);
  assert.deepEqual(extra, []);
});

test("findUndeclaredFiles: a touched file outside files: is extra", () => {
  const extra = findUndeclaredFiles(["src/a.ts", "src/b.ts"], ["src/a.ts"]);
  assert.deepEqual(extra, ["src/b.ts"]);
});

test("findUndeclaredFiles: a /** glob owns everything under its prefix", () => {
  const extra = findUndeclaredFiles(
    ["src/auth/session.ts", "src/auth/nested/token.ts"],
    ["src/auth/**"],
  );
  assert.deepEqual(extra, []);
});

test("findUndeclaredFiles: a /** glob does not own a sibling directory", () => {
  const extra = findUndeclaredFiles(["src/db/queries.ts"], ["src/auth/**"]);
  assert.deepEqual(extra, ["src/db/queries.ts"]);
});

test("testFilesFrom: keeps only files that look like tests and are named in verify", () => {
  const files = ["src/a.ts", "src/a.test.ts", "src/b.test.ts"];
  const verify = "pnpm run gate && pnpm test -- src/a.test.ts";
  assert.deepEqual(testFilesFrom(files, verify), ["src/a.test.ts"]);
});
