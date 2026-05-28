// netlify/functions/pay-crypto.js
// -----------------------------------------------------------
// Inizia un pagamento crypto autonomo (senza NOWPayments).
//
// Riceve dal frontend: il carrello, l'ordine, la rete scelta (BTC/ETH/USDT_TRC20/SOL).
// Ricalcola il prezzo lato server (anti-manomissione), converte in crypto via
// CoinGecko, aggiunge i decimali univoci e salva l'ordine nello store
// "bunker-sweet-orders" con stato "in attesa". Restituisce al frontend:
//   { address, amount, symbol, network, expiresAt, orderId }
//
// La verifica del pagamento avviene poi su /api/check-crypto.
// -----------------------------------------------------------

import { getStore } from "@netlify/blobs";
import { recomputeCartTotal } from "./_pricing.js";
import { CRYPTO_NETWORKS, getEurPriceOf, normalizeAmount, buildUniqueAmount } from "./_crypto.js";
import { notifyOrder } from "./_notify.js";

// Durata della "finestra di pagamento": il cliente ha 30 minuti per pagare
// prima che l'ordine venga marcato come scaduto.
const PAYMENT_WINDOW_MINUTES = 30;

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "JSON non valido" }, { status: 400 }); }

  const cart = body.cart || [];
  const order = body.order || {};
  const networkKey = body.network; // "BTC" | "ETH" | "USDT_TRC20" | "SOL"

  // Validazioni di base.
  const net = CRYPTO_NETWORKS[networkKey];
  if (!net) return Response.json({ error: "Rete non supportata" }, { status: 400 });
  if (!order.orderId) return Response.json({ error: "orderId mancante" }, { status: 400 });

  // Ricalcolo prezzo SICURO (ignora i prezzi inviati dal browser).
  const { total: totalEur } = await recomputeCartTotal(cart);
  if (totalEur <= 0) return Response.json({ error: "Carrello vuoto o non valido" }, { status: 400 });

  // Tasso EUR -> crypto.
  let cryptoBase;
  try {
    const pricePerUnitEur = await getEurPriceOf(net.coingeckoId);
    cryptoBase = totalEur / pricePerUnitEur;
  } catch (e) {
    return Response.json({ error: "Tasso di cambio non disponibile: " + e.message }, { status: 502 });
  }

  // Importo univoco con decimali residui per riconoscere l'ordine.
  const uniqueAmount = buildUniqueAmount(networkKey, cryptoBase, order.orderId);
  const amountStr = normalizeAmount(networkKey, uniqueAmount);

  // Salva l'ordine nello store con i dati del pagamento crypto.
  const expiresAt = new Date(Date.now() + PAYMENT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const orderToSave = {
    ...order,
    paymentMethod: "crypto",
    paymentStatus: "in attesa",
    total: Number(totalEur.toFixed(2)),
    crypto: {
      network: networkKey,
      symbol: net.symbol,
      networkName: net.name,
      address: net.address,
      amount: amountStr,        // stringa con decimali esatti
      eurAmount: Number(totalEur.toFixed(2)),
      rate: cryptoBase > 0 ? Number((totalEur / cryptoBase).toFixed(2)) : null, // EUR per 1 unita'
      decimals: net.decimals,
      confirmationsRequired: net.confirmations,
      expiresAt,
      createdAt: new Date().toISOString(),
    },
  };

  const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });
  await store.setJSON(order.orderId, orderToSave);

  // Notifica venditore: ordine creato, in attesa di pagamento crypto.
  await notifyOrder(orderToSave, "created").catch((e) => console.warn("notify error", e));

  return Response.json({
    orderId: order.orderId,
    network: networkKey,
    symbol: net.symbol,
    networkName: net.name,
    address: net.address,
    amount: amountStr,
    eurAmount: Number(totalEur.toFixed(2)),
    expiresAt,
  });
};
