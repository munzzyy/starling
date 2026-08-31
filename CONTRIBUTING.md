# Contributing

Thanks for looking. Starling is a small, dependency-free codebase and I want to
keep it that way.

## Getting set up

No build step, no install for the app itself.

```
node --test test/*.test.mjs      # the unit suite (153 tests)
node test/serve_local.mjs 8899   # run the app + relay locally on one origin
```

The two-browser end to end tests need headless Firefox:

```
python3 test/e2e_marionette.py   # full sharing scenario + screenshots
python3 test/e2e_lock.py         # the app-lock lifecycle
```

## Ground rules

- **Zero runtime dependencies.** The app, the relay, and the tests are stdlib
  and platform APIs only. A pull request that adds a dependency needs to justify
  why the thing it saves is worth the supply-chain cost.
- **The protocol is the contract.** `app/js/crypto.js` and `app/js/wire.js` are
  frozen. If a change needs to alter the wire format or crypto, it changes
  `docs/PROTOCOL.md` in the same pull request and bumps the version, and the
  reasoning goes in the description.
- **Never trust a decrypted field.** Member names, statuses, and numbers come
  from other people. They reach the DOM through `textContent` and
  `createElement`, never `innerHTML` or a string of HTML.
- **A change ships with a test.** New behavior gets a unit test; a bug fix gets
  a test that fails before the fix.
- **Keep the README honest.** Every claim in it must be true of the code at that
  commit. If behavior changes, the docs change with it.

## Style

Plain, direct comments only where the code cannot say it. No em or en dashes
anywhere, including comments and copy. `bash tools/check-clean.sh` enforces that
and runs in CI.

## Before you open a pull request

- `node --test test/*.test.mjs` is green.
- `bash tools/check-clean.sh` is clean.
- If you touched the UI, include a screenshot.

Security issues do not go in a public issue. See `SECURITY.md`.
