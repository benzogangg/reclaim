"use strict";
// Wound-down protocols, part 2: Saber LP (and other tokens) staked through Quarry wrapper programs, where the
// Quarry miner belongs to a program account and not to the wallet itself. Direct Quarry miners and LP held in
// the wallet are in wound-down.js / legacy-farms.js; this file only covers the wrappers.
//
// Sunny aggregator (SPQR4k…, Anchor, IDL on chain). Sunny is gone; the program still runs.
//   Pool 329 bytes: creator @8, quarry (Saber quarry of the LP) @40, bump @72, rewarder (Saber) @73, rewards mint @105,
//     vendor mint (Saber LP) @137, internal mint (Sunny IOU) @169, admin @201, pending admin @233,
//     fees: claim @265, vendor @273, withdraw @281 (u64 "mega-bps", 1e10 = 100%; withdraw fee is 0 in every pool).
//   Vault 97 bytes, PDA ["SunnyQuarryVault", pool, owner]: pool @8, owner @40, bump @72, index @73,
//     vendor balance @81 (LP staked in the Saber quarry), internal balance @89 (IOU staked in the Sunny quarry).
//   The vault owns two Quarry miners: vendor miner PDA ["Miner", pool.quarry, vault] and internal miner
//   PDA ["Miner", Quarry ["Quarry", Sunny rewarder 97PmYb…, internal mint], vault]; its token accounts are its ATAs.
//   Withdrawal (account order copied from mainnet tx 4tYcMNpM…, 2026-09): unstake_internal(amount) burns the IOU,
//   withdraw_vendor(amount) moves the LP from the Saber miner into the vault's LP account, withdraw_from_vault
//   sends that whole account to the owner's LP account (fee account = pool's LP ATA, fee 0).
// Quarry merge-mine (QMMD16…, Anchor, IDL on chain): MergePool 225 bytes, PDA ["MergePool", primary mint]:
//   primary mint @8, bump @40, replica mint @41. MergeMiner 97 bytes, PDA ["MergeMiner", pool, owner]: pool @8,
//   owner @40, bump @72, index @73, primary balance @81, replica balance @89. Its miners: primary miners (quarries of
//   the primary mint) and replica miners (quarries of the pool's replica mint, which it mints to itself).
//   Withdrawal (order copied from mainnet tx 2pzwVqd4…, 2026-09): unstake_all_replica_miner for every replica
//   miner (burns the replica tokens; required before the primary can move), unstake_primary_miner(amount) into the
//   merge miner's primary ATA, withdraw_tokens sends that ATA's whole balance to the owner's ATA.
// Quarry (QMNeHC…): Quarry 140 bytes: rewarder @8, staked mint @40. Miner 145 bytes: token vault @73, balance @129.
//   A paused rewarder makes the withdrawal fail; the simulation then drops the item.
// When the staked token is a Saber LP, the same item also withdraws the pool liquidity (Saber withdraw, data 03,
// minimums 0: a balanced withdrawal pays exact pro-rata shares) if everything fits in one transaction; otherwise
// the LP lands in the wallet and "Saber & Mercurial pool shares" (wound-down.js) takes it out on the next scan.
// Value = pro-rata reserves (Saber LP) or the token itself, at Jupiter prices, minus rent of new token accounts.
// Checked and left out: Ratio Finance (RFLeG…) and Parasol (PFo38…) miners hold LP as loan collateral / NFT
// deposits, not plain stakes; a few unidentified wrappers hold under $1k in total.
//
// Dead stablecoins:
// UXD (UXD8m9…, Anchor, IDL on chain): `redeem(amount)` burns UXD and pays USDC out of the protocol's depositories
//   (identity, Mercurial vault, Credix LP; split by the controller's weights; redeem fee ≤ 5 bps). Every account
//   except the wallet's two token accounts is a fixed protocol account (controller 3tbJcX…, depositories and their
//   vaults below). Order as in the IDL / mainnet redeems. The controller's per-epoch outflow limit can make a very
//   large redeem fail; the simulation then drops it. Value = UXD amount as USDC minus the largest redeem fee.
// Hubble (HubbLe…, Anchor): StabilityProviderState 1162 bytes: stability pool @9, owner @41, deposited USDH @81.
//   `stability_withdraw(amount)` (owner signs) pays the deposit (after any liquidation losses; the program caps
//   the amount, so u64::MAX takes everything) to the wallet's USDH ATA. USDH itself has < $10k of market
//   liquidity now, so it counts 0 and such items are only listed in the note until a market returns.
// Checked and left out: Parrot (no redemption path on chain); Hedge (vault withdrawals need a second fresh keypair
//   signer; staking withdrawals pay only HDG / USH, which have no market price, so they are worth 0).
(() => {
  const { W, P, ID, meta, gpa, readAccounts, disc, cat, u64, pda, enc, ata, short, b58, valueInLamports } = RC;

  const SUNNY = P("SPQR4kT3q2oUKEJes2L6NNSBCiPW9SfuhkuqC9bp6Sx");
  const SUNNY_REWARDER = P("97PmYbGpSHSrKrUkQX793mjpA2EA9rrQKkHsQuvenU44");
  const MMINE = P("QMMD16kjauP5knBwxNUJRZ1Z5o3deBuFrqVjBVmmqto");
  const QUARRY = P("QMNeHCGYnLVDn1icRAfQZpjPLBNkfGbSKRB83G5d8KB");
  const SABER = P("SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ");

  const le = (d, off) => RC.readU64(d, off);
  const key = (d, off) => new W.PublicKey(d.slice(off, off + 32));
  const fmt = (raw, dec) => { const s = Number(raw) / 10 ** dec; return s >= 1000 ? s.toFixed(0) : s >= 1 ? s.toFixed(2) : s.toPrecision(3); };
  const SYMBOLS = { So11111111111111111111111111111111111111112: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT", mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
    "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": "stSOL", "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT": "UXD",
    USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX: "USDH", Ea5SjE2Y6yvCeW5dYTn7PYMuW5ikXkvbGdcmSnXeaLjS: "PAI" };
  const sym = m => SYMBOLS[b58(m)] || short(m);
  const createAta = (p, owner, mint) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(owner, mint), false, true), meta(owner, false, false), meta(mint, false, false),
    meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] });
  const closeAta = (p, mint) => new W.TransactionInstruction({ programId: ID.TOKEN, data: Uint8Array.of(9), keys: [
    meta(ata(p, mint), false, true), meta(p, false, true), meta(p, true, false)] });
  const fits = (pk, ixs) => {
    try { return new W.TransactionMessage({ payerKey: pk, recentBlockhash: b58(ID.SYSTEM), instructions: ixs }).compileToLegacyMessage().serialize().length + 65 <= 1232; }
    catch { return false; }
  };
  let rentCache = null;
  const ataRent = async () => rentCache || (rentCache = await (await RC.rpc()).getMinimumBalanceForRentExemption(165));
  const tokAmount = a => a && a.data.length >= 72 ? le(a.data, 64) : 0n;

  // ------------------------------------------------------------------ Saber pools (by LP mint)
  const poolCache = new Map();
  function saberPool(lpMint) {
    const k = b58(lpMint);
    if (!poolCache.has(k)) {
      const p = (async () => {
        const found = await gpa(SABER, [{ dataSize: 395 }, { memcmp: { offset: 171, bytes: k } }]);
        if (!found.length) return null;
        const swap = found[0].pubkey, d = found[0].account.data;
        const pool = { swap, auth: W.PublicKey.createProgramAddressSync([swap.toBytes(), Uint8Array.of(d[2])], SABER),
          reserves: [key(d, 107), key(d, 139)], lpMint, adminFees: [key(d, 267), key(d, 299)], feeNum: le(d, 379), feeDen: le(d, 387) };
        const accs = await readAccounts([lpMint, ...pool.reserves]);
        if (accs.some(a => !a)) return null;
        pool.lpSupply = le(accs[0].data, 36);
        pool.mints = accs.slice(1).map(a => key(a.data, 0));
        pool.amounts = accs.slice(1).map(a => le(a.data, 64));
        const mintInfos = await readAccounts(pool.mints);
        pool.decimals = mintInfos.map(m => m ? m.data[44] : 0);
        return pool.lpSupply > 0n ? pool : null;
      })();
      poolCache.set(k, p);
      p.catch(() => poolCache.delete(k));
    }
    return poolCache.get(k);
  }
  const saberWithdraw = (p, pool, lp) => new W.TransactionInstruction({ programId: SABER,
    data: cat(Uint8Array.of(3), u64(lp), u64(0), u64(0)), keys: [
      meta(pool.swap, false, false), meta(pool.auth, false, false), meta(p, true, false),
      meta(pool.lpMint, false, true), meta(ata(p, pool.lpMint), false, true),
      meta(pool.reserves[0], false, true), meta(pool.reserves[1], false, true),
      meta(ata(p, pool.mints[0]), false, true), meta(ata(p, pool.mints[1]), false, true),
      meta(pool.adminFees[0], false, true), meta(pool.adminFees[1], false, true), meta(ID.TOKEN, false, false)] });
  const payout = (pool, lp) => pool.mints.map((mint, i) => {
    let a = pool.amounts[i] * lp / pool.lpSupply;
    if (pool.feeNum > 0n && pool.feeDen > 0n) a -= a * pool.feeNum / pool.feeDen;
    return { mint, amount: a, decimals: pool.decimals[i] };
  });

  // Turns "these instructions put `amount` of `mint` into the wallet's ATA" into an item: when the mint is a
  // Saber LP, also withdraw the pool (if it fits in one transaction). Returns null when worth nothing.
  // `pre(p)` = the wrapper's own instructions; they must leave `amount` in ata(p, mint).
  async function finish(pk, { mint, amount, pre, keyAcc, name, have }) {
    const rent = await ataRent();
    const pool = await saberPool(mint);
    const newLp = have.get(b58(ata(pk, mint))) !== "ok";
    if (pool) {
      const out = payout(pool, amount);
      const missing = pool.mints.filter(m => have.get(b58(ata(pk, m))) !== "ok");
      const text = out.map(o => fmt(o.amount, o.decimals) + " " + sym(o.mint)).join(" + ");
      const full = p => [...(newLp ? [createAta(p, p, mint)] : []), ...pre(p), ...missing.map(m => createAta(p, p, m)),
        saberWithdraw(p, pool, amount), ...(newLp ? [closeAta(p, mint)] : [])];
      const value = await valueInLamports(out);
      if (fits(pk, full(pk))) {
        const v = value - missing.length * rent;
        return v > 0 ? { key: keyAcc, value: v, label: name + " · Saber " + pool.mints.map(sym).join("/") + " · " + text, ixs: full } : null;
      }
      // Too large for one transaction: return the LP only; it is withdrawn from the pool on the next scan.
      const v = value - (newLp ? rent : 0);
      const lpOnly = p => [...(newLp ? [createAta(p, p, mint)] : []), ...pre(p)];
      return v > 0 && fits(pk, lpOnly(pk)) ? { key: keyAcc, value: v, ixs: lpOnly,
        label: name + " · Saber " + pool.mints.map(sym).join("/") + " LP (≈ " + text + "), comes back as LP tokens" } : null;
    }
    const [mi] = await readAccounts([mint]);
    if (!mi || !mi.owner.equals(ID.TOKEN)) return null;
    const dec = mi.data[44];
    const v = await valueInLamports([{ mint, amount, decimals: dec }]) - (newLp ? rent : 0);
    const ixs = p => [...(newLp ? [createAta(p, p, mint)] : []), ...pre(p)];
    return v > 0 && fits(pk, ixs(pk)) ? { key: keyAcc, value: v, ixs, label: name + " · " + fmt(amount, dec) + " " + sym(mint) } : null;
  }

  // The wallet's ATAs for these mints: "ok" (exists and still the wallet's), "foreign" (owner changed), or absent.
  async function ataStates(pk, mints) {
    const keys = [...new Set(mints.map(m => b58(ata(pk, m))))].map(P);
    const infos = await readAccounts(keys), out = new Map();
    keys.forEach((k, i) => { if (infos[i]) out.set(b58(k), key(infos[i].data, 32).equals(pk) ? "ok" : "foreign"); });
    return out;
  }
  const quarryPda = (rewarder, mint) => pda([enc("Quarry"), rewarder.toBytes(), mint.toBytes()], QUARRY)[0];
  const minerPda = (quarry, authority) => pda([enc("Miner"), quarry.toBytes(), authority.toBytes()], QUARRY)[0];
  const byValue = items => items.sort((a, b) => b.value - a.value);

  // ------------------------------------------------------------------ Sunny aggregator
  RC.registerSource({
    id: "sunny-vaults", title: "Sunny aggregator vaults (Saber LP)", group: "escrow", perTx: 1, programs: [SUNNY, SABER],
    async scan(pk) {
      const vaults = (await gpa(SUNNY, [{ dataSize: 97 }, { memcmp: { offset: 40, bytes: b58(pk) } }]))
        .map(({ pubkey, account: { data: d } }) => ({ vault: pubkey, pool: key(d, 8), vendor: le(d, 81), internal: le(d, 89) }));
      if (!vaults.length) return { items: [] };
      const poolKeys = [...new Map(vaults.map(v => [b58(v.pool), v.pool])).values()];
      const poolInfos = await readAccounts(poolKeys), pools = new Map();
      poolKeys.forEach((k, i) => {
        const a = poolInfos[i];
        if (!a || !a.owner.equals(SUNNY) || a.data.length !== 329) return;
        const d = a.data;
        pools.set(b58(k), { pool: k, quarry: key(d, 40), rewarder: key(d, 73), lpMint: key(d, 137), intMint: key(d, 169), withdrawFee: le(d, 281) });
      });
      // Per vault: its two miners and its two token accounts.
      const cands = vaults.map(v => {
        const pl = pools.get(b58(v.pool));
        if (!pl) return null;
        const intQuarry = quarryPda(SUNNY_REWARDER, pl.intMint);
        return { ...v, pl, intQuarry, intMiner: minerPda(intQuarry, v.vault), vendMiner: minerPda(pl.quarry, v.vault),
          intAta: ata(v.vault, pl.intMint), lpAta: ata(v.vault, pl.lpMint) };
      }).filter(Boolean);
      const infos = await readAccounts(cands.flatMap(c => [c.intMiner, c.vendMiner, c.intAta, c.lpAta]));
      const have = await ataStates(pk, [...cands.map(c => c.pl.lpMint)]);
      const items = [];
      let foreign = 0, fee = 0;
      for (const [i, c] of cands.entries()) {
        const [im, vm, ia, la] = infos.slice(4 * i, 4 * i + 4);
        const loose = tokAmount(la);                        // LP already sitting in the vault's own account
        if (c.vendor === 0n && loose === 0n) continue;
        if (c.pl.withdrawFee !== 0n) { fee++; continue; }
        if ((c.internal > 0n && (!im || !ia)) || (c.vendor > 0n && !vm) || !la) continue;
        const pool = await saberPool(c.pl.lpMint);
        const mints = pool ? [c.pl.lpMint, ...pool.mints] : [c.pl.lpMint];
        const st = await ataStates(pk, mints);
        if ([...st.values()].includes("foreign") || have.get(b58(ata(pk, c.pl.lpMint))) === "foreign") { foreign++; continue; }
        const { vault, pl, internal, vendor, intQuarry, intMiner, vendMiner, intAta, lpAta } = c;
        const intVault = im ? key(im.data, 73) : null, vendVault = vm ? key(vm.data, 73) : null;
        const [dInt, dVend, dOut] = await Promise.all(["unstake_internal", "withdraw_vendor", "withdraw_from_vault"].map(disc));
        const pre = p => [
          ...(internal > 0n ? [new W.TransactionInstruction({ programId: SUNNY, data: cat(dInt, u64(internal)), keys: [
            meta(p, true, false),                   // vault owner: this wallet
            meta(pl.intMint, false, true), meta(intAta, false, true),
            meta(pl.pool, false, true), meta(vault, false, true), meta(SUNNY_REWARDER, false, false),
            meta(intQuarry, false, true), meta(intMiner, false, true), meta(intVault, false, true),
            meta(ID.TOKEN, false, false), meta(QUARRY, false, false), meta(ID.CLOCK, false, false)] })] : []),
          ...(vendor > 0n ? [new W.TransactionInstruction({ programId: SUNNY, data: cat(dVend, u64(vendor)), keys: [
            meta(p, true, false), meta(lpAta, false, true),
            meta(pl.pool, false, true), meta(vault, false, true), meta(pl.rewarder, false, false),
            meta(pl.quarry, false, true), meta(vendMiner, false, true), meta(vendVault, false, true),
            meta(ID.TOKEN, false, false), meta(QUARRY, false, false), meta(ID.CLOCK, false, false)] })] : []),
          new W.TransactionInstruction({ programId: SUNNY, data: dOut, keys: [
            meta(p, true, false), meta(pl.pool, false, false), meta(vault, false, true), meta(lpAta, false, true),
            meta(ata(p, pl.lpMint), false, true),   // LP goes to the wallet's own LP account
            meta(ata(pl.pool, pl.lpMint), false, true), // pool's fee account (fee 0 in every Sunny pool)
            meta(ID.TOKEN, false, false)] })];
        const it = await finish(pk, { mint: pl.lpMint, amount: vendor + loose, pre, keyAcc: vault, name: "Sunny vault " + short(vault), have: st });
        if (it) items.push(it);
      }
      const notes = [];
      if (foreign) notes.push(foreign + " vault(s) skipped: a receiving token account belongs to someone else now.");
      if (fee) notes.push(fee + " vault(s) skipped: their pool charges a withdrawal fee.");
      return { items: byValue(items), note: notes.join(" ") };
    },
  });

  // ------------------------------------------------------------------ Quarry merge-mine
  // Every Quarry quarry (≈ 700), read once: rewarder and staked mint, to find a merge miner's miners.
  let quarryList = null;
  const allQuarries = () => quarryList || (quarryList = gpa(QUARRY, [{ dataSize: 140 }], { offset: 8, length: 64 })
    .then(r => r.map(({ pubkey, account: { data: d } }) => ({ quarry: pubkey, rewarder: key(d, 0), mint: key(d, 32) })))
    .catch(e => { quarryList = null; throw e; }));

  RC.registerSource({
    id: "merge-mine", title: "Quarry merge-mining (Saber LP, mSOL…)", group: "escrow", perTx: 1, programs: [MMINE, SABER],
    async scan(pk) {
      const mms = (await gpa(MMINE, [{ dataSize: 97 }, { memcmp: { offset: 40, bytes: b58(pk) } }]))
        .map(({ pubkey, account: { data: d } }) => ({ mm: pubkey, pool: key(d, 8), primary: le(d, 81), replica: le(d, 89) }));
      if (!mms.length) return { items: [] };
      const poolKeys = [...new Map(mms.map(m => [b58(m.pool), m.pool])).values()];
      const poolInfos = await readAccounts(poolKeys), pools = new Map();
      poolKeys.forEach((k, i) => { const a = poolInfos[i];
        if (a && a.owner.equals(MMINE) && a.data.length >= 73) pools.set(b58(k), { pool: k, primaryMint: key(a.data, 8), replicaMint: key(a.data, 41) }); });
      // Merge miners with something in them: staked primary, or primary already unstaked into its own ATA.
      const withPool = mms.map(m => ({ ...m, pl: pools.get(b58(m.pool)) })).filter(m => m.pl);
      const looseInfos = await readAccounts(withPool.map(m => ata(m.mm, m.pl.primaryMint)));
      const cands = withPool.map((m, i) => ({ ...m, loose: tokAmount(looseInfos[i]), primAta: ata(m.mm, m.pl.primaryMint), primAtaExists: !!looseInfos[i] }))
        .filter(m => m.primary > 0n || m.loose > 0n);
      if (!cands.length) return { items: [] };
      const quarries = await allQuarries();
      // Candidate miners of each merge miner: one per quarry of its primary or replica mint.
      const minerRefs = [];
      for (const c of cands) for (const q of quarries) {
        const role = q.mint.equals(c.pl.primaryMint) ? "primary" : q.mint.equals(c.pl.replicaMint) ? "replica" : null;
        if (role) minerRefs.push({ c, q, role, miner: minerPda(q.quarry, c.mm) });
      }
      const minerInfos = await readAccounts(minerRefs.map(r => r.miner));
      minerRefs.forEach((r, i) => { const a = minerInfos[i];
        if (a && a.owner.equals(QUARRY) && a.data.length === 145 && le(a.data, 129) > 0n)
          (r.c[r.role + "Miners"] = r.c[r.role + "Miners"] || []).push({ ...r, vault: key(a.data, 73), balance: le(a.data, 129) }); });
      const [dRep, dPrim, dOut] = await Promise.all(["unstake_all_replica_miner", "unstake_primary_miner", "withdraw_tokens"].map(disc));
      const items = [];
      let foreign = 0, incomplete = 0;
      for (const c of cands) {
        const prim = c.primaryMiners || [], reps = c.replicaMiners || [];
        const staked = prim.reduce((s, m) => s + m.balance, 0n);
        if (staked < c.primary || !c.primAtaExists) { incomplete++; continue; }    // a miner we could not find
        const { mm, pl, primAta } = c;
        const repAta = ata(mm, pl.replicaMint);
        const pool = await saberPool(pl.primaryMint);
        const st = await ataStates(pk, pool ? [pl.primaryMint, ...pool.mints] : [pl.primaryMint]);
        if ([...st.values()].includes("foreign")) { foreign++; continue; }
        const stake = m => [meta(pl.pool, false, true), meta(mm, false, true), meta(m.q.rewarder, false, false),
          meta(m.q.quarry, false, true), meta(m.miner, false, true), meta(m.vault, false, true),
          meta(ID.TOKEN, false, false), meta(QUARRY, false, false)];
        const pre = p => [
          ...reps.map(m => new W.TransactionInstruction({ programId: MMINE, data: dRep, keys: [
            meta(p, true, false),                   // merge miner owner: this wallet
            meta(pl.replicaMint, false, true), meta(repAta, false, true), ...stake(m)] })),
          ...prim.map(m => new W.TransactionInstruction({ programId: MMINE, data: cat(dPrim, u64(m.balance)), keys: [
            meta(p, true, false), meta(primAta, false, true), ...stake(m)] })),
          new W.TransactionInstruction({ programId: MMINE, data: dOut, keys: [
            meta(p, true, false), meta(pl.pool, false, false), meta(mm, false, true), meta(pl.primaryMint, false, false),
            meta(primAta, false, true),
            meta(ata(p, pl.primaryMint), false, true),    // to the wallet's own token account
            meta(ID.TOKEN, false, false)] })];
        const it = await finish(pk, { mint: pl.primaryMint, amount: staked + c.loose, pre, keyAcc: mm, name: "Merge miner " + short(mm), have: st });
        if (it) items.push(it);
      }
      const notes = [];
      if (foreign) notes.push(foreign + " position(s) skipped: a receiving token account belongs to someone else now.");
      if (incomplete) notes.push(incomplete + " position(s) skipped: not all of their Quarry miners could be found.");
      return { items: byValue(items), note: notes.join(" ") };
    },
  });

  // ------------------------------------------------------------------ UXD
  const UXDP = P("UXD8m9cvwk4RcSxnX2HZ9VudQCEeDH6fRnB4CAP57Dr");
  const UXD = P("7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT");
  const USDC = P("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const MERC_VAULT_PROG = P("24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi");
  const UXD_CONTROLLER = P("3tbJcXAWQkFVN26rZPtwkFNvC24sPT35fDxG4M7irLQW");
  const UXD_FIXED = ["BgkHf7mAtNwtnu2uCJqSJWbFdiXCoMBpNZmgVJJmsGLW",   // identity depository
    "5dT7SJWz9kLFF5jA9czkSwwMeUhHj76mhF1jtvdbAoSL",                     //   its USDC vault
    "4gMkg5iMaYApKQEJ5MDQCVuZ5HZ8Q5GvKwz2sJxRGwyb",                     // Mercurial vault depository (fee @206)
    "3zpNjTqAyKFoSLpQDgKdjzMChVDbU826cP93MMRW6ZqK",                     //   its LP token vault
    "3ESUFCnRNgZ7Mn2mPPUMmXYaKU8jpnV9VtA17M7t2mHQ",                     //   Mercurial vault
    "3RpEekjLE5cdcG15YcXJUpxSepemvq2FpmMcgo342BwC",                     //   vault LP mint
    "C2QoQ111jGHEy5918XkNXQro7gGwC9PKLXd1LqBiYNwA",                     //   vault collateral token safe
    "AGqtEsmCnzQNbSQzM6qmTZ4M5nhJ8WP8CbdNh6eQBuWF"].map(P);             // Credix LP depository (fee @315)
  RC.registerSource({
    id: "uxd-redeem", title: "UXD stablecoin (redeem for USDC)", group: "escrow", perTx: 3, programs: [UXDP],
    async scan(pk) {
      const held = (await RC.tokenAccounts(pk, ID.TOKEN)).filter(({ account }) => {
        const i = account.data?.parsed?.info;
        return i && i.mint === b58(UXD) && i.state === "initialized" && i.tokenAmount.amount !== "0";
      });
      if (!held.length) return { items: [] };
      const [ctrl, merc, credix] = await readAccounts([UXD_CONTROLLER, UXD_FIXED[2], UXD_FIXED[7]]);
      if (!ctrl || !merc || !credix) throw new Error("UXD protocol accounts missing");
      const feeBps = BigInt(Math.max(merc.data[206], credix.data[315]));
      const st = await ataStates(pk, [USDC]);
      if (st.get(b58(ata(pk, USDC))) === "foreign") return { items: [], note: "Skipped: the wallet's USDC account belongs to someone else now." };
      const create = st.get(b58(ata(pk, USDC))) !== "ok";
      const rent = create ? await ataRent() : 0;
      const d = await disc("redeem");
      const items = [];
      for (const [n, { pubkey, account }] of held.entries()) {
        const amount = BigInt(account.data.parsed.info.tokenAmount.amount);
        const out = amount * (10000n - feeBps) / 10000n;
        const value = await valueInLamports([{ mint: USDC, amount: out, decimals: 6 }]) - (n === 0 ? rent : 0);
        if (value <= 0) continue;
        items.push({ key: pubkey, value, label: "UXD " + short(pubkey) + " · " + fmt(amount, 6) + " UXD → " + fmt(out, 6) + " USDC",
          ixs: p => [...(create ? [createAta(p, p, USDC)] : []), new W.TransactionInstruction({ programId: UXDP, data: cat(d, u64(amount)), keys: [
            meta(p, true, true),                    // user
            meta(p, true, true),                    // payer
            meta(UXD_CONTROLLER, false, true), meta(UXD, false, true), meta(USDC, false, false),
            meta(pubkey, false, true),              // the wallet's UXD account (burned from)
            meta(ata(p, USDC), false, true),        // the wallet's USDC account (paid to)
            ...UXD_FIXED.map(k => meta(k, false, true)),
            meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false), meta(ID.ATA, false, false),
            meta(MERC_VAULT_PROG, false, false), meta(UXDP, false, false), meta(ID.RENT, false, false)] })] });
      }
      return { items: byValue(items) };
    },
  });

  // ------------------------------------------------------------------ Hubble stability pool
  const HUBBLE = P("HubbLeXBb7qyLHt3x7gvYaRrxQmmgExb7fCJgDqFuB6T");
  const USDH = P("USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX");
  const HUB = { market: P("YSp9bJpQom2HA7VThxYZX9pNwrcBH88NBcBNWs5yskR"), config: P("8HuhMF7ppoYdPD9fAdn9d9ZU1rL4ipty6CJEcZ5F17o1"),
    pool: P("245U3MMJ57YDGUSYRQxsJurqUhnXK4mjjvavbrvSn3uh"), vaults: P("EUEukBTF2X4gtFzkAJaqBcxUVbrSLn2yxLDBuKJj5JoZ"),
    epochs: P("HDZR8Knvh9ETmCFGig3ocmzxijVgSrtPYSNCFoj2muRf"), spVault: P("GE6PqKhREVLRTGZs7rV5mJ2L3FAcj2fqohWCzTjhCTdQ"),
    spAuth: P("CpNGqip6qTSmYEa3ANtPdHUzgD6HSWKeDE8ovNUtQLQy") };
  RC.registerSource({
    id: "hubble-stability", title: "Hubble stability pool (USDH)", group: "escrow", perTx: 3, programs: [HUBBLE],
    async scan(pk) {
      const sps = (await gpa(HUBBLE, [{ dataSize: 1162 }, { memcmp: { offset: 41, bytes: b58(pk) } }]))
        .map(({ pubkey, account: { data: d } }) => ({ sps: pubkey, pool: key(d, 9), deposited: le(d, 81) }))
        .filter(x => x.deposited > 0n && x.pool.equals(HUB.pool));
      if (!sps.length) return { items: [] };
      const st = await ataStates(pk, [USDH]);
      if (st.get(b58(ata(pk, USDH))) === "foreign") return { items: [], note: "Skipped: the wallet's USDH account belongs to someone else now." };
      const create = st.get(b58(ata(pk, USDH))) !== "ok";
      const rent = create ? await ataRent() : 0;
      const d = await disc("stability_withdraw");
      const items = [], unpriced = [];
      for (const [n, x] of sps.entries()) {
        const text = fmt(x.deposited, 6) + " USDH";
        const value = await valueInLamports([{ mint: USDH, amount: x.deposited, decimals: 6 }]) - (n === 0 ? rent : 0);
        if (value <= 0) { unpriced.push(text); continue; }
        items.push({ key: x.sps, value, label: "Hubble stability deposit " + short(x.sps) + " · up to " + text,
          ixs: p => [...(create ? [createAta(p, p, USDH)] : []), new W.TransactionInstruction({ programId: HUBBLE,
            data: cat(d, u64(0xffffffffffffffffn)), keys: [      // u64::MAX: the program pays out the whole deposit
              meta(p, true, true),                  // owner
              meta(x.sps, false, true), meta(HUB.market, false, true), meta(HUB.config, false, false),
              meta(HUB.pool, false, true), meta(HUB.vaults, false, false), meta(HUB.epochs, false, true),
              meta(HUB.spVault, false, true), meta(HUB.spAuth, false, false),
              meta(ata(p, USDH), false, true),      // the wallet's USDH account
              meta(ID.TOKEN, false, false), meta(ID.CLOCK, false, false)] })] });
      }
      return { items: byValue(items), note: unpriced.length ? "Not listed: " + unpriced.join(", ")
        + " in the Hubble stability pool. It can be withdrawn, but USDH has no liquid market now (under $10k), so it counts as 0." : "" };
    },
  });
})();
