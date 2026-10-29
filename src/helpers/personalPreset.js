// Personal preset: settings and dictionary words this install starts with.
//
// The bundled `presets/personal-preset.json` (resources/presets in a packaged
// build) names renderer settings and word-list files. A `personal-preset.json`
// in userData, if present, replaces the bundled one, so a preset can change
// without a rebuild. Word-list files resolve next to the preset that names them.
//
// Dictionary words are seeded add-only into SQLite: a word is added once, and
// a seeded word the user later deletes stays deleted (`dictionary-seed.json`
// in userData remembers every word already offered). Settings are applied by
// the preload (see applyPersonalPresetSettings in preload.js) once onboarding
// is done, and again only when the preset's `version` changes.
const fs = require("fs");
const path = require("path");

const PRESET_FILE = "personal-preset.json";
const SEED_STATE_FILE = "dictionary-seed.json";

function bundledPresetDir({ isPackaged, resourcesPath, appRoot }) {
  return isPackaged ? path.join(resourcesPath, "presets") : path.join(appRoot, "presets");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Returns { preset, dir } or null. The userData preset wins over the bundled one.
function loadPersonalPreset({ userDataDir, bundledDir }) {
  for (const dir of [userDataDir, bundledDir]) {
    if (!dir) continue;
    const preset = readJson(path.join(dir, PRESET_FILE));
    if (preset && typeof preset === "object") return { preset, dir };
  }
  return null;
}

// One term per line; blank lines and `#` comments are skipped.
function parseWordList(text) {
  const seen = new Set();
  const words = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const word = line.replace(/#.*$/, "").trim();
    if (!word) continue;
    const lower = word.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    words.push(word);
  }
  return words;
}

function presetWords(loaded) {
  if (!loaded) return [];
  const files = Array.isArray(loaded.preset.dictionaryFiles) ? loaded.preset.dictionaryFiles : [];
  const inline = Array.isArray(loaded.preset.dictionary) ? loaded.preset.dictionary : [];
  const texts = [inline.join("\n")];
  for (const file of files) {
    try {
      texts.push(fs.readFileSync(path.resolve(loaded.dir, file), "utf8"));
    } catch {}
  }
  return parseWordList(texts.join("\n"));
}

// Words to add now: in the preset, never offered before.
function wordsToSeed(words, offeredLower) {
  const offered = new Set(offeredLower);
  return words.filter((word) => !offered.has(word.toLowerCase()));
}

function seedDictionary({ databaseManager, userDataDir, bundledDir, logger }) {
  const loaded = loadPersonalPreset({ userDataDir, bundledDir });
  const words = presetWords(loaded);
  if (words.length === 0) return { added: 0 };

  const statePath = path.join(userDataDir, SEED_STATE_FILE);
  const state = readJson(statePath) || {};
  const offered = Array.isArray(state.offered) ? state.offered : [];
  const pending = wordsToSeed(words, offered);
  if (pending.length === 0) return { added: 0 };

  const result = databaseManager.applyDictionaryChanges({ add: pending }, "manual");
  const next = { offered: [...offered, ...pending.map((w) => w.toLowerCase())] };
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2));
  logger?.info?.("Seeded dictionary from personal preset", { added: result.added }, "preset");
  return { added: result.added };
}

// The renderer settings the preload writes to localStorage.
function presetSettings({ userDataDir, bundledDir }) {
  const loaded = loadPersonalPreset({ userDataDir, bundledDir });
  if (!loaded) return null;
  const { version, settings } = loaded.preset;
  if (!settings || typeof settings !== "object") return null;
  return { version: String(version ?? "1"), settings };
}

module.exports = {
  bundledPresetDir,
  loadPersonalPreset,
  parseWordList,
  presetWords,
  wordsToSeed,
  seedDictionary,
  presetSettings,
};
