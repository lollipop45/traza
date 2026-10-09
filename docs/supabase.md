# Supabase en TRAZA

## Variables de entorno

En `.env.local` (ignorado por Git mediante `.env*`):

| Variable | Uso |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clave publicable (`sb_publishable_…`) |

Ambas son públicas por diseño: lo que protege los datos es RLS, no la clave. **Nunca** añadas una clave secreta / `service_role` con prefijo `NEXT_PUBLIC_` ni la importes en código de cliente. La única clave secreta (`SUPABASE_SECRET_KEY`, `sb_secret_…`) la usa solo el programador de producción (`lib/supabase/admin.ts`, ver [docs/production.md](production.md)); la app interactiva nunca.

## Clientes

- `lib/supabase/server.ts` → `createClient()` asíncrono para Server Components, Server Actions y Route Handlers (cookies vía `next/headers`). Crear uno por petición.
- `lib/supabase/proxy.ts` → `updateSession()`, usado por `proxy.ts` (Next 16 renombró `middleware.ts`).
- `lib/supabase/admin.ts` → cliente privilegiado, solo para el programador de producción.

No hay cliente de Supabase en el navegador: todas las lecturas y escrituras pasan por el servidor con la sesión del usuario. Los clientes usan el tipo generado `Database`.

## Autenticación

Correo + contraseña con Supabase Auth y sesiones en cookies (`@supabase/ssr`). Sin registro público ni proveedores OAuth.

- `proxy.ts` → en cada petición (salvo estáticos) refresca la sesión con `getClaims()` y aplica las rutas: sin sesión todo redirige a `/login`; con sesión, `/login` redirige a `/`. Rutas públicas en `lib/auth/routes.ts`.
- `app/(app)/layout.tsx` → segunda capa: verifica las claims en el servidor (`requireUser()`) antes de renderizar Inicio, Calendario, Inbox, Proyectos, Asistente y Ajustes.
- `lib/auth/actions.ts` → Server Actions `signIn` (mensaje de error único, no revela si el correo existe) y `signOut` (revoca la sesión de este dispositivo).
- Identidad: siempre `getClaims()` (JWT verificado), nunca `getSession()`.
- Las Server Actions que lean o escriban datos deben llamar a `requireUser()`: el proxy no basta.

### Pasos en el panel de Supabase

1. **Authentication → Sign In / Providers → Email**: desactivar *Allow new users to sign up* (la API pública permitiría registrarse aunque no haya página `/signup`).
2. **Authentication → Users → Add user → Create new user**: correo + contraseña, marcando *Auto Confirm User*.

## Migraciones

El esquema vive en `supabase/migrations/*.sql` y se versiona con el repositorio. El CLI está fijado como dependencia de desarrollo (`supabase`).

```bash
npx supabase login                         # una vez; abre el navegador
npx supabase link --project-ref <ref>      # una vez; <ref> está en la URL del panel; pide la contraseña de la BD
npm run db:push -- --dry-run               # revisa qué se aplicará
npm run db:push                            # aplica las migraciones pendientes
```

Nueva migración: `npm run db:new -- <nombre>` (nunca inventes el nombre del fichero a mano). No edites migraciones ya aplicadas; crea una nueva.

Alternativa sin CLI: pegar el SQL del fichero en el SQL Editor del panel. Funciona, pero no queda registrado en el historial de migraciones; preferir `db push`.

## Tipos de base de datos

Tras aplicar las migraciones (requiere `link`):

```bash
npm run db:types    # genera lib/supabase/database.types.ts
```

Los clientes se tipan con `createServerClient<Database>(…)` e `import type { Database } from "./database.types"`. Los tipos generados no se escriben a mano. En Windows, ejecutar el script desde `npm run` (usa cmd) y no con redirección de PowerShell, que escribe UTF-16.

## Comprobación

La conexión se comprueba usando la aplicación: con `npm run dev`, inicia sesión en `/login` y crea una tarea en Inicio. RLS, privilegios y claves foráneas por dueño se verifican con `npm run test:db` (usuarios ficticios A y B, anónimo, `service_role`). TRAZA no tiene rutas de diagnóstico (`/dev/*` no existe).

## Pruebas

```bash
npm test          # todas
npm run test:unit # validación y lógica pura (sin base de datos)
npm run test:db   # aplica supabase/migrations/*.sql a un Postgres en memoria (PGlite) con stubs de Supabase
```

Las pruebas de base de datos no usan red ni credenciales: comprueban restricciones, RLS, privilegios y la relación tareas → proyectos como usuarios ficticios A y B.

## Relación tareas → proyectos

`tasks (project_id, user_id) → projects (id, user_id)` (`tasks_project_owner_fkey`). Al referenciar el par, el proyecto debe tener el **mismo dueño** que la tarea: una clave simple a `projects.id` permitiría enlazar el proyecto de otro usuario, porque las comprobaciones de claves foráneas no pasan por RLS. `ON DELETE SET NULL (project_id)`: borrar un proyecto conserva sus tareas, sin proyecto.

## Calendario

`public.calendar_events` (`20261005162926_create_calendar_events.sql`):

- **Fechas y horas locales**: `event_date date` + `start_time` / `end_time time` (sin zona horaria) guardan la hora de pared de Atlantic/Canary tal como se escribe; ninguna conversión UTC puede mover un evento de día u hora. Eventos de todo el día: `all_day = true` y sin horas. La importación de Google Calendar convierte sus instantes a hora de Canarias al escribir.
- **Proyecto**: misma clave compuesta que las tareas (`calendar_events_project_owner_fkey`); borrar el proyecto conserva el evento sin proyecto.
- **Importaciones**: índice único `(user_id, source, external_id)` cuando hay `external_id`. Los clientes no pueden escribir `source` ni `external_id`: los eventos manuales son siempre `manual` y las integraciones (Google Calendar) escriben desde el servidor.
- **Entregas**: las tareas con `due_date` **no** se copian a esta tabla. El calendario combina al renderizar los eventos y las tareas con fecha (`lib/calendar/items.ts`, modelo `CalendarItem`).
- **Inicio**: "Próximos eventos" muestra solo los eventos de hoy (todo el día primero, luego por hora); las tareas siguen en su sección.

## Inbox

`public.inbox_items` (`20261005165232_create_inbox_items.sql`) guarda **solo ideas y notas** (`kind` = `idea` | `note`). Título y contenido son opcionales, pero nunca ambos vacíos. Mismo patrón que el resto: dueño por defecto `auth.uid()`, RLS de dueño, clave compuesta al proyecto (`ON DELETE SET NULL (project_id)`), índice único `(user_id, source, external_id)` y sin escritura de cliente en `source` / `external_id`.

Las tareas **no** se duplican: una tarea capturada en el Inbox es una fila de `public.tasks` (misma ruta de escritura que la captura rápida de Inicio, `lib/tasks/mutations.ts`). La pantalla combina `tasks` e `inbox_items` al renderizar (`lib/inbox/feed.ts`, modelo `InboxEntry`), de más reciente a más antiguo.

## Canvas (Campus Virtual) · solo lectura

Variables **solo de servidor** (sin prefijo `NEXT_PUBLIC_`), en `.env.local` durante el desarrollo:

| Variable | Uso |
| --- | --- |
| `CANVAS_BASE_URL` | Dirección https del campus, p. ej. `https://campus.example.edu` (sin `/api/v1`). |
| `CANVAS_ACCESS_TOKEN` | Token de acceso personal de Canvas. Equivale a tu cuenta: **nunca** lo subas al repositorio, no lo pegues en chats ni capturas. |

