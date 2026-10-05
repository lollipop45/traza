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

## Estado de la migración a datos reales

| Entidad | Estado |
| --- | --- |
| Tareas (`public.tasks`) | Esquema, RLS e índices. Usuarios autenticados: lectura, borrado, y alta/edición solo de columnas de contenido (`id`, `user_id`, `created_at`, `updated_at` los fija la BD). `anon` sin acceso. La interfaz sigue usando datos mock. |
| Proyectos, calendario, inbox, asistente | Solo datos mock (`lib/mock-data.ts`). |
| Autenticación | Implementada (correo + contraseña, un usuario creado a mano). |
