#!/usr/bin/env python3
"""End to end test: the v2 UI surfaces that flow_a_review_accept in
e2e_marionette.py only touches in passing. Two real headless Firefoxes, same
relay, same harness (Marionette client, Browser, wait_for) as
e2e_marionette.py, but this run walks the review sheet, the members screen,
the keys-and-history settings, per-viewer beacon links, and the alerts that
only a synthetic key change or a wrong clock can provoke.

Run from the repo root:  python3 test/e2e_v2_ui.py
Ports: 8931 (http), 2850/2851 (marionette). Everything started here is
killed before exit.
"""
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "test", "screenshots")
sys.path.insert(0, os.path.join(ROOT, "test"))
import e2e_marionette as E

E.SHOTS = SHOTS
E.HTTP_PORT = 8931
E.BASE = f"http://127.0.0.1:{E.HTTP_PORT}"
BASE = E.BASE
Browser, wait_for, log, E2EError = E.Browser, E.wait_for, E.log, E.E2EError

FAILS = []

# Sheets fade in over a couple of hundred milliseconds and the headless
# compositor is happy to hand back a frame from before that; let it settle.
_orig_shot = Browser.shot


def _settled_shot(self, name):
    time.sleep(0.7)
    return _orig_shot(self, name)


Browser.shot = _settled_shot


def check(name, cond, detail=""):
    if cond:
        log(f"  ok   {name}")
    else:
        log(f"  FAIL {name} {detail}")
        FAILS.append(f"{name} {detail}")


def q(b, script, *args):
    return b.exec(script, *args)


def start_server():
    env = dict(os.environ)
    env.update({"STARLING_TEST": "1", "RATE_POST_MIN": "100000", "RATE_GET_MIN": "100000"})
    logfile = open(os.path.join(tempfile.gettempdir(), "starling-v2ui-server.log"), "w")
    proc = subprocess.Popen(
        ["node", os.path.join(ROOT, "test", "serve_local.mjs"), str(E.HTTP_PORT)],
        cwd=ROOT, env=env, stdout=logfile, stderr=logfile)

    def health():
        with urllib.request.urlopen(BASE + "/api/v2/health", timeout=5) as r:
            return r.status == 200
    wait_for(health, timeout=20, desc="relay health", interval=0.3)
    log(f"server up on {BASE}")
    return proc, logfile


def visible(b, sel):
    return q(b, "var el=document.querySelector(arguments[0]);"
                "return !!el && !el.hidden && el.offsetParent !== null;", sel)


def text(b, sel):
    return q(b, "var el=document.querySelector(arguments[0]);return el?el.textContent.trim():null;", sel)


def type_in(b, sel, value):
    wait_for(lambda: q(b, "return !!document.querySelector(arguments[0])", sel), timeout=15,
             desc=f"{b.name} {sel}")
    b.send_keys(sel, value)


