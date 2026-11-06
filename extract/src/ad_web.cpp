/*
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 */

// The map and DBC extractor for a page. The extractor's own source is compiled unchanged (its main
// renamed by the build); this file adds a step interface, so the caller converts one piece at a time
// and can store the finished files between calls. Every tile is its own output file and does not
// depend on the tiles converted before it, so the result is the same in any order.

#include <emscripten.h>
#include <cstdio>
#include <cstring>
#include <string>

#include "dbcfile.h"
#include "mpq_libmpq.h"
#include "loadlib/adt.h"
#include "loadlib/wdt.h"

// From System.cpp.
typedef struct
{
    char name[64];
    uint32 id;
} map_id;

extern map_id* map_ids;
extern char output_path[1024];
extern char data_path[1024];
extern bool CONF_allow_float_to_int;
extern ArchiveSet gOpenArchives;

uint32 ReadMapDBC();
void ReadAreaTableDBC();
void ReadLiquidTypeTableDBC();
void CreateDir(const std::string& Path);
bool ConvertADT(char* filename, char* filename2, int cell_y, int cell_x);
void ExtractDBCFiles();
void ExtractCameraFiles();
void LoadCommonMPQFiles();
int ad_cli_main(int argc, char* arg[]);

static WDT_file* web_wdt = nullptr;
static uint32 web_map_count = 0;

// The command line tool, as before (used for comparing against a native build).
int main(int argc, char* argv[])
{
    return ad_cli_main(argc, argv);
}

extern "C"
{
    // Opens the archives in `data` and sets the output folder. Returns how many archives opened.
    EMSCRIPTEN_KEEPALIVE int ad_open(const char* data, const char* out, int floatToInt)
    {
        strncpy(data_path, data, sizeof(data_path) - 1);
        strncpy(output_path, out, sizeof(output_path) - 1);
        CONF_allow_float_to_int = floatToInt != 0;
        LoadCommonMPQFiles();
        return int(gOpenArchives.size());
    }

    EMSCRIPTEN_KEEPALIVE void ad_dbc() { ExtractDBCFiles(); }

    EMSCRIPTEN_KEEPALIVE void ad_cameras() { ExtractCameraFiles(); }

    // Reads the tables the terrain conversion needs. Returns the number of maps in Map.dbc.
    EMSCRIPTEN_KEEPALIVE int ad_maps_begin()
    {
        web_map_count = ReadMapDBC();
        ReadAreaTableDBC();
        ReadLiquidTypeTableDBC();
        std::string path = output_path;
        path += "/maps/";
        CreateDir(path);
        return int(web_map_count);
    }

    EMSCRIPTEN_KEEPALIVE int ad_map_id(int z) { return uint32(z) < web_map_count ? int(map_ids[z].id) : -1; }

    EMSCRIPTEN_KEEPALIVE const char* ad_map_name(int z) { return uint32(z) < web_map_count ? map_ids[z].name : ""; }

    // Makes map z the current one. Returns its number of terrain tiles (0: none, a map of buildings only).
    EMSCRIPTEN_KEEPALIVE int ad_map_open(int z)
    {
        delete web_wdt;
        web_wdt = nullptr;
        if (uint32(z) >= web_map_count)
            return 0;
        char name[1024];
        sprintf(name, "World\\Maps\\%s\\%s.wdt", map_ids[z].name, map_ids[z].name);
        web_wdt = new WDT_file;
        if (!web_wdt->loadFile(name, false))
        {
            delete web_wdt;
            web_wdt = nullptr;
            return 0;
        }
        int n = 0;
        for (uint32 y = 0; y < WDT_MAP_SIZE; ++y)
            for (uint32 x = 0; x < WDT_MAP_SIZE; ++x)
                if (web_wdt->main->adt_list[y][x].exist)
                    ++n;
        return n;
    }

    // Does the current map have tile (y, x)?
    EMSCRIPTEN_KEEPALIVE int ad_map_has(int y, int x)
    {
        if (!web_wdt || uint32(y) >= WDT_MAP_SIZE || uint32(x) >= WDT_MAP_SIZE)
            return 0;
        return web_wdt->main->adt_list[y][x].exist ? 1 : 0;
    }

    // Converts tile (y, x) of the current map z. Returns 1 if a file was written.
    EMSCRIPTEN_KEEPALIVE int ad_map_tile(int z, int y, int x)
    {
        if (!ad_map_has(y, x))
            return 0;
        char mpq_filename[1024];
        char output_filename[1024];
        sprintf(mpq_filename, "World\\Maps\\%s\\%s_%u_%u.adt", map_ids[z].name, map_ids[z].name, x, y);
        snprintf(output_filename, sizeof(output_filename), "%s/maps/%03u%02u%02u.map", output_path, map_ids[z].id, y, x);
        return ConvertADT(mpq_filename, output_filename, y, x) ? 1 : 0;
    }

    // Converts row y of the current map z. Returns the number of files written.
    EMSCRIPTEN_KEEPALIVE int ad_map_row(int z, int y)
    {
        int n = 0;
        for (uint32 x = 0; x < WDT_MAP_SIZE; ++x)
            n += ad_map_tile(z, y, int(x));
        return n;
    }

    EMSCRIPTEN_KEEPALIVE void ad_close()
    {
        delete web_wdt;
        web_wdt = nullptr;
        for (ArchiveSet::iterator j = gOpenArchives.begin(); j != gOpenArchives.end(); ++j)
            (*j)->close();
        gOpenArchives.clear();
    }
}
