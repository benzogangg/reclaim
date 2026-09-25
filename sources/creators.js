"use strict";
// Creator tools: SOL that NFT drops, payment splitters and token streams keep after everyone forgot them.
//
// Metaplex Candy Machines. The machine account stores every config line, so it often holds 1–10+ SOL of rent.
//  - v1 (cndyAnr…): Config account, authority @8. withdraw_funds [config w, authority s] drains it to the
//    authority. v1 minting has been broken for years (its metadata CPI was removed), so this is always safe.
//  - v2 (cndy3Z…): CandyMachine, authority @8. withdraw_funds [machine w, authority s w, collection PDA w]
//    closes it; the optional collection PDA (seeds "collection", machine) is drained too; it must be omitted when it does not exist.
//  - v3 (CndyV3…, authority @16) and Core (CMACY…, authority @8): withdraw [machine w, authority s w].
//  - Candy Guards (Guard1… and the Core one CMAGAK…), authority @41: withdraw [guard w, authority s w].
// All four instructions send every lamport to the authority, which must sign: only the wallet itself.
// Closing a machine that still has unminted items ends that drop, so those machines (and the guard in front of
// them) are listed separately and opt-in; sold-out / ended ones are on by default.
//
// Streamflow (strmRq…): stream metadata (1104 bytes): withdrawn @17, end @33, sender @49, recipient @113,
// recipient tokens @145, mint @177, escrow @209, treasury @241, partner @325, net deposited @417, period @425,
// amount/period @433, cliff @441, cliff amount @449, closed @671, pause start @672, last rate change @688,
// unlocked at last rate change @696. withdraw(u64::MAX) sends the unlocked tokens to the recipient's token
// account (the program also pays out the stream's own pre-set Streamflow/partner fee from the escrow, as every
// Streamflow withdraw does; nothing comes from the wallet).
//
// Hydra fanout (hyDQ4…), wallet-membership model: voucher (disc, fanout @8, total inflow @40, last inflow @48,
// member @57, shares @89). process_distribute_wallet(false) pays the member its share of what arrived in the
// fanout's holding account since its last distribution. Anyone may call it; the SOL always goes to the member.
(() => {
  const { W, P, ID, meta, gpa, readAccounts, disc, accDisc, u64, readU64, cat, pda, enc, ata, short, b58 } = RC;
  const CM1 = P("cndyAnrLdpjq1Ssp1z8xxDsB8dxe7u4HL5Nxi2K5WXZ");
  const CM2 = P("cndy3Z4yapfJBmL3ShUp5exZKqR3z33thTzeNMm2gRZ");
  const CM3 = P("CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR");
  const GUARD = P("Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g");
  const CMCORE = P("CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J");
  const GUARDCORE = P("CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ");
  const STREAMFLOW = P("strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m");
  const SF_TREASURY = P("5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw");
  const HYDRA = P("hyDQ4Nz1eYyegS6JfenyKwKzYxRsCWCriYSAjtzP4Vg");
  const ATA_RENT = 2039280;

  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const toB58 = u8 => { let n = 0n; for (const x of u8) n = n * 256n + BigInt(x); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of u8) { if (x) break; s = "1" + s; } return s; };
  const view = d => new DataView(d.buffer, d.byteOffset, d.byteLength);
  const pk32 = (d, o) => new W.PublicKey(d.slice(o, o + 32));

  // ---------- Candy Machines ----------

  // v2 CandyMachine header: walks the variable-length fields up to items_available.
  function cm2Status(d, now) {
    try {
      const v = view(d);
      let o = 72;
      o += d[o] === 1 ? 33 : 1;                       // token_mint: Option<Pubkey>
      const redeemed = v.getBigUint64(o, true); o += 8;
      const str = () => { const n = v.getUint32(o, true); o += 4 + n; };
      str(); o += 8; str(); o += 2 + 8 + 1 + 1;         // uuid, price, symbol, fee, max supply, is_mutable, retain
      o += d[o] === 1 ? 9 : 1;                        // go_live_date: Option<i64>
      let endType = -1, endNum = 0n;
      if (d[o] === 1) { endType = d[o + 1]; endNum = v.getBigUint64(o + 2, true); o += 10; } else o += 1;
      o += 4 + v.getUint32(o, true) * 34;             // creators
      if (d[o] === 1) { o += 1; str(); str(); o += 32; } else o += 1;          // hidden_settings
      if (d[o] === 1) { o += 1 + 1 + 32 + 1; o += d[o] === 1 ? 9 : 1; } else o += 1;  // whitelist_mint_settings
      const available = v.getBigUint64(o, true);
      const ended = redeemed >= available || (endType === 0 && endNum < now) || (endType === 1 && redeemed >= endNum);
      return { live: !ended, left: available - redeemed };
    } catch { return { live: true, left: -1n }; }   // unreadable: treat as live (opt-in)
  }

  const withdrawIx = (program, data, account, extra = []) => p => [new W.TransactionInstruction({ programId: program, data, keys: [
    meta(account, false, true),       // machine / config / guard: closed or drained
    meta(p, true, true),              // authority: signs, receives every lamport
    ...extra.map(k => meta(k, false, true))] })];

  let cmCache = null;
  async function candy(pk) {
    if (cmCache && cmCache.pk.equals(pk) && Date.now() - cmCache.t < 20000) return cmCache.p;
    const p = (async () => {
      const [dCM, dCfg, dGuard, dWithdrawFunds, dWithdraw] = await Promise.all([accDisc("CandyMachine"), accDisc("Config"),
        accDisc("CandyGuard"), disc("withdraw_funds"), disc("withdraw")]);
      const f = (d, off) => [{ memcmp: { offset: 0, bytes: toB58(d) } }, { memcmp: { offset: off, bytes: b58(pk) } }];
      const [v1, v2, v3, core, g3, gCore] = await Promise.all([
        gpa(CM1, f(dCfg, 8), { offset: 0, length: 0 }),
        gpa(CM2, f(dCM, 8), { offset: 0, length: 1000 }),
        gpa(CM3, f(dCM, 16), { offset: 0, length: 128 }),
        gpa(CMCORE, f(dCM, 8), { offset: 0, length: 120 }),
        gpa(GUARD, f(dGuard, 41), { offset: 0, length: 0 }),
        gpa(GUARDCORE, f(dGuard, 41), { offset: 0, length: 0 }),
      ]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const items = [], liveGuards = new Set();
      for (const { pubkey, account: a } of v1)
        items.push({ live: false, key: pubkey, value: a.lamports, label: "Candy Machine v1 config " + short(pubkey),
          ixs: withdrawIx(CM1, dWithdrawFunds, pubkey) });
      // v2: the collection PDA (if it exists) is drained in the same instruction.
      const cols = v2.map(x => pda([enc("collection"), x.pubkey.toBytes()], CM2)[0]);
      const colInfo = cols.length ? await readAccounts(cols) : [];
      v2.forEach(({ pubkey, account: a }, i) => {
        const col = colInfo[i] && colInfo[i].owner.equals(CM2) ? cols[i] : null;
        const st = cm2Status(a.data, now);
        items.push({ live: st.live, key: pubkey, value: a.lamports + (col ? colInfo[i].lamports : 0),
          label: "Candy Machine v2 " + short(pubkey) + (st.live ? " · " + (st.left >= 0n ? st.left + " unminted" : "may still be minting") : ""),
          ixs: withdrawIx(CM2, dWithdrawFunds, pubkey, col ? [col] : []) });
      });
      for (const [list, prog, name, off] of [[v3, CM3, "Candy Machine v3", 112], [core, CMCORE, "Core Candy Machine", 104]]) {
        for (const { pubkey, account: a } of list) {
          const d = a.data, redeemed = readU64(d, off), available = readU64(d, off + 8);
          const live = redeemed < available;
          if (live) liveGuards.add(b58(pk32(d, off - 64)));   // mint_authority: the guard in front of it
          items.push({ live, key: pubkey, value: a.lamports,
            label: name + " " + short(pubkey) + (live ? " · " + (available - redeemed) + " unminted" : ""),
            ixs: withdrawIx(prog, dWithdraw, pubkey) });
        }
      }
      for (const [list, prog, name] of [[g3, GUARD, "Candy Guard"], [gCore, GUARDCORE, "Core Candy Guard"]])
        for (const { pubkey, account: a } of list) {
          const live = liveGuards.has(b58(pubkey));
          items.push({ live, key: pubkey, value: a.lamports, label: name + " " + short(pubkey) + (live ? " · guards a machine with unminted items" : ""),
            ixs: withdrawIx(prog, dWithdraw, pubkey) });
        }
      return items.sort((a, b) => b.value - a.value);
    })();
    cmCache = { pk, t: Date.now(), p };
    p.catch(() => { cmCache = null; });
    return p;
  }

  const CANDY_PROGRAMS = [CM1, CM2, CM3, CMCORE, GUARD, GUARDCORE];
  RC.registerSource({
    id: "candy-machines", title: "Candy Machines (sold out or ended)", group: "rent", perTx: 10, programs: CANDY_PROGRAMS,
    async scan(pk) {
      const all = await candy(pk), live = all.filter(i => i.live).length;
      return { items: all.filter(i => !i.live),
        note: live ? live + " more machine(s) still have unminted items — they are listed under “Candy Machines still minting”." : "" };
    },
  });
  RC.registerSource({
    id: "candy-machines-live", title: "Candy Machines still minting — closing ends the drop", group: "rent", perTx: 10,
    programs: CANDY_PROGRAMS, defaultOn: false,
    async scan(pk) { return { items: (await candy(pk)).filter(i => i.live) }; },
  });

  // ---------- Streamflow ----------

  // Mirrors calculateUnlockedAmount in @streamflow/stream.
  function unlocked(d, now) {
    const v = view(d), u = o => v.getBigUint64(o, true);
    const deposited = u(417), cliff = u(441), period = u(425) || 1n, lrc = u(688);
    const end = u(33);
    if (now < cliff) return 0n;
    if (now > end) return deposited;
    const base = lrc === 0n ? u(449) : u(696), from = lrc === 0n ? cliff : lrc;
    const s = (now - from) / period * u(433) + base;
    return s < deposited ? s : deposited;
  }

  RC.registerSource({
    id: "streamflow", title: "Streamflow vested tokens", group: "rewards", perTx: 3, programs: [STREAMFLOW],
    async scan(pk) {
      const found = await gpa(STREAMFLOW, [{ dataSize: 1104 }, { memcmp: { offset: 113, bytes: b58(pk) } }, { memcmp: { offset: 671, bytes: "1" } }]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const cand = [];
      for (const { pubkey, account: a } of found) {
        const d = a.data, v = view(d);
        if (v.getBigUint64(672, true) !== 0n) continue;              // paused
        const amount = unlocked(d, now) - v.getBigUint64(17, true);
        if (amount <= 0n) continue;
        cand.push({ pubkey, amount, recipientTokens: pk32(d, 145), mint: pk32(d, 177), escrow: pk32(d, 209),
          partner: pk32(d, 325) });
      }
      if (!cand.length) return { items: [] };
      const mints = [...new Map(cand.map(c => [b58(c.mint), c.mint])).values()];
      const mintInfo = new Map((await readAccounts(mints)).map((m, i) => [b58(mints[i]), m]));
      const withProg = cand.map(c => {
        const m = mintInfo.get(b58(c.mint));
        const prog = m && (m.owner.equals(ID.TOKEN22) ? ID.TOKEN22 : m.owner.equals(ID.TOKEN) ? ID.TOKEN : null);
        return { ...c, prog, decimals: m ? m.data[44] : 0,
          treasuryTokens: prog && ata(SF_TREASURY, c.mint, prog), partnerTokens: prog && ata(c.partner, c.mint, prog) };
      }).filter(c => c.prog);
      const tokenAccs = withProg.flatMap(c => [c.recipientTokens, c.treasuryTokens, c.partnerTokens]);
      const infos = await readAccounts(tokenAccs);
      const items = [];
      let blocked = 0;
      for (let i = 0; i < withProg.length; i++) {
        const c = withProg[i], [rt, tt, pt] = infos.slice(i * 3, i * 3 + 3);
        const ownAta = ata(pk, c.mint, c.prog);
        if (!c.recipientTokens.equals(ownAta)) continue;              // tokens must land in the wallet's own ATA
        if (!tt || !pt) { blocked++; continue; }
        const worth = await RC.valueInLamports([{ mint: c.mint, amount: c.amount, decimals: c.decimals }]);
        const value = worth - (rt ? 0 : ATA_RENT);
        if (value <= 0) continue;
        const data = cat(await disc("withdraw"), u64(0xffffffffffffffffn));   // u64::MAX = everything unlocked
        const needAta = !rt;
        const amt = Number(c.amount) / 10 ** c.decimals;
        items.push({ key: c.pubkey, value,
          feePayees: [SF_TREASURY, c.partner],   // Streamflow's own fee is paid out of the stream escrow, not the wallet
          label: "stream " + short(c.pubkey) + " · " + amt.toLocaleString("en-US", { maximumFractionDigits: 4 }) + " " + short(c.mint),
          ixs: p => [
            ...(needAta ? [new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
              meta(p, true, true), meta(ownAta, false, true), meta(p, false, false), meta(c.mint, false, false),
              meta(ID.SYSTEM, false, false), meta(c.prog, false, false)] })] : []),
            new W.TransactionInstruction({ programId: STREAMFLOW, data, keys: [
              meta(p, true, true),                   // authority: the recipient signs
              meta(p, false, true),                  // recipient: this wallet
              meta(c.recipientTokens, false, true),  // recipient's token account: receives the tokens
              meta(c.pubkey, false, true),           // stream metadata
              meta(c.escrow, false, true),           // escrow token account
              meta(SF_TREASURY, false, true),
              meta(c.treasuryTokens, false, true),
              meta(c.partner, false, true),
              meta(c.partnerTokens, false, true),
              meta(c.mint, false, true),
              meta(c.prog, false, false)] })] });
      }
      const notes = [];
      if (blocked) notes.push(blocked + " stream(s) skipped: a fee token account of Streamflow or its partner is missing (withdraw it on app.streamflow.finance).");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });

  // ---------- Hydra fanout ----------

  RC.registerSource({
    id: "hydra", title: "Hydra fanout payouts", group: "rewards", perTx: 5, programs: [HYDRA],
    async scan(pk) {
      const dVoucher = await accDisc("FanoutMembershipVoucher");
      const vouchers = await gpa(HYDRA, [{ memcmp: { offset: 0, bytes: toB58(dVoucher) } }, { memcmp: { offset: 57, bytes: b58(pk) } }]);
      if (!vouchers.length) return { items: [] };
      const fanoutKeys = [...new Map(vouchers.map(x => { const k = pk32(x.account.data, 8); return [b58(k), k]; })).values()];
      const fanouts = new Map();
      (await readAccounts(fanoutKeys)).forEach((a, i) => {
        if (!a || !a.owner.equals(HYDRA)) return;
        const d = a.data, v = view(d);
        let o = 40; o += 4 + v.getUint32(o, true);
        const holding = pk32(d, o); o += 32;
        const totalShares = v.getBigUint64(o, true), totalInflow = v.getBigUint64(o + 16, true), lastSnapshot = v.getBigUint64(o + 24, true);
        const model = d[o + 32 + 2 + 8];
        fanouts.set(b58(fanoutKeys[i]), { key: fanoutKeys[i], holding, totalShares, totalInflow, lastSnapshot, model });
      });
      const holdKeys = [...fanouts.values()].map(f => f.holding);
      const holds = await readAccounts(holdKeys);
      const holdMap = new Map(holdKeys.map((k, i) => [b58(k), holds[i]]));
      const dDist = cat(await disc("process_distribute_wallet"), Uint8Array.of(0));
      const items = [];
      for (const { pubkey, account: a } of vouchers) {
        const f = fanouts.get(b58(pk32(a.data, 8)));
        if (!f || f.model !== 0 || f.totalShares === 0n) continue;   // wallet-membership fanouts only
        const h = holdMap.get(b58(f.holding));
        if (!h) continue;
        const rent = BigInt(890880 + h.data.length * 6960);
        const snap = BigInt(h.lamports) - rent;
        const inflow = f.totalInflow + (snap > f.lastSnapshot ? snap - f.lastSnapshot : 0n);
        const v = view(a.data), amount = (inflow - v.getBigUint64(48, true)) * v.getBigUint64(89, true) / f.totalShares;
        if (amount <= 0n) continue;
        const forMint = pda([enc("fanout-config"), f.key.toBytes(), ID.WSOL.toBytes()], HYDRA)[0];
        const forMintVoucher = pda([enc("fanout-membership"), forMint.toBytes(), pk.toBytes(), ID.WSOL.toBytes()], HYDRA)[0];
        const memberWsol = ata(pk, ID.WSOL);
        items.push({ key: pubkey, value: Number(amount), label: "fanout " + short(f.key) + " · member share",
          ixs: p => [new W.TransactionInstruction({ programId: HYDRA, data: dDist, keys: [
            meta(p, true, true),              // payer
            meta(p, false, true),             // member: this wallet, receives the SOL
            meta(pubkey, false, true),        // membership voucher
            meta(f.key, false, true),         // fanout
            meta(f.holding, false, true),     // holding account: pays out
            meta(forMint, false, true),       // unused when distributing SOL (placeholders as the Hydra SDK passes them)
            meta(forMintVoucher, false, true),
            meta(ID.WSOL, false, false),
            meta(memberWsol, false, true),
            meta(ID.SYSTEM, false, false),
            meta(ID.RENT, false, false),
            meta(ID.TOKEN, false, false)] })] });
      }
      return { items: items.sort((a, b) => b.value - a.value) };
    },
  });
})();
