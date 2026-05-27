// netlify/functions/pay-crypto.js
// -----------------------------------------------------------
// Pagamento in CRYPTO tramite NOWPayments (pagina di pagamento ospitata).
// Flusso: ricalcolo sicuro del totale -> creo una "invoice" su NOWPayments
// -> restituisco l'URL della pagina dove il cliente paga in crypto.
//
// VARIABILI D'AMBIENTE necessarie (da impostare in Netlify):
//   NOWPAYMENTS_API_KEY -> chiave API del tuo account NOWPayments
//   SITE_URL            -> opzionale, indirizzo del sito
// -----------------------------------------------------------

import { recomputeCartTotal } from "./_pricing.js";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const API_KEY = process.env.NOWPAYMENTS_API_KEY;
  if (!API_KEY) {
    return Response.json({ error: "NOWPAYMENTS_API_KEY non impostata" }, { status: 500 });
  }

  const body = await req.json();
  const cart = body.cart || [];
  const order = body.order || {};

  // Ricalcolo sicuro lato server.
  const { total } = await recomputeCartTotal(cart);
  if (total <= 0) {
    return Response.json({ error: "Carrello vuoto o non valido" }, { status: 400 });
  }

  const origin = process.env.SITE_URL || new URL(req.url).origin;

  try {
    // Crea una invoice: NOWPayments restituisce un invoice_url ospitato.
    const resp = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        price_amount: total,
        price_currency: "eur",
        order_id: order.orderId || "",
        order_description: "Ordine Bunker Sweet",
        ipn_callback_url: origin + "/api/webhook-crypto",
        success_url: origin + "/#/grazie?paid=1&order=" + encodeURIComponent(order.orderId || ""),
        cancel_url: origin + "/#/checkout",
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data.invoice_url) {
      throw new Error(JSON.stringify(data));
    }
    return Response.json({ url: data.invoice_url });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
};
