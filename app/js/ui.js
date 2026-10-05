// UI components: toasts, overlay sheets, the draggable bottom sheet, member
// cards, and the settings/invite/identity builders. No app state lives here;
// main.js owns state and passes callbacks in.
//
// Hard rule respected throughout: user-controlled strings (names, statuses,
// anything decrypted) only ever pass through textContent, never innerHTML.

import { bearingDeg, compassWord, fmtClock, fmtDistance, fmtRelTime, getUnits, haversineMeters } from "./fmt.js";
import { HISTORY_CHOICES } from "./ratchet.js";
import { t, currentLocale, LOCALE_CHOICES } from "./i18n.js";
import { isBundled, native, pageShown } from "./env.js";
import { PLACE_RADII, MAX_PLACES, MAX_NAME_LEN } from "./places.js";
import { DEFAULT_TIMER_MIN, TIMER_CHOICES_MIN } from "./checkin.js";
import { staleAfter } from "./net.js";
import { VERSION } from "./version.js";

const AUTHOR = { name: "Munzzyy", url: "https://github.com/munzzyy" };

export const $ = (sel, root = document) => root.querySelector(sel);

// The translation chokepoint: every plain English literal handed to el()
// or btn() is looked up in the active catalog (t() passes unknown strings
// through, so user content and pre-composed sentences are never mangled).
export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = typeof text === "string" ? t(text) : text;
  return n;
}

function btn(cls, text, label) {
  const b = el("button", cls, text);
  b.type = "button";
  if (label) b.setAttribute("aria-label", t(label));
  return b;
}

// ---------------------------------------------------------------- toasts

export function toast(message, kind = "info") {
  const host = document.getElementById("toasts");
  // Under the map's top chrome as it stands now, since banners change its height.
  const chrome = document.querySelector("#screen-map:not([hidden]) .top-chrome");
  const bottom = chrome?.getBoundingClientRect?.().bottom || 0;
  host.style.top = bottom > 0 ? `${Math.round(bottom + 8)}px` : "";
  const node = el("div", `toast toast-${kind}`, message);
  node.dataset.testid = "toast";
  // Safety-critical toasts (an incoming SOS, a warning) announce assertively
  // instead of waiting behind the polite live region.
  if (kind === "sos" || kind === "warn") node.setAttribute("role", "alert");
  host.append(node);
  requestAnimationFrame(() => node.classList.add("in"));
  setTimeout(() => {
    node.classList.remove("in");
    setTimeout(() => node.remove(), 400);
  }, 3400);
  return node;
}

// ------------------------------------------------------------ focus trap

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// Fallback for browsers without the `inert` property: pull a subtree out of
// (or back into) the tab order, remembering any prior tabindex so it restores.
function setTabbable(root, on) {
  for (const el of root.querySelectorAll("a, button, input, select, textarea, [tabindex]")) {
    if (on) {
      if (el.dataset.prevTab !== undefined) {
        if (el.dataset.prevTab === "") el.removeAttribute("tabindex");
        else el.tabIndex = Number(el.dataset.prevTab);
        delete el.dataset.prevTab;
      }
    } else if (el.dataset.prevTab === undefined) {
      el.dataset.prevTab = el.getAttribute("tabindex") ?? "";
      el.tabIndex = -1;
    }
  }
}

export function trapFocus(root, { autofocus = true } = {}) {
  function onKey(e) {
    if (e.key !== "Tab") return;
    const items = [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  }
  document.addEventListener("keydown", onKey, true);
  if (autofocus) root.querySelector(FOCUSABLE)?.focus();
  return () => document.removeEventListener("keydown", onKey, true);
}

// --------------------------------------------------------- overlay sheets

const overlayStack = [];

export function openOverlay({ title, testid, className, onClose } = {}) {
  const host = document.getElementById("overlays");
  const wrap = el("div", "ov-wrap");
  const scrim = el("div", "ov-scrim");
  const panel = el("section", `ov-panel${className ? " " + className : ""}`);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  if (title) panel.setAttribute("aria-label", t(title));
  if (testid) panel.dataset.testid = testid;

  const head = el("header", "ov-head");
  const grab = el("div", "grabber");
  const titleEl = el("h2", "ov-title", title || "");
  const x = btn("icon-btn ov-close", "✕", "Close");
  head.append(titleEl, x);
  const body = el("div", "ov-body");
  panel.append(grab, head, body);
  wrap.append(scrim, panel);
  host.append(wrap);

  const prevFocus = document.activeElement;
  panel.tabIndex = -1;
  const untrap = trapFocus(panel, { autofocus: false });
  panel.focus();
  requestAnimationFrame(() => wrap.classList.add("open"));

  let closed = false;
  const entry = {};
  function close() {
    if (closed) return;
    closed = true;
    untrap();
    const i = overlayStack.indexOf(entry);
    if (i >= 0) overlayStack.splice(i, 1);
    wrap.classList.remove("open");
    setTimeout(() => wrap.remove(), 280);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.();
    onClose?.();
  }
  entry.close = close;
  overlayStack.push(entry);
  scrim.addEventListener("click", close);
  x.addEventListener("click", close);
  return { panel, body, close, setTitle: (t) => (titleEl.textContent = t) };
}

export function closeTopOverlay() {
  const top = overlayStack[overlayStack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function closeAllOverlays() {
  while (overlayStack.length) overlayStack[overlayStack.length - 1].close();
}

export const overlaysOpen = () => overlayStack.length > 0;

// ------------------------------------------------------------ hold-to-fire
// Arms on pointerdown, fires after ms with a radial progress ring (--p).
// A synthetic click (isTrusted false) with no prior pointerdown fires
// immediately so automated tests can drive it.

export function holdToFire(button, { ms = 1200, onFire, onShortTap }) {
  let raf = 0;
  let armed = false;
  let progress = 0;

  const setP = (p) => button.style.setProperty("--p", String(p));

  function cancel() {
    if (!armed) return;
    armed = false;
    progress = 0;
    button.classList.remove("arming");
    cancelAnimationFrame(raf);
    setP(0);
  }

  function start(e) {
    if (e.button > 0 || armed) return;
    armed = true;
    progress = 0;
    button.classList.add("arming");
    const t0 = performance.now();
    const step = (now) => {
      if (!armed) return;
      progress = Math.min(1, (now - t0) / ms);
      setP(progress);
      if (progress >= 1) {
        cancel();
        onFire();
      } else {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
  }

  let sawPointer = false;
  button.addEventListener("pointerdown", (e) => {
    sawPointer = true;
    start(e);
  });
  button.addEventListener("pointerup", () => {
    // A released short press is a plain tap; tell the user this button
    // needs a hold instead of doing nothing.
    if (armed && progress < 1) onShortTap?.();
    cancel();
  });
  button.addEventListener("pointerleave", cancel);
  button.addEventListener("pointercancel", cancel);

  // The keyboard path: holding Enter or Space arms the same timer a finger
  // does, so the deliberate-hold property survives without a pointer.
  let keyHeld = false;
  button.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // Space would otherwise synthesize a click on keyup and Enter on keydown.
    e.preventDefault();
    if (e.repeat || keyHeld) return;
    keyHeld = true;
    start({ button: 0 });
  });
  button.addEventListener("keyup", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (!keyHeld) return;
    keyHeld = false;
    if (armed && progress < 1) onShortTap?.();
    cancel();
  });
  button.addEventListener("blur", () => {
    keyHeld = false;
    cancel();
  });

  // Assistive tech's activation cannot hold anything, so for it the hold
  // becomes two activations: the first arms a window and tells the user so
  // (onShortTap hears atArmed=true and speaks the right copy), the second
  // fires. The window is long enough to re-find the button by ear.
  let atArmedUntil = 0;
  button.addEventListener("click", (e) => {
    // Untrusted clicks come from automation; they fire directly.
    if (!e.isTrusted && !armed) {
      onFire();
      return;
    }
    if (e.isTrusted && !sawPointer && !armed) {
      if (performance.now() < atArmedUntil) {
        atArmedUntil = 0;
        onFire();
      } else {
        atArmedUntil = performance.now() + 10000;
        onShortTap?.(true);
      }
    }
    sawPointer = false;
  });
}

// ------------------------------------------------------------ emoji picker

export const EMOJI = [
  "\u{1F426}", "\u{1F98A}", "\u{1F989}", "\u{1F41D}", "\u{1F98B}", "\u{1F422}",
  "\u{1F419}", "\u{1F42C}", "\u{1F995}", "\u{1F9A9}", "\u{1F43A}", "\u{1F40C}",
  "\u{1F335}", "\u{1F319}", "⚡", "\u{1F525}", "❄️", "\u{1F30A}",
  "\u{1F344}", "\u{1F388}", "\u{1F6B2}", "\u{1F3A7}", "\u{1F392}", "\u{1F9ED}",
];

export function emojiGrid(initial) {
  const grid = el("div", "emoji-grid");
  grid.setAttribute("role", "radiogroup");
  grid.setAttribute("aria-label", t("Avatar"));
  let selected = EMOJI.includes(initial) ? initial : EMOJI[0];
  const cells = new Map();
  for (const em of EMOJI) {
    const b = btn("emoji-cell", em, t("Avatar {em}", { em }));
    b.setAttribute("role", "radio");
    cells.set(em, b);
    b.addEventListener("click", () => {
      selected = em;
      for (const [k, cell] of cells) {
        cell.classList.toggle("sel", k === em);
        cell.setAttribute("aria-checked", String(k === em));
      }
    });
    grid.append(b);
  }
  for (const [k, cell] of cells) {
    cell.classList.toggle("sel", k === selected);
    cell.setAttribute("aria-checked", String(k === selected));
  }
  grid.value = () => selected;
  return grid;
}

// --------------------------------------------------------- identity fields

function identityFields(profile) {
  const wrap = el("div", "id-fields");
  const nameField = el("label", "field");
  nameField.append(el("span", "field-label", "Your name"));
  const input = el("input", "text-input");
  input.type = "text";
  input.maxLength = 24;
  input.placeholder = t("Name");
  input.autocomplete = "off";
  input.value = profile?.name || "";
  input.dataset.testid = "identity-name";
  nameField.append(input);
  const avaField = el("div", "field");
  avaField.append(el("span", "field-label", "Pick an avatar"));
  const grid = emojiGrid(profile?.emoji);
  avaField.append(grid);
  wrap.append(nameField, avaField);
  return { wrap, input, grid };
}

// The optional circleName block gives create and join a local label field;
// the label never leaves the device, it only names the circle in the switcher.
function circleNameField(circleName) {
  const field = el("label", "field");
  field.append(el("span", "field-label", "Circle name"));
  const input = el("input", "text-input");
  input.type = "text";
  input.maxLength = 24;
  input.placeholder = circleName.placeholder || t("Family, friends, the trip");
  input.autocomplete = "off";
  input.value = circleName.value || "";
  input.dataset.testid = "circle-name";
  field.append(input);
  return { field, input };
}

export function openIdentitySheet({ title, intro, cta, profile, circleName, onSave }) {
  const ov = openOverlay({ title, testid: "identity-sheet" });
  if (intro) ov.body.append(el("p", "ov-note", intro));
  const { wrap, input, grid } = identityFields(profile);
  ov.body.append(wrap);
  let cn = null;
  if (circleName) {
    cn = circleNameField(circleName);
    ov.body.append(cn.field);
  }
  const save = btn("btn btn-primary", cta || "Save");
  save.dataset.testid = "identity-save";
  const sync = () => (save.disabled = input.value.trim().length === 0);
  input.addEventListener("input", sync);
  sync();
  let busy = false;
  save.addEventListener("click", async () => {
    const name = input.value.trim().slice(0, 24);
    if (!name || busy) return;
    busy = true;
    save.disabled = true;
    try {
      const p = { name, emoji: grid.value() };
      if (cn) p.circleName = cn.input.value.trim().slice(0, 24);
      // false is the circle guard's busy-bail, already toasted; keep the
      // sheet and the typed name instead of pretending the save happened.
      if ((await onSave(p)) === false) {
        busy = false;
        save.disabled = false;
        return;
      }
      ov.close();
    } catch {
      busy = false;
      save.disabled = false;
      toast("Could not save. Try again.", "warn");
    }
  });
  ov.body.append(save);
  input.focus();
  return ov;
}

export function openJoinSheet({ profile, hasCircle, circleName, relayHost, onJoin }) {
  const ov = openOverlay({ title: "Join a circle", testid: "join-sheet" });
  ov.body.append(
    el("p", "ov-note", "You have an invite to a circle. Set up how you will appear to the people in it."),
    el(
      "p",
      "ov-note",
      "This sends a request. Somebody already in the circle has to check your safety number and accept it before you can see anyone, or they you. That check is how they know the request really came from you and not from somebody who got hold of the link.",
    ),
  );
  if (hasCircle) {
    ov.body.append(
      el("p", "ov-note", "Your current circle stays. This adds a new one, and you can switch between them from the circle name at the top of the map."),
    );
  }
  if (relayHost) {
    const note = el("p", "ov-note", t("This circle uses the relay at {host}. Asking to join switches Starling to it.", { host: relayHost }));
    note.dataset.testid = "join-relay-note";
    ov.body.append(note);
  }
  const { wrap, input, grid } = identityFields(profile);
  ov.body.append(wrap);
  let cn = null;
  if (circleName) {
    cn = circleNameField(circleName);
    ov.body.append(
      cn.field,
      el(
        "p",
        "field-note",
        "Nobody has told you the circle's real name yet (names travel encrypted, like everything else), so pick whatever you will recognize. Rename it any time in settings.",
      ),
    );
  }
  const join = btn("btn btn-primary", "Ask to join");
  join.dataset.testid = "join-confirm";
  const sync = () => (join.disabled = input.value.trim().length === 0);
  input.addEventListener("input", sync);
  sync();
  let busy = false;
  join.addEventListener("click", async () => {
    const name = input.value.trim().slice(0, 24);
    if (!name || busy) return;
    busy = true;
    join.disabled = true;
    try {
      const p = { name, emoji: grid.value() };
      if (cn) p.circleName = cn.input.value.trim().slice(0, 24);
      if ((await onJoin(p)) === false) {
        busy = false;
        join.disabled = false;
        return;
      }
      ov.close();
    } catch {
      busy = false;
      join.disabled = false;
      toast("Could not join. Try again.", "warn");
    }
  });
  ov.body.append(join);
  return ov;
}

// ------------------------------------------------------------ circle sheet
// The switcher behind the circle name pill: the active circle on top, the
// rest tappable, and the two ways to add another. Inactive circles are not
// polled, so the rows carry names only, no liveness claims.

export function openCircleSheet({ current, others, onSwitch, onCreate, onJoin }) {
  const ov = openOverlay({ title: "Your circles", testid: "circle-sheet" });
  const list = el("div", "circle-list");
  const row = (name, mark) => {
    const r = btn("circle-row" + (mark ? " circle-row-current" : ""), "");
    r.append(el("span", "circle-row-name", name));
    if (mark) r.append(el("span", "circle-row-mark", "Current"));
    return r;
  };
  const cur = row(current.name, true);
  cur.disabled = true;
  list.append(cur);
  // One tap freezes the whole sheet: two switches racing each other is a
  // storage hazard, not a UI nicety.
  const freezable = [];
  const freeze = (on) => freezable.forEach((b) => (b.disabled = on));
  others.forEach((c, i) => {
    const r = row(c.name, false);
    r.dataset.testid = `circle-switch-${i}`;
    r.addEventListener("click", async () => {
      freeze(true);
      try {
        const ok = await onSwitch(i);
        if (ok) {
          ov.close();
          return;
        }
        freeze(false);
      } catch {
        freeze(false);
        toast("Could not switch. Try again.", "warn");
      }
    });
    freezable.push(r);
    list.append(r);
  });
  ov.body.append(list);
  const add = el("div", "circle-add");
  const create = btn("btn btn-secondary", "New circle");
  create.dataset.testid = "circle-new";
  create.addEventListener("click", () => {
    ov.close();
    onCreate();
  });
  const join = btn("btn btn-ghost", "Join with invite");
  join.dataset.testid = "circle-join";
  join.addEventListener("click", () => {
    ov.close();
    onJoin();
  });
  freezable.push(create, join);
  add.append(create, join);
  ov.body.append(add);
  return ov;
}

// --------------------------------------------------------- safety numbers

// A safety number exists to be read out loud to another person, so it is set
// in a mono block with the six groups kept whole: a group that wraps halfway
// is a group somebody misreads.
export function safetyBlock(number, testid) {
  const wrap = el("div", "safety");
  if (testid) wrap.dataset.testid = testid;
  setSafety(wrap, number);
  // Tapping the number opens it full screen in large type: two people
  // standing next to each other compare phones directly, which is both the
  // easiest ceremony and the one no compromised messaging channel can sit in
  // the middle of.
  wrap.classList.add("safety-tappable");
  wrap.setAttribute("role", "button");
  wrap.tabIndex = 0;
  wrap.setAttribute("aria-label", t("Show this safety number large for comparing in person"));
  const openBig = () => {
    const digits = [...wrap.querySelectorAll(".safety-g")].map((g) => g.textContent).join(" ");
    if (!/\d/.test(digits)) return;
    const ov = openOverlay({ title: "Compare in person", testid: "safety-big" });
    ov.body.append(
      el("p", "ov-note", "Hold the phones side by side. Every group has to match."),
    );
    const big = el("div", "safety-huge");
    for (const g of digits.split(/\s+/)) big.append(el("span", "safety-huge-g", g));
    ov.body.append(big);
  };
  wrap.addEventListener("click", openBig);
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openBig();
    }
  });
  return wrap;
}

