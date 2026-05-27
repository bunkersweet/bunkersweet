// netlify/functions/webhook-crypto.js
// -----------------------------------------------------------
// WEBHOOK NOWPayments (IPN): NOWPayments chiama questo endpoint quando
// lo stato di un pagamento cambia. Verifichiamo la firma HMAC-SHA512 e,
// se il pagamento e' completato, segniamo l'ordine come "pagato".
//
// VARIABILI D'AMBIENTE necessarie:
//   NOWPAYMENTS_IPN_SECRET -> "IPN secret key" dal dashboard NOWPayments
//
// URL da configurare nel dashboard NOWPayments (Settings -> IPN/Callbacks):
//   https://IL-TUO-SITO/api/webhook-crypto
// -----------------------------------------------------------

import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

// NOWPayments firma il payload con le chiavi ordinate alfabeticamente
// (in modo ricorsivo) prima di calcolare l'HMAC. Replichiamo lo stesso ordine.
function sortObject(obj) {
  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      const val = obj[key];
      acc[key] = val && typeof val === "object" && !Array.isArray(val) ? sortObject(val) : val;
      return acc;
    }, {});
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!IPN_SECRET) {
    return new Response("Config mancante (NOWPAYMENTS_IPN_SECRET)", { status: 500 });
  }

  const signature = req.headers.get("x-nowpayments-sig");
  const rawBody = await req.text();

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response("Body non valido", { status: 400 });
  }

  // Verifica firma: HMAC-SHA512 del payload con chiavi ordinate.
  const sortedString = JSON.stringify(sortObject(payload));
  const expected = crypto.createHmac("sha512", IPN_SECRET).update(sortedString).digest("hex");
  if (!signature || expected !== signature) {
    return new Response("Firma non valida", { status: 400 });
  }

  // Stati di pagamento completato secondo NOWPayments.
  const status = payload.payment_status;
  const orderId = payload.order_id;
  if (orderId && (status === "finished" || status === "confirmed")) {
    const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });
    const order = await store.get(orderId, { type: "json" });
    if (order) {
      order.paymentStatus = "pagato";
      order.paidAt = new Date().toISOString();
      order.paymentRef = String(payload.payment_id || "");
      await store.setJSON(orderId, order);
    }
  }

  return Response.json({ received: true });
};
