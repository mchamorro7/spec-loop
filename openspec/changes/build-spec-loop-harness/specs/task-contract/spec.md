## Purpose

Define la gramática de `tasks.md`, el único input del runner, y las reglas que hacen que una
tarea sea ejecutable de forma desatendida: qué demuestra, qué archivos posee y qué comando
prueba que está lista.

## ADDED Requirements

### Requirement: Gramática de `tasks.md`

`tasks.md` SHALL ser un archivo de tareas de OpenSpec extendido, de modo que una instalación de
OpenSpec sin spec-loop lo siga leyendo como una lista de tareas válida.

Cada tarea SHALL ser una línea de checkbox `- [ ] <id> <descripción>` seguida de exactamente un
bloque fenced `yaml`. El identificador de la tarea SHALL derivarse de la línea de checkbox y
SHALL NO declararse dentro del bloque. El texto en prosa entre el bloque y la tarea siguiente
SHALL pasarse al implementer sin modificar.

Los encabezados `##` SHALL agrupar tareas por unidad funcional y SHALL NO declarar olas: las olas
las calcula el runner.

El bloque `yaml` SHALL admitir exactamente cinco campos: `proves`, `files`, `verify`
(obligatorios), `needs` y `red-check` (opcionales). Un campo desconocido SHALL rechazar el
archivo.

#### Scenario: Tarea bien formada

- **WHEN** una línea de checkbox va seguida de un bloque `yaml` con `proves`, `files` y `verify`
- **THEN** el runner la parsea, toma su identificador del checkbox y la incluye en el plan de olas

#### Scenario: Compatibilidad hacia atrás

- **WHEN** una herramienta que no conoce spec-loop lee `tasks.md`
- **THEN** ve una lista de tareas de OpenSpec válida y trata los bloques `yaml` como markdown

#### Scenario: `id` declarado en el bloque

- **WHEN** un bloque `yaml` declara un campo `id`
- **THEN** el runner aborta, porque el identificador tiene una única fuente y es el checkbox

#### Scenario: Campo desconocido

- **WHEN** una tarea declara un campo que no es uno de los cinco
- **THEN** el runner aborta antes de spawnear nada e indica el campo y el número de línea

#### Scenario: Bloque yaml ausente o duplicado

- **WHEN** una línea de checkbox no va seguida de exactamente un bloque fenced `yaml`
- **THEN** el runner aborta e indica el número de línea

#### Scenario: Encabezado que declara una ola

- **WHEN** un encabezado `##` nombra una ola en vez de una unidad funcional
- **THEN** el runner lo ignora, porque el particionado no se declara

### Requirement: Semántica de los campos

El identificador tomado del checkbox SHALL ser único dentro del change y SHALL ordenar las olas y
los desempates.
`proves` SHALL nombrar el requisito del spec delta que la tarea demuestra.
`files` SHALL listar rutas exactas, o una única ruta terminada en `/**` que la tarea posee
entera, e SHALL incluir los archivos de test.
`verify` SHALL ser un comando de shell que empieza con el comando de gate configurado.
`needs` SHALL ser una lista de ids y su default SHALL ser la lista vacía.
`red-check` SHALL ser `auto` o `skip: <razón>`, con default `auto`.

#### Scenario: `red-check: skip` sin razón

- **WHEN** una tarea declara `red-check: skip` sin texto de razón
- **THEN** el runner aborta e indica la tarea

#### Scenario: `needs` ausente

- **WHEN** una tarea no declara `needs`
- **THEN** el runner la trata como sin dependencias y candidata a la primera ola

### Requirement: Reglas verificables antes de gastar

El runner SHALL rechazar `tasks.md` antes de spawnear ningún agente cuando se viole cualquiera
de estas reglas:

1. `verify` no empieza con el comando de gate configurado.
2. Los archivos de test de la tarea no aparecen nombrados dentro de `verify`.
3. `red-check: skip` no lleva razón escrita.
4. El change declara más de quince tareas.
5. Existe un ciclo en `needs`.
6. Un identificador de checkbox está duplicado.
7. Un `needs` referencia un identificador inexistente.
8. `proves` no referencia un requisito presente en el spec delta del change.

Que un archivo escrito por la tarea no esté declarado en `files` SHALL NO ser una regla de
preflight: no hay código todavía, así que es inverificable antes de spawnear. Esa regla SHALL
verificarse en tiempo de ejecución mediante el scope check, contra el diff real de la rama de la
tarea.

#### Scenario: `verify` sin el gate

- **WHEN** una tarea declara `verify: pnpm test -- src/x.test.ts` sin el gate por delante
- **THEN** el runner aborta, nombra la regla violada y la tarea

#### Scenario: `proves` cuelga

- **WHEN** `proves` referencia `FR7` y el spec delta del change no contiene `FR7`
- **THEN** el runner aborta e indica que la trazabilidad está rota

#### Scenario: Más de quince tareas

- **WHEN** `tasks.md` declara dieciséis tareas
- **THEN** el runner aborta e indica que el alcance corresponde a `roadmap`, no a un change

### Requirement: Reglas de composición que el runner no puede verificar

Las siguientes reglas SHALL documentarse en el skill `task-contract` y SHALL ser
responsabilidad de `propose`, porque no son verificables mecánicamente:

- **Ola 0 de contratos.** Si dos tareas nombran un símbolo que todavía no existe (un tipo, una
  interfaz, un schema, una firma), ese símbolo SHALL ser una tarea propia, serial y previa.
- **Archivos compartidos.** Barrels, tablas de rutas, contenedores de inyección, el manifiesto
  de paquetes y el lockfile SHALL ser tocados por una única tarea de la ola 0. Las dependencias
  nuevas SHALL instalarse en la ola 0.
- **Recursos globales.** `verify` no SHALL depender de un puerto fijo, un nombre de base de
  datos fijo, un directorio temporal fijo ni ningún otro recurso con nombre global, porque N
  comandos `verify` corren en paralelo.
- **Frontera del harness.** Una tarea SHALL existir solo si su condición de listo es un exit
  code determinista bajo concurrencia. Performance, apariencia visual e integración contra un
  servicio externo real SHALL registrarse como NFR de juicio y SHALL NO convertirse en tareas.

#### Scenario: Declarar de más versus declarar de menos

- **WHEN** `propose` duda sobre si un archivo pertenece a `files`
- **THEN** lo declara, porque declarar de más solo cuesta paralelismo y declarar de menos
  cuesta la tarea entera
