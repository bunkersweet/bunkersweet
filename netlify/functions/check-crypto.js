// netlify/functions/check-crypto.js
// -----------------------------------------------------------
// Verifica i pagamenti crypto in attesa.
//
// Usata in due modi:
//   1) Manualmente: il cliente preme "Ho pagato, verifica" sul sito.
//      Si chiama con ?orderId=order_xxx -> verifica solo quell'ordine.
//   2) Automaticamente: un cron esterno (cron-job.org) chiama ogni minuto
//      l'endpoint senza parametri -> verifica tutti gli ordini "in attesa".
//
// Se trova un pagamento corrispondente sulla blockchain, segna l'ordine
// come "pagato" (esattamente come fa il webhook di Stripe).
// -----------------------------------------------------------

import { getStore } from "@netlify/blobs";
import { checkBlockchain } from "./_watchers.js";
import { notifyOrder } from "./_notify.js";

// Quanti minuti dopo expiresAt smettiamo di controllare un ordine.
const STALE_AFTER_MIN = 60;

async function verifyOrder(store, order) {
  // Saltiamo se non è un ordine crypto in attesa.
  if (!order || order.paymentMethod !== "crypto" || order.paymentStatus === "pagato") {
    return { orderId: order && order.orderId, skipped: true };
  }
  const c = order.crypto;
  if (!c || !c.address || !c.amount || !c.network) {
    return { orderId: order.orderId, skipped: true, reason: "Dati crypto mancanti" };
  }

  // Scaduto da troppo tempo: lo marchiamo come "scaduto" e basta.
  const expiresMs = new Date(c.expiresAt).getTime();
  if (Date.now() > expiresMs + STALE_AFTER_MIN * 60 * 1000) {
    order.paymentStatus = "scaduto";
    await store.setJSON(order.orderId, order);
    return { orderId: order.orderId, expired: true };
  }

  // Interroga la blockchain.
  const result = await checkBlockchain(c.network, c.address, c.amount, c.createdAt || order.createdAt);
  if (result.found) {
    order.paymentStatus = "pagato";
    order.paidAt = new Date().toISOString();
    order.paymentRef = result.txid;
    order.crypto.confirmations = result.confirmations;
    await store.setJSON(order.orderId, order);
    // Notifica venditore + cliente.
    await notifyOrder(order, "paid").catch((e) => console.warn("notify error", e));
    return { orderId: order.orderId, paid: true, txid: result.txid };
  }

  return { orderId: order.orderId, paid: false, error: result.error || null };
}

export default async (req) => {
  const url = new URL(req.url);
  const singleOrderId = url.searchParams.get("orderId");
  const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });

  // Modalita' 1: verifica un singolo ordine (chiamata dal pulsante "Ho pagato").
  if (singleOrderId) {
    const order = await store.get(singleOrderId, { type: "json" });
    if (!order) return Response.json({ error: "Ordine non trovato" }, { status: 404 });
    const r = await verifyOrder(store, order);
    return Response.json(r);
  }

  // Modalita' 2: verifica tutti gli ordini crypto in attesa (cron-job).
  const { blobs } = await store.list();
  const results = [];
  for (const b of blobs) {
    const o = await store.get(b.key, { type: "json" });
    if (!o) continue;
    if (o.paymentMethod !== "crypto" || o.paymentStatus !== "in attesa") continue;
    const r = await verifyOrder(store, o);
    results.push(r);
  }
  return Response.json({ checked: results.length, results });
};