// The numbers are derived asynchronously, so a row paints first and fills in.
export function setSafety(wrap, number) {
  wrap.replaceChildren();
  const groups = String(number || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!groups.length) {
    wrap.classList.add("safety-wait");
    wrap.append(el("span", "safety-g", "-----"));
    wrap.setAttribute("aria-label", t("Safety number loading"));
    return wrap;
  }
  wrap.classList.remove("safety-wait");
  // Real spaces between the groups, not just a CSS gap: this block is meant to
  // be selected and pasted into the channel you are checking it over, and six
  // groups run together is a number nobody can read back.
  groups.forEach((g, i) => {
    if (i) wrap.append(" ");
    wrap.append(el("span", "safety-g", g));
  });
  wrap.setAttribute("aria-label", t("Safety number {digits}", { digits: groups.join(" ") }));
  return wrap;
}

// Countdowns for the two things that expire: an invitation and a help link.
// Coarse on purpose. A ticking second hand on something you are about to hand
// to somebody reads as pressure, and these are read under pressure already.
export function fmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return t("expired");
  if (ms < 60000) return t("under a minute");
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")} min`;
}

function nameList(names) {
  try {
    return new Intl.ListFormat(currentLocale(), { type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

export const circleLabel = (name) => name || t("My circle");

// ---------------------------------------------------------- link handoff

// A copied invite link is a credential sitting in the clipboard, where any
// app the user pastes into later (or a clipboard manager) can pick it up.
// Best effort: 90 seconds after a copy, clear the clipboard IF it still holds
// exactly what was copied. Never touches anything the user copied since, and
// silently does nothing where reading the clipboard would mean a permission
// prompt out of thin air.
// A link is meant to be pasted into another app, so it gets five minutes,
// not ninety seconds: a share sheet, an app switch, and a scroll through a
// conversation all happen before the paste. The clear announces itself when
// the app is on screen, so a later failed paste has an explanation.
const CLIP_CLEAR_MS = 5 * 60_000;
let clipTimer = 0;
function scheduleClipboardClear(text) {
  clearTimeout(clipTimer);
  clipTimer = setTimeout(async () => {
    const announce = () => {
      if (pageShown()) toast("Invite link cleared from your clipboard.");
    };
    const n = native();
    if (n?.clearClipboardIf) {
      // The bridge checks the clipboard still holds this text before
      // clearing, but cannot answer whether it did; no announcement here
      // beats announcing a clear that never happened.
      try {
        n.clearClipboardIf(text);
      } catch {
        // old wrapper without the method
      }
      return;
    }
    try {
      const perm = await navigator.permissions?.query?.({ name: "clipboard-read" });
      if (perm?.state !== "granted") return;
      if ((await navigator.clipboard.readText()) === text) {
        await navigator.clipboard.writeText("");
        announce();
      }
    } catch {
      // no clipboard read here; leave it alone
    }
  }, CLIP_CLEAR_MS);
}

async function copyLink(link, msg) {
  try {
    await navigator.clipboard.writeText(link);
    scheduleClipboardClear(link);
    toast(msg);
  } catch {
    toast("Copy failed. Long-press the link instead.", "warn");
  }
}

// The OS share sheet is the fast path under stress: it reaches the messaging
// apps someone already has open. Clipboard is the fallback.
export async function shareLink(link, lead, msg) {
  const text = `${t(lead)} ${link}`;
  try {
    if (native()?.shareText?.(text) === true) return;
  } catch {
    // an older wrapper; fall through
  }
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch {
      // cancelled or unavailable: fall through to copying
    }
  }
  await copyLink(link, msg);
}

// ---------------------------------------------------------------- alerts
//
// The states this app refuses to settle quietly: a member's keys changing,
// somebody waiting to be let in, a clock that has made you invisible. main.js
// decides what is true and writes the words; this keeps the cards stable
// across renders so one never jumps out from under a thumb.

export function updateAlerts(container, items) {
  const existing = new Map();
  for (const node of container.children) existing.set(node.dataset.alert, node);
  for (const item of items) {
    let node = existing.get(item.id);
    if (node) {
      existing.delete(item.id);
    } else {
      node = el("div", "notice");
      node.dataset.alert = item.id;
      node.dataset.testid = "alert";
      // Set once, at build time: re-asserting it on every render would make a
      // screen reader read a standing warning out again every five seconds.
      if (item.kind !== "info") node.setAttribute("role", "alert");
      node.append(el("p", "notice-title"), el("p", "notice-text"), el("div", "notice-actions"));
    }
    node.className = `notice notice-${item.kind || "warn"}`;
    const title = node.querySelector(".notice-title");
    const text = node.querySelector(".notice-text");
    if (title.textContent !== item.title) title.textContent = item.title;
    if (text.textContent !== item.text) text.textContent = item.text;
    const acts = node.querySelector(".notice-actions");
    const wanted = (item.actions || []).map((a) => a.label).join("|");
    if (acts.dataset.labels !== wanted) {
      acts.replaceChildren();
      for (const a of item.actions || []) {
        const b = btn(`btn btn-small ${a.variant || "btn-secondary"}`, a.label);
        if (a.testid) b.dataset.testid = a.testid;
        acts.append(b);
      }
      acts.dataset.labels = wanted;
    }
    acts.hidden = !(item.actions || []).length;
    [...acts.children].forEach((b, i) => {
      b.onclick = item.actions[i].onClick;
    });
    container.append(node);
  }
  for (const node of existing.values()) node.remove();
}

// ----------------------------------------------------------- members sheet
//
// Pinning a member the first time their keys check out is trust on first use
// and nothing more. This screen is where that becomes a checked identity: the
// safety numbers, big enough to read down a phone line, what this device
// currently believes about each person, and the two decisions a human can
// make. It is one tap from the map because it is the whole difference between
// "the app says this is Ana" and "I know this is Ana".

function memberRow(api, id, { onChanged }) {
  const node = el("div", "mem-row");
  node.dataset.testid = "member-row";
  node.dataset.member = id;

  const head = el("div", "mem-head");
  const name = el("div", "mem-name");
  name.dataset.testid = "member-row-name";
  const pill = el("span", "verify-pill");
  head.append(name, pill);

  const safety = safetyBlock(null, "member-safety");

  // A key change replaces the plain number with both numbers side by side,
  // because the only useful question at that point is which of the two the
  // member reads back to you.
  const change = el("div", "key-change");
  change.dataset.testid = "key-change";
  const changeText = el("p", "ov-warn-note");
  const pair = el("div", "safety-pair");
  const wasBlock = safetyBlock(null, "safety-was");
  const nowBlock = safetyBlock(null, "safety-now");
  const wasCol = el("div", "safety-col");
  wasCol.append(el("span", "safety-cap", "Was"), wasBlock);
  const nowCol = el("div", "safety-col");
  nowCol.append(el("span", "safety-cap", "Now"), nowBlock);
  pair.append(wasCol, nowCol);
  const acceptBtn = btn("btn btn-secondary btn-small", "Accept the new keys");
  acceptBtn.dataset.testid = "key-accept";
  change.append(changeText, pair, acceptBtn);

  const hint = el("p", "field-note");

  const nickField = el("label", "field");
  const nickIn = el("input", "text-input");
  nickIn.type = "text";
  nickIn.maxLength = 24;
  nickIn.autocomplete = "off";
  nickIn.dataset.testid = "member-nick";
  nickField.append(el("span", "field-label", "Your name for them"), nickIn);
  const nickNote = el("p", "field-note");

  const muteRow = switchRow({
    label: "Mute place and battery alerts",
    note: "Their arrivals, departures and low battery stay silent on this phone. An SOS or a missed check-in from them still comes through.",
    value: false,
    onChange: async (on) => {
      await api.setMuted(id, on);
      onChanged();
    },
  });
  muteRow.dataset.testid = "member-mute";

  const actions = el("div", "mem-actions");
  const verifyBtn = btn("btn btn-secondary btn-small", "Mark verified");
  verifyBtn.dataset.testid = "member-verify";
  const removeBtn = btn("btn btn-danger-ghost btn-small", "Remove");
  removeBtn.dataset.testid = "member-remove";
  actions.append(verifyBtn, removeBtn);

  const confirm = el("div", "confirm-box");
  confirm.hidden = true;
  const confirmText = el("p", "ov-note");
  const confirmGo = btn("btn btn-danger btn-small", "Remove them");
  confirmGo.dataset.testid = "member-remove-confirm";
  confirm.append(confirmText, confirmGo);

  node.append(head, safety, change, hint, nickField, nickNote, muteRow, actions, confirm);

  let cur = { name: "Member", verified: false };

  verifyBtn.addEventListener("click", async () => {
    verifyBtn.disabled = true;
    try {
      await api.markVerified(id, !cur.verified);
    } finally {
      verifyBtn.disabled = false;
    }
    onChanged();
  });

  removeBtn.addEventListener("click", () => {
    confirm.hidden = !confirm.hidden;
    if (!confirm.hidden) confirm.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  confirmGo.addEventListener("click", async () => {
    confirmGo.disabled = true;
    const who = cur.name;
    try {
      // null is a re-key that did not happen; false is the circle guard's
      // busy-bail, which has already said so.
      const out = await api.removeMember(id);
      if (out) toast(t("{who} is out. Everyone else has new keys.", { who }));
      else if (out === null) toast("Could not remove them. Nothing changed.", "warn");
    } catch {
      toast("Could not remove them. Nothing changed.", "warn");
    }
    confirmGo.disabled = false;
    confirm.hidden = true;
    onChanged();
  });

  nickIn.addEventListener("change", async () => {
    await api.setNickname(id, nickIn.value);
    onChanged();
  });

  acceptBtn.addEventListener("click", async () => {
    acceptBtn.disabled = true;
    const who = cur.name;
    try {
      if (await api.acceptKeyChange(id)) toast(t("{who} is now pinned to the new keys.", { who }));
    } finally {
      acceptBtn.disabled = false;
    }
    onChanged();
  });

  function update({ name: who, nick, posted, muted, verified, safety: number, change: ch }) {
    cur = { name: who, verified: !!verified };
    name.textContent = who;
    muteRow.setValue(muted);
    if (document.activeElement !== nickIn) nickIn.value = nick || "";
    nickIn.placeholder = posted || "";
    nickNote.textContent =
      nick && posted && posted !== nick
        ? t("Only this phone sees this name. In the circle they go by {name}.", { name: posted })
        : t("Only this phone sees this name.");
    // Marking somebody verified while their keys are in question would be
    // verifying the wrong thing, so that action is not offered until the
    // change is answered.
    pill.textContent = ch ? t("Keys changed") : verified ? t("Verified") : t("Not verified");
    pill.className = `verify-pill ${ch ? "vp-alert" : verified ? "vp-on" : "vp-off"}`;
    verifyBtn.hidden = !!ch;
    verifyBtn.textContent = verified ? t("Mark not verified") : t("Mark verified");
    confirmText.textContent = t("Everyone else gets new keys. {who} can read nothing this circle sends from now on, and is not told. What they already saw, they keep.", { who });
    if (ch) {
      node.classList.add("mem-changed");
      change.hidden = false;
      safety.hidden = true;
      changeText.textContent = t("{who} is answering with different keys. That is a reinstall, or somebody else in their place, and this phone cannot tell which. Their location stays off your map until you accept.", { who });
      setSafety(wasBlock, ch.oldSafety);
      setSafety(nowBlock, ch.newSafety);
      hint.textContent = t("Ask {who} to read out the number on their screen. If it is the new one, accept it. If it is the old one, or they did not reinstall, remove them.", { who });
    } else {
      node.classList.remove("mem-changed");
      change.hidden = true;
      safety.hidden = false;
      setSafety(safety, number);
      hint.textContent = verified
        ? t("You have checked this number with {who}.", { who })
        : t("Read this out to {who} on a call or in person. The same digits on both screens means nobody is in between.", { who });
    }
  }

  return { node, update };
}

export function openMembersSheet({ api, onClose }) {
  const ov = openOverlay({
    title: "People and keys",
    testid: "members-sheet",
    className: "ov-members",
    onClose,
  });
  ov.body.append(
    el(
      "p",
      "ov-note",
      "Starling trusts whoever first answers with keys that match their member id. Reading these numbers out to each other is what turns that into knowing who is on your map.",
    ),
  );

  const you = el("section", "mem-you");
  const youName = el("div", "mem-name");
  const youSafety = safetyBlock(null, "own-safety");
  // The number as a code, and the camera for theirs. Scanning lives in the
  // app: the hosted site's headers deny the camera, and the scan is a check
  // between two phones held up to each other, not something a tab does.
  const youActions = el("div", "mem-you-actions");
  const showQr = btn("btn btn-secondary btn-small", "Show as QR");
  showQr.dataset.testid = "safety-show-qr";
  const scanQr = btn("btn btn-secondary btn-small", "Scan theirs");
  scanQr.dataset.testid = "safety-scan";
  youActions.append(showQr, scanQr);
  const scanNote = el("p", "field-note", "Scanning a code lives in the app. Here, compare the digits.");
  scanNote.dataset.testid = "safety-scan-note";
  const canScan = !!api.canScanQr?.();
  scanQr.hidden = !canScan;
  scanNote.hidden = canScan;
  you.append(
    el("span", "safety-cap", "Your number"),
    youName,
    youSafety,
    el("p", "field-note", "This is the number your circle should hear from you."),
    youActions,
    scanNote,
  );

  showQr.addEventListener("click", async () => {
    const text = await api.safetyQrText();
    if (!text) {
      toast("Your number is not ready yet.", "warn");
      return;
    }
    openSafetyQrSheet({ text, qrSvgFor: api.qrSvgFor });
  });
  scanQr.addEventListener("click", () => {
    openScanSheet({
      api,
      onResult: async (text) => {
        const verdict = await api.checkSafetyQr(text);
        openScanVerdict(api, verdict, { onChanged: refresh });
      },
    });
  });

  // The access ledger: what the pinned keys MEAN, said as capability. The
  // wording is deliberate: keys that could decrypt, never "who saw" - this
  // screen cannot know who looked, only who holds keys that open what you
  // send.
  const ledger = el("section", "mem-ledger");
  const ledgerNow = el("p", "mem-ledger-line");
  const ledgerHist = el("p", "mem-ledger-line mem-ledger-history");
  ledger.append(el("span", "safety-cap", "Who could read you"), ledgerNow, ledgerHist);
  const list = el("div", "mem-list");
  const empty = el("p", "ov-note", "Nobody else is in this circle yet. Invite someone from the map.");
  empty.hidden = true;
  ov.body.append(you, ledger, list, empty);

  const rows = new Map();
  const numbers = new Map();
  const pending = new Set();

  // Safety numbers do not change while the keys behind them do not, so each is
  // derived once and kept. A member whose keys DID change is drawn from the
  // key-change record instead, which carries both numbers already.
  function need(id) {
    if (numbers.has(id) || pending.has(id)) return;
    pending.add(id);
    api
      .safetyNumberFor(id)
      .then((n) => {
        pending.delete(id);
        if (!n) return;
        numbers.set(id, n);
        refresh();
      })
      .catch(() => pending.delete(id));
  }

  function refresh() {
    const meId = api.state.identity?.memberId;
    youName.textContent = api.state.profile?.name || t("You");
    if (meId) {
      need(meId);
      setSafety(youSafety, numbers.get(meId));
    }
    const changes = new Map(api.keyChanges().map((c) => [c.memberId, c]));
    const live = new Map(api.members().map((r) => [r.id, r]));
    const people = api.pinnedList();
    empty.hidden = people.length > 0;
    const others = people.filter((r) => r.memberId !== meId);
    const checked = others.filter((r) => r.verified).length;
    const unchecked = others.length - checked;
    ledgerNow.textContent =
      others.length === 0
        ? t("Only your own keys can decrypt what you send. The relay stores ciphertext it cannot open.")
        : t("{n} sets of keys besides yours can decrypt what you send: {checked} checked by a person, {unchecked} trusted on first use.", {
            n: others.length,
            checked,
            unchecked,
          });
    const win = HISTORY_CHOICES.find((c) => c.id === api.state.settings.history) || HISTORY_CHOICES[1];
    ledgerHist.textContent = t("A newly admitted key can also read back {window} of history. That window is yours to set in Settings.", {
      window: t(win.label),
    });
    const seen = new Set();
    for (const rec of people) {
      const id = rec.memberId;
      seen.add(id);
      let row = rows.get(id);
      if (!row) {
        row = memberRow(api, id, { onChanged: refresh });
        rows.set(id, row);
      }
      const ch = changes.get(id) || null;
      if (!ch) need(id);
      const heard = live.get(id);
      row.update({
        name: heard?.name || rec.nick || rec.name || t("Member"),
        nick: rec.nick || "",
        posted: (heard ? (rec.nick ? heard.posted : heard.name) : "") || rec.name || "",
        muted: rec.muted === true,
        verified: rec.verified,
        safety: numbers.get(id) || null,
        change: ch,
      });
      list.append(row.node);
    }
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.node.remove();
      rows.delete(id);
    }
  }

  refresh();
  return { close: ov.close, refresh };
}

// ------------------------------------------------------ safety number QR

export function openSafetyQrSheet({ text, qrSvgFor }) {
  const ov = openOverlay({ title: "Your number as a code", testid: "safety-qr" });
  const card = el("div", "qr-card");
  card.dataset.testid = "safety-qr-card";
  // qrSvg output is generated geometry from our own encoder, not user data.
  card.innerHTML = qrSvgFor(text);
  const svg = card.querySelector("svg");
  svg?.setAttribute("role", "img");
  svg?.setAttribute("aria-label", t("Safety number QR code"));
  ov.body.append(
    card,
    el(
      "p",
      "ov-note",
      "Let the person checking you scan this with Starling. It holds your member id and your safety number, nothing else.",
    ),
  );
  return ov;
}

// The camera, drawn to a canvas a few times a second and handed to the
// decoder. Every track stops the moment a code reads or the sheet closes,
// and no frame leaves the page.
// `check` returns words to show while the camera keeps looking, or null to take the code.
export function openScanSheet({ api, onResult, onClose, check, title, note }) {
  const words = { title: "Scan their code", note: "Point the camera at the code on their screen." };
  let stream = null;
  let timer = null;
  let closed = false;
  const video = document.createElement("video");
  video.className = "scan-video";
  video.setAttribute("playsinline", "");
  video.muted = true;
  video.autoplay = true;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const track of stream?.getTracks?.() || []) track.stop();
    stream = null;
    video.srcObject = null;
  };
  const ov = openOverlay({
    title: title || words.title,
    testid: "scan-sheet",
    onClose: () => {
      closed = true;
      stop();
      onClose?.();
    },
  });
  const status = el("p", "ov-note", note || words.note);
  status.dataset.testid = "scan-status";
  const settings = btn("btn btn-secondary btn-small", "Open app settings");
  settings.hidden = true;
  settings.addEventListener("click", () => native()?.openAppSettings?.());
  ov.body.append(video, status, settings);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  function tick() {
    if (closed || !stream || video.readyState < 2 || !video.videoWidth) return;
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    let hit = null;
    try {
      hit = api.decodeQr(ctx.getImageData(0, 0, canvas.width, canvas.height));
    } catch {
      hit = null;
    }
    if (!hit) return;
    const problem = check?.(hit.text);
    if (problem) {
      status.textContent = problem;
      status.className = "ov-warn-note";
      return;
    }
    stop();
    ov.close();
    onResult(hit.text);
  }

  const turnedDown = () => {
    status.textContent = t("Camera access was turned down. Allow it for Starling in system settings, then try again.");
    status.className = "ov-warn-note";
    settings.hidden = !native()?.openAppSettings;
  };

  (async () => {
    // The wrapper's runtime prompt first, and its answer, before the page
    // asks for a stream: see askCameraPermission in main.js.
    const allowed = await api.askCamera();
    if (closed) return;
    if (!allowed) {
      turnedDown();
      return;
    }
    let got;
    try {
      got = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      const name = e?.name || "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        turnedDown();
        return;
      }
      status.textContent =
        name === "NotFoundError" || name === "OverconstrainedError"
          ? t("No camera found on this device.")
          : t("The camera could not start.");
      status.className = "ov-warn-note";
      return;
    }
    if (closed) {
      for (const track of got.getTracks()) track.stop();
      return;
    }
    stream = got;
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // autoplay already has it, or the sheet is closing
    }
    if (!closed) timer = setInterval(tick, 250);
  })();

  return ov;
}

