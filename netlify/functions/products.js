// netlify/functions/products.js
// -----------------------------------------------------------
// API dei prodotti su Netlify Blobs.
//   GET  /api/products  -> array dei prodotti (mai errore 503: in caso di
//                          problema col database risponde lista vuota [])
//   POST /api/products  -> sovrascrive l'array dei prodotti (body = array JSON)
// -----------------------------------------------------------

import { getStore } from "@netlify/blobs";

export default async (req) => {
  // GET: leggi i prodotti. Avvolto in try/catch per non restituire mai 503.
  if (req.method === "GET") {
    try {
      const store = getStore({ name: "bunker-sweet", consistency: "strong" });
      const data = await store.get("products", { type: "json" });
      return Response.json(data ?? []);
    } catch (e) {
      console.error("products GET error:", e);
      return Response.json([]);
    }
  }

  // POST: salva i prodotti.
  if (req.method === "POST") {
    try {
      const products = await req.json();
      const store = getStore({ name: "bunker-sweet", consistency: "strong" });
      await store.setJSON("products", products);
      return Response.json({ ok: true });
    } catch (e) {
      console.error("products POST error:", e);
      return Response.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }

  return new Response("Method not allowed", { status: 405 });
};
