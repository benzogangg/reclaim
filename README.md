# Reclaim

A static page that finds SOL and tokens a Solana wallet still owns in places people forget, and lets the
owner withdraw them with their own wallet: deactivated stake, program buffers, creator fees (Pump.fun,
Raydium, Meteora), LP fees and empty positions, farm rewards, Marinade tickets, vesting, DAO deposits,
wound-down protocols, idle protocol accounts, candy machines, wrapped SOL and token-account rent.

- **No fee, no program of our own, no server.** Everything runs in the browser; the page only calls the
  programs of the protocols themselves.
- **Checked twice.** Every item is simulated on Solana before it is shown. Before signing, `assertSafe`
  (core.js) refuses any transaction whose instructions are not byte-for-byte the ones built for items found
  in the scan, or that call a program no source declared.
- **Nothing destructive by default.** Burning NFTs or tokens, cancelling live orders, closing running
  mints and similar actions are opt-in, item by item. LP position NFTs are never offered for burning.

## Layout

- `index.html`, `style.css`, `app.js` — the page.
- `core.js` — RPC access (with throttling and fallbacks), scanning, simulation, packing into transactions,
  the safety check, token valuation via Jupiter's price API.
- `sources/*.js` — one file per protocol family; each registers categories with `RC.registerSource`.
  See `SOURCES_SPEC.md` for the contract.
- `config.js` — optional own RPC URL (a Helius key restricted to this site's domain).
- `sync_sources.py` — writes a `<script>` tag for every file in `sources/` into `index.html`.
- `test/run.cjs` — `node test/run.cjs <wallet> [sources/x.js …]` scans a wallet on mainnet, simulates
  everything and runs the safety check. Nothing is signed or sent.

Run locally: `python3 -m http.server 8790` in this folder. Not affiliated with any protocol or wallet.
