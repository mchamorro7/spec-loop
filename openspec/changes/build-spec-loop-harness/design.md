## Context

`spec-loop-v3.md` (v3.1) es el diseño de entrada. Este documento registra las decisiones
técnicas que lo corrigen o lo cierran, y solo esas — lo que v3.1 ya decidió bien no se
repite acá.

Restricción declarada por el usuario, en orden: **reloj primero, logrado con uso eficiente de
tokens; simplicidad sin over-engineering; cero argumentos en comandos y skills.**

Esa segunda restricción invierte una intuición común: el paralelismo compra reloj y **cuesta**
tokens. El ahorro de contexto viene de otro lado — contexto fresco por tarea, sin MCP en los
spawns, contrato de repo corto, el runner corriendo `verify` en vez del agente. Ninguna de esas
palancas necesita `jobs > 1`. Se construyen igual y primero.

## Goals / Non-Goals

**Goals:**

- Que el reloj de un change lo domine el trabajo, no la coordinación.
- Que ningún estado del run dependa de que un modelo lo narre.
- Que el loop no pueda modificar la señal contra la que se lo mide.
- Que la superficie de uso quepa en dos verbos sin argumentos.
- Que el runner se pueda leer entero de una sentada.

**Non-Goals:**

- Ser un framework. Es un archivo donde vive el `if`.
- Cubrir trabajo cuyo "listo" no sea un exit code determinista.
- Traer un planificador propio, conectores externos o contabilidad de tokens.
- Re-planificación autónoma. El work graph es estático a propósito.

## Decisions

### D1 · La orquestación es código, no prosa

Un script parte en olas, mergea y decide. Los agentes escriben código y refutan.

Se movió a código todo lo que un modelo hace mal y en silencio: disjunción de conjuntos sobre
quince tareas, la política ante fallo parcial, el chequeo de archivos declarados, el red check,
el estado del run y el presupuesto.

**Alternativa descartada:** un skill orquestador. Devuelve siete decisiones al terreno
probabilístico, y el error de cada una es silencioso.

### D2 · El loop no puede modificar su propia señal de feedback

Es la corrección más importante sobre v3.1, que se contradice a sí mismo: obliga a declarar los
archivos de test en `files` (con lo cual el scope check los permite) y a la vez le prohíbe al
implementer crearlos mediante una instrucción de prompt, mientras la tesis del documento asume
que los escribe.

El efecto neto era un loop de tres intentos optimizando `exit 0` con permiso de escritura sobre
el archivo que define `exit 0`. En el tercer intento, con dos fallas en contexto, el camino más
barato al objetivo está dentro de su propio `files`.

**Decisión:** el implementer puede crear el archivo de test en el primer intento. Cuando `verify`
devuelve exit 0 por primera vez, el runner registra una huella de ese archivo y la exige idéntica
en todo intento posterior, incluidas las re-implementaciones por refutación.

**Por qué así y no prohibiéndolo por prompt:** una garantía determinista no puede colgar de una
instrucción probabilística. Y el arreglo *saca* una regla del prompt en vez de agregarla.

### D3 · El red check garantiza menos de lo que v3.1 declara

v3.1 afirma que el red check caza mecánicamente un test que no asegura nada. **Solo es cierto
cuando el código revertido sigue compilando e importando.** Si la tarea crea un símbolo nuevo,
quitarlo rompe el import: el comando falla, el check da verde, y la aserción nunca se evaluó.

**Decisión:** se acepta el límite y no se construye un tercer estado "no concluyente".
Distinguir un fallo de compilación de un fallo de aserción exige parsear stderr por runner, es
frágil, y en un proyecto desde cero marcaría casi todo como no concluyente — honesto e inútil.

**Se cubre por otro lado:** el lint del test caza las formas concretas del test débil (sin
aserciones, mockea su propio módulo, solo aserciones de existencia, snapshot regenerable), de
forma determinista y sin red.