Obtener el token: en Campus Virtual → **Cuenta → Configuración → Integraciones aprobadas → + Nuevo token de acceso**, con una finalidad ("TRAZA") y una fecha de caducidad; cópialo en ese momento (Canvas no vuelve a mostrarlo). Reinicia `npm run dev` tras editar `.env.local`. Para revocarlo, bórralo en esa misma pantalla.

Comprobación: `/projects/canvas` (con sesión de TRAZA) muestra el estado de la conexión y tus cursos activos. Llamadas usadas: `GET /api/v1/users/self` y `GET /api/v1/courses?enrollment_state=active&include[]=term&per_page=100` (paginación por la cabecera `Link`). No se escribe nada en Supabase.

**Vinculación de cursos** (`/projects/canvas`, enlace "Campus" en Proyectos): cada curso de Canvas se identifica por su **ID de Canvas**, nunca por el nombre. Para cada curso decides: vincularlo a un proyecto existente, crear un proyecto desde él (operación atómica, función `create_project_from_canvas_course`, SECURITY INVOKER) o ignorarlo. Las decisiones viven en `public.canvas_course_links` (`linked` con proyecto / `ignored` sin proyecto; sin fila = sin vincular), con instantánea del nombre y código del curso. Antes de guardar, el servidor vuelve a leer tus cursos de Canvas y solo acepta un ID que esté ahí; el nombre y el código salen de esa respuesta, nunca del navegador. Borrar un proyecto borra sus vínculos (el curso vuelve a "sin vincular"). El token de Canvas nunca se guarda en la base de datos.

### Sincronización de entregas (manual)

En `/projects/canvas`, bloque **Entregas de Campus**: **Vista previa** (lee Canvas y tus tareas, no escribe nada) y **Sincronizar Campus** (importa / actualiza). No hay sincronización automática ni en segundo plano.

Flujo (`lib/canvas/sync.ts`, acciones en `lib/canvas/sync-actions.ts`):

1. Verifica la sesión de TRAZA.
2. Lee tus cursos activos de Canvas en el servidor y construye el conjunto de IDs reales.
3. Carga tus vínculos y se queda con los `linked` cuyo curso está en ese conjunto. Un vínculo que Canvas ya no devuelve se omite, se informa y **se conserva**. Cursos ignorados o sin vincular nunca se sincronizan.
4. Por curso: `GET /api/v1/courses/:id/assignments?include[]=submission&order_by=due_at&per_page=100`, todas las páginas (`Link`, mismo origen, límite de 20 páginas).
5. Filtra y escribe con `sync_canvas_course_tasks` (lotes de 200). Un curso que falla no detiene los demás.

**Filtro de relevancia** (hoy = día en Atlantic/Canary): nunca entregas no publicadas (`published = false` o `workflow_state` unpublished/deleted); con fecha, solo si vencen hoy − 30 días o después; sin fecha, solo si Canvas las creó en los últimos 180 días y no están cerradas (`lock_at`) antes de hoy. Las ilegibles (sin id, sin nombre, fecha que no es un instante con zona) se omiten y se cuentan.

**Una entrega de Canvas no es automáticamente una tarea.** La API de entregas también devuelve columnas de notas ("NOTAS FINALES AUDS") y asistencia ("Roll Call Attendance"). Tras el filtro anterior, `lib/canvas/classify.ts` clasifica cada entrega con `submission_types` y el título normalizado (sin mayúsculas, acentos, signos ni etiquetas iniciales tipo "[C.E]"); gana la primera regla:

1. Título exactamente "Roll Call Attendance" → **omitida** (asistencia).
2. Título de notas ("Notas", "Calificaciones", o "Nota(s)/Calificación(es)" + final/parcial/media/global/definitiva/ordinaria/extraordinaria…) o de asistencia ("Asistencia", "Control de asistencia", "Attendance"…) **sin** entrega de estudiante → **omitida**; con entrega de estudiante → **revisar** (señales contradictorias). "Notas de campo" o "Entrega de notas" no cuentan como notas.
3. Entrega de estudiante (`online_upload`, `online_text_entry`, `online_url`, `media_recording`, `student_annotation`, `online_quiz`, `discussion_topic`) → **se importa**.
4. `external_tool` → se importa.
5. `on_paper` → se importa con fecha (examen o entrega presencial); sin fecha → revisar.
6. Solo `none` / `not_graded`, lista vacía, tipos desconocidos o sin `submission_types` → **revisar**. Nunca se importa en silencio.

Las palabras "examen", "parcial", "práctica", "actividad" o "quiz" nunca excluyen nada. `grading_type`, `points_possible` y `omit_from_final_grade` se leen pero no deciden: un examen real puede no puntuar o quedar fuera de la nota final.

**Decisiones por entrega** (`public.canvas_assignment_preferences`, `20261006082922`): `ignored` (no se importa nunca; ignorarla quita su tarea) o `included` (importar un elemento de "Revisar"); sin fila = clasificación automática. Identidad: usuario + curso + entrega de Canvas (IDs, nunca títulos), única; RLS de dueño; sin acceso anónimo. La función `set_canvas_assignment_preference` (SECURITY INVOKER) guarda la decisión y, al ignorar, borra en la misma transacción la tarea `canvas` del usuario con ese `external_id`; nunca una tarea manual. `sync_canvas_course_tasks` además se niega en la base de datos a recrear una entrega ignorada. "Restaurar" borra la decisión: no crea la tarea, la entrega vuelve a ser elegible en la siguiente vista previa / sincronización.

La vista previa agrupa: **Revisar** (Importar / Ignorar), **Importadas · revisar** (tareas ya creadas que hoy no se importarían; nunca se borran solas: "Ignorar en TRAZA"), **Se importarán**, **Omitidas automáticamente** (con motivo) y un recuento de ignoradas por ti y antiguas. Las decisiones guardadas se ven en `/projects/canvas` › "Entregas decididas por ti". Importar / Ignorar desde la vista previa vuelve a leer la entrega en Canvas en el servidor; "Ignorar en TRAZA" desde una tarea usa su propio `external_id`.

**Una entrega = una fila de `public.tasks`** (`source = 'canvas'`), sin tabla aparte: Inicio, Calendario, Inbox y los recuentos de Proyectos la muestran sin copias, con la marca discreta "CAMPUS". `external_id = course:<idCurso>:assignment:<idEntrega>`, construido por la base de datos; el índice único `(user_id, source, external_id)` impide duplicados (sincronizar diez veces deja una tarea por entrega, también con ejecuciones simultáneas: `INSERT … ON CONFLICT`).

| Campo | Dueño |
| --- | --- |
| `title`, `due_date`, `project_id` | Canvas: se reescriben en cada sincronización (cambio de fecha, título o de proyecto vinculado al curso). |
| `source`, `external_id` | Identidad: fijos. |
| `priority`, `description` | Usuario: la sincronización nunca los toca. |
| `status` / `completed_at` | Usuario, con una excepción: una tarea pendiente pasa a hecha si Canvas demuestra la entrega (`submitted_at` + estado `submitted` / `pending_review` / `graded`). Canvas nunca devuelve a pendiente una tarea hecha. |

- **Fecha:** `due_at` (instante) se convierte al día en Atlantic/Canary (`2026-10-12T22:59:00Z` → 12 OCT). **Limitación:** la tarea guarda solo el día; la hora de cierre de Canvas no se conserva.
- **Edición:** en una tarea de Campus el editor muestra título, fecha y proyecto como "Campus · Datos sincronizados"; solo cambian prioridad y completada (el servidor ignora el resto).
- **Borrado:** una tarea de Campus no se borra sin más (la siguiente sincronización la recrearía): "Ignorar en TRAZA" registra la entrega como ignorada y quita la tarea a la vez.
- **Desaparición:** si Canvas deja de devolver una entrega, su tarea queda intacta. Nada se borra por ausencia. Desvincular o ignorar un curso tampoco borra sus tareas.