// What a scan came to. A match offers the same markVerified the manual
// compare uses and nothing else does; a mismatch reads like a key change,
// because that is what it is until a human says otherwise.
function openScanVerdict(api, verdict, { onChanged }) {
  const ov = openOverlay({ title: "Scan result", testid: "scan-result" });
  const id = verdict.memberId || "";
  const rec = id ? api.pinnedList().find((p) => p.memberId === id) : null;
  const who = id ? api.members().find((m) => m.id === id)?.name || rec?.nick || rec?.name || t("Member") : "";
  if (verdict.outcome === "match") {
    ov.body.append(el("p", "ov-note", t("The code matches the keys this phone holds for {who}. Nobody is in between.", { who })));
    ov.body.append(safetyBlock(verdict.number, "scan-number"));
    const changing = api.keyChanges().some((c) => c.memberId === id);
    if (changing) {
      ov.body.append(el("p", "ov-warn-note", t("{who} is answering with different keys right now. Settle that on their card before marking anything.", { who })));
    } else if (rec?.verified) {
      ov.body.append(el("p", "field-note", t("{who} is already marked verified.", { who })));
    } else {
      const mark = btn("btn btn-primary", t("Mark {who} verified", { who }));
      mark.dataset.testid = "scan-mark-verified";
      mark.addEventListener("click", async () => {
        mark.disabled = true;
        try {
          if (await api.markVerified(id, true)) toast(t("{who} is verified.", { who }));
        } finally {
          mark.disabled = false;
        }
        ov.close();
        onChanged();
      });
      ov.body.append(mark);
    }
  } else if (verdict.outcome === "mismatch") {
    ov.body.append(
      el(
        "p",
        "ov-warn-note",
        t("The code does not match the keys this phone holds for {who}. That is a reinstall, or somebody in between, and this phone cannot tell which. Do not mark them verified. Read the digits out to each other, and if they still differ, remove them.", { who }),
      ),
    );
  } else if (verdict.outcome === "unknown") {
    ov.body.append(el("p", "ov-note", "That code belongs to nobody in this circle."));
  } else {
    ov.body.append(el("p", "ov-note", "That is not a Starling safety number code."));
  }
  return ov;
}

// --------------------------------------------------------- help link sheet

// Shown after an SOS. These links go to whoever can actually help right now,
// including people who will never install anything. Each one is its own
// channel with its own key, so one can be cut off without the others noticing,
// and none of them can see the circle.

function viewerRow(v, { onRevoke, onChanged }) {
  const node = el("div", "viewer-row");
  node.dataset.testid = "viewer-row";
  node.dataset.viewer = v.id;
  const head = el("div", "viewer-head");
  const label = el("span", "viewer-label");
  const when = el("span", "viewer-when");
  head.append(label, when);
  const linkRow = el("div", "link-row");
  const linkText = el("code", "invite-link");
  linkText.dataset.testid = "viewer-link";
  linkRow.append(linkText);
  const actions = el("div", "mem-actions");
  const share = btn("btn btn-secondary btn-small", "Send");
  const copy = btn("btn btn-secondary btn-small", "Copy");
  const revoke = btn("btn btn-danger-ghost btn-small", "Revoke");
  revoke.dataset.testid = "viewer-revoke";
  actions.append(share, copy, revoke);
  node.append(head, linkRow, actions);

  let link = "";
  share.addEventListener("click", () => shareLink(link, "Follow my location:", "Help link copied"));
  copy.addEventListener("click", () => copyLink(link, "Help link copied"));
  revoke.addEventListener("click", async () => {
    revoke.disabled = true;
    try {
      await onRevoke(v.id);
      toast("That link is dead. The others still work.");
    } finally {
      revoke.disabled = false;
    }
    onChanged();
  });

  function update(next) {
    link = next.link || "";
    label.textContent = next.label || t("Help link");
    node.classList.toggle("viewer-dead", !!next.revoked);
    if (next.revoked) {
      when.textContent = t("Revoked");
      linkRow.hidden = true;
      actions.hidden = true;
    } else {
      const left = fmtCountdown(next.expiresAt - Date.now());
      when.textContent = next.failing ? t("Not reaching the relay") : t("Expires in {left}", { left });
      when.classList.toggle("viewer-failing", !!next.failing);
      linkText.textContent = link;
      linkRow.hidden = !link;
      actions.hidden = false;
    }
  }

  return { node, update };
}

export function openHelpSheet({ api, onAdd, onRevoke, onEnd, onClose }) {
  const ov = openOverlay({
    title: "Get outside help",
    testid: "help-sheet",
    className: "ov-invite",
    onClose,
  });

  ov.body.append(
    el(
      "p",
      "ov-note",
      "Anyone you send one of these to can watch your live location on any phone or computer, with no app and no account. A link shows this emergency only, never your circle, and never the other links.",
    ),
  );

  const list = el("div", "viewer-list");
  list.dataset.testid = "viewer-list";
  ov.body.append(list);

  const addField = el("label", "field");
  addField.append(el("span", "field-label", "Another link, for one more person"));
  const addInput = el("input", "text-input");
  addInput.type = "text";
  addInput.maxLength = 40;
  addInput.placeholder = t("Who is it for?");
  addInput.autocomplete = "off";
  addInput.dataset.testid = "viewer-label";
  addField.append(addInput);
  const addBtn = btn("btn btn-secondary", "Make another link");
  addBtn.dataset.testid = "viewer-add";
  addBtn.addEventListener("click", async () => {
    addBtn.disabled = true;
    try {
      const made = await onAdd(addInput.value.trim().slice(0, 40) || "Help link");
      if (made) {
        addInput.value = "";
        toast("New link ready to send.");
      } else {
        toast("Could not make another link.", "warn");
      }
    } catch {
      toast("Could not make another link.", "warn");
    }
    addBtn.disabled = false;
    refresh();
  });
  ov.body.append(
    addField,
    addBtn,
    el("p", "field-note", "The label is for you. It is never sent anywhere."),
  );

  const danger = el("div", "danger-zone");
  danger.append(el("h3", "danger-title", "When you are safe"));
  const endBtn = btn("btn btn-danger-ghost", "Stop sharing with helpers");
  endBtn.dataset.testid = "help-end";
  endBtn.addEventListener("click", async () => {
    endBtn.disabled = true;
    await onEnd();
    toast("Help links switched off");
    ov.close();
  });
  danger.append(
    el("p", "ov-note", "Every link stops updating and shows that the session ended. A new SOS makes new links."),
    endBtn,
  );
  ov.body.append(danger);

  const rows = new Map();

  function refresh() {
    const viewers = api.beaconViewers();
    const seen = new Set();
    for (const v of viewers) {
      seen.add(v.id);
      let row = rows.get(v.id);
      if (!row) {
        row = viewerRow(v, { onRevoke, onChanged: refresh });
        rows.set(v.id, row);
      }
      row.update(v);
      list.append(row.node);
    }
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.node.remove();
      rows.delete(id);
    }
  }

  refresh();
  return { close: ov.close, refresh };
}

