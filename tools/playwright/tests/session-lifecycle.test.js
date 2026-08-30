/**
 * Session-lifecycle tests for mcp-server.js ([TOOL-C2][TOOL-C3], plan T20-h).
 *
 * These import the REAL server module and drive its exported lifecycle
 * functions with injected browser stubs (launch/close spies) — no copied
 * logic. The module must not bind a port on import.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

const {
  acquireIsolatedBrowser,
  releaseBrowserSession,
  establishSseSession,
  resolveTargetContext,
  runBrowserKey,
  _lifecycleState,
} = await import("../mcp-server.js");

function makeLauncher(calls, { delayMs = 40, fail = false } = {}) {
  return async (id, opts) => {
    calls.push({ id, opts });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (fail) throw new Error("stub launch failure");
    return { marker: `session-${calls.length}`, id };
  };
}

function makeCloser(closed) {
  return async (session) => {
    closed.push(session);
  };
}

function fakeRes() {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.statusCode = 200;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

function fakeTransport(sessionId) {
  return {
    sessionId,
    start: async () => {},
    send: async () => {},
    close: async () => {},
  };
}

test("two simultaneous acquires for one runKey launch exactly ONE browser", async () => {
  const launches = [];
  const closed = [];
  const launcher = makeLauncher(launches, { delayMs: 60 });
  const closer = makeCloser(closed);
  const runKey = "run:lifecycle-mutex";
  const deps = { launchEphemeralBrowser: launcher, closeEphemeralBrowser: closer };

  const [first, second] = await Promise.all([
    acquireIsolatedBrowser({ sessionId: "s1", profile: "classification", runKey }, deps),
    acquireIsolatedBrowser({ sessionId: "s2", profile: "classification", runKey }, deps),
  ]);

  assert.equal(launches.length, 1, `expected single launch, got ${launches.length}`);
  assert.equal(first, second, "both sessions must share the same browser session");

  assert.equal(_lifecycleState.runBrowsers.get(runKey).refCount, 2);

  await releaseBrowserSession({ browserSession: first, runKey }, { ...deps, ttlMs: 0 });
  await releaseBrowserSession({ browserSession: second, runKey }, { ...deps, ttlMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(closed.length, 1, "shared browser must be closed exactly once");
  assert.equal(_lifecycleState.runBrowsers.has(runKey), false);
});

test("acquire after TTL release reuses nothing but does not double-close", async () => {
  const launches = [];
  const closed = [];
  const launcher = makeLauncher(launches, { delayMs: 5 });
  const closer = makeCloser(closed);
  const runKey = "run:lifecycle-ttl";
  const deps = { launchEphemeralBrowser: launcher, closeEphemeralBrowser: closer };

  const first = await acquireIsolatedBrowser(
    { sessionId: "t1", profile: "hosting", runKey },
    deps,
  );
  await releaseBrowserSession({ browserSession: first, runKey }, { ...deps, ttlMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closed.length, 1);

  const second = await acquireIsolatedBrowser(
    { sessionId: "t2", profile: "hosting", runKey },
    deps,
  );
  assert.equal(launches.length, 2, "a fresh launch must happen after the old entry was evicted");
  await releaseBrowserSession({ browserSession: second, runKey }, { ...deps, ttlMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closed.length, 2);
});

test("client abort during launch releases the acquired browser (no orphan)", async () => {
  const launches = [];
  const closed = [];
  const launcher = makeLauncher(launches, { delayMs: 120 });
  const closer = makeCloser(closed);
  const deps = { launchEphemeralBrowser: launcher, closeEphemeralBrowser: closer, ttlMs: 0 };

  const res = fakeRes();
  const establishment = establishSseSession({
    req: { query: { runId: "lifecycle-abort" } },
    res,
    profile: "classification",
    transport: { sessionId: "ses-abort-1" },
    deps,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(launches.length, 1, "launch should be in flight");

  res.destroyed = true;
  res.emit("close");

  const result = await establishment;
  assert.equal(result, undefined, "setup must bail out for an aborted socket");

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closed.length, 1, "closeEphemeralBrowser must be invoked for the orphaned launch");
  assert.equal(_lifecycleState.sessions.has("ses-abort-1"), false, "no session may be registered");
});

test("abort after acquire but before setup completion releases directly", async () => {
  const launches = [];
  const closed = [];
  const launcher = makeLauncher(launches, { delayMs: 5 });
  const closer = makeCloser(closed);
  const deps = { launchEphemeralBrowser: launcher, closeEphemeralBrowser: closer, ttlMs: 0 };

  const res = fakeRes();
  const establishment = establishSseSession({
    req: { query: {} },
    res,
    profile: "embedded",
    transport: fakeTransport("ses-abort-2"),
    deps,
  });

  const result = await establishment;
  assert.ok(result !== undefined, "fast launch completes setup before abort");
  assert.equal(_lifecycleState.sessions.has("ses-abort-2"), true);

  res.emit("close");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(_lifecycleState.sessions.has("ses-abort-2"), false, "close after setup must unregister the session");
  assert.equal(closed.length >= 1, true, "browser must be released through the close path");
});

test("reuse key stays legacy without target and separates (profile,target-host)", () => {
  const req = (query) => ({ query });
  const base = { runId: "key-test" };

  assert.equal(
    runBrowserKey(req(base), "hosting"),
    "run:key-test",
    "no target keeps the legacy run:<runId> key shape",
  );

  const hostA = runBrowserKey(req({ ...base, targetHost: "a.example" }), "hosting");
  assert.equal(
    hostA,
    runBrowserKey(req({ ...base, targetHost: "a.example" }), "hosting"),
    "same (profile,target-host) must yield a stable reuse key",
  );
  assert.notEqual(
    hostA,
    runBrowserKey(req({ ...base, targetHost: "b.example" }), "hosting"),
    "different target hosts must never share a reuse key",
  );
  assert.notEqual(
    hostA,
    runBrowserKey(req({ ...base, targetHost: "a.example" }), "embedded"),
    "different profiles must never share a reuse key",
  );
});

test("targetUrl-derived host wins; malformed or missing input resolves to no target", () => {
  assert.deepEqual(
    resolveTargetContext({
      query: { targetUrl: "https://Watch.Example/page?x=1", targetHost: "bad host!" },
    }),
    { targetHost: "watch.example", targetUrl: "https://watch.example/page?x=1" },
  );
  assert.deepEqual(resolveTargetContext({ query: { targetUrl: "::not-a-url" } }), {
    targetHost: "",
    targetUrl: "",
  });
  assert.deepEqual(resolveTargetContext({ query: {} }), { targetHost: "", targetUrl: "" });
});

test("acquireIsolatedBrowser forwards profile and target into the launcher", async () => {
  const launches = [];
  const closed = [];
  const deps = {
    launchEphemeralBrowser: makeLauncher(launches, { delayMs: 5 }),
    closeEphemeralBrowser: makeCloser(closed),
  };
  const runKey = "run:fwd|hosting|a.example";

  const session = await acquireIsolatedBrowser(
    {
      sessionId: "fwd-1",
      profile: "hosting",
      runKey,
      target: { targetHost: "a.example", targetUrl: "https://a.example/watch" },
    },
    deps,
  );
  await releaseBrowserSession({ browserSession: session, runKey }, { ...deps, ttlMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(launches.length, 1);
  assert.equal(launches[0].opts.browserProfile, "hosting");
  assert.equal(launches[0].opts.targetHost, "a.example");
  assert.equal(launches[0].opts.targetUrl, "https://a.example/watch");
  assert.equal(closed.length, 1);
});

test("one runId with two target hosts never shares a browser", async () => {
  const launches = [];
  const closed = [];
  const deps = {
    launchEphemeralBrowser: makeLauncher(launches, { delayMs: 5 }),
    closeEphemeralBrowser: makeCloser(closed),
  };

  const keyA = runBrowserKey({ query: { runId: "iso", targetHost: "a.example" } }, "hosting");
  const keyB = runBrowserKey({ query: { runId: "iso", targetHost: "b.example" } }, "hosting");
  assert.notEqual(keyA, keyB);

  const [sessionA, sessionB] = await Promise.all([
    acquireIsolatedBrowser(
      { sessionId: "iso-a", profile: "hosting", runKey: keyA, target: { targetHost: "a.example" } },
      deps,
    ),
    acquireIsolatedBrowser(
      { sessionId: "iso-b", profile: "hosting", runKey: keyB, target: { targetHost: "b.example" } },
      deps,
    ),
  ]);

  assert.notEqual(sessionA, sessionB, "different target-host jars must get different browsers");
  assert.equal(launches.length, 2);

  await releaseBrowserSession({ browserSession: sessionA, runKey: keyA }, { ...deps, ttlMs: 0 });
  await releaseBrowserSession({ browserSession: sessionB, runKey: keyB }, { ...deps, ttlMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closed.length, 2, "each jar browser must close exactly once");
});
