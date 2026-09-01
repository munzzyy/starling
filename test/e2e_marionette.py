#!/usr/bin/env python3
"""End to end test: two real headless Firefox browsers against the real relay.

Drives the full scenario over Marionette: create a circle, invite, join from a
second browser, cross-visibility, check-in, SOS, stop, then proves the relay
stored nothing but ciphertext and takes the flagship screenshots.

Run from the repo root:  python3 test/e2e_marionette.py
Ports: 8920 (http), 2840/2841 (marionette). Everything started here is killed
before exit.
"""
import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "test", "screenshots")
HTTP_PORT = 8920
BASE = f"http://127.0.0.1:{HTTP_PORT}"
PORT_A = 2840
PORT_B = 2841
PAD_LEN = 512

TIMES_SQ = (40.7580, -73.9855)
COLUMBUS = (40.7681, -73.9819)
MOVED = (40.7712, -73.9740)


class E2EError(AssertionError):
    pass


def log(msg):
    print(f"[e2e +{time.time() - T0:6.1f}s] {msg}", flush=True)


T0 = time.time()

# ------------------------------------------------------------- marionette


class Marionette:
    def __init__(self, host="127.0.0.1", port=2828, timeout=45):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self._buf = b""
        self._msgid = 0
        self._read_frame()  # server handshake

    def _read_frame(self):
        while b":" not in self._buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise IOError("marionette closed")
            self._buf += chunk
        length, _, rest = self._buf.partition(b":")
        n = int(length)
        self._buf = rest
        while len(self._buf) < n:
            self._buf += self.sock.recv(4096)
        payload, self._buf = self._buf[:n], self._buf[n:]
        return json.loads(payload.decode("utf-8"))

    def command(self, name, params=None):
        self._msgid += 1
        frame = json.dumps([0, self._msgid, name, params or {}]).encode("utf-8")
        self.sock.sendall(f"{len(frame)}:".encode() + frame)
        while True:
            msg = self._read_frame()
            if isinstance(msg, list) and len(msg) >= 4 and msg[0] == 1 and msg[1] == self._msgid:
                _, _, err, result = msg
                if err:
                    raise RuntimeError(f"{name} failed: {err}")
                return result

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# Error collector plus a controllable geolocation shim. Installed after
# navigation; the app only touches geolocation when sharing starts, so the
# shim is always in place first.
INJECT = """
return (function () {
  if (window.__geoSet) return "already";
  window.__errs = window.__errs || [];
  window.addEventListener("error", function (e) {
    window.__errs.push("err:" + (e.message || String(e.error)));
  });
  window.addEventListener("unhandledrejection", function (e) {
    window.__errs.push("rej:" + String(e.reason));
  });
  document.addEventListener("securitypolicyviolation", function (e) {
    window.__errs.push("csp:" + e.violatedDirective + ":" + e.blockedURI);
  });
  var cur = null;
  var watchers = {};
  var nextId = 1;
  function fire(cb) {
    if (!cur) return;
    var pos = cur;
    setTimeout(function () { cb(pos); }, 0);
  }
  var shim = {
    getCurrentPosition: function (ok, err) {
      if (cur) fire(ok);
      else if (err) setTimeout(function () { err({ code: 2, message: "no fix" }); }, 0);
    },
    watchPosition: function (ok) {
      var id = nextId++;
      watchers[id] = ok;
      fire(ok);
      return id;
    },
    clearWatch: function (id) { delete watchers[id]; },
  };
  Object.defineProperty(navigator, "geolocation", { value: shim, configurable: true });
  window.__geoSet = function (lat, lon) {
    cur = {
      coords: { latitude: lat, longitude: lon, accuracy: 12, altitude: null,
                altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now(),
    };
    for (var k in watchers) fire(watchers[k]);
  };
  return "installed";
})();
"""