// ------------------------------------------------------------ invite sheet
//
// An invitation is a one-time credential now, not a copy of the circle key, so
// this sheet has three states: the link, the wait, and the review. The review
// is the one that matters. Accepting is what hands somebody every position the
// circle sends from that moment, so it asks for a number checked out of band
// first, and says what the answer buys.

function reviewBlock(api, req, { onChanged, onAccepted }) {
  const box = el("div", "review");
  box.dataset.testid = "join-review";
  box.dataset.member = req.memberId;
  const who = req.name || t("Someone");
  box.append(el("h3", "review-title", t("{who} wants to join", { who })));
  box.append(el("p", "ov-note", t("They chose the name {who}. Anyone can type any name, so the number below is the only part that proves who they are.", { who })));
  box.append(safetyBlock(req.safety, "join-safety"));
  box.append(
    el(
      "p",
      "ov-note",
      t("Reach {who} some way you already trust, a call or in person, and have them read the number on their screen. Every digit has to match.", { who }),
    ),
  );
  box.append(
    el(
      "p",
      "ov-note",
      "Accepting gives the whole circle new keys and lets them see everyone's location from then on. They cannot read anything sent before.",
    ),
  );
  // Accepting re-keys everyone; a phone that sleeps through it is stranded.
  // Said before the tap, to the person who can still time it better, instead
  // of after, to the person it stranded.
  const quiet = api.staleNames?.() || [];
  if (quiet.length) {
    box.append(
      el(
        "p",
        "ov-note review-stale",
        quiet.length === 1
          ? t("Heads up: {who} has not been heard from in over an hour. A phone that misses the new keys is cut off until it rejoins from a fresh invite.", { who: quiet[0] })
          : t("Heads up: {names} have not been heard from in over an hour. A phone that misses the new keys is cut off until it rejoins from a fresh invite.", { names: nameList(quiet) }),
      ),
    );
  }
  const actions = el("div", "mem-actions");
  const accept = btn("btn btn-primary btn-small", "Numbers match, let them in");
  accept.dataset.testid = "join-accept";
  const reject = btn("btn btn-danger-ghost btn-small", "Reject");
  reject.dataset.testid = "join-reject";
  actions.append(accept, reject);
  box.append(actions);

  accept.addEventListener("click", async () => {
    accept.disabled = true;
    reject.disabled = true;
    try {
      // false covers both the busy guard and an expired invitation, and both
      // have already said so out loud.
      // Accepting burns the invitation, so there is nothing left on this sheet
      // but a dead link. Get out of the way and show them the map; the accept
      // itself already says what happened.
      if (await api.acceptJoin(req)) {
        onAccepted();
        return;
      }
    } catch {
      toast("Could not let them in. Try again.", "warn");
    }
    accept.disabled = false;
    reject.disabled = false;
    onChanged();
  });
  reject.addEventListener("click", () => {
    api.rejectJoin(req);
    toast("Turned down. Your link still works for whoever it was meant for.");
    onChanged();
  });
  return box;
}

export function openInviteSheet({ api, getLink, qrSvgFor, onClose }) {
  const ov = openOverlay({
    title: "Invite someone",
    testid: "invite-sheet",
    className: "ov-invite",
    onClose,
  });

  const reviews = el("div", "review-list");
  reviews.dataset.testid = "join-reviews";

  const qrCard = el("div", "qr-card");
  qrCard.dataset.testid = "invite-qr";
  const linkRow = el("div", "link-row");
  const linkText = el("code", "invite-link");
  linkText.dataset.testid = "invite-link";
  linkRow.append(linkText);
  const share = btn("btn btn-primary", "Send the link");
  const copy = btn("btn btn-secondary btn-copy", "Copy link");
  const expiry = el("p", "field-note");
  expiry.dataset.testid = "invite-expiry";
  const waiting = el("p", "ov-note");
  waiting.dataset.testid = "invite-waiting";

  share.addEventListener("click", () => shareLink(getLink(), "Join my circle on Starling:", "Invite link copied"));
  copy.addEventListener("click", () => copyLink(getLink(), "Invite link copied"));

  ov.body.append(
    reviews,
    qrCard,
    linkRow,
    share,
    copy,
    el(
      "p",
      "ov-note",
      "Send it through something you already trust, like Signal. Whoever opens it can ask to join; they are not in until you check their number and accept.",
    ),
    expiry,
    waiting,
  );

  const danger = el("div", "danger-zone");
  danger.append(el("h3", "danger-title", "Sent it to the wrong person?"));
  const killBtn = btn("btn btn-danger-ghost", "Cancel this link");
  killBtn.dataset.testid = "invite-cancel";
  killBtn.addEventListener("click", async () => {
    killBtn.disabled = true;
    try {
      await api.burnInvite();
      toast("Link cancelled. It cannot be used now.");
      ov.close();
    } catch {
      killBtn.disabled = false;
      toast("Could not cancel the link. Try again.", "warn");
    }
  });
  danger.append(
    el("p", "ov-note", "The link stops working immediately, and any request already waiting on it is dropped. Open Invite again for a fresh one."),
    killBtn,
  );
  ov.body.append(danger);

  let shownLink = null;
  const blocks = new Map();

  function refresh() {
    const requests = api.joinRequests();
    const seen = new Set();
    for (const req of requests) {
      seen.add(req.memberId);
      if (blocks.has(req.memberId)) {
        reviews.append(blocks.get(req.memberId));
        continue;
      }
      const box = reviewBlock(api, req, { onChanged: refresh, onAccepted: () => ov.close() });
      blocks.set(req.memberId, box);
      reviews.append(box);
    }
    for (const [id, box] of blocks) {
      if (seen.has(id)) continue;
      box.remove();
      blocks.delete(id);
    }

    const link = getLink();
    if (link && link !== shownLink) {
      shownLink = link;
      // qrSvg output is generated geometry from our own encoder, not user data.
      qrCard.innerHTML = qrSvgFor(link);
      const svg = qrCard.querySelector("svg");
      svg?.setAttribute("role", "img");
      svg?.setAttribute("aria-label", t("Invite QR code"));
      linkText.textContent = link;
    }
    const inv = api.invite();
    const left = inv ? inv.expiresAt - Date.now() : 0;
    expiry.textContent = inv
      ? t("One use only, and it expires in {left}. Accepting somebody uses it up.", { left: fmtCountdown(left) })
      : t("This link is gone. Close this and tap Invite again for a new one.");
    waiting.textContent = requests.length
      ? t("Somebody is waiting on you above. The link still works until you accept.")
      : t("Nobody has used this link yet. When somebody does, their request shows up here.");
    const dead = !inv || left <= 0;
    for (const node of [linkRow, share, copy]) node.hidden = dead;
    // Somebody is waiting on a decision. Holding a QR code up to a second
    // person while the first is unanswered is how the wrong one gets in.
    qrCard.hidden = dead || requests.length > 0;
  }

  refresh();
  return { close: ov.close, refresh };
}

// ---------------------------------------------------------- settings sheet

// noteFor(value) is for the settings whose note IS the setting: the history
// window means nothing as a duration, and everything as "this is what you can
// read, and this is what a seized phone gives up".
// ---------------------------------------------------------------- status
//
// A short caption on your own dot: "omw", "here", "running late". It rides
// inside the same encrypted, padded payload as a position, so the relay
// learns nothing new from it existing.

const STATUS_CHIPS = ["On my way", "Here", "5 minutes", "Running late", "Busy"];

export function openStatusSheet({ current, onSet, onClose }) {
  const ov = openOverlay({ title: "Your status", testid: "status-sheet", onClose });
  ov.body.append(
    el("p", "ov-note", "A few words your circle sees next to your name. It is encrypted like everything else, and it clears when you stop sharing."),
  );
  const chips = el("div", "status-chips");
  for (const c of STATUS_CHIPS) {
    const b = btn("btn btn-secondary status-chip", c);
    b.addEventListener("click", () => {
      ov.close();
      // The caption sent is the words the person saw and chose, in their
      // language; the English constant is just the catalog key.
      onSet(t(c));
    });
    chips.append(b);
  }
  ov.body.append(chips);
  const field = el("label", "field");
  field.append(el("span", "field-label", "Or your own words"));
  const input = el("input", "text-input");
  input.type = "text";
  input.maxLength = 24;
  input.value = current || "";
  input.placeholder = t("at the north gate");
  input.dataset.testid = "status-input";
  field.append(input);
  const save = btn("btn btn-primary", "Set status");
  save.dataset.testid = "status-save";
  save.addEventListener("click", () => {
    const v = input.value.trim().slice(0, 24);
    ov.close();
    if (v) onSet(v);
  });
  ov.body.append(field, save);
  if (current) {
    const clear = btn("btn btn-ghost", "Clear status");
    clear.dataset.testid = "status-clear";
    clear.addEventListener("click", () => {
      ov.close();
      onSet("");
    });
    ov.body.append(clear);
  }
  return ov;
}

// ---------------------------------------------------------- check-in timer

export function openCheckinTimerSheet({ api, onStart, onCheckin, onShare, onClose }) {
  const ov = openOverlay({ title: "Check-in timer", testid: "timer-sheet", onClose });
  ov.body.append(
    el(
      "p",
      "ov-note",
      "Pick how long you need. If you have not checked in when it runs out, your circle is told, even if this phone is off by then. Only checking in stops it.",
    ),
  );
  const running = el("div", "timer-running");
  const dueLine = el("p", "timer-due");
  dueLine.dataset.testid = "timer-due";
  const checkBtn = btn("btn btn-primary", "Check in now");
  checkBtn.dataset.testid = "timer-checkin";
  checkBtn.addEventListener("click", () => onCheckin());
  running.append(dueLine, checkBtn);

  let minutes = DEFAULT_TIMER_MIN;
  const choice = segControl({
    label: "Check in within",
    options: TIMER_CHOICES_MIN.map((m) => ({ value: m, label: m < 60 ? `${m} min` : `${m / 60} h` })),
    value: minutes,
    onChange: (v) => {
      minutes = v;
    },
  });
  const start = btn("btn btn-secondary", "Start timer");
  start.dataset.testid = "timer-start";
  start.addEventListener("click", async () => {
    start.disabled = true;
    try {
      await onStart(minutes);
    } finally {
      start.disabled = false;
    }
  });

  const shareBox = el("div", "timer-share");
  const shareBtn = btn("btn btn-ghost", "Start sharing too");
  shareBtn.dataset.testid = "timer-share";
  shareBtn.addEventListener("click", () => onShare());
  shareBox.append(
    el("p", "field-note", "Sharing is off, so your circle gets the timer and the last position this phone sent, not where you are now."),
    shareBtn,
  );
  ov.body.append(running, choice, start, shareBox);

  function paint() {
    const due = api.due();
    running.hidden = !due;
    if (due) dueLine.textContent = t("Check in by {time}", { time: fmtClock(due) });
    start.className = `btn ${due ? "btn-secondary" : "btn-primary"}`;
    shareBox.hidden = api.sharing();
  }
  paint();
  return { close: ov.close, refresh: paint };
}

// Play's prominent disclosure: what, why, and that it is for nothing else, before Android asks.
export function confirmBackgroundLocation({ mode, label }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (yes) => {
      answered = true;
      resolve(yes);
      ov.close();
    };
    const ov = openOverlay({
      title: "Allow location all the time?",
      testid: "background-sheet",
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
    ov.body.append(
      el(
        "p",
        "ov-note",
        "Starling uses your location to keep sharing it with your circle after a restart or an update, even when the app is closed or not in use. Your position is encrypted on this phone before it leaves, only your circle can read it, and Starling uses it for nothing else.",
      ),
      el(
        "p",
        "ov-note",
        mode === "dialog"
          ? t("Android asks next. Choose {label}.", { label })
          : t("Android opens Starling's location settings next. Choose {label}, then come back.", { label }),
      ),
    );
    const go = btn("btn btn-primary", "Continue");
    go.dataset.testid = "background-go";
    go.addEventListener("click", () => answer(true));
    const later = btn("btn btn-ghost", "Not now");
    later.dataset.testid = "background-later";
    later.addEventListener("click", () => answer(false));
    ov.body.append(go, later);
  });
}

export function autoResumeNote(st) {
  const blocked = (line, button = null) => ({ disabled: true, button, lines: [line] });
  if (st.lock) {
    return blocked(t("Off while the app lock is on. After a restart or an update your passcode seals the circle key, so nothing can share until you unlock Starling. You get a notification with a tap to share again instead."));
  }
  if (!st.keepSharing) {
    return blocked(t("These need Keep sharing when the app is closed, because a share that comes back runs with the app closed."));
  }
  if (!st.notifications) {
    return blocked(
      t("Starling's notifications are off. A share that comes back by itself always shows one, so these stay off until notifications are on."),
      "notifications",
    );
  }
  if (st.background === "noLocation") return blocked(t("Share once first, so Android can ask for your location."));
  const lines = [];
  let button = null;
  if (st.background === "notNeeded") {
    lines.push(t("On Android 9 the location permission already covers all the time, so there is nothing more to allow."));
  } else if (st.background !== "granted") {
    lines.push(t("Android lets Starling use your location only while you use the app. Turning one of these on asks Android to allow it all the time."));
  } else if (!st.boot && !st.update) {
    lines.push(t("Android lets Starling use your location all the time, and Starling uses that for nothing while both of these are off. You can set it back to only while using the app in Android's settings."));
    button = "app";
  }
  lines.push(t("A share that comes back this way shows the sharing notification and an alert that it came back. It never brings back a share you stopped, a timed share that ran out, or anything after a panic wipe."));
  if (st.tor) {
    lines.push(t("Route through Orbot is on, so a share that comes back sends nothing until Orbot connects. If it has not connected after 5 minutes, you get a notification with a tap to share again instead."));
  }
  return { disabled: false, button, lines };
}

export function confirmTimerSwitch(circle) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (yes) => {
      answered = true;
      resolve(yes);
      ov.close();
    };
    const ov = openOverlay({
      title: "Check-in timer",
      testid: "timer-switch-sheet",
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
    ov.body.append(el("p", "ov-note", t("Your check-in timer is running in {circle}. Check in there before you switch?", { circle })));
    const go = btn("btn btn-primary", "Check in and switch");
    go.dataset.testid = "timer-switch-go";
    go.addEventListener("click", () => answer(true));
    const cancel = btn("btn btn-ghost", "Cancel");
    cancel.dataset.testid = "timer-switch-cancel";
    cancel.addEventListener("click", () => answer(false));
    ov.body.append(go, cancel);
  });
}

// ---------------------------------------------------------------- places
//
// Named spots that live only on this phone. The sheet edits the local list;
// main.js owns storage and the arrive/leave tracker. Live-refresh rebuilds
// only when the stored list actually changed, so typing a name is never
// clobbered by a poll tick.

