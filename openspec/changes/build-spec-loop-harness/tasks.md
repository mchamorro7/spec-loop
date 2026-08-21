## 1. Bootstrap del repo del plugin

- [x] 1.1 Crear `package.json` con `bin: spec-loop → bin/spec-loop.mjs`, dependencia `yaml`, y los scripts `gate` y `test`
- [x] 1.2 Definir el gate del propio repo (`eslint` sobre `bin/` y `test/`) y dejarlo verde en vacío
- [x] 1.3 Crear el esqueleto de `bin/spec-loop.mjs` con la separación núcleo puro / borde con efectos (D11) y el despacho de los dos verbos más la invocación pelada
- [x] 1.4 Crear `test/` y confirmar que `pnpm test` corre y pasa sin tests

## 2. Núcleo puro y sus tests

- [x] 2.1 `config()`: leer `spec-loop.yaml`, exigir `gate`, `test` y `max-spend`, aplicar defaults de `jobs`, `max-attempts`, `timeout` y `model`; abortar nombrando la clave faltante
- [x] 2.2 `parse()`: `tasks.md` → lista de tareas; identificador desde la línea de checkbox, un bloque `yaml` por tarea, prosa hasta la tarea siguiente; rechazar campo desconocido, `id` dentro del bloque, bloque ausente o duplicado, indicando línea (D14)
- [x] 2.3 `resolve()`: change actual desde el orden de `roadmap.md`; fallback a change activo único; mensajes distintos para "nada que correr" y ambigüedad irresoluble
- [x] 2.4 `preflight()`: las ocho reglas verificables del contrato, incluida la validación de `proves` contra el spec delta; devolver todos los errores, no el primero
- [x] 2.5 `waves()`: particionado greedy, estable y **sin estado mutable**; detectar ola vacía y distinguir ciclo en `needs` de contención total
- [x] 2.6 `signature()`: normalizar stderr a una firma estable (primera línea de error, sin números de línea/columna ni rutas absolutas)
- [x] 2.7 Tests de `parse` con fixtures buenos y rotos, uno por modo de fallo
- [x] 2.8 Tests de `preflight`, uno por regla
- [x] 2.9 Tests de `waves` en tabla: disjuntas, contención, `needs`, ciclo, corte por capa
- [x] 2.10 Tests de `resolve` y de `signature`

## 3. Invocación pelada

- [x] 3.1 `spec-loop` sin verbo: preflight, imprimir las olas, imprimir los dos verbos al pie, salir sin gastar tokens
- [x] 3.2 Formato de impresión de olas legible, que haga evidente el corte por capa (una ola por tarea)
- [x] 3.3 Verificar el gate del proyecto sobre la base como primer paso del preflight, antes de crear ningún worktree

## 4. Pipeline de una tarea, con concurrencia 1

- [x] 4.1 Crear y limpiar el worktree y la rama por tarea; base = HEAD de la rama del change al arrancar la ola (D6)
- [x] 4.2 Spawn del implementer con presupuesto de contexto acotado: sin servidores de herramientas externas y sin cambiar credenciales, tope de turnos, timeout, permisos mínimos
- [x] 4.3 El runner corre `verify` en el worktree y usa su exit code como única señal
- [x] 4.4 Loop de intentos con tope total; inyección del error anterior truncado (primer bloque + últimas 20 líneas, tope 4 KB)
- [x] 4.5 Corte por firma repetida → `stuck`; corte por intentos agotados → `blocked`
- [x] 4.6 Detectar la señal de alcance insuficiente del implementer → `needs-scope`, sin más intentos
- [x] 4.7 `events.jsonl`: append-only, escrito solo por el runner, una entrada por transición
- [x] 4.8 Salida estándar en vivo: una línea por transición, sin volcar la salida cruda de los agentes

## 5. Checks mecánicos

- [x] 5.1 El runner commitea al pasar `verify`, con trailer de tarea y trailer de requisito (D5) — primero: red check y scope check dependen de que el commit ya exista
- [x] 5.2 Lint del test después del commit: archivo inexistente, sin aserciones, mockea un módulo de su propio `files`, solo aserciones de existencia, snapshot regenerable → `test-lint-failed`
- [x] 5.3 Congelar la huella de los archivos de test tras el primer `verify` exit 0 y exigirla idéntica en todo intento posterior (D2)
- [x] 5.4 Red check dentro del worktree: quitar los `files` no nombrados en `verify`, correr `verify`, restaurar desde el commit; exit 0 → `red-check-failed`
- [x] 5.5 Honrar `red-check: skip` con razón y registrarla para el bloque de riesgo residual
- [x] 5.6 Scope check contra la base de la ola; archivos de más → `out-of-scope` con la lista
- [x] 5.7 Test de integración del red check y del congelamiento contra un repo git descartable

## 6. Checker de ola y barrier

