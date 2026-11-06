# WoW Electrode in the browser

**[Play: build23w.github.io/Electrode](https://build23w.github.io/Electrode/)**

World of Warcraft 1.12.1 in one browser tab, peer to peer. The page is the launcher of the
[WoW Electrode](https://gitlab.com/garydev00/wow-electrode) desktop app; behind it, in the same tab:

- the [wenilla](https://github.com/Arnesen/wenilla) game client (Rust, compiled to WebAssembly, drawn with WebGPU);
- the CMaNGOS classic world server, compiled to WebAssembly, on SQLite databases;
- the extractors that turn your game files into the server's maps, collision data and movement maps;
- WebRTC connections between players' browsers.

Nothing is installed, and there is no server of ours: a world runs in the tab of one of its
players, and moves to another's when that player leaves. You need your own World of Warcraft 1.12.1 (build 5875, enUS) game files. They are read on your
computer and are never uploaded, copied to the site or shared with other players.

## Playing

1. Open the page in a current Chrome or Edge on a desktop computer (the game needs WebGPU).
2. Accept the note at the top, once: players of a world can see each other's IP address, and the
   game files you use are your own copy.
3. **Use my WoW folder…** and choose your game folder (or its `Data` folder). The 14 archives are
   read where they are; nothing is copied. Chrome and Edge remember the folder and ask once per
   visit before reading it again. Other browsers ask for the folder on each visit.
4. The first time, the page makes the world data from your files (game tables and terrain in a few
   seconds, collision data in under a minute, in the background) and downloads the world database
   (41 MB).
5. **Play solo**, or type a string and **Join**, or pick a world under **Servers**.

### Worlds

- **A string is a world.** Everyone who types the same string plays in the same world. If nobody is
  running it, it starts in your tab and others join you. A new string is a room of your own.
- **Servers** lists the official permanent worlds: the same signed list the desktop app shows,
  read from the WoW Electrode repository on GitLab and checked in your browser. A world there runs
  with its own settings (rates, level cap), and starts in your browser when nobody is running it.
- **Characters** belong to the world. The browser that runs a world saves it twice a minute and
  sends each save to every player in it (about 35 KB), so every player's browser holds the world.
- **A world outlives the player who runs it.** Each player's browser keeps a server of the world
  warm, with the latest save in it. When the player running the world leaves, the first in line
  carries it on from there and the others are connected to it. The game stays in the world
  meanwhile, at the place the character stands: its connection ends in the page, which moves it to
  the new host (`web/lib/session.js`).
- **Who is first in line is measured.** A browser says whether it can run the world and how long
  its warm server took to start; the player running the world measures the round trip to each
  player and how fast each can send. The best placed come first; a browser that cannot run the
  world is not in the line.
- **AddOns**: the game's addons are turned on and off in the launcher's AddOns tab. Questie comes
  with the game; your own are added from a folder or a `.zip` and kept in your browser.

## What it does not do yet

- **Desktop and browser players do not meet.** The desktop app's players find each other through a
  UDP network that a web page cannot use, so a world's browser players and its desktop players are
  two separate groups, each with their own characters. This holds for the official worlds too.
- **A hand-off is a pause, not nothing.** Measured on one PC: about a second when the player
  running the world stops it, about five when that player's tab simply disappears (four of them
  spent making sure the host is really gone). What was done since the last save, up to 30 seconds
  before a host disappeared, is lost; positions are not.
- **A warm server is sometimes not usable.** A save that changes a guild, a group, an auction or a
  corpse cannot be taken by a running server, so the warm one starts again (a few seconds). A
  hand-off in those seconds waits for it.
- **Nobody checks that the others can reach the next host.** The line is ordered by what the
  current host measures. A player the others cannot connect to (see networks, below) can still be
  first; the others then wait and the next in line starts the world, which leaves two.
- **Two worlds under one string can happen**: two players who start the same string at the same
  moment, or the case above. They stay apart until one stops. A browser never writes a save with a
  lower number over a higher one of the same world.
- **Every player's browser runs a server.** The warm one takes memory (the same as running the
  world) on top of the game. A browser with under 4 GB of memory or fewer than 4 cores does not
  keep one and is not in the line.
- **A name is not owned.** Whoever answers under a string is its host. Your browser tells you when
  that is a different player than last time.
- **Some networks cannot connect.** Browsers connect directly with the help of public STUN servers.
  There is no relay, so two players who are both behind strict or carrier-grade NAT cannot reach
  each other.
- **Finding each other depends on public WebTorrent trackers** run by volunteers
  (`web/lib/tracker.js` lists them). They see a hash of the world's string and the IP addresses of
  players looking for it. Nothing of the game passes through them.
- **Movement maps are built where players are**, a few seconds per map tile; until a tile is there,
  creatures on it walk in straight lines. A dungeon's are built when someone first enters it and
  used from the next visit.
- **Browsers:** tested in Chrome on Windows only. Firefox and Safari have not been tried, and a
  phone or tablet has neither been tried nor is expected to have the memory.

## Where it stands

Run on one Windows PC in Chrome (a world starts in 6 to 8 seconds there):

- solo play end to end: game files read in the browser, world data extracted, the world server up,
  characters created, in the world, and still there after the tab was reloaded;
- three tabs in one world over WebRTC, each a player with its own key, account and character;
- the player running the world stopped it: the first in line carried it on from its warm server
  half a second after the host was gone, and the third player, in the world, was connected to it
  0.3 seconds later, at the same position, without leaving the world;
- the tab running the world killed without warning: the remaining player, in the world, was
  running it 4.75 seconds later, at the same position;
- an official world from the GitLab list started from the launcher with its own settings;
- movement-map tiles built on demand around players and loaded by the running server.

`server/test/session-node.mjs` runs the part that keeps the game connected (`web/lib/session.js`)
against the compiled world server under Node: sign-in, a character made and entered, the world's
connections cut, the game moved to the world again, and a running server taking a newer save.

The extractors' output was compared with the native tools': game tables, terrain and movement maps
are byte-identical; collision files are equivalent (they differ where the C libraries round or
order differently).

Not run yet: players on different computers or networks (all of the above was tabs of one browser,
found through a tracker on the same PC), the folder picker's permission prompt on a later visit,
Firefox, Safari, long play sessions, more than three players.

## Building

The site is static files. `web/` is the page; the compiled parts are built with the scripts here
and put together by `tools/build-site.mjs`. Needed: Node 22.5 or newer, an activated
[Emscripten](https://emscripten.org) (6.0.13 was used), CMake, Ninja, perl and make.

| part | built by | from |
|---|---|---|
| world server (`server/mangosd.wasm`) | `server/build-deps.sh`, then `server/build-server.sh` | CMaNGOS mangos-classic at `de8f7299` with `server/core.patch`; OpenSSL 3.5.9, Boost 1.87.0, SQLite 3.54.1 |
| extractors (`extract/*.wasm`) | `extract/build.sh` | the same CMaNGOS source with `extract/` |
| databases (`db/*.sqlite.gz`) | `tools/pack-db.mjs` | classic-db at `4d230bb1` as four SQLite files (made with the desktop app's database installer, a dump and mysql2sqlite) |
| game client (`client/`) | the desktop app's `tools/build/client.mjs` | wenilla at `ea514d8b` with the desktop app's carries |
| shipped addons (`addons/`) | `tools/pack-addons.mjs` | the addon release zips, unmodified |
| the whole site | `tools/build-site.mjs --built <dir> --out <dir> --scan` | all of the above |

`tools/dev-server.mjs` serves the result locally the way a static host does (no special headers,
under a base path), with a local tracker for trying two players without the public ones.
`server/test/run-node.mjs` starts the compiled world server under Node on real data and checks it.

The host needs no configuration: the page's service worker adds the cross-origin isolation headers
that threads need.

## Licenses

See [LICENSES.md](LICENSES.md). The site's own code is MIT OR Apache-2.0; the world server, the
extractors and the world database are GPL; the game client is MIT OR Apache-2.0.

No game data is part of the site or of this repository. WoW Electrode is not affiliated with or
endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment, Inc.
