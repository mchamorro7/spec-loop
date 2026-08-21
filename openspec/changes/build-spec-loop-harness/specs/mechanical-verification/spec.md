## Purpose

Define quién decide que una tarea está lista y con qué evidencia. Ningún agente reporta su
propio estado: todo lo decidible por un exit code lo decide un exit code, y un checker fresco
decide solo lo que un exit code no alcanza.

## ADDED Requirements

### Requirement: El runner corre `verify`, no el implementer

El runner SHALL ejecutar el comando `verify` de la tarea dentro de su worktree después de que
el spawn del implementer termine, y SHALL tratar su exit code como la única señal de si el
intento pasó. El runner SHALL ignorar cualquier afirmación del implementer sobre el estado de
la tarea.

#### Scenario: El implementer dice que terminó y no terminó

- **WHEN** el implementer sale declarando que la tarea está lista y `verify` devuelve un exit
  distinto de cero
- **THEN** el intento cuenta como fallido y el loop continúa

### Requirement: El runner commitea el trabajo de la tarea

Cuando `verify` devuelva exit 0, el runner SHALL commitear el contenido del worktree antes de
ejecutar cualquier check posterior. El commit SHALL incluir un trailer con el `id` de la tarea y
un trailer con su `proves`. El implementer SHALL NO ser responsable de commitear.

#### Scenario: Trabajo sin commitear

- **WHEN** el implementer deja cambios sin commitear y `verify` devuelve exit 0
- **THEN** el runner los commitea, y ningún check posterior puede destruirlos

#### Scenario: Trazabilidad durable

- **WHEN** el change se archiva y el registro de eventos desaparece
- **THEN** el historial de git sigue relacionando cada commit con su tarea y su requisito

### Requirement: Lint del test

Después de que `verify` devuelva exit 0 y antes de los demás checks, el runner SHALL rechazar la
tarea cuando el archivo de test nombrado en `verify` no exista, no contenga ninguna aserción,
mockee un módulo listado en los `files` de la propia tarea, se apoye únicamente en aserciones de
mera existencia, o use un snapshot regenerable.

#### Scenario: Test que se mockea a sí mismo

- **WHEN** el test mockea un módulo que figura en los `files` de su propia tarea
- **THEN** la tarea cierra en `test-lint-failed` y no se mergea

#### Scenario: Aserción vacía

- **WHEN** la única aserción del archivo de test es de mera existencia
- **THEN** la tarea cierra en `test-lint-failed`

#### Scenario: El archivo existe recién ahora

- **WHEN** el archivo de test lo crea el implementer durante el primer intento
- **THEN** el lint corre sobre él, porque corre después de `verify` y no en el preflight

### Requirement: Red check

Salvo que la tarea declare `red-check: skip` con razón, el runner SHALL, dentro del worktree
aislado: quitar de la tarea los archivos declarados en `files` que no estén nombrados en
`verify`, restaurando los que existían en la base y borrando los que no; ejecutar `verify`; y
restaurar el estado anterior.

La tarea SHALL rechazarse cuando `verify` devuelva exit 0 sin la implementación.

#### Scenario: El test prueba algo

- **WHEN** al quitar la implementación `verify` devuelve un exit distinto de cero
- **THEN** el check pasa y la tarea sigue

#### Scenario: El test no prueba nada

- **WHEN** al quitar la implementación `verify` sigue devolviendo exit 0
- **THEN** la tarea cierra en `red-check-failed` y no se mergea

#### Scenario: Salteo declarado

- **WHEN** la tarea declara `red-check: skip: refactor, el comportamiento no cambia`
- **THEN** el check no corre y la razón aparece en el bloque de riesgo residual del reporte

### Requirement: El loop no puede modificar su propia señal de feedback

Después del primer intento en que `verify` devuelva exit 0, el runner SHALL registrar una huella
del contenido de cada archivo de test nombrado en `verify`. En todo intento posterior de la misma
tarea, el runner SHALL comparar esa huella antes de ejecutar `verify` y SHALL rechazar la tarea
si cambió.

#### Scenario: El test se debilita en el reintento

- **WHEN** un intento posterior modifica un archivo de test nombrado en `verify`
- **THEN** la tarea cierra en `out-of-scope` y no se mergea

#### Scenario: Refutación del verifier

- **WHEN** el verifier refuta la tarea y se dispara una re-implementación
- **THEN** la re-implementación tampoco puede modificar el archivo de test

### Requirement: Scope check

El runner SHALL comparar los archivos modificados por la rama de la tarea contra su base, y SHALL
rechazar la tarea cuando toque algún archivo no declarado en `files`.

#### Scenario: Tocó lo que no declaró

- **WHEN** la rama de la tarea modifica un archivo ausente de `files`
- **THEN** la tarea cierra en `out-of-scope`, no se mergea, y el reporte lista los archivos de más

### Requirement: Verifier de ola

Antes del merge de una ola, el runner SHALL invocar un checker fresco una única vez por ola,
pasándole los diffs de todas las tareas candidatas juntos, el spec delta del change y el registro
de decisiones de arquitectura del proyecto. El checker SHALL ser de solo lectura y SHALL devolver
un veredicto estructurado por tarea con un booleano de refutación, una razón de una oración y
evidencia que sea una referencia a archivo y línea o una salida de comando.

