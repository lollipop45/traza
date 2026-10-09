# TRAZA 1.0.0 · Lista de verificación en producción

Comprobaciones manuales en <https://traza-gray.vercel.app> después de desplegar la versión 1.0.0. Usa datos de prueba que puedas borrar (por ejemplo, títulos que empiecen por "QA ·") y bórralos al terminar.

Antes de empezar: el despliegue de producción en Vercel muestra el *commit* de la versión 1.0.0 y `https://traza-gray.vercel.app/api/health` responde `{"ok":true}`.

## Auth

- [ ] Iniciar sesión con correo y contraseña lleva a Inicio.
- [ ] Cerrar sesión vuelve a `/login`; volver atrás en el navegador no muestra datos.
- [ ] No hay registro: en Supabase → Authentication → Sign In / Providers, "Allow new users to sign up" está desactivado.
- [ ] En una ventana privada sin sesión, `/`, `/calendar` y `/settings` redirigen a `/login`.

## Inicio / Tareas

- [ ] Crear una tarea con la captura rápida.
- [ ] Editar título, fecha y prioridad.
- [ ] Completarla.
- [ ] Reabrirla.
- [ ] Borrarla.
- [ ] Asignarle un proyecto y verla en ese proyecto.

## Proyectos

- [ ] Crear un proyecto.
- [ ] Editarlo (nombre, área, avance).
- [ ] Archivarlo.
- [ ] Borrarlo: sus tareas siguen existiendo, sin proyecto.

## Calendario

- [ ] Crear, editar y borrar un evento con hora.
- [ ] Crear y borrar un evento de todo el día: se queda en su día.
- [ ] Las tareas con fecha aparecen como entregas en su día.
- [ ] Navegar al mes anterior y al siguiente, y volver a hoy.

## Inbox

- [ ] Capturar una tarea (aparece también en Inicio).
- [ ] Capturar una nota.
- [ ] Capturar una idea.
- [ ] Los filtros muestran cada tipo.

## Campus (Canvas)

- [ ] Conexión: `/projects/canvas` muestra tus cursos activos.
- [ ] Vista previa manual: lista entregas para importar, revisar u omitir; no crea nada.
- [ ] Sincronización manual: crea las tareas; repetirla no las duplica.
- [ ] Incluir una entrega "a revisar" la importa en la siguiente sincronización.
- [ ] Ignorar una entrega importada quita su tarea y no vuelve a aparecer.
- [ ] Automática: con TRAZA abierta, el estado de sincronización se actualiza (como mucho cada 30 min).
- [ ] Programada con la app cerrada: tras más de 30 min cerrada, `canvas_sync_state` muestra `last_trigger = 'automatic'` y un `last_success_at` reciente.

## Google Calendar

- [ ] Conectar (o reconectar) vuelve a `/calendar?google=conectado`.
- [ ] Elegir el calendario de TRAZA.
- [ ] Vista previa: indica qué se enviará y qué se importará, sin cambiar nada.
- [ ] Sincronización en los dos sentidos: un evento de TRAZA aparece en Google y un evento de Google aparece en TRAZA; repetirla no duplica nada.
- [ ] Automática oportunista: con TRAZA abierta, un cambio en Google llega en ≤ 15 min.
- [ ] Programada con la app cerrada: un evento creado en Google con TRAZA cerrada aparece en 15–20 min.

## Asistente

- [ ] Una pregunta de solo lectura ("¿Qué tengo mañana?") responde con tus datos y no propone nada.
- [ ] Pedir una tarea produce una propuesta.
- [ ] Antes de confirmar no se ha creado nada (Inicio no la muestra).
- [ ] Confirmar la crea una vez.
- [ ] Recargar la página tras confirmar no la duplica; volver a pulsar dice que ya está creada.
- [ ] Descartar una propuesta impide crearla.
- [ ] Pedir algo en un proyecto que no existe no lo inventa ni lo asigna.
- [ ] Fallo del proveedor (por ejemplo, `GROQ_API_KEY` vacía temporalmente en Vercel → *Redeploy*): se ve una frase fija en español, sin detalles; restaurar la clave después.

## PWA

- [ ] Instalar en iPhone: Safari → Compartir → Añadir a pantalla de inicio.
- [ ] El icono de la pantalla de inicio es la marca oficial de TRAZA (si se instaló antes, quítalo y vuelve a añadirlo).
- [ ] Se abre en modo independiente, sin barra de Safari.
- [ ] Zonas seguras: nada queda bajo la muesca ni bajo el indicador de inicio; la barra inferior respeta el indicador.
- [ ] Sin conexión (modo avión), abrir TRAZA muestra "Sin conexión" con la marca, sin ningún dato tuyo.
- [ ] Chrome de escritorio → DevTools → Application: *service worker* activo y solo la caché `traza-static-v2`.

## Avisos (Web Push)

- [ ] Ajustes → Activar notificaciones → Permitir: el estado pasa a activas.
- [ ] Enviar notificación de prueba: llega a este dispositivo.
- [ ] Desactivar en un dispositivo deja de enviarle avisos, sin afectar a los demás.
- [ ] Aviso programado con la app cerrada: crea una tarea para mañana, cierra TRAZA del todo después de las 20:00 (hora de Canarias); en 5–10 min llega "Tienes 1 tarea para mañana.", una sola vez.
- [ ] Tocar la notificación abre TRAZA en la pantalla correspondiente.

## Seguridad

- [ ] `/dev/supabase` y `/dev/canvas` no existen: sin sesión redirigen a `/login`; con sesión muestran "No encontrada" (404).
- [ ] Programador sin autorización → 401: `node scripts/scheduler-check.mjs --base https://traza-gray.vercel.app` (todas las comprobaciones `OK`).
- [ ] Programador por Cron → 200: en el SQL Editor, `select status_code, content::jsonb -> 'outcome' from net._http_response order by created desc limit 5;` muestra `200` y `"success"`.
- [ ] Ningún secreto en el navegador: en DevTools → Sources, buscar `sb_secret_`, `GROQ_API_KEY`, `SCHEDULER_SECRET`, `CANVAS_ACCESS_TOKEN` y `GOOGLE_CLIENT_SECRET` en los archivos de `/_next/static` no encuentra nada.
- [ ] Permisos de las funciones del programador (SQL Editor): la consulta de [docs/production.md](production.md) devuelve `false` para `anon` y `authenticated` en las 9 funciones `scheduler_*`.

## Cierre

- [ ] Borrar los datos de prueba "QA ·" (tareas, eventos, notas, proyectos, eventos de prueba en Google).
- [ ] Crear la etiqueta `v1.0.0` (ver el informe de la versión).