// The complete-export sheet. Copy works on every platform; the download
// link only appears where a blob anchor genuinely lands a file (http and
// https pages), because a Save button that silently does nothing is worse
// than no button.
export function openExportSheet(json, { onClose } = {}) {
  let fileUrl = "";
  const ov = openOverlay({
    title: "Your data",
    testid: "export-sheet",
    className: "ov-export",
    onClose: () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      onClose?.();
    },
  });
  ov.body.append(
    el(
      "p",
      "ov-note",
      "Everything Starling keeps about you, on this device and nowhere else. Positions are absent because they are never stored; keys are absent on purpose.",
    ),
  );
  const pre = el("pre", "export-json");
  pre.textContent = json;
  const actions = el("div", "place-add-actions");
  const copyBtn = btn("btn btn-secondary", "Copy it all");
  copyBtn.dataset.testid = "export-copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(json);
      toast("Copied. Paste it anywhere you keep your records.");
    } catch {
      toast("Copy failed", "warn");
    }
  });
  actions.append(copyBtn);
  // The app's WebView has no download handler, so a file link there does nothing.
  if (!isBundled() && (globalThis.location?.protocol === "https:" || globalThis.location?.protocol === "http:")) {
    const dl = el("a", "btn btn-ghost");
    dl.textContent = t("Download as a file");
    dl.dataset.testid = "export-download";
    dl.download = "starling-data.json";
    fileUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    dl.href = fileUrl;
    actions.append(dl);
  }
  ov.body.append(pre, actions);
  return ov;
}

const PLACE_ALERT_CHOICES = [
  { value: "both", label: "Both" },
  { value: "arrive", label: "Arrive" },
  { value: "leave", label: "Leave" },
  { value: "off", label: "Off" },
];

export function openPlacesSheet({ api, onAdd, onPick, onRename, onRadius, onFence, onAlerts, onRemove, onClose }) {
  const ov = openOverlay({ title: "Places", testid: "places-sheet", className: "ov-places", onClose });
  const b = ov.body;

  b.append(
    el(
      "p",
      "ov-note",
      "Name the spots that matter, like Home or School, and Starling tells you when someone in your circle arrives or leaves. Places are stored only on this phone. They are never sent anywhere, and the relay cannot learn they exist.",
    ),
    el(
      "p",
      "ov-note",
      "A place with the privacy fence on shares only its center while you are inside it, never your exact spot within. Your circle still sees you are there; what they stop seeing is where in there. An SOS always sends your real position.",
    ),
  );

  const listEl = el("div", "place-list");
  const addBox = el("div", "place-add");
  b.append(listEl, addBox);

  const radiusSeg = (place) => {
    const seg = el("div", "seg seg-mini");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", t("{name} radius", { name: place.name }));
    for (const r of PLACE_RADII) {
      const cell = btn("seg-cell", fmtDistance(r));
      cell.setAttribute("role", "radio");
      cell.dataset.radius = String(r);
      const sel = place.radius === r;
      cell.classList.toggle("sel", sel);
      cell.setAttribute("aria-checked", String(sel));
      cell.addEventListener("click", () => onRadius(place.id, r));
      seg.append(cell);
    }
    return seg;
  };

  const alertsSeg = (place) => {
    const wrap = el("div", "place-alerts");
    wrap.append(el("span", "place-alerts-label", "Alerts"));
    const seg = el("div", "seg seg-mini");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", t("{name} alerts", { name: place.name }));
    const current = place.alerts ?? "both";
    for (const opt of PLACE_ALERT_CHOICES) {
      const cell = btn("seg-cell", opt.label);
      cell.setAttribute("role", "radio");
      cell.dataset.alerts = opt.value;
      const sel = current === opt.value;
      cell.classList.toggle("sel", sel);
      cell.setAttribute("aria-checked", String(sel));
      cell.addEventListener("click", () => onAlerts?.(place.id, opt.value));
      seg.append(cell);
    }
    wrap.append(seg);
    return wrap;
  };

  function placeRow(place) {
    const row = el("div", "place-row");
    row.dataset.place = place.id;
    const head = el("div", "place-row-head");
    const nameIn = el("input", "text-input place-name");
    nameIn.type = "text";
    nameIn.maxLength = MAX_NAME_LEN;
    nameIn.value = place.name;
    nameIn.setAttribute("aria-label", t("Place name"));
    nameIn.addEventListener("change", () => {
      const v = nameIn.value.trim().slice(0, MAX_NAME_LEN);
      if (v) onRename(place.id, v);
      else nameIn.value = place.name;
    });
    const rm = btn("icon-btn place-remove", "✕", t("Remove {name}", { name: place.name }));
    rm.addEventListener("click", () => onRemove(place.id));
    head.append(nameIn, rm);
    const fence = el("label", "place-fence");
    const fenceIn = document.createElement("input");
    fenceIn.type = "checkbox";
    fenceIn.className = "place-fence-check";
    fenceIn.checked = !!place.fence;
    fenceIn.setAttribute("aria-label", t("Privacy fence for {name}", { name: place.name }));
    fenceIn.addEventListener("change", () => onFence?.(place.id, fenceIn.checked));
    fence.append(fenceIn, el("span", "place-fence-text", "Privacy fence"));
    const here = el("p", "field-note place-here");
    here.dataset.testid = "place-here";
    hereEls.set(place.id, here);
    row.append(head, here, radiusSeg(place), alertsSeg(place), fence);
    return row;
  }

  const hereEls = new Map();
  function paintHere() {
    for (const [id, node] of hereEls) {
      const names = api.here?.(id) || [];
      const text = names.length ? t("Here now: {names}", { names: listNames(names) }) : "";
      if (node.textContent !== text) node.textContent = text;
      node.hidden = !text;
    }
  }

  let sig = null;
  function paint() {
    rebuild();
    paintHere();
  }

  function rebuild() {
    const places = api.places();
    const nextSig = JSON.stringify(places.map((p) => [p.id, p.name, p.radius, !!p.fence, p.alerts ?? "both"]));
    if (nextSig === sig) return;
    sig = nextSig;
    hereEls.clear();
    listEl.replaceChildren(...places.map(placeRow));
    addBox.replaceChildren();
    if (places.length >= MAX_PLACES) {
      addBox.append(el("p", "field-note", t("That is the lot: {n} places is the cap.", { n: MAX_PLACES })));
      return;
    }
    const nameField = el("label", "field");
    nameField.append(el("span", "field-label", places.length ? "Add another" : "Add your first place"));
    const nameIn = el("input", "text-input");
    nameIn.type = "text";
    nameIn.maxLength = MAX_NAME_LEN;
    nameIn.placeholder = places.length ? t("School") : t("Home");
    nameIn.dataset.testid = "place-name-input";
    nameField.append(nameIn);
    const actions = el("div", "place-add-actions");
    const takeName = () => {
      const v = nameIn.value.trim().slice(0, MAX_NAME_LEN);
      if (!v) {
        toast("Give the place a name first.", "warn");
        nameIn.focus();
        return null;
      }
      return v;
    };
    const hereBtn = btn("btn btn-secondary", "Save my current spot");
    hereBtn.dataset.testid = "place-add-here";
    hereBtn.addEventListener("click", async () => {
      const v = takeName();
      if (v) await onAdd(v);
    });
    const pickBtn = btn("btn btn-ghost", "Pick on the map");
    pickBtn.dataset.testid = "place-add-pick";
    pickBtn.addEventListener("click", () => {
      const v = takeName();
      if (!v) return;
      ov.close();
      onPick(v);
    });
    actions.append(hereBtn, pickBtn);
    addBox.append(nameField, actions);
  }
  paint();

  return { close: ov.close, refresh: paint };
}

function listNames(names) {
  if (typeof Intl.ListFormat !== "function") return names.join(", ");
  return new Intl.ListFormat(currentLocale(), { type: "conjunction" }).format(names);
}

function segControl({ label, note, noteFor, options, value, onChange }) {
  const field = el("div", "field");
  field.append(el("span", "field-label", label));
  const seg = el("div", "seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", label);
  const noteEl = note || noteFor ? el("p", "field-note", note || noteFor(value)) : null;
  const cells = [];
  for (const opt of options) {
    const b = btn("seg-cell", opt.label);
    b.setAttribute("role", "radio");
    cells.push([opt.value, b]);
    b.addEventListener("click", () => {
      for (const [v, cell] of cells) {
        cell.classList.toggle("sel", v === opt.value);
        cell.setAttribute("aria-checked", String(v === opt.value));
      }
      if (noteFor && noteEl) noteEl.textContent = noteFor(opt.value);
      onChange(opt.value);
    });
    seg.append(b);
  }
  // Also the way a setting that some OTHER control changed gets repainted: a
  // segment that disagrees with the app is a small lie about a security
  // setting, which is the kind this app cannot afford.
  field.setValue = (v) => {
    for (const [val, cell] of cells) {
      cell.classList.toggle("sel", val === v);
      cell.setAttribute("aria-checked", String(val === v));
    }
    if (noteFor && noteEl) noteEl.textContent = noteFor(v);
  };
  field.setValue(value);
  field.append(seg);
  if (noteEl) field.append(noteEl);
  return field;
}

function switchRow({ label, note, value, onChange, disabled = false }) {
  const row = el("div", "switch-row");
  const text = el("div", "switch-text");
  text.append(el("span", "switch-label", label));
  if (note) text.append(el("span", "field-note", note));
  const sw = btn("switch", null, label);
  sw.setAttribute("role", "switch");
  let on = !!value;
  const paint = () => {
    sw.setAttribute("aria-checked", String(on));
    sw.classList.toggle("on", on);
  };
  paint();
  sw.append(el("span", "switch-knob"));
  sw.addEventListener("click", () => {
    if (sw.disabled) return;
    on = !on;
    paint();
    onChange(on);
  });
  row.setValue = (v) => {
    on = !!v;
    paint();
  };
  row.setDisabled = (d) => {
    sw.disabled = !!d;
  };
  row.setDisabled(disabled);
  row.append(text, sw);
  return row;
}

// A passcode entry sheet. `confirm` requires a matching second entry (used when
// setting a new passcode). `onSubmit(passcode)` resolves true on success or
// false to keep the sheet open with an error (e.g. a wrong current passcode).
export function openPasscodeSheet({ title, intro, cta, confirm = false, current = false, minLen = 4, wrong, onSubmit, onClose }) {
  let succeeded = false;
  const ov = openOverlay({
    title,
    testid: "passcode-sheet",
    className: "ov-passcode",
    onClose: () => onClose?.(succeeded),
  });
  if (intro) ov.body.append(el("p", "ov-note", intro));

  function pcField(labelText, testid) {
    const f = el("label", "field");
    f.append(el("span", "field-label", labelText));
    const i = el("input", "text-input");
    i.type = "password";
    i.inputMode = "numeric";
    i.autocomplete = "off";
    i.dataset.testid = testid;
    i.setAttribute("aria-label", t(labelText));
    f.append(i);
    ov.body.append(f);
    return i;
  }

  const curIn = current ? pcField("Current passcode", "passcode-current") : null;
  const newIn = pcField(current ? "New passcode" : "Passcode", "passcode-input");
  const confIn = confirm ? pcField("Confirm passcode", "passcode-confirm") : null;

  const err = el("p", "ov-warn-note", "");
  err.setAttribute("role", "alert");
  err.hidden = true;
  ov.body.append(err);

  const submit = btn("btn btn-primary", cta || "Save");
  submit.dataset.testid = "passcode-save";
  let busy = false;
  const fail = (m) => {
    err.textContent = t(m);
    err.hidden = false;
  };
  submit.addEventListener("click", async () => {
    if (busy) return;
    const pc = newIn.value;
    if (pc.length < minLen) return fail(t("Use at least {n} characters.", { n: minLen }));
    if (confIn && confIn.value !== pc) return fail("The two passcodes do not match.");
    busy = true;
    submit.disabled = true;
    try {
      const ok = await onSubmit(current ? { current: curIn.value, next: pc } : pc);
      if (ok) {
        succeeded = true;
        ov.close();
      } else {
        fail(current ? t("That current passcode is wrong.") : wrong || t("Could not save. Try again."));
        busy = false;
        submit.disabled = false;
      }
    } catch {
      fail("Something went wrong. Try again.");
      busy = false;
      submit.disabled = false;
    }
  });
  ov.body.append(submit);
  (curIn || newIn).focus();
  return ov;
}

