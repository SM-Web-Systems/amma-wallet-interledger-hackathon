// Amma Wallet Service Worker
const CACHE_NAME = "amma-v1";

// Install event: cache only the app shell ("/"), used as an offline fallback page.
// Wallet data and API responses are never cached.
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(["/"])));
});

// Fetch event: page navigations go to the network; if offline, show the cached shell.
// Every other request (API, assets, POSTs) is left to the browser untouched.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate" || request.method !== "GET") return;
  event.respondWith(
    fetch(request).catch(() => caches.open(CACHE_NAME).then((cache) => cache.match("/")))
  );
});

// Activate event
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Push notification handler
self.addEventListener("push", (event) => {

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "Amma Wallet", body: event.data.text() };
  }

  const options = {
    body: data.body || "",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    vibrate: [100, 50, 100],
    data: data.data || {},
    actions: data.actions || [],
    tag: data.tag || "amma-notification",
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "Amma Wallet", options)
  );
});

// Notification click handler
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus existing window or open new one
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
