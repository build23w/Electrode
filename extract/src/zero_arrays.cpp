// Memory from new starts at zero in these tools.
//
// Two places use memory they did not fill. A file that is cut short inside an archive is read as
// far as it goes and the rest of its buffer is used as it is (Kalimdor_33_49.adt in patch.MPQ). And
// the collision extractor writes a liquid header with two bytes of padding it never set. A native
// build mostly gets such memory fresh from the system, all zero; here it would hold an earlier
// file's bytes. Zeroed, the result is the same on every run and does not depend on what was read
// before.

#include <cstdlib>
#include <new>

static void* zeroed(std::size_t n)
{
    void* p = calloc(n ? n : 1, 1);
    if (!p)
        abort();
    return p;
}

void* operator new(std::size_t n) { return zeroed(n); }
void* operator new[](std::size_t n) { return zeroed(n); }
void operator delete(void* p) noexcept { free(p); }
void operator delete[](void* p) noexcept { free(p); }
void operator delete(void* p, std::size_t) noexcept { free(p); }
void operator delete[](void* p, std::size_t) noexcept { free(p); }
