"use strict";
// Pump.fun (6EF8…) and PumpSwap (pAMM…) money that accrues to a wallet and waits for it to be claimed.
// Every account below is a PDA of the wallet (or an ATA of one), so no program-wide search is needed.
//  - Pump creator fees in SOL: lamports of PDA ["creator-vault", creator] (system-owned, no data).
//    collect_creator_fee sends everything above the rent-exempt minimum to the creator.
//    Accounts: creator(w), creator_vault(w), system, event_authority, program.
//  - Pump creator fees in a token quote (e.g. USDC coins): ATA of that vault per quote mint. collect_creator_fee_v2:
//    creator(w), creator_ata(w), creator_vault(w), vault_ata(w), quote_mint, token_program, ata_program, system,
//    event_authority, program.
//  - PumpSwap creator fees: ATA of PDA ["creator_vault", creator] per quote mint (mostly wSOL, some USDC/others).
//    collect_coin_creator_fee: quote_mint, token_program, coin_creator, vault_authority, vault_ata(w),
//    creator_token_account(w), event_authority, program.
//  - Pump cashback in SOL: PDA ["user_volume_accumulator", user] (137 bytes); owed = cashback_earned @74 minus
//    total_cashback_claimed @82, paid from its lamports. claim_cashback: user(w), accumulator(w), system,
//    event_authority, program.
//  - Pump cashback on token-quoted coins: ATAs of that accumulator (stable_cashback_earned @90 minus claimed @98
//    says whether any is owed). claim_cashback_v2: user(w), accumulator(w),
//    quote_mint, token_program, ata_program, accumulator_ata(w), user_token_account(w), system, event_authority, program.
//  - PumpSwap cashback: ATAs of PumpSwap's ["user_volume_accumulator", user] (wSOL or another quote mint). claim_cashback:
//    user(w), accumulator(w), quote_mint, token_program, accumulator_ata(w), user_token_account(w), system,
//    event_authority, program.
// Token payouts go to the wallet's own ATA, created idempotently in the same item when missing (its rent is
// subtracted from the value). wSOL: with no wSOL ATA the item creates it, claims and closes it in one go, so the
// wallet gets plain SOL; if a wSOL ATA already exists the claim lands there as wSOL and it is left alone.
// Layouts checked against pump-fun/pump-public-docs IDLs and mainnet txs u3jvEwox…, 3h61wxiL…, P1cXLVPw…,
// 64w2xxaM…, 2YA86S5K….
// Not handled: PUMP token incentives (claim_token_incentives), fees of coins that use a fee-sharing config
// (they are distributed by distribute_creator_fees to the shareholders, not claimed by the creator).
(() => {
  const { W, P, ID, meta, readAccounts, readU64, tokenAccounts, valueInLamports, rpc, pda, enc, ata, short, b58 } = RC;
  const PUMP = P("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  const AMM = P("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const EV_PUMP = pda([enc("__event_authority")], PUMP)[0];
  const EV_AMM = pda([enc("__event_authority")], AMM)[0];
  const USDC = P("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), USDT = P("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
  const SYMBOL = { [b58(ID.WSOL)]: "SOL", [b58(USDC)]: "USDC", [b58(USDT)]: "USDT" };
  const D = {
    collect: Uint8Array.of(20, 22, 86, 123, 198, 28, 219, 132),       // collect_creator_fee
    collectV2: Uint8Array.of(207, 17, 138, 242, 4, 34, 19, 56),       // collect_creator_fee_v2
    collectAmm: Uint8Array.of(160, 57, 89, 42, 181, 139, 43, 66),     // collect_coin_creator_fee
    cashback: Uint8Array.of(37, 58, 35, 126, 190, 53, 228, 197),      // claim_cashback (both programs)
    cashbackV2: Uint8Array.of(122, 243, 204, 65, 94, 116, 29, 55),    // claim_cashback_v2
  };
  const pdaVault = pk => pda([enc("creator-vault"), pk.toBytes()], PUMP)[0];
  const pdaAmmAuth = pk => pda([enc("creator_vault"), pk.toBytes()], AMM)[0];

  // Accounts at fixed addresses, read once per scan and shared by the three categories.
  let cache = null;
  function fixed(pk) {
    if (cache && cache.pk.equals(pk) && Date.now() - cache.t < 20000) return cache.p;
    const k = {
      vault: pdaVault(pk),
      ammAuth: pdaAmmAuth(pk),
      uva: pda([enc("user_volume_accumulator"), pk.toBytes()], PUMP)[0],
      ammUva: pda([enc("user_volume_accumulator"), pk.toBytes()], AMM)[0],
    };
    const keys = [k.vault, k.uva, k.ammUva, ata(k.ammUva, ID.WSOL), ata(pk, ID.WSOL)];
    const p = (async () => {
      const [infos, c] = await Promise.all([readAccounts(keys), rpc()]);
      // Rent is linear in (128 + size); one call gives the rate for every size we need.
      const rent0 = await c.getMinimumBalanceForRentExemption(0), rent = n => Math.ceil(rent0 * (128 + n) / 128);
      const rent137 = rent(137), rent165 = rent(165), rent170 = rent(170);
      const acc = new Map(keys.map((key, i) => [b58(key), infos[i]]));
      return { k, acc, rent0, rent137, ataRent: tp => tp.equals(ID.TOKEN22) ? rent170 : rent165 };
    })();
    cache = { pk, t: Date.now(), p };
    p.catch(() => { cache = null; });
    return p;
  }

  // Raw amount of an SPL token account (Token or Token-2022), 0 if missing.
  const amountOf = info => info && (info.owner.equals(ID.TOKEN) || info.owner.equals(ID.TOKEN22)) && info.data.length >= 72
    ? readU64(info.data, 64) : 0n;
  const fmt = (raw, dec) => (Number(raw) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: Math.min(dec, 4) });
  const tokenText = (mint, raw, dec) => fmt(raw, dec) + " " + (SYMBOL[b58(mint)] || "tokens of " + short(mint));

  const createAta = (p, account, mint, tp) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(account, false, true), meta(p, false, false),
    meta(mint, false, false), meta(ID.SYSTEM, false, false), meta(tp, false, false)] });

  // One item whose claim instruction pays `raw` of `mint` into the wallet's ATA.
  // hasAta is read at scan time, so ixs(p) is deterministic.
  async function tokenItem({ pk, key, label, mint, tp, raw, dec, hasAta, ataRent, claim }) {
    const userAta = ata(pk, mint, tp);
    if (mint.equals(ID.WSOL)) {
      if (hasAta) return { key, value: Number(raw), label: label + " · " + tokenText(mint, raw, 9) + " (arrives as wSOL in your wSOL account)",
        ixs: p => [claim(p, userAta)] };
      return { key, value: Number(raw), label: label + " · " + tokenText(mint, raw, 9),
        ixs: p => [createAta(p, userAta, mint, tp), claim(p, userAta),
          new W.TransactionInstruction({ programId: tp, data: Uint8Array.of(9), keys: [   // close: unwrap to the wallet
            meta(userAta, false, true), meta(p, false, true), meta(p, true, false)] })] };
    }
    const worth = await valueInLamports([{ mint: b58(mint), amount: raw, decimals: dec }]);
    return { key, value: worth - (hasAta ? 0 : ataRent(tp)), label: label + " · " + tokenText(mint, raw, dec),
      ixs: hasAta ? p => [claim(p, userAta)] : p => [createAta(p, userAta, mint, tp), claim(p, userAta)] };
  }

  // A vault authority's canonical ATAs that hold a balance.
  async function vaultTokens(owner) {
    const out = [];
    for (const tp of [ID.TOKEN, ID.TOKEN22]) {
      for (const { pubkey, account } of await tokenAccounts(owner, tp)) {
        const info = account.data?.parsed?.info, mint = info && P(info.mint);
        if (!mint || !info.tokenAmount || info.tokenAmount.amount === "0" || !pubkey.equals(ata(owner, mint, tp))) continue;
        out.push({ account: pubkey, mint, tp, raw: BigInt(info.tokenAmount.amount), dec: info.tokenAmount.decimals });
      }
    }
    return out;
  }

  RC.registerSource({
    id: "pump-creator", title: "Pump.fun creator fees", group: "rewards", perTx: 4, programs: [PUMP, AMM],
    async scan(pk) {
      const [{ k, acc, rent0, ataRent }, pumpToks, ammToks] =
        await Promise.all([fixed(pk), vaultTokens(pdaVault(pk)), vaultTokens(pdaAmmAuth(pk))]);
      const items = [];
      const v = acc.get(b58(k.vault));
      if (v && v.owner.equals(ID.SYSTEM) && v.lamports > rent0) {
        items.push({ key: k.vault, value: v.lamports - rent0, label: "Pump.fun creator fees · " + fmt(v.lamports - rent0, 9) + " SOL",
          ixs: p => [new W.TransactionInstruction({ programId: PUMP, data: D.collect, keys: [
            meta(p, true, true),              // creator: receives the SOL
            meta(k.vault, false, true),       // creator vault PDA
            meta(ID.SYSTEM, false, false),
            meta(EV_PUMP, false, false),
            meta(PUMP, false, false)] })] });
      }
      // SOL-quoted Pump fees are the lamports above; a wSOL account under the Pump vault is not claimed here.
      const toks = [...pumpToks.filter(t => !t.mint.equals(ID.WSOL)).map(t => ({ ...t, amm: false })),
                    ...ammToks.map(t => ({ ...t, amm: true }))];
      const have = toks.length ? await readAccounts(toks.map(t => ata(pk, t.mint, t.tp))) : [];
      for (const [i, t] of toks.entries()) {
        items.push(await tokenItem({ pk, key: t.account, mint: t.mint, tp: t.tp, raw: t.raw, dec: t.dec, hasAta: !!have[i], ataRent,
          label: t.amm ? "PumpSwap creator fees" : "Pump.fun creator fees",
          claim: t.amm
            ? (p, userAta) => new W.TransactionInstruction({ programId: AMM, data: D.collectAmm, keys: [
                meta(t.mint, false, false),       // quote mint
                meta(t.tp, false, false),         // its token program
                meta(p, false, false),            // coin creator
                meta(k.ammAuth, false, false),    // creator vault authority PDA
                meta(t.account, false, true),     // vault ATA: emptied
                meta(userAta, false, true),       // the wallet's ATA: receives
                meta(EV_AMM, false, false),
                meta(AMM, false, false)] })
            : (p, userAta) => new W.TransactionInstruction({ programId: PUMP, data: D.collectV2, keys: [
                meta(p, true, true),              // creator
                meta(userAta, false, true),       // the wallet's ATA: receives
                meta(k.vault, false, true),       // creator vault PDA
                meta(t.account, false, true),     // vault ATA: emptied
                meta(t.mint, false, false),
                meta(t.tp, false, false),
                meta(ID.ATA, false, false),
                meta(ID.SYSTEM, false, false),
                meta(EV_PUMP, false, false),
                meta(PUMP, false, false)] }) }));
      }
      return { items: items.filter(i => i.value > 0).sort((a, b) => b.value - a.value) };
    },
  });

  // Token cashback of an accumulator: its canonical ATAs with a balance, each marked with whether the wallet
  // already has the matching ATA. Listed only when the accumulator says something is owed (saves requests).
  async function withUserAtas(pk, toks) {
    const have = toks.length ? await readAccounts(toks.map(t => ata(pk, t.mint, t.tp))) : [];
    return toks.map((t, i) => ({ ...t, hasAta: !!have[i] }));
  }

  RC.registerSource({
    id: "pump-cashback", title: "Pump.fun trading cashback", group: "rewards", perTx: 4, programs: [PUMP],
    async scan(pk) {
      const { k, acc, rent137, ataRent } = await fixed(pk);
      const u = acc.get(b58(k.uva)), items = [];
      if (!u || !u.owner.equals(PUMP) || u.data.length < 106) return { items };
      const owed = Number(readU64(u.data, 74) - readU64(u.data, 82));
      const value = Math.min(owed, u.lamports - rent137);
      if (value > 0) items.push({ key: k.uva, value, label: "Pump.fun cashback · " + fmt(value, 9) + " SOL",
        ixs: p => [new W.TransactionInstruction({ programId: PUMP, data: D.cashback, keys: [
          meta(p, true, true),              // user: receives the SOL
          meta(k.uva, false, true),         // user volume accumulator PDA
          meta(ID.SYSTEM, false, false),
          meta(EV_PUMP, false, false),
          meta(PUMP, false, false)] })] });
      // Cashback on token-quoted coins (stable_cashback_earned @90 > total_stable_cashback_claimed @98).
      const toks = readU64(u.data, 90) > readU64(u.data, 98)
        ? await withUserAtas(pk, (await vaultTokens(k.uva)).filter(t => !t.mint.equals(ID.WSOL))) : [];
      for (const t of toks) {
        items.push(await tokenItem({ pk, key: t.account, mint: t.mint, tp: t.tp, raw: t.raw, dec: t.dec, hasAta: t.hasAta, ataRent,
          label: "Pump.fun cashback",
          claim: (p, userAta) => new W.TransactionInstruction({ programId: PUMP, data: D.cashbackV2, keys: [
            meta(p, true, true),              // user
            meta(k.uva, false, true),         // user volume accumulator PDA
            meta(t.mint, false, false),       // quote mint
            meta(t.tp, false, false),         // its token program
            meta(ID.ATA, false, false),
            meta(t.account, false, true),     // accumulator's ATA: emptied
            meta(userAta, false, true),       // the wallet's ATA: receives
            meta(ID.SYSTEM, false, false),
            meta(EV_PUMP, false, false),
            meta(PUMP, false, false)] }) }));
      }
      return { items: items.filter(i => i.value > 0).sort((a, b) => b.value - a.value) };
    },
  });

  RC.registerSource({
    id: "pumpswap-cashback", title: "PumpSwap trading cashback", group: "rewards", perTx: 4, programs: [AMM],
    async scan(pk) {
      const { k, acc, ataRent } = await fixed(pk);
      const u = acc.get(b58(k.ammUva)), items = [];
      if (!u || !u.owner.equals(AMM) || u.data.length < 90) return { items };
      // wSOL cashback sits in a fixed ATA (read above); other quote mints are listed when cashback is owed.
      const wsolAta = ata(k.ammUva, ID.WSOL), wsolRaw = amountOf(acc.get(b58(wsolAta)));
      const toks = [];
      if (wsolRaw > 0n) toks.push({ account: wsolAta, mint: ID.WSOL, tp: ID.TOKEN, raw: wsolRaw, dec: 9, hasAta: !!acc.get(b58(ata(pk, ID.WSOL))) });
      if (readU64(u.data, 74) > readU64(u.data, 82))
        toks.push(...await withUserAtas(pk, (await vaultTokens(k.ammUva)).filter(t => !t.mint.equals(ID.WSOL))));
      for (const t of toks) {
        items.push(await tokenItem({ pk, key: t.account, mint: t.mint, tp: t.tp, raw: t.raw, dec: t.dec, hasAta: t.hasAta, ataRent,
          label: "PumpSwap cashback",
          claim: (p, userAta) => new W.TransactionInstruction({ programId: AMM, data: D.cashback, keys: [
            meta(p, true, true),              // user
            meta(k.ammUva, false, true),      // user volume accumulator PDA
            meta(t.mint, false, false),       // quote mint
            meta(t.tp, false, false),         // its token program
            meta(t.account, false, true),     // accumulator's ATA: emptied
            meta(userAta, false, true),       // the wallet's ATA: receives
            meta(ID.SYSTEM, false, false),
            meta(EV_AMM, false, false),
            meta(AMM, false, false)] }) }));
      }
      return { items: items.filter(i => i.value > 0).sort((a, b) => b.value - a.value) };
    },
  });
})();