- [x] 6.0 Agregar `checker-model` a `loadConfig()`: opcional, default = `model` (D15)
- [x] 6.1 Spawn del checker una vez por ola bajo `checker-model`, de solo lectura, sin permiso de exploración, con los N diffs, el spec delta y `architecture.md` entregados por entrada; veredicto estructurado por tarea y regla de linter propuesta cuando la violación sea mecanizable
- [x] 6.2 Refutación → una re-implementación por tarea refutada, en paralelo, dentro del tope total de intentos; máximo dos pasadas de checker por ola
- [x] 6.3 Barrier: merge de las verificadas en orden de `id`; conflicto → detener el change y reportarlo como bug del harness
- [x] 6.4 Suite del proyecto sobre la rama del change, siempre con concurrencia 1; roja → detener el change sin revertir nada. Después, correr el comando de chequeo caro si está declarado, con la misma política
- [x] 6.5 Propagar bloqueo por clausura de `needs` sobre tareas rojas y recalcular las olas restantes
- [ ] 6.6 Habilitar concurrencia mayor a 1 con un pool del tamaño de `jobs`

## 7. Estado, reporte y salida

- [ ] 7.1 `derive()`: estado del run desde `events.jsonl`; cruzar contra las ramas del change y hacer prevalecer git ante discrepancia
- [ ] 7.2 `spec-loop status`: imprimir el estado derivado
- [ ] 7.3 Resume: saltear lo cerrado y continuar; correr de más no rehace trabajo
- [ ] 7.4 Negarse a reintentar tareas rojas si no cambió el contrato de alguna tarea ni la base; el hash del contrato cubre los bloques `yaml` y la prosa, nunca los checkboxes (D14)
- [ ] 7.5 Proyectar el progreso marcando el checkbox de cada tarea mergeada, sin leerlo nunca y sin tocar el bloque `yaml` ni la prosa
- [ ] 7.6 Acumular costo en dólares por spawn y detener al superar el techo, terminando la ola en curso sin matar spawns en vuelo
- [ ] 7.7 Reporte en el orden rojo → riesgo residual → advertencias → verde → totales, a la salida estándar y a un archivo del change
- [ ] 7.8 Exit codes por tipo de fallo, distinguiendo preflight, tareas rojas, change detenido y techo de gasto agotado

## 8. Agentes

- [ ] 8.1 `agents/implementer.md`: un intento, una tarea, sin auto-evaluación, sin commitear, sin tocar lo que no posee, señal explícita de alcance insuficiente, y los dos guardrails de prompt (no asumir que algo no está implementado; nada de placeholders ni stubs)
- [ ] 8.2 `agents/verifier.md`: refutar en vez de revisar, solo lectura, orden de lectura obligatorio, las CUATRO preguntas incluida la de decisiones de arquitectura sobre el diff acumulado, evidencia como referencia a archivo y línea o salida de comando, y el trinquete: proponer la regla de linter sin escribirla

## 9. Skills de planificación

- [ ] 9.1 `skills/task-contract/SKILL.md`: la gramática extendida sobre el formato de OpenSpec, los cinco campos, las ocho reglas verificables y las cuatro de composición, más el recetario de `verify` por forma de tarea y los olores con su cazador
- [ ] 9.2 `skills/roadmap/SKILL.md`: divergir, pausa de recorte, riesgos que matan el proyecto, walking skeleton, corte en changes por riesgo, triage de NFR, y `roadmap.md` con lo recortado adentro
- [ ] 9.3 `skills/propose/SKILL.md`: brainstorm con pausa de camino, resolución de supuestos por las tres puertas, pausa condicional de arquitectura, derivación del `verify` desde el spec delta, descomposición con ola 0, y cierre corriendo la invocación pelada del runner
- [ ] 9.4 Verificar que `propose` no pueda cerrar con un supuesto sin resolver ni con un NFR de juicio convertido en tarea

## 10. Templates, manifiesto y documentación

- [ ] 10.1 `templates/spec-loop.yaml` con las tres claves obligatorias, las cinco opcionales con default y `barrier` comentada
- [ ] 10.2 `templates/CLAUDE.md` bajo cien líneas, solo restricciones de juicio; lo chequeable va al gate
- [ ] 10.3 `templates/settings.json` con permisos y modelo
- [ ] 10.4 `.claude-plugin/plugin.json`
- [ ] 10.5 `README.md`: setup de cero al primer change, runbook, el patrón de heartbeat por planificador del sistema operativo, el aviso al terminar por exit code y archivo de reporte, y pnpm como prerequisito
- [ ] 10.6 Documentar las métricas y el criterio de abandono, incluida la fracción del reloj que consume la suite

## 11. Validación del harness sobre sí mismo

- [ ] 11.1 Escribir un `tasks.md` en formato de contrato para los grupos 5 a 7 y confirmar que el particionado produce olas con más de una tarea
- [ ] 11.2 Correr el harness sobre sí mismo desde el grupo 5 en adelante y registrar aceleración, costo por tarea cerrada y tasa de éxito al primer intento
- [ ] 11.3 Contrastar esos números contra el criterio de abandono y dejar la conclusión escrita
