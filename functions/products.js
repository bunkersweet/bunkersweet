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
