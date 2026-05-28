// netlify/functions/_notify.js
// -----------------------------------------------------------
// Invia notifiche di ordine al venditore (te) e al cliente.
//
// Due canali, entrambi opzionali e indipendenti:
//   - TELEGRAM: messaggio al tuo chat_id tramite bot.
//     Variabili: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
//   - EMAIL: email a te + email al cliente, tramite Resend.
//     Variabili: RESEND_API_KEY, NOTIFY_EMAIL_FROM, NOTIFY_EMAIL_TO
//
// Se una variabile manca, quel canale viene saltato (l'altro funziona lo stesso).
// La funzione e' "fire and forget": se fallisce non blocca l'ordine.
// -----------------------------------------------------------

// Costruisce il testo del riepilogo ordine (semplice, leggibile su qualsiasi canale).
function buildSummary(order) {
  const c = order.customer || {};
  const items = (order.items || [])
    .map((it, i) => {
      const file = it.file ? ` (file: ${it.file.name})` : "";
      return `${i + 1}. ${it.name} — ${it.configLabel || ""} — € ${Number(it.price).toFixed(2)}${file}`;
    })
    .join("\n");

  const extra = [
    c.instagram ? `IG: ${c.instagram}` : "",
    c.telegram ? `Telegram: ${c.telegram}` : "",
    c.signal ? `Signal: ${c.signal}` : "",
  ].filter(Boolean).join(" · ");

  const method = order.paymentMethod === "card" ? "Carta"
    : order.paymentMethod === "crypto" ? `Crypto (${order.crypto?.symbol || "?"})`
    : order.paymentMethod === "manual" ? "Manuale (bonifico/cash/postepay)"
    : order.paymentMethod || "—";
  const status = order.paymentStatus || "—";

  return `🛒 NUOVO ORDINE — Bunker Sweet
Rif: ${order.orderId || "-"}
Stato: ${status}
Metodo: ${method}

👤 ${c.name || "-"}
📞 ${c.phone || "-"}
✉️ ${c.email || "-"}
📍 ${c.address || "-"}
${extra ? "🔗 " + extra : ""}
${c.notes ? "📝 " + c.notes : ""}

Prodotti:
${items || "-"}

💰 TOTALE: € ${Number(order.total || 0).toFixed(2)}`;
}

// Invio Telegram (al venditore).
async function sendTelegram(text) {
  const TOKEN = process.env.TELEGRAM_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!TOKEN || !CHAT_ID) return { sent: false, reason: "Telegram non configurato" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });
    const data = await res.json();
    return { sent: !!data.ok, error: data.ok ? null : JSON.stringify(data) };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

// Invio email tramite Resend (servizio gratuito, https://resend.com).
async function sendEmail(to, subject, text) {
  const KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.NOTIFY_EMAIL_FROM || "Bunker Sweet <onboarding@resend.dev>";
  if (!KEY || !to) return { sent: false, reason: "Email non configurata o destinatario mancante" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject,
        // Versione testuale + HTML semplice (le email viaggiano meglio così).
        text,
        html: `<pre style="font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}</pre>`,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { sent: res.ok, error: res.ok ? null : JSON.stringify(data) };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

// Punto unico chiamato dalle altre funzioni quando un ordine cambia stato.
// "moment" puo' essere: "created" (appena creato) | "paid" (confermato pagato)
export async function notifyOrder(order, moment = "created") {
  const text = buildSummary(order);
  const tagged = (moment === "paid" ? "✅ PAGAMENTO CONFERMATO\n" : "") + text;

  const out = { telegram: null, emailMerchant: null, emailCustomer: null };

  // Telegram al venditore (sempre, se configurato).
  out.telegram = await sendTelegram(tagged);

  // Email al venditore.
  const MERCHANT = process.env.NOTIFY_EMAIL_TO;
  if (MERCHANT) {
    out.emailMerchant = await sendEmail(
      MERCHANT,
      (moment === "paid" ? "[PAGATO] " : "") + "Nuovo ordine Bunker Sweet — " + (order.orderId || ""),
      tagged
    );
  }

  // Email al cliente: conferma con riepilogo (versione cortese).
  if (order.customer && order.customer.email) {
    const friendly =
`Ciao ${order.customer.name || ""},

grazie per il tuo ordine su Bunker Sweet!
${moment === "paid" ? "Il tuo pagamento è stato confermato." : "Abbiamo ricevuto la tua richiesta e ti ricontatteremo a breve."}

${text}

A presto,
Bunker Sweet`;
    out.emailCustomer = await sendEmail(
      order.customer.email,
      (moment === "paid" ? "Pagamento confermato — " : "Ordine ricevuto — ") + (order.orderId || ""),
      friendly
    );
  }

  return out;
}
