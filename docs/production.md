# TRAZA en producción

TRAZA se publica en **Vercel** (aplicación Next.js) con **Supabase** como base de datos y autenticación. Un **programador en segundo plano** mantiene los avisos, Campus y Google Calendar funcionando aunque TRAZA esté cerrada.

> Desarrollo local y producción usan **el mismo proyecto de Supabase** (los mismos datos). Por eso algunas claves deben ser idénticas en local y en producción (ver la tabla de variables).

## Arquitectura del programador

```
Supabase Cron (pg_cron), cada 5 minutos
  → traza_private.invoke_scheduler()            (migración 20261008094339)
  → pg_net: POST https://<dominio>/api/internal/scheduler
            Authorization: Bearer <SCHEDULER_SECRET>      (URL y secreto en Supabase Vault)
  → Vercel: lib/scheduler/  →  motores existentes de avisos, Campus y Google
```

- Postgres **solo despierta** la app. Ninguna regla de avisos, Campus o Google vive en SQL.
- La frecuencia (5 min) no es la de los avisos ni la de las sincronizaciones: en cada despertar la app pregunta si hay algo pendiente. Campus sigue sincronizando como mucho cada 30 min y Google cada 15 min (sus esperas de siempre); los avisos los decide el planificador y la clave de cada aviso impide enviarlos dos veces.
- Sin secretos en la migración. Sin los dos secretos de Vault el trabajo programado no hace nada (no envía nada ni da error).

### Por qué existe un acceso privilegiado

| Petición | Identidad | Seguridad |
| --- | --- | --- |
| Interactiva (tú en TRAZA) | tu sesión → rol `authenticated` | RLS + funciones fijadas a `auth.uid()` |
| Programador | `SCHEDULER_SECRET` (cabecera `Authorization`) | clave secreta de Supabase → usuario objetivo explícito (elegido solo por las consultas de candidatos) → almacenes acotados a ese usuario + funciones `scheduler_*` |

La clave secreta (`SUPABASE_SECRET_KEY`, cliente aislado en `lib/supabase/admin.ts`, solo servidor) salta RLS. Por eso el programador **no inicia sesión por nadie** (ni enlaces mágicos, ni OTP, ni sesiones de Auth) y trabaja como sistema, siempre acotado a un usuario explícito:

1. **Consultas de candidatos** (`lib/scheduler/candidates.ts`), solo lectura y acotadas (máx. 10 usuarios por integración y ejecución): quién tiene dispositivos y un aviso pendiente, quién tiene Campus vinculado, qué conexiones de Google están al día. Son la **única** fuente del usuario objetivo; ninguna petición, navegador ni endpoint público puede elegirlo. Nunca leen tokens cifrados, *endpoints* de push ni claves.
2. **Ámbito por usuario** (`lib/scheduler/scope.ts`, `createScheduledDependencies({ admin, userId })`): todo acceso de los almacenes programados (`lib/scheduler/stores/`) pasa por un objeto ligado a ese usuario. Cada `select`, `update` y `delete` lleva `user_id = <usuario>` por construcción, cada `insert` escribe ese `user_id`, y solo se pueden llamar las funciones `scheduler_*` con `p_user_id = <usuario>`. Los almacenes nunca ven el cliente privilegiado.
3. **Funciones `scheduler_*`** (migración `20261008121027_scheduler_rpcs.sql`): copias **literales** de las funciones interactivas que usan los motores (turnos de Campus y Google, deduplicación de avisos, importación de entregas y eventos, credenciales cifradas de Google). Solo cambia de dónde sale el usuario: `p_user_id`, validado contra `auth.users`, en lugar de `auth.uid()`. Solo `service_role` puede ejecutarlas; `anon` y `authenticated` no. Un test de base de datos falla si alguna se desvía de su original.

Los motores (`runDueNotifications`, `runLeasedCanvasSync`, `runLeasedGoogleSync`) son los mismos que usa la app. Las rutas interactivas siguen con la sesión del usuario y RLS, sin cambios.

