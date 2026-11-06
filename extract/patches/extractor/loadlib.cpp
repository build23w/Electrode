#define _CRT_SECURE_NO_DEPRECATE

#include "loadlib.h"
#include "../mpq_libmpq.h"

#include <stdio.h>
#include <string.h>

class MPQFile;
extern ArchiveSet gOpenArchives;

FileLoader::FileLoader()
{
    data = 0;
    data_size = 0;
    version = 0;
}

FileLoader::~FileLoader()
{
    free();
}

bool FileLoader::loadFile(char* filename, bool log)
{
    free();
    MPQFile mf(filename);
    if (mf.isEof())
    {
        if (log)
            printf("No such file %s\n", filename);
        return false;
    }

    data_size = mf.getSize();

    data = new uint8 [data_size];
    mf.read(data, data_size);
    mf.close();
    if (prepareLoadedData())
        return true;

    // Retry lower-priority archives only if the preferred terrain is malformed.
    printf("Invalid preferred terrain file: %s\n", filename);
    free();
    for (ArchiveSet::const_iterator it = gOpenArchives.begin(); it != gOpenArchives.end(); ++it)
    {
        uint32 fileNumber;
        libmpq__off_t length = 0, transferred = 0;
        if (libmpq__file_number((*it)->mpq_a, filename, &fileNumber) != 0 ||
            libmpq__file_unpacked_size((*it)->mpq_a, fileNumber, &length) != 0 || length <= 1)
            continue;
        data_size = length;
        data = new uint8[data_size];
        int result = libmpq__file_read((*it)->mpq_a, fileNumber, data, length, &transferred);
        if (result == 0 && transferred == length && prepareLoadedData())
        {
            printf("Recovered valid terrain from an underlying archive: %s\n", filename);
            return true;
        }
        free();
    }
    printf("UNRECOVERABLE terrain file: %s\n", filename);
    return false;
}

bool FileLoader::prepareLoadedData()
{
    // Check version
    version = (file_MVER*) data;
    if (!strncmp(version->fcc_txt, "MVER", 4))
        return false;
    if (version->ver != FILE_FORMAT_VERSION)
        return false;
    return true;
}

void FileLoader::free()
{
    if (data) delete[] data;
    data = 0;
    data_size = 0;
    version = 0;
}
