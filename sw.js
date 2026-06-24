const CACHE_NAME = "count-voice-app-v18-icons-packurl";
const ASSETS = [
  "./",
  "./index.html",
  "./voice-pack-maker.html",
  "./styles.css",
  "./app.js",
  "./audio.js",
  "./count-format.js",
  "./db.js",
  "./voice-pack-maker.js",
  "./manifest.webmanifest",
  "./favicon.ico",
  "./icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/apple-touch-icon-152.png",
  "./icons/apple-touch-icon-120.png",
  "./icons/favicon-64x64.png",
  "./icons/favicon-48x48.png",
  "./icons/favicon-32x32.png",
  "./icons/favicon-16x16.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
