#!/bin/bash
# Builds the world server (CMaNGOS classic at the pinned commit, with core.patch applied) as wasm.
#
# Needs: an activated Emscripten, cmake, ninja, and the libraries from build-deps.sh.
#   ELECTRODE_WEB_BUILD  build root; the patched core source is expected in $ELECTRODE_WEB_BUILD/server/src-core
#   BOOST_SRC            an unpacked boost_1_87_0 source tree (headers)
#   ZLIB_SRC             optional: a zlib source tree, to skip the download at configure time
# usage: build-server.sh [configure] [build]   (no argument: both)
set -euo pipefail
: "${ELECTRODE_WEB_BUILD:?set ELECTRODE_WEB_BUILD}"
: "${BOOST_SRC:?set BOOST_SRC}"
SRC="$ELECTRODE_WEB_BUILD/server/src-core"
OUT="$ELECTRODE_WEB_BUILD/server/build"
DEPS="$ELECTRODE_WEB_BUILD/server/deps"
JOBS="${JOBS:-14}"
WHAT="${*:-configure build}"

# Windows drive paths as the compiler sees them (C:/...), so the prefix maps match.
native() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
SRC_N="$(native "$SRC")"; BOOST_N="$(native "$BOOST_SRC")"; DEPS_N="$(native "$DEPS")"; OUT_N="$(native "$OUT")"

# No build path may end up in the binary: every source root is renamed.
MAPS="-ffile-prefix-map=$SRC_N=core -ffile-prefix-map=$BOOST_N=boost -ffile-prefix-map=$DEPS_N=deps -ffile-prefix-map=$OUT_N=build"
CFLAGS="-pthread -fwasm-exceptions $MAPS"
CXXFLAGS="$CFLAGS -DBOOST_STACKTRACE_USE_NOOP"
LINK="-fwasm-exceptions -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=4294967296"
LINK="$LINK -sSTACK_SIZE=4194304 -sDEFAULT_PTHREAD_STACK_SIZE=2097152 -sENVIRONMENT=web,worker,node"

if [[ " $WHAT " == *" configure "* ]]; then
  EXTRA=()
  if [[ -n "${ZLIB_SRC:-}" ]]; then EXTRA+=("-DFETCHCONTENT_SOURCE_DIR_ZLIB=$(native "$ZLIB_SRC")"); fi
  # The install prefix is printed into the configuration template, so it is a fixed name too.
  MSYS2_ARG_CONV_EXCL='-DCMAKE_INSTALL_PREFIX=' emcmake cmake -G Ninja -S "$SRC_N" -B "$OUT_N" \
    -DCMAKE_BUILD_TYPE=Release -DSQLITE=ON -DPCH=OFF -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DBUILD_GAME_SERVER=ON -DBUILD_LOGIN_SERVER=OFF -DBUILD_EXTRACTORS=OFF \
    -DBUILD_PLAYERBOTS=OFF -DBUILD_AHBOT=OFF \
    -DWEB_DEPS="$DEPS_N" -DWEB_BOOST_INCLUDE="$BOOST_N" \
    -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CXXFLAGS" \
    -DWEB_LINK_FLAGS="$LINK" "${EXTRA[@]}"
fi

if [[ " $WHAT " == *" build "* ]]; then
  cmake --build "$OUT_N" -j "$JOBS"
fi
