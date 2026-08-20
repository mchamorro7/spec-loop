import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTasks } from "../bin/spec-loop.mjs";

test("parseTasks: a well-formed task parses with the id taken from the checkbox", () => {
  const md = `## 2. Sesion

- [ ] 2.1 Persistir la sesion en el storage

\`\`\`yaml
proves: "FR1 - un usuario recupera su sesion al reabrir la app"
files:
  - src/auth/session.ts
  - src/auth/session.test.ts
verify: "pnpm run gate && pnpm test -- src/auth/session.test.ts"
needs: ["1.1"]
red-check: auto
\`\`\`

Notas para el implementer, en prosa, opcionales.
`;
  const { tasks, errors } = parseTasks(md);
  assert.deepEqual(errors, []);
  assert.equal(tasks.length, 1);
  const t = tasks[0];
  assert.equal(t.id, "2.1");
  assert.equal(t.description, "Persistir la sesion en el storage");
  assert.equal(t.checked, false);
  assert.deepEqual(t.files, ["src/auth/session.ts", "src/auth/session.test.ts"]);
  assert.deepEqual(t.needs, ["1.1"]);
  assert.deepEqual(t.redCheck, { mode: "auto" });
  assert.equal(t.prose, "Notas para el implementer, en prosa, opcionales.");
});

test("parseTasks: needs and red-check default when absent", () => {
  const md = `- [x] 1.1 Algo

\`\`\`yaml
proves: "FR1"
files: ["a.ts"]
verify: "pnpm run gate"
\`\`\`
`;
  const { tasks, errors } = parseTasks(md);
  assert.deepEqual(errors, []);
  assert.equal(tasks[0].checked, true);
  assert.deepEqual(tasks[0].needs, []);
  assert.deepEqual(tasks[0].redCheck, { mode: "auto" });
});

test("parseTasks: red-check skip carries its reason", () => {
  const md = `- [ ] 1.1 Algo

\`\`\`yaml
proves: "FR1"
files: ["a.ts"]
verify: "pnpm run gate"
red-check: "skip: refactor, el comportamiento no cambia"
\`\`\`
`;
  const { tasks, errors } = parseTasks(md);
  assert.deepEqual(errors, []);
  assert.deepEqual(tasks[0].redCheck, {
    mode: "skip",
    reason: "refactor, el comportamiento no cambia",
  });
});

test("parseTasks: rejects an id declared inside the yaml block", () => {
  const md = `- [ ] 1.1 Algo

\`\`\`yaml
id: "1.1"
proves: "FR1"
files: ["a.ts"]
verify: "pnpm run gate"
\`\`\`
`;
  const { tasks, errors } = parseTasks(md);
  assert.equal(tasks.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /"id"/);
});

test("parseTasks: rejects an unknown field, naming it and the line", () => {
  const md = `- [ ] 1.1 Algo

\`\`\`yaml
proves: "FR1"
files: ["a.ts"]
verify: "pnpm run gate"
budget: 5
\`\`\`
`;
  const { errors } = parseTasks(md);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /budget/);
  assert.equal(errors[0].line, 3);
});

test("parseTasks: a checkbox without a yaml block is rejected with its line", () => {
  const md = `- [ ] 1.1 Algo sin bloque\n\nprosa suelta\n`;
  const { tasks, errors } = parseTasks(md);
  assert.equal(tasks.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
});

test("parseTasks: an unclosed yaml block is rejected", () => {
  const md = `- [ ] 1.1 Algo

\`\`\`yaml
proves: "FR1"
files: ["a.ts"]
verify: "pnpm run gate"
`;
  const { tasks, errors } = parseTasks(md);
  assert.equal(tasks.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no está cerrado/);
});

test("parseTasks: a duplicated yaml block for the same task is rejected", () => {
  const md = `- [ ] 1.1 Algo

\`\`\`yaml
proves: "FR1"
files: ["a.ts"]
verify: "pnpm run gate"
\`\`\`

\`\`\`yaml
proves: "FR2"
files: ["b.ts"]
verify: "pnpm run gate"
\`\`\`
`;
  const { tasks, errors } = parseTasks(md);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /más de un bloque yaml/);
  // The first block still parses as the task's contract.
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].proves, "FR1");
});

test("parseTasks: a required field missing is rejected", () => {
  const md = `- [ ] 1.1 Algo

\`\`\`yaml
files: ["a.ts"]
verify: "pnpm run gate"
\`\`\`
`;
  const { tasks, errors } = parseTasks(md);
  assert.equal(tasks.length, 0);
  assert.match(errors[0].message, /"proves"/);
});

test("parseTasks: an ## heading is not a wave declaration and does not break parsing", () => {
  const md = `## Ola sugerida 2

- [ ] 2.1 Algo

\`\`\`yaml
proves: "FR1"
files: ["a.ts"]
verify: "pnpm run gate"
\`\`\`

## 3. Otro grupo

- [ ] 3.1 Otra cosa

\`\`\`yaml
proves: "FR2"
files: ["b.ts"]
verify: "pnpm run gate"
\`\`\`
`;
  const { tasks, errors } = parseTasks(md);
  assert.deepEqual(errors, []);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, "2.1");
  assert.equal(tasks[1].id, "3.1");
});

test("parseTasks: prose stops at the next checkbox, not swallowing the next task", () => {
  const md = `- [ ] 1.1 Uno

\`\`\`yaml
proves: "FR1"
files: ["a.ts"]
verify: "pnpm run gate"
\`\`\`

prosa de la 1.1

- [ ] 1.2 Dos

\`\`\`yaml
proves: "FR2"
files: ["b.ts"]
verify: "pnpm run gate"
\`\`\`
`;
  const { tasks } = parseTasks(md);
  assert.equal(tasks[0].prose, "prosa de la 1.1");
  assert.equal(tasks[1].id, "1.2");
});

test("parseTasks: a tool that does not know spec-loop still sees valid OpenSpec checkboxes", () => {
  const md = `- [ ] 1.1 Uno

\`\`\`yaml
proves: "FR1"
files: ["a.ts"]
verify: "pnpm run gate"
\`\`\`
`;
  // The checkbox line itself is plain OpenSpec syntax regardless of what
  // follows it - this is the retro-compatibility guarantee from D14.
  assert.match(md, /^- \[ \] 1\.1 Uno$/m);
  const { errors } = parseTasks(md);
  assert.deepEqual(errors, []);
});
