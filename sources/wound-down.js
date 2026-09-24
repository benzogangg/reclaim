"use strict";
// Wound-down protocols whose programs still let depositors take their money out. Sources in this file:
// Saber/Mercurial LP (+ Quarry-staked LP), Friktion volts, Solend dead-market deposits, Port Finance, abandoned SPL
// stake pools, Jet v1, Jet v2, Francium. Every payout goes to the wallet, its ATAs or a stake account it controls.
// Not here, checked and not possible: Lido stSOL (all validator stake is below 2 SOL while the minimum delegation is
// 1 SOL, so every split fails; the withdraw also needs a fresh keypair signer); Tulip (refresh/redeem panic since the
// 2025 redeploy); Apricot (program frozen). Larix and borrowed-against positions are left out.
//
// Saber StableSwap (SSwpkE…, SwapInfo 395 bytes): is_paused @1, nonce @2, reserve A @107, reserve B @139,
//   LP mint @171, mint A @203, mint B @235, admin fee accounts A @267 / B @299, fees @331 (8 × u64:
//   admin trade n/d, admin withdraw n/d, trade n/d, withdraw n/d). Authority = createProgramAddress([swap, nonce]).
//   Withdraw (data 03, u64 LP amount, u64 min A, u64 min B) burns the LP and pays both reserves pro rata minus
//   the withdraw fee. It has no is_paused check, so it also works on paused pools. The Saber site is gone.
// Mercurial stable pools (MERLuD…, SwapState 265 bytes): token count u32 @27, token accounts 4 × 32 @71,
//   LP mint @199. Authority = PDA([swap]). RemoveLiquidity (data 02, u64 LP amount, vec<u64> minimums) pays every
//   reserve pro rata, no fee. Accounts: swap, token program, authority, owner, reserves…, LP mint, destinations…, LP.
// Quarry (QMNeHC…, the Saber farms): Miner 145 bytes: quarry @8, authority @40, vault @73, balance @129;
//   Quarry: rewarder @8, staked mint @40. withdraw_tokens(amount) returns staked LP to the owner's token account
//   (accounts: authority, miner, quarry, miner vault, token account, token program, rewarder); in the same item the
//   LP is then withdrawn from the pool as above. Fails while the rewarder is paused (simulation drops it).
// Minimum outputs are 0: a balanced withdrawal pays exact pro-rata shares, nothing can move its price.
// Value = the pro-rata reserves at Jupiter prices (worthless wrapped tokens count 0), minus rent of new ATAs.
(() => {
  const { W, P, ID, meta, gpa, readAccounts, tokenAccounts, disc, cat, u32, u64, pda, ata, short, b58, valueInLamports } = RC;

  const le = (d, off) => RC.readU64(d, off);
  const key = (d, off) => new W.PublicKey(d.slice(off, off + 32));
  const fmt = (raw, dec) => { const s = Number(raw) / 10 ** dec; return s >= 1000 ? s.toFixed(0) : s >= 1 ? s.toFixed(2) : s.toPrecision(3); };
  const SYMBOLS = { So11111111111111111111111111111111111111112: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT", mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
    "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": "stSOL", J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
    "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT": "UXD", USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX: "USDH",
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD", "7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn": "JSOL",
    "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm": "INF" };
  const sym = m => SYMBOLS[m] || short(m);
  // The wallet's SPL token accounts, read once per scan and shared by the sources in this file.
  const heldCache = new Map();
  function walletTokens(pk, programId = ID.TOKEN) {
    const k = b58(programId), c = heldCache.get(k);
    if (c && c.pk.equals(pk) && Date.now() - c.t < 20000) return c.v;
    const v = tokenAccounts(pk, programId);
    heldCache.set(k, { pk, t: Date.now(), v });
    v.catch(() => heldCache.delete(k));
    return v;
  }
  let rentCache = null;
  const ataRent = async () => rentCache || (rentCache = await (await RC.rpc()).getMinimumBalanceForRentExemption(165));
  const createAta = (p, mint) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(p, mint), false, true), meta(p, false, false), meta(mint, false, false),
    meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] });

  // ------------------------------------------------------------------ Saber / Mercurial LP
  const SABER = P("SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ");
  const MERC = P("MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky");
  const QUARRY = P("QMNeHCGYnLVDn1icRAfQZpjPLBNkfGbSKRB83G5d8KB");

  // Every Saber and Mercurial pool, keyed by LP mint: { kind, swap, lpMint }.
  async function poolsByLpMint() {
    const [saber, merc] = await Promise.all([
      gpa(SABER, [{ dataSize: 395 }], { offset: 171, length: 32 }),
      gpa(MERC, [{ dataSize: 265 }], { offset: 199, length: 32 }),
    ]);
    const out = new Map();
    for (const { pubkey, account } of saber) out.set(b58(key(account.data, 0)), { kind: "saber", swap: pubkey });
    for (const { pubkey, account } of merc) out.set(b58(key(account.data, 0)), { kind: "merc", swap: pubkey });
    return out;
  }

  // Reads a pool's full state: reserves (token account, mint, amount, decimals), LP supply, fee, accounts for the ix.
  async function loadPool(pool) {
    const [info] = await readAccounts([pool.swap]);
    if (!info) return null;
    const d = info.data;
    const p = { ...pool };
    if (pool.kind === "saber") {
      p.auth = W.PublicKey.createProgramAddressSync([pool.swap.toBytes(), Uint8Array.of(d[2])], SABER);
      p.reserves = [key(d, 107), key(d, 139)];
      p.lpMint = key(d, 171);
      p.adminFees = [key(d, 267), key(d, 299)];
      p.feeNum = le(d, 379); p.feeDen = le(d, 387);
    } else {
      const n = new DataView(d.buffer, d.byteOffset).getUint32(27, true);
      p.auth = pda([pool.swap.toBytes()], MERC)[0];
      p.reserves = [...Array(n)].map((_, i) => key(d, 71 + 32 * i));
      p.lpMint = key(d, 199);
      p.feeNum = 0n; p.feeDen = 1n;
    }
    const accs = await readAccounts([p.lpMint, ...p.reserves]);
    if (accs.some(a => !a)) return null;
    p.lpSupply = le(accs[0].data, 36);
    p.mints = accs.slice(1).map(a => key(a.data, 0));
    p.amounts = accs.slice(1).map(a => le(a.data, 64));
    const mintInfos = await readAccounts(p.mints);
    p.decimals = mintInfos.map(m => m ? m.data[44] : 0);
    return p;
  }

  // Burn `lp` from the token account `src` and pay the reserves into the wallet's ATAs.
  function withdrawIx(p, pool, src, lp) {
    const dests = pool.mints.map(m => ata(p, m));
    if (pool.kind === "saber") return new W.TransactionInstruction({ programId: SABER, data: cat(Uint8Array.of(3), u64(lp), u64(0), u64(0)), keys: [
      meta(pool.swap, false, false), meta(pool.auth, false, false), meta(p, true, false),
      meta(pool.lpMint, false, true), meta(src, false, true),
      meta(pool.reserves[0], false, true), meta(pool.reserves[1], false, true),
      meta(dests[0], false, true), meta(dests[1], false, true),
      meta(pool.adminFees[0], false, true), meta(pool.adminFees[1], false, true), meta(ID.TOKEN, false, false)] });
    const n = pool.reserves.length;
    return new W.TransactionInstruction({ programId: MERC, data: cat(Uint8Array.of(2), u64(lp), u32(n), ...pool.mints.map(() => u64(0))), keys: [
      meta(pool.swap, false, false), meta(ID.TOKEN, false, false), meta(pool.auth, false, false), meta(p, true, false),
      ...pool.reserves.map(r => meta(r, false, true)), meta(pool.lpMint, false, true),
      ...dests.map(x => meta(x, false, true)), meta(src, false, true)] });
  }

  // What `lp` LP tokens pay out: pro-rata reserves minus the withdraw fee.
  function payout(pool, lp) {
    return pool.mints.map((mint, i) => {
      let a = pool.amounts[i] * lp / pool.lpSupply;
      if (pool.feeNum > 0n && pool.feeDen > 0n) a -= a * pool.feeNum / pool.feeDen;
      return { mint, amount: a, decimals: pool.decimals[i] };
    });
  }

  // The wallet's Quarry miners. Some RPCs refuse this search (Quarry has many accounts); then derive the
  // wallet's miner PDA ["Miner", quarry, wallet] for the quarry ["Quarry", rewarder, LP mint] of every pool
  // under Saber's rewarder (which holds almost all LP quarries) and read those addresses directly.
  const SABER_REWARDER = P("rXhAofQCT7NN9TUqigyEAUzV1uLL4boeD8CRkNBSkYk");
  async function quarryMiners(pk, pools) {
    try { return await gpa(QUARRY, [{ dataSize: 145 }, { memcmp: { offset: 40, bytes: b58(pk) } }]); }
    catch { console.warn("Quarry search refused by the RPC, reading miner addresses directly"); }
    const keys = [...pools.keys()].map(m => {
      const quarry = pda([RC.enc("Quarry"), SABER_REWARDER.toBytes(), P(m).toBytes()], QUARRY)[0];
      return pda([RC.enc("Miner"), quarry.toBytes(), pk.toBytes()], QUARRY)[0];
    });
    const infos = await readAccounts(keys);
    return keys.map((pubkey, i) => ({ pubkey, account: infos[i] })).filter(x => x.account && x.account.data.length === 145);
  }

  RC.registerSource({
    id: "stableswap-lp", title: "Saber & Mercurial pool shares", group: "escrow", perTx: 2, programs: [SABER, MERC, QUARRY],
    async scan(pk) {
      const [pools, held] = await Promise.all([poolsByLpMint(), walletTokens(pk)]);
      const miners = await quarryMiners(pk, pools);
      // Positions: LP in the wallet's own token accounts, and LP staked in the wallet's Quarry miners.
      const positions = [];
      for (const { pubkey, account } of held) {
        const info = account.data?.parsed?.info;
        const pool = info && pools.get(info.mint);
        if (!pool || info.state !== "initialized" || info.tokenAmount.amount === "0") continue;
        positions.push({ pool, src: pubkey, lp: BigInt(info.tokenAmount.amount) });
      }
      if (miners.length) {
        const quarries = await readAccounts(miners.map(m => key(m.account.data, 8)));
        const rewarders = await readAccounts(quarries.map(q => q ? key(q.data, 8) : ID.SYSTEM));
        miners.forEach((m, i) => {
          const q = quarries[i], d = m.account.data;
          if (!q || !rewarders[i]) return;
          const pool = pools.get(b58(key(q.data, 40)));
          const balance = le(d, 129);
          if (!pool || balance === 0n) return;
          positions.push({ pool, lp: balance, miner: { miner: m.pubkey, quarry: key(d, 8), vault: key(d, 73), rewarder: key(q.data, 8) } });
        });
      }
      if (!positions.length) return { items: [] };

      const loaded = new Map();
      for (const pos of positions) {
        const k = b58(pos.pool.swap);
        if (!loaded.has(k)) loaded.set(k, await loadPool(pos.pool));
        pos.pool = loaded.get(k);
      }
      const live = positions.filter(x => x.pool && x.pool.lpSupply > 0n);
      // Destination ATAs: skip positions whose ATA exists but was handed to another owner.
      const destKeys = [...new Set(live.flatMap(x => [...x.pool.mints, x.pool.lpMint].map(m => b58(ata(pk, m)))))].map(P);
      const destInfos = await readAccounts(destKeys);
      const destState = new Map(destKeys.map((k, i) => [b58(k), destInfos[i] ? (key(destInfos[i].data, 32).equals(pk) ? "ok" : "foreign") : "missing"]));
      const rent = await ataRent();

      const items = [];
      let foreign = 0;
      for (const pos of live) {
        const { pool, lp, miner } = pos;
        const needed = [...pool.mints, ...(miner ? [pool.lpMint] : [])];
        const states = needed.map(m => destState.get(b58(ata(pk, m))));
        if (states.includes("foreign")) { foreign++; continue; }
        const out = payout(pool, lp);
        let value = await valueInLamports(out);
        const missing = [...new Set(needed.filter((m, i) => states[i] === "missing").map(b58))];
        value -= missing.length * rent;
        if (value <= 0) continue;
        const lpAta = ata(pk, pool.lpMint);
        const src = miner ? lpAta : pos.src;
        const name = (pool.kind === "saber" ? "Saber " : "Mercurial ") + pool.mints.map(m => sym(b58(m))).join("/");
        const withdrawDisc = miner ? await disc("withdraw_tokens") : null;
        items.push({
          key: miner ? miner.miner : pos.src, value,
          label: name + (miner ? " · staked in Quarry" : "") + " · " + out.map(o => fmt(o.amount, o.decimals) + " " + sym(b58(o.mint))).join(" + "),
          ixs: p => [
            ...pool.mints.map(m => createAta(p, m)),
            ...(miner ? [createAta(p, pool.lpMint), new W.TransactionInstruction({ programId: QUARRY, data: cat(withdrawDisc, u64(lp)), keys: [
              meta(p, true, false),                     // miner authority: this wallet
              meta(miner.miner, false, true), meta(miner.quarry, false, true), meta(miner.vault, false, true),
              meta(lpAta, false, true),                 // LP comes back to the wallet's own LP account
              meta(ID.TOKEN, false, false), meta(miner.rewarder, false, false)] })] : []),
            withdrawIx(p, pool, src, lp)],
        });
      }
      return { items: items.sort((a, b) => b.value - a.value),
        note: foreign ? foreign + " position(s) skipped: a receiving token account belongs to someone else now." : "" };
    },
  });

  // ------------------------------------------------------------------ measuring a withdrawal by simulation
  // Lending withdrawals accrue interest inside the transaction, so the exact payout is read from a simulation:
  // the change of the wallet's SOL (including the rent of accounts it creates and the fee) plus the change of
  // each receiving token account, priced with valueInLamports.
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function simAccounts(pk, ixs, keys) {
    const c = await RC.rpc();
    let r;
    for (let tries = 0; ; tries++) {           // simulations are many here; ride out a rate limit instead of failing the scan
      try {
        const { blockhash } = await c.getLatestBlockhash("confirmed");
        const msg = new W.TransactionMessage({ payerKey: pk, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage();
        r = await c.simulateTransaction(new W.VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true,
          commitment: "confirmed", accounts: { encoding: "base64", addresses: keys.map(b58) } });
        break;
      } catch (e) { if (tries >= 4 || !/429|Too Many/i.test(String(e?.message || e))) throw e; await RC.sleep(1500 * (tries + 1)); }
    }
    if (r.value.err) return null;
    return r.value.accounts.map(a => a ? { lamports: a.lamports, data: b64(a.data[0]) } : null);
  }
  const tokAmount = a => a && a.data.length >= 72 ? le(a.data, 64) : 0n;
  const decimalsCache = new Map([[b58(ID.WSOL), 9]]);
  async function decimalsOf(mints) {
    const need = [...new Set(mints.map(b58))].filter(m => !decimalsCache.has(m));
    const infos = need.length ? await readAccounts(need.map(P)) : [];
    need.forEach((m, i) => decimalsCache.set(m, infos[i] ? infos[i].data[44] : 0));
    return m => decimalsCache.get(b58(m));
  }
  // → { value (lamports), got: [{mint, amount, decimals}] } or null when the simulation fails.
  async function measure(pk, ixs, mints) {
    const list = [...new Set(mints.map(b58))].map(P);
    const keys = [pk, ...list.map(m => ata(pk, m))];
    const [before, after] = await Promise.all([readAccounts(keys), simAccounts(pk, ixs, keys)]);
    if (!after) return null;
    const dec = await decimalsOf(list);
    let sol = BigInt(after[0]?.lamports || 0) - BigInt(before[0]?.lamports || 0);
    const got = [], tokens = [];
    list.forEach((m, i) => {
      if (m.equals(ID.WSOL)) {             // wrapped SOL is unwrapped at the end: count its lamports as SOL
        sol += BigInt(after[i + 1]?.lamports || 0) - BigInt(before[i + 1]?.lamports || 0);
        return;
      }
      const d = tokAmount(after[i + 1]) - tokAmount(before[i + 1]);
      if (d > 0n) { tokens.push({ mint: m, amount: d, decimals: dec(m) }); got.push({ mint: m, amount: d, decimals: dec(m) }); }
    });
    if (sol > 0n) got.unshift({ mint: ID.WSOL, amount: sol, decimals: 9 });
    return { value: Number(sol) + await valueInLamports(tokens), got };
  }
  const describe = got => got.map(g => fmt(g.amount, g.decimals) + " " + sym(b58(g.mint))).join(" + ") || "dust";
  const closeWsol = (p, mint) => mint.equals(ID.WSOL) ? [new W.TransactionInstruction({ programId: ID.TOKEN, data: Uint8Array.of(9),
    keys: [meta(ata(p, ID.WSOL), false, true), meta(p, false, true), meta(p, true, false)] })] : [];
  const fitsOneTx = (pk, ixs) => {
    try { return new W.TransactionMessage({ payerKey: pk, recentBlockhash: b58(ID.SYSTEM), instructions: ixs }).compileToLegacyMessage().serialize().length + 65 <= 1232; }
    catch { return false; }
  };
  const u128 = (d, off) => le(d, off) + (le(d, off + 8) << 64n);
  const WAD = 10n ** 18n;

  // ------------------------------------------------------------------ Friktion volts
  // Friktion (VoLT1m…, Anchor) shut down in 2023; every volt still has instant transfers enabled.
  // VoltVault (747 bytes): instant_transfers_enabled @101, round_number u64 @105, vault_authority @137,
  //   deposit_pool @169, vault_mint (shares) @297, deposit_mint (underlying) @329.
  // ExtraVoltData PDA [volt,"extraVoltData"]: is_whitelisted @8, whitelist @9.
  // PendingDeposit [volt,wallet,"pendingDeposit"] / PendingWithdrawal [volt,wallet,"pendingWithdrawal"]: round @9, amount @17.
  // Round PDAs [volt, u64 round, "roundInfo"|"roundUnderlyingTokens"|"roundVoltTokens"|"roundUlPending"|"epochInfo"].
  // One item per volt: claim (older round) or cancel (current round) a pending deposit / withdrawal, then
  // `withdraw` every share: underlying = shares × deposit pool / share supply, paid to the wallet's ATA.
  const VOLT = P("VoLT1mJz1sbnxwq5Fv2SXjdVDgPXrb9tJyC8WpMDkSp");
  const FRK_FEES = P("3KjJiWBfaw96qGhysq6Fc9FTxdPgPTNY6shM7Bwfp8EJ");
  RC.registerSource({
    id: "friktion", title: "Friktion volts", group: "escrow", perTx: 1, programs: [VOLT],
    async scan(pk) {
      const [volts, held] = await Promise.all([gpa(VOLT, [{ dataSize: 747 }]), walletTokens(pk)]);
      const shareBal = new Map();
      for (const { account } of held) {
        const info = account.data?.parsed?.info;
        if (info && info.tokenAmount.amount !== "0") shareBal.set(info.mint, (shareBal.get(info.mint) || 0n) + BigInt(info.tokenAmount.amount));
      }
      const E = RC.enc;
      const vs = volts.map(({ pubkey, account: { data: d } }) => ({ volt: pubkey, instant: d[101] === 1, round: le(d, 105),
        auth: key(d, 137), pool: key(d, 169), vaultMint: key(d, 297), mint: key(d, 329) }));
      const pdas = vs.flatMap(v => [pda([v.volt.toBytes(), pk.toBytes(), E("pendingDeposit")], VOLT)[0],
        pda([v.volt.toBytes(), pk.toBytes(), E("pendingWithdrawal")], VOLT)[0]]);
      const pend = await readAccounts(pdas);
      const cand = [];
      vs.forEach((v, i) => {
        const pd = pend[2 * i], pw = pend[2 * i + 1];
        v.pdKey = pdas[2 * i]; v.pwKey = pdas[2 * i + 1];
        v.pd = pd && le(pd.data, 17) > 0n ? { round: le(pd.data, 9) } : null;
        v.pw = pw && le(pw.data, 17) > 0n ? { round: le(pw.data, 9) } : null;
        v.pwExists = !!pw;
        v.shares = shareBal.get(b58(v.vaultMint)) || 0n;
        if (v.instant && (v.pd || v.pw || v.shares > 0n)) cand.push(v);
      });
      if (!cand.length) return { items: [] };
      const extras = await readAccounts(cand.map(v => pda([v.volt.toBytes(), E("extraVoltData")], VOLT)[0]));
      const [dClaimDep, dCancelDep, dClaimW, dCancelW, dWithdraw] = await Promise.all(
        ["claim_pending_deposit", "cancel_pending_deposit", "claim_pending_withdrawal", "cancel_pending_withdrawal", "withdraw"].map(disc));
      const round = (v, n) => Object.fromEntries(["roundInfo", "roundUnderlyingTokens", "roundVoltTokens", "roundUlPending", "epochInfo"]
        .map(s => [s, pda([v.volt.toBytes(), u64(n), E(s)], VOLT)[0]]));
      const items = [];
      for (let i = 0; i < cand.length; i++) {
        const v = cand[i], ex = extras[i];
        if (!ex) continue;
        const extra = pda([v.volt.toBytes(), E("extraVoltData")], VOLT)[0];
        const whitelist = ex.data[8] ? key(ex.data, 9) : ID.SYSTEM;
        const shareAta = ata(pk, v.vaultMint), ulAta = ata(pk, v.mint), cur = round(v, v.round);
        const claims = p => {
          const out = [];
          if (v.pd) {
            if (v.pd.round < v.round) { const r = round(v, v.pd.round);
              out.push(new W.TransactionInstruction({ programId: VOLT, data: dClaimDep, keys: [meta(p, true, false), meta(v.volt, false, false),
                meta(extra, false, false), meta(v.auth, false, false), meta(ata(p, v.vaultMint), false, true), meta(r.roundInfo, false, true),
                meta(r.roundVoltTokens, false, true), meta(v.pdKey, false, true), meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] }));
            } else out.push(new W.TransactionInstruction({ programId: VOLT, data: dCancelDep, keys: [meta(p, true, false), meta(v.volt, false, false),
                meta(extra, false, false), meta(v.auth, false, false), meta(ata(p, v.mint), false, true), meta(cur.roundInfo, false, true),
                meta(cur.roundUnderlyingTokens, false, true), meta(v.pdKey, false, true), meta(cur.epochInfo, false, true),
                meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] }));
          }
          if (v.pw) {
            if (v.pw.round < v.round) { const r = round(v, v.pw.round);
              out.push(new W.TransactionInstruction({ programId: VOLT, data: dClaimW, keys: [meta(p, true, false), meta(v.volt, false, false),
                meta(extra, false, false), meta(v.auth, false, false), meta(v.vaultMint, false, false), meta(ata(p, v.mint), false, true),
                meta(r.roundInfo, false, true), meta(v.pwKey, false, true), meta(r.roundUlPending, false, true),
                meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] }));
            } else out.push(new W.TransactionInstruction({ programId: VOLT, data: dCancelW, keys: [meta(p, true, false), meta(v.vaultMint, false, true),
                meta(v.volt, false, false), meta(extra, false, false), meta(v.auth, false, false), meta(ata(p, v.vaultMint), false, true),
                meta(cur.roundInfo, false, true), meta(v.pwKey, false, true), meta(cur.epochInfo, false, true),
                meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] }));
          }
          return out;
        };
        const head = p => [createAta(p, v.vaultMint), createAta(p, v.mint), ...claims(p)];
        // Shares after the claims: read from a simulation when a claim/cancel changes them.
        let shares = v.shares;
        if (v.pd || v.pw) {
          const after = await simAccounts(pk, head(pk), [shareAta]);
          if (!after) continue;
          shares = tokAmount(after[0]);
        }
        const withdraw = p => shares > 0n ? [new W.TransactionInstruction({ programId: VOLT, data: cat(dWithdraw, u64(shares)), keys: [
          meta(p, true, true), meta(p, true, false), meta(p, false, false), meta(v.vaultMint, false, true), meta(v.volt, false, true),
          meta(extra, false, false), meta(v.auth, false, false), meta(whitelist, false, false), meta(v.pool, false, true),
          meta(ata(p, v.mint), false, true), meta(ata(p, v.vaultMint), false, true), meta(cur.roundInfo, false, true),
          meta(cur.roundUnderlyingTokens, false, true), meta(v.pwKey, false, true), meta(cur.epochInfo, false, true),
          meta(ata(FRK_FEES, v.mint), false, true), meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false), meta(ID.RENT, false, false)] })] : [];
        const ixs = p => [...head(p), ...withdraw(p), ...closeWsol(p, v.mint)];
        const m = await measure(pk, ixs(pk), [v.mint]);
        if (!m || m.value <= 0) continue;
        items.push({ key: v.volt, value: m.value, label: "Friktion volt " + short(v.volt) + " · " + describe(m.got), ixs });
      }
      return { items: items.sort((a, b) => b.value - a.value) };
    },
  });

  // ------------------------------------------------------------------ Solend (Save) deposits in dead reserves
  // SPL token-lending fork So1end…. Obligation (1300 bytes): market @10, owner @42, deposits_len @202, borrows_len
  //   @203, deposits @204 (88 bytes each: reserve, deposited cTokens u64 @+32). Reserve (619): last_update slot @1,
  //   market @10, liquidity mint @42, liquidity supply @75, available u64 @171, borrowed wads u128 @179,
  //   collateral mint @227, collateral supply u64 @259, collateral supply account @267, protocol fees wads @373.
  //   Market authority = createProgramAddress([market, market[1]]).
  // Tag 15 WithdrawObligationCollateralAndRedeemReserveCollateral(u64 cTokens) accrues interest itself and needs no
  //   oracle when the obligation has no borrows; remaining accounts = every reserve still in the obligation.
  // Only reserves nobody has touched for 30 days (markets that were wound down) are offered; obligations with
  // borrows need live oracles and are left out. A reserve that lent out its liquidity pays at most what it holds.
  const SOLEND = P("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");
  const STALE_SLOTS = 6_500_000n;                          // ~30 days
  // cTokens that `avail` liquidity can pay for, 0.01% below the edge (interest accrues inside the transaction).
  const capFor = (avail, totalWads, csupply) => { if (totalWads <= 0n) return 0n; const c = avail * csupply * WAD / totalWads; return c - c / 10000n - 1n; };
  RC.registerSource({
    id: "solend-dead", title: "Solend deposits in wound-down markets", group: "escrow", perTx: 1, programs: [SOLEND],
    async scan(pk) {
      const obls = await gpa(SOLEND, [{ dataSize: 1300 }, { memcmp: { offset: 42, bytes: b58(pk) } }]);
      if (!obls.length) return { items: [] };
      const slot = BigInt(await (await RC.rpc()).getSlot("confirmed"));
      let borrowed = 0, tooBig = 0;
      const parsed = obls.map(({ pubkey, account: { data: d } }) => {
        const deps = [];
        for (let i = 0, o = 204; i < d[202]; i++, o += 88) deps.push({ reserve: key(d, o), amt: le(d, o + 32) });
        return { obl: pubkey, market: key(d, 10), deps, borrows: d[203] };
      }).filter(o => o.deps.some(x => x.amt > 0n) && (o.borrows === 0 || (borrowed++, false)));
      const resKeys = [...new Set(parsed.flatMap(o => o.deps.map(x => b58(x.reserve))))].map(P);
      const mkKeys = [...new Set(parsed.map(o => b58(o.market)))].map(P);
      const [resInfos, mkInfos] = await Promise.all([readAccounts(resKeys), readAccounts(mkKeys)]);
      const R = new Map(resKeys.map((k, i) => [b58(k), resInfos[i]])), M = new Map(mkKeys.map((k, i) => [b58(k), mkInfos[i]]));
      const items = [];
      for (const o of parsed) {
        const mk = M.get(b58(o.market));
        if (!mk) continue;
        const auth = W.PublicKey.createProgramAddressSync([o.market.toBytes(), Uint8Array.of(mk.data[1])], SOLEND);
        // One item per obligation: every withdrawal must list the reserves still in the obligation, so they go together.
        let remaining = o.deps.map(x => x.reserve);
        const parts = [], mints = [];
        let capped = false;
        for (const dp of o.deps) {
          const r = R.get(b58(dp.reserve));
          if (!r || dp.amt === 0n || le(r.data, 1) + STALE_SLOTS > slot) continue;
          const d = r.data;
          const res = { mint: key(d, 42), supply: key(d, 75), cmint: key(d, 227), csupplyAcc: key(d, 267) };
          const build = (amt, rem) => p => [createAta(p, res.cmint), createAta(p, res.mint),
            new W.TransactionInstruction({ programId: SOLEND, data: cat(Uint8Array.of(15), u64(amt)), keys: [
              meta(res.csupplyAcc, false, true), meta(ata(p, res.cmint), false, true), meta(dp.reserve, false, true), meta(o.obl, false, true),
              meta(o.market, false, true), meta(auth, false, false), meta(ata(p, res.mint), false, true), meta(res.cmint, false, true),
              meta(res.supply, false, true), meta(p, true, false), meta(p, true, false), meta(ID.TOKEN, false, false),
              ...rem.map(x => meta(x, false, true))] }),
            ...closeWsol(p, res.mint)];
          // Cap to the reserve's available liquidity, read after interest accrual from a tiny simulated withdrawal.
          let amt = dp.amt;
          const total = le(d, 171) * WAD + u128(d, 179) - u128(d, 373);
          if (amt >= capFor(le(d, 171), total, le(d, 259))) {
            const probe = await simAccounts(pk, build(amt < 1000n ? amt : 1000n, remaining)(pk), [dp.reserve]);
            if (!probe) continue;
            const e = probe[0].data;
            const cap = capFor(le(e, 171), le(e, 171) * WAD + u128(e, 179) - u128(e, 373), le(e, 259));
            if (amt > cap) { amt = cap; capped = true; }
          }
          if (amt <= 0n) continue;
          parts.push(build(amt, remaining));
          mints.push(res.mint);
          if (amt === dp.amt) remaining = remaining.filter(x => !x.equals(dp.reserve));
        }
        if (!parts.length) continue;
        const ixs = p => parts.flatMap(f => f(p));
        if (!fitsOneTx(pk, ixs(pk))) { tooBig++; continue; }
        const m = await measure(pk, ixs(pk), mints);
        if (!m || m.value <= 0) continue;
        items.push({ key: o.obl, value: m.value, ixs,
          label: "Solend " + short(o.market) + " · " + describe(m.got) + (capped ? " (all the reserve still holds)" : "") });
      }
      return { items: items.sort((a, b) => b.value - a.value),
        note: [borrowed ? borrowed + " obligation(s) with open borrows were skipped: repaying needs working price feeds." : "",
          tooBig ? tooBig + " obligation(s) hold too many deposits for one transaction." : ""].filter(Boolean).join(" ") };
    },
  });

  // ------------------------------------------------------------------ Port Finance deposits
  // Port Finance (Port7u…LfR, token-lending fork) is shut down; the deployed program lets a deposit without borrows
  // be withdrawn without a refresh. Obligation (916 bytes): market @10, owner @42, deposits_len @138,
  //   borrows_len @139, deposits @140 (56 bytes: reserve, cTokens u64 @+32). Reserve (575): market @10,
  //   liquidity mint @42, liquidity supply @75, available @175, borrowed wads u128 @183, collateral mint @231,
  //   collateral supply u64 @263, collateral supply account @271, staking pool flag @327 / pool @328.
  // WithdrawObligationCollateral (tag 9, u64) → cTokens to the wallet; if the reserve has a staking pool, also the
  //   wallet's stake account (stkarv…, 233 bytes: owner @17, pool @49), the pool and that program. Then
  //   RedeemReserveCollateral (tag 5, u64) → the liquidity to the wallet's ATA. Capped to available liquidity.
  const PORT = P("Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR");
  const PORT_STAKE = P("stkarvwmSzv2BygN5e2LeTwimTczLWHCKPKGC2zVLiq");
  RC.registerSource({
    id: "port", title: "Port Finance deposits", group: "escrow", perTx: 1, programs: [PORT],
    async scan(pk) {
      const obls = await gpa(PORT, [{ dataSize: 916 }, { memcmp: { offset: 42, bytes: b58(pk) } }]);
      if (!obls.length) return { items: [] };
      let borrowed = 0;
      const parsed = obls.map(({ pubkey, account: { data: d } }) => {
        const deps = [];
        for (let i = 0, o = 140; i < d[138]; i++, o += 56) deps.push({ reserve: key(d, o), amt: le(d, o + 32) });
        return { obl: pubkey, market: key(d, 10), deps, borrows: d[139] };
      }).filter(o => o.deps.some(x => x.amt > 0n) && (o.borrows === 0 || (borrowed++, false)));
      if (!parsed.length) return { items: [], note: borrowed ? borrowed + " position(s) with open borrows were skipped." : "" };
      const resKeys = [...new Set(parsed.flatMap(o => o.deps.map(x => b58(x.reserve))))].map(P);
      const mkKeys = [...new Set(parsed.map(o => b58(o.market)))].map(P);
      const [resInfos, mkInfos] = await Promise.all([readAccounts(resKeys), readAccounts(mkKeys)]);
      const R = new Map(resKeys.map((k, i) => [b58(k), resInfos[i]])), M = new Map(mkKeys.map((k, i) => [b58(k), mkInfos[i]]));
      let stakes = null;
      const items = [];
      for (const o of parsed) {
        const mk = M.get(b58(o.market));
        if (!mk) continue;
        const auth = W.PublicKey.createProgramAddressSync([o.market.toBytes(), Uint8Array.of(mk.data[1])], PORT);
        for (const dp of o.deps) {
          const r = R.get(b58(dp.reserve));
          if (!r || dp.amt === 0n) continue;
          const d = r.data;
          const res = { mint: key(d, 42), supply: key(d, 75), cmint: key(d, 231), csupplyAcc: key(d, 271), pool: d[327] ? key(d, 328) : null };
          let stake = [];
          if (res.pool) {
            stakes = stakes || await gpa(PORT_STAKE, [{ dataSize: 233 }, { memcmp: { offset: 17, bytes: b58(pk) } }]);
            const s = stakes.find(x => key(x.account.data, 49).equals(res.pool));
            if (!s) continue;
            stake = [meta(s.pubkey, false, true), meta(res.pool, false, true), meta(PORT_STAKE, false, false)];
          }
          const build = amt => p => [createAta(p, res.cmint), createAta(p, res.mint),
            new W.TransactionInstruction({ programId: PORT, data: cat(Uint8Array.of(9), u64(amt)), keys: [
              meta(res.csupplyAcc, false, true), meta(ata(p, res.cmint), false, true), meta(dp.reserve, false, true), meta(o.obl, false, true),
              meta(o.market, false, false), meta(auth, false, false), meta(p, true, false), meta(ID.CLOCK, false, false),
              meta(ID.TOKEN, false, false), ...stake] }),
            new W.TransactionInstruction({ programId: PORT, data: cat(Uint8Array.of(5), u64(amt)), keys: [
              meta(ata(p, res.cmint), false, true), meta(ata(p, res.mint), false, true), meta(dp.reserve, false, true),
              meta(res.cmint, false, true), meta(res.supply, false, true), meta(o.market, false, false), meta(auth, false, false),
              meta(p, true, false), meta(ID.CLOCK, false, false), meta(ID.TOKEN, false, false)] }),
            ...closeWsol(p, res.mint)];
          let amt = dp.amt;
          if (amt >= capFor(le(d, 175), le(d, 175) * WAD + u128(d, 183), le(d, 263))) {
            const probe = await simAccounts(pk, build(amt < 1000n ? amt : 1000n)(pk), [dp.reserve]);
            if (!probe) continue;
            const e = probe[0].data;
            const cap = capFor(le(e, 175), le(e, 175) * WAD + u128(e, 183), le(e, 263));
            if (amt > cap) amt = cap;
          }
          if (amt <= 0n) continue;
          const ixs = build(amt);
          const m = await measure(pk, ixs(pk), [res.mint, res.cmint]);
          if (!m || m.value <= 0) continue;
          items.push({ key: dp.reserve, value: m.value, ixs,
            label: "Port " + (res.pool ? "staked " : "") + "deposit · " + describe(m.got.filter(g => !g.mint.equals(res.cmint)))
              + (amt < dp.amt ? " (all the reserve still holds)" : "") });
        }
      }
      return { items: items.sort((a, b) => b.value - a.value),
        note: borrowed ? borrowed + " position(s) with open borrows were skipped: repaying needs working price feeds." : "" };
    },
  });

  // ------------------------------------------------------------------ abandoned SPL stake pools
  // Stake pools (SPL stake-pool program and Sanctum's two deployments of it) whose operator stopped updating them:
  // the pool token has no market, but the pool still holds SOL. StakePool: account_type 1 @0, validator_list @98,
  //   reserve @130, pool_mint @162, manager_fee_account @194, token_program @226, total_lamports @258,
  //   pool_token_supply @266, last_update_epoch @274, then variable-length fee fields (sol_withdraw_authority is an
  //   Option<Pubkey> after them). ValidatorList: count u32 @5, entries of 73 bytes @9 (transient seed u64 @+24,
  //   validator seed u32 @+36, vote account @+41). Withdraw authority = PDA [pool, "withdraw"]; validator stake
  //   = PDA [vote, pool, (seed u32 if non-zero)], transient = PDA ["transient", vote, pool, seed u64].
  // A pool not updated this epoch refuses withdrawals, so the item first runs the permissionless updates
  //   (UpdateValidatorListBalance 06 over all validators, UpdateStakePoolBalance 07, Cleanup 08; harmless if
  //   someone already ran them), then WithdrawSol (16, u64 pool tokens) pays SOL from the reserve to the wallet.
  // Only pools not updated for 10+ epochs, with at most 6 validators and no SOL-withdraw authority. SOL delegated
  //   to validators: when the reserve can't pay, WithdrawStake (10) splits it into a stake account for the wallet.
  const POOL_PROGRAMS = ["SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy", "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY",
    "SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn"].map(P);
  const STAKE = P("Stake11111111111111111111111111111111111111");
  function poolFields(d) {
    let o = 330;
    const fee = () => { o += 16; }, fut = () => { if (d[o++]) o += 16; }, opt = () => { const some = d[o++]; const k = some ? key(d, o) : null; if (some) o += 32; return k; };
    fee(); fut(); opt(); opt(); fee(); fee(); fut(); o++;      // epoch fee … stake referral fee
    opt(); fee(); o++;                                        // sol deposit authority, sol deposit fee, sol referral fee
    return { validatorList: key(d, 98), reserve: key(d, 130), mint: key(d, 162), managerFee: key(d, 194),
      tokenProgram: key(d, 226), lastEpoch: le(d, 274), solWithdrawAuthority: opt() };
  }
  RC.registerSource({
    id: "dead-stake-pools", title: "Abandoned stake pools", group: "escrow", perTx: 1, programs: POOL_PROGRAMS,
    async scan(pk) {
      const mine = new Map();
      for (const tp of [ID.TOKEN, ID.TOKEN22]) for (const { pubkey, account } of await walletTokens(pk, tp)) {
        const info = account.data?.parsed?.info;
        if (info && info.state === "initialized" && info.tokenAmount.amount !== "0") mine.set(info.mint, { src: pubkey, amount: BigInt(info.tokenAmount.amount) });
      }
      if (!mine.size) return { items: [] };
      const lists = await Promise.all(POOL_PROGRAMS.map(prog => gpa(prog, [{ memcmp: { offset: 0, bytes: "2" } }], { offset: 162, length: 120 })));
      const epoch = BigInt((await (await RC.rpc()).getEpochInfo("confirmed")).epoch);
      const hits = [];
      lists.forEach((list, i) => { for (const { pubkey, account } of list) {
        const m = b58(key(account.data, 0));
        if (mine.has(m) && le(account.data, 112) + 10n <= epoch) hits.push({ prog: POOL_PROGRAMS[i], pool: pubkey, ...mine.get(m) });
      } });
      if (!hits.length) return { items: [] };
      const infos = await readAccounts(hits.map(h => h.pool));
      const items = [];
      let big = 0;
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i], f = infos[i] && poolFields(infos[i].data);
        if (!f || f.solWithdrawAuthority || !(f.tokenProgram.equals(ID.TOKEN) || f.tokenProgram.equals(ID.TOKEN22))) continue;
        const [vl] = await readAccounts([f.validatorList]);
        if (!vl) continue;
        const n = new DataView(vl.data.buffer, vl.data.byteOffset).getUint32(5, true);
        if (n > 6) { big++; continue; }
        const withdrawAuth = pda([h.pool.toBytes(), RC.enc("withdraw")], h.prog)[0];
        const pairs = [];
        for (let j = 0, o = 9; j < n; j++, o += 73) {
          const vd = vl.data, vote = key(vd, o + 41), seed = new DataView(vd.buffer, vd.byteOffset).getUint32(o + 36, true);
          pairs.push(pda([vote.toBytes(), h.pool.toBytes(), ...(seed ? [u32(seed)] : [])], h.prog)[0],
            pda([RC.enc("transient"), vote.toBytes(), h.pool.toBytes(), u64(le(vd, o + 24))], h.prog)[0]);
        }
        const amount = h.amount;
        const update = [
          ...(n ? [new W.TransactionInstruction({ programId: h.prog, data: cat(Uint8Array.of(6), u32(0), Uint8Array.of(0)), keys: [
            meta(h.pool, false, false), meta(withdrawAuth, false, false), meta(f.validatorList, false, true), meta(f.reserve, false, true),
            meta(ID.CLOCK, false, false), meta(ID.STAKE_HISTORY, false, false), meta(STAKE, false, false),
            ...pairs.map(k => meta(k, false, true))] })] : []),
          new W.TransactionInstruction({ programId: h.prog, data: Uint8Array.of(7), keys: [
            meta(h.pool, false, true), meta(withdrawAuth, false, false), meta(f.validatorList, false, true), meta(f.reserve, false, false),
            meta(f.managerFee, false, true), meta(f.mint, false, true), meta(f.tokenProgram, false, false)] }),
          new W.TransactionInstruction({ programId: h.prog, data: Uint8Array.of(8), keys: [meta(h.pool, false, false), meta(f.validatorList, false, true)] })];
        const label = "stake pool " + short(h.pool) + " · " + fmt(amount, 9) + " " + short(f.mint) + " → ";
        // 1) SOL straight from the pool's reserve.
        const solIxs = p => [...update, new W.TransactionInstruction({ programId: h.prog, data: cat(Uint8Array.of(16), u64(amount)), keys: [
          meta(h.pool, false, true), meta(withdrawAuth, false, false), meta(p, true, false), meta(h.src, false, true),
          meta(f.reserve, false, true), meta(p, false, true), meta(f.managerFee, false, true), meta(f.mint, false, true),
          meta(ID.CLOCK, false, false), meta(ID.STAKE_HISTORY, false, false), meta(STAKE, false, false), meta(f.tokenProgram, false, false)] })];
        const m = await measure(pk, solIxs(pk), []);
        if (m && m.value > 0) { items.push({ key: h.pool, value: m.value, ixs: solIxs, label: label + fmt(BigInt(m.value), 9) + " SOL" }); continue; }
        // 2) The reserve can't pay: split the SOL off the pool's largest validator stake into a new stake account at a
        //    seed address of the wallet (createAccountWithSeed, no extra signer); its staker and withdrawer are the
        //    wallet. It is then deactivated and withdrawn like any stake account (see "Deactivated stake accounts").
        if (!n) continue;
        let best = -1;
        for (let j = 0, o = 9; j < n; j++, o += 73) if (best < 0 || le(vl.data, o) > le(vl.data, 9 + best * 73)) best = j;
        const seed = "reclaim-" + b58(h.pool).slice(0, 24);
        const dest = await W.PublicKey.createWithSeed(pk, seed, STAKE);
        const [destInfo] = await readAccounts([dest]);
        if (destInfo) continue;                              // already split once: it's in the wallet's stake accounts
        const rent = await (await RC.rpc()).getMinimumBalanceForRentExemption(200);
        const seedBytes = RC.enc(seed);
        const stakeIxs = p => [...update,
          new W.TransactionInstruction({ programId: ID.SYSTEM, keys: [meta(p, true, true), meta(dest, false, true), meta(p, true, false)],
            data: cat(u32(3), p.toBytes(), u64(seedBytes.length), seedBytes, u64(rent), u64(200), STAKE.toBytes()) }),
          new W.TransactionInstruction({ programId: h.prog, data: cat(Uint8Array.of(10), u64(amount)), keys: [
            meta(h.pool, false, true), meta(f.validatorList, false, true), meta(withdrawAuth, false, false), meta(pairs[2 * best], false, true),
            meta(dest, false, true), meta(p, false, false), meta(p, true, false), meta(h.src, false, true), meta(f.managerFee, false, true),
            meta(f.mint, false, true), meta(ID.CLOCK, false, false), meta(f.tokenProgram, false, false), meta(STAKE, false, false)] })];
        const after = await simAccounts(pk, stakeIxs(pk), [dest]);
        if (!after || !after[0]) continue;
        const value = after[0].lamports - rent;               // the wallet paid the rent; it comes back with the stake
        if (value <= 0) continue;
        items.push({ key: h.pool, value, ixs: stakeIxs,
          label: label + fmt(BigInt(after[0].lamports), 9) + " SOL as a stake account (deactivate it, then withdraw)" });
      }
      return { items: items.sort((a, b) => b.value - a.value),
        note: big ? big + " abandoned pool position(s) skipped: the pool has too many validators to update in one transaction." : "" };
    },
  });

  // ------------------------------------------------------------------ Jet v1 deposits
  // Jet v1 (JPv1rC…, Anchor, wound down): one market 9oiXza…, four reserves (USDC, SOL, BTC, ETH). Per wallet:
  //   obligation PDA ["obligation", market, wallet]; deposit-notes account ["deposits", reserve, wallet];
  //   collateral-notes account ["collateral", reserve, obligation, wallet] (SPL token accounts owned by the program).
  // Item per reserve: refresh_reserve ×8 (permissionless; accrues interest in bounded steps), withdraw_collateral
  //   (bumps + Amount{units 1 = deposit notes, value}) from the obligation into the deposit account, then
  //   close_deposit_account, which redeems every note to the wallet's token account and returns the rent. SOL is
  //   received as wSOL and unwrapped. Only positions whose deposit account still exists (no borrows checked by the program).
  const JET1 = P("JPv1rCqrhagNNmJVM5J1he7msQ5ybtvE1nNuHpDHMNU");
  const JET1_MARKET = P("9oiXzad28vLhT2TkFoVRRRcwYKrSF7E3XPUJpwcarCAo"), JET1_AUTH = P("7gpj9cpzBBW9Ci1yMwWz7iGbQYpm5fZmadNQyrYsqch8");
  const JET1_RESERVES = [
    ["USDC", "3ARjV1TvKbQoHAFyQW5P85F7AX5U58Hm2zwTRHGN4v4A", "63AEVgBicvYeaEwoTr8tkURPnszuB2H1pMBUoNnUPjTN", "APU2N1S1qgLpQgpZFTocNuvuL7uNSMVX7X2J1QtAz1sY", "GwbEoYmrmYToCNpEvnhMuVw6hmvRWn6QBFYJCwGfEDAT", "Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    ["SOL", "HBD5vNf9a7nnGyfXHEWHZN8Y6bKquB9mSzj6tbcqoXXZ", "DvM98WWqFFAeCQi1QJbFREkHetRREqiymHBfaPckdHR3", "5VLVVw7g89XY9PVEvsxcMuM6YMuZCjw9ZX1SseV8fsgS", "2YuVnXkSmW714ziXkfPfmvAnniBc1tHiAB7gYgRpx43a", "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG", "So11111111111111111111111111111111111111112"],
    ["BTC", "GqPX7JNRKQ9eTqUxG9zZUm5zQqKSv2gnWqRzLRz6hN29", "5xMkycaRErjMYYJYktpVvXb72EC4bpF2GTNpmsnaGgz", "EkY4ST7xnPJjargggtX1mof7puzYD6ojMuZAYG2KFY4F", "AA8Aq7q6VixAqwp2xGFpBYt9Ck3iXmr7ZK3VT1naiTpS", "GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU", "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E"],
    ["ETH", "2X39AAQzsY7YFLvoLQ5kSd7cJDLn5EEDkgFrFUfqhG1M", "FPwT6PEYNJvN2i9Pnz4rD9xS72fgStRdNGXq1kSVGeMH", "ArUf8kRgWnWu7qVCfQUE5SkEz4eMA5MauYEqsSJo2ApL", "65zGnhqrsqFKABMupVjU9FXVJLFzzH9aXGyVjnAzdB8A", "JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB", "2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk"],
  ].map(([name, reserve, vault, feeVault, noteMint, pyth, mint]) => ({ name, reserve: P(reserve), vault: P(vault), feeVault: P(feeVault),
    noteMint: P(noteMint), pyth: P(pyth), mint: P(mint) }));
  RC.registerSource({
    id: "jet-v1", title: "Jet v1 deposits", group: "escrow", perTx: 1, programs: [JET1],
    async scan(pk) {
      const E = RC.enc;
      const oblig = pda([E("obligation"), JET1_MARKET.toBytes(), pk.toBytes()], JET1)[0];
      const acc = JET1_RESERVES.map(r => ({ r, dep: pda([E("deposits"), r.reserve.toBytes(), pk.toBytes()], JET1),
        col: pda([E("collateral"), r.reserve.toBytes(), oblig.toBytes(), pk.toBytes()], JET1) }));
      const infos = await readAccounts(acc.flatMap(a => [a.dep[0], a.col[0]]));
      const [dRefresh, dWithdrawCol, dClose] = await Promise.all(["refresh_reserve", "withdraw_collateral", "close_deposit_account"].map(disc));
      const items = [];
      let noDeposit = 0;
      for (let i = 0; i < acc.length; i++) {
        const { r, dep, col } = acc[i], di = infos[2 * i], ci = infos[2 * i + 1];
        const colNotes = ci ? tokAmount(ci) : 0n, depNotes = di ? tokAmount(di) : 0n;
        if (colNotes === 0n && depNotes === 0n) continue;
        if (!di) { noDeposit++; continue; }
        const ixs = p => [createAta(p, r.mint),
          ...Array.from({ length: 8 }, () => new W.TransactionInstruction({ programId: JET1, data: dRefresh, keys: [
            meta(JET1_MARKET, false, true), meta(JET1_AUTH, false, false), meta(r.reserve, false, true), meta(r.feeVault, false, true),
            meta(r.noteMint, false, true), meta(r.pyth, false, false), meta(ID.TOKEN, false, false)] })),
          ...(colNotes > 0n ? [new W.TransactionInstruction({ programId: JET1, data: cat(dWithdrawCol, Uint8Array.of(col[1], dep[1], 1), u64(colNotes)), keys: [
            meta(JET1_MARKET, false, false), meta(JET1_AUTH, false, false), meta(r.reserve, false, false), meta(oblig, false, true),
            meta(p, true, false), meta(dep[0], false, true), meta(col[0], false, true), meta(ID.TOKEN, false, false)] })] : []),
          new W.TransactionInstruction({ programId: JET1, data: cat(dClose, Uint8Array.of(dep[1])), keys: [
            meta(JET1_MARKET, false, false), meta(JET1_AUTH, false, false), meta(r.reserve, false, true), meta(r.vault, false, true),
            meta(r.noteMint, false, true), meta(p, true, true), meta(dep[0], false, true), meta(ata(p, r.mint), false, true), meta(ID.TOKEN, false, false)] }),
          ...closeWsol(p, r.mint)];
        const m = await measure(pk, ixs(pk), [r.mint]);
        if (!m || m.value <= 0) continue;
        items.push({ key: dep[0], value: m.value, ixs, label: "Jet v1 " + r.name + " deposit · " + describe(m.got) });
      }
      return { items: items.sort((a, b) => b.value - a.value),
        note: noDeposit ? noDeposit + " Jet v1 position(s) skipped: their deposit account was closed." : "" };
    },
  });

  // ------------------------------------------------------------------ Jet v2 margin-pool deposits
  // Jet v2 (margin JPMRGN…, margin pools JPPooL…, Anchor, wound down). MarginAccount (7544 bytes): owner @16;
  //   positions @1400, 32 × 192 bytes: token (deposit-note mint) @0, token account @32, adapter @64, balance u64 @112,
  //   kind u32 @152 (1 = deposit). MarginPool: vault @10, deposit-note mint @74, token mint @138, price oracle @170.
  // Per deposit position: margin.accounting_invoke(pool.margin_refresh_position) then margin.adapter_invoke(pool.withdraw
  //   {change_kind: SetTo, amount: 0}) → the whole position is paid to the wallet's token account (SOL as wSOL, unwrapped).
  //   Accounts copied from mainnet tx DFa4Lzyj…; FVAyEs… is the margin program's config for the pool adapter.
  const JET_MARGIN = P("JPMRGNgRk3w2pzBM1RLNBnpGxQYsFQ3yXKpuk4tTXVZ"), JET_POOL = P("JPPooLEqRo3NCSx82EdE2VZY5vUaSsgskpZPBHNGVLZ");
  const JET_ADAPTER = P("FVAyEsyT4XahfZXMRfwu5vYHANsmxx5YmpHYBRd9jgbj");
  const hex = s => Uint8Array.from(s.match(/../g), x => parseInt(x, 16));
  RC.registerSource({
    id: "jet-v2", title: "Jet v2 margin deposits", group: "escrow", perTx: 1, programs: [JET_MARGIN, JET_POOL],
    async scan(pk) {
      const accts = await gpa(JET_MARGIN, [{ dataSize: 7544 }, { memcmp: { offset: 16, bytes: b58(pk) } }]);
      const pos = [];
      for (const { pubkey, account: { data: d } } of accts)
        for (let i = 0, o = 1400; i < 32; i++, o += 192)
          if (key(d, o + 64).equals(JET_POOL) && new DataView(d.buffer, d.byteOffset).getUint32(o + 152, true) === 1 && le(d, o + 112) > 0n)
            pos.push({ margin: pubkey, noteMint: key(d, o), src: key(d, o + 32) });
      if (!pos.length) return { items: [] };
      const pools = await gpa(JET_POOL, [{ dataSize: 352 }]);
      const byNote = new Map(pools.map(({ pubkey, account: { data: d } }) => [b58(key(d, 74)),
        { pool: pubkey, vault: key(d, 10), noteMint: key(d, 74), mint: key(d, 138), oracle: key(d, 170) }]));
      const dAccounting = hex("6077c58acfb2c69b"), dAdapter = hex("5f84c49fbd47a875");
      const [dRefresh, dWithdraw] = await Promise.all(["margin_refresh_position", "withdraw"].map(disc));
      const items = [];
      for (const x of pos) {
        const pl = byNote.get(b58(x.noteMint));
        if (!pl) continue;
        const ixs = p => [createAta(p, pl.mint),
          new W.TransactionInstruction({ programId: JET_MARGIN, data: cat(dAccounting, u32(8), dRefresh), keys: [
            meta(x.margin, false, true), meta(JET_POOL, false, false), meta(JET_ADAPTER, false, false),
            meta(x.margin, false, true), meta(pl.pool, false, false), meta(pl.oracle, false, false)] }),
          new W.TransactionInstruction({ programId: JET_MARGIN, data: cat(dAdapter, u32(17), dWithdraw, Uint8Array.of(0), u64(0)), keys: [
            meta(p, true, true), meta(x.margin, false, true), meta(JET_POOL, false, false), meta(JET_ADAPTER, false, false),
            meta(x.margin, false, true), meta(pl.pool, false, true), meta(pl.vault, false, true), meta(pl.noteMint, false, true),
            meta(x.src, false, true), meta(ata(p, pl.mint), false, true), meta(ID.TOKEN, false, false)] }),
          ...closeWsol(p, pl.mint)];
        const m = await measure(pk, ixs(pk), [pl.mint]);
        if (!m || m.value <= 0) continue;
        items.push({ key: x.src, value: m.value, ixs, label: "Jet v2 deposit · " + describe(m.got) });
      }
      return { items: items.sort((a, b) => b.value - a.value) };
    },
  });

  // ------------------------------------------------------------------ Francium lending deposit tokens
  // Francium lending (FC81tb…, token-lending fork, wound down). Reserve (495 bytes): market @10, liquidity mint @42,
  //   liquidity supply @75, collateral (deposit-token) mint @223. One market 4XNif2…, authority sCDiYj….
  //   RedeemReserveCollateral (tag 5, u64): the wallet's deposit tokens → the underlying to its ATA, no refresh needed.
  //   Accounts: source, destination, reserve, collateral mint, liquidity supply, market, authority, owner, clock, token.
  const FRANCIUM = P("FC81tbGt6JWRXidaWYFXxGnTk4VgobhJHATvTRVMqgWj");
  const FR_MARKET = P("4XNif294wbrxj6tJ8K5Rg7SuaEACnu9s2L27i28MQB6E"), FR_AUTH = P("sCDiYj7X7JmXg5fVq2nqED2q1Wqjo7PnqMgH3casMem");
  RC.registerSource({
    id: "francium", title: "Francium lending deposits", group: "escrow", perTx: 2, programs: [FRANCIUM],
    async scan(pk) {
      const held = await walletTokens(pk);
      if (!held.length) return { items: [] };
      const reserves = await gpa(FRANCIUM, [{ dataSize: 495 }], { offset: 0, length: 255 });
      const byColl = new Map();
      for (const { pubkey, account: { data: d } } of reserves)
        if (key(d, 10).equals(FR_MARKET)) byColl.set(b58(key(d, 223)), { reserve: pubkey, mint: key(d, 42), supply: key(d, 75), cmint: key(d, 223) });
      const items = [];
      for (const { pubkey, account } of held) {
        const info = account.data?.parsed?.info, r = info && byColl.get(info.mint);
        if (!r || info.tokenAmount.amount === "0" || info.state !== "initialized") continue;
        const amt = BigInt(info.tokenAmount.amount);
        const ixs = p => [createAta(p, r.mint),
          new W.TransactionInstruction({ programId: FRANCIUM, data: cat(Uint8Array.of(5), u64(amt)), keys: [
            meta(pubkey, false, true), meta(ata(p, r.mint), false, true), meta(r.reserve, false, true), meta(r.cmint, false, true),
            meta(r.supply, false, true), meta(FR_MARKET, false, false), meta(FR_AUTH, false, false), meta(p, true, false),
            meta(ID.CLOCK, false, false), meta(ID.TOKEN, false, false)] }),
          ...closeWsol(p, r.mint)];
        const m = await measure(pk, ixs(pk), [r.mint]);
        if (!m || m.value <= 0) continue;
        items.push({ key: pubkey, value: m.value, ixs, label: "Francium deposit · " + describe(m.got) });
      }
      return { items: items.sort((a, b) => b.value - a.value) };
    },
  });
})();
