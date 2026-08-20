## Why

Planificar y construir una feature o un MVP hoy es turn-by-turn: un humano promptea, revisa,
corrige y repite. Eso no escala en reloj (una sola cosa avanza a la vez) ni en tokens (el
contexto se acumula turno tras turno hasta que hay que compactar y se pierde el hilo).

spec-loop es un harness in-house que mueve la orquestación de prosa a código: **la sesión
interactiva planifica y se va; un runner ejecuta las tareas en paralelo, verifica
mecánicamente y no le pregunta nada a nadie hasta el reporte final.**

El diseño de partida es `spec-loop-v3.md` (v3.1). Este change lo construye con ocho
correcciones que salieron de auditarlo contra el canon de loop engineering, contra MAST y
contra su propia consistencia interna. Dos de esas correcciones son bugs que rompían la
tesis del documento.

## What Changes

### El principio que ordena todo

> El agente escribe código. El runner decide. Ningún agente reporta su propio estado.

Una tarea está lista cuando su comando `verify:` devuelve exit 0 **corrido por el runner**,
y `verify:` solo cuenta si falla cuando se le saca la implementación.

### Piezas nuevas

- **`bin/spec-loop.mjs`** — el runner. Un archivo, ~550 líneas, sin dependencias salvo `yaml`.
  Siete funciones puras (config, resolve, parse, preflight, waves, signature, derive) y tres
  con efectos (runTask, barrier, report). Dos verbos, cero argumentos, cero flags.
- **`agents/implementer.md`** — maker. Un intento, una tarea, sin auto-evaluación.
- **`agents/verifier.md`** — checker. Corre **una vez por ola**, pre-merge, sobre los N diffs
  juntos. Salida estructurada por `--json-schema`.
- **`skills/roadmap`, `skills/propose`, `skills/task-contract`** — la capa de planificación
  interactiva, donde viven las tres pausas humanas.
- **`test/`** — cinco archivos, sin mocks, sobre las funciones puras del runner.
- **`spec-loop.yaml`** — tres líneas de config por repo (`gate`, `test`, `max-spend`).

### Las ocho correcciones sobre v3.1

1. **Congelamiento del archivo de test por hash tras el intento 1.** v3.1 se contradice: §5.3
   regla 2 obliga a declarar los tests en `files:` (el scope check los permite) y §7.1 le
   prohíbe al implementer crearlos, mientras §1 asume que los escribe. Resultado: un loop de
   3 intentos que optimiza `exit 0` con permiso de escritura sobre su propia función de
   feedback. **BREAKING respecto de v3.1** — el implementer pierde esa regla de prompt y gana
   un `if` en el runner.
2. **El lint del test (4 greps) corre después de `verify:`, no en preflight.** En preflight el
   archivo de test todavía no existe.
3. **El runner commitea, no el implementer.** El red check restauraba con `git checkout` y
   dependía de que el modelo hubiera commiteado: un check determinista colgado de una
   instrucción probabilística.
4. **`base` se relee como HEAD de la rama del change al arrancar cada ola.** Implementado
   literal como en §6.2, la ola 2 no ve el código de la ola 1 y falla entera.
5. **El verifier corre por ola, no por tarea, y absorbe al `architect`.** Una ola de 5 pasa de
   6 spawns de verificación a 2, y la pregunta *"¿rompe algo que el gate no ve?"* solo se
   puede contestar viendo los N diffs juntos.
6. **Cero argumentos y cero flags.** Los 11 flags pasan a `spec-loop.yaml`; el change se
   resuelve por el orden de `roadmap.md`. `spec-loop plan` desaparece como verbo: es la
   invocación pelada.
7. **`gate` y `test` son configurables.** Saca ~20 menciones de npm del diseño; el harness
   deja de tener opinión sobre el runtime del proyecto.
8. **Dos reglas de prosa, cero código:** `verify:` no puede tomar un recurso global (puerto,
   DB, temp dir) porque N corren en paralelo; y una tarea existe solo si su `done` es un exit
   code determinista — performance, UI visual y third-party real son NFR de juicio y viven en
   `architecture.md`, no en `tasks.md`.

### Piezas de v3.1 que este change NO construye

`architect` (absorbido por el verifier de ola) · `--wave-size` · `budget:` por tarea ·
`ledger.md` · `<task>.verdict.json` · `spec-loop retry` · `spec-loop plan` como verbo ·
hooks · `notes.md` · `roadmap-brainstorm.md` como archivo aparte · un scheduler propio
(es una línea de cron, no una feature) · connectors MCP para notificar (es un exit code y un
archivo).

## Capabilities

### New Capabilities

- `task-contract`: la gramática de `tasks.md`, sus seis campos y las nueve reglas que
  `propose` no puede violar y que el preflight verifica antes de gastar un token.
- `wave-execution`: resolución del change sin argumentos, preflight, particionado en olas,
  worktree por tarea, el loop de intentos, el barrier y la propagación de bloqueos.
- `mechanical-verification`: las capas que deciden si una tarea está lista — `verify:` corrido
  por el runner, lint del test, red check, congelamiento del test, scope check, gate, verifier
  de ola y suite post-merge.
- `run-observability`: `events.jsonl` como única fuente de verdad, resume, `status`, el reporte
  ordenado por lo no verificado, los exit codes y el cortacircuitos de gasto.
- `planning-workflow`: los skills `roadmap` y `propose`, las tres pausas humanas, el triage de
  NFR, `architecture.md` creciendo por decisión forzada y la regla de frontera del harness.

### Modified Capabilities

Ninguna. El repo no tiene specs previos.

## Impact

- **Repo nuevo, greenfield.** No hay código que migrar.
- **Dependencias del runner:** Node ≥ 20 y `yaml`. Nada más.
- **Prerequisito documentado del repo que lo usa:** pnpm (store compartido + hardlinks), porque
  N worktrees × `node_modules` es inviable con npm.
- **Documento de entrada:** `spec-loop-v3.md` queda como referencia de diseño. Este change es
  la fuente de verdad a partir de ahora; donde difieran, gana el spec.
- **Bootstrap:** el paso 1 del orden de construcción (parse, preflight, waves, `spec-loop`
  pelado y sus tests) se escribe a mano. Del paso 2 en adelante, **spec-loop se construye a sí
  mismo**. Si no se puede escribir un `tasks.md` para el propio runner, el contrato de tarea
  está mal y conviene saberlo antes de apostarle un proyecto real.