Ningún otro código importa el cliente privilegiado; lo comprueban los tests (`tests/unit/scheduler.test.ts`, `tests/db/scheduler-rpcs.test.ts`).

### Campus: un token, un usuario

`CANVAS_ACCESS_TOKEN` es el token personal de **una** persona. Con la app cerrada, Campus solo se sincroniza si **exactamente un** usuario de TRAZA tiene cursos vinculados. Con dos o más, el programador **se niega** (resultado `multiple_users`) en vez de aplicar ese token a otra persona. La sincronización manual y la de la app abierta no cambian. Limitación de la v1.0: un token de Canvas por instalación.

### Concurrencia y tiempo

- Los turnos (*leases*) de Campus y Google en la base de datos siguen siendo la autoridad: navegador, botón manual y programador nunca sincronizan a la vez. Dos ejecuciones del programador no duplican trabajo. No hay candados en memoria.
- Avisos, Campus y Google corren por separado (`Promise.allSettled`): si uno falla, los otros siguen.
- Presupuesto por invocación: la función de Vercel puede durar 300 s. No se empieza ningún usuario nuevo pasados 120 s, y toda petición a Campus o Google termina antes de los 240 s, dentro del turno de 5 min. Lo que quede pendiente lo recoge el siguiente despertar. Si algo se corta, el turno caduca solo.
- Respuesta y log: solo recuentos y enumerados. Por ejemplo, `TRAZA scheduler: outcome=success notifications=1 notifications_lane=done canvas=not_due google=0 google_lane=done duration=812ms`. Nunca ids de usuario, correos, títulos, *endpoints*, ids de calendario o cursos, tokens ni secretos.

## Variables de entorno

Ningún valor va en el repositorio. Local: `.env.local` (ignorado por git y por `vercel deploy` vía `.vercelignore`). Producción: Vercel → Project → Settings → Environment Variables.

| Variable | Tipo | Production | Preview | Development (local) |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | PÚBLICA | sí | no | sí |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | PÚBLICA | sí | no | sí |
| `SUPABASE_SECRET_KEY` (`sb_secret_…`) | SECRETO DE SERVIDOR | sí | no | solo para probar el programador en local |
| `SCHEDULER_SECRET` | SECRETO DE SERVIDOR | sí (el mismo valor que en Vault) | no | solo para probar el programador en local (puede ser otro valor) |
| `CANVAS_BASE_URL` | CONFIGURACIÓN DE SERVIDOR | sí | no | sí |
| `CANVAS_ACCESS_TOKEN` | SECRETO DE SERVIDOR | sí | no | sí |
| `GOOGLE_CLIENT_ID` | CONFIGURACIÓN DE SERVIDOR | sí | no | sí |
| `GOOGLE_CLIENT_SECRET` | SECRETO DE SERVIDOR | sí | no | sí |
| `GOOGLE_REDIRECT_URI` | CONFIGURACIÓN DE SERVIDOR | `https://<dominio>/api/integrations/google/callback` | no | `http://localhost:3000/api/integrations/google/callback` |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | SECRETO DE SERVIDOR | sí, **el mismo valor que en local** | no | sí |
| `GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS` | SECRETO DE SERVIDOR | solo durante una rotación | no | solo durante una rotación |
| `GROQ_API_KEY` | SECRETO DE SERVIDOR | sí | no | sí |
| `GROQ_MODEL` | CONFIGURACIÓN DE SERVIDOR | opcional | no | opcional |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | CONFIGURACIÓN DE SERVIDOR (valor público, llega al navegador por las props de Ajustes) | sí, **el mismo par que en local** | no | sí |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | SECRETO DE SERVIDOR | sí, **el mismo par que en local** | no | sí |
| `WEB_PUSH_SUBJECT` | CONFIGURACIÓN DE SERVIDOR | sí | no | sí |

Notas:

