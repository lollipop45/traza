// Notifications: subscription validation, preferences, the pure planner (Atlantic/Canary, DST,
// midnight), durable dedupe through a store that mirrors claim/finish_notification_delivery, delivery
// with a FAKE push service, VAPID configuration and security checks. No real push is ever sent.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { deliverToUser, pushFailureFromStatus, type DeliveryDeps, type SendResult, type StoredSubscription } from "@/lib/notifications/delivery";
import { isVapidPrivateKey, isVapidPublicKey, readPushConfig, readPushPublicKey } from "@/lib/notifications/env";
import { MAX_PAYLOAD_BYTES, TEST_PAYLOAD, buildPayload, encodePayload, safeNotificationPath } from "@/lib/notifications/payload";
import { EVENT_GRACE_MINUTES, planNotifications, type PlannedNotification, type PlannerEvent, type PlannerTask } from "@/lib/notifications/planner";
import { DEFAULT_PREFERENCES, parsePreferencesForm, preferencesFromRow, type NotificationPreferences } from "@/lib/notifications/preferences";
import { runDueNotifications, type DeliveryStatus, type NotificationRunDeps } from "@/lib/notifications/run";
import { MAX_SUBSCRIPTION_BODY_BYTES, parseEndpoint, parseSubscription } from "@/lib/notifications/subscription";
import { isSameOriginRequest } from "@/lib/security/same-origin";

const P256DH = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const AUTH = "tBHItJI5svbpez7KI4CCXg";
const FAKE_PRIVATE = "FAKE-private-vapid-key-not-real-0123456789A";
const at = (iso: string) => Date.parse(iso);
const prefs = (fields: Partial<NotificationPreferences> = {}): NotificationPreferences => ({ ...DEFAULT_PREFERENCES, morningSummary: true, ...fields });
const task = (id: string, title: string, due: string | null, status = "pending"): PlannerTask => ({ id, title, status, due_date: due });
const event = (id: string, title: string, date: string, time: string | null, allDay = false): PlannerEvent => ({ id, title, event_date: date, start_time: time ? `${time}:00` : null, all_day: allDay });
const kinds = (plan: PlannedNotification[]) => plan.map((p) => p.kind);

// ---------------------------------------------------------------------------
// Subscriptions, payloads, preferences, configuration
// ---------------------------------------------------------------------------

describe("push subscriptions (input validation)", () => {
  const valid = { endpoint: "https://fcm.googleapis.com/fcm/send/abcdefghijklmnop", expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } };

  it("accepts a browser PushSubscription JSON", () => {
    assert.deepEqual(parseSubscription(valid), { endpoint: valid.endpoint, p256dh: P256DH, auth: AUTH, expirationTime: null });
    assert.equal(parseSubscription({ ...valid, expirationTime: at("2026-12-01T00:00:00Z") })?.expirationTime, "2026-12-01T00:00:00.000Z");
  });

  it("rejects malformed, insecure and oversized input", () => {
    for (const bad of [
      null,
      "x",
      [],
      { ...valid, endpoint: "http://insecure.example.com/push/abcdefgh" },
      { ...valid, endpoint: "https://user:pass@push.example.com/abcdefgh" },
      { ...valid, endpoint: `https://push.example.com/${"a".repeat(2100)}` },
      { ...valid, endpoint: "https://push.example.com/has space/abcdefgh" },
      { ...valid, keys: { p256dh: "short", auth: AUTH } },
      { ...valid, keys: { p256dh: P256DH, auth: "a".repeat(80) } },
      { ...valid, keys: { p256dh: P256DH, auth: "not base64 !!!!!!!" } },
      { ...valid, keys: null },
      { ...valid, expirationTime: "tomorrow" },
    ]) {
      assert.equal(parseSubscription(bad), null, JSON.stringify(bad)?.slice(0, 80));
    }
    assert.equal(parseEndpoint("javascript:alert(1)//aaaaaaaaaaaaaaaa"), null);
    assert.ok(MAX_SUBSCRIPTION_BODY_BYTES <= 4096);
  });
});

