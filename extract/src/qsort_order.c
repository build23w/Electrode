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

/*
 * qsort for the movement-map generator.
 *
 * The generator sorts the boxes of a tile's bounding-volume tree with qsort, and many of them
 * compare equal. C leaves the order of equal elements open and each C library settles it its own
 * way, so the tree written into a tile depends on the library the generator was built with.
 * This one leaves equal elements where a Windows build leaves them (the desktop app's tiles are
 * from one), so a tile made here is the same file.
 *
 * How it sorts: the pivot is the median of the first, middle and last element; a range of eight or
 * fewer is done by moving its largest element to the end, again and again; elements equal to the
 * pivot next to the split are left out of both sides.
 */

#include <stddef.h>

typedef int (*order_fn)(const void*, const void*);

static void exchange(char* a, char* b, size_t width)
{
    if (a == b)
        return;
    while (width--)
    {
        char t = *a;
        *a++ = *b;
        *b++ = t;
    }
}

static void sort_few(char* first, char* last, size_t width, order_fn order)
{
    while (last > first)
    {
        char* largest = first;
        for (char* p = first + width; p <= last; p += width)
            if (order(p, largest) > 0)
                largest = p;
        exchange(largest, last, width);
        last -= width;
    }
}

void qsort(void* base, size_t count, size_t width, order_fn order)
{
    struct { char* first; char* last; } waiting[8 * sizeof(void*)];
    int held = 0;

    if (count < 2 || width == 0)
        return;

    char* first = (char*)base;
    char* last = first + width * (count - 1);

    for (;;)
    {
        size_t n = (size_t)(last - first) / width + 1;
        int more = 0;

        if (n <= 8)
            sort_few(first, last, width, order);
        else
        {
            char* pivot = first + (n / 2) * width;
            if (order(first, pivot) > 0)
                exchange(first, pivot, width);
            if (order(first, last) > 0)
                exchange(first, last, width);
            if (order(pivot, last) > 0)
                exchange(pivot, last, width);

            char* up = first;
            char* down = last;
            for (;;)
            {
                if (pivot > up)
                    do up += width; while (up < pivot && order(up, pivot) <= 0);
                if (pivot <= up)
                    do up += width; while (up <= last && order(up, pivot) <= 0);
                do down -= width; while (down > pivot && order(down, pivot) > 0);
                if (down < up)
                    break;
                exchange(up, down, width);
                if (pivot == down)
                    pivot = up;             /* the pivot was moved */
            }

            /* step back over the elements equal to the pivot */
            down += width;
            if (pivot < down)
                do down -= width; while (down > pivot && order(down, pivot) == 0);
            if (pivot >= down)
                do down -= width; while (down > first && order(down, pivot) == 0);

            /* [first, down] and [up, last] are left: the longer one waits */
            if (down - first >= last - up)
            {
                if (first < down)
                {
                    waiting[held].first = first;
                    waiting[held].last = down;
                    ++held;
                }
                if (up < last)
                {
                    first = up;
                    more = 1;
                }
            }
            else
            {
                if (up < last)
                {
                    waiting[held].first = up;
                    waiting[held].last = last;
                    ++held;
                }
                if (first < down)
                {
                    last = down;
                    more = 1;
                }
            }
        }

        if (more)
            continue;
        if (!held)
            return;
        --held;
        first = waiting[held].first;
        last = waiting[held].last;
    }
}
