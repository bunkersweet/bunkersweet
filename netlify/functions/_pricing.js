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