- **Preview sin variables.** Todas las instalaciones comparten una sola base de datos, así que una *preview* con credenciales trabajaría sobre tus datos reales. Sin variables, las *previews* no funcionan, a propósito.
- `GOOGLE_TOKEN_ENCRYPTION_KEY` debe ser **idéntica** en local y en producción: la conexión guardada está cifrada con ella. Con otra clave, producción no podría leerla y pediría reconectar.
- **No regeneres las claves VAPID** al desplegar: las suscripciones existentes dependen de ese par.
- `VERCEL_ENV` la pone Vercel: no la definas tú. En producción hace que se rechace un `GOOGLE_REDIRECT_URI` con `localhost` y activa HSTS.
- Nada de `SUPABASE_SERVICE_ROLE_KEY`: TRAZA solo acepta las claves secretas nuevas (`sb_secret_…`).

## Despliegue paso a paso

Los pasos que necesitan el dominio final van **después** del primer despliegue.

1. **Clave secreta de Supabase.** Ve a Supabase Dashboard → Project Settings → API Keys → *Secret keys* → crea una, por ejemplo `traza-scheduler`. Cópiala directamente a Vercel en el paso 4, sin guardarla en ningún archivo.
2. **`SCHEDULER_SECRET`.** Genera el valor en tu terminal; se imprime una sola vez para que lo pegues en Vercel (paso 4) y en Vault (paso 9):
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
3. **Proyecto de Vercel** (solo la primera vez; TRAZA ya está desplegada en `https://traza-gray.vercel.app`).
   - **Opción A, recomendada (git):** sube el repositorio a un repositorio **privado** de GitHub y en vercel.com/new → *Import Git Repository* elige ese repositorio. El preset es Next.js; deja *Build Command* y *Install Command* por defecto. La rama de producción es la rama por defecto.
   - **Opción B (CLI, sin git remoto):** `npx vercel@latest login` y después `npx vercel@latest link`. `.vercelignore` impide subir `.env*`.
   - En Settings → Functions comprueba que **Fluid Compute** está activado (lo está por defecto en proyectos nuevos): el programador declara `maxDuration = 300` s, y sin Fluid Compute el plan Hobby solo permite 60 s.
   - Opcional: en Settings → Functions → Region, elige la región más cercana a la de tu proyecto de Supabase.
4. **Variables de producción.** Settings → Environment Variables → añade cada variable de la tabla solo para *Production*. `GOOGLE_REDIRECT_URI` todavía no se puede poner: ver el paso 7.
5. **Primer despliegue.** Opción A: Deployments → *Redeploy*, o un *push* a la rama de producción. Opción B: `npx vercel@latest deploy --prod`.
6. **Dominio final.** Copia el dominio de Settings → Domains (por ejemplo `traza-xxxx.vercel.app`).
   - Comprueba `https://<dominio>/api/health` → `{"ok":true}`.
   - Añade `GOOGLE_REDIRECT_URI=https://<dominio>/api/integrations/google/callback` (Production) y vuelve a desplegar.
7. **Google Cloud Console.** Ve a APIs & Services → Credentials → tu cliente OAuth 2.0 (tipo *Web application*) → *Authorized redirect URIs* → **Add URI**: `https://<dominio>/api/integrations/google/callback`. **Conserva** la de `localhost`. Guarda (puede tardar unos minutos en aplicarse). No cambies el proyecto ni los permisos. Lee también "Google: estado de publicación".
8. **Supabase Auth.** Authentication → URL Configuration:
   - *Site URL*: `https://<dominio>`.
   - *Redirect URLs*: añade `https://<dominio>/**` y conserva `http://localhost:3000/**`.

   TRAZA inicia sesión con correo y contraseña y no usa redirecciones de Auth, así que esto es higiene más que requisito. En Authentication → Sign In / Providers, comprueba que **"Allow new users to sign up" sigue desactivado**.