**Escritura y confianza** (`20261006070920_sync_canvas_course_tasks.sql`): los clientes siguen sin poder escribir `source` / `external_id`. La única vía es la función `sync_canvas_course_tasks(p_canvas_course_id, p_assignments)`, SECURITY DEFINER con `search_path = ''`, ejecutable solo por `authenticated`. Exige `auth.uid()`, no acepta `user_id` ni `project_id` (el proyecto sale del vínculo del propio usuario), solo inserta/actualiza filas `canvas` del llamante y respeta la clave compuesta tarea → proyecto. La base de datos no puede llamar a Canvas: la verificación del contenido la hace el servidor de Next.js. Un usuario que llamara a la RPC con datos inventados solo podría crear o retitular tareas de Campus **suyas**, en **sus** proyectos vinculados; nunca datos de otro usuario ni tareas manuales.

### Sincronización automática (mientras usas TRAZA)

Migración `20261007083209_canvas_sync_state.sql`. Campus se sincroniza solo, sin pulsar "Sincronizar Campus", mientras la aplicación privada está abierta (no se guardan tokens de Supabase ni cookies para actuar después). Con la app cerrada lo hace el programador de producción con el mismo motor, turno y espera ([docs/production.md](production.md)).

- **Un solo motor:** `lib/canvas/sync.ts` (`runCanvasSync`) es la única implementación de las reglas (cursos vivos, vínculos, decisiones, relevancia, clasificación). `lib/canvas/auto-sync.ts` (`runLeasedCanvasSync`) solo lo envuelve con el turno (*lease*) y el estado; lo usan **tanto** el botón "Sincronizar Campus" (`trigger = manual`) como la comprobación automática (`trigger = automatic`). Las dependencias reales están en `lib/canvas/sync-deps.ts`. "Vista previa" usa el mismo motor, sin turno y sin escribir.
- **Disparo:** `components/canvas/CanvasAutoSyncTrigger.tsx`, montado en el *layout* privado (`app/(app)/layout.tsx`, nunca en `/login`) solo si Canvas está configurado. Hace `POST /api/integrations/canvas/auto-sync` 3 s después de cargar, cada 15 min mientras la pestaña está visible, y al volver a una pestaña oculta ≥ 10 min; nunca más de una vez cada 5 min por pestaña. No envía cuerpo ni ids. Si se importó o actualizó algo, refresca la página.
- **Endpoint:** solo `POST`, mismo origen (cabecera `x-traza-auto-sync`, `Origin` = host, `Sec-Fetch-Site: same-origin`), sesión verificada con `getClaims()`. No lee el cuerpo: el usuario sale de la sesión y el servidor decide cursos, proyectos y entregas. Responde solo `{ outcome, changed }`. Sin sesión: 401 (también desde `proxy.ts` para escrituras en `/api/`).
- **Estado** (`public.canvas_sync_state`, una fila por usuario): último intento, último éxito, próximo momento permitido, turno, resultado (`success`, `no_linked_courses`, `temporary_error`, `auth_error`), un código seguro de error (`network`, `timeout`, `canvas_401`, `canvas_403`, `canvas_429`, `canvas_5xx`, `canvas_redirect`, `not_configured`, `database`, `unexpected`), fallos seguidos y recuentos. Nunca tokens, errores de Canvas, cuerpos de respuesta ni contenido de entregas. RLS: el dueño solo **lee** (sin el token del turno); nadie escribe la tabla directamente.
- **Turno (concurrencia):** `claim_canvas_sync(trigger, lease_seconds)` bloquea la fila del usuario (`FOR UPDATE`): solo una petición obtiene el turno (5 min); las demás devuelven `already_running` sin llamar a Canvas. Si un proceso muere, el turno caduca solo. `finish_canvas_sync(token, …)` registra el resultado y libera el turno; solo el titular del turno vigente puede hacerlo. Ambas son SECURITY DEFINER, sin parámetro de usuario (`auth.uid()`), `search_path` vacío. La base de datos es la única autoridad (sin mutex en memoria).
- **Espera:** tras un éxito, 30 min antes de otra sincronización automática (`not_due`, sin llamar a Canvas). Tras un fallo temporal: 5, 10, 20, 40 y luego 60 min. Tras un error de credenciales (401/403/redirección/no configurado): 2 h. "Sincronizar Campus" ignora la espera, pero no un turno activo. Todos los valores están en `lib/canvas/sync-policy.ts`; las funciones SQL solo los acotan (turno 30–900 s; espera 1 min–24 h).
- **Canvas:** reintentos solo para red, tiempo agotado, 429, 500, 502, 503 y 504: 3 intentos como máximo, ~0,5 s y ~1 s (±25 %), respetando `Retry-After` hasta 10 s (si pide más, no se espera y la ejecución pasa a la espera por fallo). 401, 403 y respuestas mal formadas no se reintentan. Cada petición tiene 10 s, y todas las de una ejecución deben terminar en 4 min (dentro del turno).
- **Importación conservadora:** igual que la manual: solo entregas claramente accionables o las que marcaste "Importar"; lo dudoso queda en "Revisar" (la página muestra "N requieren revisión") y nunca se aprueba solo; notas y asistencia se omiten; "Ignorar" siempre gana. Una entrega que desaparece de una respuesta no borra su tarea. La propiedad de campos no cambia: Campus actualiza título, fecha y proyecto; prioridad y "hecha" son tuyas (Campus solo puede marcarla hecha con prueba clara de entrega, nunca devolverla a pendiente).
- **Página de Campus:** bloque "Sincronización automática" con la última sincronización ("Hace 12 min"), el estado (`ACTUALIZADO`, `SIN SINCRONIZAR`, `EN CURSO`, `REVISAR CONEXIÓN`, `ERROR TEMPORAL`) y "Próxima comprobación: Automática". Sin detalles de errores.
- **Diagnóstico (solo desarrollo):** la consola del servidor muestra `TRAZA Canvas auto-sync: outcome=… trigger=… courses=… seen=… imported=… updated=… unchanged=… ignored=… review=… duration=…ms [code=…]` (no para `not_due`). Solo enumerados y números. En producción no se registra nada.
- **Con la app cerrada:** el programador de producción (Supabase Cron → `POST /api/internal/scheduler`) ejecuta el mismo motor con el disparo `automatic`, el mismo turno y la misma espera, sin guardar ni crear sesiones. Ver [docs/production.md](production.md).

**Proyectos · próximo hito:** se deriva al leer (no se guarda): la tarea pendiente con fecha ≥ hoy o el evento del calendario ≥ hoy del proyecto, el más próximo; el mismo día gana la tarea.

Si la universidad no permite tokens personales (el botón "Nuevo token de acceso" no aparece), la alternativa es OAuth2 con una *developer key* emitida por la administración de Canvas; no está implementado.

## Google Calendar · conexión

Google es una **integración** de un usuario de TRAZA ya autenticado; no es un método de inicio de sesión (TRAZA sigue usando correo y contraseña de Supabase). Esta sección cubre conectar la cuenta y elegir un calendario; la sincronización manual de eventos está en la sección siguiente.

### Pasos en Google Cloud Console

