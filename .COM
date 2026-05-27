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
const CACHE_VERSION = "pcs-v6";
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

/* =============================================================
   app.js — Print Custom Store
   -------------------------------------------------------------
   App e-commerce PWA in JavaScript vanilla.

   ORGANIZZAZIONE DEL FILE:
   1. Configurazione e costanti (tipi adesivo, forme, parametri rotolo)
   2. DB  -> layer dati astratto (oggi localStorage, domani API/DB online)
   3. Helper generici (toast, modale, formattazione, escape, file -> base64)
   4. Calcolo prezzo adesivi personalizzati
   5. Carrello (logica)
   6. Invio ordine (sendOrderToWebhook + fallback localStorage)
   7. Viste (catalogo, dettaglio, configuratore, carrello, checkout, admin)
   8. Router (navigazione via hash)
   9. PWA (service worker + bottone "Installa App")
   10. Avvio app
   ============================================================= */

"use strict";

/* =============================================================
   SHIM STORAGE — localStorage con fallback in memoria
   -------------------------------------------------------------
   In alcuni contesti (anteprime in iframe, modalità privata su iOS, ecc.)
   localStorage può essere bloccato e generare un errore. Questo shim usa
   localStorage quando disponibile, altrimenti tiene i dati in memoria,
   così l'app non si blocca mai. Online su Netlify localStorage funziona
   normalmente come cache di riserva.
   ============================================================= */
const storage = (function () {
  var mem = {};
  var useLS = false;
  try {
    var k = "__pcs_test__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    useLS = true;
  } catch (e) {
    useLS = false;
  }
  return {
    getItem: function (key) {
      try { return useLS ? window.localStorage.getItem(key) : (key in mem ? mem[key] : null); }
      catch (e) { return key in mem ? mem[key] : null; }
    },
    setItem: function (key, value) {
      try { if (useLS) window.localStorage.setItem(key, value); else mem[key] = String(value); }
      catch (e) { mem[key] = String(value); }
    },
    removeItem: function (key) {
      try { if (useLS) window.localStorage.removeItem(key); else delete mem[key]; }
      catch (e) { delete mem[key]; }
    },
  };
})();

/* =============================================================
   1. CONFIGURAZIONE E COSTANTI
   ============================================================= */

// Parametri fisici del rotolo per il calcolo prezzo adesivi.
const ROLL = {
  usableRollWidth: 127, // 137 cm - 5 cm (sx) - 5 cm (dx) = 127 cm utili
  gap: 0.4,             // 4 mm di scarto tra un adesivo e l'altro = 0.4 cm
};

// Tipi di adesivo disponibili con relativo costo al metro lineare di rotolo.
const STICKER_TYPES = [
  { id: "classici",  name: "Adesivi Classici",        pricePerMeter: 50 },
  { id: "olografici", name: "Adesivi Olografici",      pricePerMeter: 60 },
  { id: "laminati",  name: "Adesivi Laminati Lucidi",  pricePerMeter: 75 },
  { id: "rilievo",   name: "Adesivi in Rilievo",       pricePerMeter: 85 },
];

// Forme disponibili e quali campi dimensione richiedono al cliente.
const SHAPES = [
  { id: "quadrati",     name: "Quadrati",     fields: ["side"] },
  { id: "rotondi",      name: "Rotondi",      fields: ["diameter"] },
  { id: "rettangolari", name: "Rettangolari", fields: ["width", "height"] },
  { id: "sagomati",     name: "Sagomati",     fields: ["width", "height"] },
];

// File accettati per l'upload del logo.
const ACCEPTED_FILES = ".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf";

// Endpoint demo per l'invio ordine (oggi non esiste -> si usa il fallback).
const ORDER_WEBHOOK_URL = "/api/send-order";

// PIN demo dell'area Admin (SOLO DIMOSTRATIVO, non sicuro per la produzione).
const ADMIN_PIN = "1234";

// Prodotti demo iniziali (caricati al primo avvio se il DB è vuoto).
const SEED_PRODUCTS = [
  {
    id: "stickers",
    name: "Adesivi Personalizzati",
    description: "Adesivi su misura con il tuo logo. Scegli materiale, forma e dimensione: il prezzo si calcola automaticamente.",
    image: null,
    type: "configurator",      // usa il configuratore speciale
    configurator: "stickers",  // identifica QUALE configuratore
    active: true,              // configuratore attivo/disattivo
    basePrice: null,
  },
  {
    id: "biglietti",
    name: "Biglietti da Visita",
    description: "Biglietti professionali con finitura premium. Carica il tuo file e indica le quantità.",
    image: null,
    type: "simple",
    basePrice: 29.9,
  },
  {
    id: "etichette",
    name: "Etichette Prodotto",
    description: "Etichette adesive per i tuoi prodotti, resistenti e dal colore brillante.",
    image: null,
    type: "simple",
    basePrice: 19.5,
  },
  {
    id: "packaging",
    name: "Packaging Personalizzato",
    description: "Scatole e packaging brandizzati per dare valore al tuo prodotto.",
    image: null,
    type: "simple",
    basePrice: 89.0,
  },
];


/* =============================================================
   2. DB — LAYER DATI IBRIDO (server Netlify Blobs + fallback localStorage)
   -------------------------------------------------------------
   COME FUNZIONA:
   - PRODOTTI e ORDINI vengono salvati/letti dal SERVER tramite le API
     /api/products e /api/orders (funzioni Netlify che scrivono su Blobs).
     Cosi' i prodotti gestiti dall'Admin li vedono TUTTI i clienti, e gli
     ordini arrivano sul server (non piu' solo sul tuo telefono).
   - Se il server non e' raggiungibile (app aperta in locale, offline, o
     funzioni non ancora attive), l'app ricade automaticamente su
     localStorage, cosi' continua a funzionare comunque.
   - Il CARRELLO resta SEMPRE locale: e' legato al singolo dispositivo.

   Tutti i metodi sono asincroni (Promise), quindi il resto dell'app non
   cambia: usa sempre await DB.getProducts(), DB.upsertProduct(), ecc.
   ============================================================= */

const DB = {
  KEYS: {
    products: "pcs_products", // cache locale dei prodotti (fallback)
    cart: "pcs_cart",
    orders: "pcs_orders",     // cache locale degli ordini (fallback)
  },

  // Flag: true se il backend (funzioni Netlify) risponde. Rilevato all'avvio.
  serverOnline: false,

  /* ---------- utilità localStorage (fallback) ---------- */
  _read(key, fallback) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn("DB read error", key, e);
      return fallback;
    }
  },
  _write(key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error("DB write error", key, e);
      return false;
    }
  },

  /* ---------- rilevamento del server ---------- */
  // Prova a contattare l'API prodotti. Se risponde, usiamo il server.
  async detectServer() {
    try {
      const res = await fetch("/api/products", { method: "GET" });
      this.serverOnline = res.ok;
    } catch (e) {
      this.serverOnline = false;
    }
    return this.serverOnline;
  },

  /* ---------- PRODOTTI ---------- */
  async getProducts() {
    // 1) Prova dal server.
    if (this.serverOnline) {
      try {
        const res = await fetch("/api/products");
        if (res.ok) {
          const data = await res.json();
          this._write(this.KEYS.products, data); // aggiorna cache locale
          return data;
        }
      } catch (e) {
        console.warn("getProducts: server non raggiungibile, uso cache locale.", e);
      }
    }
    // 2) Fallback: cache/localStorage.
    return this._read(this.KEYS.products, []);
  },

  async getProduct(id) {
    const products = await this.getProducts();
    return products.find((p) => p.id === id) || null;
  },

  // Salva l'intero catalogo (lo otteniamo, modifichiamo e rimandiamo).
  async _saveProducts(products) {
    this._write(this.KEYS.products, products); // sempre in cache locale
    if (this.serverOnline) {
      try {
        await fetch("/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(products),
        });
      } catch (e) {
        console.warn("_saveProducts: scrittura sul server fallita.", e);
      }
    }
    return products;
  },

  async upsertProduct(product) {
    const products = await this.getProducts();
    const idx = products.findIndex((p) => p.id === product.id);
    if (idx >= 0) products[idx] = product;
    else products.push(product);
    await this._saveProducts(products);
    return product;
  },

  async deleteProduct(id) {
    let products = await this.getProducts();
    products = products.filter((p) => p.id !== id);
    await this._saveProducts(products);
  },

  // Al primo avvio: se il catalogo (server o locale) e' vuoto, carica i demo.
  async seedIfEmpty() {
    const products = await this.getProducts();
    if (!products || products.length === 0) {
      await this._saveProducts(SEED_PRODUCTS);
    }
  },

  /* ---------- CARRELLO (sempre locale) ---------- */
  async getCart() {
    return this._read(this.KEYS.cart, []);
  },
  async saveCart(items) {
    return this._write(this.KEYS.cart, items);
  },

  /* ---------- ORDINI ---------- */
  async getOrders() {
    if (this.serverOnline) {
      try {
        const res = await fetch("/api/orders");
        if (res.ok) return await res.json();
      } catch (e) {
        console.warn("getOrders: server non raggiungibile, uso cache locale.", e);
      }
    }
    return this._read(this.KEYS.orders, []);
  },

  async addOrder(order) {
    // Salva sempre una copia locale (storico sul dispositivo).
    const local = this._read(this.KEYS.orders, []);
    local.push(order);
    this._write(this.KEYS.orders, local);

    // Invia al server, se disponibile.
    if (this.serverOnline) {
      try {
        await fetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(order),
        });
      } catch (e) {
        console.warn("addOrder: invio al server fallito.", e);
      }
    }
    return order;
  },
};


/* =============================================================
   3. HELPER GENERICI
   ============================================================= */

// Selettore comodo.
const $ = (sel, root = document) => root.querySelector(sel);

// Escape HTML per evitare problemi con i contenuti inseriti dall'utente.
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// Formatta un numero in euro a 2 decimali.
function formatEUR(n) {
  return "€ " + Number(n).toFixed(2).replace(".", ",");
}

// ID univoco semplice.
function uid(prefix = "id") {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Toast (notifica temporanea in basso).
let toastTimer = null;
function showToast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast show " + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "toast " + kind;
    setTimeout(() => (el.hidden = true), 250);
  }, 3200);
}

// Modale generica. Riceve HTML e ritorna l'elemento, con funzione di chiusura.
function openModal(innerHtml) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "modal-overlay";
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
  return overlay;
}
function closeModal() {
  const ex = $("#modal-overlay");
  if (ex) ex.remove();
}

// Converte un File in stringa base64 (data URL). Usato per salvare l'anteprima.
// NOTA: in produzione il file andrà inviato al server, NON salvato in base64.
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


/* =============================================================
   4. CALCOLO PREZZO ADESIVI PERSONALIZZATI
   -------------------------------------------------------------
   Implementa esattamente la formula richiesta.
   Ritorna un oggetto con esito, prezzo finale e dati di debug.
   ============================================================= */

