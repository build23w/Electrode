// Stand-in for Boost's header: the tools built here only ask for the byte order, and
// WebAssembly is little-endian.
#pragma once
#define BOOST_ENDIAN_LITTLE_BYTE 1
