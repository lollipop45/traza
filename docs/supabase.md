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

Si la universidad no permite tokens personales (el botón "Nuevo token de acceso" no aparece), la alternativa es OAuth2 con una *developer key* emitida por la administración de Canvas; no está implementado.

## Estado de la migración a datos reales

| Entidad | Estado |
| --- | --- |
| Tareas (`public.tasks`) | Reales en Inicio: crear, fecha, prioridad, proyecto, editar, completar, borrar. Clientes escriben solo columnas de contenido; `source` y `external_id` ya no son escribibles (`20261005160009`). |
| Proyectos (`public.projects`) | Reales en Proyectos (crear, editar, archivar, borrar) y en Inicio (proyectos activos, asignación de tareas). Recuentos de tareas derivados de `public.tasks`. |
| Calendario (`public.calendar_events`) | Real: eventos (crear, editar, borrar) y entregas derivadas de `public.tasks`; navegación por mes en la URL (`?mes=&dia=`). Vistas Día y Semana aún sin implementar. |
| Inbox (`public.inbox_items` + `public.tasks`) | Real: captura de tareas, ideas y notas; edición y borrado; filtros y recuentos reales. |
| Canvas | Conexión de solo lectura (perfil y cursos activos) en `/dev/canvas`; sin importación ni datos en Supabase. |
| Asistente | Solo datos mock (`lib/mock-data.ts`). Sus `projectId` son slugs mock, no proyectos reales. |
| Autenticación | Implementada (correo + contraseña, un usuario creado a mano). |
