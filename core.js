"use strict";
// Shared engine for the page and for test/run.cjs. Sources (sources/*.js) register themselves here;
// each one finds items a wallet can reclaim and builds the instructions for them. The engine
// simulates them, packs them into transactions and checks every transaction before it is signed.

const RC = (() => {
  const W = solanaWeb3;

  // Same list as the CSP in index.html. Program and token-account searches only work from a browser on the
  // first two (SEARCH); plain reads and simulations go to the others first, so the load is spread out.
  // test/run.cjs may replace both lists (globalThis.RECLAIM_RPCS) with a private research RPC; the page never does.
  const PUBLIC_SEARCH = ["https://solana-rpc.web.helium.io", "https://public.rpc.solanavibestation.com"];
  const PUBLIC_READ = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com", ...PUBLIC_SEARCH];
  // config.js may set one RPC for everything (e.g. a Helius key locked to this site's domain): far more
  // reliable than the free endpoints. Its origin must also be added to connect-src in index.html.
  const OWN = globalThis.RECLAIM_CONFIG?.rpc ? [globalThis.RECLAIM_CONFIG.rpc] : null;
  const SEARCH_RPCS = globalThis.RECLAIM_RPCS || (OWN ? [...OWN, ...PUBLIC_SEARCH] : PUBLIC_SEARCH);

  // Every request to our own RPC goes through a throttle: at most 4 in flight and 8 started per second, which
  // keeps a free-tier key under its rate limit even though all sources scan in parallel.
  const THROTTLED = new Set(OWN || []);
  const inflight = { n: 0, q: [], stamps: [] };
  async function throttledFetch(url, init) {
    while (true) {
      const now = Date.now();
      inflight.stamps = inflight.stamps.filter(t => now - t < 1000);
      if (inflight.n < 4 && inflight.stamps.length < 8) break;
      await new Promise(r => setTimeout(r, 60));
    }
    inflight.n++; inflight.stamps.push(Date.now());
    try { return await fetch(url, init); } finally { inflight.n--; }
  }
  const connect = u => new W.Connection(u, THROTTLED.has(u) ? { commitment: "confirmed", fetch: throttledFetch } : "confirmed");
  const RPCS = globalThis.RECLAIM_RPCS || (OWN ? [...OWN, ...PUBLIC_READ] : PUBLIC_READ);

  const P = s => new W.PublicKey(s);
  const ID = {
    SYSTEM: W.SystemProgram.programId,
    TOKEN: P("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    TOKEN22: P("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    ATA: P("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    COMPUTE: P("ComputeBudget111111111111111111111111111111"),
    WSOL: P("So11111111111111111111111111111111111111112"),
    RENT: P("SysvarRent111111111111111111111111111111111"),
    CLOCK: P("SysvarC1ock11111111111111111111111111111111"),
    STAKE_HISTORY: P("SysvarStakeHistory1111111111111111111111111"),
    INSTRUCTIONS: P("Sysvar1nstructions1111111111111111111111111"),
  };
  // Programs any source may call besides its own `programs` list.
  const BASE_PROGRAMS = [ID.SYSTEM, ID.TOKEN, ID.TOKEN22, ID.ATA, ID.COMPUTE];

  const sources = [];
  const registerSource = s => { sources.push(s); };

  const chunk = (list, n) => { const o = []; for (let i = 0; i < list.length; i += n) o.push(list.slice(i, i + n)); return o; };
  const b58 = k => k.toBase58();
  const short = s => (typeof s === "string" ? s : b58(s)).replace(/^(.{4}).*(.{4})$/, "$1…$2");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Never log a full RPC URL: a private one carries its key in the query string.
  const host = u => { try { return new URL(u).host; } catch { return "rpc"; } };
  const scrub = m => String(m).replace(/https?:\/\/[^\s"')]+/g, x => host(x));

  let conn;
  async function rpc() {
    if (conn) return conn;
    for (const u of RPCS) {
      try { const c = connect(u); await c.getLatestBlockhash(); return (conn = c); }
      catch (e) { console.warn("RPC", host(u), scrub(e?.message || e)); }
    }
    throw new Error("could not connect to a Solana RPC");
  }

  // Searches run at most two at a time; each RPC gets a few tries with backoff on rate limits.
  let running = 0;
  const waiting = [];
  async function slot(fn) {
    if (running >= 2) await new Promise(r => waiting.push(r));
    running++;
    try { return await fn(); } finally { running--; waiting.shift()?.(); }
  }
  // A 429 without CORS headers reaches the page as a bare network error, so treat those as busy too.
  const limited = e => /429|Too Many Requests|rate.?limit|overloaded|try again|Failed to fetch|NetworkError|Load failed/i.test(String(e?.message || e));
  async function search(fn) {
    return slot(async () => {
      let last;
      for (let round = 0; round < 3; round++) {
        for (const u of SEARCH_RPCS) {
          try { return await fn(connect(u)); }
          catch (e) {
            last = e;
            // Our own RPC refusing us (bad or revoked key, no credits) must not break the scan: use the next one.
            if (THROTTLED.has(u) && /401|403|Forbidden|Unauthorized|credits/i.test(String(e?.message || e))) { console.warn("own RPC refused, using public RPCs"); continue; }
            if (!limited(e)) throw e;
          }
        }
        await sleep(800 * (round + 1) + Math.random() * 400);
      }
      throw new Error("the free Solana RPCs are busy, try again in a minute (" + scrub(last?.message || last) + ")");
    });
  }

  // getProgramAccounts with memcmp / dataSize filters. Returns [{pubkey, account}] with Uint8Array data.
  const gpa = (programId, filters, dataSlice) =>
    search(c => c.getProgramAccounts(programId, { commitment: "confirmed", filters, ...(dataSlice ? { dataSlice } : {}) }));

  const tokenAccounts = (owner, programId) =>
    search(c => c.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed")).then(r => r.value);

  // getMultipleAccounts in groups of 10 (the most publicnode allows), with retries on rate limits.
  async function readAccounts(keys) {
    const c = await rpc(), out = [];
    for (const g of chunk(keys, 10)) {
      for (let t = 0; ; t++) {
        try { out.push(...await c.getMultipleAccountsInfo(g, "confirmed")); break; }
        catch (e) { if (t >= 3 || !limited(e)) throw e; await sleep(700 * (t + 1)); }
      }
    }
    return out;
  }

  // Anchor instruction / account discriminator: first 8 bytes of sha256("global:<name>") / ("account:<Name>").
  async function sha8(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).slice(0, 8); }
  const disc = name => sha8("global:" + name);
  const accDisc = name => sha8("account:" + name);

  function u64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; }
  function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
  function readU64(d, off) { return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true); }
  const cat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  const pda = (seeds, programId) => W.PublicKey.findProgramAddressSync(seeds, programId);
  const enc = s => new TextEncoder().encode(s);
  const ata = (owner, mint, tokenProgram = ID.TOKEN) => pda([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ID.ATA)[0];
  const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

  // Exact fingerprint of an instruction: program, every account with its flags, data.
  const ixKey = ix => b58(ix.programId) + "|" + ix.keys.map(k => b58(k.pubkey) + (k.isSigner ? "s" : "") + (k.isWritable ? "w" : "")).join(",")
    + "|" + Array.from(ix.data, x => x.toString(16).padStart(2, "0")).join("");

  async function retry(fn) {
    for (let t = 0; ; t++) {
      try { return await fn(); }
      catch (e) { if (t >= 3 || !limited(e)) throw e; await sleep(700 * (t + 1)); }
    }
  }

  async function simulate(pk, ixs) {
    const c = await rpc();
    const { blockhash } = await retry(() => c.getLatestBlockhash("confirmed"));
    const msg = new W.TransactionMessage({ payerKey: pk, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage();
    const sim = await retry(() => c.simulateTransaction(new W.VersionedTransaction(msg),
      { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }));
    if (sim.value.err) console.log("simulation failed", JSON.stringify(sim.value.err), (sim.value.logs || []).slice(-6).join("\n"));
    return sim.value.err;
  }

  const fits = (pk, ixs) => {
    try {
      const msg = new W.TransactionMessage({ payerKey: pk, recentBlockhash: b58(ID.SYSTEM), instructions: ixs }).compileToLegacyMessage();
      return msg.serialize().length + 1 + 64 * msg.header.numRequiredSignatures <= 1232;
    } catch { return false; }
  };

  // Packs items into transaction groups: at most perTx items, and never over the size limit.
  function groups(pk, items, perTx) {
    const out = [];
    let cur = [];
    for (const it of items) {
      const next = [...cur, it];
      if (cur.length && (next.length > perTx || !fits(pk, next.flatMap(i => i.ixs(pk))))) { out.push(cur); cur = [it]; }
      else cur = next;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // Simulates items in groups; a failing group is retried item by item and the failing items are dropped.
  let noFunds = false;
  async function keepPassing(pk, items, perTx) {
    if (noFunds) return { ok: items, dropped: 0, unchecked: true };
    const ok = [];
    let dropped = 0;
    for (const g of groups(pk, items, perTx)) {
      if (!await simulate(pk, g.flatMap(i => i.ixs(pk)))) { ok.push(...g); continue; }
      for (const i of g) (await simulate(pk, i.ixs(pk))) ? dropped++ : ok.push(i);
    }
    return { ok, dropped };
  }

  // Runs every source. A source that throws shows up as a category with an error note, never breaks the scan.
  async function scanAll(pk, onProgress) {
    const balance = await (await rpc()).getBalance(pk, "confirmed").catch(() => null);
    if (balance === 0) {
      // A wallet with no SOL cannot pay the network fee, so every simulation would fail and hide real funds.
      // Scan anyway, but keep the items and say what is needed.
      noFunds = true;
    } else noFunds = false;
    const cats = await Promise.all(sources.map(async s => {
      let r;
      try { r = await s.scan(pk, api); }
      catch (e) { console.warn("source", s.id, scrub(e?.message || e)); r = { items: [], error: "could not check: " + scrub(e?.message || e) }; }
      return { src: s, id: s.id, title: s.title, group: s.group || "other", perTx: s.perTx || 8,
        items: (r.items || []).filter(i => i.value > 0 || s.allowZero), note: r.note || "", error: r.error || "",
        selected: s.defaultOn !== false, optIn: s.defaultOn === false, updated: r.updated };
    }));
    onProgress && onProgress("Simulating withdrawals…");
    for (const c of cats) {
      if (!c.items.length) continue;
      // Opt-in categories (burns, live orders…) can hold thousands of items; they are simulated only when the
      // user actually picks them (checkOptIn, right before signing), so a spam-heavy wallet still scans fast.
      if (c.optIn) { for (const i of c.items) i.on = false; c.unchecked = true; continue; }
      const { ok, dropped, unchecked } = await keepPassing(pk, c.items, c.perTx);
      if (unchecked) c.note = (c.note ? c.note + " " : "") + "Not simulated yet: this wallet has 0 SOL for network fees.";
      c.items = ok;
      if (dropped) c.note = (c.note ? c.note + " " : "") + dropped + " item(s) left out because their simulation failed.";
      for (const i of c.items) i.on = !c.optIn;
    }
    return cats;
  }

  // What will actually be sent. Opt-in (destructive) choices win: if a chosen burn changes an account, any other
  // chosen item that touches the same account is left out, so nothing is counted twice or fails halfway.
  function chosen(cats, pk) {
    const picked = cats.filter(c => c.selected).map(c => ({ c, items: c.items.filter(i => i.on) })).filter(x => x.items.length);
    if (!pk) return picked;
    const taken = new Set();
    for (const { c, items } of picked) if (c.optIn)
      for (const i of items) for (const ix of i.ixs(pk)) for (const k of ix.keys) if (k.isWritable && !k.pubkey.equals(pk)) taken.add(b58(k.pubkey));
    if (!taken.size) return picked;
    return picked.map(({ c, items }) => ({ c, items: c.optIn ? items
      : items.filter(i => !i.ixs(pk).some(ix => ix.keys.some(k => k.isWritable && taken.has(b58(k.pubkey))))) })).filter(x => x.items.length);
  }

  // Last check before the wallet sees a transaction: fee payer is the wallet, and every instruction is
  // byte-for-byte one that a source built for an item found in this scan, calling an allowed program.
  function assertSafe(tx, pk, cats) {
    const expected = new Set(), allowed = new Set(BASE_PROGRAMS.map(b58));
    for (const c of cats) {
      for (const p of c.src.programs || []) allowed.add(typeof p === "string" ? p : b58(p));
      for (const i of c.items) for (const ix of i.ixs(pk)) expected.add(ixKey(ix));
    }
    const ok = tx.feePayer && tx.feePayer.equals(pk) && tx.instructions.length > 0
      && tx.instructions.every(ix => allowed.has(b58(ix.programId)) && expected.has(ixKey(ix)));
    if (!ok) throw new Error("safety check failed, transaction not sent");
  }

  // Simulates the opt-in items the user picked and drops the ones that would fail. Returns how many were dropped.
  async function checkOptIn(pk, cats) {
    let dropped = 0;
    for (const c of cats) {
      if (!c.optIn || !c.unchecked) continue;
      const picked = c.items.filter(i => i.on);
      if (!picked.length) continue;
      const r = await keepPassing(pk, picked, c.perTx);
      const ok = new Set(r.ok);
      for (const i of picked) if (!ok.has(i)) { i.on = false; i.failed = true; dropped++; }
    }
    return dropped;
  }

  function buildTxs(pk, cats, blockhash, lastValidBlockHeight) {
    const txs = [];
    for (const { c, items } of chosen(cats, pk)) {
      for (const g of groups(pk, items, c.perTx)) {
        const tx = new W.Transaction({ feePayer: pk, blockhash, lastValidBlockHeight });
        tx.add(...g.flatMap(i => i.ixs(pk)));
        assertSafe(tx, pk, cats);
        txs.push({ tx, cat: c, items: g });
      }
    }
    return txs;
  }

  // SOL value of token amounts, via Jupiter's public price API. Tokens with thin liquidity (< $10k) or no price
  // count as 0, so a fake price can never inflate what the page promises. Returns lamports (number).
  //   await RC.valueInLamports([{ mint: "…", amount: 123456n /* raw units */, decimals: 6 }])
  const PRICE_API = "https://lite-api.jup.ag/price/v3?ids=";
  const priceCache = new Map();
  // One request per batch of up to 50 mints; concurrent callers asking for the same mint share the request.
  // Rate-limited or broken answers are retried a few times and never cached, so a busy price API cannot
  // silently turn real balances into 0.
  const pricePending = new Map();
  async function fetchPrices(g) {
    for (let t = 0; t < 4; t++) {
      try {
        const res = await fetch(PRICE_API + g.join(","));
        if (res.status === 429 || res.status >= 500) throw new Error("price API " + res.status);
        const r = await res.json();
        for (const m of g) priceCache.set(m, r?.[m] && r[m].liquidity >= 10000 ? Number(r[m].usdPrice) || 0 : 0);
        return;
      } catch (e) { console.warn("price", e?.message || e); await sleep(600 * (t + 1) + Math.random() * 300); }
    }
  }
  async function prices(mints) {
    const want = [...new Set([...mints.map(m => typeof m === "string" ? m : b58(m)), b58(ID.WSOL)])];
    const need = want.filter(m => !priceCache.has(m) && !pricePending.has(m));
    for (const g of chunk(need, 50)) { const p = fetchPrices(g); for (const m of g) pricePending.set(m, p); }
    await Promise.all(want.map(m => pricePending.get(m)).filter(Boolean));
    for (const m of want) if (priceCache.has(m)) pricePending.delete(m);
    return m => priceCache.get(typeof m === "string" ? m : b58(m)) || 0;
  }
  async function valueInLamports(list) {
    if (!list.length) return 0;
    let total = 0;
    const rest = [];
    for (const x of list) {                           // wSOL is SOL: counted at face value, no price needed
      const m = typeof x.mint === "string" ? x.mint : b58(x.mint);
      if (m === b58(ID.WSOL)) total += Number(x.amount); else rest.push({ ...x, m });
    }
    if (rest.length) {
      const px = await prices(rest.map(x => x.m)), sol = px(ID.WSOL);
      if (sol) for (const x of rest) total += Number(x.amount) / 10 ** x.decimals * px(x.m) / sol * 1e9;
    }
    return Math.floor(total);
  }

  const api = { W, ID, P, b58, prices, valueInLamports, short, chunk, sleep, rpc, search, gpa, tokenAccounts, readAccounts,
    disc, accDisc, u64, u32, readU64, cat, pda, enc, ata, meta, ixKey, simulate };
  return { ...api, get noFunds() { return noFunds; }, sources, registerSource, scanAll, checkOptIn, groups, keepPassing, chosen, assertSafe, buildTxs };
})();
if (typeof globalThis !== "undefined") globalThis.RC = RC;
