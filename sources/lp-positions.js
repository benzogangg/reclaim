"use strict";
// Concentrated-liquidity positions: unclaimed LP fees / farm rewards, and the rent of positions that are
// already empty. Liquidity itself is NEVER removed (that is the owner's live investment); fees are collected
// without touching it, and a position is closed only when it holds no liquidity. Payouts land in the wallet's
// own ATAs (created in the same item when missing; a wSOL ATA created here is closed again = plain SOL).
// Fee amounts of positions that still hold liquidity are measured by simulating the claim (their on-chain
// "owed" fields are stale until the program updates them); of empty positions they are read from the account.
// Account orders checked against mainnet transactions (2026-09-24).
//  - Meteora DLMM: PositionV2 (8120 bytes + 112 per bin beyond 70) has lb_pair @8, owner @40, lower/upper
//    bin @7912/7916, per bin: share u128 @72+16i, reward pendings @1192+48i+32/+40, fee pendings
//    @4552+48i+32/+40 (extension bins @8120+112i: share @0, rewards @48/56, fees @96/104).
//    claim_fee2(min,max,hook slices) and claim_reward2(i,min,max,slices) with the bin arrays
//    ["bin_array", pair, floor(bin/70) i64] as remaining accounts; close_position2 returns the rent (~0.057 SOL).
//  - Orca Whirlpools: Position PDA ["position", nft mint] (216 bytes): whirlpool @8, liquidity @72, ticks
//    @88/@92, fee_owed_a/b @112/@136, reward owed @144+24i+16. update_fees_and_rewards (tick arrays
//    ["tick_array", pool, start as decimal string]) + collect_fees_v2 / collect_reward_v2; close_position
//    (legacy NFT) or close_position_with_token_extensions (Token-2022 NFT, also closes the mint).
//  - Raydium CLMM: PersonalPositionState PDA ["position", nft mint] (281 bytes): pool @41, ticks @73/@77,
//    liquidity @81, fees owed @129/@137, reward owed @145+24i+16. decrease_liquidity_v2 with liquidity 0
//    collects fees + rewards (reward vault, wallet ATA, mint per initialized reward as remaining accounts);
//    close_position burns the NFT and returns the position (and Token-2022 mint) rent.
//  - Meteora DAMM v2: fees of live positions are claimed in raydium-meteora.js; here only positions without
//    liquidity are closed (close_position: burns the NFT, returns position + NFT mint + NFT account rent),
//    after claim_position_fee for leftover non-SOL fees (fee_a/b_pending @136/@144, rewards @248/@296).
(() => {
  const { W, P, ID, meta, gpa, readAccounts, tokenAccounts, disc, accDisc, u64, u32, cat, pda, enc, ata, short, b58, readU64,
    valueInLamports } = RC;
  const DLMM = P("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const WHIRL = P("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
  const CLMM = P("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
  const DAMM = P("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
  const MEMO = P("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  const ZERO = b58(ID.SYSTEM);
  const ATA_RENT = { [b58(ID.TOKEN)]: 2039280, [b58(ID.TOKEN22)]: 2200000 };   // Token-2022: conservative
  const MAX_SIM = 20;       // positions with liquidity whose fees are measured by simulation, per protocol
  const MAX_NFTS = 400;     // position-NFT candidates checked per wallet
  const MIN_CLAIM = 20000;  // lamports; a fee claim worth less than this does not pay for its share of the tx fee
  const NAMES = { So11111111111111111111111111111111111111112: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT" };

  const pk32 = (d, o) => new W.PublicKey(d.slice(o, o + 32));
  const dv = d => new DataView(d.buffer, d.byteOffset, d.byteLength);
  const i32 = (d, o) => dv(d).getInt32(o, true);
  const u128 = (d, o) => (readU64(d, o + 8) << 64n) | readU64(d, o);
  const i32be = n => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, false); return b; };
  const i32le = n => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return b; };
  const i64le = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(n), true); return b; };
  const eq8 = (d, h) => d && d.length >= 8 && h.every((x, i) => d[i] === x);
  const sol = n => (Number(n) / 1e9).toFixed(4) + " SOL";
  const tokAmount = d => (d && d.length >= 72 ? readU64(d, 64) : 0n);
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const uniq = keys => [...new Set(keys.map(b58))].map(P);
  async function readMap(keys) {
    const ks = uniq(keys), accs = await readAccounts(ks);
    return new Map(ks.map((k, i) => [b58(k), accs[i]]));
  }

  const createAta = (p, mint, prog) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(p, mint, prog), false, true), meta(p, false, false),
    meta(mint, false, false), meta(ID.SYSTEM, false, false), meta(prog, false, false)] });
  const closeAcc = (p, acct, prog) => new W.TransactionInstruction({ programId: prog, data: Uint8Array.of(9), keys: [
    meta(acct, false, true), meta(p, false, true), meta(p, true, false)] });

  // Token context for one protocol scan: mint -> token program + decimals, wallet ATA -> exists + balance.
  async function tokenCtx(pk, mints) {
    const ms = uniq(mints), mm = await readMap(ms), info = new Map();
    for (const m of ms) {
      const a = mm.get(b58(m));
      if (a) info.set(b58(m), { mint: m, prog: a.owner.equals(ID.TOKEN22) ? ID.TOKEN22 : ID.TOKEN, dec: a.data[44] });
    }
    const atas = [...info.values()].map(t => ata(pk, t.mint, t.prog)), am = await readMap(atas);
    for (const t of info.values()) { const a = am.get(b58(ata(pk, t.mint, t.prog))); t.exists = !!a; t.bal = tokAmount(a?.data); }
    return m => info.get(b58(m));
  }

  // Receiving side of one item: the wallet's ATAs for the given mints (deduplicated). `settled` = the amounts
  // are final (no liquidity left), so a created ATA that receives nothing can be closed again safely.
  function payouts(tok, mints) {
    const seen = new Set(), list = [];
    for (const m of mints) { const t = tok(m); if (t && !seen.has(b58(t.mint))) { seen.add(b58(t.mint)); list.push(t); } }
    return list;
  }
  function wrap(list, amounts, settled) {
    const close = list.map((t, i) => !t.exists && (t.mint.equals(ID.WSOL) || (settled && amounts[i] === 0n)));
    const cost = list.reduce((s, t, i) => s + (!t.exists && !close[i] ? ATA_RENT[b58(t.prog)] || 2200000 : 0), 0);
    return {
      pre: p => list.filter(t => !t.exists).map(t => createAta(p, t.mint, t.prog)),
      post: p => list.filter((t, i) => close[i]).map(t => closeAcc(p, ata(p, t.mint, t.prog), t.prog)),
      cost,
    };
  }
  // Value (lamports) and label text of token amounts paid to the wallet.
  async function worth(list, amounts) {
    const parts = list.map((t, i) => ({ mint: t.mint, amount: amounts[i], decimals: t.dec })).filter(x => x.amount > 0n);
    const value = await valueInLamports(parts);
    const text = parts.map(x => (Number(x.amount) / 10 ** x.decimals).toLocaleString("en-US", { maximumSignificantDigits: 4 })
      + " " + (NAMES[b58(x.mint)] || "token " + short(x.mint))).join(" + ");
    return { value, text };
  }

  // Simulates `ixs` and returns how much each of the wallet's ATAs in `list` gained (null if it fails).
  async function measure(pk, ixs, list) {
    const c = await RC.rpc();
    const msg = new W.TransactionMessage({ payerKey: pk, recentBlockhash: ZERO, instructions: ixs }).compileToLegacyMessage();
    const sim = await c.simulateTransaction(new W.VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true,
      commitment: "confirmed", accounts: { encoding: "base64", addresses: list.map(t => b58(ata(pk, t.mint, t.prog))) } });
    if (sim.value.err) return null;
    return list.map((t, i) => {
      const a = sim.value.accounts?.[i];
      const post = a ? tokAmount(b64(Array.isArray(a.data) ? a.data[0] : a.data)) : 0n;
      return post > t.bal ? post - t.bal : 0n;
    });
  }
  // Runs fn over items with at most 3 in flight.
  async function pool(list, fn) {
    const out = new Array(list.length);
    let next = 0;
    await Promise.all([0, 1, 2].map(async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i]); } }));
    return out;
  }

  // Claim item for a position that keeps its liquidity: measured by simulation; worthless claims are skipped.
  async function claimItem(pk, key, list, claim, label) {
    const w0 = wrap(list, list.map(() => 1n), false);
    const got = await measure(pk, [...w0.pre(pk), ...claim(pk)], list);
    if (!got || got.every(x => x === 0n)) return null;
    const { value, text } = await worth(list, got);
    if (value - w0.cost < MIN_CLAIM) return null;
    return { key, value: value - w0.cost, label: label + " · " + text, ixs: p => [...w0.pre(p), ...claim(p), ...w0.post(p)] };
  }
  // Close item for a position without liquidity: pending amounts are exact, rent comes back.
  async function closeItem(key, list, amounts, rent, claim, close, label) {
    const w = wrap(list, amounts, true);
    const { value, text } = await worth(list, amounts);
    return { key, value: rent + value - w.cost, label: label + " · rent " + sol(rent) + (text ? " + " + text : ""),
      ixs: p => [...(amounts.some(a => a > 0n) ? [...w.pre(p), ...claim(p), ...w.post(p)] : []), ...close(p)] };
  }

  // Position NFTs (Orca, Raydium, DAMM v2): single tokens in the wallet whose ["position", mint] PDA exists.
  // One read serves all three sources (shared for 20 s).
  let nftCache = null;
  function positionNfts(pk) {
    if (nftCache && nftCache.pk.equals(pk) && Date.now() - nftCache.t < 20000) return nftCache.p;
    const p = (async () => {
      const nfts = [];
      for (const prog of [ID.TOKEN, ID.TOKEN22])
        for (const { pubkey, account } of await tokenAccounts(pk, prog)) {
          const i = account.data?.parsed?.info;
          if (i && i.tokenAmount?.amount === "1" && i.tokenAmount?.decimals === 0)
            nfts.push({ nftAcc: pubkey, nftLamports: account.lamports, mint: P(i.mint), nftProg: prog, frozen: i.state === "frozen" });
        }
      const list = nfts.slice(0, MAX_NFTS);
      const progs = [WHIRL, CLMM, DAMM];
      const keys = list.flatMap(n => progs.map(g => pda([enc("position"), n.mint.toBytes()], g)[0]));
      const accs = await readAccounts(keys);
      const out = { [b58(WHIRL)]: [], [b58(CLMM)]: [], [b58(DAMM)]: [], capped: nfts.length - list.length };
      keys.forEach((k, j) => {
        const a = accs[j], n = list[Math.floor(j / 3)], g = progs[j % 3];
        if (a && a.owner.equals(g)) out[b58(g)].push({ ...n, position: k, posLamports: a.lamports, d: a.data });
      });
      return out;
    })();
    nftCache = { pk, t: Date.now(), p };
    p.catch(() => { if (nftCache?.p === p) nftCache = null; });
    return p;
  }
  const cappedNote = n => n ? " Only the first " + MAX_NFTS + " single-token accounts were checked for positions." : "";

  // ---------- Meteora DLMM ----------
  RC.registerSource({
    id: "lp-dlmm", title: "Meteora DLMM positions (fees + empty positions)", group: "rewards", perTx: 3, programs: [DLMM],
    async scan(pk) {
      const D_POS = await accDisc("PositionV2");
      const rows = (await gpa(DLMM, [{ memcmp: { offset: 40, bytes: b58(pk) } }])).filter(r => eq8(r.account.data, [...D_POS]));
      if (!rows.length) return { items: [] };
      const pos = rows.map(({ pubkey, account }) => {
        const d = account.data, lo = i32(d, 7912), hi = i32(d, 7916), w = hi - lo + 1;
        let liq = false, fx = 0n, fy = 0n;
        const r = [0n, 0n];
        for (let i = 0; i < Math.min(w, 70); i++) {
          if (u128(d, 72 + 16 * i) !== 0n) liq = true;
          r[0] += readU64(d, 1192 + 48 * i + 32); r[1] += readU64(d, 1192 + 48 * i + 40);
          fx += readU64(d, 4552 + 48 * i + 32); fy += readU64(d, 4552 + 48 * i + 40);
        }
        for (let i = 0; i < w - 70; i++) {
          const b = 8120 + 112 * i;
          if (b + 112 > d.length) { liq = true; break; }     // unexpected layout: treat as live
          if (u128(d, b) !== 0n) liq = true;
          r[0] += readU64(d, b + 48); r[1] += readU64(d, b + 56); fx += readU64(d, b + 96); fy += readU64(d, b + 104);
        }
        return { position: pubkey, lamports: account.lamports, pair: pk32(d, 8), lo, hi, liq, fx, fy, r };
      });
      const pairs = await readMap(pos.map(x => x.pair));
      const pairInfo = new Map();
      for (const [k, a] of pairs) {
        if (!a || a.data.length < 904) continue;
        const d = a.data;
        pairInfo.set(k, { mx: pk32(d, 88), my: pk32(d, 120), rx: pk32(d, 152), ry: pk32(d, 184),
          rewards: [0, 1].map(i => ({ mint: pk32(d, 264 + 144 * i), vault: pk32(d, 296 + 144 * i) })) });
      }
      const binArrays = x => {
        const out = [];
        for (let i = Math.floor(x.lo / 70); i <= Math.floor(x.hi / 70); i++) out.push(pda([enc("bin_array"), x.pair.toBytes(), i64le(i)], DLMM)[0]);
        return out;
      };
      const needBins = pos.filter(x => x.liq || x.fx + x.fy + x.r[0] + x.r[1] > 0n);
      const bins = await readMap(needBins.flatMap(binArrays));
      const tok = await tokenCtx(pk, [...pairInfo.values()].flatMap(q => [q.mx, q.my, ...q.rewards.map(r => r.mint).filter(m => b58(m) !== ZERO)]));
      const evt = pda([enc("__event_authority")], DLMM)[0];
      const [D_FEE, D_REW, D_CLOSE] = await Promise.all(["claim_fee2", "claim_reward2", "close_position2"].map(disc));

      const claimIxs = (x, q, rewardIdx, withFee) => p => {
        const ba = binArrays(x).map(k => meta(k, false, true));
        const tx = tok(q.mx), ty = tok(q.my), out = [];
        if (withFee) out.push(new W.TransactionInstruction({ programId: DLMM,
          data: cat(D_FEE, i32le(x.lo), i32le(x.hi), u32(2), Uint8Array.of(0, 0, 1, 0)), keys: [
            meta(x.pair, false, true), meta(x.position, false, true), meta(p, true, false),   // lb pair, position, owner signs
            meta(q.rx, false, true), meta(q.ry, false, true),                                  // pool reserves
            meta(ata(p, q.mx, tx.prog), false, true), meta(ata(p, q.my, ty.prog), false, true),  // the wallet's ATAs
            meta(q.mx, false, false), meta(q.my, false, false), meta(tx.prog, false, false), meta(ty.prog, false, false),
            meta(MEMO, false, false), meta(evt, false, false), meta(DLMM, false, false), ...ba] }));
        for (const i of rewardIdx) {
          const rw = q.rewards[i], tr = tok(rw.mint);
          out.push(new W.TransactionInstruction({ programId: DLMM,
            data: cat(D_REW, u64(i), i32le(x.lo), i32le(x.hi), u32(1), Uint8Array.of(2, 0)), keys: [
              meta(x.pair, false, true), meta(x.position, false, true), meta(p, true, false),
              meta(rw.vault, false, true), meta(rw.mint, false, false),
              meta(ata(p, rw.mint, tr.prog), false, true),                                   // the wallet's reward ATA
              meta(tr.prog, false, false), meta(MEMO, false, false), meta(evt, false, false), meta(DLMM, false, false), ...ba] }));
        }
        return out;
      };
      const closeIx = x => p => [new W.TransactionInstruction({ programId: DLMM, data: D_CLOSE, keys: [
        meta(x.position, false, true), meta(p, true, false), meta(p, false, true),           // position, owner, rent receiver = wallet
        meta(evt, false, false), meta(DLMM, false, false)] })];

      const items = [], live = [];
      let skipped = 0;
      for (const x of pos) {
        const q = pairInfo.get(b58(x.pair));
        const hasBins = binArrays(x).every(k => bins.get(b58(k)));
        const initRewards = q ? [0, 1].filter(i => b58(q.rewards[i].mint) !== ZERO && tok(q.rewards[i].mint)) : [];
        if (x.liq) { if (q && hasBins && tok(q.mx) && tok(q.my)) live.push({ x, q, initRewards }); continue; }
        const pend = x.fx + x.fy + x.r[0] + x.r[1] > 0n;
        if (!pend) {
          items.push({ key: x.position, value: x.lamports, label: "empty position " + short(x.position) + " · rent " + sol(x.lamports),
            ixs: closeIx(x) });
          continue;
        }
        if (!q || !hasBins || !tok(q.mx) || !tok(q.my) || [0, 1].some(i => x.r[i] > 0n && !initRewards.includes(i))) { skipped++; continue; }
        const rIdx = [0, 1].filter(i => x.r[i] > 0n);
        const list = payouts(tok, [q.mx, q.my, ...rIdx.map(i => q.rewards[i].mint)]);
        const amounts = list.map(t => (t.mint.equals(q.mx) ? x.fx : 0n) + (t.mint.equals(q.my) ? x.fy : 0n)
          + rIdx.reduce((s, i) => s + (t.mint.equals(q.rewards[i].mint) ? x.r[i] : 0n), 0n));
        items.push(await closeItem(x.position, list, amounts, x.lamports, claimIxs(x, q, rIdx, x.fx + x.fy > 0n), closeIx(x),
          "closed position " + short(x.position)));
      }
      const measured = await pool(live.slice(0, MAX_SIM), ({ x, q, initRewards }) =>
        claimItem(pk, x.position, payouts(tok, [q.mx, q.my, ...initRewards.map(i => q.rewards[i].mint)]),
          claimIxs(x, q, initRewards, true), "fees of position " + short(x.position)));
      items.push(...measured.filter(Boolean));
      const notes = [];
      if (skipped) notes.push(skipped + " empty position(s) could not be closed here (missing pool data); use app.meteora.ag.");
      if (live.length > MAX_SIM) notes.push("Fees checked for " + MAX_SIM + " of " + live.length + " active positions.");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });

  // ---------- Orca Whirlpools ----------
  RC.registerSource({
    id: "lp-orca", title: "Orca Whirlpool positions (fees + empty positions)", group: "rewards", perTx: 3, programs: [WHIRL],
    async scan(pk) {
      const all = await positionNfts(pk);
      const pos = all[b58(WHIRL)].filter(n => n.d.length === 216).map(n => {
        const d = n.d;
        return { ...n, pool: pk32(d, 8), liq: u128(d, 72), tl: i32(d, 88), tu: i32(d, 92), fa: readU64(d, 112), fb: readU64(d, 136),
          r: [0, 1, 2].map(i => readU64(d, 144 + 24 * i + 16)) };
      });
      if (!pos.length) return { items: [], note: cappedNote(all.capped) };
      const pools = await readMap(pos.map(x => x.pool));
      const pi = new Map();
      for (const [k, a] of pools) {
        if (!a || a.data.length < 653) continue;
        const d = a.data;
        pi.set(k, { spacing: dv(d).getUint16(41, true), ma: pk32(d, 101), va: pk32(d, 133), mb: pk32(d, 181), vb: pk32(d, 213),
          rewards: [0, 1, 2].map(i => ({ mint: pk32(d, 269 + 128 * i), vault: pk32(d, 301 + 128 * i) })) });
      }
      const tok = await tokenCtx(pk, [...pi.values()].flatMap(q => [q.ma, q.mb, ...q.rewards.map(r => r.mint).filter(m => b58(m) !== ZERO)]));
      const [D_UPD, D_FEE, D_REW, D_CL, D_CL22] = await Promise.all(
        ["update_fees_and_rewards", "collect_fees_v2", "collect_reward_v2", "close_position", "close_position_with_token_extensions"].map(disc));
      const tickArray = (pool, t, spacing) => {
        const span = spacing * 88, start = Math.floor(t / span) * span;
        return pda([enc("tick_array"), pool.toBytes(), enc(String(start))], WHIRL)[0];
      };
      const claimIxs = (x, q, rIdx, update, withFee) => p => {
        const out = [];
        if (update) out.push(new W.TransactionInstruction({ programId: WHIRL, data: D_UPD, keys: [
          meta(x.pool, false, true), meta(x.position, false, true),
          meta(tickArray(x.pool, x.tl, q.spacing), false, false), meta(tickArray(x.pool, x.tu, q.spacing), false, false)] }));
        const head = [meta(x.pool, false, false), meta(p, true, false), meta(x.position, false, true), meta(x.nftAcc, false, false)];
        const ta = tok(q.ma), tb = tok(q.mb);
        if (withFee) out.push(new W.TransactionInstruction({ programId: WHIRL, data: cat(D_FEE, Uint8Array.of(0)), keys: [...head,
          meta(q.ma, false, false), meta(q.mb, false, false),
          meta(ata(p, q.ma, ta.prog), false, true), meta(q.va, false, true),      // the wallet's ATA a, vault a
          meta(ata(p, q.mb, tb.prog), false, true), meta(q.vb, false, true),      // the wallet's ATA b, vault b
          meta(ta.prog, false, false), meta(tb.prog, false, false), meta(MEMO, false, false)] }));
        for (const i of rIdx) {
          const rw = q.rewards[i], tr = tok(rw.mint);
          out.push(new W.TransactionInstruction({ programId: WHIRL, data: cat(D_REW, Uint8Array.of(i, 0)), keys: [...head,
            meta(ata(p, rw.mint, tr.prog), false, true), meta(rw.mint, false, false), meta(rw.vault, false, true),
            meta(tr.prog, false, false), meta(MEMO, false, false)] }));
        }
        return out;
      };
      const closeIx = x => p => {
        const t22 = x.nftProg.equals(ID.TOKEN22);
        return [new W.TransactionInstruction({ programId: WHIRL, data: t22 ? D_CL22 : D_CL, keys: [
          meta(p, true, false), meta(p, false, true),                           // NFT holder signs, rent receiver = wallet
          meta(x.position, false, true), meta(x.mint, false, true), meta(x.nftAcc, false, true), meta(x.nftProg, false, false)] })];
      };
      const items = [], live = [];
      let skipped = 0;
      const lamportsOf = await readMap(pos.filter(x => x.nftProg.equals(ID.TOKEN22)).map(x => x.mint));
      for (const x of pos) {
        const q = pi.get(b58(x.pool));
        if (!q || !tok(q.ma) || !tok(q.mb)) { skipped++; continue; }
        const initRewards = [0, 1, 2].filter(i => b58(q.rewards[i].mint) !== ZERO && tok(q.rewards[i].mint));
        if (x.liq > 0n) { live.push({ x, q, initRewards }); continue; }
        if (x.frozen) { skipped++; continue; }
        const rIdx = [0, 1, 2].filter(i => x.r[i] > 0n);
        if (rIdx.some(i => !initRewards.includes(i))) { skipped++; continue; }
        const rent = x.posLamports + x.nftLamports + (lamportsOf.get(b58(x.mint))?.lamports || 0);
        const list = payouts(tok, [q.ma, q.mb, ...rIdx.map(i => q.rewards[i].mint)]);
        const amounts = list.map(t => (t.mint.equals(q.ma) ? x.fa : 0n) + (t.mint.equals(q.mb) ? x.fb : 0n)
          + rIdx.reduce((s, i) => s + (t.mint.equals(q.rewards[i].mint) ? x.r[i] : 0n), 0n));
        items.push(await closeItem(x.position, list, amounts, rent, claimIxs(x, q, rIdx, false, x.fa + x.fb > 0n), closeIx(x),
          (amounts.some(a => a > 0n) ? "closed position " : "empty position ") + short(x.position)));
      }
      const measured = await pool(live.slice(0, MAX_SIM), ({ x, q, initRewards }) =>
        claimItem(pk, x.position, payouts(tok, [q.ma, q.mb, ...initRewards.map(i => q.rewards[i].mint)]),
          claimIxs(x, q, initRewards, true, true), "fees of position " + short(x.position)));
      items.push(...measured.filter(Boolean));
      const notes = [];
      if (skipped) notes.push(skipped + " position(s) skipped (frozen NFT or unusual pool); use orca.so.");
      if (live.length > MAX_SIM) notes.push("Fees checked for " + MAX_SIM + " of " + live.length + " active positions.");
      return { items: items.sort((a, b) => b.value - a.value), note: (notes.join(" ") + cappedNote(all.capped)).trim() };
    },
  });

  // ---------- Raydium CLMM ----------
  RC.registerSource({
    id: "lp-raydium-clmm", title: "Raydium CLMM positions (fees + empty positions)", group: "rewards", perTx: 3, programs: [CLMM],
    async scan(pk) {
      const all = await positionNfts(pk);
      const pos = all[b58(CLMM)].filter(n => n.d.length === 281).map(n => {
        const d = n.d;
        return { ...n, pool: pk32(d, 41), tl: i32(d, 73), tu: i32(d, 77), liq: u128(d, 81), f0: readU64(d, 129), f1: readU64(d, 137),
          r: [0, 1, 2].map(i => readU64(d, 145 + 24 * i + 16)) };
      });
      if (!pos.length) return { items: [], note: cappedNote(all.capped) };
      const pools = await readMap(pos.map(x => x.pool));
      const pi = new Map();
      for (const [k, a] of pools) {
        if (!a || a.data.length < 904) continue;
        const d = a.data;
        pi.set(k, { m0: pk32(d, 73), m1: pk32(d, 105), v0: pk32(d, 137), v1: pk32(d, 169), spacing: dv(d).getUint16(235, true),
          status: d[389],   // bit set = disabled: 2 collect fee, 3 collect reward
          rewards: [0, 1, 2].map(i => ({ mint: pk32(d, 397 + 169 * i + 57), vault: pk32(d, 397 + 169 * i + 89) }))
            .filter(r => b58(r.mint) !== ZERO) });
      }
      const exts = await readMap([...pi.keys()].map(k => pda([enc("pool_tick_array_bitmap_extension"), P(k).toBytes()], CLMM)[0]));
      const tok = await tokenCtx(pk, [...pi.values()].flatMap(q => [q.m0, q.m1, ...q.rewards.map(r => r.mint)]));
      const [D_DEC, D_CL] = await Promise.all(["decrease_liquidity_v2", "close_position"].map(disc));
      const tickArray = (pool, t, spacing) => {
        const span = spacing * 60, start = Math.floor(t / span) * span;
        return pda([enc("tick_array"), pool.toBytes(), i32be(start)], CLMM)[0];
      };
      const collectIx = (x, q) => p => {
        const ext = pda([enc("pool_tick_array_bitmap_extension"), x.pool.toBytes()], CLMM)[0];
        const protocol = pda([enc("position"), x.pool.toBytes(), i32le(x.tl), i32le(x.tu)], CLMM)[0];   // deprecated, unchecked
        return [new W.TransactionInstruction({ programId: CLMM, data: cat(D_DEC, new Uint8Array(16), u64(0), u64(0)), keys: [
          meta(p, true, false), meta(x.nftAcc, false, false), meta(x.position, false, true), meta(x.pool, false, true),
          meta(protocol, false, false), meta(q.v0, false, true), meta(q.v1, false, true),
          meta(tickArray(x.pool, x.tl, q.spacing), false, true), meta(tickArray(x.pool, x.tu, q.spacing), false, true),
          meta(ata(p, q.m0, tok(q.m0).prog), false, true), meta(ata(p, q.m1, tok(q.m1).prog), false, true),   // the wallet's ATAs
          meta(ID.TOKEN, false, false), meta(ID.TOKEN22, false, false), meta(MEMO, false, false),
          meta(q.m0, false, false), meta(q.m1, false, false),
          ...(exts.get(b58(ext)) ? [meta(ext, false, true)] : []),
          ...q.rewards.flatMap(r => [meta(r.vault, false, true), meta(ata(p, r.mint, tok(r.mint).prog), false, true), meta(r.mint, false, false)])] })];
      };
      const closeIx = x => p => [new W.TransactionInstruction({ programId: CLMM, data: D_CL, keys: [
        meta(p, true, true), meta(x.mint, false, true), meta(x.nftAcc, false, true), meta(x.position, false, true),
        meta(ID.SYSTEM, false, false), meta(x.nftProg, false, false), ...(x.frozen ? [meta(x.pool, false, false)] : [])] })];
      const items = [], live = [];
      let skipped = 0;
      const lamportsOf = await readMap(pos.filter(x => x.nftProg.equals(ID.TOKEN22)).map(x => x.mint));
      for (const x of pos) {
        const q = pi.get(b58(x.pool));
        if (!q || !tok(q.m0) || !tok(q.m1) || q.rewards.some(r => !tok(r.mint))) { skipped++; continue; }
        const list = payouts(tok, [q.m0, q.m1, ...q.rewards.map(r => r.mint)]);
        if (x.liq > 0n) { live.push({ x, q, list }); continue; }
        const rent = x.posLamports + x.nftLamports + (lamportsOf.get(b58(x.mint))?.lamports || 0);
        const amounts = list.map(t => (t.mint.equals(q.m0) ? x.f0 : 0n) + (t.mint.equals(q.m1) ? x.f1 : 0n)
          + q.rewards.reduce((s, r, i) => s + (t.mint.equals(r.mint) ? x.r[i] : 0n), 0n));
        const owed = amounts.some(a => a > 0n);
        if (((q.status & 4) && x.f0 + x.f1 > 0n) || ((q.status & 8) && x.r.some(r => r > 0n))) { skipped++; continue; }   // pool paused
        // An empty position only needs its own payout ATAs when something is still owed.
        items.push(owed
          ? await closeItem(x.position, list, amounts, rent, collectIx(x, q), closeIx(x), "closed position " + short(x.position))
          : { key: x.position, value: rent, label: "empty position " + short(x.position) + " · rent " + sol(rent), ixs: closeIx(x) });
      }
      const measured = await pool(live.slice(0, MAX_SIM), ({ x, q, list }) =>
        claimItem(pk, x.position, list, collectIx(x, q), "fees of position " + short(x.position)));
      items.push(...measured.filter(Boolean));
      const notes = [];
      if (skipped) notes.push(skipped + " position(s) skipped (pool has fee/reward collection paused, or unusual pool); use raydium.io.");
      if (live.length > MAX_SIM) notes.push("Fees checked for " + MAX_SIM + " of " + live.length + " active positions.");
      return { items: items.sort((a, b) => b.value - a.value), note: (notes.join(" ") + cappedNote(all.capped)).trim() };
    },
  });

  // ---------- Meteora DAMM v2: empty positions ----------
  RC.registerSource({
    id: "lp-damm-v2-close", title: "Meteora DAMM v2 empty positions", group: "rent", perTx: 5, programs: [DAMM],
    async scan(pk) {
      const all = await positionNfts(pk);
      const pos = all[b58(DAMM)].filter(n => n.d.length === 408 && n.nftProg.equals(ID.TOKEN22)).map(n => {
        const d = n.d;
        const fa = readU64(d, 136), fb = readU64(d, 144);
        return { ...n, pool: pk32(d, 8), liq: u128(d, 152) + u128(d, 168) + u128(d, 184), fa, fb, fees: fa + fb,
          rewards: readU64(d, 248) + readU64(d, 296) };
      }).filter(x => x.liq === 0n);
      if (!pos.length) return { items: [] };
      // Leftover fees are claimed in the same item. Positions whose leftover fee includes SOL are left to the
      // "DAMM v2 position fees" source (raydium-meteora.js) so the two never act on the same position;
      // they can be closed on the next scan. Pending farm rewards are not handled here.
      const pools = await readMap(pos.filter(x => x.fees > 0n).map(x => x.pool));
      const pi = new Map();
      for (const [k, a] of pools) if (a) pi.set(k, { ma: pk32(a.data, 168), mb: pk32(a.data, 200), va: pk32(a.data, 232), vb: pk32(a.data, 264) });
      const tok = await tokenCtx(pk, [...pi.values()].flatMap(q => [q.ma, q.mb]));
      const mints = await readMap(pos.map(x => x.mint));
      const [D, D_FEE] = await Promise.all(["close_position", "claim_position_fee"].map(disc));
      const auth = pda([enc("pool_authority")], DAMM)[0], evt = pda([enc("__event_authority")], DAMM)[0];
      const items = [];
      let later = 0, skipped = 0;
      for (const x of pos) {
        const q = pi.get(b58(x.pool));
        if (x.frozen || x.rewards > 0n || (x.fees > 0n && (!q || !tok(q.ma) || !tok(q.mb)))) { skipped++; continue; }
        if (x.fees > 0n && ((q.ma.equals(ID.WSOL) && x.fa > 0n) || (q.mb.equals(ID.WSOL) && x.fb > 0n))) { later++; continue; }
        const rent = x.posLamports + x.nftLamports + (mints.get(b58(x.mint))?.lamports || 0);
        const close = p => [new W.TransactionInstruction({ programId: DAMM, data: D, keys: [
          meta(x.mint, false, true), meta(x.nftAcc, false, true), meta(x.pool, false, true), meta(x.position, false, true),
          meta(auth, false, false),
          meta(p, false, true),                                   // rent receiver = wallet
          meta(p, true, false),                                   // NFT holder signs
          meta(ID.TOKEN22, false, false), meta(evt, false, false), meta(DAMM, false, false)] })];
        if (x.fees === 0n) {
          items.push({ key: x.position, value: rent, label: "empty position " + short(x.position) + " · rent " + sol(rent), ixs: close });
          continue;
        }
        const ta = tok(q.ma), tb = tok(q.mb), list = payouts(tok, [q.ma, q.mb]);
        const amounts = list.map(t => (t.mint.equals(q.ma) ? x.fa : 0n) + (t.mint.equals(q.mb) ? x.fb : 0n));
        const claim = p => [new W.TransactionInstruction({ programId: DAMM, data: D_FEE, keys: [
          meta(auth, false, false), meta(x.pool, false, false), meta(x.position, false, true),
          meta(ata(p, q.ma, ta.prog), false, true), meta(ata(p, q.mb, tb.prog), false, true),   // the wallet's ATAs
          meta(q.va, false, true), meta(q.vb, false, true), meta(q.ma, false, false), meta(q.mb, false, false),
          meta(x.nftAcc, false, false), meta(p, true, false), meta(ta.prog, false, false), meta(tb.prog, false, false),
          meta(evt, false, false), meta(DAMM, false, false)] })];
        items.push(await closeItem(x.position, list, amounts, rent, claim, close, "closed position " + short(x.position)));
      }
      const notes = [];
      if (later) notes.push(later + " empty position(s) still hold SOL fees: claim them in \"Meteora DAMM v2 position fees\" first; they can be closed on the next scan.");
      if (skipped) notes.push(skipped + " empty position(s) with pending farm rewards or unusual pools are not listed; use meteora.ag.");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });
})();