function calculateStickerPrice({ stickerWidth, stickerHeight, quantity, materialCostPerMeter }) {
  const usableRollWidth = ROLL.usableRollWidth; // 127
  const gap = ROLL.gap;                          // 0.4

  // Validazione input di base.
  if (!(stickerWidth > 0) || !(stickerHeight > 0) || !(quantity > 0)) {
    return { ok: false, error: "Inserisci dimensioni e quantità valide." };
  }

  // Quanti adesivi entrano in una riga del rotolo.
  const stickersPerRow = Math.floor((usableRollWidth + gap) / (stickerWidth + gap));

  // Se nemmeno un adesivo entra in larghezza -> errore.
  if (stickersPerRow < 1) {
    return { ok: false, error: "Dimensione troppo grande per il rotolo disponibile." };
  }

  // Numero di righe necessarie per la quantità richiesta.
  const rows = Math.ceil(quantity / stickersPerRow);

  // Lunghezza di rotolo usata (in cm), considerando i gap verticali tra le righe.
  const usedLengthCm = rows * stickerHeight + (rows - 1) * gap;

  // Conversione in metri.
  const usedLengthMeters = usedLengthCm / 100;

  // Prezzo finale.
  const price = usedLengthMeters * materialCostPerMeter;

  return {
    ok: true,
    price: price,
    priceRounded: Number(price.toFixed(2)),
    // Dati tecnici: il cliente NON li vede, servono solo all'admin/debug.
    debug: {
      stickersPerRow,
      rows,
      usedLengthCm: Number(usedLengthCm.toFixed(2)),
      usedLengthMeters: Number(usedLengthMeters.toFixed(4)),
      materialCostPerMeter,
      finalPrice: Number(price.toFixed(2)),
    },
  };
}

// Dato lo "shape" e i campi inseriti, ricava larghezza e altezza in cm.
function resolveStickerDimensions(shapeId, dims) {
  switch (shapeId) {
    case "quadrati":
      return { width: dims.side, height: dims.side };
    case "rotondi":
      return { width: dims.diameter, height: dims.diameter };
    case "rettangolari":
    case "sagomati":
      return { width: dims.width, height: dims.height };
    default:
      return { width: 0, height: 0 };
  }
}


/* =============================================================
   5. CARRELLO (LOGICA)
   ============================================================= */

async function addToCart(item) {
  const cart = await DB.getCart();
  cart.push(item);
  await DB.saveCart(cart);
  await refreshCartCount();
}

async function removeFromCart(lineId) {
  let cart = await DB.getCart();
  cart = cart.filter((i) => i.lineId !== lineId);
  await DB.saveCart(cart);
  await refreshCartCount();
}

async function cartTotal() {
  const cart = await DB.getCart();
  return cart.reduce((sum, i) => sum + Number(i.price || 0), 0);
}

async function refreshCartCount() {
  const cart = await DB.getCart();
  const count = cart.length;
  $("#cart-count").textContent = count;
  $("#cart-count").style.display = count > 0 ? "grid" : "none";
}


/* =============================================================
   6. INVIO ORDINE
   -------------------------------------------------------------
   sendOrderToWebhook(orderData) prova a inviare l'ordine all'endpoint.
   COME COLLEGARLO IN FUTURO:
   - Telegram: crea un backend (es. funzione serverless) che riceve il POST
     su /api/send-order e inoltra il messaggio con la Telegram Bot API
     usando il TOKEN salvato lato SERVER (mai nel frontend!).
   - Signal: stesso schema, il backend usa signal-cli o un'API Signal.
   - Webhook serverless / database: il backend salva l'ordine e/o notifica te.

   Per ora, se l'endpoint non esiste, l'app:
   - salva l'ordine in localStorage,
   - mostra un messaggio,
   - stampa l'oggetto ordine completo in console.
   ============================================================= */

async function sendOrderToWebhook(orderData) {
  try {
    const response = await fetch(ORDER_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderData),
    });

    if (!response.ok) throw new Error("HTTP " + response.status);

    // Se in futuro il backend risponde correttamente, gestisci qui la risposta.
    const result = await response.json().catch(() => ({}));
    return { sent: true, result };
  } catch (err) {
    // Fallback: nessun backend ancora collegato.
    console.warn("Webhook non disponibile, uso il fallback locale.", err);
    return { sent: false, error: String(err) };
  }
}


/* =============================================================
   7. VISTE
   ============================================================= */

const app = $("#view");

