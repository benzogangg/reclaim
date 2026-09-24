"use strict";
// Creator / LP trading fees that sit unclaimed in Raydium and Meteora pools. Payouts land in the wallet's
// own ATAs (created in the same item if missing). A wSOL ATA the item had to create is closed again right
// after the claim, so SOL arrives as plain SOL; an ATA created here that receives nothing is closed too.
// Value = SOL + other tokens priced by RC.valueInLamports, minus rent of any ATA that has to stay open.
//  - Raydium LaunchLab: creator fee vault = token account PDA [creator, quote_mint] (checked for wSOL, USD1,
//    USDC). claim_creator_fee accounts: creator, vault authority PDA "creator_fee_vault_auth_seed", vault,
//    creator ATA, quote mint, token program, system, ATA program.
//  - Raydium CPMM: PoolState (637 bytes) has pool_creator @40, vaults @72/@104, mints @168/@200, token
//    programs @232/@264, decimals @331/@332, creator_fees_token_0/1 @397/@405; collect_creator_fee.
//  - Meteora DBC: VirtualPool (424 bytes) has config @72, creator @104, base mint @136, vaults @168/@200,
//    creator_base_fee/creator_quote_fee @352/@360; the config holds the
//    quote mint @8. Token programs and decimals come from the mint accounts. claim_creator_trading_fee(max_base, max_quote).
//  - Meteora DAMM v2: position PDA ["position", nft_mint] (408 bytes): pool @8, fee checkpoints (u256) @72/@104,
//    fee pending @136/@144, liquidity (3 × u128) @152. Pool: mints @168/@200, vaults @232/@264,
//    fee_per_liquidity (u256) @488/@520. Whoever holds the position NFT calls claim_position_fee;
//    pending fee = fee_pending + liquidity * (fee_per_liquidity - checkpoint) >> 128.
(() => {
  const { W, P, ID, meta, gpa, readAccounts, tokenAccounts, disc, u64, cat, pda, enc, ata, short, b58, readU64,
    prices, valueInLamports } = RC;
  const LAUNCH = P("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
  const CPMM = P("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
  const DBC = P("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
  const DAMM = P("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
  const USDC = P("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), USD1 = P("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB");
  const MAX = "18446744073709551615";
  const MIN = 100000;   // lamports; smaller claims are not worth a transaction
  const ATA_RENT = { [b58(ID.TOKEN)]: 2039280, [b58(ID.TOKEN22)]: 2200000 };   // Token-2022: conservative

  const pk32 = (d, o) => new W.PublicKey(d.slice(o, o + 32));
  const tokenAmount = d => (d && d.length >= 72 ? readU64(d, 64) : 0n);
  const ui = (n, dec) => (Number(n) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dec > 4 ? 4 : dec });
  const NAMES = { [b58(ID.WSOL)]: "SOL", [b58(USDC)]: "USDC", [b58(USD1)]: "USD1" };
  const amountText = parts => parts.filter(x => x.amount > 0n)
    .map(x => ui(x.amount, x.decimals) + " " + (NAMES[b58(x.mint)] || "of token " + short(x.mint))).join(" + ");

  const createAta = (p, mint, prog) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(p, mint, prog), false, true), meta(p, false, false),
    meta(mint, false, false), meta(ID.SYSTEM, false, false), meta(prog, false, false)] });
  const closeAcc = (p, acct, prog) => new W.TransactionInstruction({ programId: prog, data: Uint8Array.of(9), keys: [
    meta(acct, false, true), meta(p, false, true), meta(p, true, false)] });

  // Receiving side for one mint: the wallet's ATA, created if missing, closed again if it was created here and
  // ends up holding only wSOL (unwrap) or nothing. An ATA created here that keeps tokens costs its rent.
  function receiver(pk, mint, prog, exists, amount) {
    const close = !exists && (mint.equals(ID.WSOL) || amount === 0n);
    return {
      pre: p => exists ? [] : [createAta(p, mint, prog)],
      post: p => close ? [closeAcc(p, ata(p, mint, prog), prog)] : [],
      cost: !exists && !close ? ATA_RENT[b58(prog)] || 2200000 : 0 };
  }
  const exists = async keys => (await readAccounts(keys)).map(a => !!a);
  // Decimals and owning token program of each mint, read from the mint accounts.
  const mintInfo = async mints => {
    const keys = [...new Set(mints.map(b58))], accs = await readAccounts(keys.map(P));
    return new Map(keys.map((k, i) => [k, accs[i] ? { dec: accs[i].data[44], prog: accs[i].owner } : null]));
  };
  // Value of one claim: token worth (SOL counted as is) minus rent that stays locked.
  async function worth(parts, receivers) {
    const v = await valueInLamports(parts.filter(x => x.amount > 0n));
    return v - receivers.reduce((s, r) => s + r.cost, 0);
  }
  const noteFor = (n, where) => n ? n + " more with fees worth under 0.0001 SOL after the rent of any token account they need (or unpriced "
    + "tokens) are not listed; claim them on " + where + "." : "";

  // ---------- Raydium LaunchLab ----------
  RC.registerSource({
    id: "raydium-launchlab", title: "Raydium LaunchLab creator fees", group: "rewards", perTx: 6, programs: [LAUNCH],
    async scan(pk) {
      const auth = pda([enc("creator_fee_vault_auth_seed")], LAUNCH)[0];
      const mints = [ID.WSOL, USD1, USDC];   // quote mints LaunchLab uses; all SPL Token, 9 / 6 / 6 decimals
      const dec = [9, 6, 6];
      const vaults = mints.map(m => pda([pk.toBytes(), m.toBytes()], LAUNCH)[0]);
      const accs = await readAccounts([...vaults, ...mints.map(m => ata(pk, m))]);
      const D = await disc("claim_creator_fee");
      await prices(mints);
      const items = [];
      let skipped = 0;
      for (let i = 0; i < mints.length; i++) {
        const amount = tokenAmount(accs[i]?.data);
        if (amount === 0n) continue;
        const m = mints[i], v = vaults[i], r = receiver(pk, m, ID.TOKEN, !!accs[3 + i], amount);
        const part = { mint: m, amount, decimals: dec[i] }, value = await worth([part], [r]);
        if (value < MIN) { skipped++; continue; }
        items.push({ key: v, value, label: "creator fees " + amountText([part]) + " · vault " + short(v),
          ixs: p => [...r.pre(p), new W.TransactionInstruction({ programId: LAUNCH, data: D, keys: [
            meta(p, true, true),                 // creator: signs
            meta(auth, false, false),            // fee vault authority PDA
            meta(v, false, true),                // creator fee vault [creator, quote mint]
            meta(ata(p, m), false, true),        // recipient: the wallet's ATA
            meta(m, false, false), meta(ID.TOKEN, false, false),
            meta(ID.SYSTEM, false, false), meta(ID.ATA, false, false)] }), ...r.post(p)] });
      }
      return { items: items.sort((a, b) => b.value - a.value), note: noteFor(skipped, "raydium.io / bonk.fun") };
    },
  });

  // ---------- Raydium CPMM ----------
  RC.registerSource({
    id: "raydium-cpmm", title: "Raydium CPMM pool creator fees", group: "rewards", perTx: 3, programs: [CPMM],
    async scan(pk) {
      const pools = await gpa(CPMM, [{ dataSize: 637 }, { memcmp: { offset: 40, bytes: b58(pk) } }]);
      const found = pools.map(({ pubkey, account }) => {
        const d = account.data;
        return { pool: pubkey, cfg: pk32(d, 8), v0: pk32(d, 72), v1: pk32(d, 104), m0: pk32(d, 168), m1: pk32(d, 200),
          p0: pk32(d, 232), p1: pk32(d, 264), dec0: d[331], dec1: d[332], f0: readU64(d, 397), f1: readU64(d, 405) };
      }).filter(x => x.f0 > 0n || x.f1 > 0n);
      if (!found.length) return { items: [] };
      const auth = pda([enc("vault_and_lp_mint_auth_seed")], CPMM)[0];
      const D = await disc("collect_creator_fee");
      const has = await exists(found.flatMap(x => [ata(pk, x.m0, x.p0), ata(pk, x.m1, x.p1)]));
      await prices(found.flatMap(x => [x.m0, x.m1]));
      const items = [];
      let skipped = 0;
      for (const [i, x] of found.entries()) {
        const r0 = receiver(pk, x.m0, x.p0, has[2 * i], x.f0), r1 = receiver(pk, x.m1, x.p1, has[2 * i + 1], x.f1);
        const parts = [{ mint: x.m0, amount: x.f0, decimals: x.dec0 }, { mint: x.m1, amount: x.f1, decimals: x.dec1 }];
        const value = await worth(parts, [r0, r1]);
        if (value < MIN) { skipped++; continue; }
        items.push({ key: x.pool, value, label: "pool " + short(x.pool) + " · " + amountText(parts),
          ixs: p => [...r0.pre(p), ...r1.pre(p), new W.TransactionInstruction({ programId: CPMM, data: D, keys: [
            meta(p, true, true),              // pool creator: signs
            meta(auth, false, false),         // vault authority PDA
            meta(x.pool, false, true),        // pool state
            meta(x.cfg, false, false),        // amm config
            meta(x.v0, false, true), meta(x.v1, false, true),
            meta(x.m0, false, false), meta(x.m1, false, false),
            meta(ata(p, x.m0, x.p0), false, true), meta(ata(p, x.m1, x.p1), false, true),   // the wallet's ATAs
            meta(x.p0, false, false), meta(x.p1, false, false),
            meta(ID.ATA, false, false), meta(ID.SYSTEM, false, false)] }), ...r0.post(p), ...r1.post(p)] });
      }
      return { items: items.sort((a, b) => b.value - a.value), note: noteFor(skipped, "raydium.io") };
    },
  });

  // ---------- Meteora Dynamic Bonding Curve ----------
  RC.registerSource({
    id: "meteora-dbc", title: "Meteora bonding curve creator fees", group: "rewards", perTx: 3, programs: [DBC],
    async scan(pk) {
      const pools = await gpa(DBC, [{ dataSize: 424 }, { memcmp: { offset: 104, bytes: b58(pk) } }]);
      const found = pools.map(({ pubkey, account }) => {
        const d = account.data;
        return { pool: pubkey, cfg: pk32(d, 72), baseMint: pk32(d, 136), baseVault: pk32(d, 168), quoteVault: pk32(d, 200),
          fb: readU64(d, 352), fq: readU64(d, 360) };
      }).filter(x => x.fb > 0n || x.fq > 0n);
      if (!found.length) return { items: [] };
      const cfgKeys = [...new Set(found.map(x => b58(x.cfg)))].map(P);
      const cfgs = new Map((await readAccounts(cfgKeys)).map((a, i) => [b58(cfgKeys[i]), a?.data]));
      const ok = found.filter(x => {
        const c = cfgs.get(b58(x.cfg));
        if (!c) return false;   // config missing: cannot build the claim
        x.quoteMint = pk32(c, 8);
        return true;
      });
      const mi = await mintInfo(ok.flatMap(x => [x.baseMint, x.quoteMint]));
      for (const x of ok) {
        const b = mi.get(b58(x.baseMint)), q = mi.get(b58(x.quoteMint));
        x.baseProg = b?.prog; x.baseDec = b?.dec; x.quoteProg = q?.prog; x.quoteDec = q?.dec;
      }
      const has = await exists(ok.flatMap(x => [ata(pk, x.baseMint, x.baseProg), ata(pk, x.quoteMint, x.quoteProg)]));
      await prices(ok.flatMap(x => [x.baseMint, x.quoteMint]));
      const D = cat(await disc("claim_creator_trading_fee"), u64(MAX), u64(MAX));
      const auth = pda([enc("pool_authority")], DBC)[0], evt = pda([enc("__event_authority")], DBC)[0];
      const items = [];
      let skipped = found.length - ok.length;
      for (const [i, x] of ok.entries()) {
        const rb = receiver(pk, x.baseMint, x.baseProg, has[2 * i], x.fb);
        const rq = receiver(pk, x.quoteMint, x.quoteProg, has[2 * i + 1], x.fq);
        if (!x.baseProg || !x.quoteProg) { skipped++; continue; }
        const parts = [{ mint: x.quoteMint, amount: x.fq, decimals: x.quoteDec },
                       { mint: x.baseMint, amount: x.fb, decimals: x.baseDec }];
        const value = await worth(parts, [rb, rq]);
        if (value < MIN) { skipped++; continue; }
        items.push({ key: x.pool, value, label: "pool " + short(x.pool) + " · " + amountText(parts),
          ixs: p => [...rb.pre(p), ...rq.pre(p), new W.TransactionInstruction({ programId: DBC, data: D, keys: [
            meta(auth, false, false),                             // pool authority PDA
            meta(x.pool, false, true),                            // virtual pool
            meta(ata(p, x.baseMint, x.baseProg), false, true),    // the wallet's base token ATA
            meta(ata(p, x.quoteMint, x.quoteProg), false, true),  // the wallet's quote token ATA
            meta(x.baseVault, false, true), meta(x.quoteVault, false, true),
            meta(x.baseMint, false, false), meta(x.quoteMint, false, false),
            meta(p, true, false),                                 // creator: signs
            meta(x.baseProg, false, false), meta(x.quoteProg, false, false),
            meta(evt, false, false), meta(DBC, false, false)] }), ...rb.post(p), ...rq.post(p)] });
      }
      return { items: items.sort((a, b) => b.value - a.value), note: noteFor(skipped, "meteora.ag") };
    },
  });

  // ---------- Meteora DAMM v2 positions ----------
  const u256 = (d, o) => { let v = 0n; for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; };
  const u128 = (d, o) => (readU64(d, o + 8) << 64n) | readU64(d, o);

  RC.registerSource({
    id: "meteora-damm-v2", title: "Meteora DAMM v2 position fees", group: "rewards", perTx: 3, programs: [DAMM],
    async scan(pk) {
      const nfts = (await tokenAccounts(pk, ID.TOKEN22)).filter(({ account }) => {
        const i = account.data?.parsed?.info;
        return i && i.tokenAmount?.amount === "1" && i.tokenAmount?.decimals === 0;
      }).map(({ pubkey, account }) => ({ nftAcc: pubkey, mint: P(account.data.parsed.info.mint) }));
      if (!nfts.length) return { items: [] };
      const posKeys = nfts.map(n => pda([enc("position"), n.mint.toBytes()], DAMM)[0]);
      const posAccs = await readAccounts(posKeys);
      const pos = [];
      posAccs.forEach((a, i) => {
        if (!a || !a.owner.equals(DAMM) || a.data.length !== 408) return;
        const d = a.data;
        pos.push({ ...nfts[i], position: posKeys[i], pool: pk32(d, 8), cpA: u256(d, 72), cpB: u256(d, 104),
          pendA: readU64(d, 136), pendB: readU64(d, 144), liq: u128(d, 152) + u128(d, 168) + u128(d, 184) });
      });
      if (!pos.length) return { items: [] };
      const poolKeys = [...new Set(pos.map(x => b58(x.pool)))].map(P);
      const pools = new Map((await readAccounts(poolKeys)).map((a, i) => [b58(poolKeys[i]), a?.data]));
      let cand = [];
      for (const x of pos) {
        const d = pools.get(b58(x.pool));
        if (!d) continue;
        const fA = x.pendA + (((u256(d, 488) - x.cpA) * x.liq) >> 128n);
        const fB = x.pendB + (((u256(d, 520) - x.cpB) * x.liq) >> 128n);
        if (fA === 0n && fB === 0n) continue;
        cand.push({ ...x, mA: pk32(d, 168), mB: pk32(d, 200), vA: pk32(d, 232), vB: pk32(d, 264), fA, fB });
      }
      if (!cand.length) return { items: [] };
      const mi = await mintInfo(cand.flatMap(x => [x.mA, x.mB]));
      for (const x of cand) {
        const a = mi.get(b58(x.mA)), b = mi.get(b58(x.mB));
        x.pA = a?.prog; x.pB = b?.prog; x.dA = a?.dec; x.dB = b?.dec;
      }
      let skipped = cand.length;
      cand = cand.filter(x => x.pA && x.pB);
      skipped -= cand.length;
      const has = await exists(cand.flatMap(x => [ata(pk, x.mA, x.pA), ata(pk, x.mB, x.pB)]));
      await prices(cand.flatMap(x => [x.mA, x.mB]));
      const D = await disc("claim_position_fee");
      const auth = pda([enc("pool_authority")], DAMM)[0], evt = pda([enc("__event_authority")], DAMM)[0];
      const items = [];
      for (const [i, x] of cand.entries()) {
        const ra = receiver(pk, x.mA, x.pA, has[2 * i], x.fA), rb = receiver(pk, x.mB, x.pB, has[2 * i + 1], x.fB);
        const parts = [{ mint: x.mA, amount: x.fA, decimals: x.dA }, { mint: x.mB, amount: x.fB, decimals: x.dB }];
        const value = await worth(parts, [ra, rb]);
        if (value < MIN) { skipped++; continue; }
        items.push({ key: x.position, value, label: "position " + short(x.position) + " · " + amountText(parts),
          ixs: p => [...ra.pre(p), ...rb.pre(p), new W.TransactionInstruction({ programId: DAMM, data: D, keys: [
            meta(auth, false, false),                       // pool authority PDA
            meta(x.pool, false, false),
            meta(x.position, false, true),
            meta(ata(p, x.mA, x.pA), false, true), meta(ata(p, x.mB, x.pB), false, true),   // the wallet's ATAs
            meta(x.vA, false, true), meta(x.vB, false, true),
            meta(x.mA, false, false), meta(x.mB, false, false),
            meta(x.nftAcc, false, false),                   // the wallet's position NFT account
            meta(p, true, false),                           // NFT holder: signs
            meta(x.pA, false, false), meta(x.pB, false, false),
            meta(evt, false, false), meta(DAMM, false, false)] }), ...ra.post(p), ...rb.post(p)] });
      }
      return { items: items.sort((a, b) => b.value - a.value), note: noteFor(skipped, "meteora.ag") };
    },
  });
})();
