// netlify/functions/notify-order.js
// -----------------------------------------------------------
// Endpoint chiamato dal frontend per notificare un ordine appena creato
// (usato dal flusso "Bonifico / Cash / Postepay" che non passa dalle
// funzioni di pagamento).
//
// Salva anche l'ordine nello store, così l'admin lo vede.
// -----------------------------------------------------------

import { getStore } from "@netlify/blobs";
import { notifyOrder } from "./_notify.js";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let order;
  try { order = await req.json(); } catch { return Response.json({ error: "JSON non valido" }, { status: 400 }); }
  if (!order.orderId) return Response.json({ error: "orderId mancante" }, { status: 400 });

  // Salva l'ordine nel database.
  const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });
  await store.setJSON(order.orderId, order);

  // Invia le notifiche.
  const result = await notifyOrder(order, "created").catch((e) => ({ error: String(e) }));

  return Response.json({ ok: true, notify: result });
};
