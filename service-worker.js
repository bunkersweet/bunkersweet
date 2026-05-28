/* =============================================================
   service-worker.js — Print Custom Store
   -------------------------------------------------------------
   Gestisce:
   - Pre-cache dei file principali (App Shell) per il funzionamento offline
   - Strategia "Cache First" per le risorse statiche dell'app
   - Strategia "Network First" per le chiamate API (es. /api/send-order)
   - Pulizia automatica delle cache vecchie quando cambia la versione
   ============================================================= */

// Cambia il numero di versione ogni volta che modifichi i file cacheati.
// Questo costringe il browser a scaricare di nuovo l'App Shell.
const CACHE_VERSION = "pcs-v12";
const CACHE_NAME = `print-custom-store-${CACHE_VERSION}`;

// File che compongono lo "scheletro" dell'app (App Shell).
// Devono essere disponibili offline.
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./logo.png",
  "./hero.jpg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

/* -------------------------------------------------------------
   INSTALL: pre-carica tutti i file dell'App Shell in cache.
   ------------------------------------------------------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  // Attiva subito il nuovo service worker senza aspettare.
  self.skipWaiting();
});

/* -------------------------------------------------------------
   ACTIVATE: elimina le cache vecchie (versioni precedenti).
   ------------------------------------------------------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("print-custom-store-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Prende il controllo di tutte le tab aperte immediatamente.
  self.clients.claim();
});

/* -------------------------------------------------------------
   FETCH: intercetta tutte le richieste di rete.
   ------------------------------------------------------------- */
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Gestiamo solo richieste GET (POST verso le API non si cacheano).
  if (request.method !== "GET") {
    return; // lascia passare la richiesta normalmente (es. POST /api/send-order)
  }

  const url = new URL(request.url);

  // Le chiamate API: prima la rete, poi (se offline) fallisce in modo controllato.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request).catch(() => new Response(null, { status: 503 }))
    );
    return;
  }

  // Tutto il resto (App Shell e risorse statiche): Cache First.
  // 1) cerca in cache, 2) altrimenti vai in rete e salva la copia.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Salva in cache solo risposte valide e dello stesso origin.
          if (response && response.status === 200 && url.origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Se è una navigazione e siamo offline, mostra la index dalla cache.
          if (request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
    })
  );
});