1. **Proyecto:** en <https://console.cloud.google.com/> crea un proyecto (p. ej. "TRAZA") o elige uno.
2. **API:** *APIs y servicios → Biblioteca* → "Google Calendar API" → **Habilitar**.
3. **Pantalla de consentimiento** (*Google Auth Platform → Branding / Audiencia*): tipo **Externo**, nombre "TRAZA", tu correo de asistencia y de contacto. En *Audiencia*, deja la app en **Prueba** y añade tu cuenta de Google como **usuario de prueba**. En *Acceso a datos* añade los dos permisos:
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events.owned`
4. **Credenciales:** *Clientes → Crear cliente* → tipo **Aplicación web**, nombre "TRAZA local". En **URI de redireccionamiento autorizados** añade exactamente:
   `http://localhost:3000/api/integrations/google/callback`
   (No hace falta "Orígenes de JavaScript": el navegador nunca habla con Google con estas credenciales.)
5. Copia el **ID de cliente** y el **secreto de cliente**.

En modo *Prueba*, Google caduca los tokens de actualización a los 7 días: habrá que reconectar cada semana hasta publicar la app (el estado aparece como "Acceso retirado" y basta con "Volver a conectar").

### Variables (`.env.local`, solo servidor, nunca `NEXT_PUBLIC_`)

| Variable | Valor |
| --- | --- |
| `GOOGLE_CLIENT_ID` | ID de cliente (`…apps.googleusercontent.com`). |
| `GOOGLE_CLIENT_SECRET` | Secreto de cliente. Nunca en el repositorio ni en capturas. |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/api/integrations/google/callback` (debe coincidir carácter a carácter con el registrado; abre TRAZA en ese mismo origen, `localhost` y no `127.0.0.1`). |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | 32 bytes aleatorios en base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Si se pierde, las conexiones guardadas dejan de poder leerse y hay que reconectar. |
| `GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS` | Opcional, solo al rotar la clave (ver abajo). |

Reinicia `npm run dev` tras editarlas. **Producción:** cuando TRAZA se despliegue, se añade en Google Cloud el URI `https://<dominio>/api/integrations/google/callback` y en el hosting las mismas variables con ese `GOOGLE_REDIRECT_URI` (y una clave de cifrado propia). El código no presupone ningún dominio.

### Cómo funciona

- **OAuth 2.0 con código de autorización**, cliente confidencial en el servidor, con **PKCE (S256)** y `state` aleatorio. "Conectar Google Calendar" es un formulario (Server Action, que rechaza peticiones de otro origen): crea `state` + verificador PKCE, los guarda **cifrados** en la cookie `traza_google_oauth` (httpOnly, SameSite=Lax, solo en la ruta del callback, 10 minutos, Secure en https) y redirige a Google con `access_type=offline` y `prompt=consent`.
- **Callback** `GET /api/integrations/google/callback`: exige sesión de TRAZA; descifra la cookie, comprueba caducidad y que `state` coincide (comparación en tiempo constante) y que el flujo lo empezó **el mismo usuario**; intercambia el código en el servidor (secreto + verificador PKCE); exige token de actualización y **todos** los permisos (si se desmarca alguno, revoca lo concedido); identifica la cuenta por el id del calendario principal; guarda los tokens cifrados y vuelve a `/calendar?google=<código>`. La cookie se borra siempre; la URL final nunca lleva tokens ni el código.
- **Permisos (los mínimos):** `calendar.calendarlist.readonly` (ver tu lista de calendarios; el principal identifica la cuenta, sin pedir `email`/`openid`) y `calendar.events.owned` (ver, crear, cambiar y borrar eventos **solo en calendarios que son tuyos**). No se pide `calendar` (control total, incluido borrar calendarios y compartirlos) ni `calendar.events` (eventos de todos los calendarios a los que tienes acceso).
- **Tokens:** `public.google_calendar_connections` (`20261006095932`), una fila por usuario, RLS de dueño. Los tokens se cifran en el servidor con **AES-256-GCM** (`GOOGLE_TOKEN_ENCRYPTION_KEY`), ligados al usuario y al tipo de token; la base de datos solo guarda `v1.<clave>.<iv>.<cifrado>` y un check rechaza cualquier otra cosa (un token en claro no se puede guardar por error). Las columnas cifradas **no se pueden seleccionar** desde la API de datos (permisos por columna); el servidor las lee con `get_google_calendar_credentials()` (SECURITY DEFINER, solo las del propio usuario, solo cifrado). Supabase Vault se descartó: descifrar exige la *service role* o una función que entregaría el token **en claro** a cualquiera con el JWT del usuario.
- **Rotación de la clave:** pon la nueva en `GOOGLE_TOKEN_ENCRYPTION_KEY` y la antigua en `GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS`; cada token se vuelve a cifrar con la nueva al renovarse. Cuando todos estén renovados (o tras reconectar) se quita la antigua.
- **Renovación:** el token de acceso se guarda cifrado con su caducidad y se renueva en el servidor un minuto antes; el de actualización se conserva salvo que Google envíe otro. Si Google lo rechaza (`invalid_grant`) los tokens se borran y el estado pasa a "Acceso retirado" (se conserva el calendario elegido; reconectar la **misma** cuenta lo mantiene, otra cuenta lo borra).
- **Calendarios:** "Elegir calendario" lee tu lista en vivo (paginada) y solo ofrece calendarios de los que eres **propietario** (los compartidos contigo se cuentan pero no se ofrecen). Nada se elige automáticamente. El servidor solo acepta un id presente en esa respuesta y guarda el nombre que da Google.
- **Desconectar** (con confirmación): revoca el token en Google (si Google no responde, se desconecta igualmente) y borra la fila (tokens y calendario elegido). No borra eventos de TRAZA ni de Google.
- La página `/calendar` solo lee metadatos (nunca llama a Google al renderizar); los mensajes de resultado son textos fijos en español.
- **Diagnóstico (solo en desarrollo):** si la conexión falla, el callback añade `&google_error=<etapa>` (`state_cookie_missing`, `state_cookie_decrypt`, `state_expired`, `state_mismatch`, `user_mismatch`, `oauth_denied`, `oauth_error`, `token_exchange`, `refresh_token_missing`, `scope_validation`, `token_encryption`, `database_store`, `unexpected`; `session_missing` va a `/login`). Es una lista cerrada: nunca incluye códigos, tokens, secretos ni errores de Google o de la base de datos. En producción solo aparece `?google=<código>`.
- La conexión se guarda con UPDATE y, si no hay fila, INSERT; no con upsert: `ON CONFLICT DO UPDATE` lee los valores nuevos vía `EXCLUDED`, lo que exige permiso SELECT sobre las columnas cifradas, que los clientes no tienen.

## Google Calendar · sincronización manual

Migración `20261006122922_google_calendar_sync.sql`. En `/calendar` → *Google Calendar*, con la cuenta conectada y un calendario elegido: **Vista previa Google** (lee y planifica; no escribe nada) y **Sincronizar Google Calendar** (ejecuta ese mismo plan). Solo a mano: sin cron, sin segundo plano, sin *polling*, sin *webhooks* y nada al abrir la página.

### Propiedad por origen (nunca "gana la última escritura")

| Origen | Quién manda | En el otro lado |
| --- | --- | --- |
| **TRAZA**: eventos de `calendar_events` que no vienen de Google (manuales, y cualquier otro origen que no sea `google-calendar`) | TRAZA: título, fecha, horas, todo el día, lugar, descripción, proyecto | Google recibe una **copia**. Si la copia se edita o se borra en Google, la siguiente sincronización la **rehace** desde TRAZA. Para cambiarla o quitarla, se hace en TRAZA. |
| **Entregas** (`tasks` con `due_date`, manuales y de Campus) | TRAZA: título, fecha, completada, proyecto, origen | Google recibe un evento **de todo el día** (sin hora: las tareas no tienen hora y no se inventa) marcado como *libre*. Nunca se crea una fila en `calendar_events`. Google **nunca** cambia la tarea. |
| **Google**: eventos independientes del calendario elegido | Google: título, descripción, lugar, fecha, horas | TRAZA guarda un evento real (`source = 'google-calendar'`, `external_id = 'calendar:<id calendario>:event:<id evento>'`) que aparece en Calendario e Inicio con la marca `/ GOOGLE`. Esos campos son **solo lectura** en TRAZA ("Google Calendar · Datos sincronizados"); solo se elige el **proyecto**, que es de TRAZA y Google nunca lo toca. No se convierten en tareas ni se borran desde TRAZA. |

