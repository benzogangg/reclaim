"use strict";
// Staked tokens whose unstaking is finished but were never withdrawn. Only matured amounts the owner can take in
// one step, alone; nothing here starts an unstake. Tokens go to the wallet's own token account (created
// idempotently when missing; its rent is subtracted from the value).
//
// Jupiter JUP staking, Locked Voter (voTpe3…). Escrow 322 bytes, PDA ['Escrow', locker, owner]: locker @8,
//   owner @40, tokens (escrow's token account) @73, amount u64 @105, escrow_ends_at i64 @121, is_max_lock @161,
//   partial_unstaking_amount u64 @162. Locker: token_mint @41. PartialUnstaking (disc 'account:PartialUnstaking'):
//   escrow @8, amount u64 @40, expiration i64 @48.
//   - `withdraw_partial_unstaking` once expiration ≤ now: pays that amount to the owner's token account and closes
//     the PartialUnstaking account (rent to the owner). Accounts: locker, escrow, partial, owner, escrow tokens,
//     destination, payer (= owner), token program.
//   - `withdraw` once the escrow is not max-locked and escrow_ends_at ≤ now (the 30-day cooldown after "unstake"
//     is over): pays escrow.amount and closes the escrow (rent to the owner). Offered only when no partial
//     unstake is still open on the escrow. Accounts: locker, escrow, owner, escrow tokens, destination, payer, token.
// Pyth staking (pytS9…, also used by Oracle Integrity Staking): PositionData (owner @8, then 200-byte slots from
//   @40, each Option<Position{amount u64, activation_epoch u64, unlocking_start Option<u64>, target enum}>),
//   metadata PDA ['stake_metadata', positions] (lock/vesting enum @44), custody token account
//   PDA ['custody', positions], authority PDA ['authority', positions], config PDA ['config'] (epoch_duration @106,
//   pyth_token_list_time Option<i64> @179). Epoch = unix time / epoch_duration; a position counts as locked until
//   unlocking_start + 1 ≤ epoch. `withdraw_stake(amount)` pays up to
//   min(vested, custody − governance exposure, vested − integrity-pool exposure) (utils/risk.rs) to a token
//   account owned by the owner.
// BONK staking / Bonk Rewards (STAKEk…, mithraiclabs spl-token-staking): StakeDepositReceipt 304 bytes: owner @8,
//   stake_pool @72, lockup_duration @104, deposit_timestamp @112, deposit_amount @120, effective_stake u128 @128,
//   claimed_amounts[10] u128 @144. StakePool: vault @56, mint @88, stake_mint @120, reward_pools[10] of 64 bytes
//   @152 (reward_vault first). Once deposit_timestamp + lockup_duration ≤ now:
//   - receipts the pool authority already moved to the expired pool (effective_stake = 0, their rewards parked in
//     claimed_amounts[9]; they earn nothing any more): `withdraw_stake_and_expired_rewards` pays the deposit and
//     parked rewards and closes the receipt (rent to the owner). ExpiredRewardPool 170 bytes: reward_vault @8,
//     authority @40, reward_mint @104, stake_pool @136. The authority account is passed but does not sign.
//   - receipts still earning rewards: `withdraw` (pays deposit + rewards, closes the receipt). This ends their
//     rewards, so they are a separate opt-in category.
(() => {
  const { W, P, ID, meta, readAccounts, disc, accDisc, cat, u64, pda, enc, ata, short, b58, valueInLamports } = RC;

  const le = (d, off, n) => { let v = 0n; for (let i = off + n - 1; i >= off; i--) v = (v << 8n) | BigInt(d[i]); return v; };
  const sle = (d, off) => BigInt.asIntN(64, le(d, off, 8));
  const key = (d, off) => new W.PublicKey(d.slice(off, off + 32));
  const same = (d, bytes, off = 0) => bytes.every((x, i) => d[off + i] === x);
  const fmt = (raw, dec) => { const s = Number(raw) / 10 ** dec; return s >= 1000 ? Math.round(s).toLocaleString("en-US") : s >= 1 ? s.toFixed(2) : s.toPrecision(3); };
  const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", PYTH = "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const symbolOf = m => ({ [JUP]: "JUP", [PYTH]: "PYTH", [BONK]: "BONK" })[m] || short(m);

  // RC.gpa, plus a few retries when the indexer answers "overloaded, try again".
  async function gpa(programId, filters, dataSlice) {
    for (let i = 0; ; i++) {
      try { return await RC.gpa(programId, filters, dataSlice); }
      catch (e) { if (i >= 3 || !/overloaded|try again/i.test(String(e?.message || e))) throw e; await RC.sleep(1500 * (i + 1)); }
    }
  }
  // Chain unix time (clock sysvar @32), read once per scan.
  let clockCache = null;
  async function chainTime() {
    if (clockCache && Date.now() - clockCache.t < 20000) return clockCache.ts;
    const [c] = await readAccounts([ID.CLOCK]);
    if (!c) throw new Error("could not read the clock sysvar");
    return (clockCache = { t: Date.now(), ts: sle(c.data, 32) }).ts;
  }
  let rentCache = null;
  const ataRent = () => (rentCache ||= RC.rpc().then(c => c.getMinimumBalanceForRentExemption(165)).catch(e => { rentCache = null; throw e; }));
  const createAta = (p, mint) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(p, mint), false, true), meta(p, false, false), meta(mint, false, false),
    meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] });
  // Decimals of classic-SPL mints (all three tokens here use the classic Token program).
  async function decimals(mints) {
    const list = [...new Set(mints.map(m => typeof m === "string" ? m : b58(m)))], out = {};
    const infos = await readAccounts(list.map(P));
    list.forEach((m, i) => { if (infos[i] && infos[i].owner.equals(ID.TOKEN)) out[m] = infos[i].data[44]; });
    return out;
  }
  // Which of the wallet's token accounts exist, and whether they still belong to the wallet.
  async function existing(keys, pk) {
    const uniq = [...new Map(keys.map(k => [b58(k), k])).values()], infos = await readAccounts(uniq), out = new Map();
    uniq.forEach((k, i) => { if (infos[i]) out.set(b58(k), key(infos[i].data, 32).equals(pk) ? "ok" : "foreign"); });
    return out;
  }
  // Rent of the wallet ATAs an item has to create (only the first item paying into a new ATA pays for it).
  function ataCost(have, rentPaid, rent) {
    return dests => {
      let cost = 0;
      const fresh = [];
      for (const d of dests) { const k = b58(d); if (!have.has(k) && !rentPaid.has(k) && !fresh.includes(k)) { cost += rent; fresh.push(k); } }
      return { cost, take: () => fresh.forEach(k => rentPaid.add(k)) };
    };
  }

  // ---------------------------------------------------------------- Jupiter Locked Voter
  const VOTER = P("voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj");
  RC.registerSource({
    id: "jup-unstaked", title: "Unstaked JUP ready to withdraw", group: "escrow", perTx: 4, programs: [VOTER],
    async scan(pk) {
      const escrows = await gpa(VOTER, [{ dataSize: 322 }, { memcmp: { offset: 40, bytes: b58(pk) } }]);
      if (!escrows.length) return { items: [] };
      const [partialDisc, now] = await Promise.all([accDisc("PartialUnstaking"), chainTime()]);
      const partials = (await Promise.all(escrows.map(e => gpa(VOTER, [{ memcmp: { offset: 8, bytes: b58(e.pubkey) } }]))))
        .map(list => list.filter(x => same(x.account.data, partialDisc)));
      const lockerKeys = [...new Set(escrows.map(e => b58(key(e.account.data, 8))))];
      const lockerInfos = await readAccounts(lockerKeys.map(P)), mintOf = {};
      lockerKeys.forEach((k, i) => { if (lockerInfos[i]?.owner.equals(VOTER)) mintOf[k] = key(lockerInfos[i].data, 41); });

      const cands = [];
      let pending = 0, staked = 0, waitPartial = 0;
      escrows.forEach(({ pubkey, account }, i) => {
        const d = account.data, locker = key(d, 8), mint = mintOf[b58(locker)];
        if (!mint) return;
        const base = { escrow: pubkey, locker, mint, tokens: key(d, 73) };
        for (const { pubkey: partial, account: pa } of partials[i]) {
          const amount = le(pa.data, 40, 8);
          if (sle(pa.data, 48) > now) { pending++; continue; }
          cands.push({ ...base, kind: "partial", key: partial, amount, rent: pa.lamports });
        }
        const amount = le(d, 105, 8), ended = d[161] === 0 && sle(d, 121) <= now;
        if (!ended) { if (amount > le(d, 162, 8)) staked++; return; }
        if (le(d, 162, 8) > 0n) { waitPartial++; return; }     // an open partial unstake: withdraw that first
        cands.push({ ...base, kind: "withdraw", key: pubkey, amount, rent: account.lamports });
      });
      const notes = [];
      if (pending) notes.push(pending + " partial unstake(s) are still in their cooldown.");
      if (waitPartial) notes.push(waitPartial + " unlocked escrow(s) also have a partial unstake open: withdraw that first, then scan again for the rest.");
      if (!cands.length) return { items: [], note: notes.join(" ") };

      // Never promise more than the escrow's token account holds.
      const tokKeys = [...new Set(cands.map(c => b58(c.tokens)))], tokInfos = await readAccounts(tokKeys.map(P)), bal = {};
      tokKeys.forEach((k, i) => { bal[k] = tokInfos[i] ? le(tokInfos[i].data, 64, 8) : 0n; });
      const dec = await decimals(cands.map(c => c.mint));
      const have = await existing(cands.map(c => ata(pk, c.mint)), pk);
      const cost = ataCost(have, new Set(), await ataRent());
      const [partialIx, withdrawIx] = await Promise.all([disc("withdraw_partial_unstaking"), disc("withdraw")]);
      const items = [];
      let foreign = 0;
      // Partial unstakes first: they are paid before the escrow itself is closed.
      for (const c of cands.sort((a, b) => (a.kind === "partial" ? 0 : 1) - (b.kind === "partial" ? 0 : 1))) {
        const d = dec[b58(c.mint)];
        if (d === undefined) continue;
        if (have.get(b58(ata(pk, c.mint))) === "foreign") { foreign++; continue; }
        const k = b58(c.tokens), amount = c.amount <= bal[k] ? c.amount : bal[k];
        bal[k] -= amount;
        const worth = amount > 0n ? await valueInLamports([{ mint: c.mint, amount, decimals: d }]) : 0;
        const r = cost([ata(pk, c.mint)]);
        const value = worth + c.rent - r.cost;
        if (value <= 0 || (amount > 0n && !worth && c.rent <= r.cost)) continue;
        r.take();
        const { kind, escrow, locker, mint, tokens } = c, account = c.key;
        const what = amount > 0n ? fmt(amount, d) + " " + symbolOf(b58(mint)) : "empty";
        items.push({ key: account, value,
          label: (kind === "partial" ? "partial unstake " + short(account) : "escrow " + short(escrow) + " · unstake finished") + " · " + what,
          ixs: p => [createAta(p, mint), kind === "partial"
            ? new W.TransactionInstruction({ programId: VOTER, data: partialIx, keys: [
              meta(locker, false, true),
              meta(escrow, false, true),
              meta(account, false, true),              // PartialUnstaking: closed, rent to the wallet
              meta(p, true, false),                    // owner
              meta(tokens, false, true),               // escrow's JUP account (pays)
              meta(ata(p, mint), false, true),         // wallet's JUP account
              meta(p, true, true),                     // payer (receives the rent)
              meta(ID.TOKEN, false, false)] })
            : new W.TransactionInstruction({ programId: VOTER, data: withdrawIx, keys: [
              meta(locker, false, true),
              meta(escrow, false, true),               // escrow: closed, rent to the wallet
              meta(p, true, false),                    // escrow owner
              meta(tokens, false, true),               // escrow's JUP account (pays)
              meta(ata(p, mint), false, true),         // wallet's JUP account
              meta(p, true, true),                     // payer (receives the rent)
              meta(ID.TOKEN, false, false)] })] });
      }
      if (foreign) notes.push(foreign + " item(s) skipped: the wallet's token account for them belongs to another owner.");
      if (staked) notes.push(staked + " escrow(s) are still staked (not touched).");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });

  // ---------------------------------------------------------------- Pyth staking
  const PYTH_STAKING = P("pytS9TjG1qyAZypk7n8rw8gfW9sUaqqYyMhJQ4E7JCQ");
  const pythPda = (seed, positions) => pda([enc(seed), positions.toBytes()], PYTH_STAKING)[0];
  // Unvested balance, as VestingSchedule::get_unvested_balance (state/vesting.rs).
  function unvested(m, now, listTime) {
    const periodic = (initial, start, period, num) => {
      if (now < start) return initial;
      const passed = period > 0n ? (now - start) / period : num;
      return passed >= num ? 0n : (num - passed) * initial / num;
    };
    if (m[44] === 0) return 0n;
    if (m[44] === 1) return periodic(le(m, 45, 8), sle(m, 53), le(m, 61, 8), le(m, 69, 8));
    if (m[44] === 2) return listTime === null ? le(m, 45, 8) : periodic(le(m, 45, 8), listTime, le(m, 53, 8), le(m, 61, 8));
    return null;
  }
  // Governance and integrity-pool exposure: every position that is not yet UNLOCKED (state/positions.rs).
  function exposure(d, epoch) {
    let voting = 0n, pool = 0n;
    for (let o = 40; o + 200 <= d.length; o += 200) {
      if (d[o] !== 1) continue;
      const amount = le(d, o + 1, 8), activation = le(d, o + 9, 8);
      let q = o + 17, unlockingStart = null;
      if (d[q] === 1) { unlockingStart = le(d, q + 1, 8); q += 9; } else q += 1;
      const unlocked = epoch >= activation && unlockingStart !== null && unlockingStart + 1n <= epoch;
      if (unlocked) continue;
      if (d[q] === 0) voting += amount; else pool += amount;
    }
    return { voting, pool };
  }
  RC.registerSource({
    id: "pyth-unstaked", title: "Unlocked PYTH in Pyth staking", group: "escrow", perTx: 4, programs: [PYTH_STAKING],
    async scan(pk) {
      const posDisc = await accDisc("PositionData");
      const found = (await gpa(PYTH_STAKING, [{ memcmp: { offset: 8, bytes: b58(pk) } }])).filter(x => same(x.account.data, posDisc));
      if (!found.length) return { items: [] };
      const config = pda([enc("config")], PYTH_STAKING)[0];
      const infos = await readAccounts([config, ...found.flatMap(f => [pythPda("stake_metadata", f.pubkey), pythPda("custody", f.pubkey)])]);
      const cfg = infos[0];
      if (!cfg) throw new Error("could not read the Pyth staking config");
      const now = await chainTime(), epochLen = le(cfg.data, 106, 8);
      if (!epochLen) throw new Error("Pyth staking config has no epoch length");
      const epoch = now / epochLen, listTime = cfg.data[179] === 1 ? sle(cfg.data, 180) : null, mint = key(cfg.data, 41);
      const cands = [];
      let locked = 0;
      found.forEach(({ pubkey, account }, i) => {
        const m = infos[1 + 2 * i], c = infos[2 + 2 * i];
        if (!m || !c || !key(m.data, 12).equals(pk)) return;
        const total = le(c.data, 64, 8), unv = unvested(m.data, now, listTime);
        if (!total || unv === null) return;
        const { voting, pool } = exposure(account.data, epoch);
        const vested = total - unv;
        let w = vested;
        if (total - voting < w) w = total - voting;
        if (vested - pool < w) w = vested - pool;
        if (w <= 0n) { locked++; return; }
        if (w < total) locked++;
        cands.push({ positions: pubkey, amount: w, stakedToo: w < total });
      });
      const notes = locked ? [locked + " Pyth staking account(s) still hold staked, unlocking or unvested PYTH (not touched)."] : [];
      if (!cands.length) return { items: [], note: notes.join(" ") };
      const dec = (await decimals([mint]))[b58(mint)];
      if (dec === undefined) throw new Error("could not read the PYTH mint");
      const have = await existing([ata(pk, mint)], pk);
      if (have.get(b58(ata(pk, mint))) === "foreign") return { items: [], note: "The wallet's PYTH token account belongs to another owner; withdraw on staking.pyth.network." };
      const cost = ataCost(have, new Set(), await ataRent()), withdrawIx = await disc("withdraw_stake"), items = [];
      for (const c of cands) {
        const worth = await valueInLamports([{ mint, amount: c.amount, decimals: dec }]);
        const r = cost([ata(pk, mint)]);
        if (worth - r.cost <= 0) continue;
        r.take();
        const { positions, amount } = c;
        const metadata = pythPda("stake_metadata", positions), custody = pythPda("custody", positions), authority = pythPda("authority", positions);
        items.push({ key: positions, value: worth - r.cost,
          label: "staking account " + short(positions) + " · " + fmt(amount, dec) + " PYTH unlocked",
          ixs: p => [createAta(p, mint), new W.TransactionInstruction({ programId: PYTH_STAKING, data: cat(withdrawIx, u64(amount)), keys: [
            meta(p, true, false),                      // owner
            meta(ata(p, mint), false, true),           // destination: wallet's PYTH account
            meta(positions, false, false),
            meta(metadata, false, false),
            meta(custody, false, true),                // custody (pays)
            meta(authority, false, false),
            meta(config, false, false),
            meta(ID.TOKEN, false, false)] })] });
      }
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });

  // ---------------------------------------------------------------- BONK staking (spl-token-staking)
  const BONK_STAKING = P("STAKEkKzbdeKkqzKpLkNQD3SUuLgshDKCD7U8duxAbB");
  const bonkCache = { pk: null, t: 0, v: null };
  async function bonkScan(pk) {
    if (bonkCache.pk && bonkCache.pk.equals(pk) && Date.now() - bonkCache.t < 20000) return bonkCache.v;
    const v = (async () => {
      const receipts = await gpa(BONK_STAKING, [{ dataSize: 304 }, { memcmp: { offset: 8, bytes: b58(pk) } }]);
      if (!receipts.length) return { list: [] };
      const now = await chainTime();
      const done = [];
      let locked = 0;
      for (const { pubkey, account } of receipts) {
        const d = account.data;
        if (sle(d, 112) + sle(d, 104) > now) { locked++; continue; }
        done.push({ receipt: pubkey, pool: key(d, 72), amount: le(d, 120, 8), expired: le(d, 128, 16) === 0n,
          parked: le(d, 144 + 16 * 9, 8), rent: account.lamports });
      }
      if (!done.length) return { list: [], locked };
      const poolKeys = [...new Set(done.map(r => b58(r.pool)))], poolInfos = await readAccounts(poolKeys.map(P)), pools = {};
      poolKeys.forEach((k, i) => {
        const d = poolInfos[i]?.owner.equals(BONK_STAKING) ? poolInfos[i].data : null;
        if (!d) return;
        const rewardVaults = [];
        for (let j = 0; j < 10; j++) { const v = key(d, 152 + 64 * j); if (!v.equals(ID.SYSTEM)) rewardVaults.push(v); }
        pools[k] = { vault: key(d, 56), mint: key(d, 88), stakeMint: key(d, 120), rewardVaults };
      });
      // Reward mints (for the wallet's reward token accounts), from the reward vaults.
      const rv = [...new Set(Object.values(pools).flatMap(p => p.rewardVaults.map(b58)))], rvInfos = await readAccounts(rv.map(P)), rvMint = {};
      rv.forEach((k, i) => { if (rvInfos[i]) rvMint[k] = key(rvInfos[i].data, 0); });
      for (const p of Object.values(pools)) p.rewards = p.rewardVaults.map(v => ({ vault: v, mint: rvMint[b58(v)] }));
      // Expired-reward pools, only for pools with receipts moved there.
      const expiredPools = {};
      for (const k of poolKeys.filter(k => done.some(r => r.expired && b58(r.pool) === k))) {
        const e = (await gpa(BONK_STAKING, [{ dataSize: 170 }, { memcmp: { offset: 136, bytes: k } }]))[0];
        if (e) expiredPools[k] = { key: e.pubkey, vault: key(e.account.data, 8), authority: key(e.account.data, 40), rewardMint: key(e.account.data, 104) };
      }
      return { list: done, locked, pools, expiredPools };
    })();
    Object.assign(bonkCache, { pk, t: Date.now(), v });
    v.catch(() => { bonkCache.pk = null; });
    return v;
  }
  async function bonkItems(pk, wantExpired) {
    const { list, locked = 0, pools = {}, expiredPools = {} } = await bonkScan(pk);
    const mine = list.filter(r => r.expired === wantExpired);
    const notes = [];
    if (wantExpired && locked) notes.push(locked + " BONK stake receipt(s) are still in their lockup.");
    if (!mine.length) return { items: [], note: notes.join(" ") };
    const mints = mine.flatMap(r => { const p = pools[b58(r.pool)]; const e = expiredPools[b58(r.pool)];
      return p ? [p.mint, ...(wantExpired ? (e ? [e.rewardMint] : []) : p.rewards.map(x => x.mint).filter(Boolean))] : []; });
    const dec = await decimals(mints);
    const have = await existing([...new Map(mints.map(m => [b58(m), ata(pk, m)])).values()], pk);
    const cost = ataCost(have, new Set(), await ataRent());
    const [withdrawIx, expiredIx] = await Promise.all([disc("withdraw"), disc("withdraw_stake_and_expired_rewards")]);
    const items = [];
    let skipped = 0;
    for (const r of mine) {
      const pool = pools[b58(r.pool)], ex = expiredPools[b58(r.pool)];
      if (!pool || (wantExpired && !ex) || (!wantExpired && pool.rewards.some(x => !x.mint))) { skipped++; continue; }
      const d = dec[b58(pool.mint)];
      const dests = [pool.mint, ...(wantExpired ? [ex.rewardMint] : pool.rewards.map(x => x.mint))].map(m => ata(pk, m));
      if (d === undefined || dests.some(k => have.get(b58(k)) === "foreign")) { skipped++; continue; }
      const parts = [{ mint: pool.mint, amount: r.amount, decimals: d }];
      if (wantExpired && r.parked > 0n && dec[b58(ex.rewardMint)] !== undefined) parts.push({ mint: ex.rewardMint, amount: r.parked, decimals: dec[b58(ex.rewardMint)] });
      const worth = await valueInLamports(parts.filter(x => x.amount > 0n));
      const c = cost(dests);
      const value = worth + r.rent - c.cost;
      if (value <= 0 || !worth) continue;
      c.take();
      const { receipt, amount, parked } = r, poolKey = r.pool, { vault, mint, stakeMint, rewards } = pool;
      const sym = symbolOf(b58(mint));
      if (wantExpired) {
        const rewardMint = ex.rewardMint;
        items.push({ key: receipt, value,
          label: "receipt " + short(receipt) + " · " + fmt(amount, d) + " " + sym + (parked > 0n ? " + " + fmt(parked, dec[b58(rewardMint)] ?? d) + " " + symbolOf(b58(rewardMint)) + " rewards" : "") + " · lockup over, no longer earning",
          ixs: p => [createAta(p, mint), ...(rewardMint.equals(mint) ? [] : [createAta(p, rewardMint)]),
            new W.TransactionInstruction({ programId: BONK_STAKING, data: expiredIx, keys: [
              meta(ex.authority, false, true),         // pool authority (not a signer; balance untouched)
              meta(p, true, true),                     // owner (receives the receipt's rent)
              meta(receipt, false, true),              // StakeDepositReceipt: closed
              meta(ex.key, false, true),               // expired reward pool
              meta(poolKey, false, true),
              meta(vault, false, true),                // stake vault (pays the deposit)
              meta(ex.vault, false, true),             // expired reward vault (pays the parked rewards)
              meta(ata(p, mint), false, true),         // wallet's token account
              meta(ata(p, rewardMint), false, true),   // wallet's reward token account
              meta(ID.TOKEN, false, false),
              meta(ID.RENT, false, false),
              meta(ID.SYSTEM, false, false)] })] });
      } else {
        items.push({ key: receipt, value,
          label: "receipt " + short(receipt) + " · " + fmt(amount, d) + " " + sym + " + pending rewards · lockup over, STILL EARNING (withdrawing stops rewards)",
          ixs: p => [createAta(p, mint), ...rewards.filter(x => !x.mint.equals(mint)).map(x => createAta(p, x.mint)),
            new W.TransactionInstruction({ programId: BONK_STAKING, data: withdrawIx, keys: [
              meta(p, true, true),                     // owner (receives the receipt's rent)
              meta(poolKey, false, true),
              meta(receipt, false, true),              // StakeDepositReceipt: closed
              meta(ID.TOKEN, false, false),
              meta(vault, false, true),                // stake vault (pays the deposit)
              meta(stakeMint, false, true),
              meta(BONK_STAKING, false, false),        // `from` = None (no stake-weight tokens to burn)
              meta(ata(p, mint), false, true),         // wallet's token account
              ...rewards.flatMap(x => [meta(x.vault, false, true), meta(ata(p, x.mint), false, true)])] })] });
      }
    }
    if (skipped) notes.push(skipped + " receipt(s) skipped: pool data missing or the wallet's token account belongs to another owner.");
    return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
  }
  RC.registerSource({
    id: "bonk-unstaked", title: "Expired BONK stakes ready to withdraw", group: "escrow", perTx: 4, programs: [BONK_STAKING],
    scan: pk => bonkItems(pk, true),
  });
  RC.registerSource({
    id: "bonk-lockup-over", title: "BONK stakes past their lockup (still earning)", group: "escrow", perTx: 4, programs: [BONK_STAKING],
    defaultOn: false,
    scan: pk => bonkItems(pk, false),
  });
})();