**Alternativa descartada:** mutation testing. Da la misma garantía a un costo mil veces mayor.

### D4 · El lint del test corre después de `verify`, no en el preflight

En un change desde cero el archivo de test no existe al momento del preflight: lo escribe el
implementer. Un chequeo sobre un archivo inexistente es un chequeo que no corre.

El orden dentro del pipeline de una tarea es: `verify` exit 0 → **commit del runner** → lint
del test → congelar la huella → red check → scope check. El commit va primero, no último: es
la corrección de D5.

### D5 · El runner commitea, no el implementer

El red check restaura archivos con git, así que solo funciona sobre trabajo commiteado — y el
scope check compara `<base>..<task-branch>` por ref, lo que también exige que exista un commit
en `task-branch`. Las dos verificaciones siguientes dependen de que el commit ya esté hecho, así
que el commit tiene que ser el primer paso después de `verify`, no el último: una versión previa
de este documento tenía el orden invertido, contradiciendo su propia razón de ser (queda
corregido en D4).

En v3.1 quien commitea es el implementer, por una instrucción de prompt: si la omite, el red
check destruye el trabajo en silencio y la tarea sale roja por una causa inventada.

El runner commitea al pasar `verify`, con un trailer de tarea y un trailer de requisito. El
trailer de requisito importa por separado: es la única parte de la trazabilidad que sobrevive al
archivado del change, porque el registro de eventos no se versiona.

### D6 · La base de cada ola es el HEAD de la rama del change

v3.1 crea los worktrees desde `<base>` sin decir que `<base>` avanza. Implementado literal, las
tareas de la ola 2 se ramifican de un árbol que no contiene la ola 1 y fallan todas al compilar.

`base` se relee al arrancar cada ola. De ahí cuelgan tres consecuencias que también se fijan: el
scope check compara contra la base de su propia ola, el red check restaura desde esa base, y el
resume tras una ola parcial la recalcula.

### D7 · El checker corre por ola, no por tarea

**Decisión más discutida del diseño.** Se evaluó eliminarlo por completo, porque de sus tres
preguntas dos ya tienen dueño: que el diff implemente el `proves` está cubierto por construcción
cuando el test se deriva del `proves`, y que rompa algo invisible al gate es exactamente para lo
que existe la suite post-merge. Quedaba una sola contribución exclusiva: la aserción que
reimplementa el código.

**Se mantiene**, por dos razones. El canon de loop engineering nombra el split maker/checker como
componente, no como opción — *"the agent that wrote the code is a poor judge of its own work"*.
Y una vez movido a nivel de ola, su costo cae lo suficiente como para que el argumento de
simplicidad deje de aplicar.

**Se mantiene a nivel de ola y no de tarea** porque una ola de cinco pasa de seis spawns de
verificación a dos, las re-implementaciones por refutación salen en paralelo, y la pregunta sobre
supuestos compartidos entre tareas de la misma ola **solo se puede contestar viendo los N diffs
juntos** — pedírsela a un checker que ve un diff aislado es gastar N veces sin poder acertar.

Absorbe al `architect` de v3.1: revisar el diff acumulado de una ola contra las decisiones de
arquitectura es la misma lectura.

**Dónde queda parado respecto del canon:** el canon pide que un modelo fresco decida si se cumplió
la condición de corte. Acá todo lo decidible por exit code lo decide un exit code, y el modelo
fresco decide únicamente lo que no lo es. Es el canon llevado más lejos, no una desviación.

### D8 · Cero argumentos: la configuración es del repo, no de la invocación

Los once flags de v3.1 no cambian entre corridas: describen la máquina y el apetito de gasto. Van
a `spec-loop.yaml`, tres claves obligatorias y cuatro con default que se agregan cuando haya
números del primer change.

El change tampoco se pasa: el orden de `roadmap.md` ya dice cuál sigue. Eso regala el encadenado
sin sintaxis nueva — correr el runner repetidamente avanza change por change y se corta solo en
el primero que no cierre limpio.