describe("payloads", () => {
  it("only same-origin TRAZA paths; small; clipped", () => {
    for (const bad of ["https://evil.example.com", "//evil.example.com", "/\\evil", "javascript:alert(1)", "/api/x", 42, null]) assert.equal(safeNotificationPath(bad), "/");
    assert.equal(safeNotificationPath("/calendar"), "/calendar");
    const long = buildPayload({ body: "x".repeat(1000), title: "T".repeat(200), url: "https://evil", tag: "bad tag!", kind: "test" });
    assert.equal([...long.body].length, 240);
    assert.equal([...long.title].length, 80);
    assert.equal(long.url, "/");
    assert.equal(long.tag, "traza");
    assert.ok(encodePayload(long)!.length <= MAX_PAYLOAD_BYTES);
    assert.deepEqual(Object.keys(TEST_PAYLOAD).sort(), ["body", "kind", "tag", "title", "url"]);
    assert.deepEqual([TEST_PAYLOAD.title, TEST_PAYLOAD.body], ["TRAZA", "Las notificaciones están funcionando."]);
  });
});

describe("preferences", () => {
  it("privacy-conscious defaults", () => {
    assert.deepEqual(DEFAULT_PREFERENCES, { pushEnabled: true, tomorrowTasks: true, morningSummary: false, eventReminders: true, eventLeadMinutes: 60, showDetails: false });
    assert.deepEqual(preferencesFromRow(null), DEFAULT_PREFERENCES);
  });

  it("parses the form: unchecked boxes are false; the lead time must be offered", () => {
    const form = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? null });
    assert.deepEqual(parsePreferencesForm(form({ pushEnabled: "on", eventReminders: "on", eventLeadMinutes: "15", showDetails: "on" })), {
      pushEnabled: true,
      tomorrowTasks: false,
      morningSummary: false,
      eventReminders: true,
      eventLeadMinutes: 15,
      showDetails: true,
    });
    for (const lead of ["0", "45", "1440", "abc", ""]) assert.equal(parsePreferencesForm(form({ eventLeadMinutes: lead })), null, lead);
  });
});

describe("VAPID configuration", () => {
  const PUBLIC = P256DH;
  it("requires all three server variables with valid shapes", () => {
    assert.deepEqual(readPushConfig({}), { ok: false, problem: "missing" });
    assert.deepEqual(readPushConfig({ WEB_PUSH_VAPID_PUBLIC_KEY: PUBLIC, WEB_PUSH_VAPID_PRIVATE_KEY: "short", WEB_PUSH_SUBJECT: "mailto:a@b.es" }), { ok: false, problem: "invalid-private-key" });
    assert.deepEqual(readPushConfig({ WEB_PUSH_VAPID_PUBLIC_KEY: PUBLIC, WEB_PUSH_VAPID_PRIVATE_KEY: FAKE_PRIVATE, WEB_PUSH_SUBJECT: "hugo" }), { ok: false, problem: "invalid-subject" });
    const ok = readPushConfig({ WEB_PUSH_VAPID_PUBLIC_KEY: PUBLIC, WEB_PUSH_VAPID_PRIVATE_KEY: FAKE_PRIVATE, WEB_PUSH_SUBJECT: "mailto:hugo@example.com" });
    assert.equal(ok.ok, true);
    assert.equal(isVapidPublicKey(PUBLIC), true);
    assert.equal(isVapidPrivateKey(FAKE_PRIVATE), true);
  });

  it("only the PUBLIC key is ever handed to the browser path", () => {
    assert.equal(readPushPublicKey({ WEB_PUSH_VAPID_PUBLIC_KEY: P256DH, WEB_PUSH_VAPID_PRIVATE_KEY: FAKE_PRIVATE, WEB_PUSH_SUBJECT: "mailto:hugo@example.com" }), P256DH);
    assert.equal(readPushPublicKey({ NEXT_PUBLIC_WEB_PUSH_VAPID_PRIVATE_KEY: FAKE_PRIVATE }), null);
  });
});

