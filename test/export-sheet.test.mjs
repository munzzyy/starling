// The export sheet opens wherever its button is, and the export covers every circle.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp } from "./dom-harness.mjs";

const harness = installDom();

globalThis.indexedDB ??= {
  open() {
    throw new Error("no indexeddb in the harness");
  },
  deleteDatabase() {
    const req = {};
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  },
};

const { internals } = await loadApp(harness);
const state = internals.state;
const ui = await import("../app/js/ui.js");
const { EXPORT_KEY_DENYLIST } = await import("../app/js/export.js");

test.after(() => {
  delete globalThis.StarlingNative;
  harness.stopTimers();
});

const testids = (node) => node.children.map((c) => c.dataset?.testid).filter(Boolean);

test("the sheet opens on the web with the data, Copy, and a file to save", () => {
  delete globalThis.StarlingNative;
  const ov = ui.openExportSheet('{"app":"starling"}');
  const [, pre, actions] = ov.body.children;
  assert.equal(pre.textContent, '{"app":"starling"}');
  assert.deepEqual(testids(actions), ["export-copy", "export-download"]);
  ov.close();
});

test("inside the app there is no file link the WebView cannot follow, and Copy is still there", () => {
  globalThis.StarlingNative = { windowShown: () => true };
  try {
    const ov = ui.openExportSheet("{}");
    const actions = ov.body.children[2];
    assert.deepEqual(testids(actions), ["export-copy"]);
    assert.ok(!actions.children.some((c) => c.tagName === "A"), "no anchor at all");
    ov.close();
  } finally {
    delete globalThis.StarlingNative;
  }
});

test("closing the sheet frees the file and still tells the caller", () => {
  const revoked = [];
  const real = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => revoked.push(u);
  try {
    let told = 0;
    const ov = ui.openExportSheet("{}", { onClose: () => told++ });
    const href = ov.body.children[2].children[1].href;
    ov.close();
    assert.deepEqual(revoked, [href]);
    assert.equal(told, 1);
  } finally {
    URL.revokeObjectURL = real;
  }
});

function walkKeys(obj, path = []) {
  const hits = [];
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (EXPORT_KEY_DENYLIST.includes(k)) hits.push([...path, k].join("."));
      hits.push(...walkKeys(v, [...path, k]));
    }
  }
  return hits;
}

test("the app hands the export every circle, the one on screen first, each with its own people", () => {
  const saved = { gen: state.gen, circleName: state.circleName, circleShare: state.circleShare, pinned: state.pinned, circles: state.circles };
  try {
    state.gen = { ratchet: {} };
    state.circleName = "Family";
    state.circleShare = { precision: null, cadence: 60 };
    state.pinned = new Map([["a".repeat(32), { memberId: "a".repeat(32), name: "Blair", verified: true, pk: "PKLEAK", epk: "EPKLEAK" }]]);
    state.circles = [
      {
        name: "Climbing",
        secret: new Uint8Array([7, 7, 7]),
        identity: { memberId: "b".repeat(32) },
        channelId: "CHANNELLEAK",
        precision: "coarse",
        cadence: null,
        pinned: [{ memberId: "c".repeat(32), name: "Casey", verified: false, pk: "CASEYPKLEAK", epk: "CASEYEPKLEAK" }],
      },
    ];
    const json = internals.dataExportJson();
    const out = JSON.parse(json);
    assert.deepEqual(
      out.circles.map((c) => [c.name, c.active, c.precision, c.cadence, c.people.map((p) => p.name)]),
      [
        ["Family", true, state.settings.precision, 60, ["Blair"]],
        ["Climbing", false, "coarse", 15, ["Casey"]],
      ],
    );
    assert.deepEqual(walkKeys(out), []);
    for (const needle of ["PKLEAK", "CASEYPKLEAK", "CHANNELLEAK", "bbbbbbbb"]) assert.ok(!json.includes(needle), needle);

    state.gen = null;
    const away = JSON.parse(internals.dataExportJson());
    assert.deepEqual(away.circles.map((c) => [c.name, c.active]), [["Climbing", false]], "no circle on screen, no made-up active one");
  } finally {
    Object.assign(state, saved);
  }
});
