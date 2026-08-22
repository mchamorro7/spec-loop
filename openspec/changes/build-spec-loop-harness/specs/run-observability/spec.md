## Purpose

Define qué queda escrito de un run, cómo se retoma uno cortado, qué se lee al volver a la mañana
y con qué señal el harness corta el gasto. El estado se deriva de un registro append-only; nunca
lo narra un modelo.

## ADDED Requirements

### Requirement: Registro de eventos como única fuente de verdad

El runner SHALL ser el único proceso que escribe el registro de eventos del change, en formato
append-only, con una entrada por transición de estado. El estado de un run SHALL derivarse de ese
registro y SHALL NO persistirse como narrativa escrita por un agente.

Cada entrada SHALL llevar marca de tiempo, tarea y tipo de evento. El evento de cierre de una
tarea SHALL llevar su estado final, su costo en dólares y su duración.

#### Scenario: Estado derivado

- **WHEN** el usuario corre `spec-loop status`
- **THEN** el estado se calcula desde el registro, sin leer ningún archivo de resumen escrito por
  un modelo

#### Scenario: Ningún agente escribe estado

- **WHEN** un agente afirma en su salida que una tarea está lista
- **THEN** esa afirmación no genera ninguna entrada en el registro

### Requirement: El progreso se proyecta sobre el archivo de tareas

El runner SHALL marcar como completa la línea de checkbox de cada tarea que quede mergeada, y
SHALL NO leer nunca el estado de esos checkboxes. El flujo SHALL ser de una sola dirección: el
registro de eventos es la fuente de verdad y el checkbox es su proyección; ante discrepancia,
prevalece el registro.

El runner SHALL NO modificar el bloque `yaml` ni la prosa de ninguna tarea.

#### Scenario: Archivado sin conocer spec-loop

- **WHEN** un change ejecutado por el runner se archiva con la herramienta de specs
- **THEN** esa herramienta cuenta los checkboxes y ve las tareas completas, sin saber que el
  runner existe

#### Scenario: Contrato inmutable

- **WHEN** el runner cierra una tarea
- **THEN** toca únicamente su checkbox, y el contrato de la tarea queda idéntico

#### Scenario: Discrepancia

- **WHEN** un checkbox está marcado y el registro de eventos no tiene esa tarea como mergeada
- **THEN** el runner ignora el checkbox y usa el registro

### Requirement: Resume idempotente

`spec-loop run` sobre un change ya empezado SHALL derivar el estado del registro, saltear lo que
ya cerró y continuar. El runner SHALL cruzar ese estado contra las ramas de git del change y, si
discrepan, git SHALL prevalecer.

#### Scenario: Corte a la mitad

- **WHEN** un run se interrumpe durante la segunda ola y se vuelve a correr `spec-loop run`
- **THEN** las tareas cerradas no se rehacen y el run retoma desde donde estaba

#### Scenario: Apto para agendar

- **WHEN** `spec-loop run` se ejecuta de forma cadenciada por un planificador externo
- **THEN** correrlo de más no rehace trabajo cerrado ni corrompe el estado

### Requirement: Reintentar exige un delta

Cuando un change tenga tareas rojas, `spec-loop run` SHALL reintentarlas solo si cambió algo: el
contrato de alguna tarea, o el código de la base. La detección del cambio de contrato SHALL
considerar únicamente los bloques `yaml` y la prosa de las tareas, y SHALL ignorar el estado de
los checkboxes, que escribe el propio runner. Si nada cambió, el runner SHALL negarse e indicar
qué decisión falta.

#### Scenario: Nada cambió

- **WHEN** el usuario vuelve a correr `spec-loop run` sin haber modificado nada
- **THEN** el runner se niega, porque reintentar con los mismos insumos es repetición sin progreso

#### Scenario: El propio runner marcó checkboxes

- **WHEN** el run anterior marcó como completas varias tareas y no cambió nada más
- **THEN** el runner no lo interpreta como un delta y se sigue negando a reintentar las rojas

#### Scenario: Cambió el plan

- **WHEN** el usuario corrige el `verify` de la tarea roja en `tasks.md`
- **THEN** el run reintenta esa tarea y las que dependían de ella

### Requirement: Cortacircuitos de gasto

El runner SHALL acumular el costo en dólares reportado por cada spawn y compararlo contra el
techo configurado. Al superarlo, SHALL terminar la ola en curso y detenerse, sin matar spawns en
vuelo.

#### Scenario: Techo alcanzado

- **WHEN** el gasto acumulado supera el techo durante una ola
- **THEN** la ola en curso termina, el change se detiene y el reporte lo indica

#### Scenario: Sin contabilidad de tokens

- **WHEN** el usuario quiere saber cuánto costó una tarea
- **THEN** lo lee en dólares desde el registro, sin que exista contabilidad de tokens por tarea

### Requirement: Salida legible durante el run

El runner SHALL emitir a la salida estándar, en vivo, una línea por transición de estado, con la
misma información que escribe en el registro. Un run desatendido SHALL NO volcar la salida cruda
de los agentes.

#### Scenario: Run largo

- **WHEN** un run tarda cuarenta minutos
- **THEN** la salida estándar muestra el avance línea por línea, sin silencio y sin manguera

### Requirement: El reporte abre por lo no verificado

Al terminar, el runner SHALL emitir un reporte a la salida estándar y escribirlo también a un
archivo del change, en este orden:

1. Tareas rojas, con su estado, la razón registrada y qué decisión humana las destraba.
2. Riesgo residual: tareas con `red-check: skip` y su razón, NFR de juicio que quedaron sin
   verificar, reglas de linter propuestas por el checker que todavía no están en el gate, y los
   hallazgos del revisor de change sobre el diff acumulado.
3. Advertencias: tareas que cerraron en el último intento disponible o después de una refutación.
4. Tareas verdes, una línea por tarea con id, intentos, duración y costo.
5. Totales: costo del change, aceleración contra secuencial y tasa de éxito al primer intento.

#### Scenario: Volver a la mañana

- **WHEN** el usuario lee el reporte de un run desatendido
- **THEN** lo primero que ve es lo que ninguna máquina pudo verificar, no la lista de éxitos

#### Scenario: Deuda de comprensión señalada

- **WHEN** una tarea cerró recién en el último intento o después de haber sido refutada
- **THEN** aparece en el bloque de advertencias, porque es la que más chance tiene de estar mal y
  nadie la revisaría por su cuenta

### Requirement: Exit codes por tipo de fallo

El runner SHALL distinguir con su exit code: todas las tareas verificadas y mergeadas; el change
terminó con tareas rojas; el preflight falló; el change se detuvo por conflicto de merge o suite
roja; y el techo de gasto se agotó.

#### Scenario: Encadenar changes

- **WHEN** el usuario encadena varios `spec-loop run`
- **THEN** la cadena se corta en el primero que no cierre limpio, sin construir sobre algo que
  necesita una decisión humana

#### Scenario: Aviso al terminar

- **WHEN** el usuario quiere que le avisen al terminar un run nocturno
- **THEN** lo cablea afuera con el exit code y el archivo de reporte, sin que el harness dependa
  de ningún conector externo
