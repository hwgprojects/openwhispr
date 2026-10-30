# hwg fork of OpenWhispr

Harley's Wispr Flow replacement. Upstream: https://github.com/OpenWhispr/openwhispr.
Fork: https://github.com/hwgprojects/openwhispr, branch `hwg/provida-flow`.

## What the fork changes

- **`AUDIO_KEY`**: the Windows user env var `AUDIO_KEY` is the OpenAI key. It wins over
  any stored key and over the machine's `OPENAI_API_KEY`, and the app never writes it to disk.
  Rotate it in Windows Environment Variables, then restart the app.
- **Personal preset** (`presets/personal-preset.json`): transcription and the assistant on
  OpenAI with your own key (BYOK). Dictation uses `gpt-transcribe`; cleanup runs on
  OpenRouter `openai/gpt-oss-120b` (high effort), which OpenRouter sends to its fastest host
  (Cerebras or Groq). The Tone & Style settings for each app type are in the same file. The preload applies the preset after
  onboarding, and again only when `version` changes. A version bump overwrites the
  settings it lists.
- **Dictionary seed** (`presets/provida-terms.txt`, one term per line, `#` comments).
  The app adds new terms to the dictionary at launch. A seeded term you delete in the app
  stays deleted. `presets/provida-terms.json` is the annotated source (category, notes,
  likely mishearings). It does not ship.
- **Cleanup prompt**: the English default (`src/locales/en/prompts.json` `cleanupPrompt`)
  knows about Provida, British spelling, UK dates and £, and known mishearings.
- **Speed** (2026-10-30): a short dictation pastes about 1.6-2 s after release, a 44 s one
  about 2.6 s (was ~5.5 s). Three changes:
  - Cleanup on OpenRouter sorted by throughput (`src/services/ai/chatRequestBody.ts`), with an
    8 s deadline after which the raw transcript pastes. OpenAI's own models waited 1-6 s for
    their first token.
  - Connections to both hosts open on key-down (`src/helpers/connectionPrewarm.js`).
  - Long `gpt-transcribe` dictations are cut at pauses and transcribed while you speak
    (`src/helpers/speculativeTranscription.js`). Release only waits for the tail. Any failure
    sends the whole recording as before.
- **Updates**: the updater points at the fork, which has no releases. It never installs an
  upstream build over this one.

To change the preset without a rebuild, put a `personal-preset.json` (and any word lists it
names) in `%APPDATA%\OpenWhispr`. That copy wins over the bundled one.

## Build on Windows

The WSL repo is the source of truth. `%USERPROFILE%\dev\openwhispr` is a build mirror that
clones from it, with portable Node 24 in `%USERPROFILE%\dev\tools`.

```powershell
# one-off setup: Node 24, clone, npm ci
powershell -ExecutionPolicy Bypass -File scripts\hwg\win-setup.ps1
# each build (from the mirror)
git pull origin hwg/provida-flow
npm run prebuild:win
npm run build:renderer
npx electron-builder --win nsis --config electron-builder.unsigned-win.json --publish never
# installer: dist\OpenWhispr-Setup-*.exe
```

## Update from upstream

```bash
cd ~/projects/openwhispr
git fetch upstream
git merge upstream/main     # resolve conflicts, keep the fork's changes
# if upstream changed the en cleanupPrompt: re-apply the Provida prompt and
# update its hash in src/config/retiredPrompts.js (test/helpers/retiredPrompts.test.js checks it)
git push origin hwg/provida-flow
```

Then rebuild on Windows as above.
