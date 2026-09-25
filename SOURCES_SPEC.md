# How to write a source module

Site: static page in `reclaim/` that scans a wallet and lets the OWNER withdraw SOL that already belongs to
them, signing in their own wallet. No fee, no backend, no program of our own. Each category is one file in
`sources/`, loaded after `web3.iife.min.js` and `core.js`. Read `core.js` (the `api` object) and the existing
`sources/solanart.js`, `sources/alpha.js`, `sources/tokens.js` first; copy their style (short header comment
explaining the account layout and the instruction, plain JS, no dependencies).

```js
"use strict";
// <Protocol>: what it holds, account layout, which instruction returns it and where the SOL goes.
(() => {
  const { W, P, ID, meta, gpa, readAccounts, disc, u64, pda, enc, ata, short, b58 } = RC;
  const PROG = P("...");
  RC.registerSource({
    id: "unique-id", title: "Human title", group: "escrow" | "rent" | "rewards" | "stake" | "burn",
    perTx: 6,                 // max items per transaction (size is also enforced automatically)
    programs: [PROG],         // EVERY program your instructions call besides System/Token/Token-2022/ATA/ComputeBudget
    defaultOn: true,          // false = opt-in (anything destructive, e.g. burning)
    async scan(pk, api) {     // pk = wallet PublicKey
      return { items: [{
        key: PublicKey,       // unique per item (account being closed/claimed)
        label: "short text",  // shown in the list
        value: 123,           // lamports (number) the wallet ends up with from this item; SOL-equivalent if unavoidable
        ixs: p => [TransactionInstruction, ...],  // p = wallet; MUST be deterministic (same bytes every call)
      }], note: "optional text shown under the category" };
    },
  });
})();
```

Token values
- `await RC.valueInLamports([{ mint, amount /* raw units, BigInt or number */, decimals }])` returns the SOL value
  (lamports) via Jupiter's price API; tokens with < $10k liquidity count as 0. Use it for rewards / fees paid in
  tokens: value = that estimate, and put the token amount in the label (e.g. "12.3 USDC + 0.01 SOL").
  If the whole value is 0 (worthless token), skip the item unless it also returns rent.

Payout check
- Every simulation also compares before/after snapshots: an item is dropped if lamports land in someone else's plain
  wallet or tokens land in a token account held by someone else's wallet. If a protocol itself pays its own fee to a
  fixed party out of the protocol's escrow (never out of the wallet), list those parties in `feePayees: [PublicKey]`
  on the item, with a comment saying why.

Rules
- Only instructions the wallet owner is entitled to sign; every lamport/token goes to the wallet `p` itself
  (or its own ATA). Never a transfer to anyone else, never a fee.
- `ixs(p)` must be pure and deterministic: `assertSafe` compares the signed transaction byte-for-byte with it.
  If you need a blockhash-dependent or async value, compute it inside `scan` and close over it.
- Instruction data: build with `Uint8Array` / `RC.cat`, `RC.u64`, `RC.disc("anchor_ix_name")` (async, 8 bytes).
  Do NOT use `SystemProgram.transfer` or anything relying on Node `Buffer` (the browser bundle breaks on it).
- Discovery: `RC.gpa(programId, filters, dataSlice?)` (memcmp/dataSize; works from the browser through Helium),
  `RC.readAccounts(keys)`, `RC.tokenAccounts(owner, programId)`, PDAs with `RC.pda([seeds], program)`.
  Keep request count modest (the page runs on free public RPCs): prefer 1–3 gpa calls per source.
- A source that throws is shown as "could not check"; don't swallow real errors silently.
- If a receiving ATA may not exist, add an idempotent create (ATA program, data `01`) paid by `p` into the same item.
- `value` must be honest: what the wallet actually receives (after rent of any account it has to create).

Verification (required before you report done)
1. Find at least one REAL mainnet wallet that currently has funds in your category (via gpa / on-chain data).
2. `node test/run.cjs <wallet> sources/<yourfile>.js` — must show items > 0, no ERROR, "assertSafe OK".
   The harness simulates every transaction on mainnet (sigVerify off); items whose simulation fails are dropped
   and reported in the note — so a real pass means `items > 0` with no "left out" note for them.
3. Also run it on a wallet with nothing in the category (should be 0 items, no error).
4. Report: the file, the wallets used, amounts found, any category you could not make work and why.
Do not edit core.js, app.js, index.html or other sources; ask in your report if core needs a change.
Never sign or send transactions; no private keys are involved anywhere.
