# TRAZA

Aplicación personal de productividad para la universidad, en español: tareas, proyectos, calendario, inbox, entregas de Campus Virtual (Canvas), Google Calendar, un asistente con IA y avisos en el móvil. Uso privado de una sola persona (sin registro público).

Versión **1.0.0** · Producción: <https://traza-gray.vercel.app> · Cambios: [CHANGELOG.md](CHANGELOG.md)

## Pila

- **Next.js 16** (App Router, Server Components, Server Actions), **React 19**, **Tailwind CSS 4**, TypeScript.
- **Supabase**: Postgres, Auth, RLS, Cron (`pg_cron`), `pg_net` y Vault.
- **Vercel** (Fluid Compute) para la aplicación.
- **Groq** (`openai/gpt-oss-20b`) para el asistente · **Canvas REST API** · **Google Calendar API** · **Web Push** (`web-push`, VAPID).
- Pruebas: `node:test` con `tsx`; la base de datos se prueba con **PGlite** (Postgres en memoria) aplicando las migraciones reales.

## Arquitectura

```
Navegador (PWA) ──► proxy.ts: sesión Supabase (getClaims) y reglas de rutas
                 ──► Server Components (lecturas con la sesión del usuario → RLS)
                 ──► Server Actions / rutas /api con mismo origen (escrituras → RLS y funciones fijadas a auth.uid())

Supabase Cron (cada 5 min) ──► pg_net ──► POST /api/internal/scheduler (Bearer SCHEDULER_SECRET)
                           ──► lib/scheduler: candidatos → ámbito por usuario → funciones scheduler_* → mismos motores
```

- `app/`: pantallas (`(app)/` privadas, `login/`) y rutas API.
- `lib/`: lógica por dominio (`tasks`, `projects`, `calendar`, `inbox`, `canvas`, `google-calendar`, `assistant`, `ai`, `notifications`, `pwa`, `scheduler`, `supabase`, `auth`, `security`).
- `components/`: interfaz. `public/`: `sw.js`, `offline.html`, iconos y marca.
- `supabase/migrations/`: el esquema completo. `docs/`: guías detalladas.

## Puesta en marcha local

Requisitos: Node.js 20 o posterior y acceso al proyecto de Supabase.

```bash
npm install
# crea .env.local con las variables de abajo (nunca se sube al repositorio)
npm run dev          # http://localhost:3000
```

Inicia sesión con el usuario creado a mano en Supabase (Authentication → Users). Desarrollo local y producción comparten el mismo proyecto de Supabase.

## Variables de entorno

Solo los nombres; los valores van en `.env.local` (local) o en Vercel → Environment Variables (producción). Tabla completa con cuáles son secretos y cuáles deben coincidir entre local y producción: [docs/production.md](docs/production.md#variables-de-entorno).

| Grupo | Variables |
| --- | --- |
| Supabase (públicas) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| Programador (servidor) | `SUPABASE_SECRET_KEY`, `SCHEDULER_SECRET` |
| Canvas (servidor) | `CANVAS_BASE_URL`, `CANVAS_ACCESS_TOKEN` |
| Google (servidor) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS` (solo al rotar) |
| Asistente (servidor) | `GROQ_API_KEY`, `GROQ_MODEL` (opcional) |
| Web Push (servidor) | `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` |

Ningún secreto usa el prefijo `NEXT_PUBLIC_`. Sin una integración configurada, su pantalla sigue funcionando y lo indica.

## Base de datos y migraciones

```bash
npm run db:new -- <nombre>   # nueva migración en supabase/migrations/
npm run db:push              # aplica las migraciones pendientes al proyecto enlazado
npm run db:types             # regenera lib/supabase/database.types.ts (no se edita a mano)
```

Migraciones, en orden: tareas y privilegios (`20261005114557`, `20261005123716`), proyectos (`20261005160009`), calendario (`20261005162926`), inbox (`20261005165232`), Canvas (`20261005172944`, `20261006070920`, `20261006082922`, `20261007083209`), Google Calendar (`20261006095932`, `20261006122922`, `20261007103558`), asistente (`20261006141207`), avisos (`20261008083736`) y programador (`20261008094339`, `20261008121027`). Una migración aplicada no se modifica: los cambios van en una nueva. Detalle de cada tabla y función: [docs/supabase.md](docs/supabase.md).

## Integraciones

- **Canvas** (`/projects/canvas`): vincula cursos a proyectos y sincroniza entregas como tareas (`source = 'canvas'`). Solo lee Canvas. Automática como mucho cada 30 min. El token es personal: el programador solo sincroniza si un único usuario tiene cursos vinculados.
- **Google Calendar** (`/calendar`): OAuth con PKCE y permisos mínimos (`calendar.calendarlist.readonly`, `calendar.events.owned`); tokens cifrados con AES-256-GCM en el servidor. Los eventos y entregas de TRAZA se reflejan en Google; los eventos de Google se importan sin reexportarse. Automática como mucho cada 15 min.
- **Asistente** (`/assistant`): el modelo solo devuelve JSON validado por TRAZA. Propone crear tareas, eventos, notas o ideas, y **nada se crea sin tu confirmación** (idempotente). No edita, no borra y no llama a Canvas ni a Google.

## PWA y avisos

Manifiesto, iconos generados desde `public/brand/traza-mark.svg` (`node scripts/generate-icons.mjs`) y un *service worker* que solo guarda la página sin conexión y los iconos: nunca páginas, API ni datos. Avisos Web Push por dispositivo desde Ajustes, con preferencias; cada aviso tiene una clave única en la base de datos y no se envía dos veces. En iPhone requieren TRAZA instalada (iOS 16.4+).

## Programador en segundo plano

Supabase Cron llama cada 5 minutos a `POST /api/internal/scheduler` con `Authorization: Bearer <SCHEDULER_SECRET>`; la URL y el secreto viven en Supabase Vault. La ruta ejecuta los mismos motores de avisos, Canvas y Google que la app, con la clave secreta de Supabase pero siempre acotada a un usuario explícito, sin iniciar sesión por nadie. Turnos (*leases*) en la base de datos impiden trabajo duplicado. Detalle: [docs/production.md](docs/production.md).

## Producción

Despliegue, variables, Vault, Cron, Google OAuth y comprobaciones: [docs/production.md](docs/production.md). Lista de verificación manual de la publicación: [docs/release-checklist.md](docs/release-checklist.md).

## Pruebas

```bash
npm run lint
npm run build
npm run test:unit   # lógica, integraciones con fetch falso, service worker en un sandbox
npm run test:db     # migraciones reales en PGlite: RLS, privilegios, funciones, auditoría de seguridad
```

Las pruebas no usan red ni credenciales: nunca llaman a Canvas, Google, Groq, servicios de push ni al programador de producción.

## Seguridad

- **Privado por defecto**: toda ruta exige sesión salvo `/login`, el manifiesto, el *service worker*, la página sin conexión, `/api/health` y el programador (que exige su propio secreto).
- **La base de datos decide**: RLS en todas las tablas, políticas solo del dueño, claves foráneas compuestas `(…, user_id)` y funciones con `search_path` vacío fijadas a `auth.uid()`. `tests/db/security-audit.test.ts` falla si una migración rompe alguna de estas reglas.
- **Mínimo privilegio**: la clave secreta de Supabase solo la usa el programador, a través de un ámbito por usuario; los clientes nunca pueden ejecutar las funciones `scheduler_*`.
- **Sin secretos en el navegador ni en el repositorio**; errores al usuario como frases fijas en español, sin detalles de proveedores.
- **La IA no tiene poder propio**: solo propone, y tú confirmas.