Canvas → TRAZA → Google: la sincronización con Google solo lee las tareas de TRAZA; nunca lee Campus.

### Copias de TRAZA en Google

- Cada copia lleva **propiedades extendidas privadas** (`trazaManaged = 1`, `trazaType = calendar_event | task`, `trazaLocalId`, `trazaVersion = 1`): invisibles en Google Calendar, nunca en el texto visible. Nunca se identifica nada por el título.
- Texto visible: el título real; la descripción del evento más una línea `TRAZA · <proyecto>`; en las tareas, `Tarea de TRAZA · <proyecto> · Campus · Hecha` (según corresponda). Sin ids, sin UUID, sin ids de Canvas.
- **Tareas completadas:** la copia se conserva (no se borra historia); la descripción añade `Hecha`. El título no cambia.
- Horas: un evento con hora se envía como hora local + `timeZone: Atlantic/Canary` (Google aplica el desfase correcto a cada lado del cambio de hora). Un evento sin hora de fin termina cuando empieza (no se inventa una duración). Todo el día: fechas simples, fin exclusivo (día siguiente), sin conversión.

### Importación desde Google

- Se lee el calendario elegido con `singleEvents=true` (las **recurrencias** llegan como ocurrencias sueltas, cada una con su id estable; TRAZA no crea reglas de recurrencia) y `showDeleted=true`. Paginado; si hay más de 25 000 eventos en el periodo, no se planifica nada.
- Se ignoran las copias de TRAZA (por las propiedades privadas y por los vínculos).
- Campos: `summary` → título (máx. 200, "Sin título" si está vacío); `location` → lugar; `description` → descripción en **texto plano** (se quitan etiquetas HTML, se decodifican entidades; máx. 2000). Proyecto: ninguno (no se adivina por el título).
- Horas: un instante de Google (RFC 3339 con desfase, o local + zona) se convierte a la **fecha y hora de pared de Atlantic/Canary**. Un fin en otro día local (evento nocturno) se descarta en vez de colocarlo mal. Un evento de varios días aparece en su primer día. Fechas imposibles o formas desconocidas se omiten y se cuentan.
- Cambios en Google actualizan **el mismo** evento de TRAZA (misma fila), nunca uno nuevo.

### Periodo

Se sincroniza de **hoy − 30 días** a **hoy + 365 días** (días de Atlantic/Canary), en ambos sentidos. A Google se le pide un día de margen a cada lado y se filtra por fecha local. Fuera del periodo: una copia ya vinculada se sigue actualizando si su elemento cambia (comparando un *hash* del contenido, sin pedírsela a Google); no se importa nada nuevo.

### Duplicados

- Vínculos en `public.google_calendar_item_links`: único por (usuario, calendario, evento de Google), por (usuario, calendario, tarea) y por (usuario, calendario, evento de TRAZA).
- El id de cada copia en Google lo elige TRAZA y es **determinista** (sha256 de tipo + id + calendario, en hex, válido como base32hex). Crear dos veces la misma copia (dos sincronizaciones a la vez, un corte entre Google y la base de datos) choca en Google (409) en vez de duplicar; la siguiente sincronización **adopta** esa copia.
- Importados: único por (usuario, `google-calendar`, `external_id`).
- La base de datos solo registra una copia después de que Google la confirme.

### Borrado (conservador)

- **Evento o tarea de TRAZA borrados** (por cualquier camino: Calendario, Inicio, "Ignorar en TRAZA", cascadas): la clave del vínculo pasa a `NULL` (`ON DELETE SET NULL`) y el vínculo queda como **lápida** duradera. La siguiente sincronización borra la copia de Google y después el vínculo; si Google falla, la lápida se queda para el siguiente intento. La vista previa lo muestra como "se quitaría de Google". Ningún camino de borrado de TRAZA necesita hablar con Google y ninguna copia queda huérfana sin aviso.
- **Tarea a la que se le quita la fecha:** su copia se borra de Google; la tarea sigue.
- **Evento de Google que desaparece** (o aparece como borrado): no se borra en TRAZA por una sola lectura; se informa ("ya no aparece allí, se conserva"). Borrarlo en TRAZA no está permitido (Google es el dueño).
- **Copias marcadas por TRAZA sin elemento conocido** (p. ej. copiadas a mano en Google): se omiten y se cuentan; nunca se importan ni se borran.

### Cambio de calendario y desconexión

- Los vínculos guardan el calendario. Si eliges otro, las nuevas sincronizaciones usan el nuevo; los vínculos y copias del anterior **se conservan sin tocar** (ni se actualizan, ni se borran, ni se comparan con el nuevo) y la sincronización los cuenta. Limitación: no hay asistente para migrar o limpiar el calendario anterior; los eventos importados de ese calendario se quedan en TRAZA y dejan de actualizarse.
- Desconectar no borra vínculos, eventos ni tareas. Con el acceso retirado, TRAZA funciona igual, no se borra nada y la sección muestra "Acceso retirado" hasta reconectar. Si Google no responde, no se escribe nada (o la sincronización se detiene y se informa como incompleta; lo ya confirmado queda registrado).

### Seguridad y límite de confianza

- `public.google_calendar_item_links`: RLS de dueño, `anon` sin nada. Claves foráneas compuestas `(task_id, user_id)` → `tasks (id, user_id)` y `(calendar_event_id, user_id)` → `calendar_events (id, user_id)` (nuevas claves únicas `tasks_id_user_id_key` y `calendar_events_id_user_id_key`): un vínculo nunca puede apuntar a datos de otro usuario, ni aunque conozca el id (no depende solo de RLS). Un *check* exige exactamente la clave de su tipo y un *trigger* exige el elemento al insertar y rechaza vincular un evento de origen Google. Privilegios por columna: los clientes no escriben `user_id`, `id`, marcas de tiempo ni (tras insertar) el elemento vinculado. No contiene secretos.
- `sync_google_calendar_events(p_calendar_id, p_events)`: SECURITY DEFINER (porque `authenticated` no puede escribir `calendar_events.source/external_id`, y así sigue), `search_path` vacío, `auth.uid()` obligatorio, **sin** parámetro de usuario, solo ejecutable por `authenticated`. Exige que el calendario sea el **elegido** de una conexión **activa** del propio usuario; construye `external_id` él mismo; solo inserta/actualiza filas `source = 'google-calendar'` del propio usuario; nunca escribe `project_id`, nunca borra, nunca toca tareas ni eventos de otro origen; no importa ids que sean copias del propio usuario. Un elemento mal formado rechaza la llamada entera.
- **Límite de confianza:** el servidor de Next.js lee Google con el token del usuario y solo envía lo que Google acaba de devolver. La base de datos no puede verificar Google. Un usuario autenticado que llamara directamente a la RPC o escribiera sus vínculos solo podría alterar **sus propios** eventos de origen Google o vínculos: nunca datos de otro usuario, eventos manuales, tareas ni otro `user_id`.
- Sin *service role*. Los resultados al navegador son recuentos más títulos y fechas del propio usuario: nunca tokens, ids de Google, propiedades privadas, respuestas de Google ni errores de la base de datos. Nada se registra en logs.
- Vista previa: **cero** escrituras en Google y en Supabase (vínculos, eventos, tareas). Lo único que puede escribirse es la caché cifrada del token de acceso si hay que renovarlo (o "Acceso retirado" si Google lo revocó).

