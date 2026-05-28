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
import { notifyOrder } from "./_notify.js";

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

    // Notifica venditore: ordine creato, in attesa di pagamento carta.
    await notifyOrder({ ...order, total: Number(total.toFixed(2)), paymentMethod: "card", paymentStatus: "in attesa carta" }, "created").catch((e) => console.warn("notify error", e));

    return Response.json({ url: session.url });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
};