export function openSettingsSheet({ api, values, demo, tor, keepSharing, autoResume, shareClock, background, forward, lock, lockActions, onChange, onMembers, onInvite, onPlaces, onPanic, onLeave, onExport, onClose }) {
  const ov = openOverlay({ title: "Settings", testid: "settings-sheet", className: "ov-settings", onClose });
  const b = ov.body;

  const group = (title) => {
    const g = el("section", "set-group");
    g.append(el("h3", "set-title", title));
    b.append(g);
    return g;
  };

  // Circle
  const gCircle = group("Circle");
  const cnField = el("label", "field");
  cnField.append(el("span", "field-label", "Circle name"));
  const cn = el("input", "text-input");
  cn.type = "text";
  cn.maxLength = 24;
  cn.value = values.circleName;
  cn.placeholder = t("My circle");
  cn.addEventListener("change", () => {
    const name = cn.value.trim().slice(0, 24);
    onChange("circleName", name);
    paintShareFor(name);
  });
  cnField.append(cn);
  const inviteBtn = btn("btn btn-secondary", "Invite people");
  inviteBtn.dataset.testid = "invite-open";
  inviteBtn.addEventListener("click", onInvite);
  gCircle.append(cnField, inviteBtn);
  if (demo) {
    inviteBtn.disabled = true;
    gCircle.append(el("p", "field-note", "Exit the demo to invite your people."));
  }

  // Keys and history. Both settings here are the trade v2 exists to let a
  // person make, so they sit next to the actions that change keys instead of
  // in a list of preferences where they read as housekeeping.
  let historyField = null;
  let steadyRow = null;
  if (!demo) {
    const gKeys = group("Keys and history");
    const peopleBtn = btn("btn btn-secondary", "People and keys");
    peopleBtn.dataset.testid = "members-open-settings";
    peopleBtn.addEventListener("click", () => {
      ov.close();
      onMembers();
    });
    gKeys.append(
      peopleBtn,
      el("p", "field-note", "Everyone in this circle, their safety numbers, and who you have checked."),
    );

    const rekeyBtn = btn("btn btn-secondary", "New keys now");
    rekeyBtn.dataset.testid = "rekey-open";
    const rekeyBox = el("div", "confirm-box");
    rekeyBox.hidden = true;
    rekeyBox.append(
      el(
        "p",
        "ov-note",
        "Everyone in the circle gets a fresh key and the old one stops working, so anybody holding a copy of the old one goes dark. Do this if a phone in the circle was taken, unlocked, or handed over. Nobody is removed and nothing on your map disappears.",
      ),
    );
    const rekeyQuiet = api.staleNames?.() || [];
    if (rekeyQuiet.length) {
      rekeyBox.append(
        el(
          "p",
          "ov-note review-stale",
          rekeyQuiet.length === 1
            ? t("Heads up: {who} has not been heard from in over an hour and may miss the new keys. A phone that misses them is cut off until it rejoins from a fresh invite.", { who: rekeyQuiet[0] })
            : t("Heads up: {names} have not been heard from in over an hour and may miss the new keys. A phone that misses them is cut off until it rejoins from a fresh invite.", { names: nameList(rekeyQuiet) }),
        ),
      );
    }
    const rekeyGo = btn("btn btn-primary", "Make new keys");
    rekeyGo.dataset.testid = "rekey-confirm";
    rekeyGo.addEventListener("click", async () => {
      rekeyGo.disabled = true;
      try {
        // false is a busy guard or a re-key that could not reach anyone, both
        // of which have already said so; claiming success here would be a lie
        // about the one thing this button exists to do.
        if (await api.rekeyCircle()) {
          toast("Your circle has new keys.");
          rekeyBox.hidden = true;
        }
      } catch {
        toast("Could not make new keys. Try again.", "warn");
      }
      rekeyGo.disabled = false;
    });
    rekeyBox.append(rekeyGo);
    rekeyBtn.addEventListener("click", () => {
      rekeyBox.hidden = !rekeyBox.hidden;
      if (!rekeyBox.hidden) rekeyBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    gKeys.append(rekeyBtn, rekeyBox);

    const choices = api.historyChoices;
    const historyNote = (id) => {
      const c = choices.find((x) => x.id === id) || choices[0];
      return c.epochs <= 1
        ? t("You can see the last {window} of your circle. A phone taken from you gives up almost nothing.", { window: t(c.label) })
        : t("You can see the last {window} of your circle. A phone taken from you gives up that same {window}, and nothing older.", { window: t(c.label) });
    };
    historyField = segControl({
      label: "How far back you can see",
      noteFor: historyNote,
      options: choices.map((c) => ({ value: c.id, label: c.label })),
      value: values.settings.history,
      onChange: (v) => onChange("history", v),
    });
    steadyRow = switchRow({
      label: "Steady sending",
      note: "Send on the timer even when you have not moved. The relay cannot read a position either way, but a burst of updates while you walk and silence while you sit is a movement trail made of timing alone. This hides that, and costs a little battery.",
      value: values.settings.steady,
      onChange: (v) => onChange("steady", v),
    });
    gKeys.append(
      historyField,
      el(
        "p",
        "field-note",
        "Keys older than this window are destroyed on this device and cannot be brought back, by you or by anyone holding the phone.",
      ),
      steadyRow,
    );
  }

  // You
  const gYou = group("You");
  const nameField = el("label", "field");
  nameField.append(el("span", "field-label", "Your name"));
  const nameIn = el("input", "text-input");
  nameIn.type = "text";
  nameIn.maxLength = 24;
  nameIn.value = values.profile.name;
  nameIn.addEventListener("change", () => {
    const v = nameIn.value.trim().slice(0, 24);
    if (v) onChange("name", v);
  });
  nameField.append(nameIn);
  const grid = emojiGrid(values.profile.emoji);
  grid.addEventListener("click", () => onChange("emoji", grid.value()));
  gYou.append(nameField, grid);

  // Sharing. Precision and cadence are the circle's, so the group says which.
  const gShare = group("Sharing");
  const shareFor = el("p", "field-note");
  shareFor.dataset.testid = "share-for-circle";
  const paintShareFor = (name) => {
    shareFor.textContent = t("For {name}. Each circle keeps its own precision and timing.", { name: demo ? t("Demo circle") : circleLabel(name) });
  };
  paintShareFor(values.circleName);
  const precisionField = segControl({
    label: "Precision",
    options: [
      { value: "precise", label: "Precise" },
      { value: "coarse", label: "Neighborhood" },
    ],
    value: values.share.precision,
    onChange: (v) => onChange("precision", v),
  });
  const precisionNote = el("p", "field-note");
  precisionNote.dataset.testid = "precision-note";
  const paintPrecisionNote = () => {
    precisionNote.textContent =
      getUnits() === "imperial"
        ? t("Neighborhood rounds your position to about half a mile on your device before it is encrypted")
        : t("Neighborhood rounds your position to about 1 km on your device before it is encrypted");
  };
  paintPrecisionNote();
  precisionField.append(precisionNote);
  gShare.append(
    shareFor,
    precisionField,
    segControl({
      label: "Send every",
      note: "How often your circle hears from you while you stay put. Moving sends sooner unless Steady sending is on. Slower is easier on the battery. An SOS always goes every 15 seconds.",
      options: [
        { value: 15, label: "15 s" },
        { value: 60, label: "1 min" },
        { value: 300, label: "5 min" },
      ],
      value: values.share.cadence,
      onChange: (v) => onChange("cadence", v),
    }),
    switchRow({
      label: "Trail history",
      note: "Show recent paths on the map",
      value: values.settings.trail,
      onChange: (v) => onChange("trail", v),
    }),
  );

  // Wrapper only: on the web there is no process to hold open, and sharing is
  // app-only anyway.
  if (keepSharing) {
    const row = switchRow({
      label: "Keep sharing when the app is closed",
      note: "Sharing normally stops when you swipe Starling out of recents, because the keys that encrypt each position live in the app. With this on, Starling stays loaded in the background until the share ends, so closing it does not stop it. Anyone holding your unlocked phone can see the app is still running, and it is still holding your keys, so the app lock cannot protect them until the share ends.",
      value: keepSharing.enabled,
      onChange: (v) => onChange("keepSharing", v),
    });
    row.dataset.testid = "settings-keep-sharing";
    gShare.append(row);
  }

  // Repainted on refresh: the grant and notification settings change in system screens.
  let paintAutoResume = null;
  if (autoResume) {
    const box = el("div", "set-background");
    box.dataset.testid = "settings-auto-resume";
    const rows = {};
    const toggle = (which) => (v) => {
      autoResume
        .onToggle(which, v)
        .then((stored) => rows[which].setValue(stored))
        .catch(() => {})
        .finally(() => paintAutoResume(true));
    };
    rows.boot = switchRow({
      label: "Also after a restart",
      note: "If the phone restarts while you are sharing, Starling starts sharing again by itself once the phone has been unlocked, without being opened.",
      value: false,
      onChange: toggle("boot"),
    });
    rows.boot.dataset.testid = "settings-auto-boot";
    rows.update = switchRow({
      label: "Also after an update",
      note: "If Starling updates while you are sharing, it starts sharing again by itself, without being opened.",
      value: false,
      onChange: toggle("update"),
    });
    rows.update.dataset.testid = "settings-auto-update";
    const status = el("div", "set-background");
    let painted = "";
    paintAutoResume = (force = false) => {
      const st = autoResume.read();
      const note = autoResumeNote(st);
      const key = JSON.stringify([st.boot, st.update, note]);
      if (key === painted && !force) return;
      painted = key;
      for (const which of ["boot", "update"]) {
        rows[which].setValue(st[which]);
        // A switch that is on can always be turned off.
        rows[which].setDisabled(note.disabled && !st[which]);
      }
      const kids = note.lines.map((line) => el("p", "field-note", line));
      if (note.button === "notifications") {
        const open = btn("btn btn-secondary", "Open notification settings");
        open.dataset.testid = "settings-auto-notifications";
        open.addEventListener("click", () => autoResume.onOpenNotifications());
        kids.push(open);
      } else if (note.button === "app") {
        const open = btn("btn btn-secondary", "Open app settings");
        open.dataset.testid = "settings-auto-app";
        open.addEventListener("click", () => autoResume.onOpenApp());
        kids.push(open);
      }
      status.replaceChildren(...kids);
    };
    paintAutoResume();
    box.append(rows.boot, rows.update, status);
    gShare.append(box);
  }

  if (shareClock) {
    const row = switchRow({
      label: "Show the time on the sharing notification",
      note: "Time left on a timed share, or how long you have been sharing. Your lock screen shows it too, unless Android is set to hide sensitive notification content.",
      value: shareClock.enabled,
      onChange: (v) => onChange("shareClock", v),
    });
    row.dataset.testid = "settings-share-clock";
    gShare.append(row);
  }

  if (typeof native()?.remindShareIn === "function") {
    const remind = segControl({
      label: "Remind me if sharing stays off",
      note: "If you stop sharing and do not turn it back on, this phone shows a notification after that long. Nothing goes to your circle.",
      options: [
        { value: 0, label: "Never" },
        { value: 3_600_000, label: "1 h" },
        { value: 4 * 3_600_000, label: "4 h" },
        { value: 12 * 3_600_000, label: "12 h" },
      ],
      value: values.settings.shareReminder || 0,
      onChange: (v) => onChange("shareReminder", v),
    });
    remind.dataset.testid = "settings-share-reminder";
    gShare.append(remind);
  }

  // Repainted on refresh: the change happens in a system screen with this sheet open.
  let paintBackground = null;
  if (background) {
    const box = el("div", "field");
    box.dataset.testid = "settings-background";
    box.append(el("span", "field-label", "Running in the background"));
    const status = el("div", "set-background");
    let painted = null;
    paintBackground = () => {
      const mode = background.state();
      if (mode === painted) return;
      painted = mode;
      const note =
        mode === "unrestricted"
          ? t("Unrestricted. Android lets Starling keep a share going with the screen off.")
          : mode === "restricted"
            ? t("Restricted. Android stops Starling about a minute after you leave it, and a share stops with it. Set battery use to Unrestricted in the app's settings.")
            : t("Optimized. Android may pause Starling to save battery while the screen is off, which can stop your circle seeing you move. Allowing it to run in the background prevents that.");
      const kids = [el("p", "field-note", note)];
      if (mode === "optimized") {
        const allow = btn("btn btn-secondary", "Allow background running");
        allow.dataset.testid = "settings-battery-allow";
        allow.addEventListener("click", () => background.onAllow());
        kids.push(allow);
      } else if (mode === "restricted") {
        const open = btn("btn btn-secondary", "Open app settings");
        open.dataset.testid = "settings-battery-open";
        open.addEventListener("click", () => background.onOpen());
        kids.push(open);
      }
      status.replaceChildren(...kids);
    };
    paintBackground();
    box.append(status);
    const report = btn("btn btn-secondary", "Copy sharing report");
    report.dataset.testid = "settings-share-report";
    report.addEventListener("click", () => background.onCopyReport());
    box.append(
      report,
      el(
        "p",
        "field-note",
        "For a bug report: versions, permissions, battery settings and counts. It has no locations, no keys and no names in it.",
      ),
    );
    gShare.append(box);
  }

  // Once saved only the host shows: the address can carry a key.
  if (forward) {
    const box = el("div", "field");
    box.dataset.testid = "settings-forward";
    box.append(el("span", "field-label", "Your own server"));
    const shown = el("div", "set-forward");
    const input = el("input", "text-input");
    input.type = "url";
    input.placeholder = "https://your-server/owntracks?api_key=...";
    input.autocomplete = "off";
    input.dataset.testid = "forward-input";
    const save = btn("btn btn-secondary", "Save");
    save.dataset.testid = "forward-save";
    const stop = btn("btn btn-secondary", "Stop sending");
    stop.dataset.testid = "forward-stop";
    const tidInput = el("input", "text-input");
    tidInput.type = "text";
    tidInput.maxLength = 64;
    tidInput.placeholder = t("Tracker ID, like phone1 (optional)");
    tidInput.autocomplete = "off";
    tidInput.dataset.testid = "forward-tid-input";
    const tidSave = btn("btn btn-secondary", "Set tracker ID");
    tidSave.dataset.testid = "forward-tid-save";
    const paint = () => {
      const st = forward.status();
      const kids = [];
      if (st?.host) {
        kids.push(el("p", "field-note", t("While you share, your position also goes to {host}.", { host: st.host })));
        if (st.tor) kids.push(el("p", "field-note", "Paused while Tor mode is on, so nothing leaves this phone outside Tor."));
        else if (st.last >= 200 && st.last < 300) kids.push(el("p", "field-note", "The last send worked."));
        else if (st.last === -1) kids.push(el("p", "field-note", "The last send failed: the server did not answer."));
        else if (st.last > 0) kids.push(el("p", "field-note", t("The last send failed: the server answered {code}.", { code: st.last })));
        if (st.tid) kids.push(el("p", "field-note", t("Sent with the tracker ID {tid}.", { tid: st.tid })));
      }
      shown.replaceChildren(...kids);
      stop.hidden = !st?.host;
      tidInput.hidden = tidSave.hidden = !st?.host || !forward.onTid;
    };
    save.addEventListener("click", async () => {
      if (await forward.onSave(input.value)) {
        input.value = "";
        paint();
      }
    });
    stop.addEventListener("click", async () => {
      if (await forward.onStop()) paint();
    });
    tidSave.addEventListener("click", async () => {
      if (await forward.onTid?.(tidInput.value)) {
        tidInput.value = "";
        paint();
      }
    });
    paint();
    box.append(
      shown,
      input,
      save,
      stop,
      tidInput,
      tidSave,
      el(
        "p",
        "field-note",
        "Sends your own position in OwnTracks format to a server you run, like Reitti, Dawarich or Home Assistant, only while you share. It goes straight from this phone, never through the relay, and your circle's positions never go there. The server gets your precise position whatever the precision setting. With the app lock on, changing it needs your passcode.",
      ),
      el(
        "p",
        "field-note",
        "A tracker ID goes out as tid with each position, so a forwarder or Home Assistant can tell this phone apart.",
      ),
    );
    gShare.append(box);
  }

  // Alerts
  const gAlerts = group("Places and alerts");
  const placesBtn = btn("btn btn-secondary", "Places");
  placesBtn.dataset.testid = "places-open-settings";
  placesBtn.addEventListener("click", () => {
    ov.close();
    onPlaces();
  });
  gAlerts.append(
    placesBtn,
    el("p", "field-note", "Name the spots that matter and hear about arrivals. Places never leave this phone."),
    switchRow({
      label: "Arrive and leave alerts",
      note: "Tell me when someone in the circle reaches a place or leaves one",
      value: values.settings.placeAlerts,
      onChange: (v) => onChange("placeAlerts", v),
    }),
    switchRow({
      label: "Low battery alerts",
      note: "Tell me when a member's phone drops under 15 percent, before their dot goes dark",
      value: values.settings.batAlerts,
      onChange: (v) => onChange("batAlerts", v),
    }),
  );
  if (typeof native()?.openSosChannelSettings === "function") {
    const box = el("div", "field");
    box.dataset.testid = "settings-sos-dnd";
    const open = btn("btn btn-secondary", "Open emergency alert settings");
    open.dataset.testid = "settings-sos-dnd-open";
    open.addEventListener("click", () => {
      try {
        native()?.openSosChannelSettings?.();
      } catch {
        // the system screen is missing on this phone; nothing else to offer
      }
    });
    box.append(
      el("span", "field-label", "SOS and Do Not Disturb"),
      el(
        "p",
        "field-note",
        "An SOS from your circle rings through Do Not Disturb when alarms are allowed. To let it through total silence too, turn on Override Do Not Disturb for Emergency alerts.",
      ),
      open,
    );
    gAlerts.append(box);
  }

  // Map
  const gMap = group("Map");
  gMap.append(
    segControl({
      label: "Basemap",
      note: "Street maps load tiles from OpenStreetMap, which sees your map viewport. Off-grid loads nothing.",
      options: [
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
        { value: "none", label: "Off-grid" },
      ],
      value: values.settings.basemap,
      onChange: (v) => onChange("basemap", v),
    }),
    segControl({
      label: "Theme",
      options: [
        { value: "auto", label: "Auto" },
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
      ],
      value: values.settings.theme,
      onChange: (v) => onChange("theme", v),
    }),
    segControl({
      label: "Language",
      note: "English is the app's source language. Translations come from the community; rough edges are worth reporting.",
      options: LOCALE_CHOICES.map((c) => ({ value: c.id, label: c.label })),
      value: values.settings.lang,
      onChange: (v) => onChange("lang", v),
    }),
    segControl({
      label: "Distance units",
      options: [
        { value: "auto", label: "Auto" },
        { value: "metric", label: "Kilometers" },
        { value: "imperial", label: "Miles" },
      ],
      value: values.settings.units || "auto",
      onChange: (v) => onChange("units", v),
    }),
    switchRow({
      label: "Keep screen awake",
      note: "Holds the screen on while the map is open",
      value: values.settings.wakeLock,
      onChange: (v) => onChange("wakeLock", v),
    }),
  );

  // App lock
  if (lock && !demo) {
    const gLock = group("App lock");
    const lockRow = switchRow({
      label: "Require passcode",
      note: "Encrypts your circle secret on this device. Nobody can open Starling, or read the secret from storage, without your passcode.",
      value: lock.enabled,
      onChange: (on) => {
        // The switch paints optimistically; if the passcode sheet is dismissed
        // without finishing, snap it back to the real lock state so it never
        // shows ON over an off lock (a false security promise).
        const sw = lockRow.querySelector(".switch");
        const revert = (succeeded) => {
          if (succeeded) return;
          sw.classList.toggle("on", lock.enabled);
          sw.setAttribute("aria-checked", String(lock.enabled));
        };
        if (on) {
          openPasscodeSheet({
            title: "Set a passcode",
            intro: "Choose a passcode to lock Starling on this device. There is no reset: if you forget it, you have to erase this device and rejoin from an invite.",
            cta: "Turn on app lock",
            confirm: true,
            onClose: revert,
            onSubmit: async (pc) => {
              if ((await lockActions.enable(pc)) === false) return false;
              toast("App lock is on.");
              ov.close();
              return true;
            },
          });
        } else {
          openPasscodeSheet({
            title: "Turn off app lock",
            intro: "Enter your passcode to stop encrypting the circle secret at rest.",
            cta: "Turn off app lock",
            onClose: revert,
            onSubmit: async (pc) => {
              const ok = await lockActions.disable(pc);
              if (ok) {
                toast("App lock is off.");
                ov.close();
              }
              return ok;
            },
          });
        }
      },
    });
    gLock.append(lockRow);

    if (lock.enabled) {
      const changeBtn = btn("btn btn-secondary", "Change passcode");
      changeBtn.dataset.testid = "passcode-change";
      changeBtn.addEventListener("click", () =>
        openPasscodeSheet({
          title: "Change passcode",
          cta: "Change passcode",
          current: true,
          confirm: true,
          onSubmit: async ({ current, next }) => {
            const ok = await lockActions.change(current, next);
            if (ok) toast("Passcode changed.");
            return ok;
          },
        }),
      );
      gLock.append(changeBtn);

      if (lock.bioAvailable || lock.hasBio) {
        gLock.append(
          switchRow({
            label: "Unlock with biometrics",
            note: "Use this device's Face ID, fingerprint, or Windows Hello to unlock. Your passcode still works as backup.",
            value: lock.hasBio,
            onChange: async (on) => {
              if (on) {
                const ok = await lockActions.enableBio();
                toast(ok ? "Biometric unlock is on." : "Your device or browser could not set up biometric unlock.", ok ? "info" : "warn");
                if (!ok) ov.close();
              } else {
                await lockActions.disableBio();
                toast("Biometric unlock is off.");
              }
            },
          }),
        );
      }

      const duressBtn = btn(
        "btn btn-secondary",
        lock.hasDuress ? "Change duress passcode" : "Set a duress passcode",
      );
      duressBtn.dataset.testid = "duress-set";
      duressBtn.addEventListener("click", () =>
        openPasscodeSheet({
          title: lock.hasDuress ? "Change duress passcode" : "Set a duress passcode",
          intro:
            "A second passcode for a moment when someone makes you open Starling. Entering it on the lock screen erases everything on this device, instantly and silently, and shows a fresh install. There is no undo and no way back in. It only guards the passcode path: biometric unlock still opens the app normally, so if a forced unlock is in your threat model, turn biometrics off too.",
          cta: "Save duress passcode",
          confirm: true,
          onSubmit: async (pc) => {
            const ok = await lockActions.setDuress(pc);
            if (ok) {
              toast("Duress passcode saved.");
              ov.close();
            }
            return ok;
          },
        }),
      );
      gLock.append(
        duressBtn,
        el(
          "p",
          "field-note",
          "Anyone who checks this phone's storage can see that a duress code exists, though not what it is. What they cannot do is tell it apart from your real passcode while typing.",
        ),
      );
      if (lock.hasDuress) {
        const duressOff = btn("btn btn-ghost", "Remove duress passcode");
        duressOff.dataset.testid = "duress-remove";
        duressOff.addEventListener("click", async () => {
          await lockActions.clearDuress();
          toast("Duress passcode removed.");
          ov.close();
        });
        gLock.append(duressOff);
      }

      gLock.append(
        segControl({
          label: "Auto-lock",
          note: "Relock after the app has been in the background this long. Locking ends a share unless Keep sharing when the app is closed is on.",
          options: [
            { value: "0", label: "Now" },
            { value: "60000", label: "1 min" },
            { value: "300000", label: "5 min" },
            { value: "3600000", label: "1 hr" },
          ],
          value: String(lock.autolockMs),
          onChange: (v) => lockActions.setAutolock(Number(v)),
        }),
      );
    }
  }

  // Advanced. The relay field arrives null outside the wrapper (the web CSP
  // could never reach a foreign relay), so the group only renders where its
  // contents can work.
  if (!demo && (values.relay != null || tor)) {
    const gAdv = group("Advanced");
    if (values.relay != null) {
      const relayField = el("label", "field");
      relayField.append(el("span", "field-label", "Relay"));
      const relayIn = el("input", "text-input");
      relayIn.type = "url";
      relayIn.placeholder = "https://starlingmap.app";
      relayIn.autocomplete = "off";
      relayIn.value = values.relay || "";
      relayIn.dataset.testid = "relay-input";
      relayIn.addEventListener("change", () => onChange("relay", relayIn.value));
      relayField.append(relayIn);
      gAdv.append(
        relayField,
        el("p", "field-note", "Point Starling at your own relay if you run one. The relay source ships with the app, so anyone can host it. Leave this empty for the default. A change applies the next time Starling starts."),
      );
    }
    if (tor) {
      gAdv.append(
        switchRow({
          label: "Route through Orbot",
          note: "Sends relay and map traffic through Orbot's Tor proxy on this device. Needs Orbot installed with Power User Mode on. Orbot's per-app VPN mode also covers Starling with this off.",
          value: tor.enabled,
          onChange: (v) => onChange("tor", v),
        }),
      );
    }
  }

  // Danger
  if (onExport && !demo) {
    const gData = group("Your data");
    const expBtn = btn("btn btn-secondary", "See everything Starling has");
    expBtn.dataset.testid = "settings-export";
    expBtn.addEventListener("click", onExport);
    gData.append(
      el(
        "p",
        "field-note",
        "One readable file: profile, settings, places, circle names, who you trust. No positions, because Starling stores none, and no keys, ever.",
      ),
      expBtn,
    );
  }

  const gDanger = group("Danger zone");
  gDanger.classList.add("danger-zone");
  if (onLeave && !demo) {
    const leaveBtn = btn("btn btn-danger-ghost", "Leave this circle");
    leaveBtn.dataset.testid = "settings-leave";
    const leaveBox = el("div", "confirm-box");
    leaveBox.hidden = true;
    leaveBox.append(
      el("p", "ov-note", "Leaving deletes this circle's secret and your identity in it from this device. The circle itself keeps existing for everyone else, and you can come back with a fresh invite. Type \"leave\" to confirm."),
    );
    const leaveInput = el("input", "text-input");
    leaveInput.type = "text";
    leaveInput.placeholder = t("Type \"leave\"");
    leaveInput.autocomplete = "off";
    const leaveGo = btn("btn btn-danger", "Leave circle");
    leaveGo.dataset.testid = "settings-leave-confirm";
    leaveGo.disabled = true;
    leaveInput.addEventListener("input", () => {
      leaveGo.disabled = leaveInput.value.trim().toLowerCase() !== "leave";
    });
    leaveGo.addEventListener("click", async () => {
      leaveGo.disabled = true;
      try {
        if ((await onLeave()) === false) {
          leaveGo.disabled = false;
          return;
        }
        ov.close();
      } catch {
        leaveGo.disabled = false;
        toast("Could not leave. Try again.", "warn");
      }
    });
    leaveBox.append(leaveInput, leaveGo);
    leaveBtn.addEventListener("click", () => {
      leaveBox.hidden = !leaveBox.hidden;
      if (!leaveBox.hidden) {
        leaveInput.focus();
        leaveBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
    gDanger.append(leaveBtn, leaveBox);
  }
  const panicBtn = btn("btn btn-danger-ghost", "Panic wipe");
  panicBtn.dataset.testid = "settings-panic";
  const panicBox = el("div", "confirm-box");
  panicBox.hidden = true;
  panicBox.append(
    el("p", "ov-note", "Erases the circle secret, your identity, and all Starling data from this device, then reloads. One residual: street-map tiles your browser cached may remain in its own cache. The Off-grid basemap never loads any. There is no undo. Hold the button to confirm."),
  );
  const holdBtn = btn("btn btn-danger btn-hold", "Hold to erase everything");
  holdToFire(holdBtn, { ms: 1500, onFire: onPanic });
  panicBox.append(holdBtn);
  panicBtn.addEventListener("click", () => {
    panicBox.hidden = !panicBox.hidden;
    if (!panicBox.hidden) panicBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  gDanger.append(panicBtn, panicBox);

  // About
  const gAbout = group("About");
  const outLink = (text, href) => {
    const a = document.createElement("a");
    a.textContent = text;
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  };
  const credit = el("p", "about-credit");
  credit.dataset.testid = "about-credit";
  const [madeBy, madeAfter = ""] = t("Made by {name}").split("{name}");
  credit.append(
    madeBy,
    outLink(AUTHOR.name, AUTHOR.url),
    madeAfter,
    " \u00b7 ",
    outLink(t("Source code"), "https://github.com/munzzyy/starling"),
  );
  gAbout.append(
    el("p", "about-version", `Starling ${VERSION}`),
    credit,
    el("p", "ov-note", "Your positions are encrypted on this device with a key only your circle holds. There are no accounts, no phone numbers, and no server that can read where you are. Sharing is off until you turn it on, and stopping is one tap."),
    el("p", "ov-note", "The relay that passes your updates along stores only encrypted data it cannot read, and deletes it after 24 hours. The protocol is open, so anyone can check these claims against the code."),
  );

  // The high-risk history window switches steady sending on by itself, so the
  // two controls have to be able to hear about each other.
  return {
    close: ov.close,
    refresh: () => {
      historyField?.setValue(api.state.settings.history);
      steadyRow?.setValue(api.state.settings.steady);
      paintBackground?.();
      paintPrecisionNote();
      paintAutoResume?.();
    },
  };
}

// ------------------------------------------------------------ bottom sheet

export function createSheet(sheetEl, dragEl, bodyEl, { onSnap } = {}) {
  let snap = "peek";
  let dragging = false;
  let untrap = null;
  const H = () => window.innerHeight;

  const peekH = () => dragEl.offsetHeight + 8;
  // The drag region grows when the avatar strip fills in; re-apply so the
  // peek snap never clips content that appeared after the last measure.
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      if (!dragging && snap === "peek") apply(false);
    }).observe(dragEl);
  }
  function heightFor(name) {
    if (name === "peek") return Math.min(peekH(), Math.round(H() * 0.72));
    if (name === "half") return Math.round(H() * 0.56);
    return H() - 76;
  }

  function apply(animate = true) {
    if (dragging) return;
    sheetEl.classList.toggle("no-anim", !animate);
    const visible = heightFor(snap);
    sheetEl.style.transform = `translateY(${Math.max(0, H() - visible)}px)`;
    sheetEl.classList.toggle("sheet-full", snap === "full");
    sheetEl.classList.toggle("sheet-peek", snap === "peek");
    bodyEl.style.height =
      snap === "peek" ? "0px" : `${Math.max(0, visible - dragEl.offsetHeight - 8)}px`;
    bodyEl.style.overflowY = snap === "peek" ? "hidden" : "auto";
    // At peek the body is clipped to zero height; keep its member cards and
    // nudges out of the tab order and the accessibility tree until expanded.
    // inert is the clean tool; where it is missing, hide from AT and drop the
    // whole subtree out of tab order the portable way.
    const hasInert = "inert" in HTMLElement.prototype;
    if (snap === "peek") {
      bodyEl.setAttribute("aria-hidden", "true");
      if (hasInert) bodyEl.inert = true;
      else setTabbable(bodyEl, false);
    } else {
      bodyEl.removeAttribute("aria-hidden");
      if (hasInert) bodyEl.inert = false;
      else setTabbable(bodyEl, true);
    }
    // Overflow clips at the padding box, so bottom padding would leak a
    // sliver of the first card at peek.
    bodyEl.style.paddingBottom = snap === "peek" ? "0px" : "";
    document.documentElement.style.setProperty("--peek", `${peekH()}px`);
    if (snap === "full") {
      sheetEl.setAttribute("role", "dialog");
      sheetEl.setAttribute("aria-modal", "true");
      if (!untrap) untrap = trapFocus(sheetEl, { autofocus: false });
    } else {
      sheetEl.removeAttribute("role");
      sheetEl.removeAttribute("aria-modal");
      untrap?.();
      untrap = null;
    }
    dragEl.querySelector(".grabber")?.setAttribute("aria-expanded", String(snap !== "peek"));
    if (!animate) requestAnimationFrame(() => sheetEl.classList.remove("no-anim"));
    onSnap?.(snap);
  }

  // Drag from the header zone only; buttons inside it still tap normally.
  let startY = 0;
  let startVisible = 0;
  let lastY = 0;
  let lastT = 0;
  let vel = 0;
  let dragMoved = false;

  // Click (keyboard, screen reader double-tap, or a plain tap on the bar)
  // toggles between peek and half; a click that was really the tail of a
  // drag is ignored, the drag already picked its snap.
  const grab = dragEl.querySelector(".grabber");
  grab?.addEventListener("click", () => {
    if (dragMoved) {
      dragMoved = false;
      return;
    }
    snap = snap === "peek" ? "half" : "peek";
    apply(true);
  });

  dragEl.addEventListener("pointerdown", (e) => {
    // Buttons in the header still tap normally; the grabber is a button too
    // now (for keyboard and screen readers) but stays a drag handle.
    if (e.target.closest("button:not(.grabber), input, a")) return;
    dragging = true;
    dragMoved = false;
    dragEl.setPointerCapture(e.pointerId);
    sheetEl.classList.add("no-anim");
    startY = lastY = e.clientY;
    lastT = performance.now();
    startVisible = H() - new DOMMatrixReadOnly(getComputedStyle(sheetEl).transform).f;
    vel = 0;
  });
  dragEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    if (Math.abs(e.clientY - startY) > 6) dragMoved = true;
    const now = performance.now();
    if (now > lastT) vel = (e.clientY - lastY) / (now - lastT);
    lastY = e.clientY;
    lastT = now;
    const visible = Math.min(heightFor("full"), Math.max(120, startVisible + (startY - e.clientY)));
    sheetEl.style.transform = `translateY(${H() - visible}px)`;
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    sheetEl.classList.remove("no-anim");
    const visible = startVisible + (startY - e.clientY);
    const projected = visible - vel * 160;
    let best = "peek";
    let bestDist = Infinity;
    for (const name of ["peek", "half", "full"]) {
      const d = Math.abs(heightFor(name) - projected);
      if (d < bestDist) {
        bestDist = d;
        best = name;
      }
    }
    snap = best;
    apply(true);
  }
  dragEl.addEventListener("pointerup", endDrag);
  dragEl.addEventListener("pointercancel", endDrag);

  window.addEventListener("resize", () => apply(false));

  return {
    snapTo(name, animate = true) {
      snap = name;
      apply(animate);
    },
    getSnap: () => snap,
    recompute: () => apply(false),
  };
}

// ------------------------------------------------------------ member cards

const CHIP_TEXT = { live: "Live", sos: "SOS", overdue: "Missed check-in", checkin: "Checked in", stopped: "Stopped", stale: "Last seen" };

function buildAva(cls) {
  const ava = el("div", cls);
  ava.append(el("span", "ava-emoji"));
  return ava;
}

function buildCard(id, onTap) {
  const card = el("div", "member-card");
  card.dataset.testid = "member-card";
  card.dataset.member = id;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  const ava = buildAva("ava");
  const main = el("div", "mc-main");
  const name = el("div", "mc-name");
  name.dataset.testid = "member-name";
  const sub = el("div", "mc-sub");
  main.append(name, sub);
  const side = el("div", "mc-side");
  const chip = el("span", "chip");
  const bat = el("div", "bat");
  bat.append(el("div", "bat-fill"));
  side.append(chip, bat);
  card.append(ava, main, side);
  card.addEventListener("click", () => onTap(id));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onTap(id, { keyboard: true });
    }
  });
  return card;
}

