"use strict";
// Old farming / staking positions (2021–23) whose owner can still take the staked tokens back.
//
// Raydium farms (layouts and instructions from raydium-sdk v1 src/farm): the wallet's ledger holds `deposited`
// LP (or RAY for the RAY staking pool 4EwbZo…); `withdraw(amount)` sends the LP back to the owner and pays all
// pending rewards in the same instruction. Farm authority = PDA [farm] (bump = farm nonce).
//  - v3 EhhTKc… farm 200 bytes: lp vault @16, reward vault @48, per_share u128 @168 (×1e9), last slot @184,
//    per_slot @192. Ledger 88 bytes (old, keypair) or 232 (PDA [farm, owner, "staker_info_v2_associated_seed"]):
//    farm @8, owner @40, deposited @72, reward debt @80 (u64 old / u128 new). withdraw = ix 11.
//  - v5 9KEPoZ… farm 224 bytes: lp vault @16, reward A vault @48 / per_share @88 / per_slot @104, reward B
//    vault @113 / per_share @160 / per_slot @176, last slot @184 (×1e15). Ledger 96 (old) or 248 (PDA, same seed):
//    deposited @72, debts @80/@88 (u64) or @80/@96 (u128). withdraw = ix 12.
//    Old keypair ledgers are merged first, as the Raydium UI does: create the PDA ledger if missing (ix 9 / 10),
//    then deposit(0) (ix 10 / 11) with the old ledgers appended; then withdraw everything from the PDA ledger.
//  - v6 Farmqi… farm 1976 bytes: reward count @24, multiplier u128 @32, lp mint @72, lp vault @104, 5 reward
//    infos of 304 bytes @136 (state, open, end, last update, total, emitted, claimed, per_second, acc u128 @64,
//    vault @80, mint @112, type @176). Ledger PDA [farm, owner, "farmer_info_associated_seed"] 296 bytes:
//    farm @16, owner @48, deposited @80, debts u128 @88. withdraw = ix 2.
//  Farms that still pay rewards (RAY staking, live v6 farms) are a separate, opt-in category.
//  LP value: Jupiter price of the LP mint, else the wallet's share of the Raydium AMM v4 pool's two vaults
//  (lp mint @464 of the 752-byte pool; vaults @336/@368, mints @400/@432, pnl owed @192/@200, lp reserve @720;
//  Serum/OpenBook-side funds are ignored, so this is a lower bound). The wallet receives LP tokens and can
//  remove the liquidity on Raydium afterwards.
//
// Quarry mine (QMNeHC…, used by Marinade mSOL, Saber, Sunny…): Miner 145 bytes: quarry @8, authority @40,
//   token vault @73, balance @129; Quarry 140 bytes: rewarder @8, staked mint @40; Rewarder is_paused @259.
//   withdraw_tokens(amount) (authority signs) moves the staked tokens from the miner vault to the wallet.
//   Rewards are not claimed: every Quarry reward token still holding miners (Marinade, Saber IOU, Sunny…) has
//   no market any more.
(() => {
  const { W, P, ID, meta, gpa, readAccounts, disc, cat, u64, pda, enc, ata, short, b58, valueInLamports } = RC;
  const V3 = P("EhhTKczWMGQt46ynNeRX1WfeagwwJd7ufHvCDjRxjo5Q");
  const V5 = P("9KEPoZmtHUrBbhWN1v1KWLMkkvwY6WLtAVUCPRtRjP4z");
  const V6 = P("FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG");
  const AMM = P("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  const QUARRY = P("QMNeHCGYnLVDn1icRAfQZpjPLBNkfGbSKRB83G5d8KB");
  const MAX_POOL_LOOKUPS = 8;   // AMM v4 pool searches per scan (one gpa each)

  const le = (d, off, n) => { let v = 0n; for (let i = off + n - 1; i >= off; i--) v = (v << 8n) | BigInt(d[i]); return v; };
  const key = (d, off) => new W.PublicKey(d.slice(off, off + 32));
  const fmt = (raw, dec) => { const s = Number(raw) / 10 ** dec; return s >= 1000 ? s.toFixed(0) : s >= 1 ? s.toFixed(2) : s.toPrecision(3); };
  const NAMES = { "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY", So11111111111111111111111111111111111111112: "SOL",
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
    mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL", vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7: "vSOL",
    SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt: "SRM", Saber2gLauYim4Mvftnrasomsv6NvAuncvMEZwcLpD1: "SBR" };
  const sym = m => NAMES[b58(m)] || short(m);
  const ixData = (n, amount) => cat(Uint8Array.of(n), u64(amount));
  const createAta = (p, mint) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(p, mint), false, true), meta(p, false, false), meta(mint, false, false),
    meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] });
  const closeAta = (p, mint) => new W.TransactionInstruction({ programId: ID.TOKEN, data: Uint8Array.of(9), keys: [
    meta(ata(p, mint), false, true), meta(p, false, true), meta(p, true, false)] });

  let rentCache = null;
  const rentFor = async n => {
    rentCache = rentCache || {};
    if (rentCache[n] === undefined) rentCache[n] = await (await RC.rpc()).getMinimumBalanceForRentExemption(n);
    return rentCache[n];
  };
  // Token accounts: mint, amount, owning program. null if missing.
  async function tokenInfos(keys) {
    const infos = await readAccounts(keys), out = new Map();
    keys.forEach((k, i) => { const a = infos[i]; out.set(b58(k), a && a.data.length >= 72
      ? { mint: key(a.data, 0), owner: key(a.data, 32), amount: le(a.data, 64, 8), prog: a.owner } : null); });
    return out;
  }
  async function decimalsOf(mints) {
    const list = [...new Set(mints.map(b58))], infos = await readAccounts(list.map(P)), out = {};
    list.forEach((m, i) => { if (infos[i] && infos[i].data.length >= 45) out[m] = infos[i].data[44]; });
    return out;
  }
  // The wallet's ATAs: "ok" (exists, still the wallet's), "foreign" (owner was changed), or absent.
  async function ataState(pk, mints) {
    const list = [...new Set(mints.map(b58))], infos = await readAccounts(list.map(m => ata(pk, P(m)))), out = new Map();
    list.forEach((m, i) => { if (infos[i]) out.set(m, key(infos[i].data, 32).equals(pk) ? "ok" : "foreign"); });
    return out;
  }
  const unpricedNote = list => {
    if (!list.length) return "";
    const s = list.slice(0, 6).join(", ") + (list.length > 6 ? "…" : "");
    return list.length + " position(s) hold only tokens without a market price (not listed): " + s + ".";
  };

  // SOL value of LP tokens: the LP mint's own price, else the share of the Raydium AMM v4 pool vaults.
  function lpPricer() {
    const pools = new Map();
    let lookups = 0;
    return async function value(mint, amount, dec) {
      if (amount <= 0n) return { value: 0, text: "" };
      const direct = await valueInLamports([{ mint, amount, decimals: dec }]);
      if (direct > 0) return { value: direct, text: fmt(amount, dec) + " " + sym(mint) };
      const m = b58(mint);
      if (!pools.has(m)) {
        if (lookups >= MAX_POOL_LOOKUPS) return { value: 0, text: "" };
        lookups++;
        const found = await gpa(AMM, [{ dataSize: 752 }, { memcmp: { offset: 464, bytes: m } }]);
        let pool = null;
        if (found.length) {
          const d = found[0].account.data, vaults = await tokenInfos([key(d, 336), key(d, 368)]);
          const bv = vaults.get(b58(key(d, 336))), qv = vaults.get(b58(key(d, 368)));
          // Divide by the larger of the pool's LP reserve and the LP supply, so the share is never overstated.
          const [mintAcc] = await readAccounts([mint]), supply = mintAcc ? le(mintAcc.data, 36, 8) : 0n, reserve = le(d, 720, 8);
          if (bv && qv) pool = { reserve: reserve > supply ? reserve : supply,
            base: { mint: key(d, 400), dec: Number(le(d, 32, 8)), amount: bv.amount - le(d, 192, 8) },
            quote: { mint: key(d, 432), dec: Number(le(d, 40, 8)), amount: qv.amount - le(d, 200, 8) } };
        }
        pools.set(m, pool);
      }
      const pool = pools.get(m);
      if (!pool || pool.reserve <= 0n) return { value: 0, text: "" };
      const parts = [pool.base, pool.quote].map(s => ({ mint: s.mint, decimals: s.dec,
        amount: s.amount > 0n ? s.amount * amount / pool.reserve : 0n }));
      const v = await valueInLamports(parts);
      return { value: v, text: fmt(amount, dec) + " LP (≈ " + parts.map(x => fmt(x.amount, x.decimals) + " " + sym(x.mint)).join(" + ") + ")" };
    };
  }

  // ---------------------------------------------------------------- Raydium farms
  const RAY = [
    { v: 3, prog: V3, sizes: { 88: "old", 232: "pda" }, withdraw: 11, deposit: 10, createLedger: 9, mult: 10n ** 9n },
    { v: 5, prog: V5, sizes: { 96: "old", 248: "pda" }, withdraw: 12, deposit: 11, createLedger: 10, mult: 10n ** 15n },
  ];
  const ledgerPda = (prog, farm, owner, seed) => pda([farm.toBytes(), owner.toBytes(), enc(seed)], prog)[0];

  async function scanRaydium(pk) {
    const [l3, l5, l6] = await Promise.all([
      gpa(V3, [{ memcmp: { offset: 40, bytes: b58(pk) } }]),
      gpa(V5, [{ memcmp: { offset: 40, bytes: b58(pk) } }]),
      gpa(V6, [{ dataSize: 296 }, { memcmp: { offset: 48, bytes: b58(pk) } }])]);
    // Group ledgers with a deposit by farm.
    const groups = new Map();
    let odd = 0;
    const add = (spec, pubkey, lamports, kind, farm, dep, debts) => {
      const k = b58(spec.prog) + b58(farm);
      const g = groups.get(k) || { spec, farm, pdaLedger: null, pdaExists: false, olds: [], deposited: 0n, rent: 0 };
      if (kind === "pda") { g.pdaExists = true; g.pdaLedger = pubkey; g.pdaDep = dep; g.pdaDebts = debts; }
      else g.olds.push({ pubkey, dep, debts });
      g.deposited += dep;
      g.rent += lamports;
      groups.set(k, g);
    };
    for (const spec of RAY) {
      for (const { pubkey, account } of spec.v === 3 ? l3 : l5) {
        const d = account.data, kind = spec.sizes[d.length];
        if (!kind || !key(d, 40).equals(pk)) continue;
        const farm = key(d, 8), dep = le(d, 72, 8);
        const wide = kind === "pda", n = spec.v === 3 ? 1 : 2;
        const debts = [...Array(n)].map((_, i) => wide ? le(d, 80 + 16 * i, 16) : le(d, 80 + 8 * i, 8));
        if (kind === "pda" && !pubkey.equals(ledgerPda(spec.prog, farm, pk, "staker_info_v2_associated_seed"))) { if (dep > 0n) odd++; continue; }
        if (dep === 0n && kind === "old") continue;
        add(spec, pubkey, account.lamports, kind, farm, dep, debts);
      }
    }
    const V6SPEC = { v: 6, prog: V6, withdraw: 2 };
    for (const { pubkey, account } of l6) {
      const d = account.data, farm = key(d, 16), dep = le(d, 80, 8);
      if (dep === 0n) continue;
      if (!pubkey.equals(ledgerPda(V6, farm, pk, "farmer_info_associated_seed"))) { odd++; continue; }
      add(V6SPEC, pubkey, account.lamports, "pda", farm, dep, [0, 1, 2, 3, 4].map(i => le(d, 88 + 16 * i, 16)));
    }
    const list = [...groups.values()].filter(g => g.deposited > 0n);
    if (!list.length) return { ended: [], active: [], notes: odd ? [odd + " Raydium ledger(s) with an unusual address were skipped."] : [] };

    // Farm states, then their vaults.
    const farmInfos = await readAccounts(list.map(g => g.farm));
    const vaultKeys = [];
    list.forEach((g, i) => {
      const a = farmInfos[i];
      if (!a || !a.owner.equals(g.spec.prog)) return;
      const d = a.data;
      g.nonce = Number(le(d, g.spec.v === 6 ? 16 : 8, 8));
      if (g.spec.v === 3) {
        g.lpVault = key(d, 16);
        g.rewards = [{ vault: key(d, 48), pps: le(d, 168, 16), perSlot: le(d, 192, 8) }];
        g.lastSlot = le(d, 184, 8); g.mult = g.spec.mult;
      } else if (g.spec.v === 5) {
        g.lpVault = key(d, 16);
        g.rewards = [{ vault: key(d, 48), pps: le(d, 88, 16), perSlot: le(d, 104, 8) },
          { vault: key(d, 113), pps: le(d, 160, 16), perSlot: le(d, 176, 8) }];
        g.lastSlot = le(d, 184, 8); g.mult = g.spec.mult;
      } else {
        g.lpVault = key(d, 104); g.mult = le(d, 32, 16);
        g.rewards = [];
        for (let r = 0; r < Math.min(5, Number(le(d, 24, 8))); r++) {
          const o = 136 + 304 * r;
          g.rewards.push({ state: le(d, o, 8), open: le(d, o + 8, 8), end: le(d, o + 16, 8), last: le(d, o + 24, 8),
            total: le(d, o + 32, 8), emitted: le(d, o + 40, 8), perSec: le(d, o + 56, 8), acc: le(d, o + 64, 16),
            vault: key(d, o + 80), mint: key(d, o + 112), type: le(d, o + 176, 8) });
        }
      }
      g.ok = true;
      vaultKeys.push(g.lpVault, ...g.rewards.map(r => r.vault));
    });
    const vaults = await tokenInfos([...new Map(vaultKeys.map(k => [b58(k), k])).values()]);
    const slot = BigInt(await (await RC.rpc()).getSlot("confirmed"));
    const now = BigInt(Math.floor(Date.now() / 1000));

    const cands = [];
    for (const g of list) {
      if (!g.ok) continue;
      const lp = vaults.get(b58(g.lpVault));
      if (!lp || !lp.prog.equals(ID.TOKEN)) continue;
      g.lpMint = lp.mint;
      let active = false, bad = false;
      g.rewards.forEach((r, i) => {
        const v = vaults.get(b58(r.vault));
        r.mint = r.mint || (v && v.mint);
        r.left = v ? v.amount : 0n;
        if (!v || !v.prog.equals(ID.TOKEN) || r.type === 1n) { bad = true; return; }
        let acc;
        if (g.spec.v === 6) {
          acc = r.acc;
          if (r.state !== 0n) {
            const upto = now < r.end ? now : r.end;
            if (r.open < upto && upto > r.last) {
              let reward = (upto - r.last) * r.perSec;
              if (reward > r.total - r.emitted) reward = r.total - r.emitted;
              if (lp.amount > 0n) acc += reward * g.mult / lp.amount;
            }
            if (now < r.end && r.emitted < r.total) active = true;
          }
        } else {
          acc = r.pps;
          if (slot > g.lastSlot && lp.amount > 0n) acc += r.perSlot * (slot - g.lastSlot) * g.mult / lp.amount;
          if (r.perSlot > 0n && r.left > 0n) active = true;
        }
        // Pending over all of the wallet's ledgers for this farm.
        let pending = 0n;
        const parts = [...(g.pdaExists ? [{ dep: g.pdaDep, debts: g.pdaDebts }] : []), ...g.olds];
        for (const l of parts) { const x = l.dep * acc / g.mult - (l.debts[i] || 0n); if (x > 0n) pending += x; }
        r.pending = pending > r.left ? r.left : pending;
      });
      if (bad) continue;
      g.active = active;
      cands.push(g);
    }
    if (!cands.length) return { ended: [], active: [], notes: [] };

    const decs = await decimalsOf(cands.flatMap(g => [g.lpMint, ...g.rewards.map(r => r.mint)]));
    const have = await ataState(pk, cands.flatMap(g => [g.lpMint, ...g.rewards.map(r => r.mint)]));
    const ataRent = await rentFor(165);
    const lpValue = lpPricer();
    const out = { ended: [], active: [], notes: [], unpriced: { ended: [], active: [] } };
    let foreign = 0;
    const rentPaid = new Set();
    for (const g of cands) {
      const mints = [g.lpMint, ...g.rewards.map(r => r.mint)];
      if (mints.some(m => have.get(b58(m)) === "foreign")) { foreign++; continue; }
      const lpDec = decs[b58(g.lpMint)];
      if (lpDec === undefined) continue;
      const lpv = await lpValue(g.lpMint, g.deposited, lpDec);
      // Withdrawing everything closes the ledger(s) (old ones are closed by the merge): their rent comes back.
      let value = lpv.value + g.rent;
      const texts = [lpv.text || fmt(g.deposited, lpDec) + " LP " + short(g.lpMint)];
      for (const r of g.rewards) {
        if (r.pending <= 0n || decs[b58(r.mint)] === undefined) continue;
        const v = await valueInLamports([{ mint: r.mint, amount: r.pending, decimals: decs[b58(r.mint)] }]);
        value += v;
        texts.push(fmt(r.pending, decs[b58(r.mint)]) + " " + sym(r.mint) + " reward");
      }
      // Receiving accounts: created if missing; a reward account created here that surely stays empty
      // (its reward vault is empty) or holds wSOL is closed again, the others keep their rent.
      const seen = new Set(), creates = [], closes = [];
      for (const [i, m] of mints.entries()) {
        const k = b58(m);
        if (seen.has(k)) continue;
        seen.add(k);
        if (have.get(k) === "ok") continue;
        creates.push(m);
        const r = i > 0 ? g.rewards[i - 1] : null;
        const receivesNothing = r && mints.filter(x => b58(x) === k).length === 1 && r.left === 0n;
        if (r && (receivesNothing || m.equals(ID.WSOL))) closes.push(m);
        else if (!rentPaid.has(k)) { rentPaid.add(k); value -= ataRent; }
      }
      const bucket = g.active ? "active" : "ended";
      if (value <= 0) { out.unpriced[bucket].push(texts[0]); continue; }

      const { spec, farm, lpVault, deposited, olds, rewards, nonce } = g, prog = spec.prog;
      const authority = W.PublicKey.createProgramAddressSync([farm.toBytes(), Uint8Array.of(nonce)], prog);
      const lpMint = g.lpMint;
      out[bucket].push({ key: g.pdaLedger || olds[0].pubkey, value,
        label: "Raydium farm v" + spec.v + " " + short(farm) + (olds.length ? " (old ledger)" : "") + " · " + texts.join(" + "),
        ixs: p => {
          const ledger = spec.v === 6 ? ledgerPda(V6, farm, p, "farmer_info_associated_seed")
            : ledgerPda(prog, farm, p, "staker_info_v2_associated_seed");
          const lpAcc = ata(p, lpMint), rAcc = rewards.map(r => ata(p, r.mint));
          const ixs = creates.map(m => createAta(p, m));
          if (spec.v === 6) {
            const keys = [meta(ID.TOKEN, false, false),
              meta(farm, false, true), meta(authority, false, false), meta(lpVault, false, true),
              meta(ledger, false, true), meta(p, true, false), meta(lpAcc, false, true)];
            rewards.forEach((r, i) => keys.push(meta(r.vault, false, true), meta(rAcc[i], false, true)));
            ixs.push(new W.TransactionInstruction({ programId: prog, data: ixData(spec.withdraw, deposited), keys }));
          } else {
            // Common account list of v3/v5 deposit and withdraw; reward B pair (v5) comes after the token program.
            const base = () => {
              const k = [meta(farm, false, true), meta(authority, false, false), meta(ledger, false, true), meta(p, true, false),
                meta(lpAcc, false, true), meta(lpVault, false, true), meta(rAcc[0], false, true), meta(rewards[0].vault, false, true),
                meta(ID.CLOCK, false, false), meta(ID.TOKEN, false, false)];
              if (spec.v === 5) k.push(meta(rAcc[1], false, true), meta(rewards[1].vault, false, true));
              return k;
            };
            if (olds.length) {
              if (!g.pdaExists) ixs.push(new W.TransactionInstruction({ programId: prog, data: Uint8Array.of(spec.createLedger), keys: [
                meta(farm, false, true), meta(ledger, false, true), meta(p, true, false),
                meta(ID.SYSTEM, false, false), meta(ID.RENT, false, false)] }));
              ixs.push(new W.TransactionInstruction({ programId: prog, data: ixData(spec.deposit, 0n),
                keys: [...base(), ...olds.map(o => meta(o.pubkey, false, true))] }));
            }
            ixs.push(new W.TransactionInstruction({ programId: prog, data: ixData(spec.withdraw, deposited), keys: base() }));
          }
          for (const m of closes) ixs.push(closeAta(p, m));
          return ixs;
        } });
    }
    if (foreign) out.notes.push(foreign + " position(s) skipped: the wallet's token account for the LP or reward now belongs to another owner.");
    if (odd) out.notes.push(odd + " Raydium ledger(s) with an unusual address were skipped.");
    return out;
  }

  // One Raydium scan per wallet, shared by the two categories.
  const cache = new Map();
  const raydium = pk => {
    const k = b58(pk), hit = cache.get(k);
    if (hit && Date.now() - hit.t < 60000) return hit.p;
    const p = scanRaydium(pk);
    cache.set(k, { t: Date.now(), p });
    p.catch(() => cache.delete(k));
    return p;
  };
  const byValue = items => items.sort((a, b) => b.value - a.value);
  const LP_NOTE = "Withdrawn LP tokens land in your wallet; remove the liquidity on Raydium to get the two tokens.";

  RC.registerSource({
    id: "raydium-farms", title: "Raydium farms & RAY staking (ended)", group: "escrow", perTx: 2, programs: [V3, V5, V6],
    async scan(pk) {
      const r = await raydium(pk);
      const notes = [...r.notes];
      if (r.unpriced && r.unpriced.ended.length) notes.push(unpricedNote(r.unpriced.ended));
      if (r.ended.length) notes.push(LP_NOTE);
      return { items: byValue(r.ended), note: notes.join(" ") };
    },
  });
  RC.registerSource({
    id: "raydium-farms-active", title: "Raydium farms & RAY staking still earning (withdraw)", group: "escrow", perTx: 2,
    programs: [V3, V5, V6], defaultOn: false,
    async scan(pk) {
      const r = await raydium(pk);
      const notes = [];
      if (r.unpriced && r.unpriced.active.length) notes.push(unpricedNote(r.unpriced.active));
      if (r.active.length) notes.push("These farms still pay rewards; withdrawing stops them. Pending rewards are paid out with the withdrawal.");
      return { items: byValue(r.active), note: notes.join(" ") };
    },
  });

  // ---------------------------------------------------------------- Quarry
  RC.registerSource({
    id: "quarry-miners", title: "Quarry staking (Marinade mSOL, Saber, Sunny…)", group: "escrow", perTx: 4, programs: [QUARRY],
    async scan(pk) {
      const miners = (await gpa(QUARRY, [{ dataSize: 145 }, { memcmp: { offset: 40, bytes: b58(pk) } }]))
        .map(({ pubkey, account: a }) => ({ pubkey, quarry: key(a.data, 8), vault: key(a.data, 73), balance: le(a.data, 129, 8) }))
        .filter(m => m.balance > 0n);
      if (!miners.length) return { items: [] };
      const qKeys = [...new Map(miners.map(m => [b58(m.quarry), m.quarry])).values()];
      const qInfos = await readAccounts(qKeys), quarries = {};
      qKeys.forEach((k, i) => { const a = qInfos[i]; if (a && a.owner.equals(QUARRY)) quarries[b58(k)] = { rewarder: key(a.data, 8), mint: key(a.data, 40) }; });
      const rKeys = [...new Map(Object.values(quarries).map(q => [b58(q.rewarder), q.rewarder])).values()];
      const rInfos = await readAccounts(rKeys), paused = {};
      rKeys.forEach((k, i) => { paused[b58(k)] = !rInfos[i] || rInfos[i].data[259] === 1; });
      const vaults = await tokenInfos(miners.map(m => m.vault));
      const cands = [];
      let stopped = 0;
      for (const m of miners) {
        const q = quarries[b58(m.quarry)], v = vaults.get(b58(m.vault));
        if (!q || !v) continue;
        if (paused[b58(q.rewarder)]) { stopped++; continue; }
        const amount = m.balance < v.amount ? m.balance : v.amount;
        if (amount > 0n) cands.push({ ...m, ...q, amount });
      }
      const decs = await decimalsOf(cands.map(c => c.mint));
      const have = await ataState(pk, cands.map(c => c.mint));
      const ataRent = await rentFor(165), items = [], unpriced = [], paid = new Set();
      let foreign = 0;
      const withdrawIx = await disc("withdraw_tokens");
      for (const c of cands) {
        const dec = decs[b58(c.mint)];
        if (dec === undefined) continue;
        const k = b58(c.mint), text = fmt(c.amount, dec) + " " + sym(c.mint);
        if (have.get(k) === "foreign") { foreign++; continue; }
        let value = await valueInLamports([{ mint: c.mint, amount: c.amount, decimals: dec }]);
        const create = have.get(k) !== "ok";
        if (create && !paid.has(k)) value -= ataRent;
        if (value <= 0) { unpriced.push(text); continue; }
        if (create) paid.add(k);
        const { pubkey, quarry, rewarder, vault, mint, amount } = c;
        items.push({ key: pubkey, value, label: "Quarry miner " + short(pubkey) + " · " + text + " staked",
          ixs: p => [...(create ? [createAta(p, mint)] : []), new W.TransactionInstruction({ programId: QUARRY,
            data: cat(withdrawIx, u64(amount)), keys: [
              meta(p, true, false),                 // miner authority = this wallet
              meta(pubkey, false, true),            // miner
              meta(quarry, false, true),
              meta(vault, false, true),             // miner vault (pays)
              meta(ata(p, mint), false, true),      // wallet's token account for the staked mint
              meta(ID.TOKEN, false, false),
              meta(rewarder, false, false)] })] });
      }
      const notes = [];
      if (unpriced.length) notes.push(unpricedNote(unpriced));
      if (stopped) notes.push(stopped + " position(s) are in a paused Quarry rewarder and cannot be withdrawn now.");
      if (foreign) notes.push(foreign + " position(s) skipped: the wallet's token account for them now belongs to another owner.");
      return { items: byValue(items), note: notes.join(" ") };
    },
  });
})();
