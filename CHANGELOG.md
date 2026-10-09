# Changelog

## TRAZA 1.0.0

Primera versión completa: una aplicación personal de productividad, en español, para el trabajo de la universidad. Desplegada en Vercel con Supabase. Desarrollada entre el 5 y el 9 de octubre de 2026.

### Producto

- **Inicio**: tareas de hoy, captura rápida, proyectos activos y eventos del día.
- **Tareas**: crear, editar, fecha, prioridad, completar, reabrir y borrar; proyecto opcional.
- **Proyectos**: crear, editar, archivar y borrar; recuentos de tareas y avance.
- **Calendario**: vista mensual con eventos propios (con hora o de todo el día) y entregas.
- **Inbox**: captura de tareas, notas e ideas; filtros y edición.
- **Campus (Canvas)**: vinculación curso ↔ proyecto, sincronización de entregas con vista previa, clasificación por relevancia y decisiones duraderas de importar/ignorar. Canvas solo se lee.
- **Google Calendar**: conexión OAuth, elección de calendario y sincronización en los dos sentidos (eventos y entregas de TRAZA → Google; eventos de Google → TRAZA), con tokens cifrados.
- **Asistente**: preguntas sobre tus datos con Groq y propuestas (tarea, evento, nota, idea) que solo se crean al confirmarlas; conversaciones guardadas.
- **App instalable**: PWA con la marca oficial de TRAZA, *service worker* conservador y página sin conexión; zonas seguras del iPhone.
- **Avisos**: Web Push por dispositivo, preferencias y avisos (tareas para mañana, resumen de la mañana, antes de eventos con hora) que nunca se envían dos veces.
- **En segundo plano**: Supabase Cron despierta cada 5 minutos un programador de confianza; avisos, Campus y Google siguen funcionando con TRAZA cerrada.

### Seguridad

- Supabase Auth (correo y contraseña, sin registro público); la identidad sale de los *claims* verificados del JWT.
- RLS en todas las tablas, políticas solo del dueño y claves foráneas compuestas por dueño; sin acceso anónimo.
- El programador usa una clave secreta solo de servidor, a través de un ámbito por usuario y de funciones `scheduler_*` que solo puede ejecutar `service_role`; nunca crea sesiones de usuario.
- Comprobación de mismo origen en los endpoints que llama el navegador, cabeceras de seguridad y HSTS en producción; ningún secreto llega al navegador.

### Cierre de la versión

- Eliminadas las rutas de diagnóstico `/dev/*` y su excepción de inicio de sesión.
- Eliminado el adaptador inactivo de Gemini; sus pruebas de reintentos se ejecutan ahora con Groq.
- Páginas de error y de "no encontrada" en español.
- Auditoría de seguridad de toda la base de datos como prueba (`tests/db/security-audit.test.ts`).
- Los archivos de credenciales descargados de las consolas de los proveedores quedan ignorados por git.
- README, documentación de producción y de base de datos al día; lista de comprobación de la publicación.
