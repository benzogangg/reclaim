"use strict";
// Token accounts owned by the wallet, SPL Token and Token-2022.
//  - empty accounts: CloseAccount (data 09) returns the rent deposit;
//  - wrapped SOL: CloseAccount on a native account returns its whole balance as plain SOL.
// Skipped: accounts with another close authority, frozen ones, and Token-2022 accounts with withheld fees.
(() => {
  const { W, ID, meta, tokenAccounts, short, b58 } = RC;

  let cache = null;   // both sources read the same accounts once per scan
  async function all(pk) {
    if (cache && cache.pk.equals(pk) && Date.now() - cache.t < 20000) return cache.list;
    const list = [];
    for (const programId of [ID.TOKEN, ID.TOKEN22])
      for (const { pubkey, account } of await tokenAccounts(pk, programId)) list.push({ pubkey, account, programId });
    cache = { pk, t: Date.now(), list };
    return list;
  }

  const closeIx = (programId, account) => p => [new W.TransactionInstruction({ programId, data: Uint8Array.of(9), keys: [
    meta(account, false, true),   // token account: closed
    meta(p, false, true),         // destination: this wallet
    meta(p, true, false)] })];    // owner

  function closable(info, pk) {
    if (!info || info.state !== "initialized") return false;
    if (info.closeAuthority && info.closeAuthority !== b58(pk)) return false;
    return !(info.extensions || []).some(e => e.extension === "transferFeeAmount" && Number(e.state?.withheldAmount) > 0);
  }

  RC.registerSource({
    id: "tokens", title: "Empty token accounts", group: "rent", perTx: 20,
    async scan(pk) {
      let skipped = 0;
      const items = [];
      for (const { pubkey, account, programId } of await all(pk)) {
        const info = account.data?.parsed?.info;
        if (!info || info.isNative || info.tokenAmount?.amount !== "0") continue;
        if (!closable(info, pk)) { skipped++; continue; }
        items.push({ key: pubkey, value: account.lamports, ixs: closeIx(programId, pubkey),
          label: (programId.equals(ID.TOKEN22) ? "Token-2022 · " : "") + "mint " + short(info.mint) });
      }
      return { items: items.sort((a, b) => b.value - a.value),
        note: skipped ? skipped + " empty account(s) skipped: frozen, another close authority, or withheld Token-2022 fees." : "" };
    },
  });

  RC.registerSource({
    id: "wsol", title: "Wrapped SOL", group: "rent", perTx: 20,
    async scan(pk) {
      const items = [];
      for (const { pubkey, account, programId } of await all(pk)) {
        const info = account.data?.parsed?.info;
        if (!info?.isNative || info.tokenAmount?.amount === "0" || !closable(info, pk)) continue;
        items.push({ key: pubkey, value: account.lamports, ixs: closeIx(programId, pubkey),
          label: "wSOL account " + short(pubkey) + " · unwraps to SOL" });
      }
      return { items };
    },
  });
})();
