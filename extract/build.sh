#!/usr/bin/env bash
# Builds the extractors for the browser with Emscripten (emcc on PATH: source emsdk_env.sh first).
#
#   CORE  the core source: github.com/cmangos/mangos-classic at de8f72993b9e1faa1bf92dd5505f3daec5cea3ce
#   WORK  a scratch folder for object files and the zlib source
#   OUT   where the compiled files go (the site serves them as extract/)
#
#   CORE=... WORK=... OUT=... extract/build.sh [ad] [vmap] [mmap]      (default: all three)
#
# ad    the map and DBC extractor: the core's contrib/extractor with the patched files in
#       patches/extractor, plus src/ad_web.cpp (a step interface for the page)   -> ad.js, ad.wasm
# vmap  the collision tools, unchanged: contrib/vmap_extractor and contrib/vmap_assembler with the
#       core's g3dlite                -> vmap_extractor.js/.wasm, vmap_assembler.js/.wasm
# mmap  the movement-map generator, unchanged: contrib/mmap with Recast, Detour, the core's collision
#       code and g3dlite              -> movemapgen.js/.wasm, and its config.json and offmesh.txt
#
# Checked against native builds with the scripts in test/.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CORE:?set CORE to the core source}" "${WORK:?set WORK to a scratch folder}" "${OUT:?set OUT to the output folder}"
what="${*:-ad vmap mmap}"
ZV=1.3.1
ZSHA=17e88863f3600672ab49182f217281b6fc4d3c762bde361935e436a95214d05c
Z="$WORK/zlib-$ZV"
mkdir -p "$WORK/obj" "$OUT"

# The same paths in every build, and none of the build machine's: __FILE__ would carry them.
m() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
PFX=("-ffile-prefix-map=$(m "$CORE")=core" "-ffile-prefix-map=$(m "$HERE")=extract" "-ffile-prefix-map=$(m "$WORK")=work")
CC=(emcc -O2 -w "${PFX[@]}")
CXX=(em++ -O2 -w -std=c++17 "${PFX[@]}")

if [ ! -d "$Z" ]; then
  [ -f "$WORK/zlib-$ZV.tar.gz" ] || curl -sL -o "$WORK/zlib-$ZV.tar.gz" "https://github.com/madler/zlib/archive/refs/tags/v$ZV.tar.gz"
  echo "$ZSHA *$WORK/zlib-$ZV.tar.gz" | sha256sum -c -
  tar -xzf "$WORK/zlib-$ZV.tar.gz" -C "$WORK"
fi

# Compile $1 to $2 unless it is up to date; the rest is the compiler and its arguments.
cc() { local src="$1" obj="$2"; shift 2; if [ ! -f "$obj" ] || [ "$src" -nt "$obj" ]; then "$@" -c "$src" -o "$obj"; fi; }

cd "$WORK/obj"
for f in adler32 compress crc32 deflate infback inffast inflate inftrees trees uncompr zutil; do cc "$Z/$f.c" "z_$f.o" "${CC[@]}"; done
for f in blocksort bzlib compress crctable decompress huffman randtable; do cc "$CORE/dep/src/bzip2/$f.c" "bz_$f.o" "${CC[@]}" -I"$CORE/dep/src/bzip2"; done
for u in common explode extract huffman mpq wave; do cc "$CORE/dep/libmpq/libmpq/$u.c" "mpq_$u.o" "${CC[@]}" -I"$Z" -I"$CORE/dep/src/bzip2" -I"$CORE/dep/libmpq"; done
# Memory from new starts at zero in the tools that read the archives (see the file).
cc "$HERE/src/zero_arrays.cpp" zero_arrays.o "${CXX[@]}"
LIBS=(z_*.o bz_*.o mpq_*.o)

# One module per tool: an ES module for a worker (or Node, for the tests), its own file system,
# memory that grows as needed, nothing run at load.
LINK=(-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB
  -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=4MB -sFORCE_FILESYSTEM=1 -lworkerfs.js -lnodefs.js -sINVOKE_RUN=0 -sEXIT_RUNTIME=0
  -sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,NODEFS,MEMFS,callMain,ccall,cwrap,UTF8ToString,HEAPU8)

