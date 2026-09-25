"use strict";
// Burning leftover tokens: DESTROYS the whole balance and gives the token account's rent back to the wallet.
// Opt-in, every item starts unchecked. NFTs are never burned here: any single token (amount 1, 0 decimals),
// anything with a Metaplex edition and any Orca / Raydium / Meteora liquidity-position NFT is left alone.
//  - BurnChecked (data 0f + amount u64 + decimals) for the whole balance, then CloseAccount (data 09).
//  - Skipped: wrapped SOL (see tokens.js), USDC/USDT, balances worth more than the rent they free (Jupiter
//    price), frozen accounts, accounts with another close authority, Token-2022 accounts with withheld fees
//    or confidential balances.
(() => {
  const { W, P, ID, meta, gpa, rpc, readAccounts, tokenAccounts, u64, cat, pda, enc, short, b58 } = RC;
  const MPL = P("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  // Well-known tokens with real value are never offered for burning.
  const KEEP = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);

  const LP_PROGRAMS = [P("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"), P("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
                       P("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG")];
  const edPda = mint => pda([enc("metadata"), MPL.toBytes(), mint.toBytes(), enc("edition")], MPL)[0];

  // Both token sources share one read per scan: the wallet's token accounts, plus the Metaplex edition of
  // every single decimals-0 token that is not both frozen and delegated (those are skipped anyway).
  const info = x => x.account.data?.parsed?.info;
  const single = x => { const t = info(x)?.tokenAmount; return t && t.decimals === 0 && t.amount === "1"; };
  let cache = null;
  function load(pk) {
    if (cache && cache.pk.equals(pk) && Date.now() - cache.t < 20000) return cache.p;
    const p = (async () => {
      const list = [];
      for (const programId of [ID.TOKEN, ID.TOKEN22])
        for (const { pubkey, account } of await tokenAccounts(pk, programId)) list.push({ pubkey, account, programId });
      // Liquidity positions of Orca, Raydium CLMM and Meteora DAMM v2 are NFTs: burning one would destroy the
      // liquidity inside. Any single token whose ["position", mint] PDA exists in one of them is never offered.
      const singles = list.filter(single);
      const posKeys = singles.flatMap(x => LP_PROGRAMS.map(g => pda([enc("position"), P(info(x).mint).toBytes()], g)[0]));
      const pos = posKeys.length ? await readAccounts(posKeys) : [];
      const lp = new Set(singles.filter((x, n) => LP_PROGRAMS.some((g, k) => pos[n * LP_PROGRAMS.length + k]?.owner.equals(g))).map(x => b58(x.pubkey)));
      for (let n = list.length - 1; n >= 0; n--) if (lp.has(b58(list[n].pubkey))) list.splice(n, 1);
      const look = list.filter(x => single(x) && !(info(x).state === "frozen" && info(x).delegate));
      const eds = await readAccounts(look.map(x => edPda(P(info(x).mint))));
      const edition = new Map(look.map((x, n) => [b58(x.pubkey), eds[n]]).filter(([, e]) => e));
      return { list, edition };
    })();
    cache = { pk, t: Date.now(), p };
    p.catch(() => { if (cache && cache.p === p) cache = null; });
    return p;
  }

  const fmt = (amount, decimals) => {
    const s = amount.padStart(decimals + 1, "0"), int = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + frac.slice(0, 6) : "");
  };

  RC.registerSource({
    id: "burn-tokens", title: "Burn leftover tokens (destroys them)", group: "burn", perTx: 8, defaultOn: false,
    async scan(pk) {
      const { list, edition } = await load(pk);
      let skipped = 0;
      const items = [];
      for (const { pubkey, account, programId } of list) {
        const i = account.data?.parsed?.info, t = i?.tokenAmount;
        if (!i || i.isNative || !t || t.amount === "0" || KEEP.has(i.mint)) continue;
        if (single({ account }) || edition.has(b58(pubkey))) continue;   // anything that may be an NFT is never burned
        const ext = i.extensions || [];
        if (i.state !== "initialized" || (i.closeAuthority && i.closeAuthority !== b58(pk))
          || ext.some(e => e.extension === "confidentialTransferAccount"
            || (e.extension === "transferFeeAmount" && Number(e.state?.withheldAmount) > 0))) { skipped++; continue; }
        const mint = P(i.mint), amount = BigInt(t.amount), decimals = t.decimals;
        items.push({ key: pubkey, value: account.lamports, mint: i.mint, amount, decimals,
          label: "DESTROY " + fmt(t.amount, decimals) + " of " + (programId.equals(ID.TOKEN22) ? "Token-2022 " : "") + "mint " + short(mint)
            + " · closes account",
          ixs: p => [
            new W.TransactionInstruction({ programId, data: cat(Uint8Array.of(15), u64(amount), Uint8Array.of(decimals)), keys: [
              meta(pubkey, false, true),      // token account
              meta(mint, false, true),        // mint: supply goes down
              meta(p, true, false)] }),       // owner
            new W.TransactionInstruction({ programId, data: Uint8Array.of(9), keys: [
              meta(pubkey, false, true),      // token account: closed
              meta(p, false, true),           // destination: this wallet
              meta(p, true, false)] })] });   // owner
      }
      // Never offer to burn a balance that is worth more than the rent it gives back (Jupiter price, liquid tokens only).
      let valuable = 0;
      const worth = await Promise.all(items.map(it => RC.valueInLamports([{ mint: it.mint, amount: it.amount, decimals: it.decimals }])));
      let unpriced = 0;   // price could not be loaded: never offer it (a failed lookup is not "worthless")
      const cheap = items.filter((it, k) => {
        if (!RC.priceKnown(it.mint)) { unpriced++; return false; }
        if (worth[k] > it.value) { valuable++; return false; }
        return true;
      });
      return { items: cheap.sort((a, b) => b.value - a.value),
        note: "Burning permanently destroys these tokens (the whole balance) and returns the account rent. If a token "
          + "has value, swap or send it instead of burning. USDC and USDT are never listed."
          + (valuable ? " " + valuable + " token balance(s) worth more than their rent are not offered." : "")
          + (unpriced ? " " + unpriced + " token(s) not offered because their price could not be checked right now." : "")
          + (skipped ? " " + skipped + " account(s) not offered: frozen, another close authority, or Token-2022 fees/confidential balance." : "") };
    },
  });

})();