9. **Vault.** Integrations → Vault → *Secrets* → *Add new secret*, dos veces. Escribe los valores en el formulario del panel, no en el chat:

   | Name | Value |
   | --- | --- |
   | `traza_scheduler_url` | `https://<dominio>/api/internal/scheduler` |
   | `traza_scheduler_secret` | el mismo valor que `SCHEDULER_SECRET` en Vercel |

   Equivalente en el SQL Editor (sustituye los marcadores; no guardes la consulta como *snippet*):
   ```sql
   select vault.create_secret('https://<dominio>/api/internal/scheduler', 'traza_scheduler_url', 'TRAZA scheduler endpoint');
   select vault.create_secret('<SCHEDULER_SECRET>', 'traza_scheduler_secret', 'TRAZA scheduler bearer secret');
   ```
10. **Supabase Cron.** Las migraciones `20261008094339_scheduler_cron.sql` (despertador) y `20261008121027_scheduler_rpcs.sql` (funciones `scheduler_*`) deben estar aplicadas. La primera ya crea los trabajos `traza-scheduler` (cada 5 min) y `traza-scheduler-cleanup` (historial de 7 días). No hay que instalar nada más. Compruébalo en el SQL Editor:
    ```sql
    select jobname, schedule, active from cron.job where jobname like 'traza-%';
    select traza_private.invoke_scheduler();             -- una ejecución ya; devuelve el id de la petición (null = falta algún secreto)
    -- unos segundos después:
    select status_code, content::jsonb -> 'outcome' as outcome, created
      from net._http_response order by created desc limit 5;                   -- 200 y "success"
    select status, return_message, start_time from cron.job_run_details
     where jobid = (select jobid from cron.job where jobname = 'traza-scheduler')
     order by start_time desc limit 5;
    ```
    Pausar: `select cron.alter_job((select jobid from cron.job where jobname = 'traza-scheduler'), active := false);`. Reanudar: lo mismo con `active := true`.
11. **Google en producción.** Con el mismo cliente OAuth y la misma `GOOGLE_TOKEN_ENCRYPTION_KEY`, la conexión que ya tienes sigue sirviendo y no hay que reconectar. Reconecta en Calendario → Google solo si TRAZA lo pide; por ejemplo, si la app de Google está en *Testing* y han pasado 7 días.
12. **iPhone.** Abre `https://<dominio>` en Safari → Compartir → **Añadir a pantalla de inicio** → abre TRAZA desde el icono. Necesitas iOS 16.4 o posterior.
13. **Web Push.** En TRAZA instalada: Ajustes → **Activar notificaciones** → Permitir → **Enviar notificación de prueba**.
14. **Aviso con TRAZA cerrada.** Crea una tarea para mañana. Después de las 20:00 (hora de Canarias), cierra TRAZA del todo. En 5–10 min llega "Tienes 1 tarea para mañana.", una sola vez. Tócala: se abre TRAZA.
15. **Campus programado.** Con TRAZA cerrada más de 30 min desde la última sincronización, consulta `canvas_sync_state` (`last_trigger = 'automatic'`, `last_success_at` reciente) o mira el estado de sincronización en Proyectos → Campus.
16. **Google programado.** Crea un evento en Google Calendar con TRAZA cerrada. En 15–20 min aparece en el Calendario de TRAZA.

## Google: estado de publicación

TRAZA pide `calendar.calendarlist.readonly` y `calendar.events.owned`. Desde aquí no puedo ver tu consola. Mira el estado en Google Cloud Console → Google Auth Platform → *Audience* (o "OAuth consent screen").

- **Testing** con tipo de usuario *External*: según Google, los *refresh tokens* caducan a los **7 días** cuando se piden permisos de Calendar. TRAZA lo detecta (`reconnect_required`), deja de intentarlo y te pide reconectar. El programador no puede evitarlo.
- **Opciones:**
  - seguir en *Testing* y reconectar cada semana;
  - o **publicar** la app ("Publish app" → *In production*), con lo que los tokens dejan de caducar a los 7 días.

  Los permisos de Calendar son "sensibles". Para tu propio uso, Google permite usar una app publicada sin verificar mostrando un aviso de "app no verificada", que se acepta en "Configuración avanzada". La verificación solo hace falta para quitar ese aviso o para tener muchos usuarios. Revisa los requisitos que muestre tu consola antes de publicar.

