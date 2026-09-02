// UI components: toasts, overlay sheets, the draggable bottom sheet, member
// cards, and the settings/invite/identity builders. No app state lives here;
// main.js owns state and passes callbacks in.
//
// Hard rule respected throughout: user-controlled strings (names, statuses,
// anything decrypted) only ever pass through textContent, never innerHTML.

import { fmtDistance, fmtRelTime, haversineMeters } from "./fmt.js";

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function btn(cls, text, label) {
  const b = el("button", cls, text);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  return b;
}

// ---------------------------------------------------------------- toasts

export function toast(message, kind = "info") {
  const host = document.getElementById("toasts");
  const t = el("div", `toast toast-${kind}`, message);
  t.dataset.testid = "toast";
  // Safety-critical toasts (an incoming SOS, a warning) announce assertively
  // instead of waiting behind the polite live region.
  if (kind === "sos" || kind === "warn") t.setAttribute("role", "alert");
  host.append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => {
    t.classList.remove("in");
    setTimeout(() => t.remove(), 400);
  }, 3400);
  return t;
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
  if (title) panel.setAttribute("aria-label", title);
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

  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", () => {
    // A released short press is a plain tap; tell the user this button
    // needs a hold instead of doing nothing.
    if (armed && progress < 1) onShortTap?.();
    cancel();
  });
  button.addEventListener("pointerleave", cancel);
  button.addEventListener("pointercancel", cancel);
  button.addEventListener("click", (e) => {
    if (!e.isTrusted && !armed) onFire();
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
  grid.setAttribute("aria-label", "Avatar");
  let selected = EMOJI.includes(initial) ? initial : EMOJI[0];
  const cells = new Map();
  for (const em of EMOJI) {
    const b = btn("emoji-cell", em, `Avatar ${em}`);
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
  input.placeholder = "Name";
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
  input.placeholder = circleName.placeholder || "Family, friends, the trip";
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

export function openJoinSheet({ profile, hasCircle, circleName, onJoin }) {
  const ov = openOverlay({ title: "Join a circle", testid: "join-sheet" });
  ov.body.append(
    el("p", "ov-note", "You have an invite to a circle. Set up how you will appear to the people in it."),
    el(
      "p",
      "ov-note",
      "This sends a request. Somebody already in the circle has to check your safety number and accept it before you can see anyone, or they you.",
    ),
  );
  if (hasCircle) {
    ov.body.append(
      el("p", "ov-note", "Your current circle stays. This adds a new one, and you can switch between them from the circle name at the top of the map."),
    );
  }
  const { wrap, input, grid } = identityFields(profile);
  ov.body.append(wrap);
  let cn = null;
  if (circleName) {
    cn = circleNameField(circleName);
    ov.body.append(cn.field);
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
    wrap.setAttribute("aria-label", "Safety number loading");
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
  wrap.setAttribute("aria-label", `Safety number ${groups.join(" ")}`);
  return wrap;
}

// Countdowns for the two things that expire: an invitation and a help link.
// Coarse on purpose. A ticking second hand on something you are about to hand
// to somebody reads as pressure, and these are read under pressure already.
export function fmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  if (ms < 60000) return "under a minute";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")} min`;
}

// ---------------------------------------------------------- link handoff

async function copyLink(link, msg) {
  try {
    await navigator.clipboard.writeText(link);
    toast(msg);
  } catch {
    toast("Copy failed. Long-press the link instead.", "warn");
  }
}

// The OS share sheet is the fast path under stress: it reaches the messaging
// apps someone already has open. Clipboard is the fallback.
async function shareLink(link, lead, msg) {
  if (navigator.share) {
    try {
      await navigator.share({ text: `${lead} ${link}` });
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

  node.append(head, safety, change, hint, actions, confirm);

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
      if (out) toast(`${who} is out. Everyone else has new keys.`);
      else if (out === null) toast("Could not remove them. Nothing changed.", "warn");
    } catch {
      toast("Could not remove them. Nothing changed.", "warn");
    }
    confirmGo.disabled = false;
    confirm.hidden = true;
    onChanged();
  });

  acceptBtn.addEventListener("click", async () => {
    acceptBtn.disabled = true;
    const who = cur.name;
    try {
      if (await api.acceptKeyChange(id)) toast(`${who} is now pinned to the new keys.`);
    } finally {
      acceptBtn.disabled = false;
    }
    onChanged();
  });

  function update({ name: who, verified, safety: number, change: ch }) {
    cur = { name: who, verified: !!verified };
    name.textContent = who;
    // Marking somebody verified while their keys are in question would be
    // verifying the wrong thing, so that action is not offered until the
    // change is answered.
    pill.textContent = ch ? "Keys changed" : verified ? "Verified" : "Not verified";
    pill.className = `verify-pill ${ch ? "vp-alert" : verified ? "vp-on" : "vp-off"}`;
    verifyBtn.hidden = !!ch;
    verifyBtn.textContent = verified ? "Mark not verified" : "Mark verified";
    confirmText.textContent = `Everyone else gets new keys. ${who} can read nothing this circle sends from now on, and is not told. What they already saw, they keep.`;
    if (ch) {
      node.classList.add("mem-changed");
      change.hidden = false;
      safety.hidden = true;
      changeText.textContent = `${who} is answering with different keys. That is a reinstall, or somebody else in their place, and this phone cannot tell which. Their location stays off your map until you accept.`;
      setSafety(wasBlock, ch.oldSafety);
      setSafety(nowBlock, ch.newSafety);
      hint.textContent = `Ask ${who} to read out the number on their screen. If it is the new one, accept it. If it is the old one, or they did not reinstall, remove them.`;
    } else {
      node.classList.remove("mem-changed");
      change.hidden = true;
      safety.hidden = false;
      setSafety(safety, number);
      hint.textContent = verified
        ? `You have checked this number with ${who}.`
        : `Read this out to ${who} on a call or in person. The same digits on both screens means nobody is in between.`;
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
  you.append(
    el("span", "safety-cap", "Your number"),
    youName,
    youSafety,
    el("p", "field-note", "This is the number your circle should hear from you."),
  );

  const list = el("div", "mem-list");
  const empty = el("p", "ov-note", "Nobody else is in this circle yet. Invite someone from the map.");
  empty.hidden = true;
  ov.body.append(you, list, empty);

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
    youName.textContent = api.state.profile?.name || "You";
    if (meId) {
      need(meId);
      setSafety(youSafety, numbers.get(meId));
    }
    const changes = new Map(api.keyChanges().map((c) => [c.memberId, c]));
    const live = new Map(api.members().map((r) => [r.id, r]));
    const people = api.pinnedList();
    empty.hidden = people.length > 0;
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
      row.update({
        name: live.get(id)?.name || rec.name || "Member",
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
    label.textContent = next.label || "Help link";
    node.classList.toggle("viewer-dead", !!next.revoked);
    if (next.revoked) {
      when.textContent = "Revoked";
      linkRow.hidden = true;
      actions.hidden = true;
    } else {
      const left = fmtCountdown(next.expiresAt - Date.now());
      when.textContent = next.failing ? "Not reaching the relay" : `Expires in ${left}`;
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
  addInput.placeholder = "Who is it for?";
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
  const who = req.name || "Someone";
  box.append(el("h3", "review-title", `${who} wants to join`));
  box.append(el("p", "ov-note", `They chose the name ${who}. Anyone can type any name, so the number below is the only part that proves who they are.`));
  box.append(safetyBlock(req.safety, "join-safety"));
  box.append(
    el(
      "p",
      "ov-note",
      `Reach ${who} some way you already trust, a call or in person, and have them read the number on their screen. Every digit has to match.`,
    ),
  );
  box.append(
    el(
      "p",
      "ov-note",
      "Accepting gives the whole circle new keys and lets them see everyone's location from then on. They cannot read anything sent before.",
    ),
  );
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
      svg?.setAttribute("aria-label", "Invite QR code");
      linkText.textContent = link;
    }
    const inv = api.invite();
    const left = inv ? inv.expiresAt - Date.now() : 0;
    expiry.textContent = inv
      ? `One use only, and it expires in ${fmtCountdown(left)}. Accepting somebody uses it up.`
      : "This link is gone. Close this and tap Invite again for a new one.";
    waiting.textContent = requests.length
      ? "Somebody is waiting on you above. The link still works until you accept."
      : "Nobody has used this link yet. When somebody does, their request shows up here.";
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

function switchRow({ label, note, value, onChange }) {
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
    on = !on;
    paint();
    onChange(on);
  });
  row.setValue = (v) => {
    on = !!v;
    paint();
  };
  row.append(text, sw);
  return row;
}

// A passcode entry sheet. `confirm` requires a matching second entry (used when
// setting a new passcode). `onSubmit(passcode)` resolves true on success or
// false to keep the sheet open with an error (e.g. a wrong current passcode).
export function openPasscodeSheet({ title, intro, cta, confirm = false, current = false, minLen = 4, onSubmit, onClose }) {
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
    i.setAttribute("aria-label", labelText);
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
    err.textContent = m;
    err.hidden = false;
  };
  submit.addEventListener("click", async () => {
    if (busy) return;
    const pc = newIn.value;
    if (pc.length < minLen) return fail(`Use at least ${minLen} characters.`);
    if (confIn && confIn.value !== pc) return fail("The two passcodes do not match.");
    busy = true;
    submit.disabled = true;
    try {
      const ok = await onSubmit(current ? { current: curIn.value, next: pc } : pc);
      if (ok) {
        succeeded = true;
        ov.close();
      } else {
        fail(current ? "That current passcode is wrong." : "Could not save. Try again.");
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

export function openSettingsSheet({ api, values, demo, tor, lock, lockActions, onChange, onMembers, onInvite, onPanic, onLeave, onClose }) {
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
  cn.addEventListener("change", () => onChange("circleName", cn.value.trim().slice(0, 24) || "My circle"));
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
        ? `You can see the last ${c.label} of your circle. A phone taken from you gives up almost nothing.`
        : `You can see the last ${c.label} of your circle. A phone taken from you gives up that same ${c.label}, and nothing older.`;
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

  // Sharing
  const gShare = group("Sharing");
  gShare.append(
    segControl({
      label: "Precision",
      note: "Neighborhood rounds your position to about 1 km on your device before it is encrypted",
      options: [
        { value: "precise", label: "Precise" },
        { value: "coarse", label: "Neighborhood" },
      ],
      value: values.settings.precision,
      onChange: (v) => onChange("precision", v),
    }),
    switchRow({
      label: "Trail history",
      note: "Show recent paths on the map",
      value: values.settings.trail,
      onChange: (v) => onChange("trail", v),
    }),
  );

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
            intro: "Choose a passcode to lock Starling on this device. There is no reset: if you forget it you erase this device and rejoin from an invite.",
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

      gLock.append(
        segControl({
          label: "Auto-lock",
          note: "Relock after the app has been in the background this long.",
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
  const gDanger = group("Danger zone");
  gDanger.classList.add("danger-zone");
  if (onLeave && !demo) {
    const leaveBtn = btn("btn btn-danger-ghost", "Leave this circle");
    leaveBtn.dataset.testid = "settings-leave";
    const leaveBox = el("div", "confirm-box");
    leaveBox.hidden = true;
    leaveBox.append(
      el("p", "ov-note", 'Leaving deletes this circle\'s secret and your identity in it from this device. The circle itself keeps existing for everyone else, and you can come back with a fresh invite. Type "leave" to confirm.'),
    );
    const leaveInput = el("input", "text-input");
    leaveInput.type = "text";
    leaveInput.placeholder = 'Type "leave"';
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
  gAbout.append(
    el("p", "about-version", "Starling v1"),
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
    if (!animate) requestAnimationFrame(() => sheetEl.classList.remove("no-anim"));
    onSnap?.(snap);
  }

  // Drag from the header zone only; buttons inside it still tap normally.
  let startY = 0;
  let startVisible = 0;
  let lastY = 0;
  let lastT = 0;
  let vel = 0;

  dragEl.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, a")) return;
    dragging = true;
    dragEl.setPointerCapture(e.pointerId);
    sheetEl.classList.add("no-anim");
    startY = lastY = e.clientY;
    lastT = performance.now();
    startVisible = H() - new DOMMatrixReadOnly(getComputedStyle(sheetEl).transform).f;
    vel = 0;
  });
  dragEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;
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

const CHIP_TEXT = { live: "Live", sos: "SOS", checkin: "Checked in", stopped: "Stopped", stale: "Last seen" };

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
      onTap(id);
    }
  });
  return card;
}

export function memberSubLine(rec, now, mePos) {
  const bits = [fmtRelTime(now - rec.ts)];
  if (mePos && Number.isFinite(rec.lat) && Number.isFinite(rec.lon)) {
    bits.push(fmtDistance(haversineMeters(mePos.lat, mePos.lon, rec.lat, rec.lon)));
  }
  if (rec.mode === "coarse") bits.push("Neighborhood");
  return bits.join(" · ");
}

export function updateMemberList(container, items, { now, mePos, statusOf, onTap }) {
  const existing = new Map();
  for (const node of container.children) existing.set(node.dataset.member, node);
  for (const rec of items) {
    let card = existing.get(rec.id);
    if (!card) card = buildCard(rec.id, onTap);
    else existing.delete(rec.id);
    const status = statusOf(rec, now);
    card.className = `member-card mc-${status}`;
    card.style.setProperty("--m-hue", String(rec.hue ?? 0));
    $(".ava-emoji", card).textContent = rec.emoji || "";
    $(".mc-name", card).textContent = rec.name || "Member";
    $(".mc-sub", card).textContent = memberSubLine(rec, now, mePos);
    const chip = $(".chip", card);
    chip.textContent = CHIP_TEXT[status];
    chip.className = `chip chip-${status}`;
    const bat = $(".bat", card);
    if (typeof rec.bat === "number") {
      bat.hidden = false;
      const pct = Math.round(Math.min(1, Math.max(0, rec.bat)) * 100);
      $(".bat-fill", bat).style.width = `${pct}%`;
      bat.classList.toggle("bat-low", rec.bat < 0.15);
      bat.setAttribute("aria-label", `Battery ${pct} percent`);
    } else {
      bat.hidden = true;
    }
    card.setAttribute("aria-label", `${rec.name || "Member"}, ${CHIP_TEXT[status]}`);
    container.append(card);
  }
  for (const node of existing.values()) node.remove();
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
  const { now, mePos, statusOf, trailOn, onTrailToggle, onClose } = ctx;
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
    const actions = el("div", "fc-actions");
    const trailBtn = btn("btn-mini fc-trail", "Trail");
    const dir = el("a", "btn-mini fc-directions", "Directions");
    dir.target = "_blank";
    dir.rel = "noopener noreferrer";
    actions.append(trailBtn, dir);
    root.append(head, coords, actions);
  }
  root.className = `focus-card fc-${status}`;
  root.style.setProperty("--m-hue", String(rec.hue ?? 0));
  $(".ava-emoji", root).textContent = rec.emoji || "";
  $(".fc-name", root).textContent = rec.name || "Member";
  $(".fc-sub", root).textContent = `${CHIP_TEXT[status]} · ${memberSubLine(rec, now, mePos)}`;
  const hasPos = Number.isFinite(rec.lat) && Number.isFinite(rec.lon);
  const latlon = hasPos ? `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}` : "no position yet";
  $(".fc-latlon", root).textContent = latlon;
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