`spec-loop plan` desaparece como verbo: es la invocación pelada, porque planificar es el preflight
más imprimir, y el preflight ya corre en `run`.

**Lo que muere sin reemplazo:** seleccionar o excluir tareas por línea de comandos. `tasks.md` es
un archivo de texto del usuario; correr menos se hace ahí. Cero mecanismo.

### D9 · El gate y la suite son del proyecto, no del harness

v3.1 cablea npm en unas veinte partes, incluida una regla que exige que `verify` empiece con un
comando npm literal. Dos claves de configuración lo generalizan y **borran texto**: la regla pasa
a ser que `verify` empieza con el comando de gate configurado.

### D10 · El heartbeat es una línea de cron, no una feature

El canon nombra la cadencia como componente. El runner ya tiene las tres propiedades que la hacen
segura —es idempotente, resume desde el registro y se niega a reintentar sin un delta— así que
agendarlo es una línea en el planificador del sistema operativo. Construir uno adentro sería peor
que cron y contradice la restricción de no over-engineering.

Lo mismo con el aviso al terminar: exit code más archivo de reporte, y la notificación se cablea
afuera. Sin conectores externos, que además contradirían la decisión de no cargar MCP en los
spawns.

### D11 · Forma del runner: núcleo puro, borde con efectos

Un archivo, sin build, sin dependencias salvo `yaml`. Siete funciones puras (config, resolución
del change, parseo, preflight, particionado, firma de error, derivación de estado) y tres con
efectos (pipeline de tarea, barrier, reporte).

El particionado en olas **no recibe ni produce estado mutable**, nunca. Es la razón real por la
que se descarta el re-particionado dinámico: no es que sea complejo, es que convierte la única
función del harness testeable con una tabla en una máquina de estados.

Ese corte deja aproximadamente el setenta por ciento del runner testeable con fixtures de texto,
sin mocks, sin git y sin spawns. El harness que le exige `verify` a todo el mundo tiene el suyo.

### D12 · Bootstrap sobre sí mismo

El primer paso —parseo, preflight, particionado, invocación pelada y sus tests— se escribe a
mano. Del segundo en adelante, spec-loop se construye a sí mismo.

No es cosmético: es la única forma honesta de saber si el contrato de tarea sirve antes de
apostarle un proyecto real. Si no se puede escribir un `tasks.md` para el propio runner, el
formato está mal.

### D14 · El archivo de tareas es el de OpenSpec, extendido

v3.1 pone el input del runner exactamente donde la herramienta de specs pone su propia lista de
tareas, con un formato distinto. Es una colisión de ruta, no una convivencia.

**Decisión:** el input del runner **es** ese archivo, extendido de forma retrocompatible. Cada
tarea es una línea de checkbox seguida de un bloque `yaml`. Una instalación que no conozca
spec-loop sigue viendo una lista de tareas válida y trata el bloque como markdown.

**Alternativa descartada:** un archivo aparte para el runner. Deja dos listas de tareas por
change, duplicadas y capaces de divergir.

De la decisión salen tres consecuencias, y las tres simplifican:

1. **El identificador sale del checkbox y desaparece del bloque.** v3.1 lo tenía dos veces. El
   contrato pasa de seis campos a cinco y una clase entera de bug —que no coincidan— se vuelve
   imposible.
2. **Los encabezados agrupan por unidad funcional, nunca por ola.** El ejemplo de v3.1 declara
   olas sugeridas, pero las olas se calculan: un encabezado que las predice es una afirmación que
   el runner va a contradecir, e invita a descomponer pensando en el particionado en vez de en la
   feature.
3. **Contrato y progreso se separan, con flujo de una sola dirección.** El bloque `yaml` y la
   prosa son el contrato: los escribe la descomposición y el runner solo lee. El checkbox es
   progreso: es una proyección del registro de eventos, el runner solo escribe y jamás lee. Ante
   discrepancia prevalece el registro, igual que prevalece git.

