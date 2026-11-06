#define _CRT_SECURE_NO_DEPRECATE

#include "adt.h"
#include <string.h>
#include <stdio.h>

// Helper
int holetab_h[4] = {0x1111, 0x2222, 0x4444, 0x8888};
int holetab_v[4] = {0x000F, 0x00F0, 0x0F00, 0xF000};

bool isHole(int holes, int i, int j)
{
    int testi = i / 2;
    int testj = j / 4;
    if (testi > 3) testi = 3;
    if (testj > 3) testj = 3;
    return (holes & holetab_h[testi] & holetab_v[testj]) != 0;
}

// ---------------------------------------------------------------------------
// LOCAL PATCH (not upstream): bounds checking for chunk offsets.
//
// Upstream trusts every offset in MHDR/MCIN/MCNK without validating it
// against the loaded file size. A malformed ADT (e.g. from a rebuilt or
// truncated MPQ) sends prepareLoadedData() chasing a wild pointer and the
// extractor segfaults (observed: strncmp in adt_MCVT::prepareLoadedData on
// Kalimdor_33_49.adt).
//
// The extractor ('ad') is single-threaded, so file-scope bounds avoid
// touching any header or signature. On violation we log and return false,
// which makes FileLoader::loadFile() fail => the tile is skipped instead of
// crashing the whole extraction.
// ---------------------------------------------------------------------------
static const uint8* s_bounds_start = 0;
static const uint8* s_bounds_end   = 0;

static bool adt_inBounds(const void* p, unsigned long need, const char* what)
{
    const uint8* q = (const uint8*)p;
    if (q >= s_bounds_start && q < s_bounds_end &&
        (unsigned long)(s_bounds_end - q) >= need)
        return true;
    fprintf(stderr, "\nADT bounds check failed (%s): chunk offset outside file data\n", what);
    return false;
}

//
// Adt file loader class
//
ADT_file::ADT_file()
{
    a_grid = 0;
}

ADT_file::~ADT_file()
{
    free();
}

void ADT_file::free()
{
    a_grid = 0;
    FileLoader::free();
}

//
// Adt file check function
//
bool ADT_file::prepareLoadedData()
{
    // PATCH: refuse files too small to contain even the version header
    if (GetDataSize() < sizeof(file_MVER))
        return false;

    // Check parent
    if (!FileLoader::prepareLoadedData())
        return false;

    // PATCH: establish bounds for this file
    s_bounds_start = GetData();
    s_bounds_end   = GetData() + GetDataSize();

    // Check and prepare MHDR
    a_grid = (adt_MHDR*)(GetData() + 8 + version->size);
    if (!adt_inBounds(a_grid, sizeof(adt_MHDR), "MHDR"))
        return false;
    if (!a_grid->prepareLoadedData())
        return false;

    return true;
}

bool adt_MHDR::prepareLoadedData()
{
    if (!strncmp(fcc_txt, "MHDR", 4))
        return false;

    if (size != sizeof(adt_MHDR) - 8)
        return false;

    // Check and prepare MCIN
    if (offsMCIN)
    {
        if (!adt_inBounds(getMCIN(), sizeof(adt_MCIN), "MCIN"))
            return false;
        if (!getMCIN()->prepareLoadedData())
            return false;
    }

    // Check and prepare MH2O
    if (offsMH2O)
    {
        if (!adt_inBounds(getMH2O(), sizeof(adt_MH2O), "MH2O"))
            return false;
        if (!getMH2O()->prepareLoadedData())
            return false;
    }

    return true;
}

bool adt_MCIN::prepareLoadedData()
{
    if (!strncmp(fcc_txt, "MCIN", 4))
        return false;

    // Check cells data
    for (int i = 0; i < ADT_CELLS_PER_GRID; i++)
        for (int j = 0; j < ADT_CELLS_PER_GRID; j++)
            if (cells[i][j].offsMCNK)
            {
                if (!adt_inBounds(getMCNK(i, j), sizeof(adt_MCNK), "MCNK"))
                    return false;
                if (!getMCNK(i, j)->prepareLoadedData())
                    return false;
            }

    return true;
}

bool adt_MH2O::prepareLoadedData()
{
    if (!strncmp(fcc_txt, "MH2O", 4))
        return false;

    // Check liquid data
//    for (int i=0; i<ADT_CELLS_PER_GRID;i++)
//        for (int j=0; j<ADT_CELLS_PER_GRID;j++)

    return true;
}

bool adt_MCNK::prepareLoadedData()
{
    if (!strncmp(fcc_txt, "MCNK", 4))
        return false;

    // Check height map
    if (offsMCVT)
    {
        if (!adt_inBounds(getMCVT(), sizeof(adt_MCVT), "MCVT"))
            return false;
        if (!getMCVT()->prepareLoadedData())
            return false;
    }
    // Check liquid data
    // PATCH v2: the map converter (System.cpp) reads MCLQ only through
    // flags[8][8] — 728 bytes from chunk start; the trailing data[84] is
    // never accessed, and MCLQ commonly sits at end-of-file, so requiring
    // sizeof(adt_MCLQ) (812) rejected ~1,450 valid coastal tiles.
    // A chunk that still fails bounds is degraded to "no liquid"
    // (offset zeroed) instead of rejecting the tile; the converter
    // already null-guards getMCLQ() (System.cpp: "if (!liquid || ...)").
    // Empty liquid headers are skipped by the converter.
    if (offsMCLQ && sizeMCLQ > 8)
    {
        const unsigned long MCLQ_READ_BYTES = 728;
        if (!adt_inBounds(getMCLQ(), MCLQ_READ_BYTES, "MCLQ"))
        {
            fprintf(stderr, "  -> degrading: dropping liquid for this chunk, keeping the tile\n");
            offsMCLQ = 0;
        }
        else if (!getMCLQ()->prepareLoadedData())
            return false;
    }

    return true;
}

bool adt_MCVT::prepareLoadedData()
{
    if (!strncmp(fcc_txt, "MCVT", 4))
        return false;

    if (size != sizeof(adt_MCVT) - 8)
        return false;

    return true;
}

bool adt_MCLQ::prepareLoadedData()
{
    if (!strncmp(fcc_txt, "MCLQ", 4))
        return false;

    return true;
}
