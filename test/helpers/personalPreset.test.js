const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const preset = require("../../src/helpers/personalPreset");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ow-preset-"));
}

function fakeDatabase() {
  const words = new Map();
  return {
    words,
    applyDictionaryChanges({ add = [] }) {
      let added = 0;
      for (const word of add) {
        if (!words.has(word.toLowerCase())) added += 1;
        words.set(word.toLowerCase(), word);
      }
      return { success: true, added, removed: 0 };
    },
  };
}

test("word lists skip blanks, comments and case-insensitive repeats", () => {
  assert.deepEqual(preset.parseWordList("Provida\n\n# people\nLuis  # colleague\r\nprovida\nCOSHH"), [
    "Provida",
    "Luis",
    "COSHH",
  ]);
});

test("the userData preset replaces the bundled one", () => {
  const bundledDir = tempDir();
  const userDataDir = tempDir();
  fs.writeFileSync(path.join(bundledDir, "personal-preset.json"), '{"version":"1","settings":{"a":"1"}}');
  assert.deepEqual(preset.presetSettings({ userDataDir, bundledDir }), {
    version: "1",
    settings: { a: "1" },
  });
  fs.writeFileSync(path.join(userDataDir, "personal-preset.json"), '{"version":"2","settings":{"a":"2"}}');
  assert.equal(preset.presetSettings({ userDataDir, bundledDir }).version, "2");
});

test("dictionary seeding adds each preset word once and never re-adds a deleted one", () => {
  const bundledDir = tempDir();
  const userDataDir = tempDir();
  fs.writeFileSync(
    path.join(bundledDir, "personal-preset.json"),
    JSON.stringify({ version: "1", dictionary: ["Syrinx"], dictionaryFiles: ["terms.txt"] })
  );
  fs.writeFileSync(path.join(bundledDir, "terms.txt"), "Provida\nLuis\n");
  const db = fakeDatabase();

  assert.equal(preset.seedDictionary({ databaseManager: db, userDataDir, bundledDir }).added, 3);
  db.words.delete("luis");
  assert.equal(preset.seedDictionary({ databaseManager: db, userDataDir, bundledDir }).added, 0);
  assert.equal(db.words.has("luis"), false);

  fs.appendFileSync(path.join(bundledDir, "terms.txt"), "Mojola\n");
  assert.equal(preset.seedDictionary({ databaseManager: db, userDataDir, bundledDir }).added, 1);
  assert.equal(db.words.get("mojola"), "Mojola");
});

test("the shipped preset parses and names only settings strings or objects", () => {
  const bundledDir = path.join(__dirname, "..", "..", "presets");
  const loaded = preset.loadPersonalPreset({ userDataDir: null, bundledDir });
  assert.ok(loaded, "presets/personal-preset.json is missing");
  assert.ok(preset.presetWords(loaded).length > 100);
  for (const [key, value] of Object.entries(loaded.preset.settings)) {
    assert.ok(typeof value === "string" || typeof value === "object", key);
  }
});
