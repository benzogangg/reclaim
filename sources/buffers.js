"use strict";
// Program deploy buffers (BPF upgradeable loader) whose authority is this wallet.
// Layout: variant u32 @0 (1 = Buffer), authority option tag u8 @4, authority @5.
// Close (instruction 5) sends the buffer's whole balance to the wallet. Programs themselves are never touched.
(() => {
  const { W, P, meta, gpa, u32, short, b58 } = RC;
  const LOADER = P("BPFLoaderUpgradeab1e11111111111111111111111");

  RC.registerSource({
    id: "buffers", title: "Program deploy buffers", group: "rent", perTx: 20, programs: [LOADER],
    async scan(pk) {
      const found = await gpa(LOADER, [
        { memcmp: { offset: 0, bytes: "2UzHM" } },  // 01 00 00 00 = Buffer
        { memcmp: { offset: 4, bytes: "2" } },                                              // 01 = authority is set
        { memcmp: { offset: 5, bytes: b58(pk) } },
      ], { offset: 0, length: 0 });
      return { items: found.map(({ pubkey, account: a }) => ({
        key: pubkey, value: a.lamports, label: "buffer " + short(pubkey),
        ixs: p => [new W.TransactionInstruction({ programId: LOADER, data: u32(5), keys: [
          meta(pubkey, false, true),    // buffer: closed
          meta(p, false, true),         // recipient: this wallet
          meta(p, true, false)] })],    // buffer authority
      })).sort((a, b) => b.value - a.value) };
    },
  });
})();
