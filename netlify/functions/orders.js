// netlify/functions/orders.js
// -----------------------------------------------------------
// API degli ordini su Netlify Blobs.
//   GET  /api/orders  -> tutti gli ordini (mai 503: in errore risponde [])
//   POST /api/orders  -> salva un nuovo ordine (chiave = orderId)
// -----------------------------------------------------------

import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method === "POST") {
    try {
      const order = await req.json();
      const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });
      const key = order.orderId || ("order_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7));
      await store.setJSON(key, order);
      return Response.json({ ok: true, key });
    } catch (e) {
      console.error("orders POST error:", e);
      return Response.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }

  if (req.method === "GET") {
    try {
      const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });
      const { blobs } = await store.list();
      const orders = [];
      for (const b of blobs) {
        const o = await store.get(b.key, { type: "json" });
        if (o) orders.push(o);
      }
      orders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      return Response.json(orders);
    } catch (e) {
      console.error("orders GET error:", e);
      return Response.json([]);
    }
  }

  return new Response("Method not allowed", { status: 405 });
};
