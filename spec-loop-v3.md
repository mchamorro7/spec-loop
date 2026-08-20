# spec-loop — Diseño v3.1 · Build Spec

Documento único para construir el harness desde cero. Reemplaza a v2.0 y v3.0.
Todo lo que está acá es implementable tal cual: formatos exactos, algoritmos y
contenidos de prompt. Lo que no está acá, no va.

---

## 0. Qué cambia respecto de v2.0

Una sola decisión nueva, y todo lo demás sale de ella.

> **v2.0:** un agente orquestador lee un ledger, lanza olas, mergea y decide.
> **v3.0:** un script lanza olas, mergea y decide. Los agentes solo escriben código y refutan.

| | v2.0 | v3.0 |
|---|---|---|
| Orquestación | skill `implement` (prosa) | `spec-loop` (código, ~250 líneas) |
| Loop de reintentos | interno al implementer | del runner, por tarea, en paralelo |
| Estado del run | `ledger.md` escrito por el modelo | `events.jsonl` escrito por el runner; el estado se **deriva**, no se narra |
| ¿La tarea pasó? | lo reporta el implementer | **el runner re-corre `verify:`** |
| `files:` | declaración | declaración **+ check de `git diff`** |
| ¿El test prueba algo? | nadie chequea | **red check** determinista |
| Barrier ante fallo parcial | indefinido | política escrita, en código |
| Contexto por tarea | orquestador acumula | **fresh context por tarea**, por construcción |
| Hooks | `SubagentStop` → `run.jsonl` | **eliminados** — el runner ya observa los exits |
| `architect` | agente opcional | opt-in por flag `--architect` |

**Piezas: 14 archivos.** v2.0 tenía 15. La orquestación se movió de prosa a código y
dos archivos (`hooks/`) desaparecieron.

### 0.1 Qué saca la revisión 3.1

Pasada final de eficiencia y de anti-over-engineering. **Saca más de lo que pone.**

| Sacado | Por qué |
|---|---|
| `--wave-size` | Dos perillas para una cosa. La ola es lo que es disjunto y está listo; `-j` ya controla la máquina |
| `budget:` por tarea | Un campo menos en el contrato. `--max-turns` + timeout global alcanzan |
| `ledger.md` en disco | Era el checkpoint del orquestador-agente. Con runner de código, `spec-loop status` lo imprime desde `events.jsonl`. Un archivo menos que puede quedar viejo |
| `<task>.verdict.json` | Redundante: el veredicto es un evento |
| `spec-loop retry` | Es `run --retry`. Un comando menos |

| Puesto | Costo |
|---|---|
| **Preflight**: el gate tiene que estar verde en `base` antes de spawnear nada | 3 líneas. Evita que 6 tareas fallen por algo que ninguna causó |
| **`--max-spend <usd>`**: cortacircuitos global del change | 3 líneas. Es el presupuesto de tokens, hecho con el número que importa |
| **`--max-turns`** en cada spawn | 1 flag. Acota la exploración sin contabilidad |
| **`--strict-mcp-config`** en cada spawn | 1 flag. Saca los schemas de MCP del contexto sin perder la suscripción |
| **`--only` / `--skip`** + exit codes por tipo de fallo | 1 flag y una tabla. Es lo que hace usable el modo desatendido (§15) |
| **§5.4 reescrita**: de dónde sale un `verify:`, la pregunta que lo audita, 7 reglas y un recetario por forma de tarea | 0 código. Es la sección que decide si un run desatendido sirve |
| **Truncar el stderr** que se reinyecta en el reintento | 2 líneas. Era un bug de contexto |
| **Regla de archivos compartidos** (barrels, `package.json`, rutas) → ola 0 | 1 línea en `task-contract`, 0 código |
| **Los supuestos se resuelven antes de `tasks.md`** | 1 regla en `propose`, 0 código |
| **`architecture.md` arranca vacío**; cada decisión entra cuando una feature la fuerza | 0 código. Es el arreglo de "no asumir nada" |

---

## 1. La tesis, en dos líneas

> **Una tarea está lista cuando su comando `verify:` devuelve exit 0 — corrido por el runner, no por quien la implementó.**
> **Y `verify:` solo cuenta si falla cuando se le saca la implementación.**

La primera línea es v2.0. La segunda es el arreglo del único hueco que rompía la tesis:
si el implementer escribe el código *y* el test, exit 0 dejaba de probar "está listo" y
pasaba a probar "escribió un test que su código pasa". El **red check** lo convierte de
nuevo en una prueba, sin TDD, sin mutation testing y sin juicio de modelo.

El principio operativo que ordena todo el diseño:

```
   El agente escribe código.
   El runner decide.
   Ningún agente reporta su propio estado.
```

---

## 2. La decisión de arquitectura

### 2.1 El reparto

| | Corre como | Por qué |
|---|---|---|
| **Planificar** (`roadmap`, `propose`) | Sesión interactiva de Claude Code + skills | Es donde viven las 2 pausas humanas y donde el juicio es el trabajo |
| **Ejecutar** (`spec-loop run`) | Script Node + `claude -p` por tarea | Es donde el juicio es el enemigo. Todo lo decidible por exit code lo decide código |

La frontera es limpia: **la sesión interactiva produce `tasks.md` y se va. El runner consume
`tasks.md` y no le pregunta nada a nadie hasta el reporte final.**

### 2.2 Por qué el runner y no un agente orquestador

Es la única pieza nueva de v3, así que le aplico el test del documento: **¿qué se rompe si
la saco?** Si vuelvo a orquestar con un skill:

| Vuelve a ser probabilístico | Consecuencia |
|---|---|
| Particionado en olas | Es disjunción de conjuntos sobre 15 tareas. Los modelos la hacen mal y el error es silencioso |
| Política del barrier ante fallo parcial | FM-1.5 (*unaware of stopping conditions*), 12.4% de fallos medidos |
| Check de `files:` | El paralelismo vuelve a descansar en buena voluntad |
| Red check | El hueco #1 vuelve a estar abierto |
| Ledger | Lo escribe el mismo modelo que puede perder el hilo por compactación |
| Presupuesto por tarea | Sin enforcement |
| Concurrencia según la máquina | Sin control: 8 `tsc` simultáneos en una notebook |

Siete cosas. **El costo honesto son ~250 líneas de JS sin dependencias externas salvo
`yaml`.** No es un framework, no es una capa: es el archivo donde vive el `if`.

Y esto no contradice el cementerio de v2.0, lo completa. Ahí el fan-out en shell se
descartó por dos razones concretas: *"sin `isolation: worktree` ni retorno de resultados"*.
Las dos se caen:

- **Aislamiento:** `git worktree add` son tres líneas.
- **Retorno de resultados:** `claude -p --output-format json --json-schema '<esquema>'`
  devuelve un objeto validado. El veredicto del verifier deja de ser prosa a parsear.

### 2.3 Lo que esto simplifica (no solo endurece)

El prompt del `implementer` se achica mucho. En v2.0 tenía que: implementar, correr
`verify:`, evaluar el resultado, comparar la firma de error con el intento anterior,
decidir si reintentar, y auto-declararse `done`/`stuck`/`blocked`. En v3.0 hace **una
cosa**: implementar un intento. El loop, la comparación de firmas y la decisión son del
runner.

Menos prosa por prompt × N spawns es exactamente la restricción de contexto que v2.0 §7
identificaba como la más dura del diseño.

---

## 3. Veredicto sobre Ralph

