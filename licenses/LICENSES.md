# Licenses

The browser version's own code (this repository: `web/`, `tools/`, the build scripts and tests) is
offered under **MIT OR Apache-2.0**, the same terms as the WoW Electrode desktop app, whose launcher
page it carries (`web/index.html`, `web/theme.css`, `web/launcher.js`), and as wenilla. The changes
to CMaNGOS (`server/core.patch`, `extract/`) are offered under CMaNGOS's own terms, the GPL.

The site serves the compiled programs below. Their notice texts are in `licenses/`.

| component | pinned at | license | source |
|---|---|---|---|
| CMaNGOS mangos-classic: the world server with the login server's socket code linked in (`server/mangosd.wasm`), and the map, collision and movement-map extractors (`extract/*.wasm`) | commit `de8f72993b9e1faa1bf92dd5505f3daec5cea3ce`, with `server/core.patch` and the changes in `extract/` | GPL-2.0-or-later | https://github.com/cmangos/mangos-classic |
| Libraries inside the CMaNGOS source tree and compiled with it: G3D (g3dlite), Recast/Detour, utf8cpp, libmpq, bzip2 | as in that commit | each its own: Modified BSD (G3D, with the parts its `license.cpp` names), Zlib (Recast/Detour), BSL-1.0 (utf8cpp), GPL-2.0 (libmpq), bzip2's license | in the CMaNGOS repository, `dep/` |
| OpenSSL (libcrypto), linked into the world server | 3.5.9 | Apache-2.0 | https://www.openssl.org |
| Boost, linked into the world server | 1.87.0 | BSL-1.0 | https://www.boost.org |
| SQLite, linked into the world server | 3.54.1 | public domain | https://sqlite.org |
| zlib, linked into the world server and the extractors | 1.3.2 | Zlib | https://zlib.net |
| Emscripten's runtime and system libraries (musl, libc++), part of every compiled program above | 6.0.13 | MIT / University of Illinois; musl MIT; libc++ Apache-2.0 with LLVM exception | https://emscripten.org |
| classic-db: the world database, converted to SQLite (`db/world.sqlite.gz`) and the empty character, account and log databases | commit `4d230bb1bd477948cac61c107d2718b3ea04a5b8` | GPL-3.0 | https://github.com/cmangos/classic-db |
| wenilla: the game client (`client/`), built from the pinned source with the desktop app's carries | commit `ea514d8bb724c0571fc74183f23de7b1bbb303cf` | MIT OR Apache-2.0; the Rust crates it links are listed in its `Cargo.lock`, each under its own terms | https://github.com/Arnesen/wenilla |
| Questie 3.7.1, game-client addon (`addons/!Questie`, the release zip unmodified) | tag `v3.7.1`, commit `51c9dae5`, zip SHA-256 `6951db68…dae1d` | No license file in the release. The Questie project's `LICENSE.md` (shipped as `questie-LICENSE.md`, with `questie-gpl-3.0.md`) says historic Questie has no proper license, to treat it as all rights reserved when in doubt, and that the team is fine with copying it under GPL-3.0 terms; the name and logo are not covered. Its Astrolabe library: LGPL-2.1 (`questie-astrolabe-lgpl.txt`); its arrow art: free for non-commercial use (`questie-ArrowLicense.txt`); its Ace2, Babble, Dewdrop, Tablet and Tourist libraries carry no license statement. | https://github.com/Questie/Questie |
| The launcher page (`index.html`, `theme.css`, `launcher.js`, the crest) | WoW Electrode desktop app 1.1.9 | MIT OR Apache-2.0 | https://gitlab.com/garydev00/wow-electrode |

The world server program combines CMaNGOS (GPL-2.0-or-later) with OpenSSL (Apache-2.0). As a whole
it is offered under GPL-3.0-or-later, the version of the GPL that Apache-2.0 code can be combined
with. This is the project's reading of those licenses, not legal advice.

## Local changes to upstream code

- `server/core.patch` (GPL-2.0-or-later, as CMaNGOS): the world server built for WebAssembly on
  SQLite. A build option for SQLite on Windows and with MinGW; in a browser tab, connections that
  arrive as calls from the page instead of sockets (`Network/PageNet.*`, `PageSocket.hpp`), the login
  server's socket code served by the same program, no SOAP, stop / console commands / database
  snapshots asked by the page (`mangosd/PageHost.cpp`), SQLite opened for one process with several
  connections, large read buffers, movement-map files asked of the page when missing, and G3D's
  platform checks.
- `extract/` (GPL-2.0-or-later, as CMaNGOS): the extractors built for WebAssembly. The desktop app's
  map extractor patch (`extract/patches/extractor`, see `patch-LICENSE` there), an entry point that
  runs one stage at a time, zeroed allocations, a fixed sort order and a single-threaded build of
  the movement-map generator, so the output equals the Windows tools' output.
- The game client is the desktop app's build of wenilla: the carries are `patches/wenilla` in the
  WoW Electrode repository (MIT OR Apache-2.0).

## Source for the GPL programs

The site includes programs licensed under the GNU General Public License: CMaNGOS mangos-classic
and the libraries built with it, and classic-db. Their complete corresponding source is the exact
upstream revision named above plus the changes in this repository (`server/core.patch`,
`extract/`), built with the scripts in `server/`, `extract/` and `tools/`. The repository that
publishes the site holds all of it.

## Not included

No game data is part of the site or of this repository. The game runs on the player's own copy of
the 1.12.1 game files, which are read in the player's browser and never uploaded or shared with
other players. Not affiliated with or endorsed by Blizzard Entertainment.
