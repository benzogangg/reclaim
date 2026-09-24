#!/usr/bin/env node
// Test harness: node test/run.cjs <wallet> [source-file ...]
// Loads web3 + core.js + the given sources (default: all in sources/), scans the wallet on mainnet,
// simulates every group, builds the transactions and runs assertSafe on each. Nothing is signed or sent.
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
globalThis.window = globalThis;
const load = f => (0, eval)(fs.readFileSync(path.join(root, f), "utf8"));
load("web3.iife.min.js"); globalThis.solanaWeb3 = solanaWeb3;
// Use the project's private RPC (../../.env SB_RPC_URLS) for tests unless RECLAIM_PUBLIC=1: public RPCs rate-limit hard.
if (!process.env.RECLAIM_PUBLIC) {
  try {
    const env = fs.readFileSync(path.join(root, "..", ".env"), "utf8");
    const m = env.match(/^SB_RPC_URLS=(.*)$/m);
    const urls = m && m[1].replace(/^["'\[]+|["'\]]+$/g, "").split(/[,\s"']+/).filter(u => /^https:/.test(u) && !/mainnet-beta/.test(u));
    if (urls && urls.length) globalThis.RECLAIM_RPCS = [urls[0], urls[0]];
  } catch {}
}
console.log("RPC:", globalThis.RECLAIM_RPCS ? "project private RPC" : "public RPCs");
load("core.js");
const wallet = process.argv[2];
let files = process.argv.slice(3);
if (!files.length) files = fs.readdirSync(path.join(root, "sources")).filter(f => f.endsWith(".js")).map(f => "sources/" + f);
for (const f of files) load(f.startsWith("sources/") ? f : "sources/" + path.basename(f));

(async () => {
  const pk = new RC.W.PublicKey(wallet);
  const t0 = Date.now();
  const cats = await RC.scanAll(pk, m => console.log(m));
  let total = 0;
  for (const c of cats) {
    const sum = c.items.reduce((s, i) => s + i.value, 0);
    total += c.optIn ? 0 : sum;
    console.log(`\n[${c.id}] ${c.title}: ${c.items.length} item(s), ${(sum / 1e9).toFixed(6)} SOL${c.optIn ? " (opt-in)" : ""}`);
    if (c.error) console.log("  ERROR:", c.error);
    if (c.note) console.log("  note:", c.note);
    for (const i of c.items.slice(0, 5)) console.log("   -", i.label, (i.value / 1e9).toFixed(6));
  }
  for (const c of cats) { c.selected = true; for (const i of c.items) i.on = true; }
  const dropped = await RC.checkOptIn(pk, cats);            // what the page does when the user picks opt-in items
  if (dropped) console.log("opt-in items that fail simulation:", dropped);
  const { blockhash, lastValidBlockHeight } = await (await RC.rpc()).getLatestBlockhash();
  const txs = RC.buildTxs(pk, cats, blockhash, lastValidBlockHeight);
  const sizes = txs.map(t => t.tx.serializeMessage().length);
  console.log(`\nTOTAL default-on ${(total / 1e9).toFixed(6)} SOL · ${txs.length} tx · max msg ${Math.max(0, ...sizes)} bytes · assertSafe OK · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
