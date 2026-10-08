// PWA: manifest, icons, metadata/viewport, the REAL service worker (public/sw.js, executed in a vm
// sandbox with fake caches/clients/fetch), install and push-support rules, and mobile CSS. No browser,
// no network.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import manifest from "@/app/manifest";
import { isPublicPath } from "@/lib/auth/routes";
import { NOTIFICATION_PATHS } from "@/lib/notifications/payload";
import {
  INSTALL_HINT_SNOOZE_MS,
  applicationServerKey,
  deviceNotificationState,
  installState,
  isIOS,
  isStandalone,
  pushSupport,
  shouldShowInstallHint,
  type DisplayEnvironment,
} from "@/lib/pwa/device";

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

// ---------------------------------------------------------------------------
// Manifest and icons
// ---------------------------------------------------------------------------

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): [number, number] {
  const data = readFileSync(path.join(ROOT, file));
  assert.equal(data.subarray(1, 4).toString("ascii"), "PNG", file);
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

describe("PWA manifest", () => {
  const m = manifest();

  it("describes TRAZA as a standalone Spanish app on the sand palette", () => {
    assert.equal(m.name, "TRAZA");
    assert.equal(m.short_name, "TRAZA");
    assert.equal(m.start_url, "/");
    assert.equal(m.scope, "/");
    assert.equal(m.display, "standalone");
    assert.equal(m.lang, "es");
    assert.equal(m.background_color, "#F4F2ED");
    assert.equal(m.theme_color, "#F4F2ED");
    assert.ok(m.description && m.description.length > 10);
    assert.equal(m.orientation, undefined, "no orientation lock (tablets and desktop)");
  });

  it("lists local any + maskable icons at 192 and 512 that exist with the stated sizes", () => {
    const icons = m.icons ?? [];
    for (const [size, purpose] of [
      [192, "any"],
      [512, "any"],
      [192, "maskable"],
      [512, "maskable"],
    ] as const) {
      const icon = icons.find((entry) => entry.sizes === `${size}x${size}` && entry.purpose === purpose);
      assert.ok(icon, `${size} ${purpose}`);
      assert.match(icon.src, /^\/icons\/[a-z0-9-]+\.png$/, "local static asset");
      assert.deepEqual(pngSize(`public${icon.src}`), [size, size]);
    }
    assert.deepEqual(pngSize("public/icons/apple-touch-icon.png"), [180, 180]);
    assert.deepEqual(pngSize("public/icons/badge-96.png"), [96, 96]);
    assert.ok(existsSync(path.join(ROOT, "app/favicon.ico")));
  });

  it("the manifest, worker and offline page are reachable without a session; private routes are not", () => {
    for (const p of ["/manifest.webmanifest", "/sw.js", "/offline.html", "/login"]) assert.equal(isPublicPath(p), true, p);
    for (const p of ["/", "/settings", "/calendar", "/api/notifications/subscription", "/offline"]) assert.equal(isPublicPath(p), false, p);
  });
});

describe("root metadata and viewport", () => {
  const layout = read("app/layout.tsx");

  it("enables the iPhone Home Screen app titled TRAZA, with local icons", () => {
    assert.match(layout, /appleWebApp: \{ capable: true, title: "TRAZA", statusBarStyle: "default" \}/);
    assert.match(layout, /apple: \[\{ url: "\/icons\/apple-touch-icon\.png", sizes: "180x180"/);
    assert.match(layout, /applicationName: "TRAZA"/);
  });

  it("uses viewport-fit=cover, the sand theme colour, and never disables zoom", () => {
    assert.match(layout, /viewportFit: "cover"/);
    assert.match(layout, /themeColor: "#F4F2ED"/);
    assert.doesNotMatch(layout, /maximumScale|userScalable|minimumScale/);
  });

  it("registers the worker from a small client component; the root layout stays a Server Component", () => {
    assert.doesNotMatch(layout, /^\s*["']use client["']/);
    assert.match(layout, /<PwaRegistrar \/>/);
    const registrar = read("components/pwa/PwaRegistrar.tsx");
    assert.match(registrar, /navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/", updateViaCache: "none" \}\)\.catch\(/);
    assert.doesNotMatch(registrar, /console\.|location\.reload|requestPermission/);
  });

  it("serves the worker uncached with a same-origin script policy", () => {
    const config = read("next.config.ts");
    assert.match(config, /source: "\/sw\.js"/);
    assert.match(config, /no-cache, no-store, must-revalidate/);
    assert.match(config, /default-src 'self'; script-src 'self'/);
  });
});

// ---------------------------------------------------------------------------
// The real service worker, in a sandbox
// ---------------------------------------------------------------------------

const ORIGIN = "https://traza.example.com";

type Handler = (event: Record<string, unknown>) => void;

function loadWorker(options: { network?: "up" | "down"; windows?: { url: string; navigate?: boolean }[] } = {}) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, Response>>();
  const fetched: string[] = [];
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const focused: string[] = [];
  const deleted: string[] = [];
  const posted: { url: string; body: string }[] = [];
  let skipped = false;
  let claimed = false;

  const keyOf = (input: Request | string) => {
    const url = new URL(typeof input === "string" ? input : input.url, ORIGIN);
    return url.pathname + url.search;
  };
  const cacheFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      async addAll(requests: (Request | string)[]) {
        for (const request of requests) store.set(keyOf(request), new Response(`static ${keyOf(request)}`, { status: 200 }));
      },
      async match(input: Request | string) {
        return store.get(keyOf(input))?.clone();
      },
      async put(input: Request | string, response: Response) {
        store.set(keyOf(input), response);
      },
    };
  };
  const caches = {
    open: async (name: string) => cacheFor(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => {
      deleted.push(name);
      return stores.delete(name);
    },
    match: async (input: Request | string) => {
      for (const name of stores.keys()) {
        const hit = await cacheFor(name).match(input);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const windows = (options.windows ?? []).map((w) => ({
    url: w.url,
    focus: async function () {
      focused.push(w.url);
      return this;
    },
    ...(w.navigate === false
      ? {}
      : {
          navigate: async (target: string) => {
            navigated.push(target);
          },
        }),
  }));
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: async () => {
      skipped = true;
    },
    clients: {
      claim: async () => {
        claimed = true;
      },
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
    registration: {
      showNotification: async (title: string, opts: Record<string, unknown>) => {
        shown.push({ title, options: opts });
      },
      pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: "https://push.example.com/new", keys: {} }) }) },
    },
  };
  const fetchFn = async (input: Request | string | { url: string }, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    fetched.push(url);
    if (init?.method === "POST") posted.push({ url, body: String(init.body) });
    if (options.network === "down") throw new TypeError("Failed to fetch");
    return new Response(`network ${url}`, { status: 200 });
  };
  // In a real worker, relative URLs resolve against the worker's origin.
  class WorkerRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
    }
  }
  const context = vm.createContext({ self, caches, fetch: fetchFn, Request: WorkerRequest, Response, URL, Promise, JSON, String, Number, Array, Object });
  vm.runInContext(read("public/sw.js"), context, { filename: "sw.js" });

  async function dispatch(type: string, event: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | null = null;
    handlers[type]({
      ...event,
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      respondWith: (promise: Promise<Response>) => {
        responded = promise;
      },
    });
    await Promise.all(waits);
    return responded as Promise<Response> | null;
  }

  // The fields the worker reads from a FetchEvent's request.
  const request = (url: string, mode: string, method = "GET") => ({ url: new URL(url, ORIGIN).href, mode, method });
  return {
    handlers,
    stores,
    fetched,
    shown,
    opened,
    navigated,
    focused,
    deleted,
    posted,
    caches,
    dispatch,
    request,
    flags: () => ({ skipped, claimed }),
    install: () => dispatch("install"),
    activate: () => dispatch("activate"),
    fetch: (url: string, mode = "no-cors", method = "GET") => dispatch("fetch", { request: request(url, mode, method) }),
    push: (data: unknown) => dispatch("push", { data }),
    click: (url: unknown) => {
      const notification = { data: { url }, closed: false, close() { this.closed = true; } };
      return dispatch("notificationclick", { notification }).then(() => notification);
    },
  };
}

