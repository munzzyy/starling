// Everything this device knows about you, as one readable object. The point
// is the shape: the export is BUILT from an allowlist, field by field, so key
// material cannot ride along by accident. Nothing here reads storage; the
// caller hands in live state, which also means a locked device cannot export
// at all, because there is no live state to hand.
export function buildDataExport(src) {
  const places = (src.places || []).map((p) => ({
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    radius: p.radius,
    fence: !!p.fence,
  }));
  const people = (src.pinned || []).map((r) => ({
    name: r.name || null,
    memberId: r.memberId,
    verified: !!r.verified,
  }));
  return {
    app: "starling",
    exported: new Date(src.now ?? Date.now()).toISOString(),
    profile: {
      name: src.profile?.name || null,
      emoji: src.profile?.emoji || null,
    },
    settings: { ...(src.settings || {}) },
    places,
    circles: (src.circles || []).map((c) => ({ name: c.name || null })),
    people,
    note:
      "This is every category of data Starling keeps about you, held only on your device. " +
      "Positions are not in it because Starling does not store them: points live in memory and die with the session. " +
      "No keys are in it, on purpose: keys never leave the device, not even into your own export.",
  };
}

// The names that must never appear as keys anywhere in an export, at any
// depth. The test walks the built object against this list; keeping the list
// next to the builder keeps the promise and its proof in one place.
export const EXPORT_KEY_DENYLIST = [
  "secret",
  "seed",
  "ck",
  "ck0",
  "chain",
  "vaultKey",
  "pk",
  "epk",
  "sk",
  "key",
  "sig",
  "passcode",
  "duress",
];
