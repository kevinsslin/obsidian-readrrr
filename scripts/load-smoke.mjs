// Loads the built main.js against a stub `obsidian` module and drives onload()
// to verify the shipped bundle registers its view, commands, ribbon, and
// settings tab without throwing. Complements the unit tests (engine) and the
// browser demo (engine rendering) with a "does the plugin load" check.
//
// Usage: node scripts/load-smoke.mjs [path-to-main.js]   (default: ./main.js)
import Module from "node:module";
import { createRequire } from "node:module";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = process.argv[2] ?? "main.js";
// Copy to a .cjs file so Node loads it as CommonJS regardless of the project's
// package.json "type": "module".
const cjs = join(mkdtempSync(join(tmpdir(), "rr-smoke-")), "main.cjs");
copyFileSync(src, cjs);

const fakeEl = () => ({
  style: {},
  createDiv: () => fakeEl(),
  createEl: () => fakeEl(),
  createSpan: () => fakeEl(),
  empty() {},
  addClass() {},
  removeClass() {},
  toggleClass() {},
  setText() {},
  setAttr() {},
  addEventListener() {},
  focus() {},
});

class Component {
  register() {}
  registerEvent() {}
  registerDomEvent() {}
  registerInterval() {}
}
class PluginStub extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    this.commands = [];
    this.ribbons = [];
    this.views = {};
    this.settingTabs = [];
  }
  addCommand(c) { this.commands.push(c); return c; }
  addRibbonIcon(icon, title, cb) { this.ribbons.push({ icon, title, cb }); return fakeEl(); }
  registerView(type, factory) { this.views[type] = factory; }
  registerEditorExtension() {}
  addSettingTab(tab) { this.settingTabs.push(tab); }
  async loadData() { return { unrealApiKey: "legacy-test-key" }; }
  async saveData(data) { this.savedData = data; }
}
class ItemViewStub extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.containerEl = fakeEl();
    this.contentEl = fakeEl();
  }
}
class PluginSettingTabStub {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = fakeEl();
  }
}
class ModalStub {
  constructor(app) {
    this.app = app;
    this.contentEl = fakeEl();
  }
  open() {}
  close() {}
}
const chain = () => new Proxy(() => chain(), { get: () => chain() });
class SettingStub {
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  addSlider(cb) { cb(chain()); return this; }
  addToggle(cb) { cb(chain()); return this; }
  addDropdown(cb) { cb(chain()); return this; }
  addButton(cb) { cb(chain()); return this; }
}

const obsidianStub = {
  Plugin: PluginStub,
  ItemView: ItemViewStub,
  PluginSettingTab: PluginSettingTabStub,
  Setting: SettingStub,
  Modal: ModalStub,
  Notice: class {},
  MarkdownView: class {},
  TFile: class {},
  Platform: { isMobile: false },
  WorkspaceLeaf: class {},
  setIcon: () => {},
};

// CodeMirror is provided by Obsidian at runtime (externalized in the bundle).
// Only StateEffect.define / StateField.define run at module load; the returned
// objects are just registered, never exercised here.
const codemirrorStateStub = {
  StateEffect: { define: () => ({}) },
  StateField: { define: () => ({}) },
};
const codemirrorViewStub = { Decoration: {}, EditorView: {} };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  if (request === "@codemirror/state") return codemirrorStateStub;
  if (request === "@codemirror/view") return codemirrorViewStub;
  return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const mod = require(cjs);
const PluginClass = mod.default ?? mod;

const secrets = new Map();
const app = {
  secretStorage: {
    getSecret: (id) => secrets.get(id) ?? null,
    setSecret: (id, value) => secrets.set(id, value),
  },
  workspace: {
    getLeavesOfType: () => [],
    getLeaf: () => ({ setViewState: async () => {}, view: null }),
    revealLeaf: async () => {},
    getActiveViewOfType: () => null,
    getActiveFile: () => null,
  },
  vault: { read: async () => "", on: () => ({}) },
};

const plugin = new PluginClass(app, { id: "rsvp-reader", version: "0.1.0" });
await plugin.onload();
plugin.onunload(); // exercise unload path (no open leaves)

Module._load = origLoad;

const cmdIds = plugin.commands.map((c) => c.id).sort();
const problems = [];
for (const id of ["read-current-note", "read-selection", "open-reader"]) {
  if (!cmdIds.includes(id)) problems.push(`missing command: ${id}`);
}
if (!Object.keys(plugin.views).includes("rsvp-reader-view")) problems.push("view not registered");
if (plugin.ribbons.length === 0) problems.push("no ribbon icon");
if (plugin.settingTabs.length === 0) problems.push("no settings tab");
if (secrets.get("rsvp-reader-unreal-api-key") !== "legacy-test-key") {
  problems.push("legacy API key not migrated to SecretStorage");
}
if (Object.hasOwn(plugin.savedData ?? {}, "unrealApiKey")) {
  problems.push("API key remained in plugin data");
}

if (problems.length) {
  console.error("load smoke FAILED:", problems.join("; "));
  process.exit(1);
}
console.log("load smoke OK: commands, view, ribbon, and settings tab registered");
