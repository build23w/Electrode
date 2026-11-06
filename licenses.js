// The Licenses page: the repository's LICENSES.md as it is, and the notice files beside it.
const NOTICES = [
  'cmangos-LICENSE', 'cmangos-COPYRIGHT.md', 'classic-db-LICENSE.md', 'classic-db-COPYRIGHT.md', 'extractor-patch-LICENSE',
  'wenilla-LICENSE-APACHE', 'wenilla-LICENSE-MIT', 'openssl-LICENSE.txt', 'boost-LICENSE_1_0.txt', 'zlib-LICENSE',
  'recastnavigation-License.txt', 'emscripten-LICENSE',
];
const ADDON_NOTICES = ['questie-LICENSE.md', 'questie-gpl-3.0.md', 'questie-astrolabe-lgpl.txt', 'questie-ArrowLicense.txt'];

fetch('licenses/LICENSES.md')
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((text) => { document.getElementById('text').textContent = text; })
  .catch((e) => { document.getElementById('text').textContent = 'The list could not be loaded: ' + e.message; });

const list = document.getElementById('notices');
const add = (href, name) => {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = href;
  a.textContent = name;
  li.appendChild(a);
  list.appendChild(li);
};
for (const name of NOTICES) add('licenses/' + name, name);
for (const name of ADDON_NOTICES) add('addons/licenses/' + name, name);
