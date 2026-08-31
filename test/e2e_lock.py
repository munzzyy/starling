#!/usr/bin/env python3
"""App-lock end to end: create a circle, turn on the passcode lock, reload, and
prove the app comes back locked, rejects a wrong passcode, unlocks with the
right one into the same circle, and stores no plaintext secret at rest.

Reuses the Marionette harness from e2e_marionette.py. Biometric (WebAuthn PRF)
cannot run in headless Firefox with no authenticator, so this covers the
passcode path; the biometric wrapper is unit-tested at the crypto layer and
degrades to a disabled control when no platform authenticator is present.
"""
import sys
import time

import e2e_marionette as e
from e2e_marionette import Browser, log, wait_for, E2EError, start_server, BASE


def get_idb(b, key):
    """Return 'present' if the app persisted this IDB key, else None. Uses an
    async Marionette script because IndexedDB is callback-based."""
    res = b.client.command(
        "WebDriver:ExecuteAsyncScript",
        {
            "script": """
              const key = arguments[0];
              const done = arguments[arguments.length - 1];
              const r = indexedDB.open('starling', 1);
              r.onsuccess = () => {
                try {
                  const tx = r.result.transaction('kv', 'readonly');
                  const g = tx.objectStore('kv').get(key);
                  g.onsuccess = () => done(g.result === undefined ? null : 'present');
                  g.onerror = () => done('err');
                } catch (e) { done('noStore'); }
              };
              r.onerror = () => done('openErr');
            """,
            "args": [key],
        },
    )
    return res.get("value") if isinstance(res, dict) else res


def main():
    server, logfile = start_server()
    b = None
    try:
        b = Browser("lock", 2860)
        b.navigate(BASE + "/")
        wait_for(lambda: b.state() is not None, timeout=20, desc="app boot")
        wait_for(lambda: b.state().get("screen") == "onboarding", timeout=10, desc="onboarding")

        # Create a circle.
        b.click('[data-testid="onboarding-create"]')
        e.type_name_and_confirm(b, "Vault", "identity-save")
        wait_for(lambda: b.state().get("screen") == "map", timeout=15, desc="map after create")
        channel = b.state().get("channel")
        if not channel or len(channel) != 32:
            raise E2EError(f"bad channel after create: {channel!r}")
        log(f"circle created, channel {channel[:8]}...")
        b.escape()  # close the invite sheet the create flow opens

        # Plaintext secret is on disk before lock is enabled.
        if get_idb(b, "secret") != "present":
            raise E2EError("expected plaintext secret before lock")
        log("pre-lock: plaintext secret present (as expected)")

        # Turn on app lock through settings.
        b.click('[data-testid="settings-open"]')
        wait_for(lambda: b.exec("return !!document.querySelector('[data-testid=\"settings-sheet\"]')"),
                 timeout=10, desc="settings open")
        # The App-lock switch is the switch inside the App lock group. Click the
        # "Require passcode" switch by walking to it, then fill the passcode sheet.
        b.exec(
            "const g=[...document.querySelectorAll('.set-group')].find(s=>/App lock/.test(s.textContent));"
            "if(!g) return false; g.querySelector('.switch').click(); return true;"
        )
        wait_for(lambda: b.exec("return !!document.querySelector('[data-testid=\"passcode-sheet\"]')"),
                 timeout=10, desc="passcode sheet")
        b.send_keys('[data-testid="passcode-input"]', "246810")
        b.send_keys('[data-testid="passcode-confirm"]', "246810")
        b.click('[data-testid="passcode-save"]')
        wait_for(lambda: b.state().get("lockEnabled") is True, timeout=15, desc="lock enabled")
        log("app lock enabled")

        # At rest now: sealed vaultSecret present, plaintext secret gone.
        if get_idb(b, "secret") != None:  # noqa: E711
            raise E2EError("plaintext secret must be deleted once lock is on")
        if get_idb(b, "vaultSecret") != "present":
            raise E2EError("sealed vaultSecret must be stored once lock is on")
        if get_idb(b, "lock") != "present":
            raise E2EError("lock record must be stored")
        log("at rest: plaintext secret gone, sealed vaultSecret + lock record present")

        # Reload: the app must come back LOCKED.
        b.navigate(BASE + "/")
        wait_for(lambda: b.state() is not None, timeout=20, desc="reboot")
        wait_for(lambda: b.state().get("locked") is True, timeout=10, desc="locked after reload")
        if b.state().get("screen") != "lock":
            raise E2EError(f"expected lock screen, got {b.state().get('screen')}")
        if b.state().get("channel") is not None:
            raise E2EError("channel must not be derivable while locked")
        b.shot("07-lock.png")
        log("reload: app is locked, no channel in state")

        # Wrong passcode is rejected and stays locked.
        b.send_keys('[data-testid="lock-input"]', "000000")
        b.click('[data-testid="lock-unlock"]')
        time.sleep(1.5)  # PBKDF2 derive
        if b.state().get("locked") is not True:
            raise E2EError("wrong passcode must not unlock")
        err_shown = b.exec("const e=document.querySelector('#lock-error'); return e && !e.hidden")
        if not err_shown:
            raise E2EError("wrong passcode must show an error")
        log("wrong passcode rejected, still locked")

        # Right passcode unlocks into the SAME circle.
        b.exec("document.querySelector('[data-testid=\"lock-input\"]').value='';")
        b.send_keys('[data-testid="lock-input"]', "246810")
        b.click('[data-testid="lock-unlock"]')
        wait_for(lambda: b.state().get("locked") is False, timeout=15, desc="unlock")
        wait_for(lambda: b.state().get("screen") == "map", timeout=10, desc="map after unlock")
        if b.state().get("channel") != channel:
            raise E2EError(f"unlocked into a different channel: {b.state().get('channel')} != {channel}")
        log("right passcode unlocked into the same circle")

        # Console must be clean throughout.
        errs = b.errors()
        dirty = [v for v in (errs.get("__starlingErrors") or []) if v]
        if dirty:
            raise E2EError(f"console errors: {dirty}")
        log("console clean")

        log("E2E LOCK PASS")
        return 0
    finally:
        if b:
            b.close()
        server.terminate()
        try:
            server.wait(timeout=8)
        except Exception:
            server.kill()
        logfile.close()


if __name__ == "__main__":
    sys.exit(main())