/** Objects built inside the vm sandbox have another realm's prototypes: compare plain copies. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const pushData = (value: unknown) => ({ json: () => (typeof value === "string" ? JSON.parse(value) : value) });

describe("service worker: caching", () => {
  it("precaches only the offline page and icons, in one versioned cache", async () => {
    const sw = loadWorker();
    await sw.install();
    assert.deepEqual([...sw.stores.keys()], ["traza-static-v1"]);
    assert.deepEqual([...sw.stores.get("traza-static-v1")!.keys()].sort(), ["/icons/badge-96.png", "/icons/icon-192.png", "/icons/icon-512.png", "/offline.html"]);
    assert.equal(sw.flags().skipped, true);
  });

  it("never caches app pages, APIs, Server Actions, Supabase or third-party responses", async () => {
    const sw = loadWorker();
    await sw.install();
    const before = JSON.stringify([...sw.stores.get("traza-static-v1")!.keys()]);
    for (const [url, mode, method] of [
      ["/", "navigate", "GET"],
      ["/calendar", "navigate", "GET"],
      ["/assistant", "navigate", "GET"],
      ["/api/integrations/google/auto-sync", "cors", "POST"],
      ["/api/notifications/subscription", "cors", "POST"],
      ["/_next/static/chunks/app.js", "no-cors", "GET"],
      ["/?_rsc=abc", "cors", "GET"],
      ["https://abcd.supabase.co/rest/v1/tasks", "cors", "GET"],
      ["https://www.googleapis.com/calendar/v3/x", "cors", "GET"],
    ] as const) {
      const responded = await sw.fetch(url, mode, method);
      if (mode === "navigate") assert.ok(responded, "navigations go through the worker (network first)");
      else assert.equal(responded, null, `${url} is left to the browser`);
    }
    assert.equal(JSON.stringify([...sw.stores.get("traza-static-v1")!.keys()]), before, "nothing was stored");
    assert.equal(sw.stores.size, 1);
  });

  it("navigations use the network; only a network failure shows the generic offline page", async () => {
    const online = loadWorker();
    await online.install();
    const page = await (await online.fetch("/calendar", "navigate"))!;
    assert.equal(await page.text(), `network ${ORIGIN}/calendar`);

    const offline = loadWorker({ network: "down" });
    await offline.caches.open("traza-static-v1").then((cache) => cache.addAll(["/offline.html"]));
    const fallback = await (await offline.fetch("/projects", "navigate"))!;
    assert.equal(await fallback.text(), "static /offline.html", "never a cached private page");
  });

  it("activation deletes every older cache and claims open windows without reloading", async () => {
    const sw = loadWorker();
    await sw.caches.open("traza-static-v0");
    await sw.caches.open("some-old-cache");
    await sw.install();
    await sw.activate();
    assert.deepEqual(sw.deleted.sort(), ["some-old-cache", "traza-static-v0"]);
    assert.deepEqual([...sw.stores.keys()], ["traza-static-v1"]);
    assert.equal(sw.flags().claimed, true);
    assert.doesNotMatch(read("public/sw.js"), /location\.reload|\.reload\(/);
  });

  it("the offline page is static and shows no user data", () => {
    const html = read("public/offline.html");
    assert.match(html, /Sin conexión/);
    assert.match(html, /TRAZA necesita conexión para acceder a tus datos actualizados/);
    assert.doesNotMatch(html, /<script\b|fetch\(|supabase|localStorage|indexedDB/i);
  });
});

describe("service worker: push and notification clicks", () => {
  it("shows a valid payload, clipped, with a safe path", async () => {
    const sw = loadWorker();
    await sw.push(pushData({ title: "TRAZA", body: "Tienes 2 tareas para mañana.", url: "/calendar", tag: "tomorrow-2026-10-09", kind: "tomorrow_tasks" }));
    assert.deepEqual(plain(sw.shown[0]), {
      title: "TRAZA",
      options: { body: "Tienes 2 tareas para mañana.", tag: "tomorrow-2026-10-09", data: { url: "/calendar" }, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", lang: "es" },
    });
  });

  it("malformed or missing payloads show a generic TRAZA notification instead of crashing", async () => {
    const sw = loadWorker();
    await sw.push({ json: () => JSON.parse("{not json") });
    await sw.push(null);
    await sw.push(pushData([1, 2, 3]));
    await sw.push(pushData({ title: 42, body: "", url: "javascript:alert(1)", tag: "<script>" }));
    assert.equal(sw.shown.length, 4);
    for (const { title, options } of sw.shown) {
      assert.equal(title, "TRAZA");
      assert.deepEqual(plain(options.data), { url: "/" });
    }
    assert.equal(sw.shown[3].options.tag, "traza");
  });

  it("rejects external, protocol-relative and unknown URLs from push data", async () => {
    const sw = loadWorker();
    for (const url of ["https://evil.example.com/", "//evil.example.com", "/\\evil.example.com", "javascript:alert(1)", "/api/notifications/check", "/settings/../../x"]) {
      await sw.push(pushData({ title: "TRAZA", body: "x", url }));
    }
    for (const notification of sw.shown) assert.equal((notification.options.data as { url: string }).url, "/", JSON.stringify(notification.options.data));
    // An allowed screen keeps only its path: queries and fragments from push data are dropped.
    await sw.push(pushData({ title: "TRAZA", body: "x", url: "/calendar?next=https://evil.example.com#x" }));
    assert.equal((sw.shown.at(-1)!.options.data as { url: string }).url, "/calendar");
  });

  it("a click closes the notification and focuses an open TRAZA window, navigating to the safe path", async () => {
    const sw = loadWorker({ windows: [{ url: `${ORIGIN}/inbox` }] });
    const notification = await sw.click("/calendar");
    assert.equal(notification.closed, true);
    assert.deepEqual(sw.focused, [`${ORIGIN}/inbox`]);
    assert.deepEqual(sw.navigated, [`${ORIGIN}/calendar`]);
    assert.deepEqual(sw.opened, []);
  });

  it("with no TRAZA window it opens one; external URLs never leave the origin", async () => {
    const sw = loadWorker({ windows: [{ url: "https://other.example.com/" }] });
    await sw.click("https://evil.example.com/phish");
    assert.deepEqual(sw.opened, [`${ORIGIN}/`]);
  });

  it("the worker's allowed paths are exactly the server's", () => {
    const list = read("public/sw.js").match(/const SAFE_PATHS = (\[[^\]]+\]);/)?.[1];
    assert.ok(list);
    assert.deepEqual(JSON.parse(list), [...NOTIFICATION_PATHS]);
  });

  it("a rotated subscription is re-sent to TRAZA's own endpoint only", async () => {
    const sw = loadWorker();
    await sw.dispatch("pushsubscriptionchange", { oldSubscription: { options: { userVisibleOnly: true } } });
    assert.equal(sw.posted.length, 1);
    assert.equal(new URL(sw.posted[0].url, ORIGIN).origin, ORIGIN);
    assert.equal(new URL(sw.posted[0].url, ORIGIN).pathname, "/api/notifications/subscription");
  });
});

// ---------------------------------------------------------------------------
// Install and device rules
// ---------------------------------------------------------------------------

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const env = (fields: Partial<DisplayEnvironment>): DisplayEnvironment => ({ standaloneMedia: false, navigatorStandalone: undefined, userAgent: CHROME, maxTouchPoints: 0, ...fields });
const ALL = { serviceWorker: true, pushManager: true, notification: true };

describe("install and standalone detection", () => {
  it("detects standalone through display-mode or iOS navigator.standalone", () => {
    assert.equal(isStandalone(env({ standaloneMedia: true })), true);
    assert.equal(isStandalone(env({ userAgent: IPHONE, navigatorStandalone: true })), true);
    assert.equal(isStandalone(env({ userAgent: IPHONE, navigatorStandalone: false })), false);
    assert.equal(isStandalone(env({})), false);
  });

  it("recognises iPhone and iPadOS (desktop-class user agent with touch)", () => {
    assert.equal(isIOS(env({ userAgent: IPHONE })), true);
    assert.equal(isIOS(env({ userAgent: IPAD, maxTouchPoints: 5 })), true);
    assert.equal(isIOS(env({ userAgent: IPAD, maxTouchPoints: 0 })), false, "a real Mac");
    assert.equal(isIOS(env({})), false);
  });

  it("installed hides every install control; Chromium uses beforeinstallprompt; iPhone gets Share instructions", () => {
    assert.equal(installState(env({ standaloneMedia: true }), true), "installed");
    assert.equal(installState(env({ userAgent: IPHONE, navigatorStandalone: true }), false), "installed");
    assert.equal(installState(env({}), true), "prompt");
    assert.equal(installState(env({ userAgent: IPHONE }), false), "ios");
    assert.equal(installState(env({}), false), "unavailable");
  });

  it("the install hint is restrained: hidden when installed or unavailable, and for 30 days after dismissal", () => {
    const now = Date.parse("2026-10-08T10:00:00Z");
    assert.equal(shouldShowInstallHint("installed", null, now), false);
    assert.equal(shouldShowInstallHint("unavailable", null, now), false);
    assert.equal(shouldShowInstallHint("prompt", null, now), true);
    assert.equal(shouldShowInstallHint("ios", null, now), true);
    assert.equal(shouldShowInstallHint("ios", now - 24 * 3600_000, now), false);
    assert.equal(shouldShowInstallHint("ios", now - INSTALL_HINT_SNOOZE_MS, now), true);
    assert.equal(shouldShowInstallHint("prompt", now + 999_999, now), true, "a timestamp from the future is ignored");
    assert.equal(INSTALL_HINT_SNOOZE_MS, 30 * 24 * 3600_000);
  });

  it("the install hint never calls the browser on render and never shows a modal", () => {
    const hint = read("components/pwa/InstallHint.tsx");
    assert.doesNotMatch(hint, /role="dialog"|<dialog|aria-modal/);
    assert.match(hint, /onClick=\{\(\) => void promptInstall\(\)\}/);
  });
});

describe("push support and permission", () => {
  it("iPhone Safari must install first; installed iPhone and capable browsers are supported", () => {
    assert.equal(pushSupport(env({ userAgent: IPHONE }), ALL), "needs-install");
    assert.equal(pushSupport(env({ userAgent: IPHONE, navigatorStandalone: true, standaloneMedia: true }), ALL), "supported");
    assert.equal(pushSupport(env({}), ALL), "supported");
    assert.equal(pushSupport(env({}), { ...ALL, pushManager: false }), "unsupported");
  });

  it("maps permission + subscription to readable states (not colour)", () => {
    assert.equal(deviceNotificationState("unsupported", null, false), "unsupported");
    assert.equal(deviceNotificationState("needs-install", "default", false), "needs-install");
    assert.equal(deviceNotificationState("supported", "denied", false), "blocked");
    assert.equal(deviceNotificationState("supported", "default", false), "no-permission");
    assert.equal(deviceNotificationState("supported", "granted", true), "active");
    assert.equal(deviceNotificationState("supported", "granted", false), "inactive");
  });

  it("permission is requested only inside the click handler, never on load", () => {
    const section = read("components/pwa/DeviceSection.tsx");
    const client = read("lib/pwa/push-client.ts");
    assert.doesNotMatch(section, /requestPermission/);
    assert.match(client, /export async function enableNotifications\(publicKey: string\): Promise<EnableResult> \{\n  const permission = await Notification\.requestPermission\(\);/, "the first statement, before any other await");
    for (const file of ["components/pwa/PwaRegistrar.tsx", "components/pwa/NotificationCheckTrigger.tsx", "components/pwa/InstallHint.tsx", "app/layout.tsx"]) {
      assert.doesNotMatch(read(file), /requestPermission/, file);
    }
    const effect = section.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[capabilities\]\);/)?.[1] ?? "";
    assert.doesNotMatch(effect, /enableNotifications|requestPermission|subscribe\(/);
  });

  it("decodes only a valid 65-byte VAPID public key", () => {
    const valid = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
    assert.equal(applicationServerKey(valid)?.length, 65);
    assert.equal(applicationServerKey("short"), null);
    assert.equal(applicationServerKey(`A${valid.slice(1)}`), null, "must be an uncompressed point (0x04)");
  });
});

// ---------------------------------------------------------------------------
// Mobile and safe areas
// ---------------------------------------------------------------------------

describe("mobile layout", () => {
  const css = read("app/globals.css");

  it("bottom navigation pads for the home indicator and the notch sides, and steps aside while typing", () => {
    const nav = read("components/layout/AppNavigation.tsx");
    assert.match(nav, /pb-\[env\(safe-area-inset-bottom\)\]/);
    assert.match(nav, /pl-\[env\(safe-area-inset-left\)\]/);
    assert.match(nav, /pr-\[env\(safe-area-inset-right\)\]/);
    assert.match(nav, /app-navigation/);
    assert.match(css, /body:has\(:is\(input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), textarea, select\):focus\) \.app-navigation \{\s*display: none;/);
  });

  it("the shell leaves room for the navigation + inset, and pads every side with the safe area", () => {
    const shell = read("components/layout/AppShell.tsx");
    assert.match(shell, /pb-\[calc\(4rem\+env\(safe-area-inset-bottom\)\+3rem\)\]/, "the assistant composer and last buttons stay above the nav and the home indicator");
    assert.match(shell, /pt-\[calc\(env\(safe-area-inset-top\)\+1\.25rem\)\]/);
    assert.match(shell, /pl-\[max\(1\.25rem,env\(safe-area-inset-left\)\)\]/);
    assert.match(shell, /pr-\[max\(1\.25rem,env\(safe-area-inset-right\)\)\]/);
  });

  it("form fields are 16 px on touch screens (no iOS focus zoom); text is not inflated; motion can be reduced", () => {
    assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?font-size: 16px;/);
    assert.match(css, /text-size-adjust: 100%/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });

  it("no 100vh, w-screen or forced horizontal overflow in the app", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : /\.(tsx|css)$/.test(name) ? [full] : [];
      });
    for (const file of [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "components"))]) {
      if (file.includes(`${path.sep}dev${path.sep}`)) continue;
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /100vh|h-screen|w-screen|overflow-x-scroll|min-w-\[[5-9]\d\dpx\]/, path.relative(ROOT, file));
    }
  });

  it("buttons are 44 px tall on touch screens", () => {
    assert.match(read("components/ui/Button.tsx"), /compact: "h-9 px-3 pointer-coarse:h-11"/);
  });
});
