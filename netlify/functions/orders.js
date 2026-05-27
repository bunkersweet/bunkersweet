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
      if (b.key.startsWith("_")) continue;
      const o = await store.get(b.key, { type: "json" });
      if (o) orders.push(o);
    }
    // Ordina dal piu' recente al piu' vecchio.
    orders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return Response.json(orders);
  }

  return new Response("Method not allowed", { status: 405 });
};
