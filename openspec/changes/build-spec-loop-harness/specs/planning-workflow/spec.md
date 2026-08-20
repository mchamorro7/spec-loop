## Purpose

Define la capa donde el juicio es el trabajo: cómo una iniciativa se corta en changes, cómo un
change se convierte en `tasks.md`, y dónde exactamente el harness le pide una decisión a un
humano en vez de tomarla en silencio.

## ADDED Requirements

### Requirement: Frontera entre planificar y ejecutar

La planificación SHALL correr en sesión interactiva y la ejecución SHALL correr como proceso.
Todas las pausas humanas SHALL ocurrir antes de que exista `tasks.md`. Una vez que existe, el run
SHALL NO preguntar nada hasta el reporte final.

#### Scenario: Frontera respetada

- **WHEN** `propose` cierra `tasks.md`
- **THEN** el usuario puede irse, y ninguna decisión pendiente lo espera durante el run

### Requirement: Las tres pausas humanas

El harness SHALL detenerse y pedir una decisión humana exactamente en tres puntos: recortar el
alcance de la iniciativa, elegir el camino de la feature, y decidir una cuestión de arquitectura
que la feature fuerza y que no está registrada.

La tercera pausa SHALL ser condicional: si la decisión ya está registrada, no ocurre.

#### Scenario: Decisión ya registrada

- **WHEN** la feature depende de una decisión de arquitectura ya registrada
- **THEN** `propose` no pausa y sigue

#### Scenario: Decisión nueva

- **WHEN** la feature fuerza una decisión de arquitectura no registrada
- **THEN** `propose` se detiene, muestra la decisión y la alternativa, y no sigue hasta que el
  humano elija

### Requirement: Roadmap de una iniciativa

El skill de roadmap SHALL divergir antes de converger: producir capacidades, requisitos
funcionales, requisitos no funcionales, supuestos y riesgos; pausar para que el humano recorte;
ordenar los changes por riesgo y no por valor; y producir un roadmap donde cada change ocupa una
línea sin detalle.

El roadmap SHALL registrar también lo recortado y por qué.

#### Scenario: Amplitud al planificar

- **WHEN** el skill de roadmap explora la iniciativa
- **THEN** diverge a propósito, porque el sesgo hacia el camino más chico corresponde a `propose`
  y no a este nivel

#### Scenario: Detalle diferido

- **WHEN** el roadmap declara siete changes
- **THEN** ninguno lleva detalle, porque los primeros seis van a enseñar cosas que hoy no se saben

### Requirement: Los supuestos no quedan colgados

`propose` SHALL NO cerrar su fase de exploración con un supuesto sin resolver. Cada supuesto SHALL
salir por una de tres puertas: verificado con evidencia concreta; convertido en una tarea de ola 0
cuyo `verify` es la respuesta; o acotado como apuesta explícita con el costo de revertirla escrito.

#### Scenario: Supuesto verificable ahora

- **WHEN** un supuesto se puede chequear con un comando o leyendo documentación
- **THEN** queda registrado como verificado con la evidencia concreta

#### Scenario: Supuesto no verificable sin código

- **WHEN** un supuesto no se puede verificar sin escribir código
- **THEN** se convierte en una tarea de ola 0

#### Scenario: Supuesto acotado

- **WHEN** verificar un supuesto cuesta más que equivocarse
- **THEN** queda registrado como apuesta, con qué pasa si es falso y cuánto cuesta revertir

### Requirement: Derivación del `verify` de cada tarea

`propose` SHALL derivar cada `verify` desde el spec delta y no inventarlo: el criterio observable
del delta produce el `proves`, el `proves` produce el test, y el test produce el comando.

Si no se puede escribir el test a partir del `proves` sin inventar detalles, el `proves` no es
observable, y eso SHALL tratarse como un defecto del spec delta y no de la implementación.

#### Scenario: `proves` no observable

- **WHEN** no se puede derivar un test desde el `proves` sin inventar detalles
- **THEN** `propose` vuelve a la fase de spec en vez de escribir el comando igual

#### Scenario: Auditoría del comando

- **WHEN** `propose` escribe un `verify`
- **THEN** contesta cuál sería la implementación mínima e incorrecta que lo pasaría, y lo reescribe
  si la respuesta es un stub

### Requirement: Triage de requisitos no funcionales

Cada requisito no funcional SHALL clasificarse en el momento en que se escribe: si una herramienta
lo puede chequear barato, SHALL convertirse en regla del gate; si lo puede chequear caro, SHALL
convertirse en un chequeo del barrier; si ninguna herramienta lo puede chequear, SHALL quedar
registrado como guía de diseño y SHALL NO convertirse en tarea.

#### Scenario: NFR mecánico

- **WHEN** un NFR se puede expresar como regla de linter
- **THEN** entra al gate y desde ese momento lo corre cada `verify` de cada tarea futura

#### Scenario: NFR de juicio

- **WHEN** un NFR no es chequeable por ninguna herramienta
- **THEN** queda registrado como guía de diseño, aparece en el bloque de riesgo residual del
  reporte, y nadie pretende verificarlo automáticamente

### Requirement: Las decisiones de arquitectura arrancan vacías

El registro de decisiones de arquitectura del proyecto SHALL empezar sin ninguna decisión tomada y
SHALL crecer solo cuando una feature fuerce una. Cada entrada SHALL declarar el disparador, la
decisión, la alternativa descartada y, cuando exista, la regla mecánica que la hace cumplir.

Una decisión sin alternativa nombrable SHALL NO registrarse, porque es una preferencia.

#### Scenario: Día cero

- **WHEN** se inicia un proyecto nuevo
- **THEN** lo único que se define es el gate; las capas, los límites y dónde vive la policy no se
  deciden todavía

#### Scenario: Decisión con mecánica

- **WHEN** una decisión de arquitectura se puede expresar como regla de linter
- **THEN** se escribe la regla, y la entrada pasa a documentar el porqué en vez de ser una
  restricción que alguien tiene que recordar

### Requirement: Cierre de la descomposición

`propose` SHALL cerrar su fase de descomposición corriendo el runner en modo de solo planificar.
Si el particionado produce una ola por tarea, SHALL volver a descomponer antes de cerrar.

#### Scenario: Corte por capa

- **WHEN** el particionado devuelve una ola por tarea
- **THEN** `propose` vuelve a la descomposición, porque cortó por capa y no por feature vertical

#### Scenario: Alcance excedido

- **WHEN** la feature da más de quince tareas
- **THEN** `propose` se detiene y manda a `roadmap`, en vez de escribir un change gigante