El checker SHALL responder, en orden: si el diff implementa el `proves` de la tarea o algo
adyacente; si la aserción prueba el requisito o solo reimplementa el código; si el diff rompe algo
que el gate no puede ver, incluyendo supuestos que otra tarea de la misma ola necesita; y si el
diff acumulado de la ola viola una decisión de arquitectura registrada.

La cuarta pregunta SHALL responderse sobre el diff acumulado de la ola y no tarea por tarea,
porque una violación entre archivos de tareas distintas es invisible desde cualquiera de ellas por
separado.

Una tarea refutada SHALL disparar como máximo una re-implementación, y el verifier SHALL correr
como máximo dos veces por ola, siempre dentro del tope total de intentos de cada tarea.

El checker SHALL correr bajo el modelo configurado en `checker-model`, que por default coincide
con el del implementer y que el usuario puede separar sin tocar código. Un checker que comparte
familia de modelo con quien escribió el código tiende a aceptar soluciones que se parecen a su
propio razonamiento; declarar `checker-model` distinto es la única mitigación disponible para la
pregunta (b), la única superficie del harness que sigue siendo juicio y no un exit code.

#### Scenario: Una ola de cinco

- **WHEN** cinco tareas de una ola pasan los checks deterministas
- **THEN** el checker se invoca una sola vez con los cinco diffs y devuelve cinco veredictos

#### Scenario: Refutación

- **WHEN** el checker refuta dos tareas de la ola
- **THEN** ambas re-implementan en paralelo y el checker vuelve a correr una vez sobre la ola

#### Scenario: Evidencia obligatoria

- **WHEN** el checker no puede señalar archivo y línea ni salida de comando
- **THEN** su veredicto no cuenta como refutación fundada y la razón queda registrada como tal

#### Scenario: Ante la duda, refuta

- **WHEN** el checker no está seguro de si el diff cumple el `proves`
- **THEN** refuta, porque un falso "pasa" cuesta más que un falso "refutado"

#### Scenario: Violación entre tareas de la misma ola

- **WHEN** dos tareas de una ola, cada una dentro de sus propios `files`, producen juntas una
  violación de una decisión de arquitectura registrada
- **THEN** el checker la detecta sobre el diff acumulado, aunque ningún implementer aislado en su
  worktree pudiera verla

#### Scenario: Diversidad de modelo por default

- **WHEN** el proyecto no declara `checker-model`
- **THEN** el checker corre con el mismo modelo que `model`, y el usuario puede separarlos
  declarando `checker-model` sin tocar código

### Requirement: El trinquete — una violación se convierte en regla

Cuando el checker encuentre una violación expresable como regla de linter, SHALL devolver junto a
su veredicto la regla propuesta, con su origen y su justificación. El checker SHALL NO escribir en
el proyecto: no posee ningún archivo y sus cambios estarían fuera del alcance de toda tarea.

Las reglas propuestas SHALL aparecer en el reporte del run. Incorporarlas al gate SHALL ser una
decisión humana o una tarea de un change posterior.

#### Scenario: Violación mecanizable

- **WHEN** el checker detecta una violación que una regla de linter puede atrapar
- **THEN** la propone en el reporte, y una vez incorporada al gate esa violación queda atrapada
  para siempre sin volver a necesitar un agente

#### Scenario: El costo de revisar baja con el tiempo

- **WHEN** el proyecto acumula changes
- **THEN** el gate atrapa cada vez más y el checker encuentra cada vez menos, porque cada
  violación mecanizable dejó una regla

#### Scenario: El checker no toca el proyecto

- **WHEN** el checker quiere aplicar la regla que propone
- **THEN** no puede, porque es de solo lectura y ningún archivo del proyecto está en su alcance

### Requirement: Gate y suite

El comando de gate configurado SHALL correr dentro de cada `verify`, y SHALL ser el lugar donde
crecen las reglas de arquitectura del proyecto. La suite configurada SHALL correr una vez por ola
sobre la rama del change, después del merge, siempre con concurrencia 1.

Toda restricción expresable como regla de linter SHALL expresarse como regla de linter y no como
prosa en el contrato del repo.

Cuando el proyecto declare un comando de chequeo caro, el runner SHALL correrlo una vez por ola
después de la suite, con concurrencia 1. Es el destino de los requisitos no funcionales que una
herramienta puede verificar pero que son demasiado lentos para correr dentro de cada `verify`.
Su fallo SHALL tratarse igual que una suite roja: el change se detiene.

#### Scenario: Trinquete

- **WHEN** se agrega una regla nueva al gate
- **THEN** todos los `verify` existentes se vuelven más estrictos sin que haya que tocarlos

#### Scenario: Cuello de botella deliberado

- **WHEN** la suite corre en el barrier
- **THEN** corre con concurrencia 1 aunque `jobs` sea mayor

#### Scenario: Chequeo caro con destino

- **WHEN** el triage clasifica un requisito no funcional como verificable por herramienta pero
  demasiado lento para cada `verify`
- **THEN** entra al comando de chequeo del barrier, y corre una vez por ola en vez de una vez por
  intento por tarea

#### Scenario: Sin chequeo caro declarado

- **WHEN** el proyecto no declara comando de chequeo del barrier
- **THEN** el barrier no corre ninguno y el paso no cuesta nada
