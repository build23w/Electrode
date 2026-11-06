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

// Included ahead of the movement-map generator's sources (the build passes -include).
//
// The generator hands each tile of a whole-map build to std::async(std::launch::async, work), one
// thread per tile. This build has no threads: a page runs several copies of the tool in workers
// instead. So here that call runs the work at once and returns a future that is already ready;
// the generator's queue then finds every task finished, and nothing else in it changes.

#ifndef ELECTRODE_RUN_NOW_H
#define ELECTRODE_RUN_NOW_H

#include <future>
#include <utility>

namespace electrode
{
    template <class Work>
    std::future<void> run_now(Work&& work)
    {
        std::promise<void> done;
        std::forward<Work>(work)();
        done.set_value();
        return done.get_future();
    }
}

// std::async(policy, work) -> std::electrode_run_now(work); std::launch::async itself is untouched
// (a function-like macro only applies where a parenthesis follows the name).
namespace std
{
    template <class Work>
    future<void> electrode_run_now(Work&& work) { return electrode::run_now(std::forward<Work>(work)); }
}
#define async(policy, work) electrode_run_now(work)

#endif
