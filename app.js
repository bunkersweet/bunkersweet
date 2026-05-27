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
const ADMIN_PIN = "9988";

// Contatti per il pagamento manuale (Bonifico/Cash/Postepay).
// Modifica questi valori (o lasciali vuoti per nascondere quella riga).
const MANUAL_CONTACTS = {
  telegram: "@bunkersweet",       // es. "@iltuonome"
  signal: "",                      // es. "+39 333 1234567"
  instagram: "@bunkersweet",      // es. "@iltuonome"
  whatsapp: "",                    // es. "+39 333 1234567"
  email: "info@bunkersweet.com",   // es. "info@bunkersweet.com"
  iban: "",                        // es. "IT60 X054 2811 1010 0000 0123 456"
  postepay: "",                    // es. "4023 6009 1234 5678"
};

// Prodotti demo iniziali (caricati al primo avvio se il DB è vuoto).
// I prodotti "tiered" hanno scaglioni di quantità (qty -> price) e
// finiture extra opzionali. Le finiture sono "per pezzo" (costano +X € a pezzo).
// L'admin può modificare tutto questo dall'area Admin senza toccare il codice.
const SEED_PRODUCTS = [
  {
    id: "stickers",
    name: "Adesivi Personalizzati",
    description: "Adesivi su misura con il tuo logo. Scegli materiale, forma e dimensione: il prezzo si calcola automaticamente.",
    image: null,
    type: "configurator",
    configurator: "stickers",
    active: true,
    basePrice: null,
  },
  {
    id: "biglietti-visita",
    name: "Biglietti da Visita",
    description: "Biglietti professionali stampati in alta qualità.",
    image: null,
    type: "tiered",
    leadTime: "3-5 giorni lavorativi",
    tiers: [
      { qty: 48, price: 50 },
      { qty: 96, price: 100 },
      { qty: 200, price: 200 },
    ],
    finishes: [
      { id: "olografico", name: "Effetto olografico", pricePerPiece: 0.30 },
      { id: "lucidato", name: "Plastificazione lucida", pricePerPiece: 0.10 },
      { id: "opaco", name: "Plastificazione opaca", pricePerPiece: 0.10 },
    ],
  },
  {
    id: "volantini-a6",
    name: "Volantini A6",
    description: "Volantini A6 a colori, carta 170g.",
    image: null,
    type: "tiered",
    leadTime: "2-4 giorni lavorativi",
    tiers: [
      { qty: 100, price: 35 },
      { qty: 250, price: 65 },
      { qty: 500, price: 110 },
      { qty: 1000, price: 180 },
    ],
    finishes: [],
  },
  {
    id: "volantini-a5",
    name: "Volantini A5",
    description: "Volantini A5 a colori, carta 170g, fronte/retro.",
    image: null,
    type: "tiered",
    leadTime: "2-4 giorni lavorativi",
    tiers: [
      { qty: 100, price: 50 },
      { qty: 250, price: 95 },
      { qty: 500, price: 160 },
    ],
    finishes: [],
  },
  {
    id: "etichette-prodotto",
    name: "Etichette Prodotto",
    description: "Etichette adesive resistenti per i tuoi prodotti.",
    image: null,
    type: "tiered",
    leadTime: "3-5 giorni lavorativi",
    tiers: [
      { qty: 100, price: 40 },
      { qty: 250, price: 80 },
      { qty: 500, price: 140 },
    ],
    finishes: [
      { id: "lucidato", name: "Laminazione lucida", pricePerPiece: 0.10 },
      { id: "trasparente", name: "Supporto trasparente", pricePerPiece: 0.15 },
    ],
  },
  {
    id: "packaging-scatole",
    name: "Packaging — Scatole",
    description: "Scatole brandizzate per i tuoi prodotti.",
    image: null,
    type: "tiered",
    leadTime: "7-10 giorni lavorativi",
    tiers: [
      { qty: 50, price: 120 },
      { qty: 100, price: 220 },
      { qty: 250, price: 480 },
    ],
    finishes: [
      { id: "oro", name: "Stampa a caldo oro", pricePerPiece: 0.50 },
      { id: "rilievo", name: "Effetto rilievo", pricePerPiece: 0.40 },
    ],
  },
  {
    id: "buste",
    name: "Buste Personalizzate",
    description: "Buste con logo per spedizioni e packaging.",
    image: null,
    type: "tiered",
    leadTime: "5-7 giorni lavorativi",
    tiers: [
      { qty: 100, price: 60 },
      { qty: 250, price: 130 },
      { qty: 500, price: 230 },
    ],
    finishes: [],
  },
  {
    id: "menu",
    name: "Menu / Brochure",
    description: "Menu, listini e brochure su carta premium.",
    image: null,
    type: "tiered",
    leadTime: "4-6 giorni lavorativi",
    tiers: [
      { qty: 25, price: 70 },
      { qty: 50, price: 120 },
      { qty: 100, price: 210 },
    ],
    finishes: [
      { id: "plastificato", name: "Plastificazione resistente", pricePerPiece: 0.30 },
    ],
  },
  {
    id: "poster",
    name: "Poster / Locandine",
    description: "Stampe a colori formato grande.",
    image: null,
    type: "tiered",
    leadTime: "2-4 giorni lavorativi",
    tiers: [
      { qty: 10, price: 40 },
      { qty: 25, price: 85 },
      { qty: 50, price: 150 },
    ],
    finishes: [],
  },
  {
    id: "magliette",
    name: "Magliette Personalizzate",
    description: "T-shirt con stampa del tuo design.",
    image: null,
    type: "tiered",
    leadTime: "7-10 giorni lavorativi",
    tiers: [
      { qty: 10, price: 120 },
      { qty: 25, price: 270 },
      { qty: 50, price: 500 },
    ],
    finishes: [
      { id: "ricamo", name: "Aggiunta ricamo", pricePerPiece: 1.50 },
    ],
  },
  {
    id: "tessere",
    name: "Tessere / Card Plastica",
    description: "Tessere PVC formato carta di credito.",
    image: null,
    type: "tiered",
    leadTime: "5-7 giorni lavorativi",
    tiers: [
      { qty: 50, price: 90 },
      { qty: 100, price: 160 },
      { qty: 250, price: 360 },
    ],
    finishes: [
      { id: "chip", name: "Striscia magnetica", pricePerPiece: 0.40 },
      { id: "lucido", name: "Finitura lucida", pricePerPiece: 0.10 },
    ],
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
      const isTiered = p.type === "tiered";
      // Se il configuratore è disattivato, mostralo come non disponibile.
      const disabled = isConfig && p.active === false;
      // Prezzo "Da X €" per i tiered (primo scaglione).
      const tieredMin = isTiered && Array.isArray(p.tiers) && p.tiers.length
        ? p.tiers[0].price
        : null;
      const priceLabel = isConfig
        ? `<span class="price">Da configurare</span>`
        : isTiered
        ? `<span class="price">Da ${formatEUR(tieredMin || 0)}</span>`
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

  // Prodotti "tiered" con scaglioni di quantità e finiture extra opzionali.
  if (p.type === "tiered") {
    return renderTieredProduct(p);
  }

  // Fallback (vecchi prodotti "simple", per compatibilità).
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
      file: uploadedFile,
    });
    showToast("Aggiunto al carrello ✓", "success");
    location.hash = "#/cart";
  });
}

