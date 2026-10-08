#!/bin/bash
# Builds app/js/argon2.wasm from the Argon2 reference implementation, pinned
# to one commit and to the SHA-256 of every source file that goes into the
# module, with clang's bare wasm32 target and no libc. The result has no
# imports at all. docs/ARGON2.md explains the choices; test/argon2.test.mjs
# holds the shipped file to the hash pinned in app/js/argon2.js and to the
# RFC 9106 test vector.
#
#   bash tools/build-argon2.sh          rebuild app/js/argon2.wasm
#   bash tools/build-argon2.sh --check  rebuild to a temp file and compare
#
# Needs clang and wasm-ld (the LLVM linker) with the wasm32 target, and git.
# The shipped file comes from Debian 13's clang 19.1.7, the compiler on
# F-Droid's build server; CLANG and WASM_LD point the script at that version
# on another distro, and ARGON2_SRC names an existing checkout of the
# reference tree (F-Droid passes its srclib) instead of cloning one.
set -euo pipefail
cd "$(dirname "$0")/.."

ARGON2_REPO=https://github.com/P-H-C/phc-winner-argon2
ARGON2_COMMIT=62358ba2123abd17fccf2a108a301d4b52c01a7c   # tag 20190702
OUT=app/js/argon2.wasm
CLANG="${CLANG:-clang}"
WASM_LD="${WASM_LD:-wasm-ld}"

tmpsrc=
if [ -n "${ARGON2_SRC:-}" ]; then
  src=$ARGON2_SRC
  [ "$(git -C "$src" rev-parse HEAD)" = "$ARGON2_COMMIT" ] || { echo "ARGON2_SRC is not at $ARGON2_COMMIT"; exit 1; }
else
  tmpsrc=$(mktemp -d)
  src=$tmpsrc
  trap 'rm -rf "$tmpsrc"' EXIT
  git clone -q "$ARGON2_REPO" "$src"
  git -C "$src" checkout -q "$ARGON2_COMMIT"
fi

# Every file the compiler reads from the reference tree. A mismatch here is
# a different Argon2 than the one that was reviewed, so it stops the build.
(cd "$src" && sha256sum -c --quiet /dev/stdin) <<'SUMS'
df20cb726a2fe6bccc736b81ea0d86219766a0d17f1794c19e048a34830ca1cc  include/argon2.h
72a93deebc5fd76bec0c6d300a2d92b500fb354b26babbddbc6d8b88681e663d  src/argon2.c
0f53eb2370f8971f04fcf043b8083bf81d1530c48b2ead71c0b6c4e22a01aeec  src/core.c
c9665623cb3d306f63b6a3effd87bcfab971c28253c77e111445e42c1523235e  src/core.h
42f283d12ec445cfb423ac2f1f5a5d1a7f152ce2b9363f6ec3e1d5b61cd4ee6d  src/encoding.h
d3a2861d057d5cf19cbb11911d61724b2803fd997f2600bb17c9399f52a8fdf6  src/genkat.h
4ec47b080c22f4ee416b9dbcfae70ee6007fcfba427f870d7b84395846fa1bc7  src/ref.c
9eab7f9ff356862a00a3075478dd0059344953ed79daab8b29185be2010efe78  src/thread.h
3c2de197dd23179f78c57deac7b73a6049778bf651c5db57e508b2cfce5e7559  src/blake2/blake2.h
8ac91f1f57d94235f8de0069b7809be1deb365c3b37adb8e30423cd364aff09a  src/blake2/blake2-impl.h
52519ccbc1e48f489ff444091f630d05dadcc8f1ee61c5b7361e3a9618299c9a  src/blake2/blake2b.c
bcfdcf785218cf897f05b144e80b659e611188fee3887d533bdcb7a6aa4c336b  src/blake2/blamka-round-ref.h
SUMS

obj=$(mktemp -d)
trap 'rm -rf "$obj" ${tmpsrc:+"$tmpsrc"}' EXIT
cflags=(--target=wasm32 -nostdlib -ffreestanding -O2 -mbulk-memory -DARGON2_NO_THREADS
  -Itools/argon2/include "-I$src/include" "-I$src/src")
for f in argon2 core ref blake2/blake2b; do
  "$CLANG" "${cflags[@]}" -c "$src/src/$f.c" -o "$obj/$(basename "$f").o"
done
# -fno-builtin keeps clang from turning the shim's own byte loops back into
# calls to the memset and memcpy they implement.
"$CLANG" "${cflags[@]}" -fno-builtin -c tools/argon2/shim.c -o "$obj/shim.o"

# encoding.c (the "$argon2id$..." string format) is not compiled: the lock
# stores raw bytes, and that file wants sprintf. The functions in argon2.c
# that reference it are unreachable from the export and --gc-sections drops
# them; --unresolved-symbols lets the link finish without inventing imports,
# and the test that the module imports nothing is what proves it did not.
"$WASM_LD" --no-entry --export=memory --strip-all --gc-sections --unresolved-symbols=ignore-all \
  -o "$obj/argon2.wasm" "$obj/argon2.o" "$obj/core.o" "$obj/ref.o" "$obj/blake2b.o" "$obj/shim.o"

sum=$(sha256sum "$obj/argon2.wasm" | cut -d' ' -f1)
if [ "${1:-}" = "--check" ]; then
  have=$(sha256sum "$OUT" | cut -d' ' -f1)
  if [ "$sum" = "$have" ]; then
    echo "argon2.wasm reproduces: $sum"
  else
    echo "argon2.wasm differs: built $sum, shipped $have"
    echo "(a different clang version is the usual reason; docs/ARGON2.md lists the one used)"
    exit 1
  fi
else
  cp "$obj/argon2.wasm" "$OUT"
  echo "wrote $OUT ($(stat -c %s "$OUT") bytes) sha256 $sum"
  echo "clang: $("$CLANG" --version | head -1)"
fi