[snarktank/ralph](https://github.com/snarktank/ralph) y la técnica original de
[ghuntley](https://ghuntley.com/ralph/). **Sirve, y sirve para cinco cosas concretas.**
Ninguna es una dependencia: son decisiones de diseño validadas por algo que ya corre.

### 3.1 Lo que tomamos

| De Ralph | Qué valida / aporta a spec-loop |
|---|---|
| **El loop externo es un script, no un agente.** `while :; do cat PROMPT.md \| claude -p; done` | Es exactamente §2.2. Ralph lo tiene en producción. Confirma que el orquestador-como-código funciona y que el estado en disco alcanza |
| **Fresh context por iteración; lo único que persiste es git + un archivo de estado** | Valida el diseño de `events.jsonl` + ramas de git como fuente de verdad, y mata el ledger escrito por el modelo |
| **"Only 1 subagent for build/tests"** — cuello de botella serializado a propósito | Confirmación independiente del límite de máquina: la suite del barrier corre **siempre con concurrencia 1**, y el gate por tarea va acotado por `-j` |
| **"El filtrado semántico en runtime falla el 70-80% de las veces; el scoping determinista se hace al crear el plan"** | Es el argumento directo de por qué `files:` y `verify:` los escribe `propose` y no el implementer |
| **Guardrails de prompt probados**: *"no asumas que no está implementado"* (falsos negativos de ripgrep) y *"implementá completo, nada de placeholders ni stubs"* | Dos líneas gratis en `implementer.md`. Son failure modes medidos, no hipótesis |

Y uno más, de filosofía: **el plan es descartable**. Ralph regenera el plan cuando se
desvía en vez de arreglarlo tarea por tarea. Eso es mejor respuesta para `needs-scope` que
"un humano destraba cada tarea": si dos o más tareas salen con `needs-scope`, el problema
es el plan → volvés a `propose`, no a parchear `tasks.md`.

### 3.2 Lo que NO tomamos

| De Ralph | Por qué no |
|---|---|
| `while :;` infinito con *eventual consistency* | spec-loop tiene condición de corte por tarea. Un loop sin corte por unidad de trabajo es la definición de FM-1.5 |
| *"Let Ralph Ralph"* / *"deterministically bad in an undeterministic world"*, tuneado por observación | Choca de frente con la tesis de contratos. Ralph acepta la varianza y la corrige con guardrails reactivos; spec-loop la elimina donde puede |
| `prd.json` con `passes: true` escrito por el agente | **Es exactamente el ledger-escrito-por-el-modelo que estamos matando.** El runner re-corre `verify:`; el agente no vota |
| El LLM elige la próxima tarea por juicio | spec-loop calcula olas por disjunción de `files:`. Determinista, y además es lo que habilita el paralelismo real |
| 250-500 subagentes de exploración | Absurdo para este tamaño. `Explore` built-in cuando haga falta |
| `specs/` plano, sin delta ni archive | OpenSpec (delta ADDED/MODIFIED/REMOVED + archive) es estrictamente mejor en brownfield |
| Prompts con "DO IT OR I WILL YELL AT YOU" y numeración 999+ | Es tuning por observación sobre un sistema sin gates. Con gates mecánicos no hace falta |

### 3.3 Veredicto en una línea

**Ralph aporta la topología del loop externo, no el modelo de planificación.** Tomamos su
esqueleto (script + fresh context + estado en disco + backpressure serializada) y lo
llenamos con contratos en vez de con juicio. Es la mitad que a v2.0 le faltaba y la mitad
que a Ralph le sobra en varianza.

**No instalamos Ralph.** No hay nada que importar: son ~40 líneas de bash y una filosofía.

---

## 4. Scaffolding

### 4.1 El plugin — 14 archivos

```
spec-loop/
├── .claude-plugin/
│   └── plugin.json                 manifiesto
├── README.md
│
├── bin/
│   └── spec-loop.mjs               ⭐ EL RUNNER. Toda la orquestación
│
├── agents/
│   ├── implementer.md              1 intento, 1 tarea, sin auto-reporte
│   ├── verifier.md                 refuta, salida JSON con schema
│   └── architect.md                opt-in, corre en el barrier
│
├── skills/
│   ├── roadmap/SKILL.md            /spec-loop:roadmap    iniciativa → changes
│   ├── propose/SKILL.md            /spec-loop:propose    change → spec delta + tasks.md
│   └── task-contract/SKILL.md      conocimiento: la gramática de tasks.md
│
├── templates/
│   ├── CLAUDE.md                   esqueleto del contrato del repo (<100 líneas)
│   ├── settings.json               permisos + modelo
│   └── architecture.md             esqueleto de capas
│
├── package.json                    bin: spec-loop → bin/spec-loop.mjs; dep: yaml
└── marketplace.json.example
```

**No hay `skills/implement/`.** Esa era la pieza con más prosa de v2.0 y ahora es
`bin/spec-loop.mjs`. **No hay `hooks/`**: el runner observa los exits directamente.

### 4.2 Tu repo, después del setup

```
mi-proyecto/
├── CLAUDE.md                       ← template. Bajo 100 líneas
├── .claude/settings.json           ← template
│
├── openspec/
│   ├── project.md                  openspec init
│   ├── architecture.md             ← arranca VACÍO. Crece por decisión forzada
│   ├── roadmap.md                  ← /spec-loop:roadmap · una línea por change
│   ├── roadmap-brainstorm.md       ← /spec-loop:roadmap · FR/NFR/supuestos + LO RECORTADO
│   ├── specs/                      la doc viva
│   ├── changes/<change-id>/
│   │   ├── brainstorm.md
│   │   ├── proposal.md
│   │   ├── design.md               solo si hay decisión no obvia
│   │   ├── specs/<cap>/spec.md     el delta
│   │   └── tasks.md                ← EL INPUT DEL RUNNER
│   └── archive/
│
├── package.json                    → scripts.gate  ·  scripts.test
├── eslint.config.js                → donde viven las reglas de arquitectura
│
└── .spec-loop/                     gitignored
    ├── wt/                         worktrees efímeros
    └── <change-id>/
        ├── events.jsonl            ⭐ append-only, lo escribe SOLO el runner. Única fuente de verdad
        └── notes.md                opcional: la nota humana que habilita `run --retry`
```

**Novedad sobre v2.0:** `roadmap-brainstorm.md`. En v2.0 los FR/NFR de nivel iniciativa se
producían y se tiraban, porque el único artefacto era `roadmap.md` (*"una línea por
change"*). Un NFR mecánico detectado en el change #1 no tenía dónde vivir hasta el change
que lo implementara, y lo recortado no dejaba rastro. Un archivo, cero costo en runtime
(solo lo lee `roadmap`).

---

## 5. El contrato de tarea

Es la keystone del harness. Si esto está mal escrito, nada de lo demás funciona.

### 5.1 Gramática exacta

`tasks.md` es markdown legible; cada tarea es un `###` seguido de **un bloque fenced
`yaml`**. Una sola fuente de verdad, legible por humanos y parseable sin regex frágil.

````markdown
## Ola sugerida 2 — sesión

### 2.1 · Persistir la sesión en el storage

```yaml
id: "2.1"
proves: "FR1 · un usuario recupera su sesión al reabrir la app"
files:
  - src/auth/session.ts
  - src/auth/session.test.ts
verify: "npm run gate && npm test -- src/auth/session.test.ts"
needs: ["1.1"]
red-check: auto
```

Notas para el implementer, en prosa, opcionales. El runner las pasa tal cual.
````

### 5.2 Campos

| Campo | Req | Tipo | Regla |
|---|---|---|---|
| `id` | sí | string | único en el change. Ordena olas y desempates |
| `proves` | sí | string | **el requisito del spec delta que esta tarea demuestra.** Es lo que lee el verifier para decidir si el diff hizo lo que había que hacer, no lo que se le ocurrió |
| `files` | sí | lista | rutas exactas, o **una** ruta terminada en `/**` que la tarea posee entera. Incluye los archivos de test |
| `verify` | sí | string | comando de shell. **Siempre empieza con `npm run gate &&`** |
| `needs` | no | lista de ids | default `[]`. Define el orden entre olas |
| `red-check` | no | `auto` \| `skip: <razón>` | default `auto`. `skip` **exige razón escrita** |

**Seis campos, cinco obligatorios.** Todo lo que no está acá se decide en el runner con un
flag global. Un campo por tarea es un campo que `propose` tiene que pensar 15 veces.

### 5.3 Las siete reglas que `propose` no puede violar

1. **`verify` arranca con `npm run gate &&`.** El gate es donde crecen las reglas; si cada
   `verify` repite `tsc && eslint`, no hay un lugar donde crezcan.
2. **Todo archivo que la tarea escribe está en `files:`** — incluidos los de test. Si no
   está declarado, el scope check lo rechaza.
3. **Los archivos de test de la tarea aparecen nombrados dentro de `verify:`.** Así el red
   check sabe cuáles preservar y cuáles revertir. Un test que no se nombra en `verify:` no
   existe para el harness.
4. **Ola 0 de contratos.** Si dos tareas de la misma ola nombran un símbolo que todavía no
   existe (un tipo, una interfaz, un schema, una firma), ese símbolo es una **tarea propia,
   serial, previa a todas**. Es el mitigante directo del fallo que describe Cognition: dos
   agentes aislados definiendo la misma abstracción distinto, y un merge que nadie puede
   reconciliar. Sin esto, `files:` disjunto no alcanza.
5. **`red-check: skip` solo para tareas sin comportamiento en runtime** (una regla de lint,
   un archivo de config, docs) y **con la razón escrita**. Saltear en silencio es el
   agujero por donde vuelve el problema.
6. **Los archivos compartidos no se editan en paralelo.** Barrels e `index.ts`, tablas de
   rutas, contenedores de DI, `package.json` y el lockfile los toca **una sola tarea de la
   ola 0**, nunca una tarea de una ola paralela. Es el caso real más frecuente de
   contención: dos tareas en archivos distintos que igual necesitan registrarse en el mismo
   lugar. **Corolario: las dependencias nuevas se instalan en la ola 0**, jamás a mitad de
   ola — el lockfile es el archivo más compartido de cualquier repo Node.
7. **≤15 tareas por change.** Si el alcance da más, `propose` para y manda a `roadmap`.

**Sobre declarar `files:`:** declará lo que razonablemente vas a tocar. Declarar de más
solo cuesta paralelismo (la tarea comparte ola con menos gente); declarar de menos cuesta
la tarea entera (`out-of-scope`, no se mergea). La asimetría es enorme, así que ante la
duda, declarás.

### 5.4 Cómo se configura un `verify:`

**Esta es la sección que decide si un run desatendido sirve o no.** La calidad de lo que
volvés a encontrar a la mañana es exactamente la calidad de estos comandos. Todo lo demás
del harness es maquinaria alrededor de esta línea.

#### 5.4.1 Anatomía

```
verify: npm run gate && <la prueba de ESTA tarea>
        └── invariante ──┘  └────── lo único que escribís ──────┘
```

La primera mitad no se piensa: es igual para todas las tareas y **mejora sola con el
tiempo**. Cada NFR mecánico que aparece en un brainstorm se convierte en una regla de
eslint, entra al gate, y desde ese momento la corre cada `verify:` de cada tarea futura,
gratis. Es el trinquete de §6.5 visto desde el otro lado: **tus `verify:` viejos se vuelven
más estrictos sin que los toques.**

La segunda mitad es el trabajo.

#### 5.4.2 De dónde sale, mecánicamente

No se inventa. Se deriva:

```
spec delta   "dado un usuario con sesión expirada, cuando reabre la app,
              entonces se le renueva el token sin pedirle login"
    ↓
proves:      "FR2 · la sesión se renueva sola al reabrir"
    ↓
el test      expone exactamente ese dado / cuando / entonces
    ↓
verify:      npm run gate && npm test -- src/auth/refresh.test.ts
```

**La regla:** si no podés escribir el test a partir de `proves:` sin inventar detalles,
entonces `proves:` todavía no es observable — y eso es un bug del spec delta, no del
implementer. Volvé a la fase 2 de `propose`. Es la señal temprana más barata que tiene el
harness y aparece antes de gastar un token.

#### 5.4.3 La pregunta que audita cualquier `verify:`

Una sola, y `propose` la tiene que poder contestar por cada tarea:

> **¿Cuál es la implementación mínima e incorrecta que pasaría este `verify:`?**

- Si la respuesta es *"un stub que devuelve un objeto vacío"* → el `verify:` es malo.
- Si la respuesta es *"ninguna: para pasar hay que implementar el comportamiento"* → sirve.

Es la misma pregunta que se hace el verifier en su punto (b), pero hecha en planning, que
es donde cuesta cero arreglarla.

#### 5.4.4 Siete reglas operativas

1. **Nombrá el archivo de test en el comando.** `npm test -- src/auth/refresh.test.ts`,
   nunca `npm test` a secas. Dos razones: el red check necesita saber qué archivos preservar
   al revertir, y correr la suite entera en cada intento de cada tarea multiplica el
   wall-clock por N.
2. **Un archivo de test por tarea.** Si necesitás dos, casi siempre son dos tareas.
3. **Determinista.** Sin red real, sin reloj, sin random, sin depender del orden de los
   tests, sin fechas. **Un `verify:` flaky dentro de un loop de 3 intentos es un generador
   aleatorio de `stuck`** — y de noche, un generador aleatorio de gasto.
4. **Rápido.** Corre en cada intento × cada tarea. Diez tareas a dos intentos promedio con
   un verify de 2 minutos son 40 minutos solo de verificación.
5. **Mockeá los bordes, nunca el módulo bajo prueba.** Red, reloj, filesystem: sí. Lo que
   estás probando: jamás. Es el olor que el red check **no** caza.
6. **El assert no reimplementa el código.** Si el test calcula lo mismo que la
   implementación, es una tautología que pasa siempre. Asertá contra un valor literal.
7. **Nada de snapshots ni golden files como prueba principal.** Un snapshot se regenera con
   un flag, y un agente trabado va a intentar regenerarlo. Si usás snapshots, el
   implementer tiene prohibido `-u` / `--update-snapshot` (está en su lista de *does NOT
   own*), pero la mejor defensa es no apoyar el `verify:` en uno.

#### 5.4.5 Recetario por forma de tarea

| Forma de la tarea | `verify:` |
|---|---|
| Función o módulo con comportamiento *(el ~80% de los casos)* | `npm run gate && npm test -- src/x/y.test.ts` |
| Tipo · interfaz · schema **(ola 0)** | `npm run gate && npm test -- src/x/y.types.test.ts` (type-test: `expectTypeOf`, `tsd`). El red check funciona igual: sin el tipo, no compila |
| Endpoint o handler | `npm run gate && npm test -- src/api/x.test.ts` — integración chica, sin red real |
| Componente de UI | `npm run gate && npm test -- src/ui/X.test.tsx` — testing-library, comportamiento observable, **no** snapshot |
| Regla de arquitectura / lint nueva | `npm run gate && npm test -- eslint-rules/x.test.ts` con un fixture que la viola y debe fallar. **Una regla SÍ se puede probar** — no es candidata a `red-check: skip` |
| NFR mecánico ("el token nunca se persiste en claro") | la regla de eslint entra al gate **y** un test que lo demuestra en runtime |
| Migración de datos | `npm run gate && npm test -- migrations/x.test.ts` contra una DB efímera |
| **Refactor puro** (sin cambio de comportamiento) | `npm run gate && npm test` — los tests existentes SON la prueba. **Es el único caso legítimo de `red-check: skip`**, con razón escrita: *"refactor, el comportamiento no cambia"* |
| Config · docs · scaffolding | `npm run gate` + `red-check: skip: <razón>` |

#### 5.4.6 Los olores, y quién los caza

| Olor | Ejemplo | Quién lo caza |
|---|---|---|
| No asegura nada | `expect(fn()).toBeDefined()` | **El red check**, mecánicamente |
| Es el gate y nada más | `verify: npm run gate` sin `skip` | **El red check**, mecánicamente |
| Testea el mock | el test mockea el módulo bajo prueba | Solo la pregunta (b) del verifier ⚠️ |
| Reimplementa el requisito en el assert | el test calcula lo mismo que el código | Solo la pregunta (b) ⚠️ |
| Prueba que corre, no que cumple | el `verify:` corre el build | Solo la pregunta (b) ⚠️ |
| Snapshot regenerable | `toMatchSnapshot()` | Nadie. **Por eso la regla 7** |

Las tres filas con ⚠️ son **la única superficie probabilística que queda en todo el
harness**. Todo lo demás es un exit code. Por eso la pregunta de §5.4.3 se hace en
planning: es el momento en que arreglarla cuesta una línea en vez de un run entero.

---

## 6. El runner

`bin/spec-loop.mjs`. Node, sin build, una dependencia (`yaml`). Todo lo que sigue es
implementable tal cual.

### 6.1 CLI

**Tres comandos.**

```bash
spec-loop plan   <change-id>            # imprime las olas y sale. Cuesta 0 tokens
spec-loop run    <change-id> [flags]    # ejecuta. Retoma solo si se cortó
spec-loop status <change-id>            # imprime el estado desde events.jsonl
```

| Flag | Default | Qué hace |
|---|---|---|
| `-j, --jobs <n>` | `min(3, cpus-1)` | tareas concurrentes. **La suite del barrier siempre corre con 1** |
| `--max-attempts <n>` | `3` | **spawns de implementer por tarea, en total** (no por pasada de verifier) |
| `--max-turns <n>` | `30` impl · `10` verif | turnos agénticos por spawn. Al tope, `claude` sale con error y el runner lo ve |
| `--timeout <dur>` | `20m` | wall-clock de cualquier subproceso: el spawn, `verify:`, la suite |
| `--max-spend <usd>` | `20` | **cortacircuitos del change entero.** Ver 11.2 |
| `--model <m>` | `sonnet` | modelo del implementer |
| `--verifier-model <m>` | = `--model` | ver 6.6 |
| `--architect` | off | corre el architect en cada barrier |
| `--retry` | off | resetea los estados rojos y reintenta. Exige un delta, ver 6.8 |
| `--only <ids>` | todas | corre solo esas tareas (y sus `needs:`). Ver §15.2 |
| `--skip <ids>` | ninguna | corre todo menos esas |

No hay `--wave-size`. La ola es lo que está disjunto y listo; `-j` ya controla la carga de
la máquina. Dos perillas para el mismo problema era una de más.

### 6.1.1 Preflight — antes de spawnear nada

```
1. npm run gate  en <base>          exit != 0 → ABORTA: "el gate está rojo antes de empezar"
2. parsear tasks.md                 falla la gramática → ABORTA, con la línea
3. validar las 7 reglas de §5.3     falla → ABORTA, y decís cuál
4. particionar en olas              ola vacía → ABORTA: ciclo en needs:
5. git worktree list                worktrees viejos del change → limpiar
```

Es lo más barato que hay y evita el modo de fallo más caro: **seis tareas fallando por algo
que ninguna causó.** Sin esto, un gate roto en `base` gasta 6 tareas × 3 intentos antes de
que alguien se entere.

### 6.2 El pipeline de una tarea

Corre para las N tareas de la ola **en paralelo, sin coordinación**. Ninguna espera a otra.
El loop de reintentos vive acá, en código, no en el agente.

```
worktree = git worktree add -b spec-loop/<change>/<id> .spec-loop/wt/<id> <base>

for attempt in 1..max-attempts:          ← el tope es TOTAL, cruza las pasadas de verifier
    ├─ claude -p  (implementer)  ── --max-turns 30, timeout
    │     entrada: bloque yaml + prosa + (si attempt>1) el stderr del intento anterior, TRUNCADO
    │
    ├─ el RUNNER corre `verify:` en el worktree        ←── la única fuente de verdad
    │     exit 0      → sale del loop
    │     exit != 0   → firma = normalizar(stderr)
    │                   firma == firma del intento anterior  → status: stuck, sale
    │                   attempt == max-attempts              → status: blocked, sale
    │
    └─ siguiente intento

si verify pasó:
    ├─ RED CHECK      (6.3.1)  falla → status: red-check-failed
    ├─ SCOPE CHECK    (6.3.2)  falla → status: out-of-scope
    └─ claude -p  (verifier, --json-schema)
          refuted:false → status: verified   ✅ candidata a merge
          refuted:true  → UNA re-implementación con el motivo, y vuelve a esta línea
                          techo duro: 2 pasadas de verifier, y siempre dentro
                          de max-attempts. Peor caso por tarea: 3 implementers + 2 verifiers
```

**El peor caso de una tarea es 5 spawns, no 8.** En v3.0 el tope de intentos era por pasada,
así que dos pasadas de verifier daban hasta 6 implementers. Ahora `--max-attempts` es el
total y la aritmética es visible de antemano: `3 × costo(implementer) + 2 × costo(verifier)`.

**Tres cosas que hay que ver acá:**

1. **El implementer nunca declara que terminó.** El runner re-corre `verify:`. FM-2.6
   (*reasoning-action mismatch*, 13.2% de fallos medidos) deja de existir por construcción.
2. **El loop sigue siendo paralelo.** Moverlo al runner no lo serializa: son N pipelines
   concurrentes con un pool de tamaño `-j`.
3. **Cada `claude -p` es contexto fresco.** No hay acumulación entre intentos salvo lo que
   el runner inyecta a propósito. Es la parte de Ralph que importa.

**Truncar lo que se reinyecta.** El stderr de `tsc && eslint && jest` puede ser de miles de
líneas, y meterlo crudo en el prompt del reintento es exactamente el *context overflow* que
Ralph nombra como failure mode. **Regla: primer bloque de error + últimas 20 líneas, tope
4 KB.** El resto queda en `events.jsonl` si lo querés leer vos. Dos líneas de código; sin
esto, el intento 3 arranca con el contexto ya envenenado.

**Normalizar la firma de error** (para el detector de `stuck`): tomar la primera línea de
stderr que matchee `/error|Error|✕|FAIL/`, borrar números de línea/columna y rutas
absolutas, y hashear. Dos firmas iguales seguidas no son iteración, son reintento.

### 6.3 Los tres checks mecánicos

#### 6.3.1 Red check — *el test tiene que fallar sin la implementación*

Es el arreglo del único hueco que rompía la tesis. Corre **dentro del worktree aislado**,
así que no puede tocar nada tuyo.

```
impl_files = files:  MENOS  los archivos nombrados dentro de verify:

para cada f en impl_files:
    existe en <base>?  → git checkout <base> -- f
    no existe?         → rm -f f

correr verify:
    exit != 0  → OK. El test prueba algo. Restaurar y seguir
    exit 0     → REFUTED (red-check-failed). El test pasa sin la implementación

restaurar: git checkout <task-branch> -- .
```

Cuatro líneas de lógica. Es mutation testing reducido a su forma más barata: en vez de
mutar cada línea, **sacás la implementación entera y exigís que el gate se dé cuenta.**
Convierte FM-3.3 (*incorrect verification*, 9.1%) de juicio a exit code.

Y hace innecesario lo caro: no necesitás Stryker, ni TDD obligatorio, ni partir cada tarea
en "escribí el test" + "hacelo pasar". Obtenés la garantía de TDD (el test estuvo rojo)
sin su proceso.

#### 6.3.2 Scope check — *tocaste solo lo que declaraste*

```
git diff --name-only <base>..<task-branch>   ⊆   files:
    sí → seguir
    no → status: out-of-scope. NO se mergea. Va al reporte con la lista de archivos de más
```

Tres líneas. Todo el argumento de seguridad del paralelismo descansaba en que las olas
tienen `files:` disjuntos, y hasta acá nada lo verificaba. Cierra FM-2.3 (*task
derailment*, 7.4%).

#### 6.3.3 Gate — *el proyecto sigue en pie*

`npm run gate` = `tsc && eslint && depcruise`. Vive en `package.json`, corre dentro de cada
`verify:`, y es donde crecen las reglas de arquitectura. Es de v2.0 y no cambia.

> **Regla de los tres tiers, sin cambios respecto de v2.0:** toda restricción expresable
> como regla de linter se expresa como regla de linter. La prosa queda solo para lo que
> ninguna herramienta puede chequear. Escribir *"no importes de `src/db/` desde
> componentes"* en `CLAUDE.md` es tier 1 disfrazado de tier 3, y lo pagás en cada spawn,
> de forma probabilística, cuando un plugin de eslint lo verifica gratis.

### 6.4 Particionado en olas

Greedy, estable, determinista. ~20 líneas.

```
restantes = tareas en orden de id
olas = []
mientras restantes:
    ola = [];  tomados = ∅
    para t en restantes (en orden):
        si t.needs ⊄ ids_ya_en_olas_anteriores:  continuar
        si t.files ∩ tomados ≠ ∅:                continuar
        ola += t;  tomados ∪= t.files
    si ola vacía → ERROR: ciclo en needs: o contención total. Vuelve a propose
    olas += ola;  restantes -= ola
```

`spec-loop plan <change-id>` imprime esto y sale. Es el chequeo barato de si `propose`
cortó bien: **si te da una ola de 1 tarea repetida seis veces, cortaste por capa y no por
feature vertical**, y eso lo ves antes de gastar un token.

**El costo del barrier, dicho de frente.** Si una ola tiene 6 tareas y una tarda 10× más
que el resto, 5 workers quedan ociosos esperando el merge. Es real y es el precio de tener
un árbol estable para mergear y correr la suite. La solución —arrancar tareas de la ola
siguiente cuyas `needs:` ya están satisfechas y cuyos `files:` no chocan con lo que está en
vuelo— es re-particionado dinámico, y **no vale la complejidad**: agrega estado mutable al
único lugar del harness que hoy es una función pura. Se mide primero (§11.3) y se decide
después, si acaso.

### 6.5 El barrier y la política ante fallo parcial

Esto era lo que v2.0 no definía: *ola de 8, cierran 6, una `stuck` y una `blocked`, ¿qué
hace el barrier?* Sin regla escrita, el orquestador improvisa, y eso es FM-1.5 (12.4%).

```
1. MERGE — por cada tarea de la ola, en orden de id:
     status == verified  → git merge --no-ff <task-branch>  en la rama del change
     cualquier otro      → no se mergea. Se registra y sigue
     conflicto de merge  → el change PARA. status: merge-conflict. Reporte

2. SUITE — en la rama del change, concurrencia 1:
     verde → seguir
     rojo  → el change PARA. status: integration-failed. Reporte.
             NO se auto-revierte nada: hay interacción entre tareas que los verify:
             individuales no podían ver, y eso lo mira un humano

3. [--architect] — sobre el diff acumulado de la ola. Salida: {clean} o {rule}

4. PROPAGAR BLOQUEO — toda tarea restante cuya clausura de needs: toque una tarea roja
     pasa a status: blocked-by-dep

5. RECALCULAR — se rehacen las olas restantes excluyendo blocked-by-dep

6. Siguiente ola
```

**La regla que importa:** el run **nunca le pregunta nada a un humano en vuelo**. Termina y
entrega un reporte. Las únicas dos cosas que paran el change entero son un conflicto de
merge y una suite roja post-merge — las dos son estados donde seguir corrompe silenciosamente.

**Un conflicto de merge acá es un bug del harness, no del código.** Si las olas son
disjuntas y el scope check pasó, dos ramas de la misma ola no pueden haber tocado el mismo
archivo, así que un conflicto textual es imposible. Si aparece, la causa está en el
particionado o en el scope check, y es lo primero que hay que mirar. Convertir esa rama en
un diagnóstico en vez de en un susto vale la línea.

**El trinquete** (de v2.0, intacto): cuando el architect encuentra algo expresable como
regla de lint, la escribe. Esa violación queda atrapada mecánicamente para siempre y nunca
más necesita un agente. El costo de review baja con el tiempo en vez de quedarse constante.

### 6.6 Los agentes que el runner invoca

```bash
# implementer
claude -p "$(cat prompt-de-la-tarea)" \
  --append-system-prompt-file agents/implementer.md \
  --model "$MODEL" \
  --max-turns 30 \
  --strict-mcp-config \
  --permission-mode acceptEdits \
  --allowedTools "Bash(npm *),Bash(npx *),Bash(git *),Read,Edit,Write,Glob,Grep" \
  --output-format json

# verifier — el diff entra por stdin, no lo va a buscar
git diff "$BASE".."$BRANCH" | claude -p "$(cat prompt-de-verificacion)" \
  --append-system-prompt-file agents/verifier.md \
  --model "$VERIFIER_MODEL" \
  --max-turns 10 \
  --strict-mcp-config \
  --allowedTools "Read,Glob,Grep" \
  --output-format json \
  --json-schema '{"type":"object","properties":{
      "refuted":{"type":"boolean"},
      "reason":{"type":"string"},
      "evidence":{"type":"string"}},
    "required":["refuted","reason","evidence"]}'
```

`--json-schema` es la pieza que hace que el veredicto del verifier sea un dato y no un
texto a interpretar. El runner lee `.structured_output.refuted` y ya. Sin parseo, sin
heurística, sin "el modelo dijo que estaba bien".

**Tres decisiones de eficiencia, una línea cada una:**

- **`--strict-mcp-config`** apaga la carga de servidores MCP. Los schemas de tools de MCP
  son de lo más caro que entra a un contexto y un implementer no usa ninguno. **Sin perder
  el login de suscripción**, que es lo que sí perdés con `--bare`.
- **`--max-turns`** acota la exploración por spawn sin contabilidad de tokens. Al tope,
  `claude` sale con error: el runner lo trata como intento fallido y sigue.
- **El diff entra por stdin.** El verifier no necesita `Bash(git diff *)`: se lo damos
  hecho. Ahorra un round-trip de tool, lo deja read-only de verdad, y le saca la
  posibilidad de irse a explorar el repo.

**Sobre `--verifier-model`.** La evidencia dice que el *verifier gain* cae cuando solver y
verifier son de la misma familia: los modelos aceptan soluciones que se parecen a su propio
razonamiento. El flag existe por eso y cuesta una línea. **Pero es opcional a propósito:**
en v3 la parte fuerte de la verificación (red check + scope check + re-correr `verify:`) ya
es determinista, así que al modelo le queda solo la pregunta de juicio. La diversidad de
modelo pasa de mitigante crítico a mejora marginal. Si querés simpleza, dejalo apagado.

### 6.7 Estado, eventos y resume

**`events.jsonl` es la fuente de verdad y lo escribe únicamente el runner.** No hay hooks:
el runner es el proceso que observa los exits, así que un hook sería una copia peor.

```json
{"ts":"2026-08-18T14:02:11Z","task":"2.1","event":"attempt_start","attempt":1}
{"ts":"...","task":"2.1","event":"verify","attempt":1,"exit":1,"sig":"a3f1c9"}
{"ts":"...","task":"2.1","event":"verify","attempt":2,"exit":0}
{"ts":"...","task":"2.1","event":"red_check","exit":1,"ok":true}
{"ts":"...","task":"2.1","event":"scope_check","ok":true}
{"ts":"...","task":"2.1","event":"verdict","refuted":false}
{"ts":"...","task":"2.1","event":"closed","status":"verified","cost_usd":0.41,"wall_s":186}
```

- **Resume:** `spec-loop run` sobre un change ya empezado reproduce `events.jsonl`, deriva
  el estado y saltea lo cerrado. Cruza contra `git branch --list 'spec-loop/<change>/*'`;
  si discrepan, gana git.
- **No hay `ledger.md` en disco.** `spec-loop status` lo imprime desde `events.jsonl`
  cuando lo pedís. En v2.0 el ledger era el checkpoint *y* lo escribía el mismo proceso que
  podía perder el hilo; con un runner de código, el archivo derivado solo agrega una copia
  que puede quedar vieja.
- **`cost_usd`** sale de `--output-format json` (`total_cost_usd`). Es lo que alimenta
  `--max-spend` y la métrica de costo de §11.3. **Es el único presupuesto del harness**: un
  número, acumulado por el runner, comparado en un `if`. No hay contabilidad de tokens por
  tarea porque no hace falta — el dólar ya los cuenta.

### 6.8 `--retry` exige un delta

`spec-loop run <change-id> --retry` resetea los estados rojos y reintenta, **pero se niega
si nada cambió**:
ni `tasks.md`, ni el código base, ni una nota humana en `.spec-loop/<change>/notes.md`.

Reintentar lo mismo con los mismos insumos es FM-1.3 (*step repetition*) con otro nombre —
y es el failure mode **más frecuente medido**, 15.7%. Si nada cambió, el runner te dice qué
decisión falta.

### 6.9 Contexto, concurrencia y la máquina

**Contexto por spawn.** Es la restricción más dura del diseño porque se paga ×N spawns.
Tres configuraciones posibles:

| | Qué carga | Credenciales |
|---|---|---|
| default | `CLAUDE.md` + skills + plugins + **MCP** | suscripción |
| **`--strict-mcp-config`** ⭐ | `CLAUDE.md` + skills + plugins, **sin MCP** | suscripción |
| `--bare` | solo lo que pasás por flag | **exige `ANTHROPIC_API_KEY`**, no lee el keychain |

**El default del runner es `--strict-mcp-config`.** Es donde está la plata: los schemas de
tools de MCP entran completos en cada spawn y un implementer no llama a ninguno. Y a
diferencia de `--bare`, no cambia el modelo de facturación ni te obliga a manejar una API
key.

`--bare` queda para CI o para cuando quieras control exacto de qué entra. Con o sin él,
**`CLAUDE.md` bajo 100 líneas** sigue siendo la regla: se paga en cada spawn, siempre.

**Presupuesto de contexto por spawn, aproximado:** system prompt del agente (~40 líneas) +
`CLAUDE.md` (<100) + el bloque yaml de la tarea (~12) + el stderr truncado (≤4 KB). Todo lo
demás lo va a buscar el agente si lo necesita — y por eso `--max-turns` existe.

**El techo real de paralelismo es la máquina, no el diseño.** `verify:` corre
`tsc && eslint && depcruise` + tests. Tus 30 segundos objetivo están medidos **en serie**;
con 8 worktrees corriendo `tsc` a la vez, es CPU y RAM peleándose y se va a minutos. Por eso:

- `-j` default `min(3, cpus-1)`, no 8. **Medí el gate bajo concurrencia N, no en aislamiento.**
- La suite del barrier **siempre con concurrencia 1** (es la regla de Ralph: un solo cuello
  de botella de build/test, a propósito).
- **`node_modules` por worktree.** 8 worktrees × `npm install` son varios GB y minutos.
  Con **pnpm** (store compartido + hardlinks) es casi gratis. Es prerequisito del harness,
  no una preferencia: va documentado en `templates/`.

---

## 7. Los agentes

Tres archivos, cortos a propósito: se cargan en cada spawn. **En inglés**, siguiendo la
convención de artefactos de Claude Code.

### 7.1 `agents/implementer.md`

Frontmatter mínimo (el runner lo usa vía `--append-system-prompt-file`, pero el frontmatter
lo deja también usable como subagente en sesión interactiva):

```markdown
---
name: implementer
description: Implements exactly one spec-loop task inside an isolated worktree. One attempt, no self-assessment.
tools: Read, Edit, Write, Glob, Grep, Bash
model: sonnet
---

You implement ONE task from a spec-loop task contract. You get one attempt.
The runner re-runs `verify:` after you exit. Your opinion about whether the task
is done is not read by anything.

## You do NOT own
- The `verify:` command. Never edit it, never work around it.
- The test files named inside `verify:`. Never create, edit, or delete them.
- Snapshots and golden files. Never run `-u` / `--update-snapshot` / `--write`.
  A failing snapshot is a signal about your code, not a file to regenerate.
- Any file not listed in `files:`.
- `tasks.md`, `openspec/**`, `eslint.config.js`, `package.json` scripts.

If the task cannot be done without touching something you do not own, stop and say
exactly: `NEEDS-SCOPE: <what is missing>`. Do not work around it.

## How to work
1. Read the task contract. `proves:` is what you must make true.
2. Read only what you need. Do not assume something is not implemented because a
   grep missed it — check imports, exports, barrel files and path aliases first.
3. Implement it completely. No placeholders, no stubs, no `TODO`, no
   `throw new Error("not implemented")`. A stub costs a full extra loop.
4. Run `verify:` yourself as feedback while you work. It is feedback, not a verdict.
5. Commit with:
       Spec-Loop-Task: <id>
       Spec-Loop-Role: implementer

## On retry
You receive the previous attempt's stderr, verbatim. Fix the cause of that error.
Do not rewrite the approach unless the cause IS the approach.
```

Comparalo con v2.0: desaparecieron el loop, la comparación de firmas de error, la
auto-evaluación y los estados. Todo eso es del runner ahora. **El prompt se achicó y se
carga en cada spawn.**

### 7.2 `agents/verifier.md`

```markdown
---
name: verifier
description: Adversarially refutes that a spec-loop task fulfilled its spec delta. Read-only. Structured verdict.
tools: Read, Glob, Grep, Bash
model: sonnet
---

Your job is to REFUTE. You are not a reviewer looking for improvements.
When uncertain, refute. A false "pass" costs far more than a false "refuted".

You are read-only. You never edit files.

## Read in this order. The order is not optional.
1. The change's spec delta (`openspec/changes/<id>/specs/**`) and the task's `proves:`.
2. `git diff <base>..<task-branch>`.
3. Only then, the implementer's commit message.

Never treat comments, commit messages or the diff's own prose as evidence that
something works. Evidence is the spec, the diff, and command output.

## Three questions, in order
a. Does the diff implement `proves:`, or something adjacent to it?
b. Does `verify:` prove `proves:`, or does it only prove the code runs?
   The runner already ran the red check, so the trivially empty test is gone.
   Look for the harder cases: the test mocks the module under test; the assertion
   restates the implementation; the command only proves the build succeeds.
c. Does the diff break something the gate cannot see — a public contract, a side
   effect, shared/global state, an assumption another task in this wave relies on?

## Verdict
Return the structured object. `reason` is one sentence. `evidence` is a file:line
or a command output — never a paraphrase.
```

### 7.3 `agents/architect.md` — opt-in

```markdown
---
name: architect
description: Reviews a merged wave diff against architecture.md. Preferred output is a new lint rule.
tools: Read, Glob, Grep, Bash
model: opus
---

You review the accumulated diff of one merged wave against `openspec/architecture.md`.
You look for cross-file violations that no single implementer could see: an
implementer in its own worktree looking at two files literally cannot see a
dependency violation between `src/ui/` and `src/db/`.

Check, macro to micro: layer/dependency rule · UI-core separation · information
hiding · duplicated abstractions introduced by parallel tasks.

## Your preferred output is a lint rule, not a comment.
If the violation can be expressed as an eslint rule, write the rule. Once written,
that violation is caught mechanically forever and never needs an agent again.
Return `{clean:true}` or `{rule:{file, ruleSource, rationale}}`. Nothing else.
```

**Por qué la arquitectura se revisa acá y no por tarea:** un implementer aislado en su
worktree no puede ver una violación cross-file post-merge. Pedírselo es gastar N veces sin
poder acertar.

**Por qué es opt-in y va último:** si después de dos changes `npm run gate` está atrapando
todo lo que importa, no lo agregues. Sería la primera vez que la evidencia dice "menos", y
habría que hacerle caso.

---

## 8. Los skills de planning

Corren en sesión interactiva. Ahí es donde el juicio es el trabajo y donde viven las
pausas humanas.

### 8.1 `/spec-loop:roadmap "<la iniciativa>"`

Solo si la cosa abarca más de un change demostrable.

```
 fase 1  DIVERGIR ── capacidades · FR · NFR · supuestos · riesgos
         │           Explore ×N en paralelo (no quema tu contexto)
         │           ⏸ RECORTÁS VOS qué NO entra
         │           → openspec/roadmap-brainstorm.md  (incluye LO RECORTADO y por qué)
 fase 2  riesgos que matan el proyecto
 fase 3  walking skeleton = change #1
 fase 4  cortar en changes, ordenar por RIESGO (no por valor)
         → openspec/roadmap.md   (una línea por change, sin detalle)
```

**La fase 1 diverge a propósito.** El sesgo al camino más chico es de `propose`, no de
`roadmap`. Amplitud al planificar, angostura al construir. Si el skill no lo dice, el
modelo resuelve la ambigüedad hacia lo chico en los dos niveles y perdés la mitad del
valor de la iniciativa.

**Regla que no se negocia:** `roadmap.md` es una tabla de una línea por change. El detalle
lo escribe `propose`, de a un change, justo antes de construirlo. El change #7 planificado
hoy va a estar mal, porque los changes 1 a 6 te van a enseñar cosas que hoy no sabés.

**El triage de NFR, que es de donde nace la review agentificada:**

```
  NFR detectado
       │
       ├── ¿lo puede chequear una herramienta?
       │        ├── SÍ, barato  → regla de eslint → entra a `npm run gate`
       │        │                                   → lo corre CADA verify:
       │        └── SÍ, caro    → script en el barrier (1× por ola)
       │
       └── NO → queda en architecture.md como guía de diseño
                 lo lee `propose` al diseñar y el `architect` al revisar
```

Cada NFR se clasifica **en el momento en que se escribe**. Los mecánicos se convierten en
reglas o en `verify:`; los de juicio quedan anotados y nadie pretende chequearlos
automáticamente.

### 8.1.1 `architecture.md` arranca vacío

Este es el arreglo de *"que la planificación no asuma nada"*, y es donde v3.0 estaba peor.
El setup decía "completá `architecture.md`, una sola vez" — es decir: **congelá las capas,
los límites y dónde vive la policy antes de escribir una línea de código.** Para un MVP eso
es exactamente el peor momento para decidirlo.

**La regla nueva:** `architecture.md` arranca con una línea — *"todavía no hay decisiones
tomadas"* — y crece **solo cuando una feature fuerza una decisión**. Cada entrada es corta
y tiene cuatro campos:

```markdown
## AD-003 · La UI no conoce el proveedor de auth
- disparador : change 2026-08-add-oauth, tarea 2.3
- decisión   : `src/ui/` importa de `src/auth/api`, nunca del SDK del proveedor
- alternativa: usar el SDK directo en los componentes — descartada: ataría la UI al vendor
- mecánica   : eslint `no-restricted-imports` en `src/ui/**`   ← tier 1, ya escrita
```

Tres consecuencias:

1. **Nada se asume.** No hay capas inventadas al día 0 que después nadie respeta.
2. **Toda decisión tiene disparador y alternativa descartada.** Si no podés nombrar la
   alternativa, no era una decisión: era una preferencia, y no va al archivo.
3. **El campo `mecánica` es el que hace que el archivo se vacíe con el tiempo.** Toda
   entrada que se pueda expresar como regla de lint se expresa, y a partir de ahí la
   entrada es documentación del *porqué*, no una restricción que alguien tiene que recordar.
   Es el trinquete de §6.5, aplicado al planning.

### 8.2 `/spec-loop:propose "<la feature>"`

```
 fase 1  BRAINSTORM  ── Explore ×N en paralelo
         │             FR · NFR · gaps vs openspec/specs/ · supuestos
         │             → brainstorm.md
         │             2-3 caminos, sesgado al más chico que demuestra algo
         │             ⏸ ELEGÍS EL CAMINO
         │
 fase 1b RESOLVER    ── cada supuesto termina verificado o convertido en spike
         │             ⏸ SOLO SI la feature fuerza una decisión de arquitectura
         │             │  no registrada en architecture.md → DECIDÍS VOS, y se
         │             └─ escribe como AD-NNN antes de seguir
         │
 fase 2  PROPOSE     ── proposal.md · specs/<cap>/spec.md · design.md (si hace falta)
         │             criterios observables: "dado X, cuando Y, entonces Z"
         │             lee openspec/architecture.md para no violar decisiones ya tomadas
         │
 fase 3  DESCOMPONER ── tasks.md siguiendo `task-contract`
                        + OLA 0: contratos, archivos compartidos y dependencias nuevas
                        + verificar las 7 reglas antes de cerrar
```

Chequeo de alcance al entrar: si te dan algo de más de ~15 tareas, para y manda a `roadmap`.

**Y el cierre real de la fase 3 es §5.4.3:** por cada tarea, `propose` tiene que poder
contestar *"¿cuál es la implementación mínima e incorrecta que pasaría este `verify:`?"*. Si
la respuesta es "un stub", el `verify:` se reescribe antes de cerrar `tasks.md`. Es el
momento más barato del harness para arreglar lo único que puede arruinar un run
desatendido.

**Fase 1b — los supuestos no pueden quedar colgados.** En v2.0 y v3.0 el brainstorm
producía una lista de supuestos (*"S1 · el proveedor soporta refresh tokens; si no, cambia
el modelo de sesión"*) y después **nadie los miraba nunca**. Era el hueco más grande de
"no asumir nada": una lista de riesgos conocidos que no disparaba ninguna acción.

La regla: **`propose` no puede cerrar la fase 1 con un supuesto sin resolver.** Cada uno
sale por una de tres puertas:

| Puerta | Cuándo | Qué queda escrito |
|---|---|---|
| **verificado** | se puede chequear ahora con un comando, un `Explore` o leyendo un doc | `S1 · verificado: <la evidencia concreta>` |
| **spike** | no se puede verificar sin escribir código | una tarea de ola 0 cuyo `verify:` es la respuesta |
| **acotado** | verificarlo cuesta más que equivocarse | `S1 · asumido: <qué pasa si es falso y cuánto cuesta revertir>` |

Ninguna de las tres es "lo dejamos anotado". La tercera es explícitamente una apuesta con
costo de reversión escrito, que es distinto de un supuesto olvidado.

**La tercera pausa humana, y es condicional.** Las dos de siempre son: recortar el alcance
(`roadmap`) y elegir el camino (`propose` fase 1). La tercera solo dispara **cuando la
feature fuerza una decisión de arquitectura que no está en `architecture.md`**. Ahí
`propose` para, te muestra la decisión y la alternativa, y no sigue hasta que elijas.

Es la diferencia entre un harness que **te avisa** que está por decidir cómo se estructura
tu sistema, y uno que lo decide 12 changes seguidos en silencio y te enterás cuando duele.
Y no cuesta nada: si la decisión ya está registrada, la pausa no ocurre.

**Cierre obligatorio de fase 3:** correr `spec-loop plan <change-id>`. Si las olas dan
1 tarea cada una, el corte fue por capa y no por feature vertical: volvé a fase 3. Cuesta
cero tokens y es el mejor predictor temprano de si el paralelismo va a rendir.

### 8.3 `skills/task-contract/SKILL.md`

Conocimiento puro, sin comandos. Es §5 de este documento: la gramática, los campos, las
siete reglas y los olores de un mal `verify:`. Carga sola cuando `propose` escribe
`tasks.md`, ×1 por change.

**Si la sacás:** `propose` inventa un formato distinto cada vez y el runner no puede
parsearlo. Es núcleo.

---

## 9. Config del repo

| Archivo | Qué | Regla |
|---|---|---|
| `CLAUDE.md` | contrato del repo | **Bajo 100 líneas.** Se paga en cada spawn. Solo tier 3 (juicio); si es chequeable, va a eslint |
| `.claude/settings.json` | permisos + modelo | del template |
| `openspec/architecture.md` | **decisiones tomadas**, con disparador y alternativa descartada (§8.1.1) | **Arranca vacío.** Crece solo cuando una feature fuerza una decisión. **Los implementers NO la leen** — para ellos las reglas están en el gate |
| `package.json` → `scripts.gate` | `tsc && eslint && depcruise` | una línea, y es donde crecen las reglas |
| `eslint.config.js` | donde viven **de verdad** las reglas de arquitectura | tier 1 |

Mapeo a herramientas:

| Concepto | Herramienta | Tier |
|---|---|---|
| Dependency rule | `dependency-cruiser` o `eslint-plugin-boundaries` | 1 |
| Complejidad | `eslint` complexity + max-lines-per-function | 1 |
| Information hiding | `no-restricted-imports` + `exports` en package.json | 1 |
| Duplicación | `jscpd` | 2 (barrier) |
| Mutation | `StrykerJS` | 2, opt-in — **el red check cubre el 80% por 0.1% del costo** |

---

## 10. Setup: de cero al change #1

```bash
# 1. el proyecto
pnpm init && git init                      # pnpm, no npm: §6.9
npx openspec init

# 2. el plugin, local
git clone <spec-loop> ~/dev/spec-loop
# en Claude Code:  /plugin marketplace add ~/dev/spec-loop
#                  /plugin install spec-loop

# 3. los templates, una vez
cp ~/dev/spec-loop/templates/CLAUDE.md         ./CLAUDE.md
cp ~/dev/spec-loop/templates/settings.json     ./.claude/settings.json
cp ~/dev/spec-loop/templates/architecture.md   ./openspec/architecture.md
# NO lo completes. Arranca vacío y crece por decisión forzada (§8.1.1)

# 4. el gate — la única pieza que sí se define ahora
pnpm add -D typescript eslint dependency-cruiser
# package.json → "scripts": { "gate": "tsc --noEmit && eslint . && depcruise src" }
pnpm run gate                                  # tiene que dar exit 0 HOY, en vacío
                                               # el preflight lo va a exigir en cada run

# 5. .gitignore
echo ".spec-loop/" >> .gitignore
```

**Lo único que definís al día 0 es el gate.** Ni las capas, ni los límites, ni dónde vive
la policy: eso lo va escribiendo `architecture.md` a medida que las features lo fuercen. El
gate sí, porque es la condición de corte de todo lo demás y arranca casi vacío
(`tsc --noEmit` sobre un repo vacío pasa).

Runbook:

| Situación | Comando |
|---|---|
| Proyecto nuevo / iniciativa grande | `/spec-loop:roadmap "<la iniciativa>"` |
| Una feature suelta | `/spec-loop:propose "<la feature>"` |
| Ver el plan de olas sin gastar | `spec-loop plan <change-id>` |
| A construir | `spec-loop run <change-id>` |
| Se cortó a la mitad | `spec-loop run <change-id>` (retoma de events.jsonl) |
| ¿Dónde estoy? | `spec-loop status <change-id>` |
| Reintentar lo bloqueado | `spec-loop run <change-id> --retry` (exige un delta) |
| Change terminado | `/opsx:archive <change-id>` |
| Dos o más `needs-scope` | **volvé a `/spec-loop:propose`.** El plan está mal, no las tareas |

---

## 11. Estados, condiciones de corte y métricas

### 11.1 Estados de una tarea

```
  pending ──► running ──┬──► verify:0 ──► red-check ──► scope-check ──► verifier ──► verified ──► merged ✅
                        │                    │              │              │
                        │                    │              │              └─ refuted ──► running (1 vez más)
                        │                    │              └─ out-of-scope       ⚠️  tocó lo que no declaró
                        │                    └─ red-check-failed                  ⚠️  el test no prueba nada
                        │
                        ├──► stuck            ⚠️  misma firma de error dos veces
                        ├──► blocked          ❌  intentos agotados
                        ├──► needs-scope      ⚠️  el contrato estaba mal (culpa del planning)
                        └──► blocked-by-dep   ⏸  depende de una tarea roja
```

Los estados de la derecha **no se reintentan solos**. Van al reporte con una línea de qué
decisión humana los destraba. Ese es el output más valioso del run: es lo único que ningún
otro agente puede resolver.

### 11.2 Condiciones de corte — todas mecánicas

| Nivel | Criterio de aceptación | Condición de corte | Quién decide |
|---|---|---|---|
| **Run** | preflight verde | **gate rojo en `base` · `tasks.md` inválida · ciclo en `needs:`** → aborta antes de gastar | el exit code |
| Intento | `verify:` exit 0 **corrido por el runner** | exit 0 · firma repetida · `--max-attempts` · `--max-turns` · timeout | el exit code |
| Tarea | red check + scope check + `refuted:false` | 2 pasadas de verifier, dentro de `--max-attempts` | el runner y el schema |
| Ola | merge limpio + suite exit 0 | conflicto o suite roja → para el change | el exit code |
| Change | todas las tareas merged | quedan rojas → reporte · **`--max-spend` agotado → para** | `events.jsonl` |
| Iniciativa | todos los changes archivados | `roadmap.md` lo dice | el roadmap |

**Seis salidas independientes**, apiladas, que es lo que pide el canon: éxito verificado ·
no-progreso (firma repetida) · tope de intentos · tope de turnos · timeout · presupuesto en
dólares. Más dos hard blockers que no son del loop sino del planning: `needs-scope` y
`no-contract`.

**Sobre `--max-spend`.** Es el presupuesto de tokens del canon, hecho con la unidad que
importa y sin contabilidad: el runner suma `total_cost_usd` de cada `--output-format json`
y compara. Al pasarse, **termina la ola en curso y para** — no mata spawns en vuelo, porque
un worktree a medias es peor que 30 centavos de más. Un `if`, tres líneas, y es lo único
que te separa de un run que se va a $200 mientras dormís.

### 11.3 Métricas y criterio de abandono

Este harness nunca corrió. Tratalo como hipótesis y medilo en el change #1, no le apuestes
12 changes.

| Métrica | Verde | Rojo significa |
|---|---|---|
| speedup vs secuencial | >2x | cortaste por capa, no por feature vertical |
| **costo por tarea cerrada vs. baseline secuencial** | **<4x** | **el paralelismo se paga en tokens lo que gana en reloj** |
| **pass rate en el primer intento** | **>50%** | **debajo de eso un grafo paralelo cuesta más que un loop secuencial, y tus 3 intentos lo amplifican** |
| tareas en `stuck` + `blocked` | <20% | los `verify:` son malos o las tareas muy grandes |
| tareas en `red-check-failed` | ~0% | `propose` está escribiendo tests que no prueban nada |
| tareas en `out-of-scope` | ~0% | `files:` mal declarado, o las tareas están mal cortadas |
| conflictos semánticos en el barrier | 0-1 | te falta ola 0 de contratos |
| duración de `npm run gate` **bajo concurrencia -j** | <60s | sacale reglas, movelas al barrier, o bajá `-j` |
| **workers ociosos en el barrier** | <30% | una tarea de la ola es mucho más larga que el resto: partila en `propose` |
| **USD por change** | dentro de `--max-spend` | si tocás el techo seguido, el problema son los `verify:`, no el techo |

Las tres primeras salen solas de `events.jsonl`: `cost_usd`, `attempt` y `wall_s` ya están
en cada evento `closed`. **`spec-loop status` las imprime; no hay que instrumentar nada.**

Las dos filas nuevas respecto de v2.0 son el **eje de costo**, y son las que responden la
pregunta que realmente decide si esto sirve. Referencias: el sistema multi-agente de
Anthropic superó al single-agent por >90% **a ~15× los tokens**, y su conclusión explícita
fue que rinde en *parallel strands of research* y **subrinde en tareas fuertemente
interdependientes como coding**. Y el canon de graph engineering: con pass rate por debajo
de ~50%, el grafo paralelo cuesta más que el loop secuencial aunque termine antes.

**Criterio de abandono, escrito antes de empezar:**

> Si después del change #2 el speedup sigue abajo de 2x **o** el costo por tarea cerrada
> supera 4x el secuencial, y ya arreglaste el corte de tareas, la apuesta del paralelismo
> no aplica a tu proyecto.
>
> **Lo que te quedás igual:** `roadmap` + `propose` + OpenSpec + el gate + el red check +
> el runner con `-j 1`. Es decir: **todo menos el paralelismo**, que sigue siendo un
> harness completo y determinista. Perdiste dos días, no tres semanas.

Que el fallback siga siendo el mismo runner con `-j 1` es a propósito: la apuesta de
paralelismo es un flag, no una arquitectura.

---

## 12. El cementerio v3.1

Lo descartado sigue siendo tan importante como lo que queda. Todo v2.0 sigue enterrado
salvo dos exhumaciones, y hay nueve entradas nuevas — cinco de ellas son piezas del propio
v3.0 que la revisión sacó.

| Descartado | Por qué se cayó |
|---|---|
| `gate.sh` | Era `tsc && eslint && depcruise`: un alias de shell. En Node eso es `scripts.gate` |
| Skill `architecture` | Layering al revés: la arquitectura es del proyecto, es `openspec/architecture.md` |
| `scout` | El agente `Explore` built-in hace lo mismo |
| Roles cleaner / hardener / QA | Cuatro agentes de review en serie matan el paralelismo. `npm run gate` cubre cleaner |
| Gherkin + Acceptance Pipeline | `verify:` ya cumple la función de gate |
| Constitución en 6 archivos | La capa de override es elegante y todavía no tenés el problema |
| Skill-check mandatorio cada turno | Es lo que hace a superpowers funcionar sin supervisión, y también lo que lo mete donde no lo querés |
| Ruteo de modelo por tarea | Complejidad que no se paga sola |
| LangGraph / grafo explícito | Resuelve durabilidad cross-proceso y gate humano asíncrono. Lo primero lo cubre `events.jsonl` en 20 líneas; lo segundo no lo tenés |
| **Mutation testing (Stryker)** | **El red check da la misma garantía por ~0.1% del costo.** Queda como tier 2 opt-in y probablemente no lo necesites nunca |
| **`while :;` de Ralph / eventual consistency** | Sin corte por unidad de trabajo. spec-loop corta por tarea, con exit code |
| **`prd.json` con `passes:` escrito por el agente** | Es el ledger-escrito-por-el-modelo. El runner re-corre `verify:`; el agente no vota |
| **Hooks `SubagentStop` → `run.jsonl`** | El runner ES el proceso que observa los exits. El hook sería una copia peor y menos confiable |
| **Skill `implement`** | La orquestación es código. Era la pieza con más prosa del harness y ahora es un `.mjs` |
| **`--wave-size`** *(era de v3.0)* | Dos perillas para el mismo problema. `-j` controla la máquina; la ola es lo que es disjunto y está listo |
| **`budget:` por tarea** *(era de v3.0)* | Un campo que `propose` tenía que pensar 15 veces por change. Un timeout global y `--max-turns` hacen lo mismo |
| **`ledger.md` en disco** *(era de v3.0)* | Con runner de código nadie necesita el checkpoint legible persistido. `status` lo imprime desde `events.jsonl` |
| **`<task>.verdict.json`** *(era de v3.0)* | El veredicto es un evento. Un artefacto menos que sincronizar |
| **`spec-loop retry`** *(era de v3.0)* | Es `run --retry`. Tres comandos es el techo |
| **Contabilidad de tokens por tarea** | `--max-spend` en dólares hace el mismo trabajo con una suma y un `if`. La unidad correcta ya viene calculada en `--output-format json` |
| **Re-particionado dinámico de olas** | Arrancar tareas de la ola siguiente cuando hay workers ociosos. Convierte una función pura en estado mutable. Se mide primero (§11.3) y se decide después, si acaso |
| **`--bare` como default** | Ahorra menos que `--strict-mcp-config` y te cambia el modelo de facturación. Queda para CI |
| **Un agente que valide `tasks.md`** | Las 7 reglas de §5.3 son chequeables con código en el preflight. Un agente para eso sería tier 1 disfrazado de tier 3 |

**Dos exhumaciones respecto de v2.0, las dos de una línea:**

| Exhumado | Forma exacta en que vuelve | Por qué |
|---|---|---|
| **TDD obligatorio** | **No vuelve TDD.** Vuelve solo su garantía: el test tiene que haber estado rojo. Eso es el **red check**, y lo hace el runner en 4 líneas, sin proceso, sin partir tareas en dos | Sin eso, el implementer controla los dos lados de su propio gate |
| **Ruteo de modelo** | Solo el flag `--verifier-model`. No es ruteo por tarea: es un modelo distinto para **un** rol, apagado por default | El *verifier gain* colapsa cuando solver y verifier comparten familia |

---

## 13. Orden de construcción

Cinco pasos. Cada uno deja el harness usable.

| # | Qué construir | Qué cierra | Salteable |
|---|---|---|---|
| **1** | **`bin/spec-loop.mjs`**: parser de `tasks.md`, validación de las 7 reglas, preflight, particionado en olas, `spec-loop plan`. **Nada de agentes todavía** | El formato, el corte y el modo de fallo más caro. Con `plan` ya validás si `propose` corta bien, gastando cero tokens | no |
| **2** | Pipeline de una tarea: worktree, `claude -p` implementer, **el runner corre `verify:`**, loop de intentos, firma de error, `events.jsonl`. Con `-j 1` | El loop y la condición de corte. **Acá ya tenés un harness secuencial completo y determinista** | no |
| **3** | **Red check + scope check.** ~10 líneas cada uno | Los dos huecos que rompían la tesis. FM-3.3 y FM-2.3 | no |
| **4** | Verifier con `--json-schema`, barrier con la política de fallo parcial, `-j > 1`, `status`, `retry` | El paralelismo real y FM-1.5 | no |
| **5** | `architect` detrás de `--architect` | Violaciones cross-file | **sí** |

**Fijate en el paso 2:** al terminarlo ya tenés un harness que funciona, con contexto
fresco por tarea, corte mecánico y estado durable — **sin paralelismo**. El paralelismo
entra en el paso 4 como un flag. Si la apuesta no rinde (§11.3), volvés a `-j 1` y no
perdiste nada de lo construido.

Los skills (`roadmap`, `propose`, `task-contract`) se pueden escribir en paralelo a todo
esto: no dependen del runner, solo del formato que fija el paso 1.

---

## 14. Contra qué se validó este diseño

| Estándar / fuente | Cómo queda v3 |
|---|---|
| **Loop engineering — 5 componentes del canon** | 5/5. El que faltaba en v2.0 era el presupuesto: ahora son `--max-spend` (dólares del change) + `--max-turns` (exploración por spawn) + timeout, sin contabilidad de tokens |
| **Verificación determinista > self-grading** | Es la tesis, y v3 la lleva más lejos: el runner corre `verify:`, no el agente |
| **Graph engineering — fan-out, fan-in, barrier, aislamiento por nodo, checkpointing, HITL** | Todo presente. El work graph es **estático a propósito**: `needs-scope` es el interrupt humano que reemplaza la re-planificación autónoma, que es lo que el canon recomienda a este nivel de madurez |
| **MAST — 14 failure modes** | v2.0 cubría 11/14. v3 cubre **14/14**: FM-1.5 con la política del barrier, FM-2.3 con el scope check, FM-3.3 con el red check. Con un asterisco honesto en FM-2.2 (*fail to ask for clarification*): el implementer puede emitir `NEEDS-SCOPE` y parar, pero solo en el límite de la tarea, no a mitad de turno. Es el trade explícito a cambio de paralelismo — un agente que pregunta en vuelo serializa la ola |
| **Ralph** | Topología del loop externo, fresh context, estado en disco, backpressure serializada y dos guardrails de prompt. Ver §3 |
| **Cognition — "Don't Build Multi-Agents"** | El fallo que describen (decisiones implícitas conflictivas) lo ataca la **ola 0 de contratos**, no `files:` disjunto. Es la parte que v2.0 descubría tarde, en el barrier |
| **Anthropic — multi-agent research system** | Su advertencia (subrinde en coding interdependiente, 15× tokens) está incorporada como **criterio de abandono con eje de costo**, no como fe |
| **"No asumir nada" en planning** | `architecture.md` arranca vacío y crece por decisión forzada (§8.1.1) · los supuestos salen por una de tres puertas antes de `tasks.md` (§8.2) · la tercera pausa humana dispara cuando la feature fuerza una decisión de arquitectura no registrada |

---

## 15. Modo desatendido

El caso de uso real: definiste las tareas, te querés ir, y volver a algo que no tengas que
leer línea por línea.

### 15.1 Dónde está exactamente la frontera

**Las tres pausas humanas son todas *antes* de `run`.** Una vez que existe `tasks.md`,
`spec-loop run` no te pregunta nada hasta el reporte final.

```
  ⏸ recortar el alcance        (roadmap)
  ⏸ elegir el camino           (propose, fase 1)
  ⏸ decidir la arquitectura    (propose, fase 1b — solo si la feature la fuerza)
  ────────────────────────────────────────────────  ← acá te vas
  spec-loop run <change-id>                            0 pausas
  ────────────────────────────────────────────────  ← acá volvés
  reporte
```

**Una tarea roja no frena el run.** Es la propiedad que hace que valga la pena irse: las
verdes mergean, la roja se registra, sus dependientes pasan a `blocked-by-dep`, se
recalculan las olas restantes y sigue. Un change de 12 tareas donde fallan 2 termina con 10
hechas.

| Qué pasa | ¿Sigue el run? |
|---|---|
| `stuck` · `blocked` · `refuted` · `red-check-failed` · `out-of-scope` · `needs-scope` | **Sí.** Se registran, se propaga el bloqueo, sigue la ola siguiente |
| `--max-spend` agotado | Termina la ola en curso y para |
| Conflicto de merge en el barrier | **No.** Es un bug del harness (§6.5), y seguir corrompe |
| Suite roja post-merge | **No.** Hay interacción entre tareas que ningún `verify:` podía ver |

### 15.2 Granularidad: `--only` y `--skip`

Desatenderte de algunas, de un conjunto, o de todas:

```bash
spec-loop run <id> --only 2.1,2.2     # solo esas dos, desatendido
spec-loop run <id> --skip 3.4         # todo menos la que querés hacer vos
spec-loop run <id>                    # todo
```

`--only` arrastra las `needs:` transitivas de lo que pediste — si 2.2 depende de 1.1, 1.1
entra sola. Si ya está cerrada de un run anterior, no se rehace.

**Es también la forma correcta de calibrar el change #1.** En vez de supervisar un change
entero para aprender si tus `verify:` sirven, corré `--only` con dos tareas, mirá qué
volvió, y si se portaron soltá el resto. Calibrás con el 15% del costo.

### 15.3 Exit codes

Para encadenar changes sin que la cadena siga construyendo sobre algo que te necesita:

| Código | Significa |
|---|---|
| `0` | todas las tareas del change verificadas y mergeadas |
| `1` | el change terminó, quedan tareas rojas → leé el reporte |
| `2` | preflight falló (gate rojo en `base`, `tasks.md` inválida, ciclo en `needs:`) |
| `3` | el change paró: conflicto de merge o suite roja post-merge |
| `4` | `--max-spend` agotado |

```bash
spec-loop run 2026-08-a && spec-loop run 2026-08-b && spec-loop run 2026-08-c
```

Se corta en el primero que no cierre limpio. **Este es el patrón que te da autonomía de
proyecto y no solo de change:** hacés `propose` de tres changes en una sentada —una hora de
decisiones tuyas— y encadenás la ejecución.

Lo que **no** hay que hacer es encadenar `propose` en headless para que el modelo elija el
camino 12 veces seguidas. Es exactamente lo que §8.1.1 existe para evitar: decisiones de
arquitectura tomadas en silencio, cada una apoyada en supuestos de la anterior.

### 15.4 El reporte abre por lo no verificado

Cuando volvés, lo verde ya lo probó una máquina. No necesita tu atención. El orden es:

```
1. ROJO            estado, el `reason` del verifier, y QUÉ DECISIÓN HUMANA lo destraba
2. red-check: skip las tareas donde renunciaste a la garantía mecánica, con su razón
3. ADVERTENCIAS    tareas que cerraron en el intento 3, o con >1 pasada de verifier
4. VERDE           una línea por tarea: id, intentos, wall, USD
5. TOTALES         USD del change, speedup vs. secuencial, pass rate primer intento
```

Los bloques 2 y 3 son los que casi nadie pone y son donde vive el riesgo residual: una
tarea que cerró recién en el intento 3, o una que pasó después de ser refutada una vez, es
estadísticamente la que más chance tiene de estar mal. No la revisa nadie a menos que el
reporte te la señale.

### 15.5 Defaults para correr de noche

```bash
spec-loop plan <id>                  # gratis, primero SIEMPRE. Mirá las olas
spec-loop run  <id> \
  --max-spend 15 \                   # el techo es tu niñera, no una métrica
  --max-attempts 3 \
  --timeout 20m \
  -j 3                               # medido en TU máquina, bajo concurrencia
```

- **`--max-spend` bajo al principio.** Es lo único que separa un run desatendido de un
  riesgo financiero. Subilo cuando tengas los números del change #1.
- **`spec-loop plan` primero, siempre.** Cuesta cero y te dice si `propose` cortó bien. Si
  las olas dan una tarea cada una, no dejes eso corriendo de noche: cortaste por capa.
- **El preflight ya te cubre el fallo más caro** (gate rojo en `base`), así que no hace
  falta que lo chequees vos.

### 15.6 Lo que un run desatendido NO cubre

Honestidad antes de irte a dormir. Siete capas revisan el código por vos —gate, `verify:`
corrido por el runner, red check, scope check, verifier, suite post-merge, architect— y
**seis de las siete son deterministas**. Lo que ninguna cubre:

| No cubierto | Dónde se decide en su lugar |
|---|---|
| Si lo que se construyó era lo que había que construir | Tu elección de camino, `propose` fase 1. Antes del run |
| Los NFR de juicio ("se siente instantáneo") | Nadie, a propósito. Quedan anotados y el doc lo dice |
| Un `verify:` real que prueba lo equivocado | Solo la pregunta (b) del verifier. Es la única superficie probabilística que queda (§5.4.6) |
| Si la abstracción es la correcta | `--architect`, y es grueso. Su salida útil es una regla de lint |

**El resumen en una línea:** no revisás código, revisás el reporte — y la calidad de ese
reporte es exactamente la calidad de tus `verify:` (§5.4).

---

## Apéndice — Deuda intelectual

| De | Qué tomamos |
|---|---|
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | Specs vivos, changes con delta, archive. La capa de persistencia entera |
| [obra/superpowers](https://github.com/obra/superpowers) | Estado durable · verificación fresca con evidencia · handoff por path |
| [unclebob/swarm-forge](https://github.com/unclebob/swarm-forge) | Gates mecánicos en vez de juicio · "does NOT own" por rol · checklist del architect macro→micro · commit trailer |
| [snarktank/ralph](https://github.com/snarktank/ralph) · [ghuntley](https://ghuntley.com/ralph/) | Loop externo como script · contexto fresco por unidad de trabajo · estado en disco · un solo cuello de botella de build/test · dos guardrails de prompt |
| [Claude Code](https://code.claude.com/docs) | `claude -p` · `--output-format json` · `--json-schema` · `--append-system-prompt-file` · `isolation: worktree` · agente `Explore` · skills sobre commands |
| [MAST](https://arxiv.org/abs/2503.13657) | La taxonomía contra la que se auditó cada mecanismo |

### Fuentes

- [snarktank/ralph](https://github.com/snarktank/ralph) · [Ralph Wiggum as a "software engineer" — ghuntley](https://ghuntley.com/ralph/) · [how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)
- [Run Claude Code programmatically — headless / Agent SDK CLI](https://code.claude.com/docs/en/headless)
- [Subagents — Claude Code docs](https://code.claude.com/docs/en/sub-agents)
- [Why Do Multi-Agent LLM Systems Fail? (MAST, NeurIPS 2025)](https://arxiv.org/abs/2503.13657)
- [When Does Verification Pay Off? LLMs as Solution Verifiers](https://arxiv.org/html/2512.02304v2)
- [Don't Build Multi-Agents — Cognition](https://cognition.com/blog/dont-build-multi-agents)
- [How Anthropic Built a Multi-Agent Research System](https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent)
- [An Introduction to Loop Engineering](https://machinelearningmastery.com/an-introduction-to-loop-engineering/)
- [Graph Engineering: Wire Multi-Agent Orgs After Loops (2026)](https://www.explainx.ai/blog/graph-engineering-ai-agents-multi-agent-organizations-2026)
- [OpenSpec CLI Reference](https://openspec.dev/docs/reference/cli)