export const memberSaid = (rec, status) => `${rec.name || t("Member")}, ${t(CHIP_TEXT[status])}`;

// Past a day a bare clock time no longer says which day it means.
const SINCE_MAX_MS = 24 * 60 * 60 * 1000;

export function memberSubLine(rec, now, mePos, place, status, since = null) {
  const bits = [];
  if (status === "sos" && now - rec.ts > staleAfter(rec)) bits.push(t("Signal lost"));
  // The caption only speaks for a live presence: "omw" on a dot that
  // stopped sharing an hour ago is a stale claim, not a status.
  if (rec.st && (status === "live" || status === "checkin" || status === "sos")) {
    bits.push(`"${rec.st}"`);
  }
  if (place) {
    const known = Number.isFinite(since) && since <= now && now - since < SINCE_MAX_MS;
    bits.push(known ? t("At {place} since {time}", { place, time: fmtClock(since) }) : t("At {place}", { place }));
  }
  if (rec.due) bits.push(t("Check in by {time}", { time: fmtClock(rec.due) }));
  const heard = fmtRelTime(now - rec.ts);
  bits.push(heard);
  if (mePos && Number.isFinite(rec.lat) && Number.isFinite(rec.lon)) {
    const dist = fmtDistance(haversineMeters(mePos.lat, mePos.lon, rec.lat, rec.lon));
    // A post with no position (an ask, a check-in while not sharing) must not make the last one look new.
    const placed = Number.isFinite(rec.posTs) ? fmtRelTime(now - rec.posTs) : heard;
    bits.push(placed === heard ? dist : `${dist} (${placed})`);
  }
  if (rec.mode === "coarse") bits.push(t("Neighborhood"));
  return bits.join(" · ");
}