def main():
    os.makedirs(SHOTS, exist_ok=True)
    server = logfile = a = bb = None
    try:
        server, logfile = start_server()
        a = Browser("A", 2850)
        bb = Browser("B", 2851)

        # ---------------------------------------------------------- A creates
        a.navigate(BASE + "/")
        wait_for(lambda: a.state() is not None, timeout=20, desc="A boot")
        a.exec(E.INJECT)
        a.exec("window.__geoSet(40.7580, -73.9855)")
        a.click('[data-testid="onboarding-create"]')
        type_in(a, '[data-testid="identity-name"]', "Ana")
        type_in(a, '[data-testid="circle-name"]', "Trip")
        wait_for(lambda: not q(a, "return document.querySelector('[data-testid=\"identity-save\"]').disabled"),
                 timeout=10, desc="A save enabled")
        a.click('[data-testid="identity-save"]')

        # invite sheet, new shape
        wait_for(lambda: q(a, "var e=document.querySelector('[data-testid=\"invite-link\"]');"
                              "return e && e.textContent.indexOf('#j=') > 0;"),
                 timeout=25, desc="A invite link")
        invite_url = text(a, '[data-testid="invite-link"]')
        check("invite QR drawn", q(a, "return !!document.querySelector('[data-testid=\"invite-qr\"] svg')"))
        exp = text(a, '[data-testid="invite-expiry"]')
        check("invite says one use and an expiry", exp and "One use only" in exp and "expires in" in exp, repr(exp))
        wait_txt = text(a, '[data-testid="invite-waiting"]')
        check("invite shows the waiting state", wait_txt and "Nobody has used this link yet" in wait_txt, repr(wait_txt))
        a.shot("01-invite.png")

        # members screen, own safety number
        a.escape()
        wait_for(lambda: q(a, "return document.querySelector('.ov-wrap') === null"), timeout=10,
                 desc="A invite closed")
        check("people and keys button on the map", visible(a, '[data-testid="members-open"]'))
        a.click('[data-testid="members-open"]')
        wait_for(lambda: q(a, "var e=document.querySelector('[data-testid=\"own-safety\"]');"
                              "return e && /\\d{5}/.test(e.textContent);"),
                 timeout=15, desc="A own safety number")
        own_a = text(a, '[data-testid="own-safety"]')
        check("own safety number is six groups of five",
              len(own_a.split()) == 6 and all(len(g) == 5 and g.isdigit() for g in own_a.split()), repr(own_a))
        a.shot("02-members-alone.png")
        a.escape()

        # ------------------------------------------------------------ B joins
        bb.navigate(invite_url)
        wait_for(lambda: bb.state() is not None, timeout=20, desc="B boot")
        bb.exec(E.INJECT)
        bb.exec("window.__geoSet(40.7681, -73.9819)")
        wait_for(lambda: q(bb, "return !!document.querySelector('[data-testid=\"join-sheet\"]')"),
                 timeout=15, desc="B join sheet")
        type_in(bb, '[data-testid="identity-name"]', "Blair")
        wait_for(lambda: not q(bb, "return document.querySelector('[data-testid=\"join-confirm\"]').disabled"),
                 timeout=10, desc="B join enabled")
        b_cta = text(bb, '[data-testid="join-confirm"]')
        check("joiner CTA says it is a request", b_cta == "Ask to join", repr(b_cta))
        bb.click('[data-testid="join-confirm"]')

        wait_for(lambda: visible(bb, '[data-testid="join-waiting"]'), timeout=20, desc="B waiting card")
        wait_for(lambda: q(bb, "var e=document.querySelector('[data-testid=\"join-waiting-safety\"]');"
                               "return e && /\\d{5}/.test(e.textContent);"),
                 timeout=15, desc="B waiting safety number")
        own_b = text(bb, '[data-testid="join-waiting-safety"]')
        check("joiner sees its own safety number while waiting", len(own_b.split()) == 6, repr(own_b))
        check("joiner waiting copy explains the accept",
              "has to check your number and accept" in text(bb, "#join-waiting-text"))
        bb.shot("03-join-waiting.png")

        # ------------------------------------------------- A reviews and accepts
        wait_for(lambda: q(a, "return (window.__starlingState().joinRequests || 0) > 0"),
                 timeout=60, desc="A sees the request", nudge=a.nudge_poll)
        check("request raises an alert on the map",
              q(a, "return !!document.querySelector('[data-alert^=\"join:\"]')"))
        a.shot("04-request-alert.png")
        a.click('[data-testid="alert-review"]')
        wait_for(lambda: q(a, "return !!document.querySelector('[data-testid=\"join-review\"]')"),
                 timeout=15, desc="A review block")
        seen = text(a, '[data-testid="join-safety"]')
        check("A is shown exactly the number B is reading out", seen == own_b, f"{seen!r} vs {own_b!r}")
        check("review names the joiner",
              "Blair wants to join" in text(a, ".review-title"), repr(text(a, ".review-title")))
        a.shot("05-review.png")
        a.click('[data-testid="join-accept"]')
        wait_for(lambda: q(a, "return window.__starlingState().pinned === 1"), timeout=40,
                 desc="A pinned B")
        check("accepting re-keyed the circle", q(a, "return window.__starlingState().g") >= 1)
        check("the invitation was burned", q(a, "return window.__starlingState().invite") is False)

        check("accepting closes the spent invite sheet",
              q(a, "return document.querySelector('[data-testid=\"invite-sheet\"]') === null"))
        wait_for(lambda: q(bb, "return window.__starlingState().screen === 'map'"), timeout=60,
                 desc="B lands in the circle", nudge=bb.nudge_poll)
        check("B pinned A", q(bb, "return window.__starlingState().pinned") == 1)

        # ------------------------------------------------------- both sharing
        for br in (a, bb):
            br.click('[data-testid="share-toggle"]')
        wait_for(lambda: q(a, "return window.__starlingState().members.length") == 1, timeout=60,
                 desc="A sees B", nudge=a.nudge_poll)
        wait_for(lambda: q(bb, "return window.__starlingState().members.length") == 1, timeout=60,
                 desc="B sees A", nudge=bb.nudge_poll)

        # ---------------------------------------- foreground session card
        # canShareInBackground() is false on the web build, so sharing here runs
        # exactly as it does on iOS: foreground only.
        check("sharing on a foreground-only platform says so",
              q(a, "return !!document.querySelector('[data-alert=\"foreground\"]')"))
        fg = text(a, '[data-alert="foreground"] .notice-title')
        check("the foreground card carries a running timer and the reason",
              fg and "screen has to stay on" in fg
              and "no way to send a position in the background"
              in text(a, '[data-alert="foreground"] .notice-text'), repr(fg))
        a.shot("15-foreground.png")

        # ------------------------------------------- members screen with a peer
        a.click('[data-testid="members-open"]')
        wait_for(lambda: q(a, "var e=document.querySelector('[data-testid=\"member-safety\"]');"
                              "return e && /\\d{5}/.test(e.textContent);"),
                 timeout=15, desc="A member safety number")
        peer = text(a, '[data-testid="member-safety"]')
        check("A sees B's number and it matches B's own", peer == q(bb, """
            var e = document.querySelector('[data-testid="own-safety"]');
            return e ? e.textContent.trim() : null;""") or peer.split() == own_b.split(), repr(peer))
        check("row starts Not verified", text(a, ".verify-pill") == "Not verified")
        a.shot("06-members-unverified.png")
        a.click('[data-testid="member-verify"]')
        wait_for(lambda: text(a, ".verify-pill") == "Verified", timeout=10, desc="A verified B")
        check("verify action flips the pill and the button",
              text(a, '[data-testid="member-verify"]') == "Mark not verified")
        a.shot("07-members-verified.png")
        check("remove is one tap away with its cost spelled out",
              q(a, "return document.querySelector('[data-testid=\"member-remove\"]') !== null"))
        a.click('[data-testid="member-remove"]')
        rem = text(a, '[data-testid="member-row"] .confirm-box .ov-note')
        check("removal copy names the person and what they lose",
              rem and "Blair" in rem and "new keys" in rem, repr(rem))
        a.shot("08-remove-confirm.png")
        a.escape()

        # --------------------------------------------- keys and history settings
        a.click('[data-testid="settings-open"]')
        wait_for(lambda: q(a, "return !!document.querySelector('[data-testid=\"rekey-open\"]')"),
                 timeout=15, desc="A settings keys group")
        titles = q(a, "return [...document.querySelectorAll('.set-title')].map(function(n){return n.textContent});")
        check("settings has a Keys and history group", "Keys and history" in titles, repr(titles))
        hist = q(a, """
            var f = [...document.querySelectorAll('.field')].find(function (n) {
              var l = n.querySelector('.field-label');
              return l && l.textContent === 'How far back you can see';
            });
            if (!f) return null;
            return {
              cells: [...f.querySelectorAll('.seg-cell')].map(function (c) { return c.textContent; }),
              note: f.querySelector('.field-note').textContent,
            };""")
        check("history window offers the protocol's four choices",
              hist and hist["cells"] == ["10 minutes", "1 hour", "6 hours", "24 hours"], repr(hist))
        check("history note states the trade both ways",
              hist and "You can see the last" in hist["note"] and "taken from you" in hist["note"],
              repr(hist and hist["note"]))
        check("steady sending sits with it",
              q(a, "return [...document.querySelectorAll('.switch-label')]"
                   ".some(function(n){return n.textContent === 'Steady sending'});"))
        # pick the high-risk window, which the app pairs with steady sending
        q(a, """
            var f = [...document.querySelectorAll('.field')].find(function (n) {
              var l = n.querySelector('.field-label');
              return l && l.textContent === 'How far back you can see';
            });
            f.querySelectorAll('.seg-cell')[0].click();""")
        time.sleep(0.5)
        note2 = q(a, """
            var f = [...document.querySelectorAll('.field')].find(function (n) {
              var l = n.querySelector('.field-label');
              return l && l.textContent === 'How far back you can see';
            });
            return f.querySelector('.field-note').textContent;""")
        check("the note follows the choice", "almost nothing" in note2, repr(note2))
        steady = q(a, """
            var r = [...document.querySelectorAll('.switch-row')].find(function (n) {
              return n.querySelector('.switch-label').textContent === 'Steady sending';
            });
            return r.querySelector('.switch').getAttribute('aria-checked');""")
        check("the high-risk window turns steady sending on in front of you", steady == "true", repr(steady))
        a.shot("09-settings-keys.png")

        gen_before = q(a, "return window.__starlingState().g")
        a.click('[data-testid="rekey-open"]')
        rk = text(a, '[data-testid="rekey-confirm"]')
        check("new keys now explains itself before it fires", rk == "Make new keys", repr(rk))
        a.click('[data-testid="rekey-confirm"]')
        wait_for(lambda: q(a, "return window.__starlingState().g") > gen_before, timeout=40,
                 desc="A re-keyed")
        a.escape()

        # B should hear about it, attributed
        wait_for(lambda: q(bb, "return !!document.querySelector('[data-alert=\"rekey\"]')"),
                 timeout=60, desc="B sees the attributed re-key", nudge=bb.nudge_poll)
        rekey_title = text(bb, '[data-alert="rekey"] .notice-title')
        check("re-key notice names who did it", rekey_title == "Ana changed the keys", repr(rekey_title))
        bb.shot("10-rekey-notice.png")

        # ------------------------------------------------ key change warning
        # No honest way to provoke this from outside: a member id commits to the
        # keys, so a real change needs a preimage. The state is injected and only
        # the rendering is under test here.
        bb.exec("""
            var api = window.__starlingApi;
            var id = [...api.state.pinned.keys()][0];
            api.state.keyChanges.set(id, {
              presented: { alg: "p256", pk: "x", epk: "y" },
              was: null,
              oldSafety: "11111 22222 33333 44444 55555 66666",
              newSafety: "99999 88888 77777 66666 55555 44444",
              at: Date.now(),
            });
            window.dispatchEvent(new Event("online"));""")
        wait_for(lambda: visible(bb, "#banner-keys"), timeout=10, desc="B key banner")
        check("key change reaches the chrome banner",
              text(bb, "#banner-keys-text") == "Ana's keys changed", repr(text(bb, "#banner-keys-text")))
        check("key change also raises a top alert",
              q(bb, "return !!document.querySelector('[data-alert^=\"key:\"]')"))
        bb.shot("11-key-change-banner.png")
        bb.click('[data-testid="alert-keys"]')
        wait_for(lambda: q(bb, "return !!document.querySelector('[data-testid=\"key-change\"]')"),
                 timeout=15, desc="B key change block")
        pair = q(bb, "return [...document.querySelectorAll('[data-testid=\"key-change\"] .safety')]"
                     ".map(function(n){return n.textContent});")
        check("old and new numbers are shown together",
              pair == ["11111222223333344444555556666", "99999888887777766666555554444"]
              or (len(pair) == 2 and "11111" in pair[0] and "99999" in pair[1]), repr(pair))
        check("accepting is an explicit action",
              q(bb, "return !!document.querySelector('[data-testid=\"key-accept\"]')"))
        bb.shot("12-key-change-sheet.png")
        bb.click('[data-testid="key-accept"]')
        wait_for(lambda: q(bb, "return window.__starlingState().keyChanges.length") == 0, timeout=15,
                 desc="B accepted the new keys")
        bb.escape()

        # ------------------------------------------------- SOS beacon viewers
        bb.click('[data-testid="sos-button"]')
        wait_for(lambda: visible(bb, '[data-testid="sos-help"]'), timeout=30, desc="B help button")
        bb.click('[data-testid="sos-help"]')
        wait_for(lambda: q(bb, "var e=document.querySelector('[data-testid=\"viewer-link\"]');"
                               "return e && e.textContent.indexOf('#b=') > 0;"),
                 timeout=20, desc="B first help link")
        check("the first link is listed with who it is for and when it dies",
              text(bb, ".viewer-label") == "Help link"
              and "Expires in" in text(bb, ".viewer-when"), text(bb, ".viewer-when"))
        type_in(bb, '[data-testid="viewer-label"]', "Neighbour Sam")
        bb.click('[data-testid="viewer-add"]')
        wait_for(lambda: q(bb, "return document.querySelectorAll('[data-testid=\"viewer-row\"]').length") == 2,
                 timeout=20, desc="B second help link")
        links = q(bb, "return [...document.querySelectorAll('[data-testid=\"viewer-link\"]')]"
                      ".map(function(n){return n.textContent});")
        check("each viewer gets its own link", len(links) == 2 and links[0] != links[1])
        labels = q(bb, "return [...document.querySelectorAll('.viewer-label')].map(function(n){return n.textContent});")
        check("labels say who each link was for", labels == ["Help link", "Neighbour Sam"], repr(labels))
        bb.shot("13-help-viewers.png")
        bb.exec("document.querySelectorAll('[data-testid=\"viewer-revoke\"]')[0].click()")
        wait_for(lambda: q(bb, "return [...document.querySelectorAll('.viewer-when')]"
                               ".map(function(n){return n.textContent})[0] === 'Revoked';"),
                 timeout=20, desc="B revoked the first link")
        after = q(bb, "return [...document.querySelectorAll('[data-testid=\"viewer-link\"]')]"
                      ".filter(function(n){return n.offsetParent !== null}).length;")
        check("revoking cuts one link and leaves the rest", after == 1, repr(after))
        bb.shot("14-help-revoked.png")
        bb.escape()

        # ------------------------------------------------ wrong clock, install
        # Both are injected state: a refused epoch needs a relay that disagrees
        # about the time, and iOS is not something Firefox can be talked into.
        # Only the rendering is under test.
        a.exec("""
            window.__starlingApi.state.clockError = { skewMs: 25 * 60000, at: Date.now() };
            window.dispatchEvent(new Event("online"));""")
        wait_for(lambda: q(a, "return !!document.querySelector('[data-alert=\"clock\"]')"),
                 timeout=10, desc="A clock alert")
        clock = text(a, '[data-alert="clock"] .notice-text')
        check("the clock error says you are invisible and by how much",
              clock and "cannot see you" in clock and "25 minutes behind" in clock, repr(clock))
        check("the you line stops claiming you are live",
              text(a, "#you-sub") == "Not visible: this phone's clock is wrong",
              repr(text(a, "#you-sub")))
        a.exec("""
            window.__starlingApi.state.clockError = null;
            Object.defineProperty(navigator, "standalone", { value: false, configurable: true });
            window.dispatchEvent(new Event("online"));""")
        wait_for(lambda: q(a, "return !!document.querySelector('[data-alert=\"install\"]')"),
                 timeout=10, desc="A install nudge")
        check("the home-screen nudge explains what a tab costs",
              "throw your circle's keys away" in text(a, '[data-alert="install"] .notice-text'))
        a.shot("17-install-nudge.png")
        a.click('[data-testid="alert-install-no"]')
        wait_for(lambda: q(a, "return document.querySelector('[data-alert=\"install\"]') === null"),
                 timeout=10, desc="A install nudge dismissed")
        check("the nudge takes an answer and stays gone",
              q(a, "return window.__starlingApi.state.installDismissed") is True)

        # ------------------------------------------------------ console clean
        for br in (a, bb):
            errs = br.errors()
            noisy = [e for e in (errs["__errs"] or []) if "NetworkError" not in e]
            check(f"{br.name} console clean", not noisy and not errs["__starlingErrors"],
                  repr(errs))

        # A screenshot of the alert stack itself: the bottom sheet sits at peek
        # for the rest of this run, and its body is inert there by design.
        a.navigate(BASE + "/?sheet=full")
        wait_for(lambda: q(a, "return window.__starlingState().screen === 'map'"), timeout=30,
                 desc="A reopened")
        a.exec("""
            window.__starlingApi.state.clockError = { skewMs: 25 * 60000, at: Date.now() };
            window.__starlingApi.state.installDismissed = false;
            Object.defineProperty(navigator, "standalone", { value: false, configurable: true });
            window.dispatchEvent(new Event("online"));""")
        wait_for(lambda: q(a, "return document.querySelectorAll('#alerts .notice').length") >= 2,
                 timeout=10, desc="A alert stack")
        a.shot("16-alerts.png")

        log("FAILS: " + (", ".join(FAILS) if FAILS else "none"))
        return 1 if FAILS else 0
    except E2EError as e:
        log(f"HARNESS FAIL: {e}")
        return 2
    finally:
        for br in (a, bb):
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


if __name__ == "__main__":
    sys.exit(main())
