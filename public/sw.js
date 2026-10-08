/* TRAZA service worker.
 *
 * Deliberately conservative: TRAZA holds private data, so this worker caches NOTHING that comes
 * from the app at run time. Its only jobs:
 *   1. make TRAZA installable;
 *   2. show a generic, static offline page when a page navigation fails for lack of network;
 *   3. receive Web Push messages and show them;
 *   4. open / focus TRAZA when a notification is clicked (same-origin paths only).
 *
 * Cached (precached at install, in one versioned cache): the offline page and the PWA icons. All
 * public, static and user-independent.
 * Never cached: pages (HTML), API routes, Server Actions, Supabase, Canvas, Google, assistant
 * messages, tasks, projects, events, Inbox, auth/session responses, Next.js data or chunks.
 * Navigations always go to the network; only a network FAILURE shows /offline.html.
 *
 * Updating: bump VERSION. The new worker activates at once (skipWaiting + clients.claim, without
 * reloading any page) and deletes every older TRAZA cache.
 */
const VERSION = "v1";
const CACHE_PREFIX = "traza-static-";
const STATIC_CACHE = CACHE_PREFIX + VERSION;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png", "/icons/badge-96.png"];

/** Paths a notification may open: TRAZA's own screens only. */
const SAFE_PATHS = ["/", "/calendar", "/inbox", "/projects", "/assistant", "/settings"];
const DEFAULT_NOTIFICATION = { title: "TRAZA", body: "Tienes novedades en TRAZA.", url: "/", tag: "traza" };

/** A same-origin TRAZA path from untrusted push data, or "/". Never an external URL. */
function safePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  let url;
  try {
    url = new URL(value, self.location.origin);
  } catch {
    return "/";
  }
  if (url.origin !== self.location.origin) return "/";
  return SAFE_PATHS.includes(url.pathname) ? url.pathname : "/";
}

function clip(value, max, fallback) {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** The notification to show for a push message; malformed data yields a generic one. */
function notificationFromPush(data) {
  let payload = null;
  try {
    payload = data ? data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return DEFAULT_NOTIFICATION;
  return {
    title: clip(payload.title, 80, DEFAULT_NOTIFICATION.title),
    body: clip(payload.body, 240, DEFAULT_NOTIFICATION.body),
    url: safePath(payload.url),
    tag: typeof payload.tag === "string" && /^[a-z0-9:_.-]{1,64}$/i.test(payload.tag) ? payload.tag : DEFAULT_NOTIFICATION.tag,
  };
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((path) => new Request(path, { cache: "reload", credentials: "omit" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Page navigations: always the network. Only when the network fails, the generic offline page
  // (never a cached private page).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(STATIC_CACHE).then((cache) => cache.match(OFFLINE_URL)).then((response) => response || Response.error()),
      ),
    );
    return;
  }

  // The precached static files themselves (icons, offline page): cache first. Everything else is
  // left to the browser untouched (no respondWith, nothing stored).
  if (PRECACHE.includes(url.pathname) && url.search === "") {
    event.respondWith(caches.match(url.pathname).then((cached) => cached || fetch(request)));
  }
});

self.addEventListener("push", (event) => {
  const notification = notificationFromPush(event.data);
  event.waitUntil(
    self.registration.showNotification(notification.title, {
      body: notification.body,
      tag: notification.tag,
      data: { url: notification.url },
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      lang: "es",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        // navigate() only works on windows this worker controls; otherwise focusing is enough.
        return existing
          .focus()
          .then((client) => (client && "navigate" in client ? client.navigate(target) : client))
          .catch(() => undefined);
      }
      return self.clients.openWindow(target);
    }),
  );
});

// Some browsers rotate push subscriptions. Re-subscribe with the same options and tell TRAZA (same
// origin, the user's own session cookie); failures are ignored: the device then shows "Activar" again.
self.addEventListener("pushsubscriptionchange", (event) => {
  const options = event.oldSubscription && event.oldSubscription.options;
  if (!options) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe(options)
      .then((subscription) =>
        fetch("/api/notifications/subscription", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "x-traza-push": "1" },
          body: JSON.stringify({ subscription: subscription.toJSON() }),
        }),
      )
      .catch(() => undefined),
  );
});
