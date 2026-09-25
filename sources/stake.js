"use strict";
// Native stake accounts where this wallet is the withdraw authority (@44 in the account).
// Layout: state u32 @0 (1 = initialized, 2 = delegated), rent reserve u64 @4, staker @12, withdrawer @44,
// lockup unix time i64 @76, lockup epoch u64 @84, custodian @92; if delegated: deactivation epoch u64 @172.
// Withdraw (instruction 4, u64 amount) of the whole balance closes the account and pays the wallet.
// Only never-delegated or deactivated accounts are offered; one still cooling down fails simulation and is left out.
(() => {
  const { W, P, ID, meta, gpa, rpc, u32, u64, cat, short, b58 } = RC;
  const STAKE = P("Stake11111111111111111111111111111111111111");
  const NO_DEACTIVATION = 0xffffffffffffffffn;

  // One search per scan, shared by both stake sources.
  let cache = null;
  async function stakeAccounts(pk) {
    if (cache && cache.pk.equals(pk) && Date.now() - cache.t < 20000) return cache.v;
    const v = await Promise.all([
      gpa(STAKE, [{ dataSize: 200 }, { memcmp: { offset: 44, bytes: b58(pk) } }]),
      (await rpc()).getEpochInfo("confirmed"),
    ]);
    cache = { pk, t: Date.now(), v };
    return v;
  }

  RC.registerSource({
    id: "stake", title: "Deactivated stake accounts", group: "stake", perTx: 8, programs: [STAKE],
    async scan(pk) {
      const [found, epochInfo] = await stakeAccounts(pk);
      const now = BigInt(Math.floor(Date.now() / 1000)), epoch = BigInt(epochInfo.epoch);
      let active = 0, locked = 0;
      const items = [];
      for (const { pubkey, account: a } of found) {
        const d = a.data, v = new DataView(d.buffer, d.byteOffset, d.byteLength);
        const state = v.getUint32(0, true);
        if (state !== 1 && state !== 2) continue;
        if (v.getBigInt64(76, true) > now || v.getBigUint64(84, true) > epoch) { locked++; continue; }
        if (state === 2) {
          const deact = v.getBigUint64(172, true);
          if (deact === NO_DEACTIVATION || deact >= epoch) { active++; continue; }
        }
        const amount = a.lamports;
        items.push({ key: pubkey, value: amount, label: "stake " + short(pubkey) + (state === 1 ? " · never delegated" : " · deactivated"),
          ixs: p => [new W.TransactionInstruction({ programId: STAKE, data: cat(u32(4), u64(amount)), keys: [
            meta(pubkey, false, true),              // stake account: emptied and closed
            meta(p, false, true),                   // recipient: this wallet
            meta(ID.CLOCK, false, false),
            meta(ID.STAKE_HISTORY, false, false),
            meta(p, true, false)] })] });           // withdraw authority
      }
      const notes = [];
      if (active) notes.push(active + " stake account(s) are still active or cooling down — deactivate them in your wallet first, then come back after the epoch ends.");
      if (locked) notes.push(locked + " stake account(s) are under lockup.");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });

  // Active stake accounts collect extra lamports on top of the delegated stake (Jito MEV tips land there,
  // and top-ups sent to the account). That surplus can be withdrawn without touching the stake:
  // excess = balance − rent reserve (@4) − delegated stake (@156).
  RC.registerSource({
    id: "stake-excess", title: "Extra SOL on active stake accounts", group: "stake", perTx: 8, programs: [STAKE],
    async scan(pk) {
      const [found] = await stakeAccounts(pk);
      const items = [];
      for (const { pubkey, account: a } of found) {
        const d = a.data, v = new DataView(d.buffer, d.byteOffset, d.byteLength);
        if (v.getUint32(0, true) !== 2) continue;
        // only stake that is still delegated: a deactivating or deactivated account is withdrawn in full above
        if (v.getBigUint64(172, true) !== NO_DEACTIVATION) continue;
        const excess = BigInt(a.lamports) - v.getBigUint64(4, true) - v.getBigUint64(156, true);
        if (excess < 1000000n) continue;                     // under 0.001 SOL is not worth a transaction
        const amount = excess;
        items.push({ key: pubkey, value: Number(amount), label: "stake " + short(pubkey) + " · surplus above the delegated stake",
          ixs: p => [new W.TransactionInstruction({ programId: STAKE, data: cat(u32(4), u64(amount)), keys: [
            meta(pubkey, false, true), meta(p, false, true), meta(ID.CLOCK, false, false),
            meta(ID.STAKE_HISTORY, false, false), meta(p, true, false)] })] });
      }
      return { items: items.sort((a, b) => b.value - a.value) };
    },
  });
})();
