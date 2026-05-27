// netlify/functions/_crypto.js
// -----------------------------------------------------------
// Configurazione condivisa per il pagamento in crypto autonomo.
//
// COSA C'E' QUI DENTRO:
// - CRYPTO_NETWORKS: definizione delle reti supportate (indirizzi, decimali,
//   simbolo, nome, numero di conferme richieste per dire "pagato").
// - getEurPriceOf(symbol): tasso di cambio EUR -> crypto (CoinGecko, gratis).
// - buildUniqueAmount(eurPrice, symbol, salt): crea l'importo crypto con
//   decimali univoci per riconoscere chi ha pagato.
// - normalizeAmount(symbol, n): formatta l'importo coi decimali giusti.
//
// COME CAMBIARE GLI INDIRIZZI IN FUTURO:
// Modifica direttamente la costante CRYPTO_NETWORKS qui sotto (campo
// "address" della rete che vuoi cambiare). E' l'unico punto da toccare.
// -----------------------------------------------------------

// Configurazione reti. Indirizzi PUBBLICI: si possono includere nel codice.
export const CRYPTO_NETWORKS = {
  BTC: {
    name: "Bitcoin",
    symbol: "BTC",
    coingeckoId: "bitcoin",
    address: "bc1qk8wn0ye7fhhmeddtaykzw9x4xdl4gdzcj6p08w",
    decimals: 8,          // BTC ha 8 decimali (satoshi)
    confirmations: 1,     // 1 conferma = ~10 min, sufficiente per importi piccoli/medi
    color: "#f7931a",
  },
  ETH: {
    name: "Ethereum",
    symbol: "ETH",
    coingeckoId: "ethereum",
    address: "0xfA4e825fF556BC3Edc76068E0eeD34a50C9B0778",
    decimals: 6,          // basta meno per importi leggibili
    confirmations: 12,    // ~3 minuti su Ethereum
    color: "#627eea",
  },
  USDT_TRC20: {
    name: "USDT (TRON)",
    symbol: "USDT",
    coingeckoId: "tether", // stabile, ~1 USD
    address: "TFNotixL9pwTJneDyg9371K8ycA43RbG2d",
    decimals: 6,          // USDT TRC20 ha 6 decimali
    confirmations: 19,    // standard TRON per finalita'
    color: "#26a17b",
    isStable: true,       // 1 USDT ~= 1 USD, non serve riprezzare ogni minuto
  },
  SOL: {
    name: "Solana",
    symbol: "SOL",
    coingeckoId: "solana",
    address: "2unWASPEYqmCztgrX3sNZBGjkY5YFKJtjAv4UcU6xaed",
    decimals: 6,
    confirmations: 1,
    color: "#14f195",
  },
};

// Cambio EUR -> crypto via CoinGecko (gratis, no chiave richiesta).
// Esempio: getEurPriceOf("bitcoin") -> quanti euro vale 1 BTC.
export async function getEurPriceOf(coingeckoId) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=eur`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("CoinGecko HTTP " + res.status);
  const data = await res.json();
  const price = data && data[coingeckoId] && data[coingeckoId].eur;
  if (!price || price <= 0) throw new Error("Tasso non disponibile per " + coingeckoId);
  return price;
}

// Formatta un importo coi decimali della rete (senza notazione scientifica).
export function normalizeAmount(networkKey, n) {
  const net = CRYPTO_NETWORKS[networkKey];
  return Number(n).toFixed(net.decimals);
}

// Crea un importo "univoco" aggiungendo piccoli decimali residui.
// In questo modo riconosciamo l'ordine guardando la cifra esatta arrivata.
//
// Idea: parti dall'importo crypto base, poi aggiungi un piccolo "salt" derivato
// dall'orderId (numerico, sotto la soglia "rumore"). Il salt e' piccolissimo
// in valore (frazioni di centesimo) ma rende ogni ordine distinguibile.
//
// Esempio (USDT, 6 decimali): base 12.500000 -> uniqueAmount 12.500137
export function buildUniqueAmount(networkKey, baseCryptoAmount, orderId) {
  const net = CRYPTO_NETWORKS[networkKey];
  // Salt deterministico da orderId: 3-4 cifre residue, ben sotto i decimali della rete.
  let h = 0;
  for (let i = 0; i < orderId.length; i++) {
    h = (h * 31 + orderId.charCodeAt(i)) >>> 0;
  }
  // Salt: 4 cifre (0001..9999) negli ULTIMI decimali della rete.
  const saltDigits = (h % 9999) + 1; // 1..9999, mai 0
  const saltValue = saltDigits / Math.pow(10, net.decimals); // es. 0.000137 per 6 decimali
  const unique = Number(baseCryptoAmount) + saltValue;
  return Number(unique.toFixed(net.decimals));
}

// Tolleranza accettata: se l'importo ricevuto e' >= unique (a meno di un
// piccolo arrotondamento), consideriamo l'ordine pagato. Niente "ha pagato 1 satoshi in meno".
export function amountMatches(networkKey, expected, received) {
  const net = CRYPTO_NETWORKS[networkKey];
  // Tolleranza: 1 unita' minima della rete (1 satoshi, 1 micro-USDT, ecc.)
  const tolerance = 1 / Math.pow(10, net.decimals);
  return received + tolerance >= expected;
}