/* ---------- 7.1 CATALOGO (Homepage) ---------- */
async function renderCatalog() {
  const products = await DB.getProducts();

  const cards = products
    .map((p) => {
      const isConfig = p.type === "configurator";
      // Se il configuratore è disattivato, mostralo come non disponibile.
      const disabled = isConfig && p.active === false;
      const priceLabel = isConfig
        ? `<span class="price">Da configurare</span>`
        : `<span class="price">${formatEUR(p.basePrice)}</span>`;
      const tag = isConfig
        ? `<span class="tag">Configurabile</span>`
        : `<span class="tag green">Pronto</span>`;
      const media = p.image
        ? `<img src="${p.image}" alt="${escapeHtml(p.name)}" />`
        : `<span class="ph">Nessuna immagine</span>`;

      return `
        <a class="card" href="#/product/${encodeURIComponent(p.id)}" data-link
           style="${disabled ? "opacity:.55;pointer-events:none" : ""}">
          <div class="card-media">${media}</div>
          <div class="card-body">
            <div class="card-foot" style="margin:0 0 2px">${tag}</div>
            <h3>${escapeHtml(p.name)}</h3>
            <p class="desc">${escapeHtml((p.description || "").slice(0, 80))}${(p.description||"").length>80?"…":""}</p>
            <div class="card-foot">${priceLabel}</div>
          </div>
        </a>`;
    })
    .join("");

  app.innerHTML = `
    <section class="hero hero-img">
      <div class="hero-overlay">
        <span class="hero-badge">Bunker Sweet</span>
        <h1>Crea i tuoi prodotti personalizzati</h1>
        <p>Adesivi, stampe e packaging con il tuo design. Configura, carica il file e ordina in pochi tap.</p>
      </div>
    </section>

    <div class="page-head">
      <span class="kicker">Catalogo</span>
      <h1>I nostri prodotti</h1>
    </div>

    <div class="grid">${cards || `<p class="muted">Nessun prodotto. Aggiungine uno dall'area Admin.</p>`}</div>
  `;
}

/* ---------- 7.2 DETTAGLIO PRODOTTO ---------- */
async function renderProduct(id) {
  const p = await DB.getProduct(id);
  if (!p) {
    app.innerHTML = `<div class="empty"><div class="ico">🔍</div><h2>Prodotto non trovato</h2><a class="btn btn-primary spaced" href="#/" data-link>Torna al catalogo</a></div>`;
    return;
  }

  // Se è il prodotto con configuratore adesivi -> mostra il configuratore.
  if (p.type === "configurator" && p.configurator === "stickers") {
    return renderStickerConfigurator(p);
  }

  // Altrimenti -> prodotto semplice con prezzo base.
  const media = p.image
    ? `<img src="${p.image}" alt="${escapeHtml(p.name)}" />`
    : `<span class="ph">Nessuna immagine</span>`;

  app.innerHTML = `
    <a class="back-link" href="#/" data-link>← Torna al catalogo</a>
    <div class="detail">
      <div class="detail-media">${media}</div>
      <div>
        <span class="kicker">Prodotto</span>
        <h1>${escapeHtml(p.name)}</h1>
        <p class="lead">${escapeHtml(p.description || "")}</p>
        <div class="big-price">${formatEUR(p.basePrice)}</div>

        <div class="panel">
          <div class="field">
            <label for="simple-qty">Quantità</label>
            <input type="number" id="simple-qty" min="1" value="1" />
          </div>

          <div class="field">
            <label>Carica il tuo logo / file (PNG, JPG, PDF)</label>
            ${uploaderHtml()}
          </div>
          <p class="note">In demo il file resta solo sul dispositivo. Nella versione finale sarà inviato al server.</p>

          <button class="btn btn-primary" id="add-simple">Aggiungi al carrello</button>
        </div>
      </div>
    </div>
  `;

  // Stato file caricato per questo prodotto.
  let uploadedFile = null;
  bindUploader((fileData) => (uploadedFile = fileData));

  $("#add-simple").addEventListener("click", async () => {
    const qty = Math.max(1, parseInt($("#simple-qty").value, 10) || 1);
    const price = Number((p.basePrice * qty).toFixed(2));
    await addToCart({
      lineId: uid("line"),
      productId: p.id,
      name: p.name,
      qty,
      configLabel: `Quantità: ${qty}`,
      config: { qty },
      price,
      image: p.image,
      file: uploadedFile, // { dataUrl, name, type } oppure null
    });
    showToast("Aggiunto al carrello ✓", "success");
    location.hash = "#/cart";
  });
}

/* ---------- 7.3 CONFIGURATORE ADESIVI ---------- */
async function renderStickerConfigurator(p) {
  // Markup dei tipi di adesivo (chip selezionabili).
  const typeChips = STICKER_TYPES.map(
    (t, i) => `
    <label class="choice ${i === 0 ? "selected" : ""}" data-type="${t.id}">
      <input type="radio" name="stype" value="${t.id}" ${i === 0 ? "checked" : ""}>
      <div class="ttl">${escapeHtml(t.name)}</div>
      <div class="sub">${t.pricePerMeter}€ / metro</div>
    </label>`
  ).join("");

  // Markup delle forme.
  const shapeChips = SHAPES.map(
    (s, i) => `
    <label class="choice ${i === 0 ? "selected" : ""}" data-shape="${s.id}">
      <input type="radio" name="shape" value="${s.id}" ${i === 0 ? "checked" : ""}>
      <div class="ttl">${escapeHtml(s.name)}</div>
    </label>`
  ).join("");

  app.innerHTML = `
    <a class="back-link" href="#/" data-link>← Torna al catalogo</a>
    <div class="page-head">
      <span class="kicker">Configuratore</span>
      <h1>${escapeHtml(p.name)}</h1>
      <p>${escapeHtml(p.description || "")}</p>
    </div>

    <div class="detail">
      <div>
        <div class="panel">
          <h2>1. Tipo di adesivo</h2>
          <div class="choice-grid" id="type-grid">${typeChips}</div>
        </div>

        <div class="panel">
          <h2>2. Forma</h2>
          <div class="choice-grid" id="shape-grid">${shapeChips}</div>
        </div>

        <div class="panel">
          <h2>3. Dimensione e quantità</h2>
          <div id="dim-fields"></div>
          <div class="field">
            <label for="qty">Quantità</label>
            <input type="number" id="qty" min="1" value="100" />
          </div>
        </div>

        <div class="panel">
          <h2>4. Il tuo file</h2>
          <div class="field">
            <label>Carica il tuo logo / file (PNG, JPG, PDF)</label>
            ${uploaderHtml()}
          </div>
          <p class="note">In demo il file resta solo sul dispositivo. Nella versione finale sarà inviato al server.</p>
        </div>
      </div>

      <div>
        <!-- BOX PREZZO (visione cliente: solo prezzo finale pulito) -->
        <div class="price-box">
          <div>
            <div class="lab">Prezzo stimato</div>
            <div class="val" id="price-val">—</div>
          </div>
        </div>
        <div class="price-error" id="price-err" hidden></div>

        <button class="btn btn-primary" id="add-sticker">Aggiungi al carrello</button>
        <p class="note center">Il prezzo si aggiorna automaticamente in base alle tue scelte.</p>
      </div>
    </div>
  `;

  // ---- Stato del configuratore ----
  const state = {
    typeId: STICKER_TYPES[0].id,
    shapeId: SHAPES[0].id,
    dims: {},
    quantity: 100,
    file: null,
    lastResult: null,
  };

  // Disegna i campi dimensione in base alla forma scelta.
  function renderDimFields() {
    const shape = SHAPES.find((s) => s.id === state.shapeId);
    const labels = {
      side: "Lato (cm)",
      diameter: "Diametro (cm)",
      width: "Larghezza (cm)",
      height: state.shapeId === "sagomati" ? "Altezza massima (cm)" : "Altezza (cm)",
    };
    const inputs = shape.fields
      .map(
        (f) => `
        <div class="field">
          <label for="dim-${f}">${labels[f]}</label>
          <input type="number" id="dim-${f}" data-dim="${f}" min="0.1" step="0.1" placeholder="es. 5" />
        </div>`
      )
      .join("");
    // Se ci sono due campi, mettili in riga.
    $("#dim-fields").innerHTML =
      shape.fields.length === 2 ? `<div class="field-row">${inputs}</div>` : inputs;

    // Collega gli input dimensione.
    $("#dim-fields").querySelectorAll("input[data-dim]").forEach((inp) => {
      inp.addEventListener("input", () => {
        state.dims[inp.dataset.dim] = parseFloat(inp.value) || 0;
        recompute();
      });
    });
    state.dims = {}; // reset dimensioni al cambio forma
  }

  // Ricalcola il prezzo e aggiorna l'interfaccia.
  function recompute() {
    const type = STICKER_TYPES.find((t) => t.id === state.typeId);
    const { width, height } = resolveStickerDimensions(state.shapeId, state.dims);

    const result = calculateStickerPrice({
      stickerWidth: width,
      stickerHeight: height,
      quantity: state.quantity,
      materialCostPerMeter: type.pricePerMeter,
    });
    state.lastResult = result;

    const valEl = $("#price-val");
    const errEl = $("#price-err");
    const addBtn = $("#add-sticker");

    if (!result.ok) {
      valEl.textContent = "—";
      errEl.textContent = result.error;
      errEl.hidden = false;
      addBtn.disabled = true;
    } else {
      valEl.textContent = formatEUR(result.priceRounded);
      errEl.hidden = true;
      addBtn.disabled = false;
    }
  }

  // ---- Collega selezione TIPO ----
  $("#type-grid").querySelectorAll(".choice").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("#type-grid").querySelectorAll(".choice").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      chip.querySelector("input").checked = true;
      state.typeId = chip.dataset.type;
      recompute();
    });
  });

  // ---- Collega selezione FORMA ----
  $("#shape-grid").querySelectorAll(".choice").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("#shape-grid").querySelectorAll(".choice").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      chip.querySelector("input").checked = true;
      state.shapeId = chip.dataset.shape;
      renderDimFields();
      recompute();
    });
  });

  // ---- Quantità ----
  $("#qty").addEventListener("input", () => {
    state.quantity = Math.max(1, parseInt($("#qty").value, 10) || 1);
    recompute();
  });

  // ---- Upload file ----
  bindUploader((fileData) => (state.file = fileData));

  // ---- Aggiungi al carrello ----
  $("#add-sticker").addEventListener("click", async () => {
    if (!state.lastResult || !state.lastResult.ok) {
      showToast("Controlla le dimensioni inserite.", "error");
      return;
    }
    const type = STICKER_TYPES.find((t) => t.id === state.typeId);
    const shape = SHAPES.find((s) => s.id === state.shapeId);
    const { width, height } = resolveStickerDimensions(state.shapeId, state.dims);

    // Etichetta leggibile della configurazione scelta (per carrello e ordine).
    const dimText =
      state.shapeId === "rotondi"
        ? `Ø ${state.dims.diameter} cm`
        : state.shapeId === "quadrati"
        ? `${state.dims.side}×${state.dims.side} cm`
        : `${width}×${height} cm`;

    const configLabel = `${type.name} · ${shape.name} · ${dimText} · Qtà ${state.quantity}`;

    await addToCart({
      lineId: uid("line"),
      productId: p.id,
      name: p.name,
      qty: state.quantity,
      configLabel,
      config: {
        typeId: state.typeId,
        typeName: type.name,
        shapeId: state.shapeId,
        shapeName: shape.name,
        width,
        height,
        quantity: state.quantity,
        debug: state.lastResult.debug, // dati tecnici salvati per l'admin
      },
      price: state.lastResult.priceRounded,
      image: p.image,
      file: state.file,
    });

    showToast("Adesivi aggiunti al carrello ✓", "success");
    location.hash = "#/cart";
  });

  // Disegno iniziale dei campi dimensione + primo calcolo.
  renderDimFields();
  recompute();
}

/* ---------- 7.4 CARRELLO ---------- */
async function renderCart() {
  const cart = await DB.getCart();

  if (cart.length === 0) {
    app.innerHTML = `
      <div class="empty">
        <div class="ico">🛒</div>
        <h2>Il carrello è vuoto</h2>
        <p class="muted">Aggiungi qualche prodotto per iniziare.</p>
        <a class="btn btn-primary spaced" href="#/" data-link style="max-width:260px;margin:18px auto 0">Vai al catalogo</a>
      </div>`;
    return;
  }

  const rows = cart
    .map((i) => {
      const media = i.file && i.file.type && i.file.type.startsWith("image/")
        ? `<img src="${i.file.dataUrl}" alt="file">`
        : i.file
        ? `<div class="fp-doc">${(i.file.name || "FILE").split(".").pop().toUpperCase()}</div>`
        : i.image
        ? `<img src="${i.image}" alt="${escapeHtml(i.name)}">`
        : `<span class="muted">—</span>`;
      const fileLine = i.file ? `<div class="ci-config">File: ${escapeHtml(i.file.name)}</div>` : "";

      return `
        <div class="cart-item">
          <div class="ci-media">${media}</div>
          <div>
            <h3>${escapeHtml(i.name)}</h3>
            <div class="ci-config">${escapeHtml(i.configLabel || "")}</div>
            ${fileLine}
          </div>
          <div class="ci-right">
            <div class="ci-price">${formatEUR(i.price)}</div>
            <button class="link-remove" data-remove="${i.lineId}">Rimuovi</button>
          </div>
        </div>`;
    })
    .join("");

  const total = await cartTotal();

  app.innerHTML = `
    <div class="page-head">
      <span class="kicker">Carrello</span>
      <h1>Il tuo ordine</h1>
    </div>
    ${rows}
    <div class="summary">
      <div class="row total"><span>Totale</span><span>${formatEUR(total)}</span></div>
    </div>
    <button class="btn btn-primary spaced" id="go-checkout">Procedi al checkout</button>
  `;

  app.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await removeFromCart(btn.dataset.remove);
      renderCart();
      showToast("Prodotto rimosso", "");
    });
  });

  $("#go-checkout").addEventListener("click", () => (location.hash = "#/checkout"));
}

/* ---------- 7.5 CHECKOUT ---------- */
async function renderCheckout() {
  const cart = await DB.getCart();
  if (cart.length === 0) {
    location.hash = "#/cart";
    return;
  }
  const total = await cartTotal();

  app.innerHTML = `
    <a class="back-link" href="#/cart" data-link>← Torna al carrello</a>
    <div class="page-head">
      <span class="kicker">Checkout</span>
      <h1>I tuoi dati</h1>
    </div>

    <div class="panel">
      <div class="field">
        <label for="ck-name">Nome e cognome *</label>
        <input id="ck-name" type="text" placeholder="Mario Rossi" />
      </div>
      <div class="field">
        <label for="ck-phone">Telefono *</label>
        <input id="ck-phone" type="tel" placeholder="+39 ..." />
      </div>
      <div class="field">
        <label for="ck-email">Email *</label>
        <input id="ck-email" type="email" placeholder="email@esempio.it" />
      </div>
      <div class="field">
        <label for="ck-address">Indirizzo o note di consegna *</label>
        <textarea id="ck-address" placeholder="Via, città, CAP..."></textarea>
      </div>

      <hr class="divider">
      <p class="muted" style="margin:0 0 14px">Come preferisci essere ricontattato? (facoltativo)</p>
      <div class="field">
        <label for="ck-instagram">Instagram</label>
        <input id="ck-instagram" type="text" placeholder="@iltuonome" />
      </div>
      <div class="field">
        <label for="ck-telegram">Telegram</label>
        <input id="ck-telegram" type="text" placeholder="@iltuonome o numero" />
      </div>
      <div class="field">
        <label for="ck-signal">Signal</label>
        <input id="ck-signal" type="text" placeholder="Numero o username Signal" />
      </div>
      <hr class="divider">

      <div class="field">
        <label for="ck-notes">Note aggiuntive</label>
        <textarea id="ck-notes" placeholder="Eventuali richieste particolari"></textarea>
      </div>
    </div>

    <div class="summary">
      <div class="row total"><span>Totale ordine</span><span>${formatEUR(total)}</span></div>
    </div>

    <p class="muted center spaced">Scegli come pagare:</p>
    <div class="btn-row" style="flex-direction:column">
      <button class="btn btn-primary" id="pay-card">💳 Paga con carta</button>
      <button class="btn btn-green" id="pay-crypto">🪙 Paga con crypto</button>
    </div>
    <p class="note center">Verrai indirizzato a una pagina di pagamento sicura. Il tuo ordine viene salvato prima del pagamento.</p>
  `;

  $("#pay-card").addEventListener("click", () => submitOrder("card"));
  $("#pay-crypto").addEventListener("click", () => submitOrder("crypto"));
}

// Raccoglie i dati, salva l'ordine, e avvia il pagamento scelto.
// method: "card" | "crypto"
async function submitOrder(method) {
  const name = $("#ck-name").value.trim();
  const phone = $("#ck-phone").value.trim();
  const email = $("#ck-email").value.trim();
  const address = $("#ck-address").value.trim();
  const instagram = $("#ck-instagram").value.trim();
  const telegram = $("#ck-telegram").value.trim();
  const signal = $("#ck-signal").value.trim();
  const notes = $("#ck-notes").value.trim();

  // Validazione minima.
  if (!name || !phone || !email || !address) {
    showToast("Compila i campi obbligatori (*).", "error");
    return;
  }

  const cart = await DB.getCart();
  const total = await cartTotal();

  // Oggetto ordine completo.
  const orderData = {
    orderId: uid("order"),
    createdAt: new Date().toISOString(),
    paymentMethod: method,
    paymentStatus: "in attesa",
    customer: { name, phone, email, address, instagram, telegram, signal, notes },
    items: cart.map((i) => ({
      productId: i.productId,
      name: i.name,
      qty: i.qty,
      configLabel: i.configLabel,
      config: i.config,
      price: i.price,
      file: i.file ? { name: i.file.name, type: i.file.type } : null,
    })),
    total: Number(total.toFixed(2)),
  };

  const cardBtn = $("#pay-card");
  const cryptoBtn = $("#pay-crypto");
  if (cardBtn) cardBtn.disabled = true;
  if (cryptoBtn) cryptoBtn.disabled = true;
  const activeBtn = method === "card" ? cardBtn : cryptoBtn;
  const originalText = activeBtn ? activeBtn.textContent : "";
  if (activeBtn) activeBtn.textContent = "Preparazione pagamento...";

  // Salva sempre l'ordine prima di mandare al pagamento.
  await DB.addOrder(orderData);
  console.log("===== ORDINE CREATO =====", orderData);

  // Avvia il pagamento sul server.
  const endpoint = method === "card" ? "/api/pay-card" : "/api/pay-crypto";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cart, order: orderData }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.url) {
        // Svuota il carrello e vai alla pagina di pagamento sicura.
        await DB.saveCart([]);
        await refreshCartCount();
        window.location.href = data.url;
        return;
      }
    }
    // Se arriviamo qui, il pagamento non è configurato/disponibile.
    throw new Error("Pagamento non disponibile");
  } catch (err) {
    console.warn("Pagamento non disponibile, uso il fallback ordine.", err);
    // FALLBACK: nessun pagamento collegato ancora -> salva e conferma.
    await DB.saveCart([]);
    await refreshCartCount();
    if (activeBtn) activeBtn.textContent = originalText;
    showOrderConfirm(
      "Ordine salvato! Il pagamento online sarà attivo a breve: ti contatteremo per completare l'ordine.",
      orderData.orderId
    );
  }
}

function showOrderConfirm(message, orderId) {
  app.innerHTML = `
    <div class="empty">
      <div class="ico">✅</div>
      <h2>Grazie!</h2>
      <p class="muted">${escapeHtml(message)}</p>
      <p class="muted">Riferimento ordine: <b>${escapeHtml(orderId)}</b></p>
      <a class="btn btn-primary spaced" href="#/" data-link style="max-width:260px;margin:18px auto 0">Torna al catalogo</a>
    </div>`;
}

// Pagina di ritorno dopo il pagamento (success_url delle funzioni di pagamento).
function renderThankYou() {
  // Legge i parametri dall'hash, es. #/grazie?paid=1&order=order_xxx
  const q = (location.hash.split("?")[1] || "");
  const params = new URLSearchParams(q);
  const paid = params.get("paid") === "1";
  const order = params.get("order") || "";
  app.innerHTML = `
    <div class="empty">
      <div class="ico">${paid ? "🎉" : "✅"}</div>
      <h2>${paid ? "Pagamento ricevuto!" : "Grazie!"}</h2>
      <p class="muted">${paid ? "Il tuo ordine è confermato. Ti contatteremo per i dettagli." : "Ordine registrato."}</p>
      ${order ? `<p class="muted">Riferimento ordine: <b>${escapeHtml(order)}</b></p>` : ""}
      <a class="btn btn-primary spaced" href="#/" data-link style="max-width:260px;margin:18px auto 0">Torna al catalogo</a>
    </div>`;
}

/* ---------- 7.6 ADMIN ---------- */
let adminUnlocked = false; // resta sbloccato finché la sessione (tab) è aperta

async function renderAdmin() {
  if (!adminUnlocked) return renderAdminPin();

  const products = await DB.getProducts();
  const orders = await DB.getOrders();

  const rows = products
    .map((p) => {
      const media = p.image ? `<img src="${p.image}" alt="">` : "IMG";
      const meta =
        p.type === "configurator"
          ? `Configuratore adesivi · ${p.active === false ? "DISATTIVO" : "attivo"}`
          : `Prezzo base ${formatEUR(p.basePrice)}`;
      return `
        <div class="admin-row">
          <div class="ar-media">${media}</div>
          <div>
            <h3>${escapeHtml(p.name)}</h3>
            <div class="ar-meta">${meta}</div>
          </div>
          <div class="btn-row">
            <button class="btn btn-sm btn-ghost" data-edit="${p.id}">Modifica</button>
            <button class="btn btn-sm btn-danger" data-del="${p.id}">Elimina</button>
          </div>
        </div>`;
    })
    .join("");

  app.innerHTML = `
    <div class="page-head">
      <span class="kicker">Area riservata</span>
      <h1>Admin</h1>
      <p>Gestisci prodotti, prezzi e configuratore. Ordini ricevuti: <b>${orders.length}</b>.</p>
    </div>

    <div class="btn-row" style="margin-bottom:16px">
      <button class="btn btn-primary btn-sm" id="add-product">+ Aggiungi prodotto</button>
      <button class="btn btn-ghost btn-sm" id="view-orders">Vedi ordini (${orders.length})</button>
      <button class="btn btn-ghost btn-sm" id="lock-admin">Esci</button>
    </div>

    <div class="admin-list">${rows || `<p class="muted">Nessun prodotto.</p>`}</div>
  `;

  $("#add-product").addEventListener("click", () => openProductForm(null));
  $("#lock-admin").addEventListener("click", () => {
    adminUnlocked = false;
    renderAdminPin();
  });
  $("#view-orders").addEventListener("click", showOrdersModal);

  app.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", async () => {
      const product = await DB.getProduct(b.dataset.edit);
      openProductForm(product);
    })
  );
  app.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (confirm("Eliminare questo prodotto?")) {
        await DB.deleteProduct(b.dataset.del);
        showToast("Prodotto eliminato", "");
        renderAdmin();
      }
    })
  );
}

// Schermata PIN.
function renderAdminPin() {
  app.innerHTML = `
    <div class="pin-wrap">
      <div class="ico" style="font-size:42px">🔒</div>
      <h2>Area Admin</h2>
      <p class="muted">Inserisci il PIN (demo: 1234)</p>
      <div class="field spaced">
        <input id="pin-input" type="password" inputmode="numeric" maxlength="8" placeholder="••••" style="text-align:center;font-size:22px;letter-spacing:6px" />
      </div>
      <button class="btn btn-primary" id="pin-submit">Sblocca</button>
    </div>
  `;
  const submit = () => {
    if ($("#pin-input").value === ADMIN_PIN) {
      adminUnlocked = true;
      renderAdmin();
    } else {
      showToast("PIN errato.", "error");
      $("#pin-input").value = "";
    }
  };
  $("#pin-submit").addEventListener("click", submit);
  $("#pin-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

// Form di creazione/modifica prodotto (in modale).
function openProductForm(product) {
  const isEdit = !!product;
  const p = product || {
    id: uid("prod"),
    name: "",
    description: "",
    image: null,
    type: "simple",
    basePrice: 0,
    active: true,
  };
  const isConfigurator = p.type === "configurator";

  const overlay = openModal(`
    <h2>${isEdit ? "Modifica prodotto" : "Nuovo prodotto"}</h2>

    <div class="field">
      <label for="pf-name">Nome prodotto *</label>
      <input id="pf-name" type="text" value="${escapeHtml(p.name)}" />
    </div>

    <div class="field">
      <label for="pf-desc">Descrizione</label>
      <textarea id="pf-desc">${escapeHtml(p.description || "")}</textarea>
    </div>

    <div class="field">
      <label>Immagine prodotto</label>
      ${uploaderHtml(p.image, "Carica immagine")}
    </div>

    <div class="field">
      <label class="choice" style="display:flex;align-items:center;gap:10px;cursor:pointer">
        <input type="checkbox" id="pf-config" ${isConfigurator ? "checked" : ""} style="width:auto;position:static;opacity:1">
        <span>Attiva il configuratore speciale per adesivi personalizzati</span>
      </label>
    </div>

    <div class="field" id="pf-price-wrap" ${isConfigurator ? 'style="display:none"' : ""}>
      <label for="pf-price">Prezzo base (€) — per prodotti semplici</label>
      <input id="pf-price" type="number" min="0" step="0.01" value="${p.basePrice != null ? p.basePrice : 0}" />
    </div>

    <div class="field" id="pf-active-wrap" ${isConfigurator ? "" : 'style="display:none"'}>
      <label class="choice" style="display:flex;align-items:center;gap:10px;cursor:pointer">
        <input type="checkbox" id="pf-active" ${p.active !== false ? "checked" : ""} style="width:auto;position:static;opacity:1">
        <span>Configuratore attivo (visibile e ordinabile)</span>
      </label>
    </div>

    <hr class="divider">
    <div class="btn-row">
      <button class="btn btn-primary" id="pf-save">${isEdit ? "Salva modifiche" : "Crea prodotto"}</button>
      <button class="btn btn-ghost" id="pf-cancel">Annulla</button>
    </div>
  `);

  // Stato immagine (mantiene quella esistente finché non se ne carica una nuova).
  let imageData = p.image ? { dataUrl: p.image } : null;
  bindUploader((fileData) => (imageData = fileData), overlay);

  // Mostra/nasconde i campi in base al toggle configuratore.
  $("#pf-config", overlay).addEventListener("change", (e) => {
    const on = e.target.checked;
    $("#pf-price-wrap", overlay).style.display = on ? "none" : "";
    $("#pf-active-wrap", overlay).style.display = on ? "" : "none";
  });

  $("#pf-cancel", overlay).addEventListener("click", closeModal);

  $("#pf-save", overlay).addEventListener("click", async () => {
    const name = $("#pf-name", overlay).value.trim();
    if (!name) {
      showToast("Inserisci il nome prodotto.", "error");
      return;
    }
    const useConfig = $("#pf-config", overlay).checked;

    const newProduct = {
      id: p.id,
      name,
      description: $("#pf-desc", overlay).value.trim(),
      image: imageData ? imageData.dataUrl : null,
      type: useConfig ? "configurator" : "simple",
    };
    if (useConfig) {
      newProduct.configurator = "stickers";
      newProduct.active = $("#pf-active", overlay).checked;
      newProduct.basePrice = null;
    } else {
      newProduct.basePrice = parseFloat($("#pf-price", overlay).value) || 0;
    }

    await DB.upsertProduct(newProduct);
    closeModal();
    showToast(isEdit ? "Prodotto aggiornato ✓" : "Prodotto creato ✓", "success");
    renderAdmin();
  });
}

// Modale elenco ordini salvati (con dati di debug del configuratore).
async function showOrdersModal() {
  const orders = await DB.getOrders();
  const list = orders.length
    ? orders
        .slice()
        .reverse()
        .map((o) => {
          const items = o.items
            .map((it) => {
              const dbg = it.config && it.config.debug ? it.config.debug : null;
              const debugHtml = dbg
                ? `<div class="debug">
                     <b>Debug calcolo adesivi:</b><br>
                     Adesivi per riga: ${dbg.stickersPerRow}<br>
                     Righe necessarie: ${dbg.rows}<br>
                     Lunghezza usata: ${dbg.usedLengthCm} cm<br>
                     Metri usati: ${dbg.usedLengthMeters} m<br>
                     Costo al metro: ${dbg.materialCostPerMeter}€<br>
                     Prezzo finale: ${formatEUR(dbg.finalPrice)}
                   </div>`
                : "";
              return `<div class="ar-meta" style="margin:6px 0">• ${escapeHtml(it.name)} — ${escapeHtml(it.configLabel || "")} — ${formatEUR(it.price)}${it.file ? " — file: " + escapeHtml(it.file.name) : ""}</div>${debugHtml}`;
            })
            .join("");
          return `
            <div class="panel">
              <h3 style="font-size:15px">${escapeHtml(o.customer.name)} — ${formatEUR(o.total)}</h3>
              <div class="ar-meta">
                ${o.paymentStatus === "pagato"
                  ? '<span class="tag green">✓ Pagato</span>'
                  : '<span class="tag">In attesa di pagamento</span>'}
                ${o.paymentMethod ? " · " + (o.paymentMethod === "card" ? "Carta" : "Crypto") : ""}
              </div>
              <div class="ar-meta">${escapeHtml(o.customer.email)} · ${escapeHtml(o.customer.phone)}</div>
              <div class="ar-meta">${escapeHtml(o.customer.address)}</div>
              ${[
                o.customer.instagram ? "IG: " + escapeHtml(o.customer.instagram) : "",
                o.customer.telegram ? "Telegram: " + escapeHtml(o.customer.telegram) : "",
                o.customer.signal ? "Signal: " + escapeHtml(o.customer.signal) : "",
              ].filter(Boolean).length
                ? `<div class="ar-meta">${[
                    o.customer.instagram ? "IG: " + escapeHtml(o.customer.instagram) : "",
                    o.customer.telegram ? "Telegram: " + escapeHtml(o.customer.telegram) : "",
                    o.customer.signal ? "Signal: " + escapeHtml(o.customer.signal) : "",
                  ].filter(Boolean).join(" · ")}</div>`
                : ""}
              <div style="margin-top:8px">${items}</div>
            </div>`;
        })
        .join("")
    : `<p class="muted">Nessun ordine ricevuto.</p>`;

  const overlay = openModal(`
    <h2>Ordini ricevuti</h2>
    ${list}
    <button class="btn btn-ghost spaced" id="orders-close">Chiudi</button>
  `);
  $("#orders-close", overlay).addEventListener("click", closeModal);
}


/* ---------- COMPONENTE UPLOADER (riutilizzabile) ---------- */

// HTML dell'uploader. Se passi un'immagine esistente, mostra l'anteprima.
function uploaderHtml(existingImage = null, ctaText = "Carica un file") {
  const preview = existingImage
    ? `<div class="file-preview"><img src="${existingImage}" alt="anteprima"><span class="fp-name">Immagine attuale</span></div>`
    : "";
  return `
    <label class="uploader">
      <input type="file" class="file-input" accept="${ACCEPTED_FILES}">
      <div class="upload-cta">${ctaText}</div>
      <div class="hint">PNG, JPG, JPEG o PDF</div>
    </label>
    <div class="file-preview-slot">${preview}</div>
  `;
}

// Collega il comportamento dell'uploader presente nel DOM (o in un contenitore).
// onFile riceve { dataUrl, name, type } oppure null.
function bindUploader(onFile, root = document) {
  const input = root.querySelector(".file-input");
  const slot = root.querySelector(".file-preview-slot");
  if (!input) return;

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    // Validazione tipo file.
    const okTypes = ["image/png", "image/jpeg", "application/pdf"];
    if (!okTypes.includes(file.type)) {
      showToast("Formato non valido. Usa PNG, JPG o PDF.", "error");
      input.value = "";
      return;
    }

    // Legge il file come base64 (solo per demo).
    const dataUrl = await fileToDataURL(file);
    const fileData = { dataUrl, name: file.name, type: file.type };

    // Anteprima: immagine se è un'immagine, altrimenti badge documento.
    if (slot) {
      slot.innerHTML = file.type.startsWith("image/")
        ? `<div class="file-preview"><img src="${dataUrl}" alt="anteprima"><span class="fp-name">${escapeHtml(file.name)}</span></div>`
        : `<div class="file-preview"><div class="fp-doc">${file.name.split(".").pop().toUpperCase()}</div><span class="fp-name">${escapeHtml(file.name)}</span></div>`;
    }

    onFile(fileData);
  });
}


/* =============================================================
   8. ROUTER (navigazione via hash)
   ============================================================= */

async function router() {
  const hash = location.hash || "#/";
  const parts = hash.replace(/^#\//, "").split("/"); // es. "product/stickers" -> ["product","stickers"]
  const route = parts[0] || "";

  // Scroll in alto ad ogni cambio pagina.
  window.scrollTo({ top: 0 });

  switch (route) {
    case "":
      await renderCatalog();
      break;
    case "product":
      await renderProduct(decodeURIComponent(parts[1] || ""));
      break;
    case "cart":
      await renderCart();
      break;
    case "checkout":
      await renderCheckout();
      break;
    case "grazie":
      renderThankYou();
      break;
    case "admin":
      await renderAdmin();
      break;
    default:
      await renderCatalog();
  }

  updateActiveNav(route);
}

// Evidenzia la voce attiva nella bottom-nav.
function updateActiveNav(route) {
  document.querySelectorAll(".bn-item").forEach((el) => {
    const r = el.dataset.route;
    const active =
      (r === "home" && (route === "" || route === "product")) ||
      (r === "cart" && (route === "cart" || route === "checkout")) ||
      (r === "admin" && route === "admin");
    el.classList.toggle("active", active);
  });
}

// Intercetta i click sui link interni (data-link) per usare l'hash routing.
document.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-link]");
  if (link && link.getAttribute("href").startsWith("#")) {
    // Hash routing nativo: niente da fare, lasciamo che cambi l'hash.
    closeModal();
  }
});


/* =============================================================
   9. PWA — Service Worker + bottone "Installa App"
   ============================================================= */

// Registra il service worker (necessario per offline + installazione).
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./service-worker.js")
        .then((reg) => console.log("Service Worker registrato:", reg.scope))
        .catch((err) => console.warn("SW non registrato:", err));
    });
  }
}

// Gestisce il prompt di installazione (Android/desktop Chrome).
let deferredPrompt = null;
function setupInstallPrompt() {
  const btn = $("#install-btn");

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();        // blocca il mini-infobar automatico
    deferredPrompt = e;        // salva l'evento per usarlo al click
    btn.hidden = false;        // mostra il nostro bottone "Installa App"
  });

  btn.addEventListener("click", async () => {
    if (!deferredPrompt) {
      // iOS Safari non supporta beforeinstallprompt: diamo istruzioni manuali.
      showToast("Su iPhone: tocca Condividi → Aggiungi a Home.", "");
      return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btn.hidden = true;
  });

  // Quando l'app è installata, nascondi il bottone.
  window.addEventListener("appinstalled", () => {
    btn.hidden = true;
    showToast("App installata ✓", "success");
  });
}


/* =============================================================
   10. AVVIO APP
   ============================================================= */

async function init() {
  await DB.detectServer();      // rileva se il backend (Netlify Blobs) è attivo
  await DB.seedIfEmpty();       // carica i prodotti demo al primo avvio
  await refreshCartCount();     // aggiorna il badge del carrello
  setupInstallPrompt();         // prepara il bottone "Installa App"
  registerServiceWorker();      // registra il SW per offline/installazione

  window.addEventListener("hashchange", router);
  await router();               // disegna la prima vista
}

document.addEventListener("DOMContentLoaded", init);

{
  "name": "bunker-sweet",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@netlify/blobs": "^8.1.0",
    "stripe": "^17.0.0"
  }
}

# netlify.toml — configurazione del sito Bunker Sweet

[build]
  # Cartella che contiene le funzioni serverless.
  functions = "netlify/functions"
  # Niente build step: e' un sito statico, i file sono gia' pronti.
  publish = "."

# Rotte API "pulite": il frontend chiama /api/... e Netlify le instrada
# verso le funzioni corrispondenti.
[[redirects]]
  from = "/api/products"
  to = "/.netlify/functions/products"
  status = 200

[[redirects]]
  from = "/api/orders"
  to = "/.netlify/functions/orders"
  status = 200

[[redirects]]
  from = "/api/pay-card"
  to = "/.netlify/functions/pay-card"
  status = 200

[[redirects]]
  from = "/api/pay-crypto"
  to = "/.netlify/functions/pay-crypto"
  status = 200

[[redirects]]
  from = "/api/webhook-card"
  to = "/.netlify/functions/webhook-card"
  status = 200

[[redirects]]
  from = "/api/webhook-crypto"
  to = "/.netlify/functions/webhook-crypto"
  status = 200

/* =============================================================
   style.css — Print Custom Store
   Tema: refined / luxury — nero, bianco, grigio chiaro, accento oro.
   Mobile-first e responsive.
   ============================================================= */

/* ----------------------- VARIABILI ----------------------- */
:root {
  --bg: #0a0a0c;
  --bg-soft: #121216;
  --surface: #16161b;
  --surface-2: #1d1d24;
  --line: #2a2a32;
  --text: #f4f4f2;
  --text-dim: #a6a6ad;
  --text-faint: #6f6f78;
  --gold: #c9a227;
  --gold-soft: #e7c95a;
  --green: #36c98a;
  --danger: #e5544b;
  --white: #ffffff;

  --radius-s: 12px;
  --radius: 18px;
  --radius-l: 26px;

  --shadow: 0 18px 40px -18px rgba(0, 0, 0, 0.7);
  --shadow-soft: 0 8px 24px -12px rgba(0, 0, 0, 0.6);

  --font-display: "Bricolage Grotesque", "Trebuchet MS", system-ui, sans-serif;
  --font-body: "Sora", system-ui, -apple-system, "Segoe UI", sans-serif;

  --header-h: 62px;
  --bottomnav-h: 66px;
  --maxw: 1100px;
}

/* ----------------------- RESET ----------------------- */
*,
*::before,
*::after { box-sizing: border-box; }

html, body { margin: 0; padding: 0; }

body {
  font-family: var(--font-body);
  background: radial-gradient(1200px 600px at 80% -10%, #1a1a22 0%, var(--bg) 55%) fixed;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
  line-height: 1.5;
  padding-bottom: calc(var(--bottomnav-h) + env(safe-area-inset-bottom));
}

img { max-width: 100%; display: block; }
button { font-family: inherit; cursor: pointer; }
a { color: inherit; text-decoration: none; }

h1, h2, h3 { font-family: var(--font-display); font-weight: 800; letter-spacing: -0.02em; line-height: 1.08; margin: 0; }

/* ----------------------- HEADER ----------------------- */
.app-header {
  position: sticky; top: 0; z-index: 50;
  background: rgba(10, 10, 12, 0.78);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
  padding-top: env(safe-area-inset-top);
}
.header-inner {
  max-width: var(--maxw); margin: 0 auto;
  height: var(--header-h);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 16px;
}
.brand { display: flex; align-items: center; gap: 10px; }
.brand-mark {
  display: grid; place-items: center;
  width: 40px; height: 40px; border-radius: 11px;
  background: #fff; overflow: hidden; padding: 5px;
  box-shadow: 0 0 0 1px var(--line);
}
.brand-mark img { width: 100%; height: 100%; object-fit: contain; display: block; }
.brand-text { font-family: var(--font-display); font-weight: 800; font-size: 17px; letter-spacing: -0.02em; }
.brand-text em { color: var(--gold); font-style: normal; }

.top-nav { display: flex; align-items: center; gap: 6px; }
.nav-link {
  background: none; border: none; color: var(--text-dim);
  font-size: 14px; padding: 8px 10px; border-radius: 10px;
}
.nav-link:hover { color: var(--text); }
.install-link { color: var(--gold); border: 1px solid var(--line); }
.top-nav .nav-link:not(.install-link) { display: none; }

.cart-btn {
  position: relative; display: grid; place-items: center;
  width: 42px; height: 42px; border-radius: 12px;
  background: var(--surface); border: 1px solid var(--line); color: var(--text);
}
.cart-count {
  position: absolute; top: -6px; right: -6px;
  min-width: 19px; height: 19px; padding: 0 5px;
  display: grid; place-items: center;
  background: var(--gold); color: #1a1300; border-radius: 999px;
  font-size: 11px; font-weight: 700;
}

/* ----------------------- LAYOUT VISTE ----------------------- */
.view { max-width: var(--maxw); margin: 0 auto; padding: 18px 16px 30px; animation: fade .35s ease; }
@keyframes fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

.page-head { margin: 8px 0 20px; }
.page-head h1 { font-size: clamp(28px, 7vw, 42px); }
.page-head p { color: var(--text-dim); margin: 8px 0 0; max-width: 60ch; }
.kicker { color: var(--gold); font-weight: 600; font-size: 12px; letter-spacing: .18em; text-transform: uppercase; }

.back-link {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--text-dim); font-size: 14px; margin-bottom: 14px;
}
.back-link:hover { color: var(--text); }

/* ----------------------- HERO ----------------------- */
.hero {
  position: relative; overflow: hidden;
  border-radius: var(--radius-l);
  border: 1px solid var(--line);
  background:
    radial-gradient(600px 240px at 90% 0%, rgba(201,162,39,.18), transparent 60%),
    linear-gradient(160deg, var(--surface-2), var(--surface));
  padding: 30px 22px;
  margin-bottom: 26px;
}
.hero h1 { font-size: clamp(30px, 8vw, 52px); max-width: 16ch; }
.hero p { color: var(--text-dim); margin: 14px 0 0; max-width: 46ch; }
.hero .hero-badge {
  display: inline-flex; gap: 8px; align-items: center;
  font-size: 12px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--gold); margin-bottom: 14px;
}
.hero .hero-badge::before { content: ""; width: 28px; height: 1px; background: var(--gold); }

/* Variante hero con immagine di sfondo (illustrazione homepage) */
.hero-img {
  background: none;
  padding: 0;
  min-height: 420px;
  display: flex;
  align-items: flex-end;
}
.hero-img::before {
  content: "";
  position: absolute; inset: 0;
  background-image:
    linear-gradient(to top, rgba(10,10,12,.96) 4%, rgba(10,10,12,.55) 42%, rgba(10,10,12,.12) 100%),
    url("./hero.jpg");
  background-size: cover;
  background-position: center 18%;
}
.hero-img .hero-overlay { position: relative; z-index: 1; padding: 26px 22px; width: 100%; }
.hero-img .hero-overlay p { color: #e7e7e4; }
@media (min-width: 720px) { .hero-img { min-height: 480px; } }

/* ----------------------- GRID PRODOTTI ----------------------- */
.grid {
  display: grid; gap: 14px;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
}
@media (min-width: 720px) {
  .grid { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 18px; }
}

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex; flex-direction: column;
  transition: transform .25s ease, border-color .25s ease, box-shadow .25s ease;
}
.card:hover { transform: translateY(-4px); border-color: #3a3a44; box-shadow: var(--shadow); }
.card-media {
  aspect-ratio: 4 / 3; background: var(--surface-2);
  display: grid; place-items: center; overflow: hidden;
}
.card-media img { width: 100%; height: 100%; object-fit: cover; }
.card-media .ph { color: var(--text-faint); font-size: 13px; }
.card-body { padding: 14px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
.card-body h3 { font-size: 17px; }
.card-body .desc { color: var(--text-dim); font-size: 13px; flex: 1; }
.card-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.price { font-family: var(--font-display); font-weight: 800; font-size: 18px; }
.price small { color: var(--text-dim); font-weight: 500; font-size: 12px; }
.tag {
  font-size: 11px; padding: 4px 9px; border-radius: 999px;
  border: 1px solid var(--gold); color: var(--gold); letter-spacing: .04em;
}
.tag.green { border-color: var(--green); color: var(--green); }

/* ----------------------- BOTTONI ----------------------- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  border: none; border-radius: 14px;
  padding: 15px 20px; font-size: 16px; font-weight: 600;
  background: var(--surface-2); color: var(--text); border: 1px solid var(--line);
  transition: transform .12s ease, filter .2s ease, background .2s ease;
  width: 100%;
}
.btn:active { transform: scale(.98); }
.btn-primary { background: var(--gold); color: #1a1300; border-color: var(--gold); }
.btn-primary:hover { filter: brightness(1.06); }
.btn-green { background: var(--green); color: #042417; border-color: var(--green); }
.btn-ghost { background: transparent; }
.btn-danger { background: transparent; color: var(--danger); border-color: rgba(229,84,75,.4); }
.btn-sm { padding: 10px 14px; font-size: 14px; width: auto; border-radius: 11px; }
.btn-row { display: flex; gap: 10px; flex-wrap: wrap; }
.btn[disabled] { opacity: .5; pointer-events: none; }

/* ----------------------- DETTAGLIO PRODOTTO ----------------------- */
.detail { display: grid; gap: 22px; }
@media (min-width: 820px) { .detail { grid-template-columns: 1fr 1fr; align-items: start; } }
.detail-media {
  border-radius: var(--radius-l); overflow: hidden; border: 1px solid var(--line);
  background: var(--surface-2); aspect-ratio: 4/3; display: grid; place-items: center;
}
.detail-media img { width: 100%; height: 100%; object-fit: cover; }
.detail h1 { font-size: clamp(26px, 6vw, 38px); margin-bottom: 10px; }
.detail .lead { color: var(--text-dim); }
.detail .big-price { font-family: var(--font-display); font-weight: 800; font-size: 30px; margin: 16px 0; }

/* ----------------------- FORM / CONFIGURATORE ----------------------- */
.panel {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 18px; margin-bottom: 16px;
}
.panel h2 { font-size: 18px; margin-bottom: 14px; }
.field { margin-bottom: 16px; }
.field > label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 7px; font-weight: 500; }
input, select, textarea {
  width: 100%; font-family: inherit; font-size: 15px; color: var(--text);
  background: var(--bg-soft); border: 1px solid var(--line);
  border-radius: 12px; padding: 13px 14px; outline: none;
  transition: border-color .2s ease;
}
input:focus, select:focus, textarea:focus { border-color: var(--gold); }
textarea { min-height: 90px; resize: vertical; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

/* Selettori a chip (tipo adesivo, forma) */
.choice-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.choice {
  position: relative; border: 1px solid var(--line); border-radius: 14px;
  padding: 14px; background: var(--bg-soft); cursor: pointer;
  transition: border-color .2s ease, background .2s ease;
}
.choice .ttl { font-weight: 600; font-size: 14px; }
.choice .sub { font-size: 12px; color: var(--text-dim); margin-top: 3px; }
.choice input { position: absolute; opacity: 0; pointer-events: none; }
.choice.selected { border-color: var(--gold); background: rgba(201,162,39,.08); }
.choice.selected::after {
  content: "✓"; position: absolute; top: 10px; right: 12px; color: var(--gold); font-weight: 700;
}

/* Box prezzo cliente (pulito) */
.price-box {
  display: flex; align-items: center; justify-content: space-between;
  background: linear-gradient(120deg, var(--surface-2), var(--surface));
  border: 1px solid var(--gold); border-radius: var(--radius);
  padding: 18px; margin: 16px 0;
}
.price-box .lab { color: var(--text-dim); font-size: 13px; }
.price-box .val { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--gold-soft); }
.price-error { color: var(--danger); font-size: 14px; margin: 10px 0; }

/* Upload file */
.uploader {
  border: 1.5px dashed var(--line); border-radius: var(--radius);
  padding: 18px; text-align: center; background: var(--bg-soft);
  transition: border-color .2s ease;
}
.uploader:hover { border-color: var(--gold); }
.uploader input { display: none; }
.uploader .hint { color: var(--text-dim); font-size: 13px; margin-top: 6px; }
.uploader .upload-cta { color: var(--gold); font-weight: 600; }
.file-preview { margin-top: 14px; display: flex; align-items: center; gap: 12px; }
.file-preview img { width: 64px; height: 64px; object-fit: cover; border-radius: 10px; border: 1px solid var(--line); }
.file-preview .fp-doc {
  width: 64px; height: 64px; border-radius: 10px; display: grid; place-items: center;
  background: var(--surface-2); border: 1px solid var(--line); color: var(--gold); font-weight: 700; font-size: 12px;
}
.file-preview .fp-name { font-size: 13px; word-break: break-all; }
.note { font-size: 12px; color: var(--text-faint); margin-top: 8px; }

/* Debug admin */
.debug {
  background: #0d0d10; border: 1px dashed var(--line); border-radius: 12px;
  padding: 14px; font-size: 12.5px; color: var(--text-dim); line-height: 1.7;
}
.debug b { color: var(--text); }

/* ----------------------- CARRELLO ----------------------- */
.cart-item {
  display: grid; grid-template-columns: 64px 1fr auto; gap: 14px;
  align-items: center; padding: 14px;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); margin-bottom: 12px;
}
.cart-item .ci-media { width: 64px; height: 64px; border-radius: 12px; overflow: hidden; background: var(--surface-2); display: grid; place-items: center; }
.cart-item .ci-media img { width: 100%; height: 100%; object-fit: cover; }
.cart-item .ci-media .fp-doc { color: var(--gold); font-size: 11px; font-weight: 700; }
.cart-item h3 { font-size: 15px; }
.cart-item .ci-config { font-size: 12.5px; color: var(--text-dim); margin-top: 4px; }
.cart-item .ci-right { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.cart-item .ci-price { font-family: var(--font-display); font-weight: 800; }
.link-remove { background: none; border: none; color: var(--danger); font-size: 13px; padding: 0; }

.summary {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 18px; margin-top: 8px;
}
.summary .row { display: flex; justify-content: space-between; padding: 6px 0; color: var(--text-dim); font-size: 14px; }
.summary .row.total { color: var(--text); font-family: var(--font-display); font-weight: 800; font-size: 22px; border-top: 1px solid var(--line); margin-top: 8px; padding-top: 14px; }

/* ----------------------- STATO VUOTO ----------------------- */
.empty { text-align: center; padding: 50px 20px; color: var(--text-dim); }
.empty .ico { font-size: 42px; margin-bottom: 10px; }
.empty h2 { margin-bottom: 8px; }

/* ----------------------- ADMIN ----------------------- */
.admin-list .admin-row {
  display: grid; grid-template-columns: 48px 1fr auto; gap: 12px; align-items: center;
  padding: 12px; border: 1px solid var(--line); border-radius: 14px;
  background: var(--surface); margin-bottom: 10px;
}
.admin-row .ar-media { width: 48px; height: 48px; border-radius: 10px; overflow: hidden; background: var(--surface-2); display: grid; place-items: center; font-size: 11px; color: var(--text-faint); }
.admin-row .ar-media img { width: 100%; height: 100%; object-fit: cover; }
.admin-row h3 { font-size: 15px; }
.admin-row .ar-meta { font-size: 12px; color: var(--text-dim); }

/* PIN */
.pin-wrap { max-width: 360px; margin: 30px auto; text-align: center; }
.pin-dots { letter-spacing: 8px; font-size: 24px; }

/* ----------------------- BOTTOM NAV (mobile) ----------------------- */
.bottom-nav {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 60;
  height: calc(var(--bottomnav-h) + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  display: flex; background: rgba(12,12,15,.92);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-top: 1px solid var(--line);
}
.bn-item {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  color: var(--text-faint); font-size: 11px;
}
.bn-item svg { width: 22px; height: 22px; }
.bn-item.active { color: var(--gold); }
@media (min-width: 860px) {
  .bottom-nav { display: none; }
  body { padding-bottom: 30px; }
  .top-nav .nav-link:not(.install-link) { display: inline-block; }
}

/* ----------------------- TOAST ----------------------- */
.toast {
  position: fixed; left: 50%; bottom: calc(var(--bottomnav-h) + 18px);
  transform: translateX(-50%) translateY(20px);
  background: var(--surface-2); border: 1px solid var(--line);
  color: var(--text); padding: 13px 18px; border-radius: 14px;
  box-shadow: var(--shadow); z-index: 100; font-size: 14px; max-width: 90vw;
  opacity: 0; transition: opacity .25s ease, transform .25s ease;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.success { border-color: var(--green); }
.toast.error { border-color: var(--danger); }

/* ----------------------- MODALE ----------------------- */
.modal-overlay {
  position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,.6);
  display: grid; place-items: end center; padding: 0;
  animation: fade .2s ease;
}
@media (min-width: 700px) { .modal-overlay { place-items: center; padding: 20px; } }
.modal {
  width: 100%; max-width: 560px; max-height: 92vh; overflow-y: auto;
  background: var(--bg-soft); border: 1px solid var(--line);
  border-radius: var(--radius-l) var(--radius-l) 0 0;
  padding: 22px 18px calc(22px + env(safe-area-inset-bottom));
}
@media (min-width: 700px) { .modal { border-radius: var(--radius-l); } }
.modal h2 { margin-bottom: 16px; }
.modal-close { position: absolute; }

.divider { height: 1px; background: var(--line); margin: 18px 0; border: none; }
.muted { color: var(--text-dim); font-size: 13px; }
.spaced { margin-top: 14px; }
.center { text-align: center; }

<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#0a0a0c" />
  <meta name="description" content="Print Custom Store — prodotti personalizzati: adesivi, biglietti, etichette e packaging su misura." />

  <title>Bunker Sweet</title>

  <!-- Manifest PWA -->
  <link rel="manifest" href="./manifest.json" />

  <!-- Icone (anche per iOS che ignora il manifest per l'icona home) -->
  <link rel="icon" type="image/png" href="./icon-192.png" />
  <link rel="apple-touch-icon" href="./icon-192.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Bunker Sweet" />

  <!-- Font distintivi (online). Offline si usa il fallback di sistema. -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet" />

  <link rel="stylesheet" href="./style.css" />
</head>
<body>
  <!-- ===================== HEADER / NAV ===================== -->
  <header class="app-header">
    <div class="header-inner">
      <a class="brand" href="#/" data-link aria-label="Bunker Sweet — Home">
        <span class="brand-mark"><img src="./logo.png" alt="Bunker Sweet" /></span>
        <span class="brand-text">Bunker <em>Sweet</em></span>
      </a>

      <nav class="top-nav" aria-label="Navigazione principale">
        <a href="#/" data-link class="nav-link">Catalogo</a>
        <button id="install-btn" class="nav-link install-link" hidden>Installa App</button>
        <a href="#/cart" data-link class="cart-btn" aria-label="Apri carrello">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="currentColor" d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6.2 4l.94 2H21a1 1 0 0 1 .96 1.28l-2.2 7.5A2 2 0 0 1 17.84 16H8.53a2 2 0 0 1-1.94-1.5L4.2 3.5A1 1 0 0 0 3.23 3H2a1 1 0 1 1 0-2h1.23a3 3 0 0 1 2.9 2.24L6.2 4Z"/>
          </svg>
          <span class="cart-count" id="cart-count">0</span>
        </a>
      </nav>
    </div>
  </header>

  <!-- ===================== CONTENUTO ===================== -->
  <main id="view" class="view" aria-live="polite"><!-- Le viste vengono iniettate da app.js --></main>

  <!-- ===================== BARRA NAV MOBILE ===================== -->
  <nav class="bottom-nav" aria-label="Navigazione rapida">
    <a href="#/" data-link class="bn-item" data-route="home">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3 2 12h3v8h6v-5h2v5h6v-8h3L12 3Z"/></svg>
      <span>Catalogo</span>
    </a>
    <a href="#/cart" data-link class="bn-item" data-route="cart">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6.2 4l.94 2H21a1 1 0 0 1 .96 1.28l-2.2 7.5A2 2 0 0 1 17.84 16H8.53a2 2 0 0 1-1.94-1.5L4.2 3.5A1 1 0 0 0 3.23 3H2a1 1 0 1 1 0-2h1.23a3 3 0 0 1 2.9 2.24L6.2 4Z"/></svg>
      <span>Carrello</span>
    </a>
    <a href="#/admin" data-link class="bn-item" data-route="admin">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm0 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm0 5c2.2 0 4 1.2 4 2.5V17H8v-1.5C8 14.2 9.8 13 12 13Z"/></svg>
      <span>Admin</span>
    </a>
  </nav>

  <!-- ===================== TOAST / NOTIFICHE ===================== -->
  <div id="toast" class="toast" role="status" aria-live="assertive" hidden></div>

  <script src="./app.js"></script>
</body>
</html>

{
  "name": "Bunker Sweet",
  "short_name": "Bunker Sweet",
  "description": "Bunker Sweet — prodotti personalizzati: adesivi, biglietti, etichette e packaging su misura.",
  "lang": "it",
  "dir": "ltr",
  "start_url": "./index.html",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#0a0a0c",
  "theme_color": "#0a0a0c",
  "categories": ["shopping", "business"],
  "icons": [
    {
      "src": "./icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "./icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "./icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }// netlify/functions/webhook-crypto.js
// -----------------------------------------------------------
// WEBHOOK NOWPayments (IPN): NOWPayments chiama questo endpoint quando
// lo stato di un pagamento cambia. Verifichiamo la firma HMAC-SHA512 e,
// se il pagamento e' completato, segniamo l'ordine come "pagato".
//
// VARIABILI D'AMBIENTE necessarie:
//   NOWPAYMENTS_IPN_SECRET -> "IPN secret key" dal dashboard NOWPayments
//
// URL da configurare nel dashboard NOWPayments (Settings -> IPN/Callbacks):
//   https://IL-TUO-SITO/api/webhook-crypto
// -----------------------------------------------------------

import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

// NOWPayments firma il payload con le chiavi ordinate alfabeticamente
// (in modo ricorsivo) prima di calcolare l'HMAC. Replichiamo lo stesso ordine.
function sortObject(obj) {
  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      const val = obj[key];
      acc[key] = val && typeof val === "object" && !Array.isArray(val) ? sortObject(val) : val;
      return acc;
    }, {});
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!IPN_SECRET) {
    return new Response("Config mancante (NOWPAYMENTS_IPN_SECRET)", { status: 500 });
  }

  const signature = req.headers.get("x-nowpayments-sig");
  const rawBody = await req.text();

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response("Body non valido", { status: 400 });
  }

  // Verifica firma: HMAC-SHA512 del payload con chiavi ordinate.
  const sortedString = JSON.stringify(sortObject(payload));
  const expected = crypto.createHmac("sha512", IPN_SECRET).update(sortedString).digest("hex");
  if (!signature || expected !== signature) {
    return new Response("Firma non valida", { status: 400 });
  }

  // Stati di pagamento completato secondo NOWPayments.
  const status = payload.payment_status;
  const orderId = payload.order_id;
  if (orderId && (status === "finished" || status === "confirmed")) {
    const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });
    const order = await store.get(orderId, { type: "json" });
    if (order) {
      order.paymentStatus = "pagato";
      order.paidAt = new Date().toISOString();
      order.paymentRef = String(payload.payment_id || "");
      await store.setJSON(orderId, order);
    }
  }

  return Response.json({ received: true });
};

// netlify/functions/webhook-card.js
// -----------------------------------------------------------
// WEBHOOK Stripe: Stripe chiama questo endpoint quando un pagamento
// viene completato. Verifichiamo la firma (per sicurezza) e segniamo
// l'ordine come "pagato" nel database (Netlify Blobs).
//
// VARIABILI D'AMBIENTE necessarie:
//   STRIPE_SECRET_KEY     -> chiave segreta Stripe
//   STRIPE_WEBHOOK_SECRET -> "signing secret" del webhook (whsec_...)
//
// URL da configurare nel dashboard Stripe (Developers -> Webhooks):
//   https://IL-TUO-SITO/api/webhook-card
//   Evento da ascoltare: checkout.session.completed
// -----------------------------------------------------------

import Stripe from "stripe";
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  if (!STRIPE_SECRET_KEY || !WEBHOOK_SECRET) {
    return new Response("Config mancante (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET)", { status: 500 });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const signature = req.headers.get("stripe-signature");

  // IMPORTANTE: per verificare la firma serve il corpo GREZZO, non il JSON.
  const rawBody = await req.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    // Firma non valida = richiesta non autentica: rifiutiamo.
    return new Response("Firma non valida: " + err.message, { status: 400 });
  }

  // Ci interessa il completamento del checkout.
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata && session.metadata.orderId;
    if (orderId) {
      const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });
      const order = await store.get(orderId, { type: "json" });
      if (order) {
        order.paymentStatus = "pagato";
        order.paidAt = new Date().toISOString();
        order.paymentRef = session.id;
        await store.setJSON(orderId, order);
      }
    }
  }

  // Rispondiamo 200 per dire a Stripe "ricevuto".
  return Response.json({ received: true });
};

// netlify/functions/pay-crypto.js
// -----------------------------------------------------------
// Pagamento in CRYPTO tramite NOWPayments (pagina di pagamento ospitata).
// Flusso: ricalcolo sicuro del totale -> creo una "invoice" su NOWPayments
// -> restituisco l'URL della pagina dove il cliente paga in crypto.
//
// VARIABILI D'AMBIENTE necessarie (da impostare in Netlify):
//   NOWPAYMENTS_API_KEY -> chiave API del tuo account NOWPayments
//   SITE_URL            -> opzionale, indirizzo del sito
// -----------------------------------------------------------

import { recomputeCartTotal } from "./_pricing.js";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const API_KEY = process.env.NOWPAYMENTS_API_KEY;
  if (!API_KEY) {
    return Response.json({ error: "NOWPAYMENTS_API_KEY non impostata" }, { status: 500 });
  }

  const body = await req.json();
  const cart = body.cart || [];
  const order = body.order || {};

  // Ricalcolo sicuro lato server.
  const { total } = await recomputeCartTotal(cart);
  if (total <= 0) {
    return Response.json({ error: "Carrello vuoto o non valido" }, { status: 400 });
  }

  const origin = process.env.SITE_URL || new URL(req.url).origin;

  try {
    // Crea una invoice: NOWPayments restituisce un invoice_url ospitato.
    const resp = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        price_amount: total,
        price_currency: "eur",
        order_id: order.orderId || "",
        order_description: "Ordine Bunker Sweet",
        ipn_callback_url: origin + "/api/webhook-crypto",
        success_url: origin + "/#/grazie?paid=1&order=" + encodeURIComponent(order.orderId || ""),
        cancel_url: origin + "/#/checkout",
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data.invoice_url) {
      throw new Error(JSON.stringify(data));
    }
    return Response.json({ url: data.invoice_url });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
};

// netlify/functions/pay-card.js
// -----------------------------------------------------------
// Pagamento con CARTA tramite Stripe Checkout.
// Flusso: il frontend invia il carrello + l'ordine -> qui ricalcoliamo
// il totale in modo sicuro, creiamo una sessione di pagamento Stripe e
// restituiamo l'URL della pagina di pagamento ospitata da Stripe.
//
// VARIABILI D'AMBIENTE necessarie (da impostare in Netlify, mai nel codice):
//   STRIPE_SECRET_KEY  -> chiave segreta Stripe (sk_live_... o sk_test_...)
//   SITE_URL           -> opzionale, l'indirizzo del sito (es. https://bunkersweet.netlify.app)
// -----------------------------------------------------------

import Stripe from "stripe";
import { recomputeCartTotal } from "./_pricing.js";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    return Response.json({ error: "STRIPE_SECRET_KEY non impostata" }, { status: 500 });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const body = await req.json();
  const cart = body.cart || [];
  const order = body.order || {};

  // Ricalcolo sicuro lato server (ignora i prezzi inviati dal browser).
  const { total, items } = await recomputeCartTotal(cart);
  if (total <= 0) {
    return Response.json({ error: "Carrello vuoto o non valido" }, { status: 400 });
  }

  // Origine del sito per i link di ritorno.
  const origin = process.env.SITE_URL || new URL(req.url).origin;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Una sola riga col totale dell'ordine (semplice e robusto per ordini su misura).
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: Math.round(total * 100), // Stripe usa i centesimi
            product_data: { name: "Ordine Bunker Sweet (" + items.length + " articoli)" },
          },
        },
      ],
      customer_email: order.customer && order.customer.email,
      // Salviamo il riferimento ordine nei metadati.
      metadata: { orderId: order.orderId || "" },
      success_url: origin + "/#/grazie?paid=1&order=" + encodeURIComponent(order.orderId || ""),
      cancel_url: origin + "/#/checkout",
    });

    return Response.json({ url: session.url });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
};

// netlify/functions/_pricing.js
// -----------------------------------------------------------
// Ricalcolo prezzi LATO SERVER (sicurezza anti-manomissione).
// Il browser potrebbe inviare un prezzo falsato: qui ricalcoliamo
// tutto a partire dal catalogo salvato e dalla configurazione scelta,
// usando ESATTAMENTE la stessa formula del frontend.
// -----------------------------------------------------------

import { getStore } from "@netlify/blobs";

// Stessi parametri del frontend.
const ROLL = { usableRollWidth: 127, gap: 0.4 };
const STICKER_PRICES = { classici: 50, olografici: 60, laminati: 75, rilievo: 85 };

// Calcolo prezzo adesivi (identico a quello dell'app).
function stickerPrice({ width, height, quantity, pricePerMeter }) {
  if (!(width > 0) || !(height > 0) || !(quantity > 0)) return null;
  const stickersPerRow = Math.floor((ROLL.usableRollWidth + ROLL.gap) / (width + ROLL.gap));
  if (stickersPerRow < 1) return null;
  const rows = Math.ceil(quantity / stickersPerRow);
  const usedLengthCm = rows * height + (rows - 1) * ROLL.gap;
  const usedLengthMeters = usedLengthCm / 100;
  return Number((usedLengthMeters * pricePerMeter).toFixed(2));
}

// Ricalcola il totale di un carrello in modo affidabile.
// Ritorna { total, items } con i prezzi verificati dal server.
export async function recomputeCartTotal(cart) {
  const store = getStore({ name: "bunker-sweet", consistency: "strong" });
  const products = (await store.get("products", { type: "json" })) || [];

  let total = 0;
  const items = [];

  for (const line of cart) {
    const product = products.find((p) => p.id === line.productId);
    let price = 0;

    if (product && product.type === "configurator" && line.config) {
      // Adesivi: ricalcolo con la formula ufficiale.
      const pricePerMeter = STICKER_PRICES[line.config.typeId] || 0;
      const computed = stickerPrice({
        width: line.config.width,
        height: line.config.height,
        quantity: line.config.quantity,
        pricePerMeter,
      });
      price = computed || 0;
    } else if (product && product.type === "simple") {
      // Prodotto semplice: prezzo base x quantita'.
      const qty = (line.config && line.config.qty) || line.qty || 1;
      price = Number((product.basePrice * qty).toFixed(2));
    }

    total += price;
    items.push({ name: line.name, price, qty: line.qty, configLabel: line.configLabel });
  }

  return { total: Number(total.toFixed(2)), items };
}

// netlify/functions/orders.js
// -----------------------------------------------------------
// API degli ordini. Ogni ordine viene salvato come blob separato,
// con chiave "order_<timestamp>". L'Admin puo' leggere l'elenco completo.
//   GET  /api/orders  -> restituisce tutti gli ordini (array)
//   POST /api/orders  -> salva un nuovo ordine (body = oggetto ordine)
// -----------------------------------------------------------

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });

  if (req.method === "POST") {
    const order = await req.json();
    // Usiamo l'orderId come chiave: così il webhook di pagamento può
    // ritrovare e aggiornare lo stesso ordine in modo diretto.
    const key = order.orderId || ("order_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7));
    await store.setJSON(key, order);
    return Response.json({ ok: true, key });
  }

  if (req.method === "GET") {
    // Elenca tutte le chiavi e carica ogni ordine.
    const { blobs } = await store.list();
    const orders = [];
    for (const b of blobs) {
      const o = await store.get(b.key, { type: "json" });
      if (o) orders.push(o);
    }
    // Ordina dal piu' recente al piu' vecchio.
    orders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return Response.json(orders);
  }

  return new Response("Method not allowed", { status: 405 });
};

// netlify/functions/products.js
// -----------------------------------------------------------
// API dei prodotti. Salva e legge l'intero catalogo su Netlify Blobs.
//   GET  /api/products  -> restituisce l'array dei prodotti
//   POST /api/products  -> sovrascrive l'array dei prodotti (body = array JSON)
//
// Netlify Blobs e' a configurazione zero: a runtime le credenziali del sito
// vengono iniettate automaticamente, non serve impostare nulla.
// -----------------------------------------------------------

import { getStore } from "@netlify/blobs";

export default async (req) => {
  // "strong" = letture immediate dopo una scrittura (utile per l'Admin).
  const store = getStore({ name: "bunker-sweet", consistency: "strong" });

  if (req.method === "GET") {
    const data = await store.get("products", { type: "json" });
    return Response.json(data ?? []);
  }

  if (req.method === "POST") {
    const products = await req.json();
    await store.setJSON("products", products);
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

// netlify/functions/send-order.js
// -----------------------------------------------------------
// Riceve l'ordine dal frontend (POST /api/send-order) e lo inoltra
// al tuo account tramite la Telegram Bot API.
//
// SICUREZZA: il token del bot e la chat ID NON stanno nel codice,
// ma nelle Variabili d'Ambiente di Netlify (impostate dall'interfaccia).
//   TELEGRAM_TOKEN    -> token del bot (da @BotFather)
//   TELEGRAM_CHAT_ID  -> il tuo ID chat Telegram
// -----------------------------------------------------------

exports.handler = async (event) => {
  // Accetta solo richieste POST.
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const TOKEN = process.env.TELEGRAM_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  // Se mancano le variabili d'ambiente, avvisa (e non blocca l'app).
  if (!TOKEN || !CHAT_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: "Variabili TELEGRAM_TOKEN / TELEGRAM_CHAT_ID non impostate" }) };
  }

  // Legge l'ordine inviato dal frontend.
  let order;
  try {
    order = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "JSON non valido" }) };
  }

  // Costruisce il testo del messaggio Telegram.
  const c = order.customer || {};
  const items = (order.items || [])
    .map((it, i) => {
      const file = it.file ? `  (file: ${it.file.name})` : "";
      return `${i + 1}. ${it.name} — ${it.configLabel || ""} — € ${Number(it.price).toFixed(2)}${file}`;
    })
    .join("\n");

  const text =
`🛒 NUOVO ORDINE — Print Custom Store
Rif: ${order.orderId || "-"}

👤 ${c.name || "-"}
📞 ${c.phone || "-"}
✉️ ${c.email || "-"}
📍 ${c.address || "-"}
📝 ${c.notes || "-"}

Prodotti:
${items || "-"}

💰 TOTALE: € ${Number(order.total || 0).toFixed(2)}`;

  // Invia il messaggio tramite la Telegram Bot API.
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: text }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(JSON.stringify(data));

    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: String(err) }) };
  }
};

  ]
}
