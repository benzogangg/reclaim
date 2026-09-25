"use strict";
// Larix (dead lending protocol, program 7Zb1bGi…). Only its mSOL and SRM reserves still pay out; every other
// reserve refuses withdrawals. A wallet holding Larix deposit tokens (cTokens) for those two reserves can redeem
// them itself:
//   RefreshReserve (data 18): reserve(w), the reserve's price oracle;
//   RedeemReserveCollateral (data 05 + amount u64): source cTokens(w), reserve(w), collateral mint(w),
//     liquidity supply(w), lending market, market authority, owner(signer), token program, destination(w).
// The destination is the wallet's own ATA for mSOL / SRM, created in the same item if missing. The amount
// received is measured by simulating the item during the scan (it depends on the reserve's exchange rate).
(() => {
  const { W, P, ID, meta, search, rpc, u64, cat, ata, short, b58 } = RC;
  const LARIX = P("7Zb1bGi32pfsrBkzWdqd4dFhUXwp5Nybr1zuaEwN34hy");
  const MARKET = P("5geyZJdffDBNoMqEbogbPvdgH9ue7NREobtW8M3C1qfe");
  const AUTH = P("BxnUi6jyYbtEEgkBq4bPLKzDpSfWVAzgyf3TF2jfC1my");
  const RESERVES = [
    { name: "mSOL", decimals: 9, reserve: P("GaX5diaQz7imMTeNYs5LPAHX6Hq1vKtxjBYzLkjXipMh"), cMint: P("y6rnvwa2fTBynxGPNo6oH94WhmRxKE96cieCtyCwQBi"),
      supply: P("EPP9puLRYdRYdN11XgLreTwscUnxXCkRnDQ2hvDcumuL"), mint: P("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"), oracle: P("7aRo8AYpnx2k2WKaYCkJgY7fgTVUeomQPkqQY3Apni2b") },
    { name: "SRM", decimals: 6, reserve: P("9xdoHwJr4tD2zj3QVpWrzafBKgLZUQWZ2UYPkqyAhQf6"), cMint: P("9yoGvCPSFqfgHCyyhb7iVQcNTscFbAqRTbn6XuGUi8xa"),
      supply: P("48nRGYwh2opu2LjnrR1rdQ8DGh1zN9YW9F5UVULY6AYD"), mint: P("SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt"), oracle: P("41qU3QVbNvJGJHRYS8zfNUrPJBUPQNtQD4DgABuPCeVH") },
  ];

  const redeemIxs = (r, src, amount) => p => {
    const dest = ata(p, r.mint);
    return [
      new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [   // create the wallet's ATA if missing
        meta(p, true, true), meta(dest, false, true), meta(p, false, false), meta(r.mint, false, false),
        meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] }),
      new W.TransactionInstruction({ programId: LARIX, data: Uint8Array.of(0x18), keys: [
        meta(r.reserve, false, true), meta(r.oracle, false, false)] }),
      new W.TransactionInstruction({ programId: LARIX, data: cat(Uint8Array.of(5), u64(amount)), keys: [
        meta(src, false, true),              // the wallet's cTokens: burned
        meta(r.reserve, false, true), meta(r.cMint, false, true), meta(r.supply, false, true),
        meta(MARKET, false, false), meta(AUTH, false, false),
        meta(p, true, false),                // owner of the cTokens
        meta(ID.TOKEN, false, false),
        meta(dest, false, true)] })];        // the wallet's mSOL / SRM account: receives the tokens
  };

  RC.registerSource({
    id: "larix", title: "Larix deposits (mSOL, SRM)", group: "escrow", perTx: 2, programs: [LARIX],
    async scan(pk) {
      const c = await rpc(), items = [];
      let failed = 0;
      for (const r of RESERVES) {
        const accs = await search(x => x.getParsedTokenAccountsByOwner(pk, { mint: r.cMint }, "confirmed")).then(v => v.value);
        for (const { pubkey, account } of accs) {
          const info = account.data?.parsed?.info;
          if (!info || info.state !== "initialized" || info.tokenAmount?.amount === "0") continue;
          const amount = BigInt(info.tokenAmount.amount), ixs = redeemIxs(r, pubkey, amount);
          // How much mSOL / SRM comes out: simulate and read the destination balance.
          const dest = ata(pk, r.mint);
          const before = await c.getTokenAccountBalance(dest, "confirmed").then(b => BigInt(b.value.amount)).catch(() => null);
          const { blockhash } = await c.getLatestBlockhash("confirmed");
          const msg = new W.TransactionMessage({ payerKey: pk, recentBlockhash: blockhash, instructions: ixs(pk) }).compileToLegacyMessage();
          const sim = await c.simulateTransaction(new W.VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true,
            commitment: "confirmed", accounts: { encoding: "base64", addresses: [b58(dest)] } }).catch(() => null);
          const post = sim?.value?.accounts?.[0];
          if (!sim || sim.value.err || !post) { failed++; continue; }
          const d = Uint8Array.from(atob(post.data[0]), ch => ch.charCodeAt(0));
          const got = new DataView(d.buffer).getBigUint64(64, true) - (before ?? 0n);
          const rent = before === null ? await c.getMinimumBalanceForRentExemption(165) : 0;
          const value = await RC.valueInLamports([{ mint: r.mint, amount: got, decimals: r.decimals }]) - rent;
          if (value <= 0) continue;
          items.push({ key: pubkey, value, ixs,
            label: "Larix " + r.name + " deposit · " + (Number(got) / 10 ** r.decimals).toLocaleString("en-US", { maximumFractionDigits: 4 }) + " " + r.name });
        }
      }
      return { items, note: failed ? failed + " Larix deposit(s) could not be simulated (for example the wallet has no SOL for the fee)." : "" };
    },
  });
})();