Esa tercera consecuencia es la que hace que la decisión no contradiga el principio de que el
estado se deriva y no se narra: el checkbox no es una segunda fuente de verdad, es el mismo
render que imprime el comando de estado, persistido donde la herramienta de specs lo busca para
poder archivar. Y la detección de delta para reintentar cubre solo el contrato, así que el runner
marcando checkboxes nunca se confunde con un cambio de plan.

### D13 · Orden de construcción, cada paso deja algo usable

1. Parseo, preflight, particionado, invocación pelada, y los tests de las funciones puras. Sin
   agentes. Ya valida si la descomposición cortó bien, gastando cero.
2. Pipeline de una tarea con concurrencia 1: worktree, spawn, `verify` corrido por el runner,
   loop de intentos, firma de error, registro de eventos. **Acá ya hay un harness completo y
   determinista, sin paralelismo.**
3. Lint del test, red check, congelamiento de la huella, scope check.
4. Checker de ola, barrier con la política ante fallo parcial, concurrencia mayor a 1, estado y
   reporte.

Los skills de planificación no dependen del runner, solo del formato que fija el paso 1, así que
se pueden escribir en paralelo a todo esto.

### D15 · `checker-model`: diversidad de modelo, opt-in

v3.1 traía `--verifier-model` con el mismo argumento: *"la evidencia dice que el verifier gain
cae cuando solver y verifier son de la misma familia — los modelos aceptan soluciones que se
parecen a su propio razonamiento."* Al simplificar a cero flags el campo se perdió en el
camino, sin una decisión explícita que lo descartara — quedó afuera por omisión, no por análisis.

