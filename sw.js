/* Polish Chad Rankings – service worker (v3)
   Strategia: strona (HTML) zawsze najpierw z sieci, z zapasem w pamięci podręcznej gdy brak internetu.
   Ikony i manifest: z pamięci, odświeżane w tle. Firebase, imgbb i inne domeny NIE są przechwytywane. */
const VER = 'pcr-v3';

/* Powiadomienia push (Firebase Cloud Messaging). Błąd ładowania nie może zepsuć reszty service workera. */
try {
  importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: 'AIzaSyCJDcay4pyauLgGQLloTrf1kp2GjXoQmTA',
    projectId: 'polish-chad-rankings',
    messagingSenderId: '941798583866',
    appId: '1:941798583866:web:d79633db32004e07c74f03'
  });
  firebase.messaging().onBackgroundMessage(function (p) {
    var d = (p && p.data) || {};
    return self.registration.showNotification(d.title || 'Polish Chad Rankings', {
      body: d.body || '', icon: 'icon-192.png', badge: 'favicon.png', tag: d.tag || 'pcr', data: { url: d.url || '/' }
    });
  });
} catch (err) { /* push niedostępny, reszta działa */ }

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
    return self.clients.openWindow(url);
  }));
});
const SHELL = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'favicon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VER).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VER; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (res) {
      const copy = res.clone();
      caches.open(VER).then(function (c) { c.put('./', copy); });
      return res;
    }).catch(function () { return caches.match('./'); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) {
    const net = fetch(req).then(function (res) {
      if (res && res.ok) { const copy = res.clone(); caches.open(VER).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return hit; });
    return hit || net;
  }));
});
