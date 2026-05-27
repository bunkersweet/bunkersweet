import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const { orderId } = await req.json();
  if (!orderId) return Response.json({ sent: false, reason: "orderId mancante" }, { status: 400 });

  const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });
  const order = await store.get(orderId, { type: "json" });
  if (!order) return Response.json({ sent: false, reason: "ordine non trovato" }, { status: 404 });

  const email = order.customer && order.customer.email;
  if (!email) return Response.json({ sent: false, reason: "email non fornita" });

  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  const FROM_EMAIL = process.env.FROM_EMAIL || "ordini@bunkersweet.com";

  if (!SENDGRID_KEY) {
    console.log("SENDGRID_API_KEY non impostata — email non inviata per ordine:", orderId);
    return Response.json({ sent: false, reason: "servizio email non configurato" });
  }

  const itemsHtml = (order.items || []).map((it, i) =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${i + 1}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${it.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${it.configLabel || "-"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">&euro; ${Number(it.price).toFixed(2)}</td>
    </tr>`
  ).join("");

  const c = order.customer || {};
  const html = `
    <div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;color:#333;">
      <div style="background:#0a0a0c;padding:30px;text-align:center;border-radius:12px 12px 0 0;">
        <h1 style="color:#c9a227;margin:0;font-size:24px;">Grazie per il tuo ordine!</h1>
        <p style="color:#a6a6ad;margin:8px 0 0;">Bunker Sweet</p>
      </div>
      <div style="padding:24px;background:#fff;border:1px solid #eee;">
        <p style="font-size:16px;margin:0 0 16px;">Ciao <b>${c.name || "cliente"}</b>,</p>
        <p>Ecco il riepilogo del tuo ordine:</p>
        <div style="background:#f8f8f8;padding:12px 16px;border-radius:8px;margin:16px 0;">
          <p style="margin:0;font-size:14px;color:#666;">Numero ordine</p>
          <p style="margin:4px 0 0;font-size:20px;font-weight:bold;color:#0a0a0c;">${order.orderId}</p>
        </div>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <thead>
            <tr style="background:#f4f4f2;">
              <th style="padding:8px 12px;text-align:left;">#</th>
              <th style="padding:8px 12px;text-align:left;">Prodotto</th>
              <th style="padding:8px 12px;text-align:left;">Configurazione</th>
              <th style="padding:8px 12px;text-align:right;">Prezzo</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="text-align:right;padding:12px;background:#f8f8f8;border-radius:8px;margin-top:8px;">
          <span style="font-size:18px;font-weight:bold;">Totale: &euro; ${Number(order.total).toFixed(2)}</span>
        </div>
        ${c.address ? `<p style="margin:16px 0 4px;color:#666;font-size:13px;">Indirizzo:</p><p style="margin:0;">${c.address}</p>` : ""}
        ${c.phone ? `<p style="margin:8px 0 0;color:#666;font-size:13px;">Telefono: ${c.phone}</p>` : ""}
        ${c.notes ? `<p style="margin:12px 0 0;color:#666;font-size:13px;">Note: ${c.notes}</p>` : ""}
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
        <p style="color:#999;font-size:12px;text-align:center;">Stato pagamento: ${order.paymentStatus || "in attesa"} &middot; Metodo: ${order.paymentMethod === "card" ? "Carta" : order.paymentMethod === "crypto" ? "Crypto" : order.paymentMethod || "-"}</p>
      </div>
      <div style="background:#0a0a0c;padding:16px;text-align:center;border-radius:0 0 12px 12px;">
        <p style="color:#a6a6ad;font-size:12px;margin:0;">Bunker Sweet &mdash; Prodotti personalizzati</p>
      </div>
    </div>`;

  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + SENDGRID_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: FROM_EMAIL, name: "Bunker Sweet" },
        subject: `Conferma ordine ${order.orderId} - Bunker Sweet`,
        content: [{ type: "text/html", value: html }],
      }),
    });

    if (resp.status >= 200 && resp.status < 300) {
      return Response.json({ sent: true });
    }
    const errBody = await resp.text();
    console.error("SendGrid error:", resp.status, errBody);
    return Response.json({ sent: false, reason: "errore invio email" });
  } catch (err) {
    console.error("Email send error:", err);
    return Response.json({ sent: false, reason: String(err) });
  }
};
