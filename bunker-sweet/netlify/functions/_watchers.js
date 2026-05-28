// netlify/functions/_watchers.js
// -----------------------------------------------------------
// Watcher delle 4 blockchain. Ogni funzione qui dentro riceve:
//   - address: l'indirizzo del nostro wallet
//   - amountStr: l'importo univoco atteso (stringa con decimali esatti)
//   - sinceISO: timestamp ISO dell'ordine, per ignorare transazioni vecchie
// e ritorna:
//   - { found: true, txid, confirmations } se trova un pagamento corrispondente
//   - { found: false } altrimenti
//
// API usate (tutte gratuite, senza chiave richiesta):
//   - Bitcoin:  Mempool.space
//   - Ethereum: Etherscan (richiede chiave gratuita: ETHERSCAN_API_KEY)
//   - TRON:     TronGrid
//   - Solana:   RPC pubblico solana.com
// -----------------------------------------------------------

import { amountMatches, CRYPTO_NETWORKS } from "./_crypto.js";

// ========== BITCOIN (Mempool.space) ==========
async function checkBitcoin(address, amountStr, sinceISO) {
  const sinceMs = new Date(sinceISO).getTime();
  const url = `https://mempool.space/api/address/${address}/txs`;
  const res = await fetch(url);
  if (!res.ok) return { found: false, error: "mempool HTTP " + res.status };
  const txs = await res.json(); // array di transazioni recenti

  for (const tx of txs) {
    // Salta transazioni piu' vecchie dell'ordine
    if (tx.status && tx.status.block_time && tx.status.block_time * 1000 < sinceMs - 60000) continue;

    // Somma degli output che vanno al nostro indirizzo (in satoshi).
    let receivedSat = 0;
    for (const vout of tx.vout || []) {
      if (vout.scriptpubkey_address === address) receivedSat += Number(vout.value || 0);
    }
    const receivedBtc = receivedSat / 1e8;

    if (amountMatches("BTC", Number(amountStr), receivedBtc)) {
      const confirmations = tx.status && tx.status.confirmed ? (tx.status.block_height ? 1 : 0) : 0;
      return { found: true, txid: tx.txid, confirmations };
    }
  }
  return { found: false };
}

// ========== ETHEREUM (Etherscan) ==========
async function checkEthereum(address, amountStr, sinceISO) {
  const KEY = process.env.ETHERSCAN_API_KEY || "";
  const sinceMs = new Date(sinceISO).getTime();
  // Lista transazioni in entrata "normali" (ETH nativo).
  const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=20&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) return { found: false, error: "etherscan HTTP " + res.status };
  const data = await res.json();
  const txs = Array.isArray(data.result) ? data.result : [];

  for (const tx of txs) {
    if (tx.to && tx.to.toLowerCase() !== address.toLowerCase()) continue;
    const txTimeMs = Number(tx.timeStamp) * 1000;
    if (txTimeMs < sinceMs - 60000) continue;

    const receivedEth = Number(tx.value) / 1e18;
    if (amountMatches("ETH", Number(amountStr), receivedEth)) {
      return { found: true, txid: tx.hash, confirmations: Number(tx.confirmations || 0) };
    }
  }
  return { found: false };
}

// ========== TRON / USDT-TRC20 (TronGrid) ==========
async function checkTronUSDT(address, amountStr, sinceISO) {
  const sinceMs = new Date(sinceISO).getTime();
  // Contratto USDT su TRON: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
  const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?only_confirmed=false&limit=30&contract_address=${USDT_CONTRACT}&only_to=true&min_timestamp=${Math.max(0, sinceMs - 60000)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return { found: false, error: "trongrid HTTP " + res.status };
  const data = await res.json();
  const txs = Array.isArray(data.data) ? data.data : [];

  for (const tx of txs) {
    if (!tx.to || tx.to !== address) continue;
    // value e' in unita' minime (6 decimali). Converti in USDT.
    const receivedUsdt = Number(tx.value) / 1e6;
    if (amountMatches("USDT_TRC20", Number(amountStr), receivedUsdt)) {
      return { found: true, txid: tx.transaction_id, confirmations: 19 };
    }
  }
  return { found: false };
}

// ========== SOLANA (RPC pubblico) ==========
async function checkSolana(address, amountStr, sinceISO) {
  const sinceMs = new Date(sinceISO).getTime();
  const RPC = "https://api.mainnet-beta.solana.com";

  // 1) Lista delle ultime firme per l'indirizzo.
  const sigRes = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "getSignaturesForAddress",
      params: [address, { limit: 20 }],
    }),
  });
  if (!sigRes.ok) return { found: false, error: "solana RPC HTTP " + sigRes.status };
  const sigData = await sigRes.json();
  const sigs = (sigData.result || []).filter((s) => !s.err);

  // 2) Per ogni transazione recente, vediamo se all'indirizzo arrivano lamports
  //    pari all'importo atteso (1 SOL = 1e9 lamports).
  for (const s of sigs) {
    const txTimeMs = (s.blockTime || 0) * 1000;
    if (txTimeMs && txTimeMs < sinceMs - 60000) continue;

    const txRes = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getTransaction",
        params: [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
      }),
    });
    if (!txRes.ok) continue;
    const txData = await txRes.json();
    const tx = txData.result;
    if (!tx || !tx.meta) continue;

    // Calcola variazione lamports per il nostro indirizzo confrontando preBalances/postBalances.
    const keys = (tx.transaction.message.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
    const idx = keys.indexOf(address);
    if (idx < 0) continue;
    const pre = Number(tx.meta.preBalances[idx] || 0);
    const post = Number(tx.meta.postBalances[idx] || 0);
    const deltaLamports = post - pre;
    if (deltaLamports <= 0) continue;

    const receivedSol = deltaLamports / 1e9;
    if (amountMatches("SOL", Number(amountStr), receivedSol)) {
      return { found: true, txid: s.signature, confirmations: 1 };
    }
  }
  return { found: false };
}

// Dispatcher: dato il networkKey, chiama il watcher giusto.
export async function checkBlockchain(networkKey, address, amountStr, sinceISO) {
  try {
    switch (networkKey) {
      case "BTC":         return await checkBitcoin(address, amountStr, sinceISO);
      case "ETH":         return await checkEthereum(address, amountStr, sinceISO);
      case "USDT_TRC20":  return await checkTronUSDT(address, amountStr, sinceISO);
      case "SOL":         return await checkSolana(address, amountStr, sinceISO);
      default:            return { found: false, error: "Rete non supportata" };
    }
  } catch (e) {
    return { found: false, error: String(e) };
  }
}