class Browser:
    def __init__(self, name, port, width=412, height=915):
        self.name = name
        self.profile = tempfile.mkdtemp(prefix=f"starling-e2e-{name}-")
        with open(os.path.join(self.profile, "user.js"), "w") as f:
            f.write(f'user_pref("marionette.port", {port});\n')
        self.proc = subprocess.Popen(
            ["firefox", "--headless", "--marionette", "--profile", self.profile,
             "--window-size", f"{width},{height}", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        client = None
        for _ in range(90):
            try:
                client = Marionette(port=port)
                break
            except (ConnectionRefusedError, OSError):
                time.sleep(0.5)
        if client is None:
            raise E2EError(f"marionette for {name} never came up on {port}")
        self.client = client
        client.command("WebDriver:NewSession", {})
        rect = client.command("WebDriver:SetWindowRect",
                              {"width": width, "height": height, "x": 0, "y": 0})
        log(f"browser {name}: window {rect.get('width')}x{rect.get('height')} "
            f"(requested {width}x{height})")

    def navigate(self, url):
        self.client.command("WebDriver:Navigate", {"url": url})

    def url(self):
        return self.client.command("WebDriver:GetCurrentURL")["value"]

    def exec(self, script, *args):
        res = self.client.command("WebDriver:ExecuteScript",
                                  {"script": script, "args": list(args)})
        return res.get("value")

    def find(self, css):
        res = self.client.command("WebDriver:FindElement",
                                  {"using": "css selector", "value": css})
        return next(iter(res["value"].values()))

    def send_keys(self, css, text):
        el = self.find(css)
        self.client.command("WebDriver:ElementSendKeys", {"id": el, "text": text})

    def click(self, css):
        # Synthetic click. The app honors untrusted clicks on every control
        # (holdToFire explicitly fires on them), and Marionette's coordinate
        # math is unreliable inside the transformed bottom sheet.
        hit = self.exec(
            "var el = document.querySelector(arguments[0]);"
            "if (!el) return false; el.click(); return true;", css)
        if not hit:
            raise E2EError(f"{self.name}: no element for click: {css}")

    def state(self):
        return self.exec("return window.__starlingState ? window.__starlingState() : null")

    def errors(self):
        return {
            "__errs": self.exec("return window.__errs || null"),
            "__starlingErrors": self.exec("return window.__starlingErrors || null"),
        }

    def escape(self):
        self.exec("document.dispatchEvent(new KeyboardEvent('keydown',"
                  " {key: 'Escape', bubbles: true}))")

    def nudge_poll(self):
        self.exec("window.dispatchEvent(new Event('online'))")

    def shot(self, filename):
        res = self.client.command("WebDriver:TakeScreenshot", {"full": True, "hash": False})
        data = res.get("value") if isinstance(res, dict) else res
        path = os.path.join(SHOTS, filename)
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        check_png(path)
        log(f"screenshot {filename} ({os.path.getsize(path)} bytes)")
        return path

    def close(self):
        try:
            self.client.close()
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=8)
        shutil.rmtree(self.profile, ignore_errors=True)


# ----------------------------------------------------------------- helpers


def wait_for(fn, timeout=30, interval=0.5, desc="condition", nudge=None):
    deadline = time.time() + timeout
    last = None
    last_nudge = 0.0
    while time.time() < deadline:
        if nudge and time.time() - last_nudge >= 2.0:
            nudge()
            last_nudge = time.time()
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # transient marionette/JS hiccups surface at timeout
            last = f"exc: {e}"
        time.sleep(interval)
    raise E2EError(f"timeout ({timeout}s) waiting for {desc}; last: {str(last)[:500]}")


def http_get(path, timeout=10):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8")


def b64u_decode(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def check_png(path):
    from PIL import Image
    with Image.open(path) as im:
        im.load()
        w, h = im.size
        if w < 400 or h < 600:
            raise E2EError(f"{os.path.basename(path)}: implausible size {w}x{h}")
        colors = im.convert("RGB").getcolors(maxcolors=1 << 20)
        if colors is not None and len(colors) < 50:
            raise E2EError(f"{os.path.basename(path)}: looks blank ({len(colors)} colors)")


def member_named(st, name):
    for m in (st or {}).get("members", []):
        if m.get("name") == name:
            return m
    return None


def near(m, latlon, tol=0.001):
    return (m and m.get("lat") is not None and m.get("lon") is not None
            and abs(m["lat"] - latlon[0]) < tol and abs(m["lon"] - latlon[1]) < tol)


def wait_overlay_gone(b):
    wait_for(lambda: b.exec("return document.querySelector('.ov-wrap') === null"),
             timeout=10, desc=f"{b.name} overlay closed")


def sheet_to_peek(b):
    for _ in range(3):
        if b.exec("return document.getElementById('sheet').classList.contains('sheet-peek')"):
            return
        b.escape()
        time.sleep(0.6)
    raise E2EError(f"{b.name}: sheet never reached peek")


def set_offgrid(b):
    b.click('[data-testid="settings-open"]')
    wait_for(lambda: b.exec("return !!document.querySelector('[data-testid=\"settings-sheet\"]')"),
             timeout=10, desc=f"{b.name} settings sheet")
    ok = b.exec(
        "var cells = document.querySelectorAll("
        "'[data-testid=\"settings-sheet\"] .seg-cell');"
        "for (var i = 0; i < cells.length; i++) {"
        "  if (cells[i].textContent === 'Off-grid') { cells[i].click(); return true; }"
        "} return false;")
    if not ok:
        raise E2EError(f"{b.name}: Off-grid basemap cell not found")
    wait_for(lambda: b.exec("return document.getElementById('map').classList.contains('offgrid')"),
             timeout=5, desc=f"{b.name} off-grid basemap")
    b.escape()
    wait_overlay_gone(b)


def type_name_and_confirm(b, name, confirm_testid):
    sel = '[data-testid="identity-name"]'
    wait_for(lambda: b.exec(f"return !!document.querySelector('{sel}')"),
             timeout=15, desc=f"{b.name} identity input")
    b.send_keys(sel, name)
    btn = f'[data-testid="{confirm_testid}"]'
    wait_for(lambda: b.exec(f"return !document.querySelector('{btn}').disabled"),
             timeout=5, desc=f"{b.name} {confirm_testid} enabled")
    b.click(btn)


# ------------------------------------------------------------------ stages


def start_server():
    env = dict(os.environ)
    env.update({"STARLING_TEST": "1", "RATE_POST_MIN": "100000", "RATE_GET_MIN": "100000"})
    logfile = open(os.path.join(tempfile.gettempdir(), "starling-e2e-server.log"), "w")
    proc = subprocess.Popen(["node", os.path.join(ROOT, "test", "serve_local.mjs"),
                             str(HTTP_PORT)],
                            cwd=ROOT, env=env, stdout=logfile, stderr=logfile)
    wait_for(lambda: http_get("/api/v1/health")[0] == 200, timeout=20,
             desc="relay health", interval=0.3)
    log(f"server up on {BASE}")
    return proc, logfile


def flow_a_create(a):
    a.navigate(BASE + "/")
    wait_for(lambda: a.state() is not None, timeout=20, desc="A app boot")
    wait_for(lambda: a.state().get("screen") == "onboarding", timeout=10, desc="A onboarding")
    a.exec(INJECT)
    time.sleep(0.8)
    a.shot("01-onboarding.png")

    a.click('[data-testid="onboarding-create"]')
    type_name_and_confirm(a, "Avery", "identity-save")

    wait_for(lambda: a.exec(
        "var el = document.querySelector('[data-testid=\"invite-link\"]');"
        "return el && el.textContent.indexOf('#j=') >= 0;"),
        timeout=20, desc="A invite sheet with link")
    invite_url = a.exec(
        "return document.querySelector('[data-testid=\"invite-link\"]').textContent")
    if not invite_url.startswith(BASE) or "#j=" not in invite_url:
        raise E2EError(f"bad invite url: {invite_url}")
    log(f"invite url: {invite_url[:40]}...")
    a.escape()
    wait_overlay_gone(a)

    st = a.state()
    channel = st.get("channel")
    if not re.fullmatch(r"[0-9a-f]{32}", channel or ""):
        raise E2EError(f"bad channel id: {channel}")

    # Off-grid basemap first (clean map shots), then the settings screenshot.
    a.click('[data-testid="settings-open"]')
    wait_for(lambda: a.exec("return !!document.querySelector('[data-testid=\"settings-sheet\"]')"),
             timeout=10, desc="A settings sheet")
    ok = a.exec(
        "var cells = document.querySelectorAll("
        "'[data-testid=\"settings-sheet\"] .seg-cell');"
        "for (var i = 0; i < cells.length; i++) {"
        "  if (cells[i].textContent === 'Off-grid') { cells[i].click(); return true; }"
        "} return false;")
    if not ok:
        raise E2EError("A: Off-grid basemap cell not found")
    wait_for(lambda: a.exec("return document.getElementById('map').classList.contains('offgrid')"),
             timeout=5, desc="A off-grid basemap")
    time.sleep(0.8)
    a.shot("05-settings.png")
    a.escape()
    wait_overlay_gone(a)

    # Invite sheet again via the empty-circle nudge, for the QR screenshot.
    a.click("#nudge-invite")
    wait_for(lambda: a.exec(
        "return !!document.querySelector('[data-testid=\"invite-qr\"] svg')"),
        timeout=10, desc="A invite QR svg")
    time.sleep(0.8)
    a.shot("03-invite-qr.png")
    a.escape()
    wait_overlay_gone(a)

    # Share from Times Square.
    a.exec(f"window.__geoSet({TIMES_SQ[0]}, {TIMES_SQ[1]})")
    a.click('[data-testid="share-toggle"]')
    wait_for(lambda: a.state().get("sharing") is True, timeout=10, desc="A sharing on")
    wait_for(lambda: (a.state().get("me") or {}).get("lat") is not None,
             timeout=10, desc="A own fix")

    def relay_has_point():
        _, body = http_get(f"/api/v1/f/{channel}")
        feed = json.loads(body)
        return any(m.get("points") for m in feed.get("members", []))
    wait_for(relay_has_point, timeout=20, desc="A point on relay")
    log("A is sharing; relay has ciphertext")

    # Service worker must have installed and claimed: proves every precached
    # shell path actually serves.
    wait_for(lambda: a.exec("return !!navigator.serviceWorker.controller"),
             timeout=20, desc="A service worker active")
    log("A service worker active")
    return invite_url, channel


def flow_b_join(b, invite_url, channel):
    b.navigate(invite_url)
    wait_for(lambda: b.state() is not None, timeout=20, desc="B app boot")
    url_now = wait_for(lambda: "#j=" not in b.url() and b.url(), timeout=10,
                       desc="B invite fragment stripped")
    log(f"B url after strip: {url_now}")
    b.exec(INJECT)

    wait_for(lambda: b.exec("return !!document.querySelector('[data-testid=\"join-sheet\"]')"),
             timeout=15, desc="B join sheet")
    type_name_and_confirm(b, "Blair", "join-confirm")
    wait_for(lambda: b.state().get("screen") == "map", timeout=20, desc="B on map")
    st = b.state()
    if st.get("channel") != channel:
        raise E2EError(f"B channel {st.get('channel')} != A channel {channel}")

    b.exec(f"window.__geoSet({COLUMBUS[0]}, {COLUMBUS[1]})")
    b.click('[data-testid="share-toggle"]')
    wait_for(lambda: b.state().get("sharing") is True, timeout=10, desc="B sharing on")
    log("B joined and sharing")


def chan_member_ids(channel):
    _, body = http_get(f"/api/v1/f/{channel}")
    return {m.get("m") for m in json.loads(body).get("members", [])}


def flow_multicircle(a, channel):
    # A second circle from the pill switcher, then back. Sharing must not
    # carry across, each channel only ever sees its own rows, and the relay
    # must not be able to link the two circles through a shared member id.
    me1 = (a.state().get("me") or {}).get("id")
    chan1_before = chan_member_ids(channel)
    a.click('[data-testid="circle-open"]')
    wait_for(lambda: a.exec("return !!document.querySelector('[data-testid=\"circle-sheet\"]')"),
             timeout=10, desc="A circle sheet")
    a.click('[data-testid="circle-new"]')
    wait_for(lambda: a.exec("return !!document.querySelector('[data-testid=\"circle-name\"]')"),
             timeout=10, desc="A add-circle sheet")
    a.exec("var el = document.querySelector('[data-testid=\"circle-name\"]');"
           "el.value = 'Friends'; el.dispatchEvent(new Event('input', {bubbles: true}));")
    type_name_and_confirm(a, "Avery", "identity-save")
    wait_for(lambda: a.exec(
        "var el = document.querySelector('[data-testid=\"invite-link\"]');"
        "return el && el.textContent.indexOf('#j=') >= 0;"),
        timeout=20, desc="A invite sheet for the new circle")
    a.escape()
    wait_overlay_gone(a)
    st = a.state()
    chan2 = st.get("channel")
    if chan2 == channel or not re.fullmatch(r"[0-9a-f]{32}", chan2 or ""):
        raise E2EError(f"second circle channel wrong: {chan2}")
    pill = a.exec("return document.getElementById('pill-name').textContent")
    if pill != "Friends":
        raise E2EError(f"pill shows {pill!r}, not the new circle")
    if st.get("sharing"):
        raise E2EError("sharing carried into the new circle")

    # One point on the new channel proves the sender rebuilt for it.
    a.exec(f"window.__geoSet({TIMES_SQ[0]}, {TIMES_SQ[1]})")
    a.click('[data-testid="share-toggle"]')
    wait_for(lambda: a.state().get("sharing") is True, timeout=10, desc="A sharing on Friends")

    def relay_has_point2():
        _, body = http_get(f"/api/v1/f/{chan2}")
        return any(m.get("points") for m in json.loads(body).get("members", []))
    wait_for(relay_has_point2, timeout=20, desc="point on the Friends channel")

    # Isolation, both directions. The Friends channel holds exactly one
    # member whose id is NOT the id A uses on the first channel, and the
    # first channel gained no member it did not already have (B keeps
    # posting there under an id from the before set).
    me2 = (a.state().get("me") or {}).get("id")
    if not me1 or not me2 or me2 == me1:
        raise E2EError(f"identity reused across circles: {me1!r} vs {me2!r}")
    chan2_ids = chan_member_ids(chan2)
    if chan2_ids != {me2}:
        raise E2EError(f"Friends channel members {chan2_ids}, expected only {me2!r}")
    chan1_during = chan_member_ids(channel)
    if not chan1_during.issubset(chan1_before):
        raise E2EError(f"first channel grew during the Friends share: {chan1_during - chan1_before}")
    if me2 in chan1_during:
        raise E2EError("the Friends identity leaked onto the first channel")

    a.click('[data-testid="circle-open"]')
    wait_for(lambda: a.exec("return !!document.querySelector('[data-testid=\"circle-switch-0\"]')"),
             timeout=10, desc="A switch row")
    a.click('[data-testid="circle-switch-0"]')
    wait_for(lambda: a.state().get("channel") == channel, timeout=15,
             desc="A back on the first channel")
    if a.state().get("sharing"):
        raise E2EError("sharing carried across the switch back")

    # A share after the switch back lands on the first channel under the
    # original identity, and the Friends channel stays exactly as it was.
    def me1_point_count():
        _, body = http_get(f"/api/v1/f/{channel}")
        for m in json.loads(body).get("members", []):
            if m.get("m") == me1:
                return len(m.get("points") or [])
        return 0
    chan2_ids_before_back = chan_member_ids(chan2)
    points_before_back = me1_point_count()
    a.click('[data-testid="share-toggle"]')
    wait_for(lambda: a.state().get("sharing") is True, timeout=10, desc="A sharing again on circle 1")
    wait_for(lambda: me1_point_count() > points_before_back, timeout=20,
             desc="a NEW post-switch point under the original id on channel 1")
    if chan_member_ids(chan2) != chan2_ids_before_back:
        raise E2EError("the Friends channel changed after switching away")
    a.click('[data-testid="share-toggle"]')
    wait_for(lambda: a.state().get("sharing") is False, timeout=10, desc="A sharing off again")
    log("multi-circle: second channel live, isolation both ways, switch round-trip clean")
    return chan2


def cross_visibility(a, b):
    wait_for(lambda: near(member_named(a.state(), "Blair"), COLUMBUS),
             timeout=30, desc="A sees Blair at Columbus Circle", interval=1)
    wait_for(lambda: near(member_named(b.state(), "Avery"), TIMES_SQ),
             timeout=30, desc="B sees Avery at Times Square", interval=1)
    log("cross-visibility confirmed both ways")

    cards = a.exec(
        "var out = [];"
        "var cards = document.querySelectorAll('[data-testid=\"member-card\"]');"
        "for (var i = 0; i < cards.length; i++) {"
        "  out.push({name: cards[i].querySelector('[data-testid=\"member-name\"]').textContent,"
        "            sub: cards[i].querySelector('.mc-sub').textContent});"
        "} return out;")
    blair = next((c for c in cards if c["name"] == "Blair"), None)
    if not blair:
        raise E2EError(f"A member card missing Blair: {cards}")
    m = re.search(r"(\d+(?:\.\d+)?)\s*km", blair["sub"])
    if not m or not (1.0 <= float(m.group(1)) <= 1.4):
        raise E2EError(f"A card distance implausible (want ~1.2 km): {blair['sub']!r}")
    log(f"A card: Blair / {blair['sub']!r}")


def flagship_map_shots(a, b):
    sheet_to_peek(a)
    if not a.exec("return window.__starlingFit()"):
        raise E2EError("A __starlingFit found nothing to frame")
    time.sleep(1.2)
    a.shot("02-map-two-members.png")

    set_offgrid(b)
    sheet_to_peek(b)
    if not b.exec("return window.__starlingFit()"):
        raise E2EError("B __starlingFit found nothing to frame")
    time.sleep(1.2)
    b.shot("04-joined.png")


def move_checkin_sos_stop(a, b):
    b.exec(f"window.__geoSet({MOVED[0]}, {MOVED[1]})")
    wait_for(lambda: near(member_named(a.state(), "Blair"), MOVED),
             timeout=30, desc="A sees Blair's move", interval=1, nudge=a.nudge_poll)
    log("A sees Blair's new position")

    b.click('[data-testid="checkin-button"]')
    wait_for(lambda: (member_named(a.state(), "Blair") or {}).get("type") == "checkin",
             timeout=30, desc="A sees Blair check-in", interval=0.5, nudge=a.nudge_poll)
    log("A sees the check-in")

    b.click('[data-testid="sos-button"]')  # synthetic click fires per UI contract
    wait_for(lambda: (member_named(a.state(), "Blair") or {}).get("type") == "sos",
             timeout=30, desc="A sees Blair SOS", interval=0.5, nudge=a.nudge_poll)
    log("A sees the SOS")

    a.click('[data-testid="share-toggle"]')
    wait_for(lambda: a.state().get("sharing") is False, timeout=10, desc="A sharing off")
    wait_for(lambda: (member_named(b.state(), "Avery") or {}).get("type") == "bye",
             timeout=30, desc="B sees Avery stop (bye)", interval=1, nudge=b.nudge_poll)
    log("B sees Avery's bye")


def zero_knowledge_dump(channels):
    _, body = http_get("/debug/dump")
    for needle in ["Avery", "Blair", "40.7", "73.9", "lat", "name"]:
        if needle in body:
            idx = body.index(needle)
            raise E2EError(
                f"dump leaks {needle!r} at offset {idx}: ...{body[max(0, idx - 40):idx + 44]}...")
    dump = json.loads(body)
    points = dump.get("points", [])
    members = dump.get("members", [])
    if not points or not members:
        raise E2EError(f"dump unexpectedly empty: {len(members)} members, {len(points)} points")
    b64re = re.compile(r"^[A-Za-z0-9_-]+$")
    for p in points:
        if not b64re.fullmatch(p["c"]) or not b64re.fullmatch(p["n"]):
            raise E2EError(f"point fields not b64url: {json.dumps(p)[:200]}")
        clen = len(b64u_decode(p["c"]))
        if clen != PAD_LEN + 16:
            raise E2EError(f"ciphertext length {clen}, want {PAD_LEN + 16}")
    want_cols = {"channel", "member", "alg", "pk", "last_ts", "srv"}
    for row in members:
        if set(row.keys()) != want_cols:
            raise E2EError(f"members table columns {sorted(row.keys())}, want {sorted(want_cols)}")
        if not re.fullmatch(r"[0-9a-f]{32}", row["channel"]):
            raise E2EError(f"bad channel in members row: {row['channel']}")
        if not re.fullmatch(r"[0-9a-f]{16}", row["member"]):
            raise E2EError(f"bad member id in members row: {row['member']}")
        if row["channel"] not in channels:
            raise E2EError("unexpected foreign channel in dump")
    log(f"zero-knowledge dump clean: {len(members)} members, {len(points)} points, "
        f"all ciphertext {PAD_LEN + 16} bytes")


def console_check(browsers):
    dirty = {}
    for b in browsers:
        errs = b.errors()
        for key, arr in errs.items():
            if arr:
                dirty[f"{b.name}.{key}"] = arr
    if dirty:
        raise E2EError(f"console errors: {json.dumps(dirty)[:1200]}")
    log("console clean in " + ", ".join(b.name for b in browsers))


def demo_shot():
    c = Browser("C", PORT_A)
    try:
        c.navigate(BASE + "/?demo=1")
        t_nav = time.time()
        wait_for(lambda: (c.state() or {}).get("demo") is True, timeout=20, desc="demo running")
        c.exec(INJECT)
        wait = 25 - (time.time() - t_nav)
        if wait > 0:
            log(f"demo mid-flight wait {wait:.0f}s")
            time.sleep(wait)
        sheet_to_peek(c)
        st = c.state()
        if not st.get("members"):
            raise E2EError("demo has no members")
        c.shot("06-demo.png")
        console_check([c])
    finally:
        c.close()


def port_free(port):
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=1)
        s.close()
        return False
    except OSError:
        return True


def main():
    os.makedirs(SHOTS, exist_ok=True)
    server = logfile = a = b = None
    try:
        server, logfile = start_server()
        a = Browser("A", PORT_A)
        invite_url, channel = flow_a_create(a)
        b = Browser("B", PORT_B)
        flow_b_join(b, invite_url, channel)
        cross_visibility(a, b)
        flagship_map_shots(a, b)
        move_checkin_sos_stop(a, b)
        chan2 = flow_multicircle(a, channel)
        zero_knowledge_dump({channel, chan2})
        console_check([a, b])
        a.close()
        a = None
        b.close()
        b = None
        demo_shot()
        log("E2E PASS")
        return 0
    except E2EError as e:
        log(f"E2E FAIL: {e}")
        return 1
    finally:
        for br in (a, b):
            if br:
                br.close()
        if server:
            server.terminate()
            try:
                server.wait(timeout=8)
            except subprocess.TimeoutExpired:
                server.kill()
        if logfile:
            logfile.close()
        for port in (HTTP_PORT, PORT_A, PORT_B):
            if not port_free(port):
                log(f"WARNING: port {port} still occupied after cleanup")


if __name__ == "__main__":
    sys.exit(main())
