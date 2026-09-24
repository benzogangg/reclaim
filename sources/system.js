"use strict";
// Native Solana accounts a wallet controls as authority:
//  - address lookup tables (lookup-table program): deactivation slot u64 @4, authority option tag @21, key @22.
//    CloseLookupTable (ix 4) works once a table has been deactivated and cooled down (~513 slots, a few minutes);
//    active tables can be deactivated here (ix 3) as an opt-in first step;
//  - vote accounts (validators): authorized withdrawer @36. Withdraw (ix 3) of everything above the rent reserve.
(() => {
  const { W, P, ID, meta, gpa, rpc, u32, u64, cat, short, b58 } = RC;
  const ALT = P("AddressLookupTab1e1111111111111111111111111");
  const VOTE = P("Vote111111111111111111111111111111111111111");
  const NEVER = 0xffffffffffffffffn;
  const COOLDOWN = 513n;                           // slots a deactivated table must wait before it can be closed

  let altCache = null;
  async function tables(pk) {
    if (altCache && altCache.pk.equals(pk) && Date.now() - altCache.t < 20000) return altCache.v;
    const v = await Promise.all([
      gpa(ALT, [{ memcmp: { offset: 21, bytes: "2" } }, { memcmp: { offset: 22, bytes: b58(pk) } }], { offset: 0, length: 22 }),
      (await rpc()).getSlot("confirmed"),
    ]);
    altCache = { pk, t: Date.now(), v };
    return v;
  }
  const deactivation = a => new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(4, true);

  RC.registerSource({
    id: "alt-close", title: "Address lookup tables", group: "rent", perTx: 10, programs: [ALT],
    async scan(pk) {
      const [found, slot] = await tables(pk);
      const waiting = found.filter(x => { const d = deactivation(x.account); return d !== NEVER && BigInt(slot) <= d + COOLDOWN; }).length;
      return { note: waiting ? waiting + " deactivated table(s) are still cooling down; they can be closed in a few minutes." : "",
        items: found.filter(x => { const d = deactivation(x.account); return d !== NEVER && BigInt(slot) > d + COOLDOWN; })
          .map(({ pubkey, account: a }) => ({ key: pubkey, value: a.lamports, label: "lookup table " + short(pubkey),
            ixs: p => [new W.TransactionInstruction({ programId: ALT, data: u32(4), keys: [
              meta(pubkey, false, true),        // table: closed
              meta(p, true, false),             // authority
              meta(p, false, true)] })] })) };  // recipient: this wallet
    },
  });

  RC.registerSource({
    id: "alt-deactivate", title: "Active lookup tables — step 1: deactivate", group: "rent", perTx: 15, programs: [ALT],
    defaultOn: false, allowZero: true,
    async scan(pk) {
      const [found] = await tables(pk);
      const active = found.filter(x => deactivation(x.account) === NEVER);
      return { note: active.length ? "Deactivating returns nothing yet: after a few minutes, check again and close the tables to get "
          + (active.reduce((s, x) => s + x.account.lamports, 0) / 1e9).toFixed(4) + " SOL back. Only do this for tables you no longer use." : "",
        items: active.map(({ pubkey, account: a }) => ({ key: pubkey, value: 0,
          label: "lookup table " + short(pubkey) + " · frees " + (a.lamports / 1e9).toFixed(4) + " SOL later",
          ixs: p => [new W.TransactionInstruction({ programId: ALT, data: u32(3), keys: [
            meta(pubkey, false, true), meta(p, true, false)] })] })) };
    },
  });

  RC.registerSource({
    id: "vote", title: "Validator vote account balance", group: "stake", perTx: 6, programs: [VOTE],
    async scan(pk) {
      const found = await gpa(VOTE, [{ memcmp: { offset: 36, bytes: b58(pk) } }], { offset: 0, length: 0 });
      if (!found.length) return { items: [] };
      const c = await rpc(), infos = await c.getMultipleAccountsInfo(found.map(x => x.pubkey), { dataSlice: { offset: 0, length: 0 } });
      const items = [];
      for (let i = 0; i < found.length; i++) {
        const acc = infos[i]; if (!acc) continue;
        const size = (await c.getAccountInfo(found[i].pubkey, { dataSlice: { offset: 0, length: 0 } }))?.space ?? 3762;
        const reserve = await c.getMinimumBalanceForRentExemption(size);
        const amount = acc.lamports - reserve;
        if (amount < 1000000) continue;
        const key = found[i].pubkey;
        items.push({ key, value: amount, label: "vote account " + short(key) + " · keeps its rent reserve",
          ixs: p => [new W.TransactionInstruction({ programId: VOTE, data: cat(u32(3), u64(amount)), keys: [
            meta(key, false, true), meta(p, false, true), meta(p, true, false)] })] });
      }
      return { items };
    },
  });
})();
