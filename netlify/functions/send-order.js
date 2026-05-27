// netlify/functions/send-order.js
// -----------------------------------------------------------
// Riceve l'ordine dal frontend (POST /api/send-order) e lo inoltra
// al tuo account tramite la Telegram Bot API.
//
// SICUREZZA: il token del bot e la chat ID NON stanno nel codice,
// ma nelle Variabili d'Ambiente di Netlify (impostate dall'interfaccia).
//   TELEGRAM_TOKEN    -> token del bot (da @BotFather)
//   TELEGRAM_CHAT_ID  -> il tuo ID chat Telegram
// -----------------------------------------------------------

exports.handler = async (event) => {
  // Accetta solo richieste POST.
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const TOKEN = process.env.TELEGRAM_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  // Se mancano le variabili d'ambiente, avvisa (e non blocca l'app).
  if (!TOKEN || !CHAT_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: "Variabili TELEGRAM_TOKEN / TELEGRAM_CHAT_ID non impostate" }) };
  }

  // Legge l'ordine inviato dal frontend.
  let order;
  try {
    order = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "JSON non valido" }) };
  }

  // Costruisce il testo del messaggio Telegram.
  const c = order.customer || {};
  const items = (order.items || [])
    .map((it, i) => {
      const file = it.file ? `  (file: ${it.file.name})` : "";
      return `${i + 1}. ${it.name} — ${it.configLabel || ""} — € ${Number(it.price).toFixed(2)}${file}`;
    })
    .join("\n");

  const text =
`🛒 NUOVO ORDINE — Print Custom Store
Rif: ${order.orderId || "-"}

👤 ${c.name || "-"}
📞 ${c.phone || "-"}
✉️ ${c.email || "-"}
📍 ${c.address || "-"}
📝 ${c.notes || "-"}

Prodotti:
${items || "-"}

💰 TOTALE: € ${Number(order.total || 0).toFixed(2)}`;

  // Invia il messaggio tramite la Telegram Bot API.
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: text }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(JSON.stringify(data));

    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: String(err) }) };
  }
};