// ---------------------------------------------------------------------------
// Planner (Atlantic/Canary)
// ---------------------------------------------------------------------------

describe("planner: tomorrow's tasks (20:00, the evening before)", () => {
  const tasks = [task("t1", "Panel final", "2026-10-09"), task("t2", "Lámina 3", "2026-10-09"), task("t3", "Hecha", "2026-10-09", "done"), task("t4", "Otra fecha", "2026-10-12"), task("t5", "Sin fecha", null)];

  it("from 20:00 Canary: one reminder for the pending tasks due tomorrow, counts only by default", () => {
    // 2026-10-08 is summer time (UTC+1): 20:00 local = 19:00Z.
    assert.deepEqual(planNotifications({ now: at("2026-10-08T18:59:00Z"), preferences: prefs(), tasks, events: [] }), []);
    const [reminder] = planNotifications({ now: at("2026-10-08T19:30:00Z"), preferences: prefs(), tasks, events: [] });
    assert.equal(reminder.kind, "tomorrow_tasks");
    assert.equal(reminder.dedupeKey, "tomorrow_tasks:2026-10-09");
    assert.equal(reminder.scheduledFor, "2026-10-08T19:00:00.000Z");
    assert.equal(reminder.payload.body, "Tienes 2 tareas para mañana.");
    assert.equal(reminder.payload.url, "/");
    assert.ok(!JSON.stringify(reminder).includes("Panel final"), "no titles on the lock screen by default");
  });

  it("shows titles only with show_details; never invents a time; completed tasks excluded", () => {
    const [reminder] = planNotifications({ now: at("2026-10-08T20:00:00Z"), preferences: prefs({ showDetails: true }), tasks, events: [] });
    assert.equal(reminder.payload.body, "Mañana: Lámina 3 y Panel final.");
    assert.doesNotMatch(reminder.payload.body, /\d{1,2}:\d{2}/);
    const many = [1, 2, 3, 4].map((n) => task(`m${n}`, `Entrega ${n}`, "2026-10-09"));
    assert.equal(planNotifications({ now: at("2026-10-08T20:00:00Z"), preferences: prefs({ showDetails: true }), tasks: many, events: [] })[0].payload.body, "Mañana: Entrega 1, Entrega 2 y 2 más.");
    assert.equal(planNotifications({ now: at("2026-10-08T20:00:00Z"), preferences: prefs(), tasks: [task("x", "Uno", "2026-10-09")], events: [] })[0].payload.body, "Tienes 1 tarea para mañana.");
  });

  it("manual, Canvas and assistant tasks behave the same (only status and date matter)", () => {
    const mixed = [task("manual", "A", "2026-10-09"), task("canvas", "B", "2026-10-09"), task("ai", "C", "2026-10-09")];
    assert.equal(planNotifications({ now: at("2026-10-08T20:00:00Z"), preferences: prefs(), tasks: mixed, events: [] })[0].payload.body, "Tienes 3 tareas para mañana.");
  });

  it("nothing when disabled, when push is off, or when nothing is due", () => {
    const now = at("2026-10-08T20:00:00Z");
    assert.deepEqual(planNotifications({ now, preferences: prefs({ tomorrowTasks: false }), tasks, events: [] }), []);
    assert.deepEqual(planNotifications({ now, preferences: prefs({ pushEnabled: false }), tasks, events: [] }), []);
    assert.deepEqual(planNotifications({ now, preferences: prefs(), tasks: [task("t", "x", "2026-10-20")], events: [] }), []);
  });

  it("midnight: after 00:00 Canary it is already the next day (no reminder for the day that started)", () => {
    // 23:00Z on Oct 8 = 00:00 Oct 9 Canary: 'tomorrow' is now Oct 10, and it is not 20:00 yet.
    assert.deepEqual(planNotifications({ now: at("2026-10-08T23:00:00Z"), preferences: prefs(), tasks, events: [] }), []);
    const [late] = planNotifications({ now: at("2026-10-08T22:59:00Z"), preferences: prefs(), tasks, events: [] });
    assert.equal(late.dedupeKey, "tomorrow_tasks:2026-10-09", "23:59 Canary still counts");
  });

  it("DST end (25 Oct 2026, UTC+1 → UTC+0): 20:00 local is 19:00Z the day before and 20:00Z after", () => {
    const due = [task("a", "A", "2026-10-25"), task("b", "B", "2026-10-26")];
    assert.equal(planNotifications({ now: at("2026-10-24T19:05:00Z"), preferences: prefs(), tasks: due, events: [] })[0].dedupeKey, "tomorrow_tasks:2026-10-25");
    assert.deepEqual(planNotifications({ now: at("2026-10-25T19:30:00Z"), preferences: prefs(), tasks: due, events: [] }), [], "19:30 local after the change");
    const [after] = planNotifications({ now: at("2026-10-25T20:05:00Z"), preferences: prefs(), tasks: due, events: [] });
    assert.deepEqual([after.dedupeKey, after.scheduledFor], ["tomorrow_tasks:2026-10-26", "2026-10-25T20:00:00.000Z"]);
  });

  it("DST start (29 Mar 2026, UTC+0 → UTC+1)", () => {
    const due = [task("a", "A", "2026-03-29"), task("b", "B", "2026-03-30")];
    assert.equal(planNotifications({ now: at("2026-03-28T20:05:00Z"), preferences: prefs(), tasks: due, events: [] })[0].scheduledFor, "2026-03-28T20:00:00.000Z");
    assert.equal(planNotifications({ now: at("2026-03-29T19:05:00Z"), preferences: prefs(), tasks: due, events: [] })[0].scheduledFor, "2026-03-29T19:00:00.000Z");
  });

  it("the server's time zone never matters", () => {
    const previous = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      assert.equal(planNotifications({ now: at("2026-10-08T19:30:00Z"), preferences: prefs(), tasks, events: [] })[0].dedupeKey, "tomorrow_tasks:2026-10-09");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("planner: morning overview (08:00–12:00)", () => {
  const tasks = [task("a", "Hoy 1", "2026-10-08"), task("b", "Hoy 2", "2026-10-08"), task("c", "Vencida", "2026-10-01"), task("d", "Futura", "2026-10-20"), task("e", "Hecha", "2026-10-08", "done")];

  it("counts today's and overdue pending tasks, once per day", () => {
    assert.deepEqual(kinds(planNotifications({ now: at("2026-10-08T06:59:00Z"), preferences: prefs({ tomorrowTasks: false }), tasks, events: [] })), []);
    const [summary] = planNotifications({ now: at("2026-10-08T07:10:00Z"), preferences: prefs({ tomorrowTasks: false }), tasks, events: [] });
    assert.deepEqual([summary.kind, summary.dedupeKey, summary.payload.body], ["morning_summary", "morning_summary:2026-10-08", "Hoy tienes 2 tareas y 1 vencida."]);
    assert.deepEqual(kinds(planNotifications({ now: at("2026-10-08T11:00:00Z"), preferences: prefs({ tomorrowTasks: false }), tasks, events: [] })), [], "not after 12:00");
    const next = planNotifications({ now: at("2026-10-09T07:10:00Z"), preferences: prefs({ tomorrowTasks: false }), tasks, events: [] });
    assert.equal(next[0].dedupeKey, "morning_summary:2026-10-09", "next day, different key");
  });

  it("is off by default, and titles appear only with show_details", () => {
    assert.deepEqual(planNotifications({ now: at("2026-10-08T07:10:00Z"), preferences: DEFAULT_PREFERENCES, tasks, events: [] }), []);
    const [detailed] = planNotifications({ now: at("2026-10-08T07:10:00Z"), preferences: prefs({ showDetails: true, tomorrowTasks: false }), tasks, events: [] });
    assert.equal(detailed.payload.body, "Hoy: Hoy 1 y Hoy 2. Además, 1 vencida.");
    const [onlyOverdue] = planNotifications({ now: at("2026-10-08T07:10:00Z"), preferences: prefs({ tomorrowTasks: false }), tasks: [task("c", "Vencida", "2026-10-01")], events: [] });
    assert.equal(onlyOverdue.payload.body, "Tienes 1 tarea vencida.");
  });
});

describe("planner: timed event reminders", () => {
  const events = [event("e1", "Crítica de proyecto", "2026-10-08", "10:00"), event("e2", "Festivo", "2026-10-08", null, true)];

  it("lead minutes before a timed event (Canary), never for all-day events, never once it started", () => {
    // 10:00 Canary (UTC+1) = 09:00Z; 60 min before = 08:00Z.
    assert.deepEqual(planNotifications({ now: at("2026-10-08T07:59:00Z"), preferences: prefs({ morningSummary: false }), tasks: [], events }), []);
    const [reminder] = planNotifications({ now: at("2026-10-08T08:05:00Z"), preferences: prefs({ morningSummary: false }), tasks: [], events });
    assert.equal(reminder.kind, "event_reminder");
    assert.equal(reminder.dedupeKey, "event:e1:60m:2026-10-08T09:00:00.000Z");
    assert.equal(reminder.eventId, "e1");
    assert.equal(reminder.payload.url, "/calendar");
    assert.equal(reminder.payload.body, "Tienes un evento a las 10:00.");
    assert.deepEqual(planNotifications({ now: at("2026-10-08T09:00:00Z"), preferences: prefs({ morningSummary: false }), tasks: [], events }), [], "started");
    assert.deepEqual(planNotifications({ now: at("2026-10-08T08:00:00Z") + (EVENT_GRACE_MINUTES + 1) * 60_000, preferences: prefs({ morningSummary: false }), tasks: [], events }), [], "too late to be useful");
  });

  it("honours the lead time and show_details", () => {
    const [soon] = planNotifications({ now: at("2026-10-08T08:46:00Z"), preferences: prefs({ morningSummary: false, eventLeadMinutes: 15, showDetails: true }), tasks: [], events });
    assert.deepEqual([soon.dedupeKey, soon.payload.body], ["event:e1:15m:2026-10-08T09:00:00.000Z", "Crítica de proyecto · 10:00"]);
    assert.deepEqual(planNotifications({ now: at("2026-10-08T08:05:00Z"), preferences: prefs({ morningSummary: false, eventReminders: false }), tasks: [], events }), []);
  });

  it("DST end and start shift the instant, not the local time", () => {
    const afterEnd = [event("w", "Invierno", "2026-10-25", "10:00")]; // UTC+0
    assert.equal(planNotifications({ now: at("2026-10-25T09:05:00Z"), preferences: prefs({ morningSummary: false }), tasks: [], events: afterEnd })[0].dedupeKey, "event:w:60m:2026-10-25T10:00:00.000Z");
    const afterStart = [event("s", "Verano", "2026-03-29", "10:00")]; // UTC+1
    assert.equal(planNotifications({ now: at("2026-03-29T08:05:00Z"), preferences: prefs({ morningSummary: false }), tasks: [], events: afterStart })[0].dedupeKey, "event:s:60m:2026-03-29T09:00:00.000Z");
  });

  it("an event right after midnight is reminded the evening before", () => {
    const [reminder] = planNotifications({ now: at("2026-10-08T22:10:00Z"), preferences: prefs({ morningSummary: false, tomorrowTasks: false }), tasks: [], events: [event("n", "Nocturno", "2026-10-09", "00:00")] });
    assert.equal(reminder.dedupeKey, "event:n:60m:2026-10-08T23:00:00.000Z");
  });

  it("dedupe keys never contain titles", () => {
    const plan = planNotifications({
      now: at("2026-10-08T19:30:00Z"),
      preferences: prefs({ showDetails: true }),
      tasks: [task("t", "Panel secreto", "2026-10-09")],
      events: [event("e9", "Reunión secreta", "2026-10-08", "21:00")],
    });
    assert.equal(plan.length, 2);
    for (const planned of plan) assert.doesNotMatch(planned.dedupeKey, /secret/i);
  });
});

// ---------------------------------------------------------------------------
// Delivery with a fake push service
// ---------------------------------------------------------------------------

const sub = (id: string): StoredSubscription => ({ id, endpoint: `https://push.example.com/${id}-aaaaaaaaaaaa`, p256dh: P256DH, auth: AUTH });

function fakeDevices(results: Record<string, SendResult | (() => never)>, owner = "A") {
  const devices = new Map(Object.keys(results).map((id) => [id, { ...sub(id), owner }]));
  const sent: { id: string; payload: string }[] = [];
  const deps: DeliveryDeps = {
    loadSubscriptions: async () => [...devices.values()].filter((d) => d.owner === owner).map((d) => ({ id: d.id, endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth })),
    removeSubscription: async (id) => devices.delete(id),
    send: async (subscription, payload) => {
      sent.push({ id: subscription.id, payload });
      const result = results[subscription.id];
      return typeof result === "function" ? result() : result;
    },
  };
  return { deps, devices, sent };
}

describe("push delivery", () => {
  it("sends the test notification to each of the user's devices", async () => {
    const fake = fakeDevices({ phone: { ok: true }, laptop: { ok: true } });
    const report = await deliverToUser(fake.deps, TEST_PAYLOAD);
    assert.deepEqual(report, { devices: 2, sent: 2, expired: 0, failed: 0, code: null });
    assert.deepEqual(JSON.parse(fake.sent[0].payload), { title: "TRAZA", body: "Las notificaciones están funcionando.", url: "/settings", tag: "traza-test", kind: "test" });
  });

  it("404/410 removes only that expired device; 429/5xx keep theirs", async () => {
    const fake = fakeDevices({ old: { ok: false, code: pushFailureFromStatus(410) }, gone: { ok: false, code: pushFailureFromStatus(404) }, busy: { ok: false, code: pushFailureFromStatus(429) }, down: { ok: false, code: pushFailureFromStatus(503) }, phone: { ok: true } });
    const report = await deliverToUser(fake.deps, TEST_PAYLOAD);
    assert.deepEqual(report, { devices: 5, sent: 1, expired: 2, failed: 2, code: null });
    assert.deepEqual([...fake.devices.keys()].sort(), ["busy", "down", "phone"]);
  });

  it("failure categories only; a thrown provider error never leaks", async () => {
    assert.equal(pushFailureFromStatus(410), "expired_subscription");
    assert.equal(pushFailureFromStatus(403), "push_rejected");
    assert.equal(pushFailureFromStatus(413), "push_rejected");
    assert.equal(pushFailureFromStatus(500), "temporary_error");
    assert.equal(pushFailureFromStatus(null), "temporary_error");
    const fake = fakeDevices({
      phone: () => {
        throw new Error("Received unexpected response code 500 from https://push.example.com/phone body=SECRET");
      },
    });
    const report = await deliverToUser(fake.deps, TEST_PAYLOAD);
    assert.deepEqual(report, { devices: 1, sent: 0, expired: 0, failed: 1, code: "temporary_error" });
    assert.doesNotMatch(JSON.stringify(report), /SECRET|push\.example/);
    assert.deepEqual((await deliverToUser(fakeDevices({}).deps, TEST_PAYLOAD)).code, "no_subscriptions");
    assert.deepEqual((await deliverToUser(fakeDevices({ only: { ok: false, code: "expired_subscription" } }).deps, TEST_PAYLOAD)).code, "expired_subscription");
  });

  it("user A's delivery only ever loads A's own devices", async () => {
    const fake = fakeDevices({ a1: { ok: true } }, "A");
    const report = await deliverToUser(fake.deps, TEST_PAYLOAD);
    assert.equal(report.sent, 1);
    const store = readFileSync(path.join(process.cwd(), "lib/notifications/store.ts"), "utf8");
    assert.match(store, /from\("push_subscriptions"\)\.select\("id, endpoint, p256dh, auth"\)\.eq\("user_id", userId\)/);
  });
});

// ---------------------------------------------------------------------------
// One run: plan → claim (durable dedupe) → deliver → finish
// ---------------------------------------------------------------------------

function fakeRun(options: { now: number; preferences?: NotificationPreferences; tasks?: PlannerTask[]; events?: PlannerEvent[]; send?: SendResult[] }) {
  /** Mirrors claim/finish_notification_delivery (unique per key; temporary failures retried ≤ 3). */
  const deliveries = new Map<string, { id: string; status: "pending" | DeliveryStatus; code: string | null; attempts: number }>();
  let clock = options.now;
  let n = 0;
  const outcomes = [...(options.send ?? [])];
  const devices = fakeDevices({ phone: { ok: true } });
  const deps: NotificationRunDeps = {
    configured: true,
    loadPreferences: async () => options.preferences ?? prefs(),
    loadPlannerData: async () => ({ tasks: options.tasks ?? [], events: options.events ?? [] }),
    claim: async (planned) => {
      const row = deliveries.get(planned.dedupeKey);
      if (!row) {
        const id = `d${++n}`;
        deliveries.set(planned.dedupeKey, { id, status: "pending", code: null, attempts: 1 });
        return id;
      }
      if (row.status === "failed" && row.code === "temporary_error" && row.attempts < 3) {
        Object.assign(row, { status: "pending", code: null, attempts: row.attempts + 1 });
        return row.id;
      }
      return null;
    },
    finish: async (id, status, code) => {
      const row = [...deliveries.values()].find((r) => r.id === id && r.status === "pending");
      if (!row) return false;
      Object.assign(row, { status, code });
      return true;
    },
    delivery: { ...devices.deps, send: async (s, p) => (outcomes.length ? outcomes.shift()! : devices.deps.send(s, p)) },
    now: () => clock,
  };
  return { deps, deliveries, sent: devices.sent, advance: (ms: number) => (clock += ms) };
}

describe("dedupe across runs", () => {
  const evening = at("2026-10-08T19:30:00Z");
  const tasks = [task("t1", "Panel", "2026-10-09")];

  it("repeated runs send each reminder once", async () => {
    const run = fakeRun({ now: evening, tasks });
    const first = await runDueNotifications(run.deps);
    assert.deepEqual([first.planned, first.sent], [1, 1]);
    for (let i = 0; i < 5; i++) {
      run.advance(10 * 60_000);
      const again = await runDueNotifications(run.deps);
      assert.deepEqual([again.sent, again.duplicates], [0, 1]);
    }
    assert.equal(run.sent.length, 1);
    assert.equal(run.deliveries.size, 1);
  });

  it("the same event reminder is never sent twice", async () => {
    const run = fakeRun({ now: at("2026-10-08T08:05:00Z"), preferences: prefs({ morningSummary: false }), events: [event("e1", "Crítica", "2026-10-08", "10:00")] });
    await runDueNotifications(run.deps);
    run.advance(5 * 60_000);
    await runDueNotifications(run.deps);
    assert.equal(run.sent.length, 1);
  });

  it("a temporary failure is retried without a duplicate row; a success is final", async () => {
    const run = fakeRun({ now: evening, tasks, send: [{ ok: false, code: "temporary_error" }] });
    assert.equal((await runDueNotifications(run.deps)).failed, 1);
    const retry = await runDueNotifications(run.deps);
    assert.equal(retry.sent, 1);
    assert.equal((await runDueNotifications(run.deps)).sent, 0);
    assert.equal(run.deliveries.size, 1);
    assert.equal([...run.deliveries.values()][0].status, "sent");
  });

  it("no devices: recorded as skipped (not retried); push off or not configured: nothing claimed", async () => {
    const run = fakeRun({ now: evening, tasks });
    run.deps.delivery.loadSubscriptions = async () => [];
    assert.equal((await runDueNotifications(run.deps)).skipped, 1);
    assert.deepEqual([...run.deliveries.values()].map((d) => [d.status, d.code]), [["skipped", "no_subscriptions"]]);

    const off = fakeRun({ now: evening, tasks, preferences: prefs({ pushEnabled: false }) });
    assert.equal((await runDueNotifications(off.deps)).outcome, "disabled");
    assert.equal(off.deliveries.size, 0);
    const unconfigured = fakeRun({ now: evening, tasks });
    unconfigured.deps.configured = false;
    assert.equal((await runDueNotifications(unconfigured.deps)).outcome, "not_configured");
    assert.equal(unconfigured.deliveries.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const code = (file: string) => read(file).replace(/^\s*\/\/.*$/gm, "");
function files(dir: string, accept: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full, accept) : accept(full) ? [full] : [];
  });
}

describe("notification security", () => {
  it("subscription, unsubscribe and check endpoints: POST only, same-origin, session first, no user id", () => {
    for (const file of ["app/api/notifications/subscription/route.ts", "app/api/notifications/unsubscribe/route.ts", "app/api/notifications/check/route.ts"]) {
      const route = code(file);
      assert.match(route, /export async function POST\(/, file);
      assert.doesNotMatch(route, /export (async )?function (GET|PUT|PATCH|DELETE)\b/, file);
      assert.match(route, /isSameOriginRequest\(request\.headers, PUSH_HEADER\)/, file);
      assert.match(route, /if \(!user\) return json\(\{ ok: false \}, 401\)/, file);
      assert.doesNotMatch(route, /user_id|userId\s*[:=]\s*body|searchParams/, file);
    }
    assert.doesNotMatch(code("app/api/notifications/check/route.ts"), /request\.(json|text|formData|body)/, "the check never reads a body");
    const headers = new Headers({ "x-traza-push": "1", origin: "https://evil.example.com", host: "traza.example.com" });
    assert.equal(isSameOriginRequest(headers, "x-traza-push"), false);
  });

  it("the private key and the web-push library stay on the server", () => {
    assert.match(read("lib/notifications/web-push-sender.ts"), /^import "server-only";/);
    for (const file of ["lib/notifications/store.ts", "lib/notifications/deps.ts"]) assert.match(read(file), /^import "server-only";/, file);
    const sources = ["app", "components", "lib"].flatMap((dir) => files(path.join(ROOT, dir), (f) => /\.tsx?$/.test(f)));
    for (const file of sources.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")))) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /@\/lib\/notifications\/(env|store|deps|web-push-sender)["']|from "web-push"|WEB_PUSH_VAPID_PRIVATE_KEY/, path.relative(ROOT, file));
    }
    const everything = sources.map((f) => readFileSync(f, "utf8")).join("\n");
    assert.doesNotMatch(everything, /NEXT_PUBLIC_WEB_PUSH|SERVICE_ROLE|service_role_key|serviceRole/i);
  });

  it("nothing logs subscriptions, keys or provider errors", () => {
    for (const file of files(path.join(ROOT, "lib/notifications"), () => true).concat(files(path.join(ROOT, "app/api/notifications"), () => true), [path.join(ROOT, "public/sw.js")])) {
      const text = readFileSync(file, "utf8");
      const logs = text.match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const line of logs) assert.doesNotMatch(line, /endpoint|p256dh|auth|key|error|subscription/i, `${path.relative(ROOT, file)}: ${line}`);
    }
  });

  it("the built browser bundle (if present) has no server secrets or the push library", () => {
    const bundle = files(path.join(ROOT, ".next", "static"), (f) => f.endsWith(".js"));
    if (bundle.length === 0) return;
    const text = bundle.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const needle of [
      "WEB_PUSH_VAPID_PRIVATE_KEY",
      "WEB_PUSH_SUBJECT",
      "vapidDetails",
      "aes128gcm",
      "GROQ_API_KEY",
      "CANVAS_ACCESS_TOKEN",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_TOKEN_ENCRYPTION_KEY",
      "SUPABASE_SERVICE_ROLE",
    ]) {
      assert.ok(!text.includes(needle), needle);
    }
  });
});