## Google Calendar · sincronización automática (mientras usas TRAZA)

Migración `20261007103558_google_calendar_sync_state.sql`. Mismo diseño que la de Campus: dentro de peticiones del usuario conectado y, con la app cerrada, del programador de producción (mismo motor, turno y espera; [docs/production.md](production.md)).

- **Un solo motor:** `runGoogleSync` (`lib/google-calendar/sync.ts`) planifica y ejecuta para "Vista previa Google", "Sincronizar Google Calendar" y la sincronización automática. `lib/google-calendar/auto-sync.ts` (`runLeasedGoogleSync`) solo añade comprobaciones previas, turno y estado. Las reglas de propiedad (TRAZA manda en sus eventos y tareas; Google en los suyos), el periodo (hoy −30 / +365 días, Atlantic/Canary), los vínculos, las lápidas y las propiedades privadas no cambian.
- **Disparo:** `components/calendar/GoogleCalendarAutoSyncTrigger.tsx` en el *layout* privado (nunca en `/login`), solo si Google está configurado; independiente del de Campus. `POST /api/integrations/google/auto-sync` 5 s después de cargar, cada 10 min con la pestaña visible y al volver a una pestaña oculta ≥ 10 min; como mucho una vez cada 4 min, compartido entre pestañas (`localStorage`, solo una hora). Sin cuerpo ni ids; sin avisos. Si se importaron eventos de Google, refresca la página.
- **Endpoint:** solo `POST`, mismo origen (cabecera `x-traza-google-sync`, `Origin`, `Sec-Fetch-Site`; comprobación común en `lib/security/same-origin.ts`), sesión verificada. Usa la conexión y el calendario **guardados** del usuario; nunca lee el cuerpo. Responde `{ outcome, changed }`.
- **Comprobaciones previas** (sin turno, sin llamar a Google, sin leer tokens): configuración incompleta → `credentials_missing` (la conexión guardada no se toca); sin conexión → `not_connected`; acceso retirado → `reconnect_required`; sin calendario elegido → `no_calendar`.
- **Turno y espera:** `claim_google_calendar_sync` / `finish_google_calendar_sync` (SECURITY DEFINER, `auth.uid()`, sin parámetro de usuario, sin leer tokens). Turno de 5 min; una sola sincronización por usuario (pestañas, manual y automática). Tras un éxito, 15 min. Fallos temporales y límites de Google: 5, 10, 20, 40 y luego 60 min. Acceso perdido: 6 h, **salvo** que reconectes (si `connected_at` es posterior a la última ejecución, vuelve a tocar enseguida). La manual ignora la espera, nunca un turno activo. Valores en `lib/google-calendar/sync-policy.ts`.
- **Tokens:** se renueva el token de acceso en el servidor cuando caduca (o si Google lo rechaza: un único reintento), se guarda cifrado y solo lo hace quien tiene el turno. `invalid_grant` → la conexión pasa a "Acceso retirado" (se borran solo los tokens; los eventos importados se conservan) y no se vuelve a llamar a Google hasta reconectar. Si los tokens guardados no se pueden descifrar (por ejemplo, otra `GOOGLE_TOKEN_ENCRYPTION_KEY`), la sincronización automática **no los borra**: informa "Requiere reconectar"; restaurar la clave correcta recupera la conexión.
- **Google:** reintentos solo para red, tiempo agotado, 408, 429, 500, 502, 503, 504 y los 403 que Google usa como límite de peticiones (`rateLimitExceeded`, `userRateLimitExceeded`): 3 intentos como máximo, ~0,5 s y ~1 s (±25 %), `Retry-After` hasta 10 s. No se reintentan 400, otros 403 ni respuestas mal formadas. Todas las peticiones de una ejecución terminan en 4 min. Repetir es seguro: los ids de las copias son deterministas.
- **Estado** (`public.google_calendar_sync_state`): fechas, resultado (`success`, `not_connected`, `no_calendar`, `reconnect_required`, `rate_limited`, `temporary_error`, `unexpected`), fallos seguidos y recuentos (creados, actualizados, importados, borrados, sin cambios, fallidos). Nunca tokens, correos, ids de calendario, contenido de eventos ni errores de Google. El dueño solo lee (sin el token del turno); nadie escribe directamente.
- **Calendario:** la sección de Google muestra "Última sincronización", "Estado" (`ACTUALIZADO`, `SIN SINCRONIZAR`, `EN CURSO`, `NO CONECTADO`, `REQUIERE RECONECTAR`, `ERROR TEMPORAL`, `NO CONFIGURADO`) y "Próxima comprobación" (Automática / En pausa). Con "Requiere reconectar" aparece "Volver a conectar". Los botones manuales siguen igual.
- **Diagnóstico (solo desarrollo):** `TRAZA Google auto-sync: outcome=… trigger=… created=… updated=… imported=… deleted=… unchanged=… failed=… duration=…ms`. Nunca correo, usuario, calendario, títulos ni tokens.

## Asistente (IA con confirmación)

Migración `20261006141207_assistant.sql`. Pantalla `/assistant`.

### Configurar el proveedor (Groq)

1. En <https://console.groq.com/keys> crea una clave de API.
2. En `.env.local` (solo servidor, **nunca** `NEXT_PUBLIC_`):
   - `GROQ_API_KEY=<tu clave>`
   - opcional: `GROQ_MODEL=openai/gpt-oss-20b` (es el valor por defecto).
3. Reinicia `npm run dev`. Sin la clave, la pantalla funciona pero el campo de texto queda desactivado y no se guarda nada.

La clave nunca sale del servidor: va en la cabecera `Authorization: Bearer …`, no se registra, no se guarda en la base de datos y no llega al navegador. Los errores del proveedor se convierten en frases fijas ("El asistente no está disponible en este momento.").

### Cómo funciona

