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
