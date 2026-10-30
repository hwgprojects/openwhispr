// Opens the HTTPS connections a BYOK dictation is about to use while the user
// is still speaking, so the transcription and cleanup requests sent on release
// skip DNS, TCP and TLS setup (~0.1-0.2 s per host, measured to OpenAI and
// OpenRouter). The request itself is an unauthenticated HEAD whose response is
// ignored; Chromium keeps the socket in its pool for the real request.

const OPENROUTER_ORIGIN = "https://openrouter.ai";
// Chromium closes idle sockets after a few minutes; a fresh warm-up per minute
// is plenty and keeps rapid dictations from sending one each.
const PREWARM_INTERVAL_MS = 60_000;

function originOf(url) {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "https:" ? origin : null;
  } catch {
    return null;
  }
}

// The hosts this dictation will call, from the settings that route it. Only
// direct BYOK routes: OpenWhispr Cloud and local models are someone else's job.
export function prewarmOrigins(settings = {}) {
  const origins = new Set();
  if (!settings.useLocalWhisper && settings.cloudTranscriptionMode === "byok") {
    const origin = originOf(settings.cloudTranscriptionBaseUrl);
    if (origin) origins.add(origin);
  }
  if (settings.useCleanupModel !== false && settings.cleanupMode === "providers") {
    if (settings.cleanupProvider === "openrouter") origins.add(OPENROUTER_ORIGIN);
    else if (settings.cleanupProvider === "openai") {
      const origin = originOf(settings.cleanupCloudBaseUrl);
      if (origin) origins.add(origin);
    }
  }
  return [...origins];
}

export function createConnectionPrewarmer({ fetchImpl, now = () => Date.now() } = {}) {
  const lastWarmed = new Map();
  return function prewarm(settings) {
    if (typeof fetchImpl !== "function") return [];
    const sent = [];
    for (const origin of prewarmOrigins(settings)) {
      const last = lastWarmed.get(origin);
      if (last !== undefined && now() - last < PREWARM_INTERVAL_MS) continue;
      lastWarmed.set(origin, now());
      sent.push(origin);
      Promise.resolve()
        .then(() => fetchImpl(origin, { method: "HEAD", mode: "no-cors", cache: "no-store" }))
        .catch(() => {});
    }
    return sent;
  };
}