Una revisión honesta de [garrytan/gstack](https://github.com/garrytan/gstack) — plataforma
open-source de 214k líneas, sin relación con este proyecto — encontró que resolvió el mismo
problema por su cuenta: `/codex` pide una segunda opinión de un modelo distinto sobre el mismo
diff. Es validación independiente de una idea que ya estaba en el diseño original, no una idea
nueva importada de afuera.

**Decisión:** `checker-model`, clave opcional en `spec-loop.yaml`, default = valor de `model`.
Con el default, el checker corre en el mismo modelo que el implementer — cero diferencia de
comportamiento contra lo que ya existía. Declararla distinta es la única palanca disponible
contra la pregunta (b) del checker (*"¿la aserción prueba el requisito o solo reimplementa el
código?"*), que es la única superficie del harness que sigue siendo juicio.

**Por qué opt-in y no default-distinto:** cambiar el default habría sido una decisión de
producto no pedida — un modelo más caro corriendo por default en cada ola sin que nadie lo haya
elegido. Con el default en `model`, el usuario paga la diversidad solo cuando decide que la
pregunta (b) le importa lo suficiente.

**Por qué esto no contradice el resto del diseño:** gstack resuelve la MISMA pregunta con MÁS
peso en juicio de agente (heurísticas de atribución de fallos, coverage auto-evaluado, gates que
el mismo agente marca). Este harness la resuelve con MENOS: siete de sus ocho capas de
verificación ya son deterministas: `checker-model` refuerza la única que no lo es, en vez de
agregar una capa de juicio nueva.

### D16 · Revisor de change: el hueco cross-ola, cerrado con la misma pieza que ya existe

El checker de ola resuelve su pregunta (c) — *"¿rompe algo que el gate no puede ver?"* — mirando
los N diffs de **una** ola. Nunca ve la ola anterior, porque `taskDiffBlock` calcula el diff contra
`baseRef`, que D6 relee al arrancar cada ola. Una abstracción que la ola 1 crea y que la ola 3
duplica sin saberlo no la caza nada: no el gate (no tipa duplicación), no el checker de la ola 3 (no
vio el diff de la ola 1), no el reporte (cada tarea, mirada sola, está bien).

Revisando [aaif-goose/goose](https://github.com/aaif-goose/goose) — Linux Foundation, ex-Block,
2397 archivos, sin relación con este proyecto — para responder si paralelizar sin perder calidad
era un problema resuelto en otro lado, aparece la misma respuesta que ya había dado gstack:
`code-review.yaml` revisa el diff **completo de un PR contra la base**, una vez, con instrucciones
acotadas (*"don't add feedback outside the scope of the instructions"*, *"avoid nit-pick
comments"*). Es la tercera vez, en dos proyectos grandes e independientes, que aparece el mismo
patrón: verificar por unidad de trabajo no alcanza, hace falta una pasada sobre el diff acumulado.

**Decisión:** un revisor de change, no una pieza nueva — el mismo checker (mismo spawn, mismo
schema JSON, misma regla de evidencia obligatoria, mismo trinquete de proponer una regla de
linter), corriendo con un scope distinto y una cadencia distinta:

| | Checker de ola (ya existe) | Revisor de change (nuevo) |
|---|---|---|
| Cadencia | una vez por ola | **una vez por change**, sin importar cuántas olas hubo |
| Ve | los N diffs de la ola actual | el diff acumulado, base original → HEAD final |
| Bloquea merge | sí — refutar dispara un reintento | **no** — todo lo que revisa ya está mergeado |
| Efecto en el exit code | si | **ninguno** — es puramente informativo |
| Dónde aparece | veredicto por tarea | bloque de riesgo residual del reporte |

**Por qué no es una auditoría de seguridad ni un `/cso`:** el scope queda a propósito angosto —
¿el diff acumulado cumple el proposal como un todo?, ¿alguna ola duplicó algo que otra ya hizo?,
¿algo es mecanizable? Nada de OWASP, nada de UX, nada de performance: la frontera del harness
(§task-contract, "una tarea existe solo si su done es un exit code determinista") sigue vigente acá
también. Ensancharlo sería exactamente el over-engineering que este documento existe para evitar.

**Por qué el costo es marginal:** un spawn por change entero, no por ola — más barato que el propio
checker de ola en cualquier change de más de una ola.

## Risks / Trade-offs

| Riesgo | Trade-off aceptado |
|---|---|
| **La aserción que reimplementa el código** pasa gate, red check, scope check y suite | Es la única superficie probabilística que queda. La cubre el checker de ola, y se mide en los dos primeros changes: si aparece seguido, el `verify` está mal escrito, no el harness |
| **El red check no discrimina en tareas de símbolo nuevo** (D3) | Aceptado y documentado. Lo compensa el lint del test, determinista |
| **El barrier deja workers ociosos** si una tarea de la ola tarda mucho más que el resto | Es el precio de un árbol estable para mergear. Se mide; si se pasa del treinta por ciento, se parte la tarea larga en la descomposición, no se cambia el harness |
| **La suite es la cola serial de cada ola** y crece con el proyecto | Es el techo de escala real. Se mide como fracción del reloj total; si domina, el problema es la suite del proyecto |
| **El paralelismo puede no rendir**: puede costar más en tokens de lo que gana en reloj | Es un flag, no una arquitectura. Si el primer change muestra menos del doble de aceleración o más del cuádruple de costo, se vuelve a concurrencia 1 y **queda todo lo demás**: planificación, verificación mecánica, contrato de tarea y estado durable |
| **El implementer no puede preguntar en vuelo** | Explícito. Un agente que pregunta a mitad de turno serializa la ola. Puede declarar que le falta alcance y cerrar; dos o más de esos casos significan que el plan está mal, no las tareas |
| **Deuda de comprensión**: buenos loops producen más código del que se alcanza a leer | El reporte abre por lo no verificado y tiene un bloque de riesgo residual dedicado. Lo verde ya lo probó una máquina; lo que pide atención se señala |
| **El work graph es estático**: no hay re-planificación autónoma | Deliberado a este nivel de madurez. El interrupt humano reemplaza a la re-planificación, y el plan es descartable: dos tareas sin alcance mandan a rehacer la descomposición, no a parchear |
