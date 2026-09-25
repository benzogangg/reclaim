#!/usr/bin/env node
// Economic audit: node test/audit.cjs <wallet> [<wallet> …]
// Scans each wallet with every source, selects everything (opt-in too), builds the real transactions and
// simulates each one with before/after snapshots of every writable account. Flags:
//   OTHER_SOL      lamports landing in someone else's plain wallet (system-owned, no data)
//   OTHER_TOKENS   tokens landing in a token account owned by someone else's wallet (on-curve owner)
//   SPENT_TOKENS   the wallet's own token balance going down outside the burn categories
//   WALLET_LOSS    the wallet (plus accounts it controls) ending poorer than the network fee
//   SIM_FAIL       a transaction that no longer simulates
// Nothing is signed or sent.
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
globalThis.window = globalThis;
const load = f => (0, eval)(fs.readFileSync(path.join(root, f), "utf8"));
load("web3.iife.min.js"); globalThis.solanaWeb3 = solanaWeb3;
if (!process.env.RECLAIM_PUBLIC) {
  try {
    const env = fs.readFileSync(path.join(root, "..", ".env"), "utf8");
    const m = env.match(/^SB_RPC_URLS=(.*)$/m);
    const urls = m && m[1].replace(/^["'\[]+|["'\]]+$/g, "").split(/[,\s"']+/).filter(u => /^https:/.test(u) && !/mainnet-beta/.test(u));
    if (urls && urls.length) globalThis.RECLAIM_RPCS = [urls[0], urls[0]];
  } catch {}
}
load("core.js");
for (const f of fs.readdirSync(path.join(root, "sources")).filter(f => f.endsWith(".js"))) load("sources/" + f);

const W = RC.W, TOKEN = RC.ID.TOKEN.toBase58(), TOKEN22 = RC.ID.TOKEN22.toBase58(), SYS = RC.ID.SYSTEM.toBase58();
const STAKE = "Stake11111111111111111111111111111111111111";
const u64 = (d, o) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
const isToken = a => a && (a.owner === TOKEN || a.owner === TOKEN22) && a.data.length >= 165 && a.data.length !== 82;
const b64 = x => Uint8Array.from(Buffer.from(x, "base64"));

function view(a) {                               // normalise pre (AccountInfo) and post (simulation) accounts
  if (!a) return null;
  if (Array.isArray(a.data)) return { lamports: a.lamports, owner: a.owner, data: b64(a.data[0]) };
  return { lamports: a.lamports, owner: a.owner.toBase58(), data: a.data };
}

async function auditWallet(addr) {
  const pk = new W.PublicKey(addr), me = pk.toBase58();
  const cats = await RC.scanAll(pk);
  for (const c of cats) { c.selected = true; for (const i of c.items) i.on = true; }
  await RC.checkOptIn(pk, cats);
  const c = await RC.rpc();
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
  const built = RC.buildTxs(pk, cats, blockhash, lastValidBlockHeight);
  const flags = [], perCat = {};
  for (const { tx, cat } of built) {
    const burn = cat.group === "burn";
    const writable = [...new Set(tx.instructions.flatMap(ix => ix.keys.filter(k => k.isWritable).map(k => k.pubkey.toBase58())))];
    if (!writable.includes(me)) writable.push(me);
    const pre = (await RC.readAccounts(writable.map(k => new W.PublicKey(k)))).map(view);
    const msg = new W.TransactionMessage({ payerKey: pk, recentBlockhash: blockhash, instructions: tx.instructions }).compileToLegacyMessage();
    let sim;
    for (let t = 0; t < 4; t++) {
      try { sim = await c.simulateTransaction(new W.VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true,
        commitment: "confirmed", accounts: { encoding: "base64", addresses: writable } }); break; }
      catch (e) { if (t === 3) throw e; await new Promise(r => setTimeout(r, 800 * (t + 1))); }
    }
    perCat[cat.id] = (perCat[cat.id] || 0) + 1;
    if (sim.value.err) { flags.push(["SIM_FAIL", cat.id, JSON.stringify(sim.value.err)]); continue; }
    const post = sim.value.accounts.map(view);
    let net = 0;                                    // wallet + everything it owns/controls, in lamports
    writable.forEach((k, n) => {
      const a = pre[n], b = post[n];
      const dl = (b ? b.lamports : 0) - (a ? a.lamports : 0);
      if (k === me) { net += dl; return; }
      const any = b || a;
      const tokOwner = x => isToken(x) ? new W.PublicKey(x.data.slice(32, 64)).toBase58() : null;
      const owner = tokOwner(b) || tokOwner(a);
      const stakeAuth = x => x && x.owner === STAKE && x.data.length >= 76 ? new W.PublicKey(x.data.slice(44, 76)).toBase58() : null;
      const mine = owner === me || stakeAuth(b) === me || stakeAuth(a) === me;
      if (mine) net += dl;
      // someone else's plain wallet getting SOL
      if (a && a.owner === SYS && a.data.length === 0 && dl > 0) flags.push(["OTHER_SOL", cat.id, k + " +" + dl]);
      if (!a && b && b.owner === SYS && b.data.length === 0 && dl > 0) flags.push(["OTHER_SOL", cat.id, k + " +" + dl + " (new)"]);
      // token movements
      if (isToken(a) || isToken(b)) {
        const amt = x => isToken(x) ? u64(x.data, 64) : 0n;
        const d = amt(b) - amt(a);
        if (owner === me && d < 0n && !burn) flags.push(["SPENT_TOKENS", cat.id, k + " " + d]);
        if (owner && owner !== me && d > 0n && W.PublicKey.isOnCurve(new W.PublicKey(owner).toBytes()))
          flags.push(["OTHER_TOKENS", cat.id, k + " owner " + owner + " +" + d]);
      }
    });
    const fee = 5000 * msg.header.numRequiredSignatures;
    if (net < -fee - 1000) flags.push(["WALLET_LOSS", cat.id, "net " + net + " lamports"]);
  }
  return { built: built.length, perCat, flags };
}

(async () => {
  let total = 0;
  for (const w of process.argv.slice(2)) {
    try {
      const r = await auditWallet(w);
      total += r.flags.length;
      console.log(`\n${w}: ${r.built} tx in ${Object.keys(r.perCat).length} categories (${Object.entries(r.perCat).map(([k, v]) => k + ":" + v).join(", ")})`);
      for (const f of r.flags) console.log("  FLAG", f.join(" | "));
      if (!r.flags.length) console.log("  clean");
    } catch (e) { console.log(`\n${w}: AUDIT ERROR ${e.message}`); total++; }
  }
  console.log(`\nflags total: ${total}`);
})();
