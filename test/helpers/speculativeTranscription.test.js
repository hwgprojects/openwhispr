const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/speculativeTranscription.js");

const RATE = 16000;

// Speech is a loud tone, silence a faint hiss; `plan` is [kind, seconds] pairs.
function pcm(plan) {
  const parts = plan.map(([kind, seconds]) => {
    const out = new Int16Array(Math.round(seconds * RATE));
    for (let i = 0; i < out.length; i++) {
      out[i] =
        kind === "speech"
          ? Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE))
          : Math.round(40 * Math.sin(i * 12.9898));
    }
    return out;
  });
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Int16Array(total);
  let offset = 0;
  for (const p of parts) {
    all.set(p, offset);
    offset += p.length;
  }
  return all;
}

// Feeds the PCM in worklet-sized chunks, as PcmTap does.
function feed(target, samples, chunk = 2048) {
  for (let i = 0; i < samples.length; i += chunk) target.push(samples.subarray(i, i + chunk));
}

test("cuts in the first pause past the minimum length, never mid-speech", async () => {
  const { SpeculativeSegmenter } = await load();
  const cuts = [];
  const segmenter = new SpeculativeSegmenter({ onSegment: (piece) => cuts.push(piece.length) });
  feed(segmenter, pcm([["speech", 6], ["silence", 0.5], ["speech", 6], ["silence", 0.5], ["speech", 4]]));
  // The 6 s pause comes before the 10 s minimum; the second one is cut.
  assert.equal(cuts.length, 1);
  const cutSeconds = cuts[0] / RATE;
  // The pause runs from 12.5 s to 13 s.
  assert.ok(cutSeconds > 12.5 && cutSeconds < 13, `cut at ${cutSeconds}s`);
  assert.equal(segmenter.takeTail().length + cuts[0], segmenter.totalSamples);
});

test("a dictation shorter than the minimum is never cut", async () => {
  const { createSpeculativeTranscription } = await load();
  const spec = createSpeculativeTranscription({ toWav: (s) => s, transcribe: async () => "x" });
  feed(spec, pcm([["speech", 4], ["silence", 1], ["speech", 4]]));
  assert.equal(spec.segmentCount, 0);
  assert.equal(await spec.finish(), null);
});

test("continuous speech is cut by the maximum length at its quietest point", async () => {
  const { SpeculativeSegmenter } = await load();
  const cuts = [];
  const segmenter = new SpeculativeSegmenter({ onSegment: (piece) => cuts.push(piece.length) });
  feed(segmenter, pcm([["speech", 30]]));
  assert.equal(cuts.length, 1);
  assert.ok(cuts[0] / RATE <= 25 && cuts[0] / RATE >= 22, `cut at ${cuts[0] / RATE}s`);
});

test("finish joins the pieces in cut order with the tail and skips a silent tail", async () => {
  const { createSpeculativeTranscription } = await load();
  let calls = 0;
  const make = () =>
    createSpeculativeTranscription({
      toWav: (samples) => samples,
      transcribe: async (samples) => {
        calls += 1;
        // Each request answers sooner than the one before it, so the answers
        // arrive in the opposite order to the requests.
        await new Promise((resolve) => setTimeout(resolve, 30 - calls * 8));
        return `${(samples.length / RATE).toFixed(2)}s`;
      },
    });

  const spoken = make();
  feed(spoken, pcm([["speech", 11], ["silence", 0.5], ["speech", 11], ["silence", 0.5], ["speech", 3]]));
  assert.equal(spoken.segmentCount, 2);
  const seconds = (await spoken.finish()).split(" ").map((part) => parseFloat(part));
  assert.equal(seconds.length, 3);
  // Cut order: first piece ends in the first pause, the tail is the last 3 s.
  assert.ok(seconds[0] > 11 && seconds[0] < 11.5, `first piece ${seconds[0]}s`);
  assert.ok(seconds[1] > 11 && seconds[1] < 12, `second piece ${seconds[1]}s`);
  assert.ok(seconds[2] > 3 && seconds[2] < 3.5, `tail ${seconds[2]}s`);

  calls = 0;
  const silentTail = make();
  feed(silentTail, pcm([["speech", 11], ["silence", 1.5]]));
  assert.equal(silentTail.segmentCount, 1);
  assert.equal((await silentTail.finish()).split(" ").length, 1);
  assert.equal(calls, 1, "the silent tail is not sent");
});

test("a failed piece fails finish, and a discarded one sends nothing more", async () => {
  const { createSpeculativeTranscription } = await load();
  let calls = 0;
  const failing = createSpeculativeTranscription({
    toWav: (s) => s,
    transcribe: async () => {
      calls += 1;
      throw new Error("503");
    },
  });
  feed(failing, pcm([["speech", 11], ["silence", 0.5], ["speech", 3]]));
  await assert.rejects(failing.finish(), /503/);

  calls = 0;
  const discarded = createSpeculativeTranscription({
    toWav: (s) => s,
    transcribe: async () => {
      calls += 1;
      return "x";
    },
  });
  discarded.discard();
  feed(discarded, pcm([["speech", 11], ["silence", 0.5], ["speech", 3]]));
  assert.equal(calls, 0);
  assert.equal(await discarded.finish(), null);
});

test("joinSegmentTexts trims and drops empty pieces", async () => {
  const { joinSegmentTexts } = await load();
  assert.equal(joinSegmentTexts([" Hello there. ", "", null, "How are you?"]), "Hello there. How are you?");
});
