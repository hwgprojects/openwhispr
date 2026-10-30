// Transcribes a long BYOK dictation in pieces while the user is still talking.
//
// Batch transcription time grows with audio length (gpt-transcribe: ~0.6 s plus
// ~0.03 s per second of audio), and all of it used to start on release. The
// segmenter reads the 16 kHz PCM16 copy of the recording (PcmTap), cuts it at a
// pause once a piece is long enough, and sends that piece off at once. On
// release only the tail is left to transcribe, so a 60 s dictation waits about
// as long as a short one. Cuts land in silence, so no word is split.
//
// The segmenter never decides alone: finish() hands back the pieces' texts in
// order plus the tail, and the caller falls back to the whole recording when
// any piece failed or the PCM copy cannot vouch for the recording.

const FRAME_MS = 20;
// Shorter recordings are never cut: one request is as fast as two.
const DEFAULT_MIN_SEGMENT_SECONDS = 10;
// Past this, cut at the quietest frame of the last CUT_SEARCH_SECONDS.
const DEFAULT_MAX_SEGMENT_SECONDS = 25;
const DEFAULT_SILENCE_MS = 300;
const CUT_SEARCH_SECONDS = 3;
// A frame is silent when its RMS sits within this fraction of the way from the
// piece's noise floor to its speech level.
const SILENCE_FRACTION = 0.15;
// Below this RMS (PCM16 units) a frame is silent whatever the levels say.
const ABSOLUTE_SILENCE_RMS = 120;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export class SpeculativeSegmenter {
  constructor({
    sampleRate = 16000,
    minSegmentSeconds = DEFAULT_MIN_SEGMENT_SECONDS,
    maxSegmentSeconds = DEFAULT_MAX_SEGMENT_SECONDS,
    silenceMs = DEFAULT_SILENCE_MS,
    onSegment,
  } = {}) {
    this.sampleRate = sampleRate;
    this.frameSize = Math.round((sampleRate * FRAME_MS) / 1000);
    this.minFrames = Math.round((minSegmentSeconds * 1000) / FRAME_MS);
    this.maxFrames = Math.round((maxSegmentSeconds * 1000) / FRAME_MS);
    this.silenceFrames = Math.round(silenceMs / FRAME_MS);
    this.searchFrames = Math.round((CUT_SEARCH_SECONDS * 1000) / FRAME_MS);
    this.onSegment = onSegment;
    // Samples of the current, not yet cut piece; earlier pieces are released.
    this._pending = [];
    this._pendingLength = 0;
    this._frameRms = [];
    this._carry = new Int16Array(0);
    this.totalSamples = 0;
    this.segmentCount = 0;
    this.lastThreshold = null;
  }

  push(chunk) {
    if (!chunk?.length) return;
    this.totalSamples += chunk.length;
    this._pending.push(chunk);
    this._pendingLength += chunk.length;
    // Frame RMS over carry + chunk, keeping the partial frame for next time.
    const joined = new Int16Array(this._carry.length + chunk.length);
    joined.set(this._carry, 0);
    joined.set(chunk, this._carry.length);
    let offset = 0;
    while (offset + this.frameSize <= joined.length) {
      let sum = 0;
      for (let i = offset; i < offset + this.frameSize; i++) sum += joined[i] * joined[i];
      this._frameRms.push(Math.sqrt(sum / this.frameSize));
      offset += this.frameSize;
      this._maybeCut();
    }
    this._carry = joined.slice(offset);
  }

  _silenceThreshold() {
    const sorted = [...this._frameRms].sort((a, b) => a - b);
    const floor = percentile(sorted, 0.1);
    const speech = percentile(sorted, 0.9);
    return Math.max(ABSOLUTE_SILENCE_RMS, floor + SILENCE_FRACTION * (speech - floor));
  }

  _maybeCut() {
    const frames = this._frameRms.length;
    if (frames < this.minFrames) return;
    const threshold = this._silenceThreshold();
    this.lastThreshold = threshold;
    // A run of silent frames ending at the newest frame: cut in its middle.
    let run = 0;
    for (let i = frames - 1; i >= 0 && this._frameRms[i] <= threshold; i--) run++;
    if (run >= this.silenceFrames) {
      this._cutAtFrame(frames - Math.ceil(run / 2));
      return;
    }
    if (frames < this.maxFrames) return;
    // No pause: cut at the quietest recent frame.
    let quietest = frames - 1;
    for (let i = Math.max(0, frames - this.searchFrames); i < frames; i++) {
      if (this._frameRms[i] < this._frameRms[quietest]) quietest = i;
    }
    this._cutAtFrame(quietest);
  }

  _takePending() {
    const all = new Int16Array(this._pendingLength);
    let offset = 0;
    for (const chunk of this._pending) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    return all;
  }

  _cutAtFrame(frameIndex) {
    const cutSample = frameIndex * this.frameSize;
    const all = this._takePending();
    const piece = all.slice(0, cutSample);
    const rest = all.slice(cutSample);
    this._pending = rest.length ? [rest] : [];
    this._pendingLength = rest.length;
    // Frames past the cut belong to the next piece; the carry is still unframed.
    this._frameRms = this._frameRms.slice(frameIndex);
    this.segmentCount += 1;
    this.onSegment?.(piece, this.segmentCount - 1);
  }

  // True when the uncut tail holds no speech by the last piece's levels (or is
  // under 300 ms): sending it would only invite the model to recite keywords.
  tailIsSilent() {
    if (this._pendingLength < this.silenceFrames * this.frameSize) return true;
    const threshold = this.lastThreshold ?? ABSOLUTE_SILENCE_RMS;
    return this._frameRms.every((rms) => rms <= threshold);
  }

  // The uncut tail, including the partial last frame.
  takeTail() {
    const tail = this._takePending();
    this._pending = [];
    this._pendingLength = 0;
    this._frameRms = [];
    this._carry = new Int16Array(0);
    return tail;
  }
}

// Joins piece texts the way one request would have returned them.
export function joinSegmentTexts(texts) {
  return texts
    .map((text) => (typeof text === "string" ? text.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

// Wires a segmenter to a transcribe function. Pieces start transcribing as
// soon as they are cut; finish() transcribes the tail and resolves to the full
// text, or null when the recording was never cut (the caller then uses its
// normal single request). It rejects when any piece failed.
export function createSpeculativeTranscription({ sampleRate = 16000, toWav, transcribe, ...opts }) {
  const pieces = [];
  let discarded = false;
  const segmenter = new SpeculativeSegmenter({
    sampleRate,
    ...opts,
    onSegment: (samples) => {
      if (discarded) return;
      const promise = Promise.resolve().then(() => transcribe(toWav(samples, sampleRate)));
      // Settled here so a failure before finish() is never an unhandled rejection.
      promise.catch(() => {});
      pieces.push(promise);
    },
  });
  return {
    push: (chunk) => {
      if (!discarded) segmenter.push(chunk);
    },
    get segmentCount() {
      return segmenter.segmentCount;
    },
    get totalSamples() {
      return segmenter.totalSamples;
    },
    discard() {
      discarded = true;
    },
    get discarded() {
      return discarded;
    },
    async finish() {
      if (discarded || pieces.length === 0) return null;
      const silent = segmenter.tailIsSilent();
      const tail = segmenter.takeTail();
      const tailPromise = silent ? Promise.resolve("") : transcribe(toWav(tail, sampleRate));
      const texts = await Promise.all([...pieces, tailPromise]);
      return joinSegmentTexts(texts);
    },
  };
}
