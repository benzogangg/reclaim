"use strict";
// User accounts that trading / lending protocols keep for the wallet. Each one holds rent the owner gets back
// by closing it once it is empty; Jupiter's JLP collateral with no loan against it can also be taken back.
//  - marginfi v2 (MFv2hW…VacA): MarginfiAccount (2312 bytes): group @8, authority @40, 16 balances @72 (104 bytes
//    each: active u8 @0, asset shares I80F48 @40, liability shares @56), flags u64 @1800, active_orders u8 @2221,
//    liquidation_record @2224. `marginfi_account_close` [account, authority ✍, fee_payer ✍] closes it and pays the
//    rent to fee_payer (= the wallet). Only when every balance is below 1 share and no liability, no orders, no
//    liquidation record, not frozen/disabled.
//  - Mango v4 (4Mango…): MangoAccount (Anchor, variable size): group @8, owner @40, being_liquidated @140; dynamic
//    part @408: tokens (u32 count @12, 184 bytes each, token_index u16 @16), then serum3 (120 bytes, market @48),
//    then perps (304 bytes, market @0); an index of 0xffff = unused slot. `account_close(force_close = false)`
//    [group, account, owner ✍, sol_destination (= wallet), token program] closes it when every slot is unused.
//  - Jupiter Perps (PERPHj…): BorrowPosition (256 bytes, one per owner and borrowed custody): owner @8, pool @40,
//    custody @72, update time @112, borrow size u128 @120, locked JLP collateral u64 @152.
//    `close_borrow_position` [owner ✍, position, System, event authority, program] returns the rent to the owner
//    once borrow and collateral are 0. With collateral but no loan, `withdraw_collateral_for_borrows(amount)`
//    [owner ✍, perpetuals, pool, custody, transfer authority, position, JLP collateral vault PDA
//    ["jlp_collateral", pool], owner's JLP account, JLP mint, token program, event authority, program,
//    + every pool custody, + each custody's price account @384] pays all the JLP to the owner's JLP account;
//    the position is closed in the same step. Only positions untouched for 30+ days are offered.
// Not included: Drift v2 (its program no longer has delete_user, withdraw or reclaim_rent: every user
// instruction fails with InstructionFallbackNotFound), Solend/Save (no instruction closes an obligation).
(() => {
  const { W, P, ID, meta, gpa, readAccounts, disc, accDisc, u64, cat, pda, enc, ata, short, b58 } = RC;
  const MARGINFI = P("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
  const MANGO = P("4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg");
  const JUP = P("PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu");
  const JUP_EVENTS = pda([enc("__event_authority")], JUP)[0];
  const JUP_PERPETUALS = pda([enc("perpetuals")], JUP)[0];
  const JUP_AUTHORITY = pda([enc("transfer_authority")], JUP)[0];
  const JLP = P("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4");
  const ATA_RENT = 2039280, IDLE_SECS = 30 * 86400;

  const view = d => new DataView(d.buffer, d.byteOffset, d.byteLength);
  const key = (d, o) => new W.PublicKey(d.slice(o, o + 32));
  const i128 = (v, o) => (v.getBigInt64(o + 8, true) << 64n) | v.getBigUint64(o, true);
  const b58bytes = bytes => {   // base58 of a short byte string (for memcmp on discriminators)
    const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n, s = "";
    for (const x of bytes) n = n * 256n + BigInt(x);
    while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
    for (const x of bytes) { if (x) break; s = "1" + s; }
    return s;
  };

  // ---- marginfi ----
  const ONE_SHARE = 1n << 48n;   // I80F48 1.0 = EMPTY_BALANCE_THRESHOLD
  function marginfiState(d) {
    const v = view(d);
    for (let i = 0; i < 16; i++) {
      const o = 72 + 104 * i;
      if (i128(v, o + 40) >= ONE_SHARE || i128(v, o + 56) > 0n) return "balances";
    }
    const flags = v.getBigUint64(1800, true);
    if (flags & 0b1110011n) return "locked";              // disabled / flashloan / receivership / deleverage / frozen
    if (d[2221]) return "orders";
    if (d.slice(2224, 2256).some(x => x)) return "liquidation record";
    return "ok";
  }
  async function marginfiItems(pk) {
    const found = await gpa(MARGINFI, [{ dataSize: 2312 }, { memcmp: { offset: 40, bytes: b58(pk) } }]);
    const data = await disc("marginfi_account_close");
    const items = [], busy = {};
    for (const { pubkey, account: a } of found) {
      const st = marginfiState(a.data);
      if (st !== "ok") { busy[st] = (busy[st] || 0) + 1; continue; }
      items.push({ key: pubkey, value: a.lamports, label: "marginfi account " + short(pubkey),
        ixs: p => [new W.TransactionInstruction({ programId: MARGINFI, data, keys: [
          meta(pubkey, false, true),     // marginfi account: closed
          meta(p, true, false),          // authority
          meta(p, true, true)] })] });   // fee_payer: receives the rent
    }
    const n = Object.values(busy).reduce((s, x) => s + x, 0);
    const note = n ? n + " marginfi account(s) can't be closed yet (" + Object.entries(busy).map(([k, x]) => x + " " + k).join(", ")
      + "); empty them in the marginfi app first." : "";
    return { items, note };
  }

  // ---- Mango v4 ----
  function mangoState(d) {
    if (d.length < 424) return "unknown";
    const v = view(d), D = 408, tc = v.getUint32(D + 12, true);
    for (let i = 0; i < tc; i++) if (v.getUint16(D + 16 + 184 * i + 16, true) !== 0xffff) return "tokens";
    const s0 = D + 16 + 184 * tc + 4, sc = v.getUint32(s0, true);
    for (let i = 0; i < sc; i++) if (v.getUint16(s0 + 4 + 120 * i + 48, true) !== 0xffff) return "serum";
    const p0 = s0 + 4 + 120 * sc + 4, pc = v.getUint32(p0, true);
    for (let i = 0; i < pc; i++) if (v.getUint16(p0 + 4 + 304 * i, true) !== 0xffff) return "perps";
    return d[140] ? "liquidation" : "ok";
  }
  async function mangoItems(pk) {
    const found = await gpa(MANGO, [{ memcmp: { offset: 0, bytes: b58bytes(await accDisc("MangoAccount")) } },
      { memcmp: { offset: 40, bytes: b58(pk) } }]);
    const data = cat(await disc("account_close"), Uint8Array.of(0));   // force_close = false
    const items = [];
    let busy = 0;
    for (const { pubkey, account: a } of found) {
      if (mangoState(a.data) !== "ok") { busy++; continue; }
      const group = key(a.data, 8);
      items.push({ key: pubkey, value: a.lamports, label: "Mango account " + short(pubkey),
        ixs: p => [new W.TransactionInstruction({ programId: MANGO, data, keys: [
          meta(group, false, false),
          meta(pubkey, false, true),     // Mango account: closed
          meta(p, true, false),          // owner
          meta(p, false, true),          // sol_destination: this wallet
          meta(ID.TOKEN, false, false)] })] });
    }
    return { items, note: busy ? busy + " Mango account(s) still hold token or market positions and can't be closed here." : "" };
  }

  // ---- Jupiter Perps borrow positions ----
  let jupCache = null;   // both sources use the same scan
  async function jupPositions(pk) {
    if (jupCache && jupCache.pk.equals(pk) && Date.now() - jupCache.t < 20000) return jupCache.list;
    const list = await gpa(JUP, [{ dataSize: 256 }, { memcmp: { offset: 0, bytes: b58bytes(await accDisc("BorrowPosition")) } },
      { memcmp: { offset: 8, bytes: b58(pk) } }]);
    jupCache = { pk, t: Date.now(), list };
    return list;
  }
  const jupPos = d => { const v = view(d); return {
    pool: key(d, 40), custody: key(d, 72), updated: Number(v.getBigInt64(112, true)),
    borrow: i128(v, 120), collateral: v.getBigUint64(152, true) }; };
  const closeBorrowIx = (position, data) => p => new W.TransactionInstruction({ programId: JUP, data, keys: [
    meta(p, true, true),               // owner: receives the rent
    meta(position, false, true),       // borrow position: closed
    meta(ID.SYSTEM, false, false),
    meta(JUP_EVENTS, false, false),
    meta(JUP, false, false)] });

  async function jupEmptyItems(pk) {
    const data = await disc("close_borrow_position");
    return (await jupPositions(pk)).filter(({ account: a }) => { const x = jupPos(a.data); return x.borrow === 0n && x.collateral === 0n; })
      .map(({ pubkey, account: a }) => ({ key: pubkey, value: a.lamports, label: "Jupiter Perps borrow position " + short(pubkey),
        ixs: p => [closeBorrowIx(pubkey, data)(p)] }));
  }

  // Pool custodies and their price accounts, which the program reads when collateral moves.
  async function jupPoolAccounts(pool) {
    const [pi] = await readAccounts([pool]);
    const d = pi.data, v = view(d);
    let o = 8 + 4 + v.getUint32(8, true);
    const n = v.getUint32(o, true);
    o += 4;
    const custodies = [];
    for (let i = 0; i < n; i++) custodies.push(key(d, o + 32 * i));
    const infos = await readAccounts(custodies);
    if (infos.some(x => !x || x.data.length < 416)) throw new Error("unexpected Jupiter custody layout");
    return [...custodies, ...infos.map(x => key(x.data, 384))];
  }

  async function jupWithdrawItems(pk) {
    const now = Math.floor(Date.now() / 1000);
    const all = (await jupPositions(pk)).map(x => ({ ...x, pos: jupPos(x.account.data) }));
    const withColl = all.filter(x => x.pos.borrow === 0n && x.pos.collateral > 0n);
    const idle = withColl.filter(x => now - x.pos.updated >= IDLE_SECS);
    const recent = withColl.length - idle.length, loans = all.filter(x => x.pos.borrow > 0n).length;
    const notes = [];
    if (recent) notes.push(recent + " Jupiter borrow position(s) with JLP collateral and no loan were used in the last 30 days and are left alone.");
    if (loans) notes.push(loans + " Jupiter borrow position(s) still have a loan; repay it in Jupiter first.");
    if (!idle.length) return { items: [], note: notes.join(" ") };

    const wdData = await disc("withdraw_collateral_for_borrows"), closeData = await disc("close_borrow_position");
    const userJlp = ata(pk, JLP);
    const [jlpAcc] = await readAccounts([userJlp]);
    const extras = {};
    for (const x of idle) { const k = b58(x.pos.pool); if (!extras[k]) extras[k] = await jupPoolAccounts(x.pos.pool); }
    const items = [];
    let needAta = !jlpAcc;
    for (const { pubkey, account: a, pos } of idle) {
      const amount = pos.collateral, pool = pos.pool, custody = pos.custody, rest = extras[b58(pool)];
      const vault = pda([enc("jlp_collateral"), pool.toBytes()], JUP)[0];
      const jlpValue = await RC.valueInLamports([{ mint: JLP, amount, decimals: 6 }]);
      const value = jlpValue + a.lamports - (needAta ? ATA_RENT : 0);
      needAta = false;
      items.push({ key: pubkey, value,
        label: (Number(amount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 }) + " JLP collateral, no loan · Jupiter Perps " + short(pubkey),
        ixs: p => {
          const dest = ata(p, JLP);
          return [
            new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [   // create JLP account if missing
              meta(p, true, true), meta(dest, false, true), meta(p, false, false), meta(JLP, false, false),
              meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] }),
            new W.TransactionInstruction({ programId: JUP, data: cat(wdData, u64(amount)), keys: [
              meta(p, true, true),                 // owner
              meta(JUP_PERPETUALS, false, false),
              meta(pool, false, false),
              meta(custody, false, true),
              meta(JUP_AUTHORITY, false, false),
              meta(pubkey, false, true),           // borrow position
              meta(vault, false, true),            // JLP collateral vault
              meta(dest, false, true),             // the wallet's JLP account
              meta(JLP, false, false),
              meta(ID.TOKEN, false, false),
              meta(JUP_EVENTS, false, false),
              meta(JUP, false, false),
              ...rest.map(k => meta(k, false, false))] }),
            closeBorrowIx(pubkey, closeData)(p)];
        } });
    }
    return { items, note: notes.join(" ") };
  }

  const safely = async (list, name, fn) => {
    try { return await fn(); }
    catch (e) { list.push(name + " could not be checked (" + (e?.message || e) + ")."); return { items: [], note: "" }; }
  };

  RC.registerSource({
    id: "accounts-close", title: "Idle protocol accounts (marginfi, Mango, Jupiter Perps)", group: "rent", perTx: 8,
    programs: [MARGINFI, MANGO, JUP],
    async scan(pk) {
      const errors = [];
      const parts = await Promise.all([
        safely(errors, "marginfi", () => marginfiItems(pk)),
        safely(errors, "Mango", () => mangoItems(pk)),
        safely(errors, "Jupiter Perps", async () => ({ items: await jupEmptyItems(pk), note: "" })),
      ]);
      if (errors.length === parts.length) throw new Error(errors.join(" "));
      return { items: parts.flatMap(x => x.items).sort((a, b) => b.value - a.value),
        note: [...parts.map(x => x.note), ...errors].filter(Boolean).join(" ") };
    },
  });

  RC.registerSource({
    id: "accounts-withdraw", title: "Jupiter Perps JLP collateral without a loan", group: "escrow", perTx: 1,
    programs: [JUP],
    async scan(pk) { const r = await jupWithdrawItems(pk); r.items.sort((a, b) => b.value - a.value); return r; },
  });
})();
