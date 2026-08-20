import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWaves } from "../bin/spec-loop.mjs";

function task(id, description, needs = []) {
  return { id, description, needs };
}

test("formatWaves: lists each wave with its tasks and needs", () => {
  const out = formatWaves("add-auth", [
    [task("1.1", "Crear el tipo de sesion")],
    [task("2.1", "Persistir la sesion", ["1.1"])],
  ]);
  assert.match(out, /Ola 1/);
  assert.match(out, /1\.1\s+Crear el tipo de sesion/);
  assert.match(out, /Ola 2/);
  assert.match(out, /2\.1\s+Persistir la sesion\s+\(needs: 1\.1\)/);
});

test("formatWaves: prints both verbs naming the resolved change", () => {
  const out = formatWaves("add-auth", [[task("1.1", "Algo")]]);
  assert.match(out, /spec-loop run\s+ejecuta add-auth/);
  assert.match(out, /spec-loop status\s+imprime el estado/);
});

test("formatWaves: a layer cut (one task per wave) is called out as a warning", () => {
  const out = formatWaves("add-auth", [
    [task("1.1", "Uno")],
    [task("1.2", "Dos")],
    [task("1.3", "Tres")],
  ]);
  assert.match(out, /corte por capa|capa/);
});

test("formatWaves: a single wave with one task is not flagged as a layer cut", () => {
  const out = formatWaves("add-auth", [[task("1.1", "Uno")]]);
  assert.doesNotMatch(out, /capa/);
});

test("formatWaves: a single wave with multiple tasks is not flagged as a layer cut", () => {
  const out = formatWaves("add-auth", [[task("1.1", "Uno"), task("1.2", "Dos")]]);
  assert.doesNotMatch(out, /capa/);
});
