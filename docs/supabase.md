# Supabase en TRAZA

## Variables de entorno

En `.env.local` (ignorado por Git mediante `.env*`):

| Variable | Uso |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clave publicable (`sb_publishable_…`) |

Ambas son públicas por diseño: lo que protege los datos es RLS, no la clave. **Nunca** añadas una clave secreta / `service_role` con prefijo `NEXT_PUBLIC_` ni la importes en código de cliente; esta fase no la necesita.

## Clientes

- `lib/supabase/server.ts` → `createClient()` asíncrono para Server Components, Server Actions y Route Handlers (cookies vía `next/headers`). Crear uno por petición.
- `lib/supabase/client.ts` → `createClient()` para Client Components, solo cuando sea imprescindible.
- `lib/supabase/proxy.ts` → `updateSession()`, usado por `proxy.ts` (Next 16 renombró `middleware.ts`).

Ambos clientes usan el tipo generado `Database`.

## Autenticación

Correo + contraseña con Supabase Auth y sesiones en cookies (`@supabase/ssr`). Sin registro público ni proveedores OAuth.

- `proxy.ts` → en cada petición (salvo estáticos) refresca la sesión con `getClaims()` y aplica las rutas: sin sesión todo redirige a `/login`; con sesión, `/login` redirige a `/`. Rutas públicas en `lib/auth/routes.ts`.
- `app/(app)/layout.tsx` → segunda capa: verifica las claims en el servidor (`requireUser()`) antes de renderizar Inicio, Calendario, Inbox, Proyectos y Asistente.
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

Después, tipar los clientes: `createServerClient<Database>(…)` y `createBrowserClient<Database>(…)` con `import type { Database } from "./database.types"`. Los tipos generados no se escriben a mano. En Windows, ejecutar el script desde `npm run` (usa cmd) y no con redirección de PowerShell, que escribe UTF-16.

## Comprobación

Con `npm run dev`, abrir `/dev/supabase` (solo existe en desarrollo). Distingue: configuración ausente · sin conexión · migración pendiente · sin sesión con acceso bloqueado (esperado) · alerta si el acceso anónimo funciona · sesión sin privilegios (falta la migración de privilegios) · sesión con acceso seguro (`foreignRows` debe ser 0). Ruta temporal: borrar `app/dev/` cuando haya datos reales en la interfaz.

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

- **Fechas y horas locales**: `event_date date` + `start_time` / `end_time time` (sin zona horaria) guardan la hora de pared de Atlantic/Canary tal como se escribe; ninguna conversión UTC puede mover un evento de día u hora. Eventos de todo el día: `all_day = true` y sin horas. Una importación con timestamps (Google Calendar) deberá convertir a hora de Canarias al escribir.
- **Proyecto**: misma clave compuesta que las tareas (`calendar_events_project_owner_fkey`); borrar el proyecto conserva el evento sin proyecto.
- **Importaciones**: índice único `(user_id, source, external_id)` cuando hay `external_id`. Los clientes no pueden escribir `source` ni `external_id`: los eventos manuales son siempre `manual` y las integraciones futuras irán en el servidor.
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

Comprobación: `/dev/canvas` (solo en desarrollo y con sesión de TRAZA) muestra la conexión, tu usuario de Canvas y tus cursos activos. Llamadas usadas: `GET /api/v1/users/self` y `GET /api/v1/courses?enrollment_state=active&include[]=term&per_page=100` (paginación por la cabecera `Link`). No se escribe nada en Supabase.

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

**Proyectos · próximo hito:** se deriva al leer (no se guarda): la tarea pendiente con fecha ≥ hoy o el evento del calendario ≥ hoy del proyecto, el más próximo; el mismo día gana la tarea.

Si la universidad no permite tokens personales (el botón "Nuevo token de acceso" no aparece), la alternativa es OAuth2 con una *developer key* emitida por la administración de Canvas; no está implementado.

## Google Calendar · conexión (sin sincronizar eventos)

Google es una **integración** de un usuario de TRAZA ya autenticado; no es un método de inicio de sesión (TRAZA sigue usando correo y contraseña de Supabase). En esta fase solo se conecta la cuenta y se elige un calendario: no se importan ni se crean eventos y `public.calendar_events` no cambia.

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

## Estado de la migración a datos reales

| Entidad | Estado |
| --- | --- |
| Tareas (`public.tasks`) | Reales en Inicio: crear, fecha, prioridad, proyecto, editar, completar, borrar. Clientes escriben solo columnas de contenido; `source` y `external_id` ya no son escribibles (`20261005160009`). |
| Proyectos (`public.projects`) | Reales en Proyectos (crear, editar, archivar, borrar) y en Inicio (proyectos activos, asignación de tareas). Recuentos de tareas derivados de `public.tasks`. |
| Calendario (`public.calendar_events`) | Real: eventos (crear, editar, borrar) y entregas derivadas de `public.tasks`; navegación por mes en la URL (`?mes=&dia=`). Vistas Día y Semana aún sin implementar. |
| Inbox (`public.inbox_items` + `public.tasks`) | Real: captura de tareas, ideas y notas; edición y borrado; filtros y recuentos reales. |
| Canvas · conexión | Completa: lectura de perfil y cursos activos (`/dev/canvas`). |
| Canvas · vinculación de cursos | Completa: `public.canvas_course_links` + `/projects/canvas`; etiqueta CAMPUS en Proyectos. |
| Canvas · entregas | Completa tras aplicar `20261006070920`: sincronización manual con vista previa en `/projects/canvas`; las entregas son tareas reales (`source = 'canvas'`). Clasificación (importar / revisar / omitir) y decisiones por entrega tras aplicar `20261006082922`. |
| Canvas · sincronización automática | No implementada (sin cron ni segundo plano). Tampoco anuncios, módulos, archivos, foros ni eventos del calendario de Canvas. |
| Google Calendar · conexión | Completa tras aplicar `20261006095932`: conectar, elegir calendario propio y desconectar en `/calendar`. |
| Google Calendar · eventos | No implementado: no se importan ni se crean eventos. |
| Asistente | Solo datos mock (`lib/mock-data.ts`). Sus `projectId` son slugs mock, no proyectos reales. |
| Autenticación | Implementada (correo + contraseña, un usuario creado a mano). |