- **El modelo nunca escribe.** No tiene herramientas ni acceso a Supabase: recibe instrucciones + un bloque de datos y devuelve JSON (`message` + `actions`) con esquema estructurado (`lib/assistant/prompt.ts`). Solo TRAZA escribe, y solo tras la confirmación del usuario.
- **Proveedor:** `lib/ai/types.ts` (contrato neutro), `lib/ai/provider.ts` (solo servidor; elige el proveedor activo), `lib/ai/groq.ts` (REST `POST https://api.groq.com/openai/v1/chat/completions`), `lib/ai/retry.ts` (reintentos y errores HTTP). El adaptador anterior de Gemini se eliminó en la versión 1.0. Las pruebas usan `fetch` falso; ninguna llama a Groq.
- **Petición a Groq:** `model` (por defecto `openai/gpt-oss-20b`), `messages` (sistema + conversación), `response_format: { type: "json_schema", json_schema: { name: "traza_assistant_response", strict: true, schema } }`, `reasoning_effort: "low"`, razonamiento oculto, `temperature: 0.2`, `max_completion_tokens: 8192`, `stream: false`; sin herramientas, búsqueda ni ejecución de código. Razonamiento oculto: en `openai/gpt-oss-*` Groq no admite `reasoning_format`, así que se envía `include_reasoning: false`; en modelos que lo admiten (`qwen/qwen3*`) se envía `reasoning_format: "hidden"`. Nunca se lee un campo de razonamiento. Se usa `choices[0].message.content`.
- **Esquema estricto:** el esquema de TRAZA se convierte al modo estricto (`toStrictSchema`): todas las propiedades en `required`, `additionalProperties: false` en todos los objetos, y lo opcional como unión con `null` (`["string", "null"]`; un `enum` admite `null`). `maxItems` no se envía; TRAZA limita las propuestas a 6. La validación propia de TRAZA se mantiene igual: la salida estricta no es una garantía de confianza.
- **Contexto acotado** (`lib/assistant/context.ts`): fecha y hora reales de **Atlantic/Canary** (no del servidor), tabla de los próximos 15 días con su día de la semana, esta semana y la siguiente; proyectos activos/planificados (máx. 40) con referencias cortas `P1…` válidas solo en esa petición; tareas pendientes (máx. 80, vencidas marcadas; si el mensaje nombra un proyecto, las suyas primero); tareas hechas en los últimos 14 días (máx. 15); eventos de ayer a +60 días (máx. 60); últimas 15 notas/ideas (extracto de 300). Nunca ids, `user_id`, ids de Canvas o Google, tokens, claves, correos ni errores. Historial: los últimos 12 mensajes.
- **Validación de la respuesta** (`lib/assistant/response.ts` + `proposals.ts`): JSON inválido → se descarta la respuesta entera. Cada acción se reconstruye campo a campo (nunca se leen `user_id`, ids ni UUID de proyecto del modelo); el proyecto solo por referencia `P…` dada por TRAZA; fechas reales (2026-02-30 no), horas `HH:MM`, fin ≥ inicio; mismas reglas que los formularios. Una acción no válida se descarta y se avisa. Máx. 6 por respuesta.
- **Acciones:** `create_task` (fecha sin hora), `create_event` (con hora o de todo el día), `create_note`, `create_idea`. No hay editar ni borrar por IA; tampoco sincronizar Campus o Google (el asistente lee la base de datos de TRAZA, nunca esas APIs).
- **Propuestas** (`public.assistant_actions`): estado `proposed` → `executed` | `dismissed`; el `payload` guarda los campos ya validados con nombres de columna y el proyecto ya resuelto. Se ven como en la pantalla original ("Evento · jueves 8 OCT · 10:00"), con "Confirmar N acciones", "Descartar" y el estado.
- **Confirmación** (`lib/assistant/confirm.ts` → `execute_assistant_action`): sesión verificada → la propuesta es del usuario y sigue `proposed` → se vuelve a validar (incluido que el proyecto siga siendo suyo) → la función crea el registro con `source = 'ai'` y marca `executed` en **una** transacción, con la fila bloqueada (`FOR UPDATE`). Repetir (doble clic, recarga, dos pestañas) devuelve "ya creada" sin crear nada. Cada propuesta es independiente; un fallo parcial se informa ("1 creada · 1 no se ha podido crear"). Si el registro creado se borra después, la propuesta sigue `executed` y no se vuelve a crear.
- **Seguridad en la base de datos:** RLS de dueño en las tres tablas y `anon` sin nada; claves foráneas compuestas `(…, user_id)` (conversación → mensaje → propuesta → registro creado), así que nada puede apuntar a datos de otro usuario. Los clientes no escriben `user_id`, `state` ni resultados; los mensajes no se editan. `execute_assistant_action` y `dismiss_assistant_action` son SECURITY DEFINER (porque `source` sigue sin ser escribible por `authenticated`), con `search_path` vacío, `auth.uid()` obligatorio, sin parámetro de usuario. Vuelven a validar el `payload` (tipos, fechas reales, horas) y aplican todos los *checks* de la tabla destino. `add_assistant_reply` (INVOKER) guarda respuesta + propuestas de forma atómica. Sin *service role*.
- **Límite de confianza:** un usuario que llamara directamente a estas funciones o escribiera sus propias propuestas solo podría crear tareas, eventos o notas `ai` **en su propia cuenta**, con **sus** proyectos: lo mismo que ya puede hacer a mano.
- **Inyección de instrucciones:** títulos, notas, entregas de Campus y eventos de Google van como JSON dentro de `<datos>`, después de las reglas, que dicen expresamente que ese contenido son datos y no puede cambiar instrucciones ni permisos. Aun así, el modelo no tiene ningún poder: lo peor que podría hacer es proponer algo, y nada ocurre sin la confirmación del usuario.
- **Historial:** solo lo visible (mensajes del usuario y respuestas). Nunca razonamiento interno del modelo, *prompts* ni detalles del proveedor. "Nueva" empieza otra conversación; la pantalla muestra la más reciente.
- **Fallos:** sin clave → no se guarda nada; proveedor caído, límite de peticiones, tiempo agotado o respuesta mal formada → el mensaje del usuario queda guardado, no se crea nada y se muestra una frase fija.
- **Presupuesto de salida:** el razonamiento cuenta dentro de `max_completion_tokens` (8192); con `reasoning_effort: "low"` queda espacio de sobra para el JSON. Una respuesta cortada (`finish_reason: length`) se rechaza sin intentar leerla.
- **Reintentos (solo fallos transitorios):** 408, 429, 500, 502, 503, 504, errores de red y tiempo agotado se reintentan hasta **4 intentos** en total, esperando ~1 s, ~2 s y ~4 s (±25 % de variación aleatoria). Cada intento tiene 20 s como máximo y la llamada completa (intentos + esperas) 60 s: un reintento que no cabría con al menos 5 s no se hace. Nunca se reintentan 400/401/403, una respuesta 200 mal formada, bloqueada o cortada, ni lo que rechaza la validación del asistente. Los reintentos ocurren dentro del adaptador del proveedor (`lib/ai/retry.ts`): el mensaje del usuario y las propuestas se guardan una sola vez. Si un reintento funciona, no se muestra ningún error; si se agotan, se muestra la frase fija de siempre.
- **Diagnóstico (solo en desarrollo):** cada envío escribe en la consola del servidor una línea `TRAZA assistant diagnostic: provider=groq stage=… status=… attempts=… elapsed=…ms finish=… candidates=… tokens=prompt:…,thoughts:…,output:… model=…` (`candidates` = número de *choices*); si falla, el mensaje de error añade `(Diagnóstico: <etapa>)`. Etapas: `request_failed`, `timeout`, `http_408`, `http_400`, `http_401`, `http_403`, `http_429`, `provider_5xx`, `empty_choices`, `safety_block`, `max_tokens`, `empty_text`, `unexpected_response`, `invalid_json`, `schema_validation`; y, si la respuesta es válida pero se descartan propuestas, `unsupported_action` / `malformed_action`. Solo vocabulario fijo, enumerados y números: nunca la clave, cabeceras, el *prompt*, tus datos, el texto del modelo ni el cuerpo de la respuesta. En producción no se registra nada y solo se ve la frase fija.

## PWA y notificaciones

Migración `20261008083736_notifications.sql`. Ajustes en `/settings` (icono junto a "Cerrar sesión").

### Aplicación instalable

