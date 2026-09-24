"use strict";
// Staking rewards and unstake tickets that are already the wallet's.
//
// Marinade delayed-unstake tickets (MarBms…, Anchor TicketAccountData, 88 bytes): disc, state @8,
//   beneficiary @40, lamports_amount @72, created_epoch @80. Due from epoch created+1 (+30 min into that epoch).
//   `claim` needs no signature: it pays lamports_amount from the state's reserve PDA to the beneficiary and
//   closes the ticket (rent also to the beneficiary). Accounts: state, reserve [state,"reserve"], ticket,
//   beneficiary, clock, system.
// Kamino Farms (FarmsPZ…, zero-copy UserState 920 bytes): farm_state @16, owner @48, rewards_tally_scaled[10]
//   @88, rewards_issued_unclaimed[10] @248, last_claim_ts[10] @328, active_stake_scaled @408,
//   pending_withdrawal_unstake_scaled @448 / _ts @464. `harvest_reward(index)` sends the reward (minus the
//   global treasury fee) to the owner's token account; `withdraw_unstaked_deposits` returns fully unstaked
//   farm tokens once their cooldown has passed. Rewards are paid in tokens and valued with RC.valueInLamports.
// Orca Aquafarm (legacy 82yxje…, UserFarm 106 bytes): global_farm @2, owner @34, base_tokens_converted @66,
//   emissions checkpoint u256 @74 (×1e12). GlobalFarm 283 bytes: nonce @2, base vault @131, reward vault @163,
//   cumulative emissions per farm token u256 @251. Harvest (data 04) pays the ORCA-type reward to the owner.
(() => {
  const { W, P, ID, meta, gpa, readAccounts, disc, cat, u64, pda, enc, ata, short, b58, valueInLamports } = RC;

  const le = (d, off, n) => { let v = 0n; for (let i = off + n - 1; i >= off; i--) v = (v << 8n) | BigInt(d[i]); return v; };
  const key = (d, off) => new W.PublicKey(d.slice(off, off + 32));
  const ZERO = b58(ID.SYSTEM);
  const fmt = (raw, dec) => { const s = (Number(raw) / 10 ** dec); return s >= 1000 ? s.toFixed(0) : s >= 1 ? s.toFixed(2) : s.toPrecision(3); };
  // Rent of a new token account (165 bytes; 170 for a Token-2022 ATA with ImmutableOwner), read once from the chain.
  let rentCache = null;
  const ataRent = async () => rentCache || (rentCache = await RC.rpc().then(c => Promise.all(
    [165, 170].map(n => c.getMinimumBalanceForRentExemption(n)))).then(([a, b]) => ({ TOKEN: a, TOKEN22: b }))
    .catch(e => { rentCache = null; throw e; }));
  // Idempotent create of the wallet's own associated token account (paid by the wallet).
  const createAta = (p, mint, tokenProgram) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(p, mint, tokenProgram), false, true), meta(p, false, false), meta(mint, false, false),
    meta(ID.SYSTEM, false, false), meta(tokenProgram, false, false)] });
  const symbolOf = m => ({ orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: "ORCA", KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS: "KMNO",
    So11111111111111111111111111111111111111112: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT", J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
    JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP", "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD" })[m] || short(m);
  async function mintDecimals(mints) {
    const out = {}, infos = await readAccounts(mints.map(P));
    mints.forEach((m, i) => { if (infos[i]) out[m] = infos[i].data[44]; });
    return out;
  }
  // Rewards with no market price: summed per token for the category note.
  const unpricedNote = (list, verb) => {
    const sum = new Map();
    for (const { mint, amount, dec, tag } of list) { const k = b58(mint) + (tag || ""); const o = sum.get(k) || { mint, dec, tag, amount: 0n }; o.amount += amount; sum.set(k, o); }
    const parts = [...sum.values()].map(o => fmt(o.amount, o.dec) + " " + symbolOf(b58(o.mint)) + (o.tag || ""));
    return parts.length ? "Also " + verb + " but without a market price (not listed): " + parts.slice(0, 8).join(", ") + (parts.length > 8 ? "…" : "") + "." : "";
  };
  // The wallet's token accounts that already exist: "ok" when it still owns them, "foreign" when their owner
  // was changed (the program would pay into an account the wallet no longer controls, so such items are skipped).
  async function existing(keys, pk) {
    const infos = await readAccounts(keys), out = new Map();
    keys.forEach((k, i) => { if (infos[i]) out.set(b58(k), key(infos[i].data, 32).equals(pk) ? "ok" : "foreign"); });
    return out;
  }

  // ---------------------------------------------------------------- Marinade
  const MARINADE = P("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
  RC.registerSource({
    id: "marinade-tickets", title: "Marinade unstake tickets", group: "rewards", perTx: 8, programs: [MARINADE],
    async scan(pk) {
      const [found, { epoch }, claimIx] = await Promise.all([
        gpa(MARINADE, [{ dataSize: 88 }, { memcmp: { offset: 40, bytes: b58(pk) } }]),
        RC.rpc().then(c => c.getEpochInfo("confirmed")), disc("claim")]);
      const items = [];
      let later = 0, laterSol = 0, laterEpoch = 0;
      for (const { pubkey, account: a } of found) {
        const d = a.data, state = key(d, 8), amount = Number(le(d, 72, 8)), created = Number(le(d, 80, 8));
        if (!amount) continue;
        if (created + 1 > epoch) { later++; laterSol += amount; laterEpoch = Math.max(laterEpoch, created + 1); continue; }
        const reserve = pda([state.toBytes(), enc("reserve")], MARINADE)[0];
        items.push({ key: pubkey, value: amount + a.lamports,
          label: "ticket " + short(pubkey) + " · " + (amount / 1e9).toFixed(4) + " SOL · unstaked in epoch " + created,
          ixs: p => [new W.TransactionInstruction({ programId: MARINADE, data: claimIx, keys: [
            meta(state, false, true),          // Marinade state
            meta(reserve, false, true),        // reserve PDA: pays the SOL
            meta(pubkey, false, true),         // ticket: closed, rent to the beneficiary
            meta(p, false, true),              // beneficiary = this wallet
            meta(ID.CLOCK, false, false),
            meta(ID.SYSTEM, false, false)] })] });
      }
      return { items: items.sort((a, b) => b.value - a.value),
        note: later ? later + " ticket(s) for " + (laterSol / 1e9).toFixed(4) + " SOL are not due yet (claimable from epoch "
          + laterEpoch + ", now " + epoch + ")." : "" };
    },
  });

  // ---------------------------------------------------------------- Kamino Farms
  const FARMS = P("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
  const WAD = 10n ** 18n, RI = 192, RI_SIZE = 704;
  RC.registerSource({
    id: "kamino-farms", title: "Kamino Farms rewards", group: "rewards", perTx: 4, programs: [FARMS],
    async scan(pk) {
      const users = await gpa(FARMS, [{ dataSize: 920 }, { memcmp: { offset: 48, bytes: b58(pk) } }]);
      if (!users.length) return { items: [] };
      const farmKeys = [...new Set(users.map(u => b58(key(u.account.data, 16))))];
      const farmInfos = await readAccounts(farmKeys.map(P)), farms = {};
      farmKeys.forEach((k, i) => { if (farmInfos[i]) farms[k] = farmInfos[i].data; });
      const gcKeys = [...new Set(Object.values(farms).map(f => b58(key(f, 40))))];
      const gcInfos = await readAccounts(gcKeys.map(P)), feeBps = {};
      gcKeys.forEach((k, i) => { feeBps[k] = gcInfos[i] ? le(gcInfos[i].data, 40, 8) : 10000n; });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const [harvestIx, withdrawIx] = await Promise.all([disc("harvest_reward"), disc("withdraw_unstaked_deposits")]);

      // First pass: what each user state holds.
      const cands = [];
      let waiting = 0;
      for (const { pubkey, account } of users) {
        const u = account.data, fk = b58(key(u, 16)), f = farms[fk];
        if (!f) continue;
        const farmState = P(fk), gc = key(f, 40), fva = key(f, 7288), delegated = b58(key(f, 7328)) !== ZERO;
        const seconds = f[7360] === 0, stake = le(u, 408, 16), fee = feeBps[b58(gc)];
        const scopeId = le(f, 7568, 8), scope = scopeId === 0xffffffffffffffffn ? FARMS : key(f, 7536);
        const rewards = [];
        for (let i = 0; i < Number(le(f, 7232, 8)) && i < 10; i++) {
          const o = RI + RI_SIZE * i, mint = key(f, o);
          if (b58(mint) === ZERO) continue;
          const rps = le(f, o + 512, 16), tally = le(u, 88 + 16 * i, 16);
          const newTally = delegated ? rps * stake : rps * stake / WAD;
          const total = le(u, 248 + 8 * i, 8) + (newTally > tally ? (newTally - tally) / WAD : 0n);
          const net = total - total * fee / 10000n;
          if (net <= 0n) continue;
          if (seconds && now - le(u, 328 + 8 * i, 8) < le(f, o + 480, 8)) { waiting++; continue; }
          const tp = b58(key(f, o + 40)) === ZERO ? ID.TOKEN : key(f, o + 40);
          rewards.push({ i, mint, tp, net, dec: Number(le(f, o + 32, 8)), vault: key(f, o + 120),
            treasury: pda([enc("tvault"), gc.toBytes(), mint.toBytes()], FARMS)[0] });
        }
        let unstaked = null;
        const pw = le(u, 448, 16), tokenMint = key(f, 72);
        if (pw > 0n && !delegated && b58(tokenMint) !== ZERO && (!seconds || le(u, 464, 8) <= now))
          unstaked = { mint: tokenMint, amount: pw / WAD, dec: Number(le(f, 104, 8)), vault: key(f, 7256) };
        if (rewards.length || unstaked) cands.push({ pubkey, farmState, gc, fva, scope, rewards, unstaked });
      }
      if (!cands.length) return { items: [], note: waiting ? waiting + " reward(s) are still inside the farm's minimum claim period." : "" };

      // Values (Jupiter prices) and which of the wallet's token accounts already exist.
      const atas = [];
      for (const c of cands) {
        for (const r of c.rewards) atas.push(ata(pk, r.mint, r.tp));
        if (c.unstaked) atas.push(ata(pk, c.unstaked.mint, ID.TOKEN));
      }
      const have = await existing([...new Map(atas.map(a => [b58(a), a])).values()], pk);
      const rentPaid = new Set(), items = [], unpriced = [], rent = await ataRent();
      let foreign = 0;
      for (const c of cands) {
        const parts = [], labels = [];
        let value = 0;
        for (const r of c.rewards) {
          const v = await valueInLamports([{ mint: r.mint, amount: r.net, decimals: r.dec }]);
          if (v <= 0) { unpriced.push({ mint: r.mint, amount: r.net, dec: r.dec }); continue; }
          const dest = ata(pk, r.mint, r.tp);
          if (have.get(b58(dest)) === "foreign") { foreign++; continue; }
          if (!have.has(b58(dest)) && !rentPaid.has(b58(dest))) { rentPaid.add(b58(dest)); value -= r.tp.equals(ID.TOKEN22) ? rent.TOKEN22 : rent.TOKEN; }
          value += v; labels.push(fmt(r.net, r.dec) + " " + symbolOf(b58(r.mint)));
          parts.push(r);
        }
        let un = null;
        if (c.unstaked) {
          const v = c.unstaked.amount > 0n ? await valueInLamports([{ mint: c.unstaked.mint, amount: c.unstaked.amount, decimals: c.unstaked.dec }]) : 0;
          if (v > 0) {
            const dest = ata(pk, c.unstaked.mint, ID.TOKEN);
            if (have.get(b58(dest)) === "foreign") foreign++;
            else {
              if (!have.has(b58(dest)) && !rentPaid.has(b58(dest))) { rentPaid.add(b58(dest)); value -= rent.TOKEN; }
              value += v; un = c.unstaked;
              labels.push(fmt(un.amount, un.dec) + " " + symbolOf(b58(un.mint)) + " unstaked");
            }
          } else if (c.unstaked.amount > 0n) unpriced.push({ ...c.unstaked, tag: " (unstaked)" });
        }
        if ((!parts.length && !un) || value <= 0) continue;
        const { pubkey, farmState, gc, fva, scope } = c;
        items.push({ key: pubkey, value, label: "farm " + short(farmState) + " · " + labels.join(" + "),
          ixs: p => {
            const out = [];
            for (const r of parts) {
              out.push(createAta(p, r.mint, r.tp));
              out.push(new W.TransactionInstruction({ programId: FARMS, data: cat(harvestIx, u64(r.i)), keys: [
                meta(p, true, true),                       // payer = owner
                meta(pubkey, false, true),                 // user state
                meta(farmState, false, true),
                meta(gc, false, false),                    // global config
                meta(r.mint, false, false),                // reward mint
                meta(ata(p, r.mint, r.tp), false, true),   // wallet's reward token account
                meta(r.vault, false, true),                // farm reward vault
                meta(r.treasury, false, true),             // treasury vault (takes the protocol fee)
                meta(fva, false, false),                   // farm vaults authority
                meta(scope, false, false),                 // scope prices, or the program id for "none"
                meta(r.tp, false, false)] }));
            }
            if (un) {
              out.push(createAta(p, un.mint, ID.TOKEN));
              out.push(new W.TransactionInstruction({ programId: FARMS, data: withdrawIx, keys: [
                meta(p, true, true),                       // owner
                meta(pubkey, false, true),                 // user state
                meta(farmState, false, true),
                meta(ata(p, un.mint, ID.TOKEN), false, true),
                meta(un.vault, false, true),               // farm vault
                meta(fva, false, false),
                meta(ID.TOKEN, false, false)] }));
            }
            return out;
          } });
      }
      const notes = [];
      if (unpriced.length) notes.push(unpricedNote(unpriced, "claimable"));
      if (waiting) notes.push(waiting + " reward(s) are still inside the farm's minimum claim period.");
      if (foreign) notes.push(foreign + " reward(s) skipped: the wallet's token account for them now belongs to another owner.");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });

  // ---------------------------------------------------------------- Orca Aquafarm (legacy)
  const AQUA = P("82yxjeMsvaURa4MbZZ7WZZHfobirZYkH1zF8fmeGtyaQ");
  RC.registerSource({
    id: "orca-aquafarm", title: "Orca Aquafarm rewards (legacy)", group: "rewards", perTx: 5, programs: [AQUA],
    async scan(pk) {
      const users = await gpa(AQUA, [{ dataSize: 106 }, { memcmp: { offset: 34, bytes: b58(pk) } }]);
      if (!users.length) return { items: [] };
      const gKeys = [...new Set(users.map(u => b58(key(u.account.data, 2))))];
      const gInfos = await readAccounts(gKeys.map(P)), globals = {};
      gKeys.forEach((k, i) => { if (gInfos[i]) globals[k] = gInfos[i].data; });
      const vKeys = [...new Set(Object.values(globals).map(g => b58(key(g, 163))))];
      const vInfos = await readAccounts(vKeys.map(P)), vaults = {};
      vKeys.forEach((k, i) => { if (vInfos[i]) vaults[k] = { mint: key(vInfos[i].data, 0), amount: le(vInfos[i].data, 64, 8) }; });
      const decs = await mintDecimals([...new Set(Object.values(vaults).map(v => b58(v.mint)))]);

      const cands = [];
      let deposited = 0;
      for (const { pubkey, account } of users) {
        const u = account.data, gk = b58(key(u, 2)), g = globals[gk];
        if (!g) continue;
        const converted = le(u, 66, 8);
        if (converted > 0n) deposited++;
        const vault = vaults[b58(key(g, 163))];
        if (!vault || decs[b58(vault.mint)] === undefined) continue;
        let amount = converted * (le(g, 251, 32) - le(u, 74, 32)) / 10n ** 12n;
        if (amount > vault.amount) amount = vault.amount;
        if (amount <= 0n) continue;
        cands.push({ pubkey, global: P(gk), nonce: g[2], baseVault: key(g, 131), rewardVault: key(g, 163),
          mint: vault.mint, amount, dec: decs[b58(vault.mint)] });
      }
      const have = await existing([...new Map(cands.map(c => { const a = ata(pk, c.mint); return [b58(a), a]; })).values()], pk);
      const rentPaid = new Set(), items = [], unpriced = [], rent = await ataRent();
      let foreign = 0;
      for (const c of cands.sort((a, b) => (b.amount > a.amount ? 1 : -1))) {
        let value = await valueInLamports([{ mint: c.mint, amount: c.amount, decimals: c.dec }]);
        const amountText = fmt(c.amount, c.dec) + " " + symbolOf(b58(c.mint));
        if (value <= 0) { unpriced.push(c); continue; }
        const dest = ata(pk, c.mint);
        if (have.get(b58(dest)) === "foreign") { foreign++; continue; }
        if (!have.has(b58(dest)) && !rentPaid.has(b58(dest))) { rentPaid.add(b58(dest)); value -= rent.TOKEN; }
        if (value <= 0) continue;
        const authority = W.PublicKey.createProgramAddressSync([c.global.toBytes(), Uint8Array.of(c.nonce)], AQUA);
        const { pubkey, global, baseVault, rewardVault, mint } = c;
        items.push({ key: pubkey, value, label: "farm " + short(global) + " · " + amountText,
          ixs: p => [createAta(p, mint, ID.TOKEN), new W.TransactionInstruction({ programId: AQUA, data: Uint8Array.of(4), keys: [
            meta(p, true, false),                  // user farm owner
            meta(global, false, true),             // global farm
            meta(pubkey, false, true),             // user farm
            meta(baseVault, false, false),         // global base token vault
            meta(rewardVault, false, true),        // global reward vault
            meta(ata(p, mint), false, true),       // wallet's reward token account
            meta(authority, false, false),         // farm authority PDA [global farm, nonce]
            meta(ID.TOKEN, false, false)] })] });
      }
      const notes = [];
      if (unpriced.length) notes.push(unpricedNote(unpriced, "harvestable"));
      if (foreign) notes.push(foreign + " reward(s) skipped: the wallet's token account for them now belongs to another owner.");
      if (deposited) notes.push(deposited + " farm position(s) still hold deposited Orca LP tokens; withdrawing those is not handled here (they return LP tokens, not SOL).");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });
})();
