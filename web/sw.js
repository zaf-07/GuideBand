const CACHE='guideband-v21',ASSETS=['./','index.html','landing.css','landing.js','live.css','live.js','signs.js','models/asl_fingerspelling_landmarks.json','app.html','styles.css','app.js','manifest.webmanifest','icon.svg'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
// Network first, so an update is never hidden behind an old cached copy; the cache is only the offline fallback.
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).catch(()=>caches.match(e.request,{ignoreSearch:true})))});
