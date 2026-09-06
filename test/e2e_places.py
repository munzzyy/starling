#!/usr/bin/env python3
"""End to end: places. Two real headless Firefoxes on one relay. A creates a
circle and saves a place at her own position; B joins, shares from across the
park, then walks into the place. What must hold: the place exists only on A's
device (B's storage and the relay never see it), A's own line and B's member
card both say where they are, rename and radius edits stick, and the whole
list survives a reload.

Run from the repo root:  python3 test/e2e_places.py
Ports: 8932 (http), 2852/2853 (marionette). Everything started here is
killed before exit.
"""
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "test", "screenshots")
sys.path.insert(0, os.path.join(ROOT, "test"))
import e2e_marionette as E

E.SHOTS = SHOTS
E.HTTP_PORT = 8932
E.BASE = f"http://127.0.0.1:{E.HTTP_PORT}"
BASE = E.BASE
Browser, wait_for, log, E2EError = E.Browser, E.wait_for, E.log, E.E2EError

FAILS = []


def check(name, cond, detail=""):
    if cond:
        log(f"  ok   {name}")
    else:
        log(f"  FAIL {name} {detail}")
        FAILS.append(f"{name} {detail}")


def q(b, script, *args):
    return b.exec(script, *args)


def member_sub(b, name):
    return q(b,
        "var cards = document.querySelectorAll('.member-card');"
        "for (var i = 0; i < cards.length; i++) {"
        "  var n = cards[i].querySelector('.mc-name');"
        "  if (n && n.textContent === arguments[0])"
        "    return cards[i].querySelector('.mc-sub').textContent;"
        "} return null;", name)


def open_places(b):
    b.click('[data-testid="places-open"]')
    wait_for(lambda: q(b, "return !!document.querySelector('[data-testid=\"places-sheet\"]')"),
             timeout=10, desc="places sheet")