## Prueba local del programador

1. En `.env.local` añade `SCHEDULER_SECRET` (genéralo con el comando del paso 2). Si quieres la ejecución real, añade también `SUPABASE_SECRET_KEY`.
2. `npm run build`, luego `npm run start`.
3. Comprobaciones de rechazo (no hacen ningún trabajo real):
   ```powershell
   node scripts/scheduler-check.mjs
   ```
   Esperado: `401` sin cabecera, con secreto erróneo, con el secreto en la URL y con el secreto en el cuerpo; `405` para `GET`.
4. Ejecución real, solo si quieres. **Envía los avisos que estén pendientes** y sincroniza Campus y Google si les toca:
   ```powershell
   node scripts/scheduler-check.mjs --run
   ```
   Hace dos llamadas autorizadas. La segunda debe mostrar `notifications.sent: 0`, Campus `not_due` y Google `skipped`: nada se repite.

El script nunca imprime el secreto. Lee `SCHEDULER_SECRET` del entorno o de `.env.local` y solo lo envía en la cabecera `Authorization`.

## Verificación en producción

| Área | Comprobación |
| --- | --- |
| Auth | Inicio de sesión; no hay registro público; cerrar sesión vuelve a `/login`. |
| Datos | Inicio, Proyectos, Calendario e Inbox muestran tus datos; en otro navegador sin sesión todo redirige a `/login`. |
| Campus | Sincronización manual; automática con la app abierta; programada con la app cerrada (paso 15). |
| Google | Conectar en producción (vuelve a `/calendar?google=conectado`); sincronización manual, automática y programada (paso 16). |
| Asistente | Una pregunta responde (Groq); confirmar una propuesta la crea una sola vez (si se pulsa otra vez, no se duplica). |
| PWA | Se instala en el iPhone; el modo independiente respeta las zonas seguras; DevTools → Application muestra el service worker activo y solo `traza-static-v2` en la caché. |
| Push | Suscripción; notificación de prueba; aviso programado con TRAZA cerrada; al tocarla abre una ruta de TRAZA. |
| Programador | `POST /api/internal/scheduler` sin secreto → 401 (`node scripts/scheduler-check.mjs --base https://<dominio>`); `net._http_response` muestra 200 cada 5 min; ningún aviso repetido. |
| Sin rutas de desarrollo | `/dev/*` no existe: sin sesión redirige a `/login` como cualquier ruta privada; con sesión, 404. |

Permisos de las funciones del programador en el proyecto real (SQL Editor; las 9 filas deben mostrar `false` · `false` · `true`):

```sql
select p.proname,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'scheduler\_%'
 order by 1;
```

Lista completa para la publicación: [docs/release-checklist.md](release-checklist.md).

## Operación

- **Rotar `SCHEDULER_SECRET`:** genera uno nuevo y cámbialo en Vercel (Production; vuelve a desplegar). Después actualízalo en Vault: `select vault.update_secret((select id from vault.secrets where name = 'traza_scheduler_secret'), '<nuevo>');`. Entre los dos cambios, alguna llamada puede recibir 401, sin efecto.
- **Rotar `SUPABASE_SECRET_KEY`:** crea otra en Supabase, cámbiala en Vercel, vuelve a desplegar y borra la anterior.
- **Cabeceras de seguridad** (`next.config.ts`): `nosniff`, `Referrer-Policy`, sin *iframes* (`X-Frame-Options` + `frame-ancestors`), `object-src`/`base-uri` restringidos, `Permissions-Policy` mínima y HSTS en producción. La CSP completa con *nonces* para scripts queda pendiente a propósito.
- **Salud:** `GET /api/health` → `{"ok":true}`. No consulta la base de datos ni revela configuración.
