"use strict";
// Order books and order programs: accounts a wallet opened to trade, with rent (and often tokens) still inside.
//  - Serum v3 (9xQeW…), OpenBook v1 (srmqP…) and Serum v2 (EUqoj…): OpenOrders (3228 bytes): market @13,
//    owner @45, base free/total @77/@85, quote free/total @93/@101, free slot bits u128 @109, referrer rebates @3213.
//    SettleFunds (tag 5) pays the free tokens to the wallet's token accounts; CloseOpenOrders (tag 14) then
//    returns the rent to the wallet. Market: vault signer nonce @45, base/quote mint @53/@85, vaults @117/@165.
//  - OpenBook v2 (opnb2LAf…): OpenOrdersAccount (1264 bytes, owner @8, market @40, position @144) and the
//    wallet's OpenOrdersIndexer PDA ["OpenOrdersIndexer", wallet]. settle_funds, close_open_orders_account,
//    and close_open_orders_indexer once the indexer lists no accounts.
//  - Jupiter Limit Order v1 (jupoN…, Order 315 bytes, maker @8) and v2 (j1o2q…, Order 372 bytes, maker @8):
//    cancel_order sends the unfilled input tokens back to the maker and closes the order to the maker.
//  - Jupiter DCA (DCA265…, Dca 289 bytes, user @8): close_dca returns what is left of the input, the output
//    not yet withdrawn, and the rent. Only finished DCAs and ones whose next cycle is long overdue are offered.
//  - Phoenix (PhoeNiX…): free trader balances inside the market account, paid out by WithdrawFunds (see below).
// Accounts with orders still resting on the book are not offered (they need a cancel on the market first).
(() => {
  const { W, P, ID, meta, gpa, readAccounts, disc, u64, u32, cat, pda, enc, ata, short, b58, readU64, prices, valueInLamports } = RC;
  const SERUM3 = P("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  const OPENBOOK1 = P("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
  const SERUM2 = P("EUqojwWA2rd19FZrzeBncJsm38Jm1hEhE3zsmX3bRc2o");
  const OPENBOOK2 = P("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb");
  const JUP_LO1 = P("jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu");
  const JUP_LO2 = P("j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X");
  const JUP_DCA = P("DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M");
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const SYMBOL = { [USDC]: "USDC", [USDT]: "USDT", [b58(ID.WSOL)]: "SOL" };
  const ATA_RENT = 2039280, ATA_RENT_22 = 2200000;   // Token-2022: conservative (extensions)

  const pk32 = (d, o) => new W.PublicKey(d.slice(o, o + 32));
  const i64 = (d, o) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigInt64(o, true);
  const ui = (n, dec) => (Number(n) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dec > 4 ? 4 : dec });
  const sym = m => SYMBOL[b58(m)] || short(m);
  const amountText = parts => parts.filter(x => x.amount > 0n).map(x => ui(x.amount, x.decimals) + " " + sym(x.mint)).join(" + ");

  const createAta = (p, mint, prog) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(p, mint, prog), false, true), meta(p, false, false),
    meta(mint, false, false), meta(ID.SYSTEM, false, false), meta(prog, false, false)] });
  const closeAcc = (p, acct, prog) => new W.TransactionInstruction({ programId: prog, data: Uint8Array.of(9), keys: [
    meta(acct, false, true), meta(p, false, true), meta(p, true, false)] });

  // Decimals and token program of each mint.
  async function mintInfo(mints) {
    const keys = [...new Set(mints.map(b58))].map(P);
    const accs = await readAccounts(keys), out = new Map();
    accs.forEach((a, i) => { if (a && a.data.length >= 82) out.set(b58(keys[i]), { dec: a.data[44], prog: a.owner }); });
    return out;
  }
  const existing = async keys => (await readAccounts(keys)).map(a => !!a);

  // Receiving side for one mint: the wallet's ATA, created if missing (the programs check it even for a zero
  // amount). A created ATA is closed again right after if it is wSOL (the SOL arrives as plain SOL) or received
  // nothing; one that keeps tokens costs its rent, which lowers the value.
  function receiver(pk, mint, prog, exists, amount) {
    const isSol = mint.equals(ID.WSOL), create = !exists, close = create && (isSol || amount === 0n);
    return { addr: ata(pk, mint, prog), mint, prog,
      pre: p => create ? [createAta(p, mint, prog)] : [],
      post: p => close ? [closeAcc(p, ata(p, mint, prog), prog)] : [],
      cost: create && !close ? (prog.equals(ID.TOKEN22) ? ATA_RENT_22 : ATA_RENT) : 0 };
  }
  // Lamports the wallet ends up with: token value (wSOL at face value) minus rent of ATAs it had to create.
  // wSOL is added here directly so it still counts when the price API is unavailable.
  const worth = async (parts, recs) => {
    const sol = parts.filter(x => x.amount > 0n && x.mint.equals(ID.WSOL)).reduce((s, x) => s + Number(x.amount), 0);
    return sol + await valueInLamports(parts.filter(x => x.amount > 0n && !x.mint.equals(ID.WSOL))) - recs.reduce((s, r) => s + r.cost, 0);
  };
  const nothing = (n, what) => n ? n + " " + what : "";
  const joinNotes = (...s) => s.filter(Boolean).join(" ");

  // ---------- Serum v2 / v3 and OpenBook v1 OpenOrders ----------
  // Serum v2 has no CloseOpenOrders: there only the free tokens can be settled, the rent stays locked.
  const DEX = [{ id: SERUM3, name: "Serum v3", close: true }, { id: OPENBOOK1, name: "OpenBook v1", close: true },
    { id: SERUM2, name: "Serum v2", close: false }];
  const dexIx = tag => cat(Uint8Array.of(0), u32(tag));
  const ALL_FREE = d => d.slice(109, 125).every(x => x === 255);

  RC.registerSource({
    id: "serum-openorders", title: "Serum / OpenBook v1 open-orders accounts", group: "rent", perTx: 3,
    programs: DEX.map(x => x.id),
    async scan(pk) {
      const found = [];
      const lists = await Promise.all(DEX.map(x => gpa(x.id, [{ dataSize: 3228 }, { memcmp: { offset: 45, bytes: b58(pk) } }])));
      let busy = 0;
      lists.forEach((l, k) => l.forEach(({ pubkey, account: a }) => {
        const d = a.data;
        const o = { dex: DEX[k], oo: pubkey, lamports: a.lamports, market: pk32(d, 13),
          baseFree: readU64(d, 77), baseTotal: readU64(d, 85), quoteFree: readU64(d, 93), quoteTotal: readU64(d, 101),
          rebates: readU64(d, 3213) };
        if (!ALL_FREE(d) || o.baseTotal !== o.baseFree || o.quoteTotal !== o.quoteFree) { busy++; return; }
        found.push(o);
      }));
      if (!found.length) return { items: [], note: nothing(busy, "account(s) still have orders on the book; cancel them on the market first.") };

      const mkKeys = [...new Set(found.map(o => b58(o.market)))].map(P);
      const mkAccs = new Map((await readAccounts(mkKeys)).map((a, i) => [b58(mkKeys[i]), a]));
      const needSettle = [];
      let gone = 0;
      for (const o of found) {
        const m = mkAccs.get(b58(o.market));
        const hasFunds = o.baseFree > 0n || o.quoteFree > 0n;
        if (!m || !m.owner.equals(o.dex.id) || m.data.length < 388) {
          if (hasFunds) { gone++; o.skip = true; }        // tokens cannot be settled without the market
          continue;
        }
        const d = m.data;
        o.baseMint = pk32(d, 53); o.quoteMint = pk32(d, 85); o.baseVault = pk32(d, 117); o.quoteVault = pk32(d, 165);
        try { o.signer = W.PublicKey.createProgramAddressSync([o.market.toBytes(), u64(readU64(d, 45))], o.dex.id); }
        catch { o.skip = true; gone++; continue; }
        o.settle = hasFunds || o.rebates > 0n;
        if (o.settle) needSettle.push(o);
      }
      const mi = await mintInfo(needSettle.flatMap(o => [o.baseMint, o.quoteMint]));
      const has = await existing(needSettle.flatMap(o => [ata(pk, o.baseMint), ata(pk, o.quoteMint)]));
      await prices(needSettle.flatMap(o => [o.baseMint, o.quoteMint]));
      const CLOSE = dexIx(14), SETTLE = dexIx(5);
      const items = [];
      let i = 0;
      for (const o of found) {
        if (o.skip) continue;
        if (!o.dex.close && !o.settle) continue;
        let pre = () => [], post = () => [], value = o.dex.close ? o.lamports : 0, text = "";
        if (o.settle) {
          const bi = mi.get(b58(o.baseMint)), qi = mi.get(b58(o.quoteMint));
          const rb = receiver(pk, o.baseMint, ID.TOKEN, has[2 * i], o.baseFree), rq = receiver(pk, o.quoteMint, ID.TOKEN, has[2 * i + 1], o.quoteFree + o.rebates);   // settle may pay rebates to it too
          i++;
          if (!bi || !qi) { gone++; continue; }
          const parts = [{ mint: o.baseMint, amount: o.baseFree, decimals: bi.dec }, { mint: o.quoteMint, amount: o.quoteFree, decimals: qi.dec }];
          value += await worth(parts, [rb, rq]);
          text = amountText(parts);
          pre = p => [...rb.pre(p), ...rq.pre(p), new W.TransactionInstruction({ programId: o.dex.id, data: SETTLE, keys: [
            meta(o.market, false, true),
            meta(o.oo, false, true),              // open orders
            meta(p, true, false),                 // owner: signs
            meta(o.baseVault, false, true), meta(o.quoteVault, false, true),
            meta(rb.addr, false, true),           // the wallet's base token account
            meta(rq.addr, false, true),           // the wallet's quote token account
            meta(o.signer, false, false),         // vault signer PDA [market, nonce]
            meta(ID.TOKEN, false, false)] })];
          post = p => [...rb.post(p), ...rq.post(p)];
        }
        const close = p => o.dex.close ? [new W.TransactionInstruction({ programId: o.dex.id, data: CLOSE, keys: [
          meta(o.oo, false, true),                // open orders: closed
          meta(p, true, false),                   // owner: signs
          meta(p, false, true),                   // rent goes to the wallet
          meta(o.market, false, false)] })] : [];
        items.push({ key: o.oo, value,
          label: o.dex.name + " · market " + short(o.market) + " · " + [text, o.dex.close ? (o.lamports / 1e9).toFixed(4) + " SOL rent" : ""]
            .filter(Boolean).join(" + "),
          ixs: p => [...pre(p), ...close(p), ...post(p)] });
      }
      return { items: items.sort((a, b) => b.value - a.value), note: joinNotes(
        nothing(busy, "account(s) still have orders on the book; cancel them on the market first."),
        nothing(gone, "account(s) hold tokens on a market that no longer exists and cannot be settled.")) };
    },
  });

  // ---------- OpenBook v2 ----------
  RC.registerSource({
    id: "openbook-v2", title: "OpenBook v2 open-orders accounts", group: "rent", perTx: 2, programs: [OPENBOOK2],
    async scan(pk) {
      const indexer = pda([enc("OpenOrdersIndexer"), pk.toBytes()], OPENBOOK2)[0];
      const [list, [idxAcc]] = await Promise.all([
        gpa(OPENBOOK2, [{ dataSize: 1264 }, { memcmp: { offset: 8, bytes: b58(pk) } }]),
        readAccounts([indexer])]);
      const listed = new Set();
      if (idxAcc && idxAcc.owner.equals(OPENBOOK2)) {
        const d = idxAcc.data, n = new DataView(d.buffer, d.byteOffset).getUint32(13, true);
        for (let k = 0; k < n; k++) listed.add(b58(pk32(d, 17 + 32 * k)));
      }
      let busy = 0, penalty = 0, other = 0;
      const found = [];
      for (const { pubkey, account: a } of list) {
        const d = a.data;
        const o = { ooa: pubkey, lamports: a.lamports, market: pk32(d, 40),
          baseFree: readU64(d, 160), quoteFree: readU64(d, 168), fees: readU64(d, 176), rebates: readU64(d, 184) };
        if (i64(d, 144) !== 0n || i64(d, 152) !== 0n || i64(d, 232) !== 0n) { busy++; continue; }
        if (readU64(d, 192) > 0n) { penalty++; continue; }     // settling would charge a penalty paid to the market
        if (!listed.has(b58(pubkey))) { other++; continue; }
        found.push(o);
      }
      const items = [];
      if (found.length) {
        const mkKeys = [...new Set(found.map(o => b58(o.market)))].map(P);
        const mk = new Map((await readAccounts(mkKeys)).map((a, i) => [b58(mkKeys[i]), a]));
        const live = [];
        for (const o of found) {
          const m = mk.get(b58(o.market));
          o.settle = o.baseFree > 0n || o.quoteFree > 0n || o.rebates > 0n || o.fees > 0n;
          if (!m || !m.owner.equals(OPENBOOK2) || m.data.length !== 848) { if (o.settle) { other++; continue; } live.push(o); continue; }
          const d = m.data;
          Object.assign(o, { auth: pk32(d, 16), baseMint: pk32(d, 576), quoteMint: pk32(d, 608), baseVault: pk32(d, 640),
            quoteVault: pk32(d, 680), baseDec: d[9], quoteDec: d[10] });
          live.push(o);
        }
        const st = live.filter(o => o.settle);
        const mi = await mintInfo(st.flatMap(o => [o.baseMint, o.quoteMint]));
        const has = await existing(st.flatMap(o => [ata(pk, o.baseMint), ata(pk, o.quoteMint)]));
        await prices(st.flatMap(o => [o.baseMint, o.quoteMint]));
        const [SETTLE, CLOSE] = await Promise.all([disc("settle_funds"), disc("close_open_orders_account")]);
        let j = 0;
        for (const o of live) {
          let pre = () => [], post = () => [], value = o.lamports, text = "";
          if (o.settle) {
            const k = j++;
            const bp = mi.get(b58(o.baseMint))?.prog, qp = mi.get(b58(o.quoteMint))?.prog;
            if (!bp || !qp || !bp.equals(ID.TOKEN) || !qp.equals(ID.TOKEN)) { other++; continue; }   // settle takes one token program
            const rb = receiver(pk, o.baseMint, ID.TOKEN, has[2 * k], o.baseFree);
            const rq = receiver(pk, o.quoteMint, ID.TOKEN, has[2 * k + 1], o.quoteFree + o.rebates + o.fees);
            const parts = [{ mint: o.baseMint, amount: o.baseFree, decimals: o.baseDec }, { mint: o.quoteMint, amount: o.quoteFree, decimals: o.quoteDec }];
            value += await worth(parts, [rb, rq]);
            text = amountText(parts);
            pre = p => [...rb.pre(p), ...rq.pre(p), new W.TransactionInstruction({ programId: OPENBOOK2, data: SETTLE, keys: [
              meta(p, true, true),                  // owner: signs
              meta(p, true, true),                  // penalty payer (no penalty: skipped above)
              meta(o.ooa, false, true), meta(o.market, false, true),
              meta(o.auth, false, false),           // market authority PDA ["Market", market]
              meta(o.baseVault, false, true), meta(o.quoteVault, false, true),
              meta(rb.addr, false, true),           // the wallet's base token account
              meta(rq.addr, false, true),           // the wallet's quote token account
              meta(OPENBOOK2, false, false),        // referrer: none
              meta(ID.TOKEN, false, false), meta(ID.SYSTEM, false, false)] })];
            post = p => [...rb.post(p), ...rq.post(p)];
          }
          items.push({ key: o.ooa, value, market: o.market,
            label: "OpenBook v2 · market " + short(o.market) + " · " + [text, (o.lamports / 1e9).toFixed(4) + " SOL rent"].filter(Boolean).join(" + "),
            ixs: p => [...pre(p), new W.TransactionInstruction({ programId: OPENBOOK2, data: CLOSE, keys: [
              meta(p, true, false),                 // owner: signs
              meta(indexer, false, true),           // the wallet's indexer PDA
              meta(o.ooa, false, true),             // open orders account: closed
              meta(p, false, true),                 // rent goes to the wallet
              meta(ID.SYSTEM, false, false)] }), ...post(p)] });
        }
      }
      // The indexer can be closed once it lists nothing. If every account it lists is closed here and they fit
      // in one transaction, they become one item that ends with closing the indexer.
      let idxNote = "";
      if (idxAcc && idxAcc.owner.equals(OPENBOOK2) && items.length === listed.size && items.length <= 2) {
        const CLOSE_IDX = await disc("close_open_orders_indexer");
        const closeIdx = p => new W.TransactionInstruction({ programId: OPENBOOK2, data: CLOSE_IDX, keys: [
          meta(p, true, false),                     // owner: signs
          meta(indexer, false, true),               // indexer: closed
          meta(p, false, true),                     // rent goes to the wallet
          meta(ID.TOKEN, false, false)] });
        const parts = items.splice(0);
        items.push({ key: indexer, value: parts.reduce((s, x) => s + x.value, 0) + idxAcc.lamports,
          label: parts.length ? parts.map(x => x.label).join(" · ") + " · indexer " + (idxAcc.lamports / 1e9).toFixed(4) + " SOL"
            : "OpenBook v2 · empty open-orders indexer " + (idxAcc.lamports / 1e9).toFixed(4) + " SOL",
          ixs: p => [...parts.flatMap(x => x.ixs(p)), closeIdx(p)] });
      } else if (idxAcc && items.length) idxNote = "The OpenBook v2 indexer account can be closed on a later scan, once the accounts above are closed.";
      return { items: items.sort((a, b) => b.value - a.value), note: joinNotes(
        nothing(busy, "account(s) still have orders on the book; cancel them on the market first."),
        nothing(penalty, "account(s) owe an event-heap penalty on settlement and are left out."),
        nothing(other, "account(s) could not be handled here (market gone, Token-2022 market, or not in the indexer)."), idxNote) };
    },
  });

  // ---------- Jupiter Limit Order v1 / v2 ----------
  const LO2_EVENTS = pda([enc("__event_authority")], JUP_LO2)[0];
  let loCache = null;   // both limit-order sources read the same accounts once per scan
  async function limitOrders(pk) {
    if (loCache && loCache.pk.equals(pk) && Date.now() - loCache.t < 20000) return loCache.v;
    const [v1, v2] = await Promise.all([
      gpa(JUP_LO1, [{ dataSize: 315 }, { memcmp: { offset: 8, bytes: b58(pk) } }]),
      gpa(JUP_LO2, [{ dataSize: 372 }, { memcmp: { offset: 8, bytes: b58(pk) } }])]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const orders = [
      ...v1.map(({ pubkey, account: a }) => { const d = a.data; return { v: 1, order: pubkey, lamports: a.lamports,
        inMint: pk32(d, 40), outMint: pk32(d, 72), making: readU64(d, 121), makerIn: pk32(d, 137), reserve: pk32(d, 201) }; }),
      ...v2.map(({ pubkey, account: a }) => { const d = a.data; return { v: 2, order: pubkey, lamports: a.lamports,
        inMint: pk32(d, 40), outMint: pk32(d, 72), inProg: pk32(d, 104), reserve: pk32(d, 168), making: readU64(d, 224),
        expired: d[248] === 1 && i64(d, 249) < now }; })];
    const reserves = await readAccounts(orders.map(o => o.reserve));
    const makerIns = await readAccounts(orders.filter(o => o.v === 1).map(o => o.makerIn));
    let k = 0;
    orders.forEach((o, i) => {
      o.reserveLamports = reserves[i]?.lamports || 0;
      if (o.v === 1) o.makerInOk = (a => !!a && a.data.length >= 64 && pk32(a.data, 32).equals(pk) && pk32(a.data, 0).equals(o.inMint))(makerIns[k++]);
    });
    loCache = { pk, t: Date.now(), v: orders };
    return orders;
  }
  async function limitItems(pk, orders) {
    if (!orders.length) return [];
    const mi = await mintInfo(orders.map(o => o.inMint));
    for (const o of orders) { const m = mi.get(b58(o.inMint)); o.dec = m?.dec; o.inProg = o.inProg || m?.prog; }
    const ok = orders.filter(o => o.dec !== undefined && o.inProg);
    const has = await existing(ok.map(o => ata(pk, o.inMint, o.inProg)));
    await prices(ok.map(o => o.inMint));
    const CANCEL = await disc("cancel_order");
    const items = [];
    for (const [i, o] of ok.entries()) {
      // v1 pays back to the token account stored in the order when it still exists, else to the wallet's ATA.
      const useStored = o.v === 1 && o.makerInOk;
      const r = useStored ? { addr: o.makerIn, pre: () => [], post: () => [], cost: 0 } : receiver(pk, o.inMint, o.inProg, has[i], o.making);
      const parts = [{ mint: o.inMint, amount: o.making, decimals: o.dec }];
      // The reserve is closed to the maker too; for wSOL its lamports already include the tokens.
      const reserveRent = o.reserveLamports - (o.inMint.equals(ID.WSOL) ? Number(o.making) : 0);
      const value = o.lamports + Math.max(0, reserveRent) + await worth(parts, [r]);
      const ix = o.v === 1
        ? p => new W.TransactionInstruction({ programId: JUP_LO1, data: CANCEL, keys: [
            meta(o.order, false, true), meta(o.reserve, false, true),
            meta(p, true, true),                    // maker: signs, gets the rent
            meta(r.addr, false, true),              // the wallet's input-token account
            meta(ID.SYSTEM, false, false), meta(o.inProg, false, false), meta(o.inMint, false, false)] })
        : p => new W.TransactionInstruction({ programId: JUP_LO2, data: CANCEL, keys: [
            meta(p, true, true),                    // signer: the maker
            meta(p, false, true),                   // maker: gets the rent
            meta(o.order, false, true), meta(o.reserve, false, true),
            meta(r.addr, false, true),              // the wallet's input-token ATA
            meta(o.inMint, false, false), meta(o.inProg, false, false),
            meta(LO2_EVENTS, false, false), meta(JUP_LO2, false, false)] });
      items.push({ key: o.order, value,
        label: "Jupiter limit order v" + o.v + (o.expired ? " (expired)" : "") + " · " + (amountText(parts) || "0 " + sym(o.inMint)) + " → " + sym(o.outMint),
        ixs: p => [...r.pre(p), ix(p), ...r.post(p)] });
    }
    return items.sort((a, b) => b.value - a.value);
  }

  // v1 is Jupiter's retired limit-order program; v2 orders past their expiry can no longer fill.
  RC.registerSource({
    id: "jupiter-limit", title: "Jupiter limit orders (old or expired)", group: "escrow", perTx: 4, programs: [JUP_LO1, JUP_LO2],
    async scan(pk) {
      const all = await limitOrders(pk), open = all.filter(o => o.v === 2 && !o.expired).length;
      return { items: await limitItems(pk, all.filter(o => o.v === 1 || o.expired)),
        note: open ? open + " open Jupiter limit order(s) are listed separately (off by default)." : "" };
    },
  });
  // Live v2 orders can still fill; cancelling them is the owner's call, so this one is opt-in.
  RC.registerSource({
    id: "jupiter-limit-open", title: "Jupiter limit orders still open (cancel)", group: "escrow", perTx: 4, programs: [JUP_LO2],
    defaultOn: false,
    async scan(pk) {
      const items = await limitItems(pk, (await limitOrders(pk)).filter(o => o.v === 2 && !o.expired));
      return { items, note: items.length ? "These orders are still live on Jupiter; cancelling returns the unfilled tokens and the rent." : "" };
    },
  });

  // ---------- Jupiter DCA ----------
  const DCA_EVENTS = pda([enc("__event_authority")], JUP_DCA)[0];
  const STALE = 7n * 86400n;    // next cycle overdue by a week: the keepers have given up on it
  RC.registerSource({
    id: "jupiter-dca", title: "Jupiter DCA (finished or stalled)", group: "escrow", perTx: 2, programs: [JUP_DCA],
    async scan(pk) {
      const list = await gpa(JUP_DCA, [{ dataSize: 289 }, { memcmp: { offset: 8, bytes: b58(pk) } }]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      let running = 0;
      const dcas = [];
      for (const { pubkey, account: a } of list) {
        const d = a.data;
        const inLeft = readU64(d, 120) - readU64(d, 128) - readU64(d, 144), outLeft = readU64(d, 152) - readU64(d, 136);
        if (inLeft > 0n && i64(d, 112) > now - STALE) { running++; continue; }
        dcas.push({ dca: pubkey, lamports: a.lamports, inMint: pk32(d, 40), outMint: pk32(d, 72), inLeft, outLeft });
      }
      if (!dcas.length) return { items: [], note: nothing(running, "DCA(s) still running are not listed.") };
      const mi = await mintInfo(dcas.flatMap(x => [x.inMint, x.outMint]));
      const ok = dcas.filter(x => mi.get(b58(x.inMint)) && mi.get(b58(x.outMint)));
      for (const x of ok) {
        const a = mi.get(b58(x.inMint)), b = mi.get(b58(x.outMint));
        Object.assign(x, { inProg: a.prog, inDec: a.dec, outProg: b.prog, outDec: b.dec,
          inAta: ata(x.dca, x.inMint, a.prog), outAta: ata(x.dca, x.outMint, b.prog) });
      }
      const accs = await readAccounts(ok.flatMap(x => [x.inAta, x.outAta, ata(pk, x.inMint, x.inProg), ata(pk, x.outMint, x.outProg)]));
      await prices(ok.flatMap(x => [x.inMint, x.outMint]));
      const CLOSE = await disc("close_dca");
      const items = [];
      for (const [i, x] of ok.entries()) {
        const tok = accs[4 * i]?.data?.length >= 72 ? readU64(accs[4 * i].data, 64) : 0n;          // what the DCA really holds
        const tokOut = accs[4 * i + 1]?.data?.length >= 72 ? readU64(accs[4 * i + 1].data, 64) : 0n;
        const same = x.inMint.equals(x.outMint);
        const ri = receiver(pk, x.inMint, x.inProg, !!accs[4 * i + 2], tok);
        const ro = same ? { addr: ri.addr, pre: () => [], post: () => [], cost: 0 } : receiver(pk, x.outMint, x.outProg, !!accs[4 * i + 3], tokOut);
        const parts = [{ mint: x.inMint, amount: tok, decimals: x.inDec }, ...(same ? [] : [{ mint: x.outMint, amount: tokOut, decimals: x.outDec }])];
        // The DCA's token accounts are closed to the wallet too; a wSOL one's lamports already include the tokens.
        const acctRent = (a, amt, mint) => a ? a.lamports - (mint.equals(ID.WSOL) ? Number(amt) : 0) : 0;
        const rent = x.lamports + acctRent(accs[4 * i], tok, x.inMint) + (same ? 0 : acctRent(accs[4 * i + 1], tokOut, x.outMint));
        items.push({ key: x.dca, value: rent + await worth(parts, [ri, ro]),
          label: "DCA " + short(x.dca) + " · " + sym(x.inMint) + " → " + sym(x.outMint) + (amountText(parts) ? " · " + amountText(parts) : ""),
          ixs: p => [...ri.pre(p), ...ro.pre(p), new W.TransactionInstruction({ programId: JUP_DCA, data: CLOSE, keys: [
            meta(p, true, true),                    // user: signs, gets the rent
            meta(x.dca, false, true),               // DCA account: closed
            meta(x.inMint, false, false), meta(x.outMint, false, false),
            meta(x.inAta, false, true), meta(x.outAta, false, true),     // the DCA's own token accounts
            meta(ri.addr, false, true), meta(ro.addr, false, true),     // the wallet's ATAs
            meta(ID.SYSTEM, false, false), meta(x.inProg, false, false), meta(ID.ATA, false, false),
            meta(DCA_EVENTS, false, false), meta(JUP_DCA, false, false)] }), ...ri.post(p), ...ro.post(p)] });
      }
      return { items: items.sort((a, b) => b.value - a.value), note: nothing(running, "DCA(s) still running are not listed.") };
    },
  });

  // ---------- Phoenix ----------
  // Trader balances live inside the market account: after the 576-byte header and 304 bytes of market fields
  // come the bids, asks and traders trees (32-byte header each, then fixed-size nodes of 64/64/144 bytes). A
  // trader node is 16 bytes of links, the trader key, then quote lots locked/free and base lots locked/free.
  // WithdrawFunds (tag 12, both amounts None = everything free) pays the free balance to the trader's ATAs.
  // Seats (128 bytes, market @8, trader @40) find the markets; their rent is not the trader's to reclaim.
  const PHOENIX = P("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY");
  const PHX_LOG = pda([enc("log")], PHOENIX)[0];
  function phoenixTrader(d, pk) {
    if (d.length < 880) return null;
    const n = k => Number(readU64(d, 16 + 8 * k));
    const bids = n(0), asks = n(1), seats = n(2);
    const start = 576 + 304 + 32 + bids * 64 + 32 + asks * 64 + 32;
    if (start + seats * 144 !== d.length) return null;
    const key = pk.toBytes();
    for (let i = 0; i < seats; i++) {
      const o = start + i * 144 + 16;
      let same = true;
      for (let b = 0; b < 32 && same; b++) same = d[o + b] === key[b];
      if (same) return { quoteFree: readU64(d, o + 40), baseFree: readU64(d, o + 56) };
    }
    return null;
  }
  RC.registerSource({
    id: "phoenix", title: "Phoenix free balances", group: "escrow", perTx: 3, programs: [PHOENIX],
    async scan(pk) {
      const seats = await gpa(PHOENIX, [{ dataSize: 128 }, { memcmp: { offset: 40, bytes: b58(pk) } }]);
      const mkKeys = [...new Set(seats.map(x => b58(pk32(x.account.data, 8))))].map(P);
      if (!mkKeys.length) return { items: [] };
      const found = [];
      for (const [i, a] of (await readAccounts(mkKeys)).entries()) {
        if (!a || !a.owner.equals(PHOENIX)) continue;
        const d = a.data, t = phoenixTrader(d, pk);
        if (!t || (t.quoteFree === 0n && t.baseFree === 0n)) continue;
        found.push({ market: mkKeys[i], baseDec: d[40], baseMint: pk32(d, 48), baseVault: pk32(d, 80), baseLot: readU64(d, 112),
          quoteDec: d[120], quoteMint: pk32(d, 128), quoteVault: pk32(d, 160), quoteLot: readU64(d, 192), ...t });
      }
      if (!found.length) return { items: [] };
      const has = await existing(found.flatMap(x => [ata(pk, x.baseMint), ata(pk, x.quoteMint)]));
      await prices(found.flatMap(x => [x.baseMint, x.quoteMint]));
      const WITHDRAW = Uint8Array.of(12, 0, 0);
      const items = [];
      for (const [i, x] of found.entries()) {
        const base = x.baseFree * x.baseLot, quote = x.quoteFree * x.quoteLot;
        const rb = receiver(pk, x.baseMint, ID.TOKEN, has[2 * i], base), rq = receiver(pk, x.quoteMint, ID.TOKEN, has[2 * i + 1], quote);
        const parts = [{ mint: x.baseMint, amount: base, decimals: x.baseDec }, { mint: x.quoteMint, amount: quote, decimals: x.quoteDec }];
        items.push({ key: x.market, value: await worth(parts, [rb, rq]),
          label: "Phoenix · market " + sym(x.baseMint) + "/" + sym(x.quoteMint) + " · " + amountText(parts),
          ixs: p => [...rb.pre(p), ...rq.pre(p), new W.TransactionInstruction({ programId: PHOENIX, data: WITHDRAW, keys: [
            meta(PHOENIX, false, false), meta(PHX_LOG, false, false),   // program and log authority PDA ["log"]
            meta(x.market, false, true),
            meta(p, true, false),                   // trader: signs
            meta(rb.addr, false, true), meta(rq.addr, false, true),     // the wallet's ATAs
            meta(x.baseVault, false, true), meta(x.quoteVault, false, true),
            meta(ID.TOKEN, false, false)] }), ...rb.post(p), ...rq.post(p)] });
      }
      return { items: items.sort((a, b) => b.value - a.value) };
    },
  });
})();
