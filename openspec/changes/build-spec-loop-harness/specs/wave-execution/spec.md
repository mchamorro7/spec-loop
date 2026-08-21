## Purpose

Define cómo el runner convierte un `tasks.md` en trabajo hecho: cómo elige el change sin que
se lo pasen, cómo agrupa las tareas en olas disjuntas, cómo aísla cada intento y qué hace
cuando parte de una ola falla.

## ADDED Requirements

### Requirement: Superficie de comandos sin argumentos

El runner SHALL exponer la invocación pelada y dos verbos, y ninguno SHALL aceptar argumentos
posicionales ni flags:

- `spec-loop` — corre el preflight, imprime las olas y sale sin gastar tokens.
- `spec-loop run` — corre el preflight, imprime las olas y ejecuta.
- `spec-loop status` — imprime el estado derivado del registro de eventos.

Toda la configuración SHALL vivir en `spec-loop.yaml` en la raíz del repo, con tres claves
obligatorias (`gate`, `test`, `max-spend`), cinco opcionales con default (`jobs`,
`max-attempts`, `timeout`, `model`, `checker-model`) y una opcional sin default (`barrier`, el
comando de chequeo caro). `checker-model` SHALL usar el valor de `model` como default cuando no
se declare.

#### Scenario: Invocación pelada

- **WHEN** el usuario corre `spec-loop`
- **THEN** ve las olas, los errores de preflight si los hay, y los dos verbos al pie, sin haber
  gastado un token

#### Scenario: Config ausente

- **WHEN** no existe `spec-loop.yaml` o le falta una clave obligatoria
- **THEN** el runner aborta e indica qué clave falta

#### Scenario: Override opcional

- **WHEN** `spec-loop.yaml` declara `jobs: 6`
- **THEN** el runner usa 6; si la clave no está, usa `min(3, cpus-1)`

### Requirement: Resolución del change sin argumentos

El runner SHALL determinar el change actual sin recibirlo. El change actual SHALL ser el primer
change en el orden declarado por `roadmap.md` que tenga `tasks.md` y no esté completo. Cuando no
exista `roadmap.md` o el change no figure en él, y haya exactamente un change activo, ese SHALL
ser el actual.

#### Scenario: Cadena de changes

- **WHEN** el usuario corre `spec-loop run` tres veces y el primer change se completa
- **THEN** la segunda invocación toma el change siguiente según `roadmap.md`

#### Scenario: Nada que correr

- **WHEN** no hay ningún change activo con `tasks.md`
- **THEN** el runner sale indicando que corresponde correr `/spec-loop:propose`

#### Scenario: Ambigüedad irresoluble

- **WHEN** hay más de un change activo y ninguno figura en `roadmap.md`
- **THEN** el runner aborta y lista los candidatos

### Requirement: Preflight antes de spawnear

El runner SHALL, antes de crear ningún worktree o spawnear ningún agente: verificar que el gate
pasa en la base, parsear `tasks.md`, validar las ocho reglas verificables, particionar en olas
y limpiar los worktrees viejos del change. Cualquier fallo SHALL abortar el run identificando la
causa.

#### Scenario: Gate rojo en la base

- **WHEN** el comando de gate devuelve un exit distinto de cero sobre la base
- **THEN** el runner aborta con el mensaje de que el gate está rojo antes de empezar, sin haber
  creado ningún worktree

### Requirement: Particionado en olas

El runner SHALL agrupar las tareas en olas mediante una función determinista y pura sobre la
lista de tareas. Una tarea SHALL entrar en una ola solo si todas sus `needs` ya están en olas
anteriores y sus `files` no intersecan los de ninguna tarea ya tomada en esa ola. Las tareas
SHALL considerarse en orden de `id`.

La función de particionado SHALL NO recibir ni producir estado mutable.

#### Scenario: Olas disjuntas

- **WHEN** tres tareas sin `needs` declaran conjuntos de `files` que no se intersecan
- **THEN** las tres quedan en la misma ola

#### Scenario: Contención de archivos

- **WHEN** dos tareas sin `needs` comparten un archivo en `files`
- **THEN** quedan en olas distintas, la de menor `id` primero

#### Scenario: Ola vacía

- **WHEN** quedan tareas pendientes y ninguna puede entrar en la ola siguiente
- **THEN** el runner aborta indicando ciclo en `needs` o contención total

#### Scenario: Corte por capa detectado gratis

- **WHEN** el particionado produce una ola por tarea
- **THEN** el usuario lo ve al correr `spec-loop`, antes de gastar, como señal de que el corte
  fue por capa y no por feature vertical

### Requirement: Aislamiento por tarea

Cada tarea SHALL ejecutarse en su propio worktree de git, sobre una rama propia, creada desde la
base de su ola. La base de una ola SHALL ser el HEAD de la rama del change al momento de
arrancar esa ola, de modo que cada ola vea el trabajo mergeado de las anteriores.

#### Scenario: La ola 2 ve la ola 1

- **WHEN** la tarea `2.1` declara `needs: ["1.1"]` y la ola 1 ya mergeó
- **THEN** el worktree de `2.1` se crea desde un base que contiene el código de `1.1`

#### Scenario: Concurrencia acotada

- **WHEN** una ola tiene seis tareas y `jobs` es 3
- **THEN** corren como máximo tres worktrees a la vez

### Requirement: Presupuesto de contexto por spawn

El contexto de cada spawn se paga una vez por intento y por tarea, así que el runner SHALL
acotarlo por construcción y SHALL NO delegar esa decisión en el agente.

