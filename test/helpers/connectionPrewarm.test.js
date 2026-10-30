const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/connectionPrewarm.js");

const BYOK = {
  useLocalWhisper: false,
  cloudTranscriptionMode: "byok",
  cloudTranscriptionBaseUrl: "https://api.openai.com/v1",
  useCleanupModel: true,
  cleanupMode: "providers",
  cleanupProvider: "openrouter",
};

test("warms the BYOK transcription host and the cleanup host", async () => {
  const { prewarmOrigins } = await load();
  assert.deepEqual(prewarmOrigins(BYOK), ["https://api.openai.com", "https://openrouter.ai"]);
  assert.deepEqual(prewarmOrigins({ ...BYOK, cleanupProvider: "openai", cleanupCloudBaseUrl: "https://api.openai.com/v1" }), [
    "https://api.openai.com",
  ]);
});

test("skips local, OpenWhispr Cloud, plain-http and disabled routes", async () => {
  const { prewarmOrigins } = await load();
  assert.deepEqual(prewarmOrigins({ ...BYOK, useLocalWhisper: true, useCleanupModel: false }), []);
  assert.deepEqual(prewarmOrigins({ ...BYOK, cloudTranscriptionMode: "openwhispr", cleanupMode: "openwhispr" }), []);
  assert.deepEqual(prewarmOrigins({ ...BYOK, cloudTranscriptionBaseUrl: "http://192.168.1.5:8080/v1", cleanupMode: "local" }), []);
});

test("sends one HEAD per host per minute and never throws", async () => {
  const { createConnectionPrewarmer } = await load();
  let clock = 0;
  const calls = [];
  const prewarm = createConnectionPrewarmer({
    fetchImpl: async (url, init) => {
      calls.push([url, init.method]);
      throw new Error("offline");
    },
    now: () => clock,
  });
  assert.equal(prewarm(BYOK).length, 2);
  clock = 30_000;
  assert.equal(prewarm(BYOK).length, 0);
  clock = 61_000;
  assert.equal(prewarm(BYOK).length, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0], ["https://api.openai.com", "HEAD"]);
  assert.equal(calls.length, 4);
});