for w in $what; do
  case "$w" in
  ad)
    E="$CORE/contrib/extractor"
    P="$HERE/patches/extractor"
    INC=(-I"$CORE/dep/libmpq" -I"$CORE/src/game" -I"$E" -I"$E/loadlib")
    cc "$P/loadlib.cpp" ad_loadlib.o "${CXX[@]}" "${INC[@]}"
    cc "$P/adt.cpp" ad_adt.o "${CXX[@]}" "${INC[@]}"
    cc "$E/loadlib/wdt.cpp" ad_wdt.o "${CXX[@]}" "${INC[@]}"
    cc "$E/dbcfile.cpp" ad_dbcfile.o "${CXX[@]}" "${INC[@]}"
    cc "$E/mpq_libmpq.cpp" ad_mpq.o "${CXX[@]}" "${INC[@]}"
    # The tool's main becomes ad_cli_main; ad_web.cpp has the module's main and the step interface.
    cc "$P/System.cpp" ad_system.o "${CXX[@]}" "${INC[@]}" -Dmain=ad_cli_main
    cc "$HERE/src/ad_web.cpp" ad_web.o "${CXX[@]}" "${INC[@]}"
    STEPS=_ad_open,_ad_dbc,_ad_cameras,_ad_maps_begin,_ad_map_id,_ad_map_name,_ad_map_open,_ad_map_has,_ad_map_tile,_ad_map_row,_ad_close
    "${CXX[@]}" ad_*.o zero_arrays.o "${LIBS[@]}" "${LINK[@]}" -sEXPORT_NAME=createAd \
      -sEXPORTED_FUNCTIONS=_main,_malloc,_free,$STEPS -o "$OUT/ad.js"
    ;;
  vmap)
    # g3dlite: the files the core's own build lists.
    G="$CORE/dep/g3dlite"
    # g3dlite picks its platform by name, and the POSIX branch is the one that fits. That branch
    # expects struct timeval from its other includes.
    GDEF=(-D__linux__ -include sys/time.h)
    G3D="AABox Any BinaryFormat BinaryInput BinaryOutput Box Capsule CollisionDetection CoordinateFrame Crypto Cylinder
      FileSystem Line LineSegment Log Matrix3 Matrix4 MemoryManager PhysicsFrame Plane Quat Random Ray ReferenceCount
      RegistryUtil Sphere System TextInput TextOutput Triangle UprightFrame Vector2 Vector3 Vector4 debugAssert
      fileutils format g3dfnmatch g3dmath prompt stringutils uint128"
    for f in $G3D; do
      extra=()
      # System.cpp asks the processor about itself with x86 instructions unless it is told the
      # processor has none; its RISC-V branch is the plain one.
      [ "$f" = System ] && extra=(-D__riscv)
      cc "$G/$f.cpp" "g3d_$f.o" "${CXX[@]}" "${GDEF[@]}" "${extra[@]}" -I"$G" -I"$Z"
    done
    # shim/ stands in for the one Boost header the core's platform header asks for.
    V="$CORE/contrib/vmap_extractor/vmapextract"
    VINC=(-I"$V" -I"$CORE/dep/libmpq" -I"$G" -I"$HERE/shim" -I"$CORE/src/shared" -I"$CORE/src/framework" -I"$CORE/src/game")
    for f in adtfile dbcfile gameobject_extract model mpq_libmpq vmapexport wdtfile wmo; do
      cc "$V/$f.cpp" "vx_$f.o" "${CXX[@]}" "${GDEF[@]}" "${VINC[@]}"
    done
    "${CXX[@]}" vx_*.o zero_arrays.o g3d_*.o "${LIBS[@]}" "${LINK[@]}" -sEXPORT_NAME=createVmapExtractor \
      -sEXPORTED_FUNCTIONS=_main,_malloc,_free -o "$OUT/vmap_extractor.js"
    A="$CORE/src/game/vmap"
    AINC=(-I"$A" -I"$G" -I"$HERE/shim" -I"$CORE/src/shared" -I"$CORE/src/framework" -I"$CORE/src/game")
    for f in BIH VMapManager2 MapTree TileAssembler WorldModel ModelInstance; do
      cc "$A/$f.cpp" "va_$f.o" "${CXX[@]}" "${GDEF[@]}" -DNO_CORE_FUNCS "${AINC[@]}"
    done
    cc "$CORE/contrib/vmap_assembler/vmap_assembler.cpp" va_main.o "${CXX[@]}" "${GDEF[@]}" -DNO_CORE_FUNCS "${AINC[@]}"
    "${CXX[@]}" va_*.o g3d_*.o "${LIBS[@]}" "${LINK[@]}" -sEXPORT_NAME=createVmapAssembler \
      -sEXPORTED_FUNCTIONS=_main,_malloc,_free -o "$OUT/vmap_assembler.js"
    ;;
  mmap)
    # The movement-map generator: contrib/mmap with Recast and Detour, the core's collision code and
    # g3dlite. Its sources are compiled unchanged; src/run_now.h (included ahead of them) makes the
    # one call that starts a thread per tile run the tile at once instead.
    G="$CORE/dep/g3dlite"
    RD="$CORE/dep/recastnavigation"
    MDEF=(-D__linux__ -include sys/time.h -DMMAP_GENERATOR -DNO_CORE_FUNCS -DDT_POLYREF64 -DNO_vsnprintf -fwasm-exceptions)
    MINC=(-I"$CORE/src" -I"$CORE/src/game" -I"$CORE/src/game/vmap" -I"$CORE/src/framework" -I"$CORE/src/shared"
      -I"$CORE/dep/json" -I"$G" -I"$RD" -I"$RD/Recast/Include" -I"$RD/Detour/Include" -I"$HERE/shim")
    G3D="AABox Any BinaryFormat BinaryInput BinaryOutput Box Capsule CollisionDetection CoordinateFrame Crypto Cylinder
      FileSystem Line LineSegment Log Matrix3 Matrix4 MemoryManager PhysicsFrame Plane Quat Random Ray ReferenceCount
      RegistryUtil Sphere System TextInput TextOutput Triangle UprightFrame Vector2 Vector3 Vector4 debugAssert
      fileutils format g3dfnmatch g3dmath prompt stringutils uint128"
    for f in $G3D; do
      extra=()
      [ "$f" = System ] && extra=(-D__riscv)   # as for the collision tools
      cc "$G/$f.cpp" "mmg_$f.o" "${CXX[@]}" -D__linux__ -include sys/time.h -fwasm-exceptions "${extra[@]}" -I"$G" -I"$Z"
    done
    for f in Recast RecastAlloc RecastArea RecastAssert RecastContour RecastFilter RecastLayers RecastMesh RecastMeshDetail RecastRasterization RecastRegion; do
      cc "$RD/Recast/Source/$f.cpp" "mmr_$f.o" "${CXX[@]}" -fwasm-exceptions -I"$RD/Recast/Include"
    done
    for f in DetourAlloc DetourAssert DetourCommon DetourNavMesh DetourNavMeshBuilder DetourNavMeshQuery DetourNode; do
      cc "$RD/Detour/Source/$f.cpp" "mmd_$f.o" "${CXX[@]}" -fwasm-exceptions -DDT_POLYREF64 -I"$RD/Detour/Include"
    done
    for f in BIH VMapManager2 MapTree TileAssembler WorldModel ModelInstance; do
      cc "$CORE/src/game/vmap/$f.cpp" "mmv_$f.o" "${CXX[@]}" "${MDEF[@]}" "${MINC[@]}"
    done
    M="$CORE/contrib/mmap/src"
    for f in IntermediateValues MapBuilder TerrainBuilder VMapExtensions generator; do
      [ "$HERE/src/run_now.h" -nt "mm_$f.o" ] && rm -f "mm_$f.o"
      cc "$M/$f.cpp" "mm_$f.o" "${CXX[@]}" "${MDEF[@]}" "${MINC[@]}" -include "$HERE/src/run_now.h"
    done
    # Equal elements sorted into the order a Windows build gives them (see the file).
    cc "$HERE/src/qsort_order.c" mm_qsort.o "${CC[@]}"
    "${CXX[@]}" mm_*.o mmv_*.o mmr_*.o mmd_*.o mmg_*.o z_*.o "${LINK[@]}" -fwasm-exceptions -sEXPORT_NAME=createMoveMapGen \
      -sEXPORTED_FUNCTIONS=_main,_malloc,_free -o "$OUT/movemapgen.js"
    # The generator's settings, as the core ships them.
    cp "$CORE/contrib/extractor_scripts/config.json" "$CORE/contrib/extractor_scripts/offmesh.txt" "$OUT/"
    ;;
  *) echo "unknown target $w" >&2; exit 1 ;;
  esac
done
ls -la "$OUT"