/* ---------- 7.2.b PRODOTTO TIERED (scaglioni + finiture) ---------- */
async function renderTieredProduct(p) {
  const tiers = Array.isArray(p.tiers) ? p.tiers : [];
  const finishes = Array.isArray(p.finishes) ? p.finishes : [];
  if (tiers.length === 0) {
    app.innerHTML = `<div class="empty"><div class="ico">⚠️</div><h2>Prodotto non configurato</h2><p class="muted">Nessuno scaglione di quantità definito.</p><a class="btn btn-primary spaced" href="#/" data-link>Torna al catalogo</a></div>`;
    return;
  }

  const media = p.image
    ? `<img src="${p.image}" alt="${escapeHtml(p.name)}" />`
    : `<span class="ph">Nessuna immagine</span>`;

  // Chip degli scaglioni quantità.
  const tierChips = tiers
    .map(
      (t, i) => `
    <label class="choice ${i === 0 ? "selected" : ""}" data-tier="${i}">
      <input type="radio" name="tier" value="${i}" ${i === 0 ? "checked" : ""}>
      <div class="ttl">${t.qty} pezzi</div>
      <div class="sub">${formatEUR(t.price)}</div>
    </label>`
    )
    .join("");

  // Casella finiture extra (se previste).
  const finishesHtml = finishes.length
    ? `<div class="panel">
        <h2>Finiture extra (opzionali)</h2>
        ${finishes
          .map(
            (f, i) => `
          <label class="choice" data-finish="${f.id}" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span>
              <input type="checkbox" data-finish-cb="${f.id}" style="margin-right:8px">
              ${escapeHtml(f.name)}
            </span>
            <span class="muted">+ ${formatEUR(f.pricePerPiece)}/pz</span>
          </label>`
          )
          .join("")}
      </div>`
    : "";

  app.innerHTML = `
    <a class="back-link" href="#/" data-link>← Torna al catalogo</a>
    <div class="detail">
      <div class="detail-media">${media}</div>
      <div>
        <span class="kicker">Prodotto</span>
        <h1>${escapeHtml(p.name)}</h1>
        <p class="lead">${escapeHtml(p.description || "")}</p>
        ${p.leadTime ? `<p class="note">⏱ Tempi di preparazione: <b>${escapeHtml(p.leadTime)}</b></p>` : ""}

        <div class="panel">
          <h2>Quantità</h2>
          <div class="choice-grid">${tierChips}</div>
        </div>

        ${finishesHtml}

        <div class="panel">
          <h2>Il tuo file</h2>
          <div class="field">
            <label>Carica il tuo logo / file (PNG, JPG, PDF)</label>
            ${uploaderHtml()}
          </div>
        </div>

        <div class="price-box">
          <div>
            <div class="lab">Prezzo totale</div>
            <div class="val" id="tiered-price">—</div>
          </div>
        </div>

        <button class="btn btn-primary" id="add-tiered">Aggiungi al carrello</button>
      </div>
    </div>
  `;

  // Stato configurazione.
  const state = { tierIndex: 0, finishes: {}, file: null };

  function recompute() {
    const tier = tiers[state.tierIndex];
    let total = tier.price;
    const activeFinishes = [];
    finishes.forEach((f) => {
      if (state.finishes[f.id]) {
        total += f.pricePerPiece * tier.qty;
        activeFinishes.push(f);
      }
    });
    $("#tiered-price").textContent = formatEUR(total);
    return { tier, total: Number(total.toFixed(2)), activeFinishes };
  }

  // Eventi: scaglioni.
  app.querySelectorAll(".choice-grid .choice[data-tier]").forEach((chip) => {
    chip.addEventListener("click", () => {
      app.querySelectorAll(".choice-grid .choice[data-tier]").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      chip.querySelector("input").checked = true;
      state.tierIndex = parseInt(chip.dataset.tier, 10) || 0;
      recompute();
    });
  });

  // Eventi: finiture (checkbox).
  app.querySelectorAll("[data-finish-cb]").forEach((cb) => {
    cb.addEventListener("change", () => {
      state.finishes[cb.dataset.finishCb] = cb.checked;
      recompute();
    });
  });

  // Upload file.
  bindUploader((fileData) => (state.file = fileData));

  // Aggiungi al carrello.
  $("#add-tiered").addEventListener("click", async () => {
    const r = recompute();
    const finishLabel = r.activeFinishes.length
      ? " + " + r.activeFinishes.map((f) => f.name).join(", ")
      : "";
    await addToCart({
      lineId: uid("line"),
      productId: p.id,
      name: p.name,
      qty: r.tier.qty,
      configLabel: `${r.tier.qty} pezzi${finishLabel}`,
      config: {
        tierQty: r.tier.qty,
        tierPrice: r.tier.price,
        finishes: r.activeFinishes.map((f) => ({ id: f.id, name: f.name, pricePerPiece: f.pricePerPiece })),
      },
      price: r.total,
      image: p.image,
      file: state.file,
    });
    showToast("Aggiunto al carrello ✓", "success");
    location.hash = "#/cart";
  });

  recompute();
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
      <button class="btn" id="pay-manual">🏦 Bonifico / Cash / Postepay</button>
    </div>

    <hr class="divider">
    <p class="muted center" style="margin-bottom:10px">Oppure paga in crypto:</p>
    <div class="choice-grid" id="crypto-net-grid">
      <label class="choice" data-net="BTC"><input type="radio" name="cryptonet" value="BTC"><div class="ttl">Bitcoin</div><div class="sub">BTC</div></label>
      <label class="choice" data-net="ETH"><input type="radio" name="cryptonet" value="ETH"><div class="ttl">Ethereum</div><div class="sub">ETH</div></label>
      <label class="choice" data-net="USDT_TRC20"><input type="radio" name="cryptonet" value="USDT_TRC20"><div class="ttl">USDT (TRON)</div><div class="sub">TRC20 · stable</div></label>
      <label class="choice" data-net="SOL"><input type="radio" name="cryptonet" value="SOL"><div class="ttl">Solana</div><div class="sub">SOL</div></label>
    </div>
    <button class="btn btn-green spaced" id="pay-crypto" disabled>🪙 Paga in crypto</button>
    <p class="note center">Verrai indirizzato a una pagina di pagamento sicura. Il tuo ordine viene salvato prima del pagamento.</p>
  `;

  // Selettore rete crypto.
  let selectedNet = null;
  app.querySelectorAll("#crypto-net-grid .choice").forEach((chip) => {
    chip.addEventListener("click", () => {
      app.querySelectorAll("#crypto-net-grid .choice").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      chip.querySelector("input").checked = true;
      selectedNet = chip.dataset.net;
      $("#pay-crypto").disabled = false;
    });
  });

  $("#pay-card").addEventListener("click", () => submitOrder("card"));
  $("#pay-manual").addEventListener("click", () => submitOrder("manual"));
  $("#pay-crypto").addEventListener("click", () => {
    if (!selectedNet) { showToast("Scegli una rete crypto.", "error"); return; }
    submitOrder("crypto", selectedNet);
  });
}

// Raccoglie i dati, salva l'ordine, e avvia il pagamento scelto.
// method: "card" | "crypto"; cryptoNetwork: "BTC" | "ETH" | "USDT_TRC20" | "SOL"
async function submitOrder(method, cryptoNetwork) {
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

  // PAGAMENTO MANUALE (bonifico/cash/postepay): nessuna API di pagamento,
  // mostra una pagina con i contatti e il riepilogo. Invia la notifica al venditore.
  if (method === "manual") {
    orderData.paymentStatus = "in attesa (manuale)";
    await DB.addOrder(orderData); // riaggiorna stato
    await DB.saveCart([]);
    await refreshCartCount();
    // Notifica server (Telegram + email): non blocca se non configurato.
    fetch("/api/notify-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderData),
    }).catch(() => {});
    sessionStorage.setItem("pcs_manual_order", JSON.stringify(orderData));
    location.hash = "#/manuale";
    return;
  }

  // Avvia il pagamento sul server.
  const endpoint = method === "card" ? "/api/pay-card" : "/api/pay-crypto";
  const payload = { cart, order: orderData };
  if (method === "crypto") payload.network = cryptoNetwork;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const data = await res.json();
      // CARTA: data.url -> Stripe Checkout
      if (data.url) {
        await DB.saveCart([]);
        await refreshCartCount();
        window.location.href = data.url;
        return;
      }
      // CRYPTO: data.address + data.amount -> pagina interna "Paga in crypto"
      if (data.address && data.amount) {
        await DB.saveCart([]);
        await refreshCartCount();
        // Salva i dati di pagamento per la pagina e vai.
        sessionStorage.setItem("pcs_crypto_pay", JSON.stringify(data));
        location.hash = "#/crypto-pay?order=" + encodeURIComponent(data.orderId);
        return;
      }
    }
    throw new Error("Pagamento non disponibile");
  } catch (err) {
    console.warn("Pagamento non disponibile, uso il fallback ordine.", err);
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

// Pagina "Pagamento manuale": mostra i contatti per concordare pagamento
// (bonifico/cash/postepay) e un riepilogo dell'ordine già pronto da copiare.
function renderManualPay() {
  let order = null;
  try { order = JSON.parse(sessionStorage.getItem("pcs_manual_order") || "null"); } catch {}
  if (!order) {
    app.innerHTML = `<div class="empty"><div class="ico">⚠️</div><h2>Sessione scaduta</h2><a class="btn btn-primary spaced" href="#/" data-link style="max-width:260px;margin:18px auto 0">Torna al catalogo</a></div>`;
    return;
  }

  // Costruisce un riepilogo testuale dell'ordine, pronto da incollare.
  const lines = order.items.map((i) => `• ${i.name} — ${i.configLabel} — ${formatEUR(i.price)}`).join("\n");
  const recap =
`Ordine: ${order.orderId}
${order.customer.name} — ${order.customer.phone} — ${order.customer.email}

${lines}

TOTALE: ${formatEUR(order.total)}`;

  // Costruisce le righe contatti solo se valorizzate.
  const C = MANUAL_CONTACTS;
  const rows = [
    C.telegram && { label: "Telegram", value: C.telegram, link: "https://t.me/" + C.telegram.replace(/^@/, "") },
    C.signal && { label: "Signal", value: C.signal },
    C.whatsapp && { label: "WhatsApp", value: C.whatsapp, link: "https://wa.me/" + C.whatsapp.replace(/\D/g, "") },
    C.instagram && { label: "Instagram", value: C.instagram, link: "https://instagram.com/" + C.instagram.replace(/^@/, "") },
    C.email && { label: "Email", value: C.email, link: "mailto:" + C.email },
    C.iban && { label: "IBAN (bonifico)", value: C.iban },
    C.postepay && { label: "Postepay", value: C.postepay },
  ].filter(Boolean);

  const contactsHtml = rows
    .map(
      (r) => `
    <div class="cart-item" style="grid-template-columns:1fr auto">
      <div>
        <div class="ar-meta">${escapeHtml(r.label)}</div>
        ${r.link
          ? `<a href="${r.link}" target="_blank" rel="noopener" style="color:var(--gold);font-weight:600;word-break:break-all">${escapeHtml(r.value)}</a>`
          : `<div style="font-weight:600;word-break:break-all">${escapeHtml(r.value)}</div>`}
      </div>
      <button class="btn btn-sm" data-copy="${escapeHtml(r.value)}">Copia</button>
    </div>`
    )
    .join("");

  app.innerHTML = `
    <div class="page-head">
      <span class="kicker">Pagamento manuale</span>
      <h1>Ordine ricevuto ✓</h1>
      <p>Per completare l'ordine contattaci tramite uno dei canali qui sotto. Ti risponderemo per concordare il pagamento (bonifico, contanti o Postepay).</p>
    </div>

    <div class="panel">
      <h2>I nostri contatti</h2>
      ${contactsHtml || `<p class="muted">Nessun contatto configurato.</p>`}
    </div>

    <div class="panel">
      <h2>Riepilogo del tuo ordine</h2>
      <p class="muted">Copia il testo e mandacelo via Telegram / WhatsApp / Email.</p>
      <textarea id="manual-recap" readonly style="min-height:150px;font-family:monospace;font-size:13px">${escapeHtml(recap)}</textarea>
      <div class="btn-row spaced">
        <button class="btn btn-primary btn-sm" id="manual-copy">Copia riepilogo</button>
        <a class="btn btn-sm" href="#/" data-link>Torna al catalogo</a>
      </div>
    </div>

    <p class="muted center">Riferimento ordine: <b>${escapeHtml(order.orderId)}</b></p>
  `;

  // Eventi copia.
  app.querySelectorAll("[data-copy]").forEach((b) => {
    b.addEventListener("click", () => {
      navigator.clipboard?.writeText(b.dataset.copy);
      showToast("Copiato ✓", "success");
    });
  });
  $("#manual-copy").addEventListener("click", () => {
    const ta = $("#manual-recap");
    ta.select();
    navigator.clipboard?.writeText(ta.value);
    showToast("Riepilogo copiato ✓", "success");
  });
}

// Pagina "Paga in crypto": mostra indirizzo, importo, QR code, countdown e
// pulsante "Ho pagato" per verificare il pagamento sulla blockchain.
async function renderCryptoPay() {
  // Recupera i dati del pagamento (salvati in sessionStorage da submitOrder).
  let pay = null;
  try { pay = JSON.parse(sessionStorage.getItem("pcs_crypto_pay") || "null"); } catch {}
  if (!pay || !pay.address || !pay.amount) {
    app.innerHTML = `<div class="empty"><div class="ico">⚠️</div><h2>Sessione di pagamento scaduta</h2><a class="btn btn-primary spaced" href="#/cart" data-link style="max-width:260px;margin:18px auto 0">Torna al carrello</a></div>`;
    return;
  }

  // QR payload: per BTC usiamo lo schema "bitcoin:address?amount=", per gli
  // altri mostriamo l'indirizzo puro (i wallet capiscono in base alla rete).
  let qrPayload = pay.address;
  if (pay.network === "BTC") qrPayload = `bitcoin:${pay.address}?amount=${pay.amount}`;
  if (pay.network === "ETH") qrPayload = `ethereum:${pay.address}?value=${pay.amount}`;

  // QR generato lato client tramite servizio pubblico (immagine PNG).
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=2&data=${encodeURIComponent(qrPayload)}`;

  app.innerHTML = `
    <a class="back-link" href="#/checkout" data-link>← Torna al checkout</a>
    <div class="page-head">
      <span class="kicker">Pagamento crypto</span>
      <h1>Paga in ${escapeHtml(pay.networkName)}</h1>
      <p>Manda <b>esattamente</b> l'importo indicato all'indirizzo qui sotto. Sarà riconosciuto automaticamente.</p>
    </div>

    <div class="panel center">
      <img src="${qrUrl}" alt="QR pagamento" style="width:260px;max-width:100%;border-radius:14px;background:#fff;padding:10px" />
    </div>

    <div class="panel">
      <div class="field">
        <label>Importo da inviare (${escapeHtml(pay.symbol)})</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="cp-amount" type="text" value="${escapeHtml(pay.amount)}" readonly style="font-family:monospace;font-size:18px" />
          <button class="btn btn-sm" id="cp-copy-amount">Copia</button>
        </div>
        <p class="note">Equivalente: € ${Number(pay.eurAmount).toFixed(2)}</p>
      </div>

      <div class="field">
        <label>Indirizzo (rete ${escapeHtml(pay.networkName)})</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="cp-address" type="text" value="${escapeHtml(pay.address)}" readonly style="font-family:monospace;font-size:13px;word-break:break-all" />
          <button class="btn btn-sm" id="cp-copy-addr">Copia</button>
        </div>
      </div>

      <p class="note" style="color:var(--danger)">⚠️ Manda solo ${escapeHtml(pay.symbol)} su rete ${escapeHtml(pay.networkName)}. Reti diverse = fondi persi.</p>
    </div>

    <div class="price-box">
      <div>
        <div class="lab">Tempo residuo</div>
        <div class="val" id="cp-countdown" style="font-family:monospace">--:--</div>
      </div>
      <div class="tag" id="cp-status">In attesa</div>
    </div>

    <button class="btn btn-primary" id="cp-check">Ho pagato, verifica ora</button>
    <p class="note center">La verifica automatica avviene anche ogni minuto. Per BTC e altre reti, le conferme possono richiedere alcuni minuti.</p>
  `;

  // Copia negli appunti.
  $("#cp-copy-amount").addEventListener("click", () => {
    navigator.clipboard?.writeText(pay.amount);
    showToast("Importo copiato", "success");
  });
  $("#cp-copy-addr").addEventListener("click", () => {
    navigator.clipboard?.writeText(pay.address);
    showToast("Indirizzo copiato", "success");
  });

  // Countdown alla scadenza.
  const expiresAt = new Date(pay.expiresAt).getTime();
  function tick() {
    const ms = expiresAt - Date.now();
    if (ms <= 0) {
      $("#cp-countdown").textContent = "Scaduto";
      $("#cp-status").textContent = "Scaduto";
      clearInterval(timerId);
      return;
    }
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    $("#cp-countdown").textContent = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  tick();
  const timerId = setInterval(tick, 1000);

  // Pulsante "Ho pagato": chiama check-crypto per quest'ordine.
  let polling = null;
  async function verifyNow() {
    const btn = $("#cp-check");
    const status = $("#cp-status");
    btn.disabled = true;
    btn.textContent = "Verifica in corso...";
    status.textContent = "Verifica in corso";
    try {
      const res = await fetch("/api/check-crypto?orderId=" + encodeURIComponent(pay.orderId));
      const data = await res.json();
      if (data.paid) {
        clearInterval(timerId);
        if (polling) clearInterval(polling);
        sessionStorage.removeItem("pcs_crypto_pay");
        location.hash = "#/grazie?paid=1&order=" + encodeURIComponent(pay.orderId);
      } else if (data.expired) {
        status.textContent = "Scaduto";
        btn.textContent = "Pagamento scaduto";
      } else {
        status.textContent = "Non ancora visto";
        btn.disabled = false;
        btn.textContent = "Ho pagato, verifica ora";
      }
    } catch (e) {
      status.textContent = "Errore verifica";
      btn.disabled = false;
      btn.textContent = "Riprova";
    }
  }
  $("#cp-check").addEventListener("click", verifyNow);

  // Polling automatico ogni 30 sec finche' restiamo sulla pagina.
  polling = setInterval(() => {
    if (location.hash.startsWith("#/crypto-pay")) verifyNow();
    else clearInterval(polling);
  }, 30000);
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
    case "crypto-pay":
      await renderCryptoPay();
      break;
    case "manuale":
      renderManualPay();
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
