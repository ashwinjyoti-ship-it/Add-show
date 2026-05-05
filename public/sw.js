var CACHE = 'add-show-v1'

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return c.addAll(['/', '/manifest.json', '/icon.svg'])
    })
  )
  self.skipWaiting()
})

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE }).map(function(k) { return caches.delete(k) })
      )
    })
  )
  self.clients.claim()
})

self.addEventListener('fetch', function(e) {
  // Always go to network for API calls
  if (e.request.url.includes('/api/')) {
    e.respondWith(fetch(e.request))
    return
  }
  // Network-first for everything else, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then(function(r) {
        var clone = r.clone()
        caches.open(CACHE).then(function(c) { c.put(e.request, clone) })
        return r
      })
      .catch(function() { return caches.match(e.request) })
  )
})
