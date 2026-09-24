"use strict";
// Tokens that already belong to the wallet but sit inside a program account: vesting escrows, launch vaults,
// governance deposits, unstaked tokens. Everything is paid to the wallet's own token account (created
// idempotently by the wallet when missing; its rent is subtracted from the value).
//
// Jupiter Lock (LocpQg…, VestingEscrow 296 bytes): recipient @8, token_mint @40, creator @72, base @104,
//   token_program_flag @139 (0 Token, 1 Token-2022), cliff_time @144, frequency @152, cliff_unlock_amount @160,
//   amount_per_period @168, number_of_period @176, total_claimed_amount @184, vesting_start_time @192,
//   cancelled_at @200. Unlocked = cliff_unlock + min(periods, (now − cliff)/frequency) · amount_per_period
//   once now ≥ cliff. `claim_v2(max_amount, Some([]))` sends unlocked − claimed from the escrow's ATA to the
//   recipient's token account; the recipient signs. Accounts: escrow, mint, escrow ATA, recipient,
//   recipient token, memo, token program, event authority, program.
// Meteora Alpha Vault (vaU6kP…, Escrow 136 bytes): vault @8, owner @40, total_deposit @72, claimed_token @80,
//   refunded @96. Vault 472 bytes: pool @8, token_vault @40 (quote), token_out_vault @72 (bought token),
//   quote_mint @104, base_mint @136, total_deposit @240, swapped_amount @256, bought_token @264,
//   start_vesting_point @288, end_vesting_point @296, activation_type @353 (0 slot, 1 unix time).
//   After the launch: `withdraw_remaining_quote` returns the unused deposit share
//   (total_deposit − swapped)·deposit/total_deposit; `claim_token` pays the vested share of bought_token
//   (linear from start to end vesting point, same formula as the official SDK); `close_escrow` returns the
//   escrow rent once both are done. The owner signs all three.
// SPL Governance / Realms (GovER5… and the other program instances the Realms registry lists):
//   TokenOwnerRecord V2 (type 17) / V1 (type 2): realm @1, governing_token_mint @33, governing_token_owner @65,
//   deposit u64 @97, unrelinquished_votes @105, outstanding_proposal_count @113. `WithdrawGoverningTokens`
//   (data 02) sends the whole deposit from the realm's holding PDA ['governance', realm, mint] to the owner.
//   It only works with no unrelinquished votes and no open proposals. Votes on proposals that are already
//   decided (VoteRecord type 12/7: proposal @1, owner @33, is_relinquished @65; Proposal state @65 ≠ 2 Voting)
//   are pruned first with `RelinquishVote` (data 0f) without the optional signer accounts. That form cannot
//   change a live vote: the program then needs the signer and fails. The record's rent stays in the program.
// Bonfida token vesting (CChTq6…): header destination token account @0, mint @32, initialized @64, then
//   schedules of 16 bytes (release_time u64, amount u64). `Unlock` (data 02 + 32-byte seeds) is
//   permissionless and pays every matured schedule into the fixed destination token account. The seeds
//   (the account is create_program_address([seeds])) and the vesting token account come from the account's
//   creation transaction.
// Meteora stake-for-fee / M3M3 (FEESng…): Unstake 304 bytes (stake_escrow @8, amount @40, release_at @56),
//   StakeEscrow (owner @8, fee vault @40), FeeVault (stake_mint @40, stake_token_vault @136). After release_at,
//   `withdraw` returns the unstaked tokens to the owner and closes the Unstake account (rent to the owner).
(() => {
  const { W, P, ID, meta, readAccounts, tokenAccounts, disc, cat, u64, pda, enc, ata, short, b58, valueInLamports } = RC;

  const le = (d, off, n) => { let v = 0n; for (let i = off + n - 1; i >= off; i--) v = (v << 8n) | BigInt(d[i]); return v; };
  const key = (d, off) => new W.PublicKey(d.slice(off, off + 32));
  const fmt = (raw, dec) => { const s = Number(raw) / 10 ** dec; return s >= 1000 ? s.toFixed(0) : s >= 1 ? s.toFixed(2) : s.toPrecision(3); };
  const U64_MAX = 0xffffffffffffffffn;
  const MEMO = P("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  const eventAuthority = prog => pda([enc("__event_authority")], prog)[0];
  const symbolOf = m => ({ So11111111111111111111111111111111111111112: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT", JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
    jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "JTO", orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: "ORCA",
    METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m: "MPLX", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
    DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7: "DRIFT", SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt: "SRM",
    SLNDpmoWTVADgEdndyvWzroNL7zSi1dF9PC3xHGtPwp: "SLND", HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: "PYTH",
    MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey: "MNDE" })[m] || short(m);

  // RC.gpa, plus a few retries when the indexer answers "overloaded, try again" (not treated as a rate limit by core).
  async function gpa(programId, filters, dataSlice) {
    for (let i = 0; ; i++) {
      try { return await RC.gpa(programId, filters, dataSlice); }
      catch (e) { if (i >= 3 || !/overloaded|try again/i.test(String(e?.message || e))) throw e; await RC.sleep(1500 * (i + 1)); }
    }
  }
  // Chain clock (slot @0, unix time @32), read once per scan.
  let clockCache = null;
  async function clock() {
    if (clockCache && Date.now() - clockCache.t < 20000) return clockCache;
    const [c] = await readAccounts([ID.CLOCK]);
    if (!c) throw new Error("could not read the clock sysvar");
    return (clockCache = { t: Date.now(), slot: le(c.data, 0, 8), ts: le(c.data, 32, 8) });
  }
  // Rent of a new token account (165 bytes; 170 for a Token-2022 ATA with ImmutableOwner).
  let rentCache = null;
  const ataRent = async tp => {
    if (!rentCache) rentCache = RC.rpc().then(c => Promise.all([165, 170].map(n => c.getMinimumBalanceForRentExemption(n))))
      .catch(e => { rentCache = null; throw e; });
    const [a, b] = await rentCache;
    return tp.equals(ID.TOKEN22) ? b : a;
  };
  // Idempotent create of the wallet's own associated token account (paid by the wallet).
  const createAta = (p, mint, tp) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(p, mint, tp), false, true), meta(p, false, false), meta(mint, false, false),
    meta(ID.SYSTEM, false, false), meta(tp, false, false)] });
  const closeTokenAccount = (p, account, tp) => new W.TransactionInstruction({ programId: tp, data: Uint8Array.of(9), keys: [
    meta(account, false, true), meta(p, false, true), meta(p, true, false)] });
  // Token program and decimals of mints; missing mints are left out.
  async function mintInfo(mints) {
    const list = [...new Set(mints.map(m => typeof m === "string" ? m : b58(m)))], out = {};
    const infos = await readAccounts(list.map(P));
    list.forEach((m, i) => { if (infos[i]) out[m] = { tp: infos[i].owner, dec: infos[i].data[44] }; });
    return out;
  }
  // Which of the wallet's token accounts exist: "ok", or "foreign" when their owner was changed away from the wallet.
  async function existing(keys, pk) {
    const uniq = [...new Map(keys.map(k => [b58(k), k])).values()], infos = await readAccounts(uniq), out = new Map();
    uniq.forEach((k, i) => { if (infos[i]) out.set(b58(k), key(infos[i].data, 32).equals(pk) ? "ok" : "foreign"); });
    return out;
  }
  // Value of a token payout into the wallet's ATA. `rent` is what creating that ATA costs the wallet (0 when it
  // exists or an earlier item of this scan already pays for it); call `take()` once the payout is actually used.
  function payout(have, rentPaid) {
    return async (pk, mint, tp, amount, dec) => {
      const dest = ata(pk, mint, tp), k = b58(dest);
      if (have.get(k) === "foreign") return { foreign: true };
      const tokens = amount > 0n ? await valueInLamports([{ mint, amount, decimals: dec }]) : 0;
      const rent = have.has(k) || rentPaid.has(k) ? 0 : await ataRent(tp);
      return { tokens, rent, take: () => rentPaid.add(k) };
    };
  }
  const unpricedNote = (list, verb) => {
    const sum = new Map();
    for (const { mint, amount, dec } of list) { const k = b58(mint); const o = sum.get(k) || { mint, dec, amount: 0n }; o.amount += amount; sum.set(k, o); }
    const parts = [...sum.values()].map(o => fmt(o.amount, o.dec) + " " + symbolOf(b58(o.mint)));
    return parts.length ? "Also " + verb + " but without a market price (not listed): " + parts.slice(0, 8).join(", ") + (parts.length > 8 ? "…" : "") + "." : "";
  };

  // ---------------------------------------------------------------- Jupiter Lock
  const LOCK = P("LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn");
  RC.registerSource({
    id: "jup-lock", title: "Jupiter Lock vesting", group: "rewards", perTx: 5, programs: [LOCK, MEMO],
    async scan(pk) {
      const found = await gpa(LOCK, [{ dataSize: 296 }, { memcmp: { offset: 8, bytes: b58(pk) } }]);
      if (!found.length) return { items: [] };
      const { ts: now } = await clock(), claimIx = await disc("claim_v2");
      const cands = [];
      let later = 0;
      for (const { pubkey, account } of found) {
        const d = account.data;
        if (le(d, 200, 8) > 0n) continue;                    // cancelled: the unlocked part was paid out on cancel
        const cliff = le(d, 144, 8), freq = le(d, 152, 8), periods = le(d, 176, 8);
        let unlocked = 0n;
        if (now >= cliff) {
          let n = freq > 0n ? (now - cliff) / freq : periods;
          if (n > periods) n = periods;
          unlocked = le(d, 160, 8) + n * le(d, 168, 8);
        }
        const claimable = unlocked - le(d, 184, 8);
        if (claimable <= 0n) { if (le(d, 160, 8) + periods * le(d, 168, 8) > le(d, 184, 8)) later++; continue; }
        const mint = key(d, 40), tp = d[139] === 1 ? ID.TOKEN22 : ID.TOKEN;
        cands.push({ pubkey, mint, tp, claimable, escrowAta: ata(pubkey, mint, tp) });
      }
      if (!cands.length) return { items: [], note: later ? later + " escrow(s) have tokens that are not unlocked yet." : "" };
      // Never promise more than the escrow's token account holds.
      const bal = await readAccounts(cands.map(c => c.escrowAta));
      cands.forEach((c, i) => { const b = bal[i] ? le(bal[i].data, 64, 8) : 0n; if (b < c.claimable) c.claimable = b; });
      const mi = await mintInfo(cands.map(c => c.mint));
      const have = await existing(cands.map(c => ata(pk, c.mint, c.tp)), pk);
      await RC.prices(cands.map(c => c.mint));
      const pay = payout(have, new Set()), items = [], unpriced = [];
      let foreign = 0;
      for (const c of cands) {
        const dec = mi[b58(c.mint)]?.dec;
        if (c.claimable <= 0n || dec === undefined) continue;
        const r = await pay(pk, c.mint, c.tp, c.claimable, dec);
        if (r.foreign) { foreign++; continue; }
        if (r.tokens <= 0) { unpriced.push({ mint: c.mint, amount: c.claimable, dec }); continue; }
        if (r.tokens - r.rent <= 0) continue;
        r.take();
        const { pubkey, mint, tp, escrowAta } = c;
        items.push({ key: pubkey, value: r.tokens - r.rent, label: "escrow " + short(pubkey) + " · " + fmt(c.claimable, dec) + " " + symbolOf(b58(mint)) + " unlocked",
          ixs: p => [createAta(p, mint, tp), new W.TransactionInstruction({ programId: LOCK,
            data: cat(claimIx, u64(U64_MAX), Uint8Array.of(1, 0, 0, 0, 0)),   // max_amount, Some(no transfer-hook slices)
            keys: [
              meta(pubkey, false, true),               // vesting escrow
              meta(mint, false, false),
              meta(escrowAta, false, true),            // escrow's token account (pays)
              meta(p, true, true),                     // recipient = this wallet
              meta(ata(p, mint, tp), false, true),     // wallet's token account
              meta(MEMO, false, false),
              meta(tp, false, false),
              meta(eventAuthority(LOCK), false, false),
              meta(LOCK, false, false)] })] });
      }
      const notes = [];
      if (unpriced.length) notes.push(unpricedNote(unpriced, "claimable"));
      if (later) notes.push(later + " escrow(s) have tokens that are not unlocked yet.");
      if (foreign) notes.push(foreign + " escrow(s) skipped: the wallet's token account for them now belongs to another owner.");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });

  // ---------------------------------------------------------------- Meteora Alpha Vault
  const ALPHA = P("vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2");
  RC.registerSource({
    id: "alpha-vault", title: "Meteora Alpha Vault deposits", group: "escrow", perTx: 3, programs: [ALPHA],
    async scan(pk) {
      const escDisc = await RC.accDisc("Escrow");
      const found = await gpa(ALPHA, [{ dataSize: 136 }, { memcmp: { offset: 40, bytes: b58(pk) } }]);
      const escrows = found.filter(e => escDisc.every((x, i) => e.account.data[i] === x));
      if (!escrows.length) return { items: [] };
      const vKeys = [...new Set(escrows.map(e => b58(key(e.account.data, 8))))];
      const vInfos = await readAccounts(vKeys.map(P)), vaults = {};
      vKeys.forEach((k, i) => { if (vInfos[i]) vaults[k] = vInfos[i].data; });
      const { slot, ts } = await clock();
      const mi = await mintInfo(Object.values(vaults).flatMap(v => [key(v, 104), key(v, 136)]));
      const [refundIx, claimIx, closeIx] = await Promise.all([disc("withdraw_remaining_quote"), disc("claim_token"), disc("close_escrow")]);
      const cands = [];
      let waiting = 0;
      for (const { pubkey, account } of escrows) {
        const e = account.data, vk = b58(key(e, 8)), v = vaults[vk];
        if (!v) continue;
        const now = v[353] === 0 ? slot : ts, start = le(v, 288, 8), end = le(v, 296, 8);
        const vDep = le(v, 240, 8), dep = le(e, 72, 8);
        if (!vDep || !dep) continue;
        if (now < start) { waiting++; continue; }            // launch not over yet (buying or lock period)
        const quote = key(v, 104), base = key(v, 136);
        const refund = e[96] === 0 ? (vDep - le(v, 256, 8)) * dep / vDep : 0n;
        const upto = now < end ? now : end;
        const dripped = end + 1n > start ? le(v, 264, 8) * (upto + 1n - start) / (end + 1n - start) : 0n;
        let claim = dripped * dep / vDep - le(e, 80, 8);
        if (claim < 0n) claim = 0n;
        cands.push({ pubkey, vault: P(vk), pool: key(v, 8), tokenVault: key(v, 40), outVault: key(v, 72), quote, base,
          refund, claim, done: now >= end, rent: account.lamports });
      }
      const dests = [];
      for (const c of cands) {
        if (c.refund > 0n && mi[b58(c.quote)]) dests.push(ata(pk, c.quote, mi[b58(c.quote)].tp));
        if (c.claim > 0n && mi[b58(c.base)]) dests.push(ata(pk, c.base, mi[b58(c.base)].tp));
      }
      const have = dests.length ? await existing(dests, pk) : new Map();
      await RC.prices(cands.flatMap(c => [c.quote, c.base]));
      const rentPaid = new Set(), pay = payout(have, rentPaid), items = [], unpriced = [];
      let foreign = 0;
      for (const c of cands) {
        const labels = [], parts = {};
        let value = 0;
        const q = mi[b58(c.quote)], b = mi[b58(c.base)];
        if (c.refund > 0n && q) {
          const r = await pay(pk, c.quote, q.tp, c.refund, q.dec);
          if (r.foreign) foreign++;
          else if (c.quote.equals(ID.WSOL)) {
            // Unused SOL deposit: a wSOL account created for it is closed again right away, so no rent is lost.
            parts.refund = { tp: q.tp, unwrap: r.rent > 0 };
            value += Number(c.refund); labels.push(fmt(c.refund, 9) + " SOL unused deposit");
          } else if (r.tokens > 0) {
            r.take(); parts.refund = { tp: q.tp }; value += r.tokens - r.rent;
            labels.push(fmt(c.refund, q.dec) + " " + symbolOf(b58(c.quote)) + " unused deposit");
          } else unpriced.push({ mint: c.quote, amount: c.refund, dec: q.dec });
        }
        if (c.claim > 0n && b) {
          const r = await pay(pk, c.base, b.tp, c.claim, b.dec);
          if (r.foreign) foreign++;
          else if (r.tokens > 0) {
            r.take(); parts.claim = { tp: b.tp }; value += r.tokens - r.rent;
            labels.push(fmt(c.claim, b.dec) + " " + symbolOf(b58(c.base)) + " bought");
          } else unpriced.push({ mint: c.base, amount: c.claim, dec: b.dec });
        }
        // The escrow can be closed once the vesting has ended and nothing is left in it (after this item's own steps).
        const close = c.done && (c.refund === 0n || parts.refund) && (c.claim === 0n || parts.claim);
        if (close) { value += c.rent; labels.push("escrow rent"); }
        if (!parts.refund && !parts.claim && !close) continue;
        if (value <= 0) continue;
        const { pubkey, vault, pool, tokenVault, outVault, quote, base } = c;
        const refund = parts.refund, claim = parts.claim;
        items.push({ key: pubkey, value, label: "vault " + short(vault) + " · " + labels.join(" + "),
          ixs: p => {
            const out = [];
            if (refund) {
              out.push(createAta(p, quote, refund.tp));
              out.push(new W.TransactionInstruction({ programId: ALPHA, data: refundIx, keys: [
                meta(vault, false, true), meta(pool, false, false), meta(pubkey, false, true),
                meta(tokenVault, false, true),                   // vault's quote reserve (pays)
                meta(ata(p, quote, refund.tp), false, true),     // wallet's quote token account
                meta(quote, false, false), meta(refund.tp, false, false),
                meta(p, true, false),                            // escrow owner
                meta(eventAuthority(ALPHA), false, false), meta(ALPHA, false, false)] }));
              if (refund.unwrap) out.push(closeTokenAccount(p, ata(p, quote, refund.tp), refund.tp));
            }
            if (claim) {
              out.push(createAta(p, base, claim.tp));
              out.push(new W.TransactionInstruction({ programId: ALPHA, data: claimIx, keys: [
                meta(vault, false, true), meta(pubkey, false, true),
                meta(outVault, false, true),                     // vault's bought-token reserve (pays)
                meta(ata(p, base, claim.tp), false, true),       // wallet's token account
                meta(base, false, false), meta(claim.tp, false, false),
                meta(p, true, false),
                meta(eventAuthority(ALPHA), false, false), meta(ALPHA, false, false)] }));
            }
            if (close) out.push(new W.TransactionInstruction({ programId: ALPHA, data: closeIx, keys: [
              meta(vault, false, true), meta(pubkey, false, true), meta(p, true, false),
              meta(p, false, true),                              // rent receiver = this wallet
              meta(eventAuthority(ALPHA), false, false), meta(ALPHA, false, false)] }));
            return out;
          } });
      }
      const notes = [];
      if (unpriced.length) notes.push(unpricedNote(unpriced, "withdrawable"));
      if (waiting) notes.push(waiting + " escrow(s) belong to launches whose vault has not started vesting yet.");
      if (foreign) notes.push(foreign + " payout(s) skipped: the wallet's token account for them now belongs to another owner.");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });

  // ---------------------------------------------------------------- SPL Governance (Realms)
  // Program instances from the Realms registry that hold priced deposits on mainnet (measured 2026-09).
  const GOV = ["GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw", "jtogvBNH3WBSWDYD5FJfQP2ZxNTuf82zL8GkEhPeaJx",
    "J9uWvULFL47gtCPvgR3oN7W357iehn5WF2Vn9MJvcSxz", "AEauWRrpn9Cs6GXujzdp1YhMmv2288kBt3SdEcPYEerr",
    "dgov7NC8iaumWw3k8TkmLDybvZBCmd1qwxgLAGAsWxf", "AVoAYTs36yB5izAaBkxRG67wL1AMwG3vo41hKtUSb8is",
    "A7kmu2kUcnQwAVn8B4znQmGJeUrsJ1WEhYVMtmiBLkEr", "pytGY6tWRgGinSCvRLnSv4fHfBTMoiDGiCsesmHWM6U",
    "GqTPL6qRf5aUuqscLh8Rg2HTxPUXfhhAXDptTLhp1t2J"].map(P);
  const VOTING = 2;
  RC.registerSource({
    id: "spl-governance", title: "Realms governance deposits", group: "escrow", perTx: 3, programs: GOV,
    async scan(pk) {
      // TokenOwnerRecords: the owner sits @65 in both versions; the account type byte tells them apart.
      // A program whose search keeps failing is reported in the note; the scan fails only if none could be read.
      let failed = 0, lastErr;
      const perProg = await Promise.all(GOV.map(prog => gpa(prog, [{ memcmp: { offset: 65, bytes: b58(pk) } }])
        .then(list => list.filter(({ account: a }) => (a.data[0] === 17 || a.data[0] === 2) && a.data.length >= 114)
          .map(x => ({ ...x, prog })))
        .catch(e => { failed++; lastErr = e; return []; })));
      if (failed === GOV.length) throw lastErr;
      const failNote = failed ? failed + " of " + GOV.length + " governance programs could not be searched right now (busy RPC) — scan again later." : "";
      const tors = perProg.flat().filter(t => le(t.account.data, 97, 8) > 0n);
      if (!tors.length) return { items: [], note: failNote };
      let proposals = 0, blocked = 0, tooMany = 0;
      const cands = [];
      for (const t of tors) {
        const d = t.account.data;
        const votes = le(d, 105, 4);                       // v3 widened it to u64; older layouts keep total_votes (u32) above it
        if (d[113] > 0) { proposals++; continue; }
        cands.push({ pubkey: t.pubkey, prog: t.prog, realm: key(d, 1), mint: key(d, 33), deposit: le(d, 97, 8), votes, relinquish: [] });
      }
      // Unrelinquished votes: prune them when every one of them is on a proposal that is no longer being voted on.
      const withVotes = cands.filter(c => c.votes > 0n);
      if (withVotes.length) {
        const progs = [...new Set(withVotes.map(c => b58(c.prog)))];
        const recs = (await Promise.all(progs.map(pg => gpa(P(pg), [{ memcmp: { offset: 33, bytes: b58(pk) } }, { memcmp: { offset: 65, bytes: "1" } }])
          .then(list => list.filter(({ account: a }) => a.data[0] === 12 || a.data[0] === 7).map(x => ({ ...x, prog: P(pg) })))))).flat();
        const propKeys = [...new Set(recs.map(r => b58(key(r.account.data, 1))))];
        const propInfos = await readAccounts(propKeys.map(P)), props = {};
        propKeys.forEach((k, i) => { if (propInfos[i]) props[k] = propInfos[i].data; });
        const govKeys = [...new Set(Object.values(props).map(pd => b58(key(pd, 1))))];
        const govInfos = await readAccounts(govKeys.map(P)), govRealm = {};
        govKeys.forEach((k, i) => { if (govInfos[i]) govRealm[k] = key(govInfos[i].data, 1); });
        for (const r of recs) {
          const proposal = key(r.account.data, 1), pd = props[b58(proposal)];
          if (!pd) continue;
          const governance = key(pd, 1), mint = key(pd, 33), realm = govRealm[b58(governance)];
          if (!realm) continue;
          const c = withVotes.find(x => x.prog.equals(r.prog) && x.realm.equals(realm) && x.mint.equals(mint));
          if (!c) continue;
          const tor = pda([enc("governance"), realm.toBytes(), mint.toBytes(), pk.toBytes()], r.prog)[0];
          const vr = pda([enc("governance"), proposal.toBytes(), tor.toBytes()], r.prog)[0];
          if (!tor.equals(c.pubkey) || !vr.equals(r.pubkey)) continue;
          c.relinquish.push({ governance, proposal, voteRecord: r.pubkey, live: pd[65] === VOTING });
        }
      }
      const ready = cands.filter(c => {
        if (c.votes === 0n) return true;
        const ok = BigInt(c.relinquish.length) === c.votes && c.relinquish.every(v => !v.live);
        if (!ok) blocked++;
        return ok;
      });
      if (!ready.length) return { items: [], note: [failNote, govNote(proposals, blocked, 0)].filter(Boolean).join(" ") };
      // Holding accounts: token program and actual balance.
      const holdings = ready.map(c => pda([enc("governance"), c.realm.toBytes(), c.mint.toBytes()], c.prog)[0]);
      const hInfos = await readAccounts(holdings);
      const mi = await mintInfo(ready.map(c => c.mint));
      ready.forEach((c, i) => { c.holding = holdings[i]; c.tp = hInfos[i]?.owner; if (hInfos[i] && le(hInfos[i].data, 64, 8) < c.deposit) c.deposit = 0n; });
      const live = ready.filter(c => c.tp && c.deposit > 0n && mi[b58(c.mint)]);
      const have = await existing(live.map(c => ata(pk, c.mint, c.tp)), pk);
      await RC.prices(live.map(c => c.mint));
      const pay = payout(have, new Set()), items = [], unpriced = [];
      let foreign = 0;
      for (const c of live) {
        const dec = mi[b58(c.mint)].dec, r = await pay(pk, c.mint, c.tp, c.deposit, dec);
        if (r.foreign) { foreign++; continue; }
        if (r.tokens <= 0) { unpriced.push({ mint: c.mint, amount: c.deposit, dec }); continue; }
        if (r.tokens - r.rent <= 0) continue;
        const { pubkey, prog, realm, mint, tp, holding } = c, votes = c.relinquish;
        const realmConfig = pda([enc("realm-config"), realm.toBytes()], prog)[0];
        const item = { key: pubkey, value: r.tokens - r.rent,
          label: "realm " + short(realm) + " · " + fmt(c.deposit, dec) + " " + symbolOf(b58(mint)) + (votes.length ? " · after closing " + votes.length + " finished vote(s)" : ""),
          ixs: p => [
            ...votes.map(v => new W.TransactionInstruction({ programId: prog, data: Uint8Array.of(15), keys: [
              meta(realm, false, false), meta(v.governance, false, false),
              meta(v.proposal, false, true),                 // decided proposal (left unchanged)
              meta(pubkey, false, true),                     // token owner record
              meta(v.voteRecord, false, true),               // marked relinquished
              meta(mint, false, false)] })),
            createAta(p, mint, tp),
            new W.TransactionInstruction({ programId: prog, data: Uint8Array.of(2), keys: [
              meta(realm, false, false),
              meta(holding, false, true),                    // realm's holding PDA (pays)
              meta(ata(p, mint, tp), false, true),           // wallet's token account
              meta(p, true, false),                          // governing token owner
              meta(pubkey, false, true),                     // token owner record
              meta(tp, false, false),
              meta(realmConfig, false, false)] })] };
        if (!fitsAlone(pk, item.ixs(pk))) { tooMany++; continue; }
        r.take();
        items.push(item);
      }
      const notes = [failNote, govNote(proposals, blocked, tooMany)];
      if (unpriced.length) notes.push(unpricedNote(unpriced, "withdrawable"));
      if (foreign) notes.push(foreign + " deposit(s) skipped: the wallet's token account for them now belongs to another owner.");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.filter(Boolean).join(" ") };
    },
  });
  function govNote(proposals, blocked, tooMany) {
    const n = [];
    if (proposals) n.push(proposals + " deposit(s) are locked by a proposal this wallet created that is still open — finish or cancel it on realms.today.");
    if (blocked) n.push(blocked + " deposit(s) have votes on proposals still being voted on (or not yet finalized); they can be withdrawn after the vote ends.");
    if (tooMany) n.push(tooMany + " deposit(s) have too many old votes to clear in one transaction — withdraw them on realms.today.");
    return n.join(" ");
  }
  function fitsAlone(pk, ixs) {
    try {
      const msg = new W.TransactionMessage({ payerKey: pk, recentBlockhash: b58(ID.SYSTEM), instructions: ixs }).compileToLegacyMessage();
      return msg.serialize().length + 1 + 64 * msg.header.numRequiredSignatures <= 1232;
    } catch { return false; }
  }

  // ---------------------------------------------------------------- Bonfida token vesting
  const VEST = P("CChTq6PthWU82YZkbveA3WDf7s97BWhBK4Vx9bmsT743");
  // The destination is a token account, not the wallet, so contracts are looked up by the wallet's token accounts
  // of the mints that still have matured, unlocked schedules worth ≥ 1 SOL in total on mainnet (measured 2026-09;
  // USDC/RAY/ATLAS/SHDW left out: under 0.1 SOL network-wide, and a search for every USDC holder is not worth it).
  const VEST_MINTS = new Set(["Fe5c469ADZyvnZrB8gdDsYt5eLKodaVYhYJCdunVr1nA", "METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m",
    "CRWNYkqdgvhGGae9CKfNka58j6QQkaD5bLhKXvUYqnc1", "2RBko3xoz56aH69isQMUpzZd9NYHahhwC23A5F3Spkin",
    "7LvJrVmmY7BYPA76EzATeRerjKbsfNUxkRzEtiJ4pump", "CgsgaAyDbbqQ34zffEwqw7HStpAStGmBzHdBBGyyLthF"]);
  // Seeds and vesting token account from the contract's creation transaction (Init = 00 ‖ seeds, Create = 01 ‖ seeds ‖ …).
  // History calls go through the search RPCs: the plain read RPC (publicnode) keeps no transaction history.
  async function vestingOrigin(vesting) {
    const sigs = await RC.search(c => c.getSignaturesForAddress(vesting, { limit: 1000 }, "confirmed"));
    for (const s of [...sigs].reverse()) {
      if (s.err) continue;
      const tx = await RC.search(c => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
      if (!tx) continue;
      const m = tx.transaction.message, keys = m.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
      let seeds = null, vtoken = null;
      for (const ix of m.compiledInstructions) {
        if (!keys.get(ix.programIdIndex).equals(VEST)) continue;
        const d = ix.data;
        if ((d[0] === 0 || d[0] === 1) && d.length >= 33) {
          const s32 = Uint8Array.from(d.slice(1, 33));
          try { if (W.PublicKey.createProgramAddressSync([s32], VEST).equals(vesting)) seeds = s32; } catch {}
        }
        if (d[0] === 1 && ix.accountKeyIndexes.length >= 3) vtoken = keys.get(ix.accountKeyIndexes[2]);
      }
      if (seeds && vtoken) return { seeds, vtoken };
    }
    return null;
  }
  RC.registerSource({
    id: "bonfida-vesting", title: "Bonfida token vesting", group: "rewards", perTx: 5, programs: [VEST],
    async scan(pk) {
      const mine = (await tokenAccounts(pk, ID.TOKEN)).filter(a => VEST_MINTS.has(a.account.data?.parsed?.info?.mint));
      if (!mine.length) return { items: [] };
      const found = (await Promise.all(mine.map(a => gpa(VEST, [{ memcmp: { offset: 0, bytes: b58(a.pubkey) } }])))).flat();
      const { ts: now } = await clock();
      const cands = [];
      let later = 0;
      for (const { pubkey, account } of found) {
        const d = account.data;
        if (d.length < 65 || (d.length - 65) % 16 || d[64] !== 1) continue;
        let due = 0n, pending = 0n;
        for (let o = 65; o + 16 <= d.length; o += 16) { const a = le(d, o + 8, 8); if (le(d, o, 8) <= now) due += a; else pending += a; }
        if (due <= 0n) { if (pending > 0n) later++; continue; }
        cands.push({ pubkey, dest: key(d, 0), mint: key(d, 32), due });
      }
      if (!cands.length) return { items: [], note: later ? later + " vesting contract(s) have schedules that are not released yet." : "" };
      const mi = await mintInfo(cands.map(c => c.mint)), items = [], unpriced = [];
      await RC.prices(cands.map(c => c.mint));
      let unknown = 0;
      for (const c of cands) {
        const dec = mi[b58(c.mint)]?.dec;
        if (dec === undefined) continue;
        const origin = await vestingOrigin(c.pubkey);
        if (!origin) { unknown++; continue; }
        const [vt] = await readAccounts([origin.vtoken]);
        const bal = vt ? le(vt.data, 64, 8) : 0n, amount = bal < c.due ? bal : c.due;
        if (amount <= 0n) continue;
        const value = await valueInLamports([{ mint: c.mint, amount, decimals: dec }]);
        if (value <= 0) { unpriced.push({ mint: c.mint, amount, dec }); continue; }
        const { pubkey, dest } = c, { seeds, vtoken } = origin;
        items.push({ key: pubkey, value, label: "vesting " + short(pubkey) + " · " + fmt(amount, dec) + " " + symbolOf(b58(c.mint)) + " released",
          ixs: () => [new W.TransactionInstruction({ programId: VEST, data: cat(Uint8Array.of(2), seeds), keys: [
            meta(ID.TOKEN, false, false),
            meta(ID.CLOCK, false, false),
            meta(pubkey, false, true),                 // vesting contract
            meta(vtoken, false, true),                 // its token account (pays)
            meta(dest, false, true)] })] });           // fixed destination = the wallet's token account
      }
      const notes = [];
      if (unpriced.length) notes.push(unpricedNote(unpriced, "releasable"));
      if (later) notes.push(later + " vesting contract(s) have schedules that are not released yet.");
      if (unknown) notes.push(unknown + " contract(s) skipped: their creation transaction could not be read from this RPC.");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });

  // ---------------------------------------------------------------- Meteora stake-for-fee (M3M3)
  const M3M3 = P("FEESngU3neckdwib9X3KWqdL7Mjmqk9XNp3uh5JbP4KP");
  RC.registerSource({
    id: "m3m3-unstake", title: "Meteora M3M3 unstaked tokens", group: "escrow", perTx: 5, programs: [M3M3],
    async scan(pk) {
      const [escDisc, unDisc, withdrawIx] = await Promise.all([RC.accDisc("StakeEscrow"), RC.accDisc("Unstake"), disc("withdraw")]);
      const isA = (d, dd) => dd.every((x, i) => d[i] === x);
      const escrows = (await gpa(M3M3, [{ memcmp: { offset: 8, bytes: b58(pk) } }])).filter(e => isA(e.account.data, escDisc));
      if (!escrows.length) return { items: [] };
      const unstakes = (await Promise.all(escrows.map(e => gpa(M3M3, [{ dataSize: 304 }, { memcmp: { offset: 8, bytes: b58(e.pubkey) } }]))))
        .flat().filter(u => isA(u.account.data, unDisc));
      if (!unstakes.length) return { items: [] };
      const vaultOf = new Map(escrows.map(e => [b58(e.pubkey), key(e.account.data, 40)]));
      const vKeys = [...new Set([...vaultOf.values()].map(b58))];
      const vInfos = await readAccounts(vKeys.map(P)), vaults = {};
      vKeys.forEach((k, i) => { if (vInfos[i]) vaults[k] = { mint: key(vInfos[i].data, 40), stv: key(vInfos[i].data, 136) }; });
      const { ts: now } = await clock();
      const mi = await mintInfo(Object.values(vaults).map(v => v.mint));
      await RC.prices(Object.values(vaults).map(v => v.mint));
      const have = await existing(Object.values(vaults).filter(v => mi[b58(v.mint)]).map(v => ata(pk, v.mint, mi[b58(v.mint)].tp)), pk);
      const pay = payout(have, new Set()), items = [], unpriced = [];
      let later = 0, foreign = 0;
      for (const { pubkey, account } of unstakes) {
        const d = account.data, se = key(d, 8), vault = vaultOf.get(b58(se)), v = vault && vaults[b58(vault)];
        if (!v || !mi[b58(v.mint)]) continue;
        const amount = le(d, 40, 8);
        if (le(d, 56, 8) > now) { later++; continue; }
        const { tp, dec } = mi[b58(v.mint)];
        const r = await pay(pk, v.mint, tp, amount, dec);
        if (r.foreign) { foreign++; continue; }
        if (r.tokens <= 0 && amount > 0n) unpriced.push({ mint: v.mint, amount, dec });
        const value = r.tokens + account.lamports - r.rent;   // the request's own rent comes back too
        if (value <= 0) continue;
        r.take();
        const mint = v.mint, stv = v.stv;
        items.push({ key: pubkey, value, label: "unstake " + short(pubkey) + " · " + fmt(amount, dec) + " " + symbolOf(b58(mint)) + " + account rent",
          ixs: p => [createAta(p, mint, tp), new W.TransactionInstruction({ programId: M3M3, data: withdrawIx, keys: [
            meta(pubkey, false, true),                 // unstake request: closed, rent to the owner
            meta(se, false, true),                     // stake escrow
            meta(stv, false, true),                    // fee vault's stake token vault (pays)
            meta(vault, false, true),                  // fee vault
            meta(ata(p, mint, tp), false, true),       // wallet's token account
            meta(p, true, true),                       // owner
            meta(tp, false, false),
            meta(eventAuthority(M3M3), false, false), meta(M3M3, false, false)] })] });
      }
      const notes = [];
      if (unpriced.length) notes.push(unpricedNote(unpriced, "returned"));
      if (later) notes.push(later + " unstake request(s) are still in their lock period.");
      if (foreign) notes.push(foreign + " request(s) skipped: the wallet's token account for them now belongs to another owner.");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });
})();
