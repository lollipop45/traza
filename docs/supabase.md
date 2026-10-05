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
- Pendiente para la fase de autenticación: `proxy.ts` (Next 16 renombró `middleware.ts`) que refresca la sesión con `supabase.auth.getClaims()`.

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

Con `npm run dev`, abrir `/dev/supabase` (solo existe en desarrollo). Distingue: configuración ausente · sin conexión · conexión correcta con migración pendiente · conexión correcta con acceso bloqueado por seguridad (esperado sin sesión) · lectura permitida. Ruta temporal: borrar `app/dev/` cuando haya datos reales en la interfaz.

## Estado de la migración a datos reales

| Entidad | Estado |
| --- | --- |
| Tareas (`public.tasks`) | Esquema, RLS e índices definidos. Solo lectura para usuarios autenticados; sin escrituras desde la app. La interfaz sigue usando datos mock. |
| Proyectos, calendario, inbox, asistente | Solo datos mock (`lib/mock-data.ts`). |
| Autenticación | No implementada. Siguiente fase: `proxy.ts`, inicio de sesión y `grant insert, update, delete on public.tasks to authenticated` (las políticas de escritura ya existen). |
