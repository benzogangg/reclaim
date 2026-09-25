"use strict";
// Restaking withdrawal tickets and locked governance deposits whose lock has run out. Tokens are paid to the
// wallet's own token account (created idempotently by the wallet when missing; that rent is subtracted).
//
// Jito Restaking vaults (Vau1t6…, not Anchor: 8-byte header whose first byte is the account type).
//   VaultStakerWithdrawalTicket (type 7, 384 bytes): vault @8, staker @40, base @72, vrt_amount @104,
//   slot_unstaked @112. Vault (type 2, 1111 bytes): vrt_mint @40, supported_mint @72, vrt_supply @104,
//   tokens_deposited @112, delegation state @128 (staked, enqueued, cooling u64s), fee_wallet @696,
//   mint_burn_admin @728, last_full_state_update_slot @832, withdrawal_fee_bps u16 @842, program_fee_bps @848,
//   is_paused @851. Config (UwuSgA…): epoch_length @72, program_fee_wallet @96.
//   `BurnWithdrawalTicket` (data 0e) is permissionless (the staker is not a signer): once two epochs have passed
//   since slot_unstaked and the vault has been updated this epoch (Jito's keeper cranks it each epoch), it
//   burns the ticket's VRT, pays (vrt − fees)·deposited/supply of the supported token (JitoSOL, JTO…) from
//   the vault's ATA to the staker's ATA, and closes the ticket and its VRT account (rent to the staker).
//   Accounts (as in mainnet txs): config, vault, vault ATA, vrt mint, staker, staker ATA, ticket, ticket VRT ATA,
//   vault fee wallet VRT ATA, program fee wallet VRT ATA, token program, system program.
//
// Voter Stake Registry (VSR, Anchor; the instances listed by Realms: vsr2nf…, Mango 4Q6WW…, Marinade VoteMB…,
//   Xandeum HBZ5oX…, VotEn9…, 5sWzuu…; VoteWPk… is left out: its modified withdraw rejects these accounts and its
//   7 voters hold only unpriced tokens). Voter PDA [registrar, "voter", wallet] (2728 bytes):
//   voter_authority @8, registrar @40, 32 deposit entries of 80 bytes @72 (lockup start_ts i64 +0, end_ts +8,
//   kind u8 +16 (0 none, 1 daily, 2 monthly, 3 cliff, 4 constant), amount_deposited +32,
//   amount_initially_locked +40, is_used +48, voting_mint_config_idx +50). Registrar (880 bytes):
//   governance program @8, realm @40, realm governing mint @72, 4 voting mint configs of 152 bytes @168
//   (mint +0, baseline factor +64, max extra factor +72), time_offset i64 @776.
//   Unlocked = deposited − (initially_locked − vested); vested as in the program (all once the lockup ended,
//   linear per day/month, nothing for cliff before its end, never for constant).
//   `withdraw(idx u8, amount u64)`: registrar, voter, wallet (signer), token owner record
//   ['governance', realm, governing mint, wallet] of the realm's governance program, voter weight record
//   [registrar, "voter-weight-record", wallet], vault = ATA(voter, mint), destination, token program. For a
//   mint that gives vote weight the program refuses while the record has unrelinquished votes or an open
//   proposal; votes on proposals that are already decided are pruned first with spl-governance `RelinquishVote`
//   (data 0f) without the optional signer accounts (that form cannot change a live vote). When those votes do
//   not fit in one transaction with the withdraw, an opt-in "step 1" category clears them on their own first.
//   When every deposit is then empty, `close_voter` (registrar, voter, wallet signer, rent destination =
//   wallet, token program, remaining: the voter's empty vault ATAs) returns the voter's and vaults' rent.
//   Registrars are the ones that had voters on mainnet (measured 2026-09); the voter is found by its PDA.
//
// Fragmetric liquid restaking (fragnA…, Anchor, IDL on chain). A withdrawal request (fragSOL, fragJTO, fragBTC,
//   FRAG², …) sits in UserFundAccount PDA ['user_fund', receipt mint, wallet]: receipt mint @11, user @43,
//   Vec<WithdrawalRequest> @115 (u32 len, then batch_id u64, request_id u64, receipt amount u64, created_at i64,
//   Option<supported mint>, Option<supported token program>, 14 reserved; Borsh, so entries vary in length).
//   Its batch ['withdrawal_batch', receipt mint, supported mint or 32 zero bytes, batch_id u64] (Borsh: receipt
//   mint @11, the same two options @43, then batch_id, num_requests, num_claimed, receipt amount, claimed receipt,
//   asset_user_amount, claimed asset, fee, processed_at i64) is processed by the operator; after that
//   `user_withdraw_sol(batch_id, request_id)` pays receipt·asset_user/receipt_total lamports from the fund's
//   reserve, and `user_withdraw_supported_token` pays the supported token (JTO, zBTC…) to the wallet's ATA.
//   Account order as in mainnet txs; user_withdraw_sol also passes the fund's pricing sources
//   (FundAccount: count u8 @36864, pubkeys @36865) as remaining accounts.
(() => {
  const { W, P, ID, meta, gpa, readAccounts, disc, cat, u64, pda, enc, ata, short, b58, valueInLamports } = RC;

  const le = (d, off, n) => { let v = 0n; for (let i = off + n - 1; i >= off; i--) v = (v << 8n) | BigInt(d[i]); return v; };
  const i64 = (d, off) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigInt64(off, true);
  const key = (d, off) => new W.PublicKey(d.slice(off, off + 32));
  const fmt = (raw, dec) => { const s = Number(raw) / 10 ** dec; return s >= 1000 ? s.toFixed(0) : s >= 1 ? s.toFixed(2) : s.toPrecision(3); };
  const DEFAULT = b58(ID.SYSTEM);
  const symbolOf = m => ({ J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL", jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "JTO",
    BNso1VUJnh4zcfpZa6986Ea66P6TCp59hvtNJ8b1X85: "BNSOL", kyrosJC2dtm6EoLV5wffZsS4RZVm2hRafKZCLsc38JE: "KYROS",
    nSoLnkrvh2aY792pgCNT6hzx84vYtkviRzxvhf3ws8e: "nSOL", Bybit2vBJGhPF52GBdNaQfUJ6ZpThSgHBobjWZpLPb4B: "bbSOL",
    MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey: "MNDE", MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac: "MNGO",
    XANDuUoVoUqniKkpcKhrxmvYJybpJvUxJLr21Gaj3Hx: "XAND", BLZEEuZUBVqFhj8adcCFPJvPVCiCyVmh3hkJMrU8KuJA: "BLZE",
    DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK", METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m: "MPLX",
    PsyFiqqjiv41G7o5SMRzDJCu4psptThNR2GtfeGHfSq: "PSY", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS: "KMNO", DUALa4FC2yREwZ59PHeu1un4wis36vHRv5hWVBmzykCJ: "DUAL",
    FRAGSEthVFL7fdqM8hxfxkfCZzUvmg21cqPJVvC1qdbo: "fragSOL", FRAGJ157KSDfGvBJtCSrsTWUqFnZhrw4aC8N8LqHuoos: "fragJTO",
    FRAGB4KZGLMy3wH1nBajP3Q17MHnecEvTPT6wb4pX5MB: "fragBTC", FRAG2gPNXozPpYcn2a8zK7YdtfNXCLsioZNwZXwTQ3cP: "fragFRAG",
    FRAGW7L9BxkCMbivRN5HE2iXuA196v3fHA86GY16nV4L: "fragSWTCH", FRAGMEWj2z65qM62zqKhNtwNFskdfKs4ekDUDX3b4VD5: "FRAG",
    SW1TCHLmRGTfW5xZknqQdpdarB8PD95sJYWpNp9TbFx: "SWTCH", zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg: "zBTC" })[m] || short(m);

  let rentCache = null;
  const ataRent = async () => {
    if (!rentCache) rentCache = RC.rpc().then(c => c.getMinimumBalanceForRentExemption(165)).catch(e => { rentCache = null; throw e; });
    return rentCache;
  };
  const createAta = (p, mint) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(p, mint), false, true), meta(p, false, false), meta(mint, false, false),
    meta(ID.SYSTEM, false, false), meta(ID.TOKEN, false, false)] });
  const createAtaFor = (p, mint, tp) => new W.TransactionInstruction({ programId: ID.ATA, data: Uint8Array.of(1), keys: [
    meta(p, true, true), meta(ata(p, mint, tp), false, true), meta(p, false, false), meta(mint, false, false),
    meta(ID.SYSTEM, false, false), meta(tp, false, false)] });
  const eventAuthority = prog => pda([enc("__event_authority")], prog)[0];
  async function decimals(mints) {
    const list = [...new Set(mints.map(m => typeof m === "string" ? m : b58(m)))], out = {};
    const infos = await readAccounts(list.map(P));
    list.forEach((m, i) => { if (infos[i] && infos[i].owner.equals(ID.TOKEN)) out[m] = infos[i].data[44]; });
    return out;
  }
  // The wallet's classic-token ATAs: "ok" when present and still owned by the wallet, "foreign" when reassigned.
  async function existing(keys, pk) {
    const uniq = [...new Map(keys.map(k => [b58(k), k])).values()], infos = await readAccounts(uniq), out = new Map();
    uniq.forEach((k, i) => { if (infos[i]) out.set(b58(k), key(infos[i].data, 32).equals(pk) ? "ok" : "foreign"); });
    return out;
  }
  const unpricedNote = (list, verb) => {
    const sum = new Map();
    for (const { mint, amount, dec } of list) { const k = b58(mint); const o = sum.get(k) || { mint, dec, amount: 0n }; o.amount += amount; sum.set(k, o); }
    const parts = [...sum.values()].map(o => fmt(o.amount, o.dec) + " " + symbolOf(b58(o.mint)));
    return parts.length ? "Counted at 0 (no market price), still " + verb + ": " + parts.slice(0, 8).join(", ") + (parts.length > 8 ? "…" : "") + "." : "";
  };
  function fitsAlone(pk, ixs) {
    try {
      const msg = new W.TransactionMessage({ payerKey: pk, recentBlockhash: b58(ID.SYSTEM), instructions: ixs }).compileToLegacyMessage();
      return msg.serialize().length + 1 + 64 * msg.header.numRequiredSignatures <= 1232;
    } catch { return false; }
  }

  // ---------------------------------------------------------------- Jito Restaking vaults
  const VAULT = P("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");
  const VAULT_CONFIG = P("UwuSgAq4zByffCGCrWH87DsjfsewYjuqHfJEpzw1Jq3");
  RC.registerSource({
    id: "jito-restaking", title: "Jito Restaking withdrawal tickets", group: "escrow", perTx: 3, programs: [VAULT],
    async scan(pk) {
      const found = (await gpa(VAULT, [{ dataSize: 384 }, { memcmp: { offset: 40, bytes: b58(pk) } }]))
        .filter(t => t.account.data[0] === 7 && t.account.owner.equals(VAULT));
      if (!found.length) return { items: [] };
      const vaultKeys = [...new Set(found.map(t => b58(key(t.account.data, 8))))];
      const [[cfg, ...vInfos], slotNow] = await Promise.all([readAccounts([VAULT_CONFIG, ...vaultKeys.map(P)]),
        RC.rpc().then(c => c.getSlot("confirmed"))]);
      if (!cfg) throw new Error("could not read the Jito vault config");
      const epochLen = le(cfg.data, 72, 8), programFeeWallet = key(cfg.data, 96), epoch = BigInt(slotNow) / epochLen;
      const vaults = {};
      vaultKeys.forEach((k, i) => { if (vInfos[i] && vInfos[i].data[0] === 2) vaults[k] = vInfos[i].data; });
      let cooling = 0, updating = 0, blocked = 0;
      const cands = [];
      for (const { pubkey, account } of found) {
        const d = account.data, vk = b58(key(d, 8)), v = vaults[vk];
        if (!v) { blocked++; continue; }
        if (epoch <= le(d, 112, 8) / epochLen + 1n) { cooling++; continue; }
        if (b58(key(v, 728)) !== DEFAULT || v[851]) { blocked++; continue; }        // needs the vault's burn admin, or paused
        if (le(v, 832, 8) / epochLen < epoch) { updating++; continue; }                // not yet updated this epoch
        const amt = le(d, 104, 8), supply = le(v, 104, 8), deposited = le(v, 112, 8);
        const pFee = (amt * BigInt(v[848] | (v[849] << 8)) + 9999n) / 10000n;
        let vFee = (amt * BigInt(v[842] | (v[843] << 8)) + 9999n) / 10000n;
        if (pFee + vFee > amt) vFee = amt - pFee;
        const out = supply > 0n ? (amt - pFee - vFee) * deposited / supply : 0n;
        const security = le(v, 128, 8) + le(v, 136, 8) + le(v, 144, 8);
        if (out > deposited - security) { blocked++; continue; }                       // vault has not freed enough yet
        const vrtMint = key(v, 40), mint = key(v, 72), ticketVrt = ata(pubkey, vrtMint);
        cands.push({ ticket: pubkey, rent: account.lamports, vault: P(vk), vrtMint, mint, ticketVrt, out,
          fees: [key(v, 696), programFeeWallet],
          vaultAta: ata(P(vk), mint), feeAta: ata(key(v, 696), vrtMint), progFeeAta: ata(programFeeWallet, vrtMint) });
      }
      const notes = [];
      if (cooling) notes.push(cooling + " ticket(s) are still in their cooldown (about 2 epochs after unstaking).");
      if (updating) notes.push(updating + " ticket(s) wait for their vault's once-per-epoch update by Jito — try again in a few hours.");
      if (!cands.length) return { items: [], note: [...notes, blocked ? blocked + " ticket(s) cannot be claimed right now (vault paused, gated or short of free tokens)." : ""].filter(Boolean).join(" ") };
      const [ticketAtas, dec, have] = await Promise.all([readAccounts(cands.map(c => c.ticketVrt)),
        decimals(cands.map(c => c.mint)), existing(cands.map(c => ata(pk, c.mint)), pk)]);
      await RC.prices(cands.map(c => c.mint));
      const rentPaid = new Set(), items = [], unpriced = [];
      let foreign = 0;
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i], d = dec[b58(c.mint)], dest = ata(pk, c.mint), dk = b58(dest);
        if (d === undefined || !ticketAtas[i]) { blocked++; continue; }
        if (have.get(dk) === "foreign") { foreign++; continue; }
        const tokens = c.out > 0n ? await valueInLamports([{ mint: c.mint, amount: c.out, decimals: d }]) : 0;
        if (tokens <= 0 && c.out > 0n) unpriced.push({ mint: c.mint, amount: c.out, dec: d });
        const createRent = have.has(dk) || rentPaid.has(dk) ? 0 : await ataRent();
        const value = tokens + c.rent + ticketAtas[i].lamports - createRent;
        if (value <= 0) continue;
        rentPaid.add(dk);
        const { ticket, vault, vaultAta, vrtMint, ticketVrt, feeAta, progFeeAta, mint } = c;
        // The vault's and Jito's withdrawal fees are cut from the ticket's own VRT (never from the wallet) and paid
        // to their fixed fee wallets' VRT accounts.
        items.push({ key: ticket, value, feePayees: c.fees,
          label: "ticket " + short(ticket) + " · " + fmt(c.out, d) + " " + symbolOf(b58(mint)) + " + ticket rent",
          ixs: p => [createAta(p, mint), new W.TransactionInstruction({ programId: VAULT, data: Uint8Array.of(14), keys: [
            meta(VAULT_CONFIG, false, false),
            meta(vault, false, true),
            meta(vaultAta, false, true),                // vault's supported-token account (pays)
            meta(vrtMint, false, true),                 // VRT burned
            meta(p, false, true),                       // staker = this wallet (gets the ticket rent)
            meta(ata(p, mint), false, true),            // wallet's supported-token account
            meta(ticket, false, true),                  // withdrawal ticket (closed)
            meta(ticketVrt, false, true),               // ticket's VRT account (burned from, closed)
            meta(feeAta, false, true),                  // vault fee wallet's VRT account
            meta(progFeeAta, false, true),              // Jito program fee wallet's VRT account
            meta(ID.TOKEN, false, false),
            meta(ID.SYSTEM, false, false)] })] });
      }
      if (blocked) notes.push(blocked + " ticket(s) cannot be claimed right now (vault paused, gated or short of free tokens).");
      if (unpriced.length) notes.push(unpricedNote(unpriced, "paid out"));
      if (foreign) notes.push(foreign + " ticket(s) skipped: the wallet's token account for them now belongs to another owner.");
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });

  // ---------------------------------------------------------------- Voter Stake Registry
  const REGISTRARS = {
    vsr2nfGVNHmSY8uxoBGqq8AQbwz3JwaEaHqGbsTPXqQ: "BBHDDgiATiGRcSQhL1cZHudPy3Bv2SS8KHnWDJnezc5C 6m2diSkU5GVN1LHD9U2FqLeH8VYYA21krQqMkKrSc4dm F3aNkFUjL5ghi14ZPiTeModsuDACioaXjwzs35rjnWvN Az8CkSHuNshRZmgzPTQwkA5WchkHju1rzF2vXuBRqMoh 2WyVJsco2MRP4U93F3xSRXDTobjHz8fWae9GpXEoN9dc CxB8LSYkbhg5ZAKL8qtgCXP3cHggKSJePZAEGXmoTznh GtXom5cmri2zaqcEokzXosfcDNeyhY1bGMBuEwtgXkR8 GF4KfobgobrQqTShGNrbUaDQ7PJVavVgrnKgjwGSevoD 6Es2MGTv1JCHTsafGM9YBaPd7ky3DgrBBbQmeQEem55K 7eApF7pKquNx8Q1owGi2gE8MRQKp42hPcfL144VRXwfL 5k6FXYWco1wkD7QSZP366nd7HtEBmsdMsthASBACQ2aP CJ7tUeqRjHTAP7Mj1LSkwEEJNv6qr1Cqun9UQWagiCjS 3xJZ38FE31xVcsYnGpeHy36N7YwkBUsGi8Y5aPFNr4s9 6CtqjmGq5198Gay2KVQUWKzupWgj5DgBoGYcQGTJa3oQ Ho8wVPE29o5LmSAemP5VebgELKGNxJ7fmrcrqUkovoSh 46Df5cZebZufBpyPU3hXqddJJZqZVD8kJccTtQ3kortg 5vVAxag6WVUWn1Yq2hqKrWUkNtSJEefJmBLtk5syLZJ5 3eMVpr7w47t3SdZwm8pDTVJf5iG5pN1HZ1fPGX4ExjUh GDniHtZ7YRHRhb4j4jTbvNPRcCnChnBo28WShtop7eUv 72DWnWekJ9AKzTgW9muUHcYy9rVWmV2wgNTCVMxJB5dW 5ZnjJjALX8xs7zuM6t6m7XVkPV3fY3NqxwHvDLhwpShM FdodQjEwEYmU46LppkY9gGnbHwVZjnkVcmxTDajK4Gqr JDHbX7YsrMUajaP71D2cVbaYr1DSvP3Z6UKwMgZXHrtw 4zGNSwfcicUPk6nfU8KMvnzEDujMVY6weVhSpDVKsx4b 5myer6Rcx9tLqhKzbbENpreY9iawRkkkDhHeWzopx5EA 8YAQzxR7QxB369JGWusWy5yBUXexbzcSJpAaPPV8mN7z 14rUQ3Wm1N5LhdVDdykFi8krA5ZfZhwawr9Erxz5KBza EGp3oGEibXnsdQ5mQpma9NeWxgfxdVuiRGufP983167C 7KNnRoppzCvjTNpj2doHDsWyRvHHkeTsm3iVc7aAzRzH ER2RqkEfo5FwRBvH2aUKGYXiPPVGLGW8eZ6jP1yYHjp8 vm88MGkzny43N4KF1BYhTeH9HAMTNGNvaFmHSHJgrQ7 Hx1XshtFGkEwuJfRZtcbNxpmMfZGDNvJDUXMaHmGdV9V 4EtgngcjZPruW7zJNXNmXzUMs7TBScyGYEkmc4TZW6Rs 4FKZsXrw9e7u9HDN6cmpRr31sJ5DTEEVN19cMHxhsrC3 F3LYKFQ8k7f6sj3d5GHUuExkhBYrDL1XqoA51acMhvgA 148SVKRFjj8hU73LwMTH6eHqVTheF1ZC9YV9VgYYpoob 3xRTxJB6sueJUV9tHhawxqHt5TuEgDhdAsftN6duszQr 6vYaEgtTMMjsXQ1qk7xbsSvWQmyH6wr13AF8BEgmC4gn 6YGuFEQnMtHfRNn6hgmnYVdEk6yMLGGeESRgLikSdLgP AhgGH5ARtLQEDEs8jwcsKTP2KZnVtrhAUgUPMLVP8zSX 2U3hjNpRpifow1dgt9h6sMrB8UFZm3UT21JWYzmcQL18 HzW6pgpBjCVLd8Q4cnFUD6LymBGhhaUWFUifP7jBp9YJ 9doyBiJ9dmgeyGCHbow5ZnXSpLdN1TDMKvFSWFhEE112 Du7fEQExVrmNKDWjctgA4vbn2CnVSDvH2AoXsBpPcYvd FYGUd8h7mNt7QKyEZeCKA69heM85YNfuFKqFWvAtiVar A8DkydFwx22LxdURoHYxvhSUzTaFG6Mw9N66zezR9uxi Eymtkx4zExY4V7eSq8NZvkGRxc4cfp2sZ3hH9dMahHF1",
    "4Q6WW2ouZ6V3iaNm56MTd5n2tnTm4C5fiH8miFHnAFHo": "AXkpm65t2uZKrT9iz5G3jvJx4ZCXx9ZwbLMbBY1fYTjo FrzfVfxuUmmnqef7nL57pXZ1DTrzkRHDyRq7AbjuWnXD 4WQSYg21RrJNYhF4251XFpoy1uYbMHcMfZNLMXA3x5Mp HnT5SdZuYE1yr1qauB8CA9vPwTVrjm7cnNRVZ79w5Kpc 89GSX5R64drPv991xDLZfY9NJqhUEyijdffMHZcm4Ui7",
    VotEn9AWwTFtJPJSMV5F9jsMY6QwWM5qn3XP9PATGW7: "VxRuqEcwXrB5oAZcWAaGcrhqKEXJXzGmixiZTTiJ85S",
    VoteMBhDCqGLRgYpp9o7DGyq81KNmwjXQRAHStjtJsS: "5zgEgPbWKsAAnLPjSM56ZsbLPfVM6nUzh3u45tCnm97D",
    "5sWzuuYkeWLBdAv3ULrBfqA51zF7Y4rnVzereboNDCPn": "4nMDqzTTJd5QESpBnkdiG2CMqUVidkw1HojfNzqjQ3BU",
    HBZ5oXbFBFbr8Krt2oMU7ApHFeukdRS8Rye1f3T66vg5: "EoqZf99e2F6ypoyfrd7dJFkrpM3pyhQKZY6gygqqknKd",
  };
  const VSR = Object.keys(REGISTRARS).map(P);
  // Governance programs those registrars point at (only these may be called to prune finished votes).
  const GOVS = ["GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw", "GTesTBiEWE32WHXXE2S4XbZvA5CrEc4xs6ZgRe895dP",
    "GqTPL6qRf5aUuqscLh8Rg2HTxPUXfhhAXDptTLhp1t2J", "GovHgfDPyQ1GwazJTDY2avSVY8GGcpmCapmmCsymRaGe",
    "GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs", "DcG2PZTnj8s4Pnmp7xJswniCskckU5E6XsrKuyD7NYFK",
    "4ruGZqLoPVKX27Qm91Qjsqt5AzCtLrhmjKT8ubwHiVZu"].map(P);
  const DAY = 86400n, MONTH = 365n * DAY / 12n, VOTING = 2;

  // Tokens of a deposit entry that its lockup no longer holds back (mirrors DepositEntry::amount_unlocked).
  function unlocked(e, now) {
    const start = i64(e, 0), end = i64(e, 8), kind = e[16], deposited = le(e, 32, 8), initial = le(e, 40, 8);
    if (kind > 4) return 0n;
    const secsLeft = ts => { if (kind === 4) ts = start; return ts >= end ? 0n : end - ts; };
    let vested;
    if (secsLeft(now) === 0n || kind === 0) vested = initial;
    else if (kind === 3 || kind === 4) vested = 0n;
    else {
      const per = kind === 1 ? DAY : MONTH, total = secsLeft(start) / per;
      const left = now < start ? total : (secsLeft(now) + per - 1n) / per, cur = total - left;
      vested = cur <= 0n ? 0n : cur >= total ? initial : initial * cur / total;
    }
    const locked = initial - vested;
    return deposited > locked ? deposited - locked : 0n;
  }

  // One analysis per scan, shared by the withdraw source and its "clear finished votes first" step.
  let cache = null;
  function vsrState(pk) {
    if (cache && cache.pk.equals(pk) && Date.now() - cache.t < 20000) return cache.v;
    const v = analyze(pk);
    cache = { pk, t: Date.now(), v };
    v.catch(() => { if (cache && cache.v === v) cache = null; });
    return v;
  }
  const relinquishIx = (c, v) => new W.TransactionInstruction({ programId: c.gov, data: Uint8Array.of(15), keys: [
    meta(c.realm, false, false), meta(v.governance, false, false),
    meta(v.proposal, false, true),                 // decided proposal (left unchanged)
    meta(c.tor, false, true),                      // token owner record
    meta(v.voteRecord, false, true),               // marked relinquished
    meta(c.govMint, false, false)] });

  async function analyze(pk) {
    const all = [];
    for (const [prog, regs] of Object.entries(REGISTRARS))
      for (const r of regs.split(" ")) all.push({ prog: P(prog), registrar: P(r), voter: pda([P(r).toBytes(), enc("voter"), pk.toBytes()], P(prog))[0] });
    const vInfos = await readAccounts(all.map(x => x.voter));
    const mine = all.map((x, i) => ({ ...x, info: vInfos[i] }))
      .filter(x => x.info && x.info.owner.equals(x.prog) && x.info.data.length === 2728 && key(x.info.data, 8).equals(pk) && key(x.info.data, 40).equals(x.registrar));
    if (!mine.length) return { items: [], notes: [], later: [] };
    const rInfos = await readAccounts(mine.map(x => x.registrar));
    const nowTs = BigInt(Math.floor(Date.now() / 1000));
    const cands = [];
    for (let i = 0; i < mine.length; i++) {
      const x = mine[i], r = rInfos[i]?.data, d = x.info.data;
      if (!r) continue;
      const mints = [0, 1, 2, 3].map(j => ({ mint: key(r, 168 + 152 * j), weight: le(r, 168 + 152 * j + 64, 8) > 0n || le(r, 168 + 152 * j + 72, 8) > 0n }));
      const now = nowTs + i64(r, 776), entries = [];
      let remaining = 0n;
      for (let j = 0; j < 32; j++) {
        const e = d.subarray(72 + 80 * j, 152 + 80 * j), dep = le(e, 32, 8);
        if (!e[48] || dep === 0n) continue;
        const un = unlocked(e, now), m = mints[e[50]];
        if (!m || b58(m.mint) === DEFAULT) { remaining += dep; continue; }
        if (un > 0n) entries.push({ idx: j, amount: un, mint: m.mint, weight: m.weight });
        remaining += dep - un;
      }
      cands.push({ ...x, gov: key(r, 8), realm: key(r, 40), govMint: key(r, 72), mints: mints.filter(m => b58(m.mint) !== DEFAULT).map(m => m.mint),
        entries, close: remaining === 0n, locked: remaining > 0n });
    }
    const notes = [];
    let lockedOnly = 0, blocked = 0, proposals = 0, tooMany = 0, noRecord = 0, foreign = 0;
    const useful = cands.filter(c => c.entries.length || c.close);
    lockedOnly = cands.length - useful.length;
    if (!useful.length) return { items: [], notes: lockedOnly ? [lockedOnly + " DAO deposit(s) are still locked."] : [], later: [] };

    // Token owner records (needed by withdraw when the mint gives vote weight) and the vaults' balances.
    for (const c of useful) {
      c.tor = pda([enc("governance"), c.realm.toBytes(), c.govMint.toBytes(), pk.toBytes()], c.gov)[0];
      c.vwr = pda([c.registrar.toBytes(), enc("voter-weight-record"), pk.toBytes()], c.prog)[0];
      c.vaults = c.mints.map(m => ata(c.voter, m));
    }
    const [torInfos, vaultInfos] = await Promise.all([readAccounts(useful.map(c => c.tor)), readAccounts(useful.flatMap(c => c.vaults))]);
    let vi = 0;
    useful.forEach((c, i) => {
      c.torData = torInfos[i] && torInfos[i].owner.equals(c.gov) ? torInfos[i].data : null;
      c.vaultInfo = c.vaults.map(() => vaultInfos[vi++]);
    });
    // Unrelinquished votes: prune them when all are on proposals that are no longer being voted on.
    const needVotes = useful.filter(c => c.entries.some(e => e.weight) && c.torData && le(c.torData, 105, 4) > 0n);
    const govProgs = [...new Set(needVotes.map(c => b58(c.gov)))].filter(g => GOVS.some(x => b58(x) === g));
    const recs = (await Promise.all(govProgs.map(g => gpa(P(g), [{ memcmp: { offset: 33, bytes: b58(pk) } }, { memcmp: { offset: 65, bytes: "1" } }])
      .then(list => list.filter(({ account: a }) => a.data[0] === 12 || a.data[0] === 7).map(x => ({ ...x, prog: P(g) })))))).flat();
    if (recs.length) {
      const propKeys = [...new Set(recs.map(r => b58(key(r.account.data, 1))))];
      const propInfos = await readAccounts(propKeys.map(P)), props = {};
      propKeys.forEach((k, i) => { if (propInfos[i]) props[k] = propInfos[i].data; });
      for (const c of needVotes) {
        c.relinquish = [];
        for (const r of recs) {
          if (!r.prog.equals(c.gov)) continue;
          const proposal = key(r.account.data, 1), pd = props[b58(proposal)];
          if (!pd || !key(pd, 33).equals(c.govMint)) continue;
          const vr = pda([enc("governance"), proposal.toBytes(), c.tor.toBytes()], c.gov)[0];
          if (!vr.equals(r.pubkey)) continue;
          c.relinquish.push({ governance: key(pd, 1), proposal, voteRecord: r.pubkey, live: pd[65] === VOTING });
        }
      }
    }

    const allMints = [...new Set(useful.flatMap(c => c.entries.map(e => b58(e.mint))))];
    const [dec, have] = await Promise.all([decimals(allMints), existing(useful.flatMap(c => c.entries.map(e => ata(pk, e.mint))), pk)]);
    await RC.prices(allMints);
    const rentPaid = new Set(), items = [], unpriced = [], later = [];
    for (const c of useful) {
      // Which entries can go now: token-owner-record checks only apply to mints that give vote weight.
      let entries = c.entries.filter(e => dec[b58(e.mint)] !== undefined);
      let votes = [];
      if (entries.some(e => e.weight)) {
        const t = c.torData, nVotes = t ? le(t, 105, 4) : 0n;
        let ok = !!t;
        if (!t) noRecord++;
        else if (t[113] > 0) { proposals++; ok = false; }
        else if (nVotes > 0n) {
          const rel = c.relinquish || [];
          if (BigInt(rel.length) !== nVotes || rel.some(v => v.live)) { blocked++; ok = false; }
          else votes = rel;
        }
        if (!ok) entries = entries.filter(e => !e.weight);
      }
      if (entries.some(e => have.get(b58(ata(pk, e.mint))) === "foreign")) { foreign++; continue; }
      if (!entries.length && !c.entries.length && !c.close) continue;
      // Everything leaves the voter: close it and its vaults that end up empty (their rent comes back).
      const taking = new Map();
      for (const e of entries) taking.set(b58(e.mint), (taking.get(b58(e.mint)) || 0n) + e.amount);
      const close = c.close && entries.length === c.entries.length;
      const emptyVaults = close ? c.vaults.filter((v, i) => { const inf = c.vaultInfo[i];
        return inf && inf.owner.equals(ID.TOKEN) && le(inf.data, 64, 8) === (taking.get(b58(c.mints[i])) || 0n); }) : [];
      let rent = close ? c.info.lamports : 0;
      c.vaults.forEach((v, i) => { if (emptyVaults.some(x => x.equals(v))) rent += c.vaultInfo[i].lamports; });
      let tokens = 0, createRent = 0;
      const newAtas = [];
      for (const e of entries) {
        const d = dec[b58(e.mint)], val = await valueInLamports([{ mint: e.mint, amount: e.amount, decimals: d }]);
        if (val <= 0) unpriced.push({ mint: e.mint, amount: e.amount, dec: d });
        tokens += val;
        const k = b58(ata(pk, e.mint));
        if (!have.has(k) && !rentPaid.has(k) && !newAtas.includes(k)) { createRent += await ataRent(); newAtas.push(k); }
      }
      const value = tokens + rent - createRent;
      if (value <= 0 || (!entries.length && !close)) continue;
      const { prog, registrar, voter, tor, vwr, realm } = c;
      const pay = [...new Set(entries.map(e => b58(e.mint)))].map(P);
      const withdrawIx = await disc("withdraw"), closeIx = await disc("close_voter");
      const item = { key: voter, value,
        label: "DAO " + short(realm) + " · " + (entries.length ? [...taking].map(([m, a]) => fmt(a, dec[m]) + " " + symbolOf(m)).join(" + ") : "empty")
          + (close ? " + voter rent" : "") + (votes.length ? " · after closing " + votes.length + " finished vote(s)" : ""),
        ixs: p => [
          ...votes.map(v => relinquishIx(c, v)),
          ...pay.map(m => createAta(p, m)),
          ...entries.map(e => new W.TransactionInstruction({ programId: prog, data: cat(withdrawIx, Uint8Array.of(e.idx), u64(e.amount)), keys: [
            meta(registrar, false, false),
            meta(voter, false, true),
            meta(p, true, true),                           // voter authority = this wallet
            meta(tor, false, false),                       // token owner record (checked for open votes)
            meta(vwr, false, true),                        // voter weight record (updated)
            meta(ata(voter, e.mint), false, true),         // voter's vault (pays)
            meta(ata(p, e.mint), false, true),             // wallet's token account
            meta(ID.TOKEN, false, false)] })),
          ...(close ? [new W.TransactionInstruction({ programId: prog, data: closeIx, keys: [
            meta(registrar, false, false),
            meta(voter, false, true),                      // closed
            meta(p, true, false),
            meta(p, false, true),                          // rent destination = this wallet
            meta(ID.TOKEN, false, false),
            ...emptyVaults.map(v => meta(v, false, true))] })] : [])] };
      if (!fitsAlone(pk, item.ixs(pk))) {
        // Usually many old votes: they can be cleared in separate transactions first (step 1), then withdrawn.
        if (votes.length) later.push({ c, votes, what: item.label.replace(/ · after closing.*/, "") }); else tooMany++;
        continue;
      }
      for (const k of newAtas) rentPaid.add(k);
      items.push(item);
    }
    if (lockedOnly) notes.push(lockedOnly + " DAO deposit(s) are still locked.");
    if (proposals) notes.push(proposals + " deposit(s) are held by a proposal this wallet created that is still open — finish or cancel it on realms.today.");
    if (blocked) notes.push(blocked + " deposit(s) have votes on proposals still being voted on (or not yet finalized); withdraw after the vote ends.");
    if (noRecord) notes.push(noRecord + " deposit(s) have no governance record for this wallet — withdraw them on realms.today.");
    if (tooMany) notes.push(tooMany + " deposit(s) need too many steps for one transaction — withdraw them on realms.today.");
    if (later.length) notes.push(later.length + " deposit(s) first need their old votes cleared: pick \"step 1\" below, sign it, then scan again.");
    if (foreign) notes.push(foreign + " deposit(s) skipped: the wallet's token account for them now belongs to another owner.");
    if (unpriced.length) notes.push(unpricedNote(unpriced, "withdrawable"));
    return { items: items.sort((a, b) => b.value - a.value), notes, later };
  }

  RC.registerSource({
    id: "vsr", title: "Unlocked DAO deposits (VSR)", group: "escrow", perTx: 2, programs: [...VSR, ...GOVS],
    async scan(pk) {
      const { items, notes } = await vsrState(pk);
      return { items, note: notes.join(" ") };
    },
  });

  // Step 1 for deposits with more finished votes than fit next to the withdraw: clear those votes on their own.
  // Nothing is paid by this step (value 0); the deposit shows up in the category above on the next scan.
  RC.registerSource({
    id: "vsr-votes", title: "Unlocked DAO deposits (VSR) — step 1: clear finished votes", group: "escrow", perTx: 8,
    programs: GOVS, defaultOn: false, allowZero: true,
    async scan(pk) {
      const { later } = await vsrState(pk);
      const items = later.flatMap(({ c, votes, what }) => votes.map(v => ({ key: v.voteRecord, value: 0,
        label: "finished vote " + short(v.proposal) + " · frees " + what + " later",
        ixs: () => [relinquishIx(c, v)] })));
      return { items, note: later.length ? "Clearing finished votes pays nothing by itself; it only releases the deposits: "
        + later.map(l => l.what).join(", ") + ". After signing, scan again to withdraw them." : "" };
    },
  });

  // ---------------------------------------------------------------- Fragmetric withdrawal requests
  const FRAG = P("fragnAis7Bp6FTsMoa6YcH8UffhEw43Ph79qAiK3iF3");
  const FRAG_RECEIPTS = ["FRAGSEthVFL7fdqM8hxfxkfCZzUvmg21cqPJVvC1qdbo", "FRAGJ157KSDfGvBJtCSrsTWUqFnZhrw4aC8N8LqHuoos",
    "FRAGB4KZGLMy3wH1nBajP3Q17MHnecEvTPT6wb4pX5MB", "FRAG2gPNXozPpYcn2a8zK7YdtfNXCLsioZNwZXwTQ3cP",
    "FRAGW7L9BxkCMbivRN5HE2iXuA196v3fHA86GY16nV4L"].map(P);
  const fragPda = (...seeds) => pda(seeds.map(x => typeof x === "string" ? enc(x) : x.toBytes ? x.toBytes() : x), FRAG)[0];
  const optKey = (d, off) => d[off] === 1 ? [key(d, off + 1), off + 33] : [null, off + 1];
  RC.registerSource({
    id: "fragmetric", title: "Fragmetric withdrawal requests", group: "escrow", perTx: 2, programs: [FRAG],
    async scan(pk) {
      const funds = FRAG_RECEIPTS.map(m => ({ mint: m, userFund: fragPda("user_fund", m, pk) }));
      const infos = await readAccounts(funds.map(f => f.userFund));
      const reqs = [];
      funds.forEach((f, i) => {
        const d = infos[i]?.data;
        if (!d || !infos[i].owner.equals(FRAG) || d.length < 119 || !key(d, 43).equals(pk) || !key(d, 11).equals(f.mint)) return;
        let o = 119;
        for (let n = Number(le(d, 115, 4)); n > 0 && o + 48 <= d.length; n--) {
          const batchId = le(d, o, 8), requestId = le(d, o + 8, 8), amount = le(d, o + 16, 8);
          const [sm, a] = optKey(d, o + 32), [sp, b] = optKey(d, a);
          o = b + 14;
          reqs.push({ ...f, batchId, requestId, amount, sm, sp,
            batch: fragPda("withdrawal_batch", f.mint, sm ? sm.toBytes() : new Uint8Array(32), u64(batchId)) });
        }
      });
      if (!reqs.length) return { items: [] };
      const bInfos = await readAccounts(reqs.map(r => r.batch));
      let pending = 0;
      const ready = [];
      reqs.forEach((r, i) => {
        const b = bInfos[i]?.data;
        if (!b || !bInfos[i].owner.equals(FRAG)) { pending++; return; }
        const [, a] = optKey(b, 43), [, p] = optKey(b, a);
        const total = le(b, p + 24, 8), assets = le(b, p + 40, 8), claimed = le(b, p + 48, 8);
        if (i64(b, p + 64) <= 0n || total === 0n) { pending++; return; }
        let out = r.amount * assets / total;
        if (out > assets - claimed) out = assets - claimed;
        if (out > 0n) ready.push({ ...r, out });
      });
      const notes = pending ? [pending + " withdrawal request(s) are not processed by Fragmetric yet."] : [];
      if (!ready.length) return { items: [], note: notes.join(" ") };
      // Accounts the withdraw reads: the wallet's reward account must exist; its receipt-token ATA is created if missing.
      const byMint = [...new Map(ready.map(r => [b58(r.mint), r.mint])).values()];
      const rewards = byMint.map(m => fragPda("user_reward", m, pk)), receiptAtas = byMint.map(m => ata(pk, m, ID.TOKEN22));
      const payAtas = ready.filter(r => r.sm).map(r => ata(pk, r.sm, r.sp));
      const [chk, mInfos] = await Promise.all([readAccounts([...rewards, ...receiptAtas, ...payAtas]),
        readAccounts([...new Set(ready.filter(r => r.sm).map(r => b58(r.sm)))].map(P))]);
      const exists = new Set([...rewards, ...receiptAtas, ...payAtas].filter((k, i) => chk[i]).map(b58));
      const dec = {};
      [...new Set(ready.filter(r => r.sm).map(r => b58(r.sm)))].forEach((m, i) => { if (mInfos[i]) dec[m] = mInfos[i].data[44]; });
      // Pricing sources of each SOL fund (only the small slice of the large fund account is read).
      const pricing = {};
      for (const m of byMint) if (ready.some(r => r.mint.equals(m) && !r.sm)) {
        const acc = await (await RC.rpc()).getAccountInfo(fragPda("fund", m), { commitment: "confirmed", dataSlice: { offset: 36864, length: 1057 } });
        if (!acc) throw new Error("could not read the Fragmetric fund");
        const d = acc.data, n = Math.min(d[0], 33);
        pricing[b58(m)] = Array.from({ length: n }, (_, i) => key(d, 1 + 32 * i));
      }
      await RC.prices(ready.filter(r => r.sm).map(r => r.sm));
      const [solIx, tokIx] = await Promise.all([disc("user_withdraw_sol"), disc("user_withdraw_supported_token")]);
      const [t22Rent, splRent] = await Promise.all([RC.rpc().then(c => c.getMinimumBalanceForRentExemption(170)), ataRent()]);
      const paid = new Set(), items = [], unpriced = [];
      let noReward = 0;
      for (const r of ready) {
        const { mint, userFund, batch, batchId, requestId, sm, sp, out } = r;
        if (!exists.has(b58(fragPda("user_reward", mint, pk)))) { noReward++; continue; }
        const receiptAta = ata(pk, mint, ID.TOKEN22), payAta = sm ? ata(pk, sm, sp) : null;
        let rent = 0;
        if (!exists.has(b58(receiptAta)) && !paid.has(b58(receiptAta))) rent += t22Rent;
        if (payAta && !exists.has(b58(payAta)) && !paid.has(b58(payAta))) rent += sp.equals(ID.TOKEN22) ? t22Rent : splRent;
        let tokens = Number(out);
        if (sm) {
          if (dec[b58(sm)] === undefined) continue;
          tokens = await valueInLamports([{ mint: sm, amount: out, decimals: dec[b58(sm)] }]);
          if (tokens <= 0) { unpriced.push({ mint: sm, amount: out, dec: dec[b58(sm)] }); continue; }
        }
        if (tokens - rent <= 0) continue;
        paid.add(b58(receiptAta)); if (payAta) paid.add(b58(payAta));
        const common = [meta(FRAG, false, false)];
        const fund = fragPda("fund", mint), reserve = fragPda("fund_reserve", mint), treasury = fragPda("fund_treasury", mint);
        const reward = fragPda("reward", mint), userReward = fragPda("user_reward", mint, pk), evAuth = eventAuthority(FRAG);
        const args = cat(u64(batchId), u64(requestId)), sources = pricing[b58(mint)] || [];
        // When the batch's last request is claimed, the program closes the batch account into the fund's treasury
        // PDA (rent of the protocol's own account, not the wallet's money).
        items.push({ key: batch, value: tokens - rent, feePayees: [treasury],
          label: (sm ? fmt(out, dec[b58(sm)]) + " " + symbolOf(b58(sm)) : fmt(out, 9) + " SOL") + " · " + symbolOf(b58(mint)) + " request #" + requestId,
          ixs: p => [
            createAtaFor(p, mint, ID.TOKEN22),
            ...(sm ? [createAtaFor(p, sm, sp)] : []),
            sm ? new W.TransactionInstruction({ programId: FRAG, data: cat(tokIx, args), keys: [
              meta(p, true, false),                       // user
              meta(ID.SYSTEM, false, false), meta(ID.TOKEN22, false, false), meta(sp, false, false),
              meta(mint, false, false),                   // receipt token mint
              meta(receiptAta, false, false),             // wallet's receipt-token account
              meta(sm, false, false),
              meta(payAta, false, true),                  // wallet's token account (paid)
              meta(fund, false, true), meta(reserve, false, false), meta(batch, false, true),
              meta(ata(reserve, sm, sp), false, true),    // fund's reserve of the token (pays)
              meta(treasury, false, true),
              meta(userFund, false, true),                // request removed
              meta(reward, false, false), meta(userReward, false, false),
              meta(ID.INSTRUCTIONS, false, false), meta(evAuth, false, false), ...common] })
            : new W.TransactionInstruction({ programId: FRAG, data: cat(solIx, args), keys: [
              meta(p, true, true),                        // user (paid in SOL)
              meta(ID.SYSTEM, false, false), meta(ID.TOKEN22, false, false),
              meta(mint, false, false),
              meta(receiptAta, false, false),
              meta(fund, false, true),
              meta(reserve, false, true),                 // fund reserve (pays)
              meta(batch, false, true), meta(treasury, false, true),
              meta(userFund, false, true),                // request removed
              meta(reward, false, false), meta(userReward, false, false),
              meta(evAuth, false, false), ...common,
              ...sources.map(k => meta(k, false, false))] })] });   // the fund's pricing sources
      }
      if (noReward) notes.push(noReward + " request(s) need the Fragmetric app to set up the wallet's reward account first.");
      if (unpriced.length) notes.push(unpricedNote(unpriced, "claimable"));
      return { items: items.sort((a, b) => b.value - a.value), note: notes.join(" ") };
    },
  });
})();
