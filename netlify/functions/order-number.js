import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const store = getStore({ name: "bunker-sweet-orders", consistency: "strong" });

  let current = 0;
  try {
    const raw = await store.get("_order_counter", { type: "text" });
    if (raw) current = parseInt(raw, 10) || 0;
  } catch (e) {}

  const next = current + 1;
  await store.set("_order_counter", String(next));

  const orderNumber = "BS-" + String(next).padStart(4, "0");
  return Response.json({ orderNumber, sequence: next });
};
