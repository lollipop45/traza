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

## Estado de la migración a datos reales

| Entidad | Estado |
| --- | --- |
| Tareas (`public.tasks`) | Reales en Inicio: crear, fecha, prioridad, proyecto, editar, completar, borrar. Clientes escriben solo columnas de contenido; `source` y `external_id` ya no son escribibles (`20261005160009`). |
| Proyectos (`public.projects`) | Reales en Proyectos (crear, editar, archivar, borrar) y en Inicio (proyectos activos, asignación de tareas). Recuentos de tareas derivados de `public.tasks`. |
| Calendario (`public.calendar_events`) | Real: eventos (crear, editar, borrar) y entregas derivadas de `public.tasks`; navegación por mes en la URL (`?mes=&dia=`). Vistas Día y Semana aún sin implementar. |
| Inbox, asistente | Solo datos mock (`lib/mock-data.ts`). Sus `projectId` son slugs mock, no proyectos reales. |
| Autenticación | Implementada (correo + contraseña, un usuario creado a mano). |
