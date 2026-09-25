"use strict";
// Burning: DESTROYS the asset and gives the rent of its accounts back to the wallet. Every category is
// opt-in and every item starts unchecked; the wallet owner picks what is spam.
//  - NFTs / pNFTs (Metaplex Token Metadata): BurnV1 (data 29 00 + amount u64). Closes the token account,
//    the metadata, the master edition and, for pNFTs, the token record; their rent goes to the authority (the
//    wallet). A metadata account whose last byte is 1 still holds the uncollected Metaplex creation fee
//    (0.01 SOL): burn keeps that fee in the account and returns only its rent. The mint stays (SPL mints
//    cannot be closed). Accounts in order (checked against a mainnet BurnV1, 2026-09-24):
//    authority, collection metadata (verified collection only), metadata, edition, mint, token, master edition,
//    master edition mint, master edition token, edition marker (those 4: print editions only), token record
//    (pNFT only), System, Sysvar Instructions, SPL Token. Missing optional accounts = the program id.
//    Skipped: print editions, token accounts with a delegate (listed / staked), frozen standard NFTs,
//    pNFTs whose token record is not Unlocked or has a delegate.
//  - Token leftovers: BurnChecked (data 0f + amount u64 + decimals) for the whole balance, then CloseAccount
//    (data 09). Skipped: wrapped SOL (see tokens.js), NFTs, frozen accounts, accounts with another close
//    authority, Token-2022 accounts with withheld fees or confidential balances.
//  - Metaplex Core assets: BurnV1 (data 0c 00). The asset account shrinks to 1 byte; rent(size) - rent(1)
//    goes to the payer (the wallet), anything above rent(size) stays. The collection, when the asset has one,
//    is passed writable (its size goes down). Assets frozen by a (permanent) freeze delegate are skipped.
(() => {
  const { W, P, ID, meta, gpa, rpc, readAccounts, tokenAccounts, u64, cat, pda, enc, short, b58 } = RC;
  const MPL = P("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const CORE = P("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
  const FEE = 10000000;   // Metaplex creation fee held in a metadata account (last byte = 1)
  // Rent-exempt minimum for n bytes at the current rate (the programs pay back at today's rate).
  async function rentFn() { const r0 = await (await rpc()).getMinimumBalanceForRentExemption(0); return n => r0 + n * (r0 / 128); }
  // Well-known tokens with real value are never offered for burning.
  const KEEP = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);

  const mdPda = mint => pda([enc("metadata"), MPL.toBytes(), mint.toBytes()], MPL)[0];
  const LP_PROGRAMS = [P("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"), P("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
                       P("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG")];
  const edPda = mint => pda([enc("metadata"), MPL.toBytes(), mint.toBytes(), enc("edition")], MPL)[0];

  // Both token sources share one read per scan: the wallet's token accounts, plus the Metaplex edition of
  // every single decimals-0 token that is not both frozen and delegated (those are skipped anyway).
  const info = x => x.account.data?.parsed?.info;
  const single = x => { const t = info(x)?.tokenAmount; return t && t.decimals === 0 && t.amount === "1"; };
  let cache = null;
  function load(pk) {
    if (cache && cache.pk.equals(pk) && Date.now() - cache.t < 20000) return cache.p;
    const p = (async () => {
      const list = [];
      for (const programId of [ID.TOKEN, ID.TOKEN22])
        for (const { pubkey, account } of await tokenAccounts(pk, programId)) list.push({ pubkey, account, programId });
      // Liquidity positions of Orca, Raydium CLMM and Meteora DAMM v2 are NFTs: burning one would destroy the
      // liquidity inside. Any single token whose ["position", mint] PDA exists in one of them is never offered.
      const singles = list.filter(single);
      const posKeys = singles.flatMap(x => LP_PROGRAMS.map(g => pda([enc("position"), P(info(x).mint).toBytes()], g)[0]));
      const pos = posKeys.length ? await readAccounts(posKeys) : [];
      const lp = new Set(singles.filter((x, n) => LP_PROGRAMS.some((g, k) => pos[n * LP_PROGRAMS.length + k]?.owner.equals(g))).map(x => b58(x.pubkey)));
      for (let n = list.length - 1; n >= 0; n--) if (lp.has(b58(list[n].pubkey))) list.splice(n, 1);
      const look = list.filter(x => single(x) && !(info(x).state === "frozen" && info(x).delegate));
      const eds = await readAccounts(look.map(x => edPda(P(info(x).mint))));
      const edition = new Map(look.map((x, n) => [b58(x.pubkey), eds[n]]).filter(([, e]) => e));
      return { list, edition };
    })();
    cache = { pk, t: Date.now(), p };
    p.catch(() => { if (cache && cache.p === p) cache = null; });
    return p;
  }
  const trPda = (mint, token) => pda([enc("metadata"), MPL.toBytes(), mint.toBytes(), enc("token_record"), token.toBytes()], MPL)[0];

  // Token Metadata account (Borsh): key, update authority, mint, name, symbol, uri, fee, creators, primary sale,
  // mutable, edition nonce, token standard, collection. Old accounts may end early; missing = None.
  function parseMetadata(d) {
    if (!d || d.length < 70 || d[0] !== 4) return null;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let o = 65;
    const str = () => { const n = dv.getUint32(o, true); const s = new TextDecoder().decode(d.slice(o + 4, o + 4 + n)); o += 4 + n; return s.replace(/\0/g, "").trim(); };
    const name = str(), symbol = str(); str();
    o += 2;
    if (d[o++] === 1) o += 4 + 34 * dv.getUint32(o, true);
    o += 2;
    const opt = n => { if (o >= d.length) return null; const tag = d[o++]; if (tag !== 1) return null; const at = o; o += n; return at; };
    opt(1);
    const ts = opt(1), standard = ts === null ? null : d[ts];
    const col = opt(33), collection = col !== null && d[col] === 1 ? new W.PublicKey(d.slice(col + 1, col + 33)) : null;
    return { name, symbol, standard, collection };
  }

  // Token record: key 11, bump, state (0 unlocked, 1 locked, 2 listed), rule set revision?, delegate?.
  function recordFree(d) {
    if (!d || d[0] !== 11 || d[2] !== 0) return false;
    const o = 3 + (d[3] === 1 ? 9 : 1);
    return d[o] === 0;
  }

  // Lamports the metadata account gives back: all of them, or with an uncollected fee only its rent
  // (measured: 13 733 800 in the account, 3 733 800 returned, 10 000 000 kept). The lower of the two readings.
  const mdBack = (acc, rent) => acc.data[acc.data.length - 1] !== 1 ? acc.lamports
    : Math.max(0, Math.min(rent(acc.data.length), acc.lamports - FEE));
  const burnNft = (mint, token, md, ed, record, colMd) => p => [new W.TransactionInstruction({ programId: MPL,
    data: cat(Uint8Array.of(41, 0), u64(1)), keys: [
      meta(p, true, true),                     // authority: the owner, receives the rent
      colMd ? meta(colMd, false, true) : meta(MPL, false, false),
      meta(md, false, true),                   // metadata
      meta(ed, false, true),                   // master edition
      meta(mint, false, true),
      meta(token, false, true),                // token account
      meta(MPL, false, false), meta(MPL, false, false), meta(MPL, false, false), meta(MPL, false, false),
      record ? meta(record, false, true) : meta(MPL, false, false),
      meta(ID.SYSTEM, false, false), meta(ID.INSTRUCTIONS, false, false), meta(ID.TOKEN, false, false)] })];

  // "Likely spam": no verified collection, and the name or symbol advertises something — a link or domain, a
  // "claim / airdrop / reward" hook, a dollar amount. Those airdropped scam NFTs are pre-ticked; everything else
  // (any NFT in a verified collection, or without such signs) stays unticked for the owner to decide.
  const SPAM_URL = /https?:|www\.|t\.me\//i;                                   // a full link, name or symbol
  const SPAM_DOMAIN = /\b[a-z0-9-]{2,}\.(com|io|xyz|net|org|app|fun|site|live|pro|gg|click|online|top|vip|cc|link|info|biz|claims?)\b/i;  // name only
  const SPAM_WORDS = /\b(claim|claimable|airdrop|rewards?|voucher|visit|redeem|eligible|giveaway|mint now)\b|\$\s?\d|\d[\d,.]*\s?(usdc|usdt|sol|jup)\b|✅|🎁/i;
  const likelySpam = m => !m.collection
    && (SPAM_URL.test(m.name + " " + m.symbol) || SPAM_DOMAIN.test(m.name) || SPAM_WORDS.test(m.name));

  // Thumbnails so the owner can see what they are about to destroy (only when our Helius RPC is configured).
  async function withPictures(items) {
    try { const pics = await RC.thumbnails(items.map(i => i.key)); for (const i of items) i.image = pics.get(b58(i.key)); }
    catch (e) { console.warn("thumbnails", e?.message || e); }
  }

  RC.registerSource({
    id: "burn-nft", title: "Burn NFTs (destroys them)", group: "burn", perTx: 5, programs: [MPL], defaultOn: false,
    async scan(pk) {
      const { list, edition } = await load(pk);
      const cands = [];
      let skipped = 0;
      for (const x of list) {
        const i = info(x);
        if (!single(x) || !x.programId.equals(ID.TOKEN)) continue;
        if (i.delegate) { skipped++; continue; }                     // listed / staked
        const e = edition.get(b58(x.pubkey));
        if (!e) continue;                                            // no edition: not an NFT, see the token category
        if (!(e.data[0] === 6 || e.data[0] === 2)) { skipped++; continue; }   // print edition
        cands.push({ token: x.pubkey, tokenLamports: x.account.lamports, frozen: i.state === "frozen", mint: P(i.mint), edLamports: e.lamports });
      }
      const [mds, rent] = await Promise.all([readAccounts(cands.map(c => mdPda(c.mint))), rentFn()]);
      const ok = [];
      cands.forEach((c, n) => {
        const m = mds[n] && parseMetadata(mds[n].data), pnft = m?.standard === 4;
        if (!m || m.standard === 3 || m.standard === 5 || (c.frozen && !pnft)) { skipped++; return; }
        ok.push({ ...c, m, pnft, mdLamports: mdBack(mds[n], rent) });
      });
      const pn = ok.filter(c => c.pnft);
      const recs = await readAccounts(pn.map(c => trPda(c.mint, c.token)));
      pn.forEach((c, n) => { c.recLamports = recs[n] && recordFree(recs[n].data) ? recs[n].lamports : -1; });
      const items = [];
      for (const c of ok) {
        if (c.recLamports === -1) { skipped++; continue; }
        const md = mdPda(c.mint), ed = edPda(c.mint), rec = c.pnft ? trPda(c.mint, c.token) : null;
        const colMd = c.m.collection ? mdPda(c.m.collection) : null;
        const spam = likelySpam(c.m);
        items.push({ key: c.mint, value: c.tokenLamports + c.mdLamports + c.edLamports + (c.recLamports || 0), suggested: spam,
          label: (spam ? "LIKELY SPAM · " : "") + "DESTROY " + (c.pnft ? "pNFT " : "NFT ") + JSON.stringify((c.m.name || "?").slice(0, 32)) + " · mint " + short(c.mint)
            + (c.m.collection ? " · verified collection " + short(c.m.collection) : ""),
          ixs: burnNft(c.mint, c.token, md, ed, rec, colMd) });
      }
      await withPictures(items);
      return { items: items.sort((a, b) => (b.suggested - a.suggested) || (b.value - a.value)),
        note: "Burning permanently destroys the NFT. Only tick the ones you know are spam or worthless — this list "
          + "does not judge value, it is sorted by the rent you get back."
          + (skipped ? " " + skipped + " NFT(s) not offered: listed, staked, delegated, locked or print editions." : "") };
    },
  });

  const fmt = (amount, decimals) => {
    const s = amount.padStart(decimals + 1, "0"), int = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + frac.slice(0, 6) : "");
  };

  RC.registerSource({
    id: "burn-tokens", title: "Burn leftover tokens (destroys them)", group: "burn", perTx: 8, defaultOn: false,
    async scan(pk) {
      const { list, edition } = await load(pk);
      let skipped = 0;
      const items = [];
      for (const { pubkey, account, programId } of list) {
        const i = account.data?.parsed?.info, t = i?.tokenAmount;
        if (!i || i.isNative || !t || t.amount === "0" || KEEP.has(i.mint)) continue;
        if (edition.has(b58(pubkey))) continue;                      // NFTs: the category above
        if (single({ account }) && i.state === "frozen" && i.delegate) continue;   // staked NFT, counted above
        const ext = i.extensions || [];
        if (i.state !== "initialized" || (i.closeAuthority && i.closeAuthority !== b58(pk))
          || ext.some(e => e.extension === "confidentialTransferAccount"
            || (e.extension === "transferFeeAmount" && Number(e.state?.withheldAmount) > 0))) { skipped++; continue; }
        const mint = P(i.mint), amount = BigInt(t.amount), decimals = t.decimals;
        items.push({ key: pubkey, value: account.lamports, mint: i.mint, amount, decimals,
          label: "DESTROY " + fmt(t.amount, decimals) + " of " + (programId.equals(ID.TOKEN22) ? "Token-2022 " : "") + "mint " + short(mint)
            + " · closes account",
          ixs: p => [
            new W.TransactionInstruction({ programId, data: cat(Uint8Array.of(15), u64(amount), Uint8Array.of(decimals)), keys: [
              meta(pubkey, false, true),      // token account
              meta(mint, false, true),        // mint: supply goes down
              meta(p, true, false)] }),       // owner
            new W.TransactionInstruction({ programId, data: Uint8Array.of(9), keys: [
              meta(pubkey, false, true),      // token account: closed
              meta(p, false, true),           // destination: this wallet
              meta(p, true, false)] })] });   // owner
      }
      // Never offer to burn a balance that is worth more than the rent it gives back (Jupiter price, liquid tokens only).
      let valuable = 0;
      const worth = await Promise.all(items.map(it => RC.valueInLamports([{ mint: it.mint, amount: it.amount, decimals: it.decimals }])));
      const cheap = items.filter((it, k) => { if (worth[k] > it.value) { valuable++; return false; } return true; });
      return { items: cheap.sort((a, b) => b.value - a.value),
        note: "Burning permanently destroys these tokens (the whole balance) and returns the account rent. If a token "
          + "has value, swap or send it instead of burning. USDC and USDT are never listed."
          + (valuable ? " " + valuable + " token balance(s) worth more than their rent are not offered." : "")
          + (skipped ? " " + skipped + " account(s) not offered: frozen, another close authority, or Token-2022 fees/confidential balance." : "") };
    },
  });

  // Core asset plugins: after name, uri and seq comes a plugin header (key 3, registry offset u64); the registry
  // (key 4) lists records {type u8, authority (tag, +32 for Address), offset u64}. FreezeDelegate (1) and
  // PermanentFreezeDelegate (5) store {frozen: bool} right after their plugin tag.
  function coreFrozen(d) {
    try {
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      let o = 33 + (d[33] === 0 ? 1 : 33);
      for (let s = 0; s < 2; s++) o += 4 + dv.getUint32(o, true);
      o += d[o] === 1 ? 9 : 1;
      if (o >= d.length || d[o] !== 3) return false;
      let r = Number(dv.getBigUint64(o + 1, true));
      if (d[r] !== 4) return false;
      const count = dv.getUint32(r + 1, true);
      r += 5;
      for (let k = 0; k < count; k++) {
        const type = d[r], auth = d[r + 1];
        r += 2 + (auth === 3 ? 32 : 0);
        const at = Number(dv.getBigUint64(r, true));
        r += 8;
        if ((type === 1 || type === 5) && d[at + 1] === 1) return true;
      }
    } catch { /* unreadable plugin data: leave it to the simulation */ }
    return false;
  }

  RC.registerSource({
    id: "burn-core", title: "Burn Metaplex Core NFTs (destroys them)", group: "burn", perTx: 8, programs: [CORE], defaultOn: false,
    async scan(pk) {
      // AssetV1: key 1 @0, owner @1, update authority tag @33 (2 = collection) + address @34.
      const [found, rent] = await Promise.all([
        gpa(CORE, [{ memcmp: { offset: 0, bytes: "2" } }, { memcmp: { offset: 1, bytes: b58(pk) } }]), rentFn()]);
      const free = found.filter(({ account: a }) => !coreFrozen(a.data)), frozen = found.length - free.length;
      const items = free.map(({ pubkey, account: a }) => {
        const d = a.data, col = d[33] === 2 ? new W.PublicKey(d.slice(34, 66)) : null;
        const o = 33 + (d[33] === 0 ? 1 : 33), n = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
        const name = new TextDecoder().decode(d.slice(o + 4, o + 4 + Math.min(n, 64))).replace(/\0/g, "").trim();
        return { key: pubkey, value: Math.min(a.lamports, rent(d.length)) - rent(1),
          label: "DESTROY Core NFT " + JSON.stringify(name.slice(0, 32) || "?") + " · " + short(pubkey) + (col ? " · collection " + short(col) : ""),
          ixs: p => [new W.TransactionInstruction({ programId: CORE, data: Uint8Array.of(12, 0), keys: [
            meta(pubkey, false, true),                            // asset: shrunk to 1 byte
            col ? meta(col, false, true) : meta(CORE, false, false),
            meta(p, true, true),                                  // payer: receives the rent
            meta(CORE, false, false),                             // authority: none = payer
            meta(ID.SYSTEM, false, false),
            meta(CORE, false, false)] })] };                      // log wrapper: none
      });
      await withPictures(items);
      return { items: items.sort((a, b) => b.value - a.value),
        note: "Burning permanently destroys the asset; the account keeps 1 byte of rent, the rest comes back."
          + (frozen ? " " + frozen + " frozen (staked) asset(s) not offered." : "") };
    },
  });
})();
