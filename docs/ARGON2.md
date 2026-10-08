# Argon2id in the app lock

The app lock stretches your passcode with Argon2id before it wraps the vault
key. Argon2id is memory-hard: every guess costs the attacker the same 64 MiB
and three passes it costs your phone, so a GPU farm gets no shortcut the way
it does with PBKDF2. This page is about the one piece of that which is not
plain JavaScript: the WebAssembly module that does the work, and how to check
it is what it says it is.

## What ships

`app/js/argon2.wasm`, 12,782 bytes, SHA-256
`faf6ae0fae0fc3645131a1297a357cf1c50cea45f926285181f6960f514cf158`.

It is the Argon2 reference implementation, compiled as is. Nothing in it was
written for Starling except `tools/argon2/shim.c`: the five libc symbols the
reference calls (`memcpy`, `memset`, `strlen`, `malloc`, `free`), a bump
allocator over the module's own memory, and one exported function that fills
an `argon2_context` and calls the reference's `argon2_ctx`. The module
imports nothing. It cannot touch the network, the clock, storage, or any
memory outside its own, because WebAssembly gives a module no way to do any
of that without an import.

`app/js/argon2.js` loads it. Before the bytes are compiled they are hashed,
and the hash has to match the constant pinned in that file; if it does not,
the module never runs, and the lock screen reports a device problem instead
of a wrong passcode. Each hash runs in a
fresh instance whose memory is zeroed on the way out, so the 64 MiB goes back
to the system as soon as the key is derived.

## Parameters

64 MiB of memory, three passes, one lane, 32 byte output, Argon2 version
0x13. Those are the defaults KeePassXC and Bitwarden ship and sit above the
OWASP floor of 19 MiB and two passes. On a mid-range phone, opening the lock
takes about a second; a wrong passcode with a duress code set takes two,
because the duress check is a second Argon2id run on purpose.

A stored record names its own `t`, `m` and `p`. The loader refuses anything
outside 1 to 16 passes, 8 KiB to 256 MiB, 1 to 8 lanes before it asks for
memory, so a tampered record cannot turn a passcode check into an allocation of
gigabytes.

## Older installs

Records written before 0.16 wrapped the key with PBKDF2-SHA-256 at 600,000
iterations. They still open. The first time the passcode is typed, the app re-wraps the
vault key under Argon2id and writes the new record; the old one is replaced
only after the new one is on disk, so a crash in between changes nothing. A
biometric check never sees the passcode, so the switch waits for the next
time the passcode is typed. A duress code set before 0.16
keeps its PBKDF2 verifier until it is set again, since the app only has the
duress code in hand at the moment it is set.

## Rebuilding and checking it

```
bash tools/build-argon2.sh --check
```

clones the reference repository at commit `62358ba2123abd17fccf2a108a301d4b52c01a7c`
(tag `20190702`, the last release), checks the SHA-256 of every source file
the compiler reads against the list inside the script, compiles with clang's
bare `wasm32` target and no libc, links with `wasm-ld`, and compares the
result with the shipped file. Without `--check` it writes the file. The
shipped file is built with Debian 13's clang 19.1.7, because that is the
compiler on F-Droid's build server. F-Droid deletes the committed binary,
rebuilds it from the reference source during its own build (the script, with
the source handed over as a srclib through `ARGON2_SRC`) and gets the same
bytes, which is what lets its APK match the released one. Another clang
version produces different bytes for the same source (clang 22 gave a 12782
byte file where clang 19 gives 12790), so a mismatch from a different
compiler is a reason to diff the two with `wasm-objdump` or `wasm2wat`, not
proof of tampering. The source hashes are the part that holds regardless of
compiler. To reproduce the shipped bytes elsewhere, point `CLANG` and
`WASM_LD` at a 19.1.7 toolchain: on Arch `pacman -S clang19` then
`CLANG=/usr/lib/llvm19/bin/clang WASM_LD=/usr/lib/llvm19/bin/wasm-ld bash
tools/build-argon2.sh --check`; on Debian 13 `apt install clang lld` is
enough.

The flags are in the script. The ones that matter: `-ffreestanding
-nostdlib` (no libc at all), `-DARGON2_NO_THREADS` (one lane, no pthreads),
`-mbulk-memory` (so struct copies become `memory.copy` instead of libcalls),
`-O2`, `--gc-sections` (the reference's encoded string format and its
callers are dropped as unreachable; `encoding.c` is not compiled at all
because it wants `sprintf`).

`test/argon2.test.mjs` is the part CI runs on every push: the shipped bytes
hash to the pinned constant, the module's import list is empty and its
export list is exactly `memory`, `alloc`, `reset`, `argon2id`, the RFC 9106
Argon2id test vector comes out right, and seven vectors from the reference
implementation's own `test.c` do too.

## What this does not claim

The reference implementation is the one reviewed by the Password Hashing
Competition and specified in RFC 9106; this build does not change it, but
nobody outside this project has reviewed the shim or the build script. The
independent security review the README asks for would cover both. And
Argon2id raises the price of each guess, it does not make a four digit PIN
strong: the threat model's limits still apply.
