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

export function openIdentitySheet({ title, intro, cta, profile, onSave }) {
  const ov = openOverlay({ title, testid: "identity-sheet" });
  if (intro) ov.body.append(el("p", "ov-note", intro));
  const { wrap, input, grid } = identityFields(profile);
  ov.body.append(wrap);
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
      await onSave({ name, emoji: grid.value() });
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

export function openJoinSheet({ profile, hasCircle, onJoin }) {
  const ov = openOverlay({ title: "Join a circle", testid: "join-sheet" });
  ov.body.append(el("p", "ov-note", "You have an invite to a circle. Set up how you will appear to the people in it."));
  if (hasCircle) {
    ov.body.append(
      el("p", "ov-warn-note", "This device is already in a circle. Joining replaces it: you will leave your current circle."),
    );
  }
  const { wrap, input, grid } = identityFields(profile);
  ov.body.append(wrap);
  const join = btn("btn btn-primary", hasCircle ? "Replace and join" : "Join circle");
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
      await onJoin({ name, emoji: grid.value() });
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

// ------------------------------------------------------------ invite sheet

export function openInviteSheet({ getLink, qrSvgFor, onRotate }) {
  const ov = openOverlay({ title: "Invite people", testid: "invite-sheet", className: "ov-invite" });

  const qrCard = el("div", "qr-card");
  qrCard.dataset.testid = "invite-qr";
  const linkRow = el("div", "link-row");
  const linkText = el("code", "invite-link");
  linkText.dataset.testid = "invite-link";
  const copy = btn("btn btn-secondary btn-copy", "Copy link");
  linkRow.append(linkText);

  function refresh() {
    const link = getLink();
    // qrSvg output is generated geometry from our own encoder, not user data.
    qrCard.innerHTML = qrSvgFor(link);
    const svg = qrCard.querySelector("svg");
    svg?.setAttribute("role", "img");
    svg?.setAttribute("aria-label", "Invite QR code");
    linkText.textContent = link;
  }
  refresh();

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getLink());
      toast("Invite link copied");
    } catch {
      toast("Copy failed. Long-press the link instead.", "warn");
    }
  });

  ov.body.append(
    qrCard,
    linkRow,
    copy,
    el("p", "ov-note", "Anyone with this link joins your circle. Share it somewhere you already trust, like Signal."),
  );

  const danger = el("div", "danger-zone");
  danger.append(el("h3", "danger-title", "Danger zone"));
  const rotateBtn = btn("btn btn-danger-ghost", "Rotate circle");
  const confirmBox = el("div", "rotate-confirm");
  confirmBox.hidden = true;
  confirmBox.append(
    el("p", "ov-note", 'Rotating creates a fresh secret and a fresh invite link. Everyone, including you, is moved off the old channel and must re-join with the new link. Type "rotate" to confirm.'),
  );
  const confirmInput = el("input", "text-input");
  confirmInput.type = "text";
  confirmInput.placeholder = 'Type "rotate"';
  confirmInput.autocomplete = "off";
  const confirmBtn = btn("btn btn-danger", "Rotate now");
  confirmBtn.disabled = true;
  confirmInput.addEventListener("input", () => {
    confirmBtn.disabled = confirmInput.value.trim().toLowerCase() !== "rotate";
  });
  confirmBox.append(confirmInput, confirmBtn);
  rotateBtn.addEventListener("click", () => {
    confirmBox.hidden = !confirmBox.hidden;
    if (!confirmBox.hidden) {
      confirmInput.focus();
      confirmBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    try {
      await onRotate();
      confirmInput.value = "";
      confirmBox.hidden = true;
      refresh();
      toast("Circle rotated. Share the new link.");
    } catch {
      confirmBtn.disabled = confirmInput.value.trim().toLowerCase() !== "rotate";
      toast("Rotation failed. Try again.", "warn");
    }
  });
  danger.append(rotateBtn, confirmBox);
  ov.body.append(danger);
  return ov;
}

// ---------------------------------------------------------- settings sheet

function segControl({ label, note, options, value, onChange }) {
  const field = el("div", "field");
  field.append(el("span", "field-label", label));
  const seg = el("div", "seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", label);
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
      onChange(opt.value);
    });
    seg.append(b);
  }
  for (const [v, cell] of cells) {
    cell.classList.toggle("sel", v === value);
    cell.setAttribute("aria-checked", String(v === value));
  }
  field.append(seg);
  if (note) field.append(el("p", "field-note", note));
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

export function openSettingsSheet({ values, demo, lock, lockActions, onChange, onInvite, onPanic }) {
  const ov = openOverlay({ title: "Settings", testid: "settings-sheet", className: "ov-settings" });
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
              await lockActions.enable(pc);
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

  // Danger
  const gDanger = group("Danger zone");
  gDanger.classList.add("danger-zone");
  const panicBtn = btn("btn btn-danger-ghost", "Panic wipe");
  panicBtn.dataset.testid = "settings-panic";
  const panicBox = el("div", "rotate-confirm");
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

  return ov;
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
  const ro = new ResizeObserver(() => {
    if (!dragging && snap === "peek") apply(false);
  });
  ro.observe(dragEl);
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
    if (snap === "peek") {
      bodyEl.inert = true;
      bodyEl.setAttribute("aria-hidden", "true");
    } else {
      bodyEl.inert = false;
      bodyEl.removeAttribute("aria-hidden");
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
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => apply(false)).observe(dragEl);
  }

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
  container.replaceChildren();
  const shown = items.slice(0, 7);
  for (const rec of shown) {
    const a = buildAva("ava ava-mini");
    a.style.setProperty("--m-hue", String(rec.hue ?? 0));
    a.classList.toggle("ava-sos", statusOf(rec, now) === "sos");
    a.classList.toggle("ava-dim", ["stale", "stopped"].includes(statusOf(rec, now)));
    $(".ava-emoji", a).textContent = rec.emoji || "";
    container.append(a);
  }
  if (items.length > shown.length) {
    container.append(el("div", "ava ava-mini ava-more", `+${items.length - shown.length}`));
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