El runner SHALL invocar a los agentes sin cargar servidores de herramientas externas, porque sus
esquemas entran completos en cada spawn y ningún agente del harness los usa. SHALL hacerlo sin
cambiar el modelo de credenciales de la sesión.

Cada spawn SHALL recibir únicamente: el prompt de rol del agente, el contrato del repo, el
contrato de la tarea con su prosa y, a partir del segundo intento, el error anterior truncado.
Todo lo demás SHALL quedar a cargo del agente, acotado por su tope de turnos.

El runner SHALL acotar cada spawn con un tope de turnos y un timeout, y SHALL tratar alcanzar
cualquiera de los dos como intento fallido.

El contrato del repo SHALL mantenerse por debajo de cien líneas y SHALL contener únicamente
restricciones no verificables por herramienta; toda restricción verificable SHALL vivir en el
gate.

#### Scenario: Esquemas de herramientas externas

- **WHEN** el runner invoca al implementer o al checker
- **THEN** ningún servidor de herramientas externas se carga, y la sesión conserva sus
  credenciales

#### Scenario: El diff se entrega, no se busca

- **WHEN** el checker necesita el diff de las tareas de la ola
- **THEN** lo recibe como entrada, sin gastar turnos en ir a buscarlo y sin permiso para
  explorar el repo por su cuenta

#### Scenario: Tope de turnos alcanzado

- **WHEN** un spawn agota su tope de turnos
- **THEN** el runner lo trata como intento fallido y el loop continúa según sus condiciones de
  corte

#### Scenario: Contrato del repo que crece

- **WHEN** el contrato del repo incorpora una restricción verificable por una herramienta
- **THEN** esa restricción corresponde al gate, porque en el contrato se paga en cada spawn y de
  forma probabilística

### Requirement: Loop de intentos por tarea

El runner SHALL ejecutar, por tarea, un loop de a lo sumo `max-attempts` spawns de implementer
**en total**, contando los spawns disparados por una refutación del verifier. Cada spawn SHALL
recibir contexto fresco. A partir del segundo intento, el runner SHALL inyectar el error del
intento anterior truncado al primer bloque de error más las últimas veinte líneas, con un tope
de 4 KB.

El runner SHALL cortar el loop cuando `verify` devuelva exit 0, cuando la firma normalizada del
error se repita respecto del intento anterior, o cuando se agoten los intentos, el tope de
turnos por spawn o el timeout.

#### Scenario: Éxito al segundo intento

- **WHEN** el primer intento falla y el segundo hace que `verify` devuelva exit 0
- **THEN** el loop corta y la tarea pasa a los checks mecánicos

#### Scenario: Sin progreso

- **WHEN** dos intentos consecutivos producen la misma firma normalizada de error
- **THEN** la tarea cierra en `stuck` sin consumir los intentos restantes

#### Scenario: Intentos agotados

- **WHEN** se consumen los `max-attempts` sin que `verify` devuelva exit 0
- **THEN** la tarea cierra en `blocked`

#### Scenario: Contexto envenenado evitado

- **WHEN** el error del intento anterior tiene miles de líneas
- **THEN** el intento siguiente recibe como máximo 4 KB, y el error completo queda en el registro
  de eventos

### Requirement: El implementer no puede pedir alcance en vuelo

El implementer SHALL poder declarar que la tarea no se puede hacer sin tocar algo que no le
pertenece, y en ese caso la tarea SHALL cerrar en `needs-scope` sin más intentos. El implementer
SHALL NO poder pausar y preguntar a mitad de un turno.

#### Scenario: Contrato insuficiente

- **WHEN** el implementer declara que le falta alcance
- **THEN** la tarea cierra en `needs-scope` y el reporte indica qué decisión humana la destraba

#### Scenario: Dos o más `needs-scope`

- **WHEN** un change cierra con dos o más tareas en `needs-scope`
- **THEN** el reporte indica que el plan está mal y corresponde volver a `/spec-loop:propose`, no
  parchear tareas sueltas

### Requirement: Barrier y política ante fallo parcial

Al terminar una ola, el runner SHALL, en este orden: mergear las tareas verificadas en la rama
del change en orden de `id`; correr la suite del proyecto sobre la rama del change con
concurrencia 1; correr el comando de chequeo caro si el proyecto lo declaró; marcar como
bloqueada toda tarea restante cuya clausura de `needs` toque una tarea roja; y recalcular las
olas restantes excluyendo las bloqueadas.

Un run SHALL NO pedirle nada a un humano mientras está en vuelo. Solo dos condiciones SHALL
detener el change entero: un conflicto de merge y una suite roja después del merge.

#### Scenario: Fallo parcial

- **WHEN** una ola de ocho cierra con seis verificadas, una `stuck` y una `blocked`
- **THEN** las seis mergean, las dos rojas se registran, sus dependientes pasan a bloqueadas y el
  run continúa con la ola siguiente

#### Scenario: Conflicto de merge

- **WHEN** el merge de una rama de tarea produce conflicto
- **THEN** el change se detiene y el reporte lo señala como bug del harness, porque olas disjuntas
  con scope check verde no pueden producir conflicto textual

#### Scenario: Suite roja después del merge

- **WHEN** la suite falla sobre la rama del change tras mergear la ola
- **THEN** el change se detiene, nada se revierte automáticamente y el reporte indica que hay
  interacción entre tareas que ningún `verify` individual podía ver