def main():
    os.makedirs(SHOTS, exist_ok=True)
    server, logfile = E.start_server()
    a = bb = None
    try:
        a = Browser("A", 2852)
        bb = Browser("B", 2853)

        invite_url, _ = E.flow_a_create(a)
        b_safety = E.flow_b_join(bb, invite_url)
        E.flow_a_review_accept(a, b_safety)
        channel = E.flow_b_admitted(a, bb)

        # A saves a place at her own position, from the sheet tools.
        open_places(a)
        check("places sheet says local-only out loud", q(a,
            "var s = document.querySelector('[data-testid=\"places-sheet\"]');"
            "return s && s.textContent.indexOf('only on this phone') >= 0;"))
        a.send_keys('[data-testid="place-name-input"]', "Front Porch")
        a.click('[data-testid="place-add-here"]')
        wait_for(lambda: q(a, "return document.querySelectorAll('.place-row').length"),
                 timeout=10, desc="A place row")
        time.sleep(0.7)
        a.shot("20-places-sheet.png")
        a.escape()
        E.wait_overlay_gone(a)

        check("place ring drawn on A's map",
              q(a, "return document.querySelectorAll('.place-ring').length") == 1)
        wait_for(lambda: "At Front Porch" in (q(a, "return document.getElementById('you-sub').textContent") or ""),
                 timeout=15, desc="A's own line says At Front Porch")
        check("A's own line says At Front Porch", True)

        # The relay must not have learned the place exists. Its store is
        # reachable over http in test mode: dump the feed and grep.
        _, body = E.http_get(f"/api/v2/f/{channel}")
        check("relay feed carries no place name", "Front Porch" not in body)
        check("relay feed carries no place coordinates", str(E.TIMES_SQ[0]) not in body)

        # B is across the park: visible, but not at the place.
        wait_for(lambda: member_sub(a, "Blair") is not None, timeout=30,
                 desc="A sees B's card", nudge=a.nudge_poll)
        check("B's card does not claim the place",
              "At Front Porch" not in (member_sub(a, "Blair") or ""))

        # B knows nothing about A's places: not in state, not on the map.
        check("B has no place rings",
              q(bb, "return document.querySelectorAll('.place-ring').length") == 0)
        check("B's storage holds no places", not q(bb,
            "return new Promise(function (res) {"
            "  var req = indexedDB.open('starling');"
            "  req.onsuccess = function () {"
            "    var db = req.result;"
            "    try {"
            "      var t = db.transaction('kv').objectStore('kv').get('places');"
            "      t.onsuccess = function () { res(!!(t.result && t.result.length)); };"
            "      t.onerror = function () { res(false); };"
            "    } catch (e) { res(false); }"
            "  };"
            "  req.onerror = function () { res(false); };"
            "});"))

        # B walks into the place; A's card for B picks it up from ciphertext
        # positions alone.
        bb.exec(f"window.__geoSet({E.TIMES_SQ[0]}, {E.TIMES_SQ[1]})")
        wait_for(lambda: "At Front Porch" in (member_sub(a, "Blair") or ""), timeout=45,
                 desc="A sees Blair at HQ", nudge=a.nudge_poll)
        check("B's card says At Front Porch after arriving", True)
        time.sleep(0.7)
        a.shot("21-member-at-place.png")

        # A status caption set on B rides the encrypted payload to A's card.
        bb.click('[data-testid="status-open"]')
        wait_for(lambda: q(bb, "return !!document.querySelector('[data-testid=\"status-sheet\"]')"),
                 timeout=10, desc="B status sheet")
        bb.send_keys('[data-testid="status-input"]', "omw north gate")
        bb.click('[data-testid="status-save"]')
        wait_for(lambda: '"omw north gate"' in (member_sub(a, "Blair") or ""), timeout=30,
                 desc="A sees B's caption", nudge=a.nudge_poll)
        check("B's caption reaches A's card", True)
        check("relay feed never carries the caption", "omw north gate" not in E.http_get(f"/api/v2/f/{channel}")[1])

        # Rename and radius edits stick, and rename flows into the card line.
        open_places(a)
        q(a,
          "var i = document.querySelector('.place-name');"
          "i.value = 'Base';"
          "i.dispatchEvent(new Event('change', { bubbles: true }));"
          "return true;")
        wait_for(lambda: "At Base" in (member_sub(a, "Blair") or ""), timeout=15,
                 desc="rename reaches the member card")
        check("rename reaches the member card", True)
        clicked = q(a,
            "var cells = document.querySelectorAll('.place-row .seg-cell');"
            "for (var i = 0; i < cells.length; i++) {"
            "  if (cells[i].textContent.indexOf('500') >= 0) { cells[i].click(); return true; }"
            "} return false;")
        check("radius cell clickable", clicked)
        a.escape()
        E.wait_overlay_gone(a)

        # The list survives a reload: loadPlaces runs on entering the circle.
        a.navigate(BASE + "/")
        wait_for(lambda: a.state() is not None, timeout=20, desc="A reboot")
        a.exec(E.INJECT)
        a.exec(f"window.__geoSet({E.TIMES_SQ[0]}, {E.TIMES_SQ[1]})")
        wait_for(lambda: q(a, "return document.querySelectorAll('.place-ring').length") == 1,
                 timeout=20, desc="place ring after reload")
        check("place survives a reload", True)
        open_places(a)
        check("radius survived as 500 m", q(a,
            "var sel = document.querySelector('.place-row .seg-cell.sel');"
            "return sel && sel.textContent.indexOf('500') >= 0;"))
        a.escape()

        # Removing the place clears the card line without an announcement.
        open_places(a)
        a.click(".place-remove")
        wait_for(lambda: q(a, "return document.querySelectorAll('.place-row').length") == 0,
                 timeout=10, desc="place removed")
        a.escape()
        E.wait_overlay_gone(a)
        wait_for(lambda: "At Base" not in (member_sub(a, "Blair") or ""), timeout=15,
                 desc="card line dropped the place")
        check("removing the place clears the card line", True)
        check("ring removed from the map",
              q(a, "return document.querySelectorAll('.place-ring').length") == 0)

        for br in (a, bb):
            errs = br.errors()
            noisy = [e for e in (errs["__errs"] or []) if "NetworkError" not in e]
            check(f"{br.name} console clean", not noisy and not errs["__starlingErrors"],
                  repr(errs))
    finally:
        for br in (a, bb):
            if br:
                br.close()
        server.terminate()
        server.wait(timeout=10)
        logfile.close()

    if FAILS:
        log("FAILS:")
        for f in FAILS:
            log(f"  {f}")
        sys.exit(1)
    log("E2E PLACES PASS")


if __name__ == "__main__":
    main()