export function updateMemberList(container, items, { now, mePos, statusOf, onTap, placeOf, sinceOf }) {
  const existing = new Map();
  for (const node of container.children) existing.set(node.dataset.member, node);
  for (const [i, rec] of items.entries()) {
    let card = existing.get(rec.id);
    if (!card) card = buildCard(rec.id, onTap);
    else existing.delete(rec.id);
    const status = statusOf(rec, now);
    card.className = `member-card mc-${status}`;
    card.style.setProperty("--m-hue", String(rec.hue ?? 0));
    $(".ava-emoji", card).textContent = rec.emoji || "";
    $(".mc-name", card).textContent = rec.name || t("Member");
    const subLine = memberSubLine(rec, now, mePos, placeOf?.(rec.id), status, sinceOf?.(rec.id));
    $(".mc-sub", card).textContent = subLine;
    const chip = $(".chip", card);
    chip.textContent = t(CHIP_TEXT[status]);
    chip.className = `chip chip-${status}`;
    const bat = $(".bat", card);
    if (typeof rec.bat === "number") {
      bat.hidden = false;
      const pct = Math.round(Math.min(1, Math.max(0, rec.bat)) * 100);
      $(".bat-fill", bat).style.width = `${pct}%`;
      bat.classList.toggle("bat-low", rec.bat < 0.15);
      bat.setAttribute("aria-label", t("Battery {pct} percent", { pct }));
    } else {
      bat.hidden = true;
    }
    // The label carries what the eyes get: name, status, then the same sub
    // line (caption, place, age, distance) the card paints. A label of just
    // name-and-status erases the information the card exists to give.
    const batBit = typeof rec.bat === "number"
      ? `, ${t("Battery {pct} percent", { pct: Math.round(Math.min(1, Math.max(0, rec.bat)) * 100) })}`
      : "";
    card.setAttribute(
      "aria-label",
      `${rec.name || t("Member")}, ${t(CHIP_TEXT[status])}${subLine ? `, ${subLine}` : ""}${batBit}`,
    );
    // Moving a node blurs it, so a card in place stays put and moveBefore keeps focus on one that moves.
    const at = container.children[i] ?? null;
    if (at !== card) {
      if (container.moveBefore && card.parentNode === container) container.moveBefore(card, at);
      else container.insertBefore(card, at);
    }
  }
  for (const node of existing.values()) node.remove();
}

function quietCard(id, onTap) {
  const node = el("div", "member-card mc-quiet");
  node.dataset.testid = "quiet-card";
  node.dataset.member = id;
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  const ava = el("div", "ava");
  ava.setAttribute("aria-hidden", "true");
  const letter = el("span", "ava-emoji");
  ava.append(letter);
  const main = el("div", "mc-main");
  const name = el("div", "mc-name");
  const sub = el("div", "mc-sub");
  main.append(name, sub);
  node.append(ava, main);
  node.addEventListener("click", () => onTap(id));
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onTap(id);
    }
  });
  function update({ name: who, hue }) {
    const shown = who || t("Member");
    node.style.setProperty("--m-hue", String(hue ?? 0));
    letter.textContent = Array.from((who || "").trim())[0]?.toLocaleUpperCase() || "";
    name.textContent = shown;
    sub.textContent = t("No recent update");
    node.setAttribute("aria-label", `${shown}, ${t("No recent update")}`);
  }
  return { node, update };
}

const quietCards = new WeakMap();

export function updateQuietList(container, items, { onTap }) {
  if (!container) return;
  let cards = quietCards.get(container);
  if (!cards) quietCards.set(container, (cards = new Map()));
  const nodes = items.map((p) => {
    let card = cards.get(p.id);
    if (!card) cards.set(p.id, (card = quietCard(p.id, onTap)));
    card.update(p);
    return card.node;
  });
  const ids = new Set(items.map((p) => p.id));
  for (const id of cards.keys()) if (!ids.has(id)) cards.delete(id);
  const shown = [...container.children];
  if (nodes.length !== shown.length || nodes.some((n, i) => n !== shown[i])) container.replaceChildren(...nodes);
  container.hidden = !nodes.length;
}

export function updateAvaStrip(container, items, { statusOf, now }) {
  const shown = items.slice(0, 7);
  const existing = new Map();
  for (const node of container.querySelectorAll(".ava[data-id]")) existing.set(node.dataset.id, node);

  let cursor = container.firstChild;
  for (const rec of shown) {
    const st = statusOf(rec, now);
    let a = existing.get(rec.id);
    if (a) existing.delete(rec.id);
    else {
      a = buildAva("ava ava-mini");
      a.dataset.id = rec.id;
    }
    a.style.setProperty("--m-hue", String(rec.hue ?? 0));
    a.classList.toggle("ava-sos", st === "sos");
    a.classList.toggle("ava-overdue", st === "overdue");
    a.classList.toggle("ava-dim", st === "stale" || st === "stopped");
    const emoji = $(".ava-emoji", a);
    if (emoji.textContent !== (rec.emoji || "")) emoji.textContent = rec.emoji || "";
    // Place it at the cursor so order tracks the sorted list without churn.
    if (cursor !== a) container.insertBefore(a, cursor);
    else cursor = a.nextSibling;
  }
  for (const node of existing.values()) node.remove();

  let more = container.querySelector(".ava-more");
  const overflow = items.length - shown.length;
  if (overflow > 0) {
    if (!more) {
      more = el("div", "ava ava-mini ava-more");
      container.append(more);
    } else container.append(more);
    more.textContent = `+${overflow}`;
  } else if (more) {
    more.remove();
  }
}

// -------------------------------------------------------------- focus card

export function renderFocusCard(root, rec, ctx) {
  const { now, mePos, statusOf, trailOn, onTrailToggle, onClose, place, since, ask, askWho, onAsk } = ctx;
  const status = statusOf(rec, now);
  if (root.dataset.member !== rec.id) {
    root.dataset.member = rec.id;
    root.replaceChildren();
    const head = el("div", "fc-head");
    const ava = buildAva("ava ava-big");
    const main = el("div", "fc-main");
    main.append(el("div", "fc-name"), el("div", "fc-sub"));
    const x = btn("icon-btn fc-close", "✕", "Close member card");
    x.addEventListener("click", onClose);
    head.append(ava, main, x);
    const coords = el("div", "fc-coords");
    const code = el("code", "fc-latlon");
    const copyBtn = btn("btn-mini", "Copy", "Copy coordinates");
    copyBtn.classList.add("fc-copy");
    coords.append(code, copyBtn);
    // The rendezvous line: which way and how far, as words first. Pure
    // local math from two already-decrypted points; asking for a route
    // would hand a mapping service both of you.
    const compass = el("div", "fc-compass");
    const arrow = el("span", "fc-compass-arrow", "↑");
    arrow.setAttribute("aria-hidden", "true");
    compass.append(arrow, el("span", "fc-compass-text"));
    compass.hidden = true;
    const actions = el("div", "fc-actions");
    const trailBtn = btn("btn-mini fc-trail", "Trail");
    const dir = el("a", "btn-mini fc-directions", "Directions");
    dir.target = "_blank";
    dir.rel = "noopener noreferrer";
    actions.append(trailBtn, dir);
    const askBtn = btn("btn-mini fc-ask", "Ask to check in");
    root.append(head, coords, compass, actions, askBtn);
  }
  root.className = `focus-card fc-${status}`;
  root.style.setProperty("--m-hue", String(rec.hue ?? 0));
  $(".ava-emoji", root).textContent = rec.emoji || "";
  $(".fc-name", root).textContent = rec.name || t("Member");
  $(".fc-sub", root).textContent = `${t(CHIP_TEXT[status])} · ${memberSubLine(rec, now, mePos, place, status, since)}`;
  const hasPos = Number.isFinite(rec.lat) && Number.isFinite(rec.lon);
  const latlon = hasPos ? `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}` : t("no position yet");
  $(".fc-latlon", root).textContent = latlon;
  const compass = $(".fc-compass", root);
  const meHere = mePos && Number.isFinite(mePos.lat) && Number.isFinite(mePos.lon);
  if (compass) {
    if (hasPos && meHere) {
      const deg = bearingDeg(mePos.lat, mePos.lon, rec.lat, rec.lon);
      const dist = haversineMeters(mePos.lat, mePos.lon, rec.lat, rec.lon);
      compass.hidden = false;
      $(".fc-compass-text", compass).textContent = t("{dist} to the {way} of you", {
        dist: fmtDistance(dist),
        way: compassWord(deg),
      });
      $(".fc-compass-arrow", compass).style.transform = `rotate(${Math.round(deg)}deg)`;
    } else {
      compass.hidden = true;
    }
  }
  const copyBtn = $(".fc-copy", root);
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(latlon);
      toast("Coordinates copied");
    } catch {
      toast("Copy failed", "warn");
    }
  };
  const trailBtn = $(".fc-trail", root);
  trailBtn.setAttribute("aria-pressed", String(trailOn));
  trailBtn.classList.toggle("on", trailOn);
  trailBtn.onclick = onTrailToggle;
  const askBtn = $(".fc-ask", root);
  askBtn.hidden = !ask;
  askBtn.disabled = ask !== "ready";
  if (ask === "busy") askBtn.textContent = t("You already asked {who}", { who: askWho });
  else askBtn.textContent = ask === "asked" ? t("Asked to check in") : t("Ask to check in");
  askBtn.onclick = onAsk || null;
  const dir = $(".fc-directions", root);
  if (hasPos) {
    // An https maps URL works everywhere; geo: has no handler on iOS Safari
    // or desktop browsers.
    const lat = rec.lat.toFixed(5);
    const lon = rec.lon.toFixed(5);
    dir.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
    dir.classList.remove("disabled");
    dir.removeAttribute("aria-disabled");
    dir.removeAttribute("tabindex");
  } else {
    dir.removeAttribute("href");
    dir.classList.add("disabled");
    dir.setAttribute("aria-disabled", "true");
    dir.setAttribute("tabindex", "-1");
  }
  root.hidden = false;
}