- **Manifiesto:** `app/manifest.ts` (`/manifest.webmanifest`): TRAZA, `standalone`, `start_url` `/`, fondo y tema `#F4F2ED`, `es`, sin bloqueo de orientación. Iconos locales en `public/icons` (192/512 normales y *maskable*, `apple-touch-icon` 180, insignia 96) y `app/favicon.ico`, generados con `node scripts/generate-icons.mjs` (sin dependencias) desde la marca oficial `public/brand/traza-mark.svg`, el maestro vectorial (vectorizado del original `brand/traza-mark-source.png`, que queda fuera de `public`). El mismo script genera `public/brand/traza-mark.png` (maestro transparente de 1024 px). La marca en la interfaz es `components/ui/TrazaMark.tsx`, con la misma geometría; `public/offline.html` la lleva en línea. Si cambian los iconos, sube `VERSION` en `public/sw.js` para que los dispositivos instalados los vuelvan a descargar.
- **Metadatos:** `appleWebApp` (título TRAZA, barra de estado `default`), `viewport-fit=cover`, zoom permitido.
- **Service worker** (`public/sw.js`, registrado por `components/pwa/PwaRegistrar.tsx`): **no guarda datos privados**. Precarga solo `/offline.html` y los iconos en una caché versionada (`traza-static-v2`); al activarse borra cualquier caché anterior. Las navegaciones van siempre a la red; solo si la red falla se muestra la página genérica "Sin conexión". Nunca se guardan páginas, API, Server Actions, Supabase, Canvas, Google, mensajes del asistente ni sesiones. Se sirve con `Cache-Control: no-store` y CSP `'self'`. Para actualizarlo, sube `VERSION`.
- **Rutas públicas:** `/manifest.webmanifest`, `/sw.js` y `/offline.html` no necesitan sesión (no contienen datos).
- **Instalar:** en Chrome/Edge, "Instalar" en Inicio (una línea discreta) y en Ajustes (usa `beforeinstallprompt`); en iPhone, Compartir → Añadir a pantalla de inicio. "Ahora no" la oculta 30 días en ese dispositivo; instalada, no aparece nada.
- **Móvil:** márgenes con `env(safe-area-inset-*)` en los cuatro lados; la barra inferior respeta el indicador de inicio y se oculta mientras se escribe en el móvil; campos a 16 px en pantallas táctiles (iOS no hace zoom al enfocarlos); botones de 44 px en táctil.

### Notificaciones (Web Push)

- **Variables (solo servidor, nunca `NEXT_PUBLIC_`):** `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` (`mailto:…`: contacto VAPID para los servicios de push, no contenido de las notificaciones). Generar: `npx web-push generate-vapid-keys --json`. La clave pública llega al navegador por las props de Ajustes; la privada nunca sale del servidor.
- **Permiso:** solo al pulsar "Activar notificaciones". En iPhone solo funciona con TRAZA instalada (iOS 16.4+); en Safari normal se indica instalarla primero.
- **Tablas:** `push_subscriptions` (una por dispositivo; única por usuario y *endpoint*; se escribe con `save_push_subscription`, se borra la propia), `notification_preferences` (una fila por usuario, `save_notification_preferences`), `notification_deliveries` (única por usuario y clave; `claim_notification_delivery` / `finish_notification_delivery`). RLS de dueño, `anon` sin nada, funciones fijadas a `auth.uid()`, sin *service role*.
- **Preferencias por defecto:** notificaciones activas; "Tareas para mañana" (20:00) sí; "Resumen de la mañana" (08:00) no; "Antes de eventos con hora" sí, 60 min; **sin títulos** en la pantalla de bloqueo ("Tienes 2 tareas para mañana."). Nunca notas, descripciones, contenido de Campus, conversaciones, OAuth ni correos.
- **Planificador** (`lib/notifications/planner.ts`, puro): hora de Canarias. Tareas para mañana desde las 20:00; resumen entre 08:00 y 12:00; eventos con hora `n` minutos antes (como mucho 30 min tarde, nunca después de empezar; los de todo el día no). Las tareas no tienen hora: nunca se inventa una.
- **Sin duplicados:** cada aviso tiene una clave estable (`tomorrow_tasks:2026-10-09`, `morning_summary:2026-10-09`, `event:<id>:60m:<inicio>`); se reserva en la base de datos antes de enviarse. Un fallo temporal se reintenta (máx. 3 intentos, misma fila); enviado u omitido es definitivo.
- **Envío** (`web-push`, solo servidor): 404/410 → se borra **solo** esa suscripción; 429/5xx → se conserva; 400/401/403/413 → rechazo (configuración). Al navegador solo llegan frases fijas.
- **Cuándo se comprueban:** mientras TRAZA está abierta, `NotificationCheckTrigger` pide cada 10 min `POST /api/notifications/check` (mismo origen, sesión). Con TRAZA cerrada, el programador de producción (Supabase Cron → `POST /api/internal/scheduler`, ver [docs/production.md](production.md)) ejecuta el mismo `lib/notifications/run.ts`; la clave de cada aviso evita que se envíe dos veces.
- **Prueba:** Ajustes → "Enviar notificación de prueba" (solo a tus dispositivos; no crea nada).

## Estado de la migración a datos reales

| Entidad | Estado |
| --- | --- |
| Tareas (`public.tasks`) | Reales en Inicio: crear, fecha, prioridad, proyecto, editar, completar, borrar. Clientes escriben solo columnas de contenido; `source` y `external_id` ya no son escribibles (`20261005160009`). |
| Proyectos (`public.projects`) | Reales en Proyectos (crear, editar, archivar, borrar) y en Inicio (proyectos activos, asignación de tareas). Recuentos de tareas derivados de `public.tasks`. |
| Calendario (`public.calendar_events`) | Real: eventos (crear, editar, borrar) y entregas derivadas de `public.tasks`; navegación por mes en la URL (`?mes=&dia=`). Vistas Día y Semana aún sin implementar. |
| Inbox (`public.inbox_items` + `public.tasks`) | Real: captura de tareas, ideas y notas; edición y borrado; filtros y recuentos reales. |
| Canvas · conexión | Completa: lectura de perfil y cursos activos (`/projects/canvas`). |
| Canvas · vinculación de cursos | Completa: `public.canvas_course_links` + `/projects/canvas`; etiqueta CAMPUS en Proyectos. |
| Canvas · entregas | Completa tras aplicar `20261006070920`: sincronización manual con vista previa en `/projects/canvas`; las entregas son tareas reales (`source = 'canvas'`). Clasificación (importar / revisar / omitir) y decisiones por entrega tras aplicar `20261006082922`. |
| Canvas · sincronización automática | Tras aplicar `20261007083209`: mientras usas TRAZA y, en producción, también con la app cerrada (programador, `20261008094339` + `20261008121027`), como mucho cada 30 min, con turno por usuario en la base de datos. El programador solo la ejecuta si **un único** usuario tiene cursos vinculados (el token de Canvas es personal). Sin anuncios, módulos, archivos, foros ni eventos del calendario de Canvas. |
| Google OAuth | Completo (`20261006095932`). |
| Google Calendar · elección de calendario | Completa: un calendario propio por usuario, en `/calendar`. |
| Google Calendar · sincronización manual | Completa tras aplicar `20261006122922`: vista previa + sincronización a mano en `/calendar` (eventos y entregas de TRAZA → Google; eventos de Google → TRAZA). |
| Google Calendar · sincronización automática | Tras aplicar `20261007103558`: mientras usas TRAZA y, en producción, también con la app cerrada (programador, `20261008094339` + `20261008121027`), como mucho cada 15 min, con turno por usuario en la base de datos. Sin *webhooks*. |
| Asistente | Real tras aplicar `20261006141207` y configurar `GROQ_API_KEY` (Groq, `openai/gpt-oss-20b`): preguntas con tus datos reales, propuestas (tarea, evento, nota, idea) que solo se crean al confirmarlas (`source = 'ai'`), historial persistente. Sin edición ni borrado por IA. |
| PWA | Instalable, con service worker conservador y página sin conexión. |
| Notificaciones | Web Push tras aplicar `20261008083736` y configurar VAPID: activación por dispositivo, preferencias, prueba; avisos con TRAZA abierta y, en producción, también cerrada. |
| Programador en segundo plano | Tras aplicar `20261008094339` y `20261008121027`, desplegar en Vercel y guardar en Vault la URL y el secreto: Supabase Cron llama cada 5 min a `POST /api/internal/scheduler` (avisos, Campus, Google). Ver [docs/production.md](production.md). |
| Autenticación | Implementada (correo + contraseña, un usuario creado a mano). |
