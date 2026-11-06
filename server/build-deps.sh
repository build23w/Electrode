#!/bin/bash
# Builds the libraries the world server links, for wasm32 with threads:
#   SQLite (amalgamation), OpenSSL libcrypto, and the compiled parts of Boost the core uses.
#
# Needs: an activated Emscripten (emcc on PATH), perl, make (or mingw32-make).
#   ELECTRODE_WEB_BUILD  build root (objects and libraries go to $ELECTRODE_WEB_BUILD/server/deps)
#   SQLITE_SRC           folder holding sqlite3.c and sqlite3.h (amalgamation 3.54.1)
#   OPENSSL_TARBALL      openssl-3.5.9.tar.gz
#   BOOST_SRC            an unpacked boost_1_87_0 source tree (only read)
# usage: build-deps.sh [sqlite] [openssl] [boost]   (no argument: all three)
set -euo pipefail
: "${ELECTRODE_WEB_BUILD:?set ELECTRODE_WEB_BUILD}"
OUT="$ELECTRODE_WEB_BUILD/server/deps"
WORK="$ELECTRODE_WEB_BUILD/server/deps-build"
mkdir -p "$OUT/lib" "$OUT/include" "$WORK"
JOBS="${JOBS:-12}"
MAKE="$(command -v make || command -v mingw32-make)"
# One set of code-generation flags for everything that ends up in the server.
COMMON="-O2 -pthread -fwasm-exceptions -g0"
WHAT="${*:-sqlite openssl boost}"

if [[ " $WHAT " == *" sqlite "* ]]; then
  : "${SQLITE_SRC:?set SQLITE_SRC}"
  echo "== sqlite"
  cp "$SQLITE_SRC/sqlite3.h" "$OUT/include/"
  emcc $COMMON -ffile-prefix-map="$SQLITE_SRC"=sqlite \
    -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_OMIT_LOAD_EXTENSION \
    -DSQLITE_TEMP_STORE=2 -DSQLITE_MAX_MMAP_SIZE=0 -DSQLITE_DEFAULT_MEMSTATUS=0 \
    -DSQLITE_USE_ALLOCA -DSQLITE_OMIT_DEPRECATED \
    -c "$SQLITE_SRC/sqlite3.c" -o "$WORK/sqlite3.o"
  rm -f "$OUT/lib/libsqlite3.a"
  emar rcs "$OUT/lib/libsqlite3.a" "$WORK/sqlite3.o"
fi

if [[ " $WHAT " == *" openssl "* ]]; then
  : "${OPENSSL_TARBALL:?set OPENSSL_TARBALL}"
  echo "== openssl"
  rm -rf "$WORK/openssl"
  mkdir -p "$WORK/openssl"
  tar -xzf "$OPENSSL_TARBALL" -C "$WORK/openssl" --strip-components=1
  cd "$WORK/openssl"
  # no-module: the legacy provider is compiled into libcrypto. Only libcrypto is built.
  # OpenSSL keeps its configure line and its directories inside the library, so neither may name
  # a folder of the build machine: sources are compiled by relative path (no prefix map needed),
  # and the two directories are fixed names that a POSIX-on-Windows shell must not expand.
  MSYS2_ARG_CONV_EXCL='--prefix=;--openssldir=' CC=emcc AR=emar RANLIB=emranlib perl Configure linux-generic32 \
    no-asm no-shared no-module no-tests no-docs no-apps no-dso no-engine no-afalgeng \
    no-async no-secure-memory no-quic no-ssl3 no-comp no-ui-console \
    --prefix=/ossl --openssldir=/ossl/ssl \
    $COMMON -D__STDC_NO_ATOMICS__=1
  # The same directories reach the compiler as -D values: keep the shell from expanding those too.
  export MSYS2_ARG_CONV_EXCL='-DOPENSSLDIR=;-DENGINESDIR=;-DMODULESDIR='
  "$MAKE" -j"$JOBS" build_generated >/dev/null
  "$MAKE" -j"$JOBS" libcrypto.a
  unset MSYS2_ARG_CONV_EXCL
  cp libcrypto.a "$OUT/lib/"
  rm -rf "$OUT/include/openssl"
  cp -r include/openssl "$OUT/include/"
  cd - >/dev/null
fi

if [[ " $WHAT " == *" boost "* ]]; then
  : "${BOOST_SRC:?set BOOST_SRC}"
  echo "== boost"
  B="$WORK/boost"
  rm -rf "$B"
  mkdir -p "$B"
  FLAGS="$COMMON -std=c++20 -I$BOOST_SRC -ffile-prefix-map=$BOOST_SRC=boost -DBOOST_ALL_NO_LIB -DNDEBUG"
  build_lib() { # name, extra flags, sources...
    local name="$1" extra="$2"; shift 2
    mkdir -p "$B/$name"
    local objs=()
    for src in "$@"; do
      local obj="$B/$name/$(basename "${src%.cpp}").o"
      objs+=("$obj")
      echo "em++ $FLAGS $extra -c \"$src\" -o \"$obj\""
    done > "$B/$name.cmds"
    xargs -P "$JOBS" -I{} bash -c '{}' < "$B/$name.cmds"
    rm -f "$OUT/lib/libboost_$name.a"
    emar rcs "$OUT/lib/libboost_$name.a" "${objs[@]}"
  }
  L="$BOOST_SRC/libs"
  build_lib program_options "-DBOOST_PROGRAM_OPTIONS_STATIC_LINK" \
    "$L"/program_options/src/{cmdline,config_file,convert,options_description,parsers,positional_options,split,utf8_codecvt_facet,value_semantic,variables_map}.cpp
  build_lib thread "-DBOOST_THREAD_BUILD_LIB -DBOOST_THREAD_POSIX" \
    "$L"/thread/src/pthread/{thread,once}.cpp "$L"/thread/src/future.cpp
  build_lib chrono "-DBOOST_CHRONO_STATIC_LINK" \
    "$L"/chrono/src/{chrono,thread_clock,process_cpu_clocks}.cpp
  build_lib atomic "-DBOOST_ATOMIC_STATIC_LINK -DBOOST_ATOMIC_SOURCE -I$L/atomic/src" \
    "$L"/atomic/src/lock_pool.cpp
  build_lib filesystem "-DBOOST_FILESYSTEM_STATIC_LINK -DBOOST_FILESYSTEM_SOURCE -DBOOST_FILESYSTEM_NO_CXX20_ATOMIC_REF -I$L/filesystem/src" \
    "$L"/filesystem/src/{codecvt_error_category,directory,exception,operations,path,path_traits,portability,unique_path,utf8_codecvt_facet}.cpp
fi

ls -la "$OUT/lib"
