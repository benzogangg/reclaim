"use strict";
// SOL and tokens stuck at the token-program level where the wallet is the owner or an authority.
// Layouts (SPL Token / Token-2022): mint = mint authority COption (tag u32 @0, key @4), supply u64 @36,
// decimals @44, freeze authority @46..82; token account = mint @0, owner @32, amount @64 … 165 bytes.
// Token-2022 extensions: account type byte @165 (1 mint, 2 account), then TLV entries from @166
// (type u16, length u16, value). Extension 1 TransferFeeConfig = config authority 32, withdraw-withheld
// authority 32, withheld u64 @64, two fee records; 2 TransferFeeAmount = withheld u64; 3 MintCloseAuthority = key.
//  - excess lamports: WithdrawExcessLamports (data 26, i.e. 38): source, destination, authority. Moves
//    everything above the rent-exempt minimum from a token account the wallet owns, or a mint whose mint
//    authority is the wallet, to the wallet. Token-2022 has it; so does SPL Token since it runs p-token
//    (checked by simulation on mainnet, 2026-09-24). Native (wSOL) accounts are not supported (tokens.js
//    unwraps them), empty closable accounts are left to tokens.js (closing returns everything).
//    Besides SOL sent to these accounts by mistake, this returns the difference left by the rent cut: the Rent
//    sysvar is now 5080 lamports/byte-year x 1 year (was 3480 x 2), so a classic token account holding the old
//    2 039 280 lamports has 550 840 above today's minimum (1 488 440). The account stays open with its tokens.
//  - closable mints: Token-2022 CloseAccount (data 09) on a mint with supply 0 whose MintCloseAuthority is the
//    wallet: the mint's whole balance goes to the wallet.
//  - withheld transfer fees (group rewards): mints whose withdraw-withheld authority is the wallet.
//    WithdrawWithheldTokensFromMint (1a 02: mint, destination, authority) + WithdrawWithheldTokensFromAccounts
//    (1a 03 n: mint, destination, authority, n source accounts) into the wallet's own ATA (created if missing).
//    Holders are found with one gpa per mint (mint @0 is indexed, only bytes 165.. are fetched); only priced
//    tokens are searched, top 3 mints, up to 5 items of 18 accounts each per mint.
//  - fee-blocked accounts: the wallet's empty Token-2022 accounts that cannot be closed only because fees are
//    still withheld in them. HarvestWithheldTokensToMint (1a 04: mint, accounts; anyone may call it) moves those
//    fees to the mint, where they always belonged to the fee authority, then CloseAccount returns the rent.
// Discovery: authority fields are not indexed by any RPC (Token-2022 has ~300M accounts), so mints are found
// through the wallet's own token accounts (empty ones included): creators usually keep an account of their mint.
// Mints the wallet has no token account for (e.g. burned Token-2022 NFTs it can close) are not found.
(() => {
  const { W, P, ID, meta, gpa, rpc, readAccounts, tokenAccounts, readU64, short, b58 } = RC;
  const MAX_FEE_MINTS = 3;      // mints whose fee-holding accounts are searched (one gpa each)
  const MAX_SOURCES = 18;       // source accounts per withdraw-from-accounts instruction (tx size)
  const MAX_BATCHES = 5;        // withdraw-from-accounts items per mint
  const MAX_EXCESS = 480;       // excess-lamport items per scan (20 transactions)
  const MAX_MINTS = 200;        // mints read per scan (getMultipleAccounts, 10 per request)

  // Plain reads have no retry in core; the free RPCs answer 429 often.
  async function retry(fn) {
    for (let n = 0; ; n++) {
      try { return await fn(); }
      catch (e) { if (n >= 4 || !/429|Too Many|rate.?limit|Failed to fetch/i.test(String(e?.message || e))) throw e; await RC.sleep(700 * (n + 1)); }
    }
  }
  const ix = (programId, data, keys) => new W.TransactionInstruction({ programId, data: Uint8Array.from(data), keys });
  const u16 = (d, o) => d[o] | (d[o + 1] << 8);
  const same = (d, o, pk) => { const k = pk.toBytes(); for (let i = 0; i < 32; i++) if (d[o + i] !== k[i]) return false; return true; };

  // Token-2022 TLV extensions after the account type byte at 165: {type: value bytes}. `from` = 1 for data
  // sliced at 165.
  function tlv(d, from = 166) {
    const out = {};
    if (!d) return out;
    for (let o = from; o + 4 <= d.length;) {
      const t = u16(d, o), n = u16(d, o + 2);
      if (t === 0 || o + 4 + n > d.length) break;
      out[t] = d.subarray(o + 4, o + 4 + n);
      o += 4 + n;
    }
    return out;
  }

  // One read per scan, shared by the three sources: token accounts, their mints, the rent function.
  let cache = null;
  function load(pk) {
    if (cache && cache.pk.equals(pk) && Date.now() - cache.t < 20000) return cache.p;
    const p = (async () => {
      const accounts = [];
      for (const programId of [ID.TOKEN, ID.TOKEN22])
        for (const { pubkey, account } of await tokenAccounts(pk, programId)) accounts.push({ pubkey, account, programId });
      // Token-2022 mints first: they are the only ones that can have fees or a close authority.
      const t22 = accounts.filter(a => a.programId.equals(ID.TOKEN22)), rest = accounts.filter(a => !a.programId.equals(ID.TOKEN22));
      const mints = [...new Set([...t22, ...rest].map(a => a.account.data?.parsed?.info?.mint).filter(Boolean))].slice(0, MAX_MINTS);
      const infos = await retry(() => readAccounts(mints.map(P)));
      const mint = new Map(mints.map((m, n) => [m, infos[n]]).filter(([, a]) => a));
      const r0 = await retry(async () => (await rpc()).getMinimumBalanceForRentExemption(0));
      return { accounts, mint, rent: n => r0 + n * (r0 / 128) };
    })();
    cache = { pk, t: Date.now(), p };
    p.catch(() => { if (cache && cache.p === p) cache = null; });
    return p;
  }

  const withdrawExcess = (programId, source) => p => [ix(programId, [38], [
    meta(source, false, true),   // token account or mint: keeps exactly its rent-exempt minimum
    meta(p, false, true),        // destination: this wallet
    meta(p, true, false)])];     // owner / mint authority

  // Empty accounts the wallet can close get everything back through tokens.js or token-fee-blocked below.
  const closedByTokens = (info, pk) => info.tokenAmount?.amount === "0" && info.state === "initialized"
    && (!info.closeAuthority || info.closeAuthority === b58(pk));

  function closableMint(d, pk) {
    if (!d || d.length <= 165 || d[165] !== 1 || readU64(d, 36) !== 0n) return false;
    const c = tlv(d)[3];
    return !!c && c.length >= 32 && same(c, 0, pk);
  }

  RC.registerSource({
    id: "token-excess", title: "SOL sitting in token accounts and mints", group: "rent", perTx: 24,
    async scan(pk) {
      const { accounts, mint, rent } = await load(pk);
      const items = [];
      for (const { pubkey, account, programId } of accounts) {
        const info = account.data?.parsed?.info, space = account.data?.space;
        if (!info || info.isNative || typeof space !== "number" || closedByTokens(info, pk)) continue;
        const extra = account.lamports - rent(space);
        if (extra > 0) items.push({ key: pubkey, value: extra, ixs: withdrawExcess(programId, pubkey),
          label: (programId.equals(ID.TOKEN22) ? "Token-2022 · " : "") + "token account " + short(pubkey) + " · mint " + short(info.mint) });
      }
      for (const [m, a] of mint) {
        const d = a.data;
        if (!d || d.length < 82 || u16(d, 0) !== 1 || !same(d, 4, pk)) continue;      // mint authority = wallet
        if (a.owner.equals(ID.TOKEN22) && closableMint(d, pk)) continue;               // token-mint-close takes it all
        const extra = a.lamports - rent(d.length);
        if (extra > 0) items.push({ key: P(m), value: extra, ixs: withdrawExcess(a.owner, P(m)),
          label: (a.owner.equals(ID.TOKEN22) ? "Token-2022 · " : "") + "mint " + short(m) + " (you are its mint authority)" });
      }
      items.sort((a, b) => b.value - a.value);
      const more = items.length - MAX_EXCESS;
      return { items: items.slice(0, MAX_EXCESS),
        note: (items.length ? "Solana lowered rent-exempt minimums; the difference can be taken out of accounts that stay open. " : "")
          + (more > 0 ? more + " more account(s) not listed; scan again after withdrawing." : "") };
    },
  });

  RC.registerSource({
    id: "token-mint-close", title: "Closable Token-2022 mints", group: "rent", perTx: 20,
    async scan(pk) {
      const { mint } = await load(pk);
      const items = [];
      for (const [m, a] of mint) {
        if (!a.owner.equals(ID.TOKEN22) || !closableMint(a.data, pk)) continue;
        items.push({ key: P(m), value: a.lamports, label: "mint " + short(m) + " · supply 0, you are its close authority",
          ixs: p => [ix(ID.TOKEN22, [9], [
            meta(P(m), false, true),    // mint: closed
            meta(p, false, true),       // destination: this wallet
            meta(p, true, false)])] }); // close authority
      }
      return { items };
    },
  });

  // Withheld fees in token accounts of a mint: one gpa on the mint (indexed offset 0), only the extension area.
  async function feeHolders(m) {
    const found = await gpa(ID.TOKEN22, [{ memcmp: { offset: 0, bytes: m } }, { memcmp: { offset: 165, bytes: "3" } }],
      { offset: 165, length: 64 });
    const out = [];
    for (const { pubkey, account } of found) {
      const e = tlv(account.data, 1)[2];
      if (e && e.length >= 8) { const w = readU64(e, 0); if (w > 0n) out.push({ pubkey, withheld: w }); }
    }
    return out.sort((a, b) => (b.withheld > a.withheld ? 1 : b.withheld < a.withheld ? -1 : 0));
  }

  RC.registerSource({
    id: "token-withheld-fees", title: "Token-2022 transfer fees you can withdraw", group: "rewards", perTx: 1,
    async scan(pk) {
      const { mint, rent } = await load(pk);
      const mine = [];
      for (const [m, a] of mint) {
        if (!a.owner.equals(ID.TOKEN22)) continue;
        const f = tlv(a.data)[1];
        if (f && f.length >= 72 && same(f, 32, pk)) mine.push({ m, withheld: readU64(f, 64), decimals: a.data[44] });
      }
      // Only tokens with a market price are worth a search; the ones with fees already in the mint first.
      const px = mine.length ? await RC.prices(mine.map(x => x.m)) : () => 0;
      const priced = mine.filter(x => px(x.m) > 0)
        .sort((a, b) => Number(b.withheld) / 10 ** b.decimals * px(b.m) - Number(a.withheld) / 10 ** a.decimals * px(a.m));
      const items = [];
      let more = 0;
      for (const x of priced.slice(0, MAX_FEE_MINTS)) {
        const mintPk = P(x.m), dest = RC.ata(pk, mintPk, ID.TOKEN22);
        const holders = (await feeHolders(x.m)).filter(h => !h.pubkey.equals(dest));
        const batches = [];
        for (let i = 0; i < holders.length && batches.length < MAX_BATCHES; i += MAX_SOURCES) batches.push(holders.slice(i, i + MAX_SOURCES));
        if (!batches.length && x.withheld > 0n) batches.push([]);
        more += holders.length - batches.reduce((s, b) => s + b.length, 0);
        if (!batches.length) continue;
        const [destInfo] = await retry(() => readAccounts([dest]));
        const createAta = p => ix(ID.ATA, [1], [
          meta(p, true, true), meta(dest, false, true), meta(p, false, false), meta(mintPk, false, false),
          meta(ID.SYSTEM, false, false), meta(ID.TOKEN22, false, false)]);                   // idempotent create of own ATA
        for (const [n, take] of batches.entries()) {
          const fromMint = n === 0 && x.withheld > 0n;
          const amount = (fromMint ? x.withheld : 0n) + take.reduce((s, h) => s + h.withheld, 0n);
          const worth = await RC.valueInLamports([{ mint: x.m, amount, decimals: x.decimals }]);
          // The first item pays for the ATA if it is new: 165 + type + immutable owner + fee amount = 182 bytes.
          const value = worth - (n === 0 && !destInfo ? Math.ceil(rent(182)) : 0);
          if (value <= 0) continue;
          const ui = Number(amount) / 10 ** x.decimals;
          items.push({ key: n === 0 ? mintPk : take[0].pubkey, value,
            label: ui.toLocaleString("en-US", { maximumFractionDigits: 6 }) + " of mint " + short(x.m) + " · withheld fees in "
              + [fromMint ? "the mint" : "", take.length ? take.length + " account(s)" : ""].filter(Boolean).join(" + "),
            ixs: p => {
              const out = [createAta(p)];
              if (fromMint) out.push(ix(ID.TOKEN22, [26, 2], [
                meta(mintPk, false, true), meta(dest, false, true), meta(p, true, false)]));    // from the mint
              if (take.length) out.push(ix(ID.TOKEN22, [26, 3, take.length], [
                meta(mintPk, false, false), meta(dest, false, true), meta(p, true, false),
                ...take.map(h => meta(h.pubkey, false, true))]));                                // from the accounts
              return out;
            } });
        }
      }
      const skipped = priced.length - Math.min(priced.length, MAX_FEE_MINTS);
      const notes = [];
      if (more) notes.push(more + " more fee-holding account(s) not included; scan again after withdrawing.");
      if (skipped) notes.push(skipped + " more fee mint(s) not checked; scan again after withdrawing.");
      return { items, note: notes.join(" ") };
    },
  });

  RC.registerSource({
    id: "token-fee-blocked", title: "Token-2022 accounts blocked by withheld fees", group: "rent", perTx: 10,
    async scan(pk) {
      const { accounts } = await load(pk);
      const items = [];
      for (const { pubkey, account, programId } of accounts) {
        const info = account.data?.parsed?.info;
        if (!programId.equals(ID.TOKEN22) || !info || info.isNative || info.tokenAmount?.amount !== "0" || info.state !== "initialized") continue;
        if (info.closeAuthority && info.closeAuthority !== b58(pk)) continue;
        const ext = info.extensions || [];
        if (!ext.some(e => e.extension === "transferFeeAmount" && Number(e.state?.withheldAmount) > 0)) continue;
        if (ext.some(e => /confidential/i.test(e.extension))) continue;
        const m = P(info.mint);
        items.push({ key: pubkey, value: account.lamports, label: "mint " + short(m) + " · fees go to the mint, account closes",
          ixs: p => [
            ix(ID.TOKEN22, [26, 4], [meta(m, false, true), meta(pubkey, false, true)]),   // harvest fees to the mint
            ix(ID.TOKEN22, [9], [meta(pubkey, false, true), meta(p, false, true), meta(p, true, false)])] });
      }
      return { items: items.sort((a, b) => b.value - a.value) };
    },
  });
})();
