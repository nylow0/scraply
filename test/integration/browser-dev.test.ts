import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { startBrowserDevHost } from "../../src/main/browser-dev";
import { BROWSER_DEV_ORIGIN, isBrowserDevRequestAllowed } from "../../scripts/browser-dev-proxy";

test("browser dev proxy rejects cross-origin mutations, DNS rebinding, and preflight", () => {
  const headers = { host: "127.0.0.1:5173", origin: BROWSER_DEV_ORIGIN, "sec-fetch-site": "same-origin" };
  expect(isBrowserDevRequestAllowed({ method: "POST", headers })).toBe(true);
  expect(isBrowserDevRequestAllowed({ method: "POST", headers: { host: headers.host } })).toBe(false);
  expect(isBrowserDevRequestAllowed({ method: "POST", headers: { ...headers, origin: "http://127.0.0.1:9000" } })).toBe(false);
  expect(isBrowserDevRequestAllowed({ method: "POST", headers: { ...headers, host: "attacker.example:5173" } })).toBe(false);
  expect(isBrowserDevRequestAllowed({ method: "GET", headers: { ...headers, "sec-fetch-site": "cross-site" } })).toBe(false);
  expect(isBrowserDevRequestAllowed({ method: "OPTIONS", headers })).toBe(false);
});

test("dev transport authenticates, dispatches only registered handlers, streams events, and protects shutdown", async () => {
  const token = "a".repeat(48);
  let calls = 0;
  let shutdowns = 0;
  const host = await startBrowserDevHost({
    port: 0, token, sessionId: randomUUID(),
    handlers: new Map([["workspace", () => { calls++; return { threads: [] }; }]]),
    shutdown: () => { shutdowns++; },
  });
  const url = `http://127.0.0.1:${host.port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    expect((await fetch(`${url}/invoke`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(`${url}/invoke`, { method: "POST", headers: { authorization: "é".repeat(55) }, body: "{}" })).status).toBe(403);
    expect(calls).toBe(0);
    const response = await fetch(`${url}/invoke`, { method: "POST", headers, body: JSON.stringify({ channel: "workspace", args: [] }) });
    expect(await response.json()).toEqual({ data: { threads: [] } });
    expect(calls).toBe(1);
    expect((await fetch(`${url}/invoke`, { method: "POST", headers, body: JSON.stringify({ channel: "missing", args: [] }) })).status).toBe(404);
    expect((await fetch(`${url}/invoke`, { method: "POST", headers, body: "invalid" })).status).toBe(400);
    expect((await fetch(`${url}/invoke`, { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    const events = await fetch(`${url}/events`, { headers });
    const reader = events.body!.getReader();
    await reader.read();
    host.publish({ type: "run-completed", threadId: "thread-1", runId: "run-1", problemId: null });
    const next = await reader.read();
    expect(new TextDecoder().decode(next.value)).toContain('"type":"run-completed"');
    await reader.cancel();
    expect((await fetch(`${url}/shutdown`, { method: "POST", headers })).status).toBe(403);
    expect(shutdowns).toBe(0);
    expect((await fetch(`${url}/shutdown`, { method: "POST", headers: { ...headers, "x-scraply-control": token } })).status).toBe(200);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(shutdowns).toBe(1);
  } finally {
    host.close();
  }
});
