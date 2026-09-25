"use strict";
// Page logic. The scan, simulation, packing and safety check live in core.js; the categories in sources/*.js.

const { W, b58 } = RC;
const $ = id => document.getElementById(id);
const sol = l => (l / 1e9).toLocaleString("en-US", { maximumFractionDigits: 6 }) + " SOL";

const GROUPS = [
  ["escrow", "Idle deposits"],
  ["stake", "Stake"],
  ["rewards", "Unclaimed rewards & fees"],
  ["rent", "Account rent"],
  ["burn", "Burn to reclaim rent — opt-in"],
];

let provider, owner = null, scanned = null, cats = [];

// Status text is always set as plain text; links are built only from signatures we got back.
function log(text, cls, links) {
  const el = $("log");
  el.textContent = "";
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  el.appendChild(span);
  for (const l of links || []) {
    const a = document.createElement("a");
    a.href = l.href; a.textContent = l.text; a.target = "_blank"; a.rel = "noopener noreferrer";
    el.append(document.createTextNode("\n"), a);
  }
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

async function scan(pk) {
  $("results").hidden = false;
  $("wallet").textContent = b58(pk) + (owner && owner.equals(pk) ? "" : "  (read-only)");
  $("total").textContent = "…";
  $("cats").replaceChildren();
  $("claim").disabled = true;
  scanned = null;
  log("Checking " + RC.sources.length + " places where SOL can get stuck…");
  cats = await RC.scanAll(pk, m => log(m));
  scanned = pk;
  render();
  const any = cats.some(c => c.items.length);
  if (any && RC.noFunds) log("This wallet has 0 SOL, so it cannot pay the network fee (about 0.000005 SOL per transaction). "
    + "Send it a little SOL (0.001 is plenty), then check again to withdraw.", "bad");
  else if (!any) log("Nothing to withdraw for this wallet right now.");
  else if (!owner || !owner.equals(pk)) log("Only this wallet's owner can withdraw. Connect it to continue.");
  else log("Pick what to withdraw and press the button. Your wallet will preview every transaction.");
}

function catBox(c) {
  const box = el("div", "cat" + (c.items.length ? "" : " empty") + (c.optIn ? " optin" : ""));
  const head = el("label", "cat-head");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = c.selected && c.items.some(i => i.on); cb.disabled = !c.items.length;
  const t = el("div", "cat-title");
  t.append(el("b", null, c.title), el("span", null, c.error ? "could not check" : c.items.length ? c.items.length + " found" : "none found"));
  const amt = el("div", "cat-amt");
  head.append(cb, t, amt);
  box.append(head);

  const itemBoxes = [];
  const refresh = () => {
    const sel = c.items.filter(i => i.on);
    amt.textContent = c.items.length ? (c.optIn ? sol(sel.reduce((s, i) => s + i.value, 0)) + " of " + sol(c.items.reduce((s, i) => s + i.value, 0)) : sol(sel.reduce((s, i) => s + i.value, 0))) : "—";
    cb.checked = sel.length > 0; cb.indeterminate = sel.length > 0 && sel.length < c.items.length;
    c.selected = sel.length > 0;
    updateTotal();
  };
  cb.onchange = () => { for (const i of c.items) i.on = cb.checked; itemBoxes.forEach(x => { x.checked = cb.checked; }); refresh(); };

  if (c.items.length) {
    const list = el("div", "items");
    for (const i of c.items.slice(0, 300)) {
      const row = el("label", "item");
      const icb = el("input"); icb.type = "checkbox"; icb.checked = !!i.on;
      icb.onchange = () => { i.on = icb.checked; refresh(); };
      itemBoxes.push(icb);
      row.append(icb);
      row.append(a, el("span", "v", sol(i.value)));
      list.append(row);
    }
    if (c.items.length > 300) list.append(el("div", "item", "…and " + (c.items.length - 300) + " more (selected together with the category)"));
    box.append(list);
  }
  if (c.error) box.append(el("div", "note bad", c.error));
  if (c.note) box.append(el("div", "note", c.note));
  refresh();
  return box;
}

function render() {
  const out = [];
  for (const [g, title] of GROUPS) {
    const list = cats.filter(c => c.group === g);
    if (!list.length) continue;
    const found = list.filter(c => c.items.length || c.error), empty = list.filter(c => !c.items.length && !c.error);
    const sec = el("div", "group");
    sec.append(el("h3", "group-title", title));
    found.forEach(c => sec.append(catBox(c)));
    if (empty.length) sec.append(el("div", "checked", "Checked, nothing found: " + empty.map(c => c.title).join(" · ")));
    out.push(sec);
  }
  $("cats").replaceChildren(...out);
  updateTotal();
}

function updateTotal() {
  const total = RC.chosen(cats, scanned).reduce((s, x) => s + x.items.reduce((t, i) => t + i.value, 0), 0);
  $("total").textContent = sol(total);
  $("claim").disabled = !(owner && scanned && owner.equals(scanned) && total > 0 && !RC.noFunds);
}

// "What you sign": every program any source can call, straight from the registry.
function renderPrograms() {
  const ul = $("programs");
  for (const s of RC.sources) {
    const li = el("li");
    li.append(el("b", null, s.title + ": "), el("span", "mono", (s.programs || []).map(p => typeof p === "string" ? p : b58(p)).join(", ") || "SPL Token / Token-2022"));
    ul.append(li);
  }
}

function pickProvider() {
  return window.phantom?.solana || window.solflare || window.backpack || window.solana || null;
}

$("connect").onclick = async () => {
  try {
    provider = pickProvider();
    if (!provider) { $("results").hidden = false; log("No wallet found. Open this page in a browser with Phantom, Solflare or Backpack, or in your wallet app's browser.", "bad"); return; }
    const r = await provider.connect();
    owner = new W.PublicKey((r && r.publicKey) || provider.publicKey);
    $("addr").value = b58(owner);
    await scan(owner);
  } catch (e) { $("results").hidden = false; log("Error: " + (e.message || e), "bad"); }
};

$("scanBtn").onclick = async () => {
  let pk;
  try { pk = new W.PublicKey($("addr").value.trim()); }
  catch { $("results").hidden = false; log("That is not a valid Solana address.", "bad"); return; }
  try { await scan(pk); } catch (e) { log("Error: " + (e.message || e), "bad"); }
};
$("addr").onkeydown = e => { if (e.key === "Enter") $("scanBtn").click(); };

$("claim").onclick = async () => {
  $("claim").disabled = true;
  try {
    const c = await RC.rpc();
    if (cats.some(x => x.optIn && x.items.some(i => i.on))) {
      log("Checking the items you picked…");
      const dropped = await RC.checkOptIn(owner, cats);
      if (dropped) { render(); throw new Error(dropped + " picked item(s) would fail and were unticked. Check the list and press the button again."); }
    }
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
    const built = RC.buildTxs(owner, cats, blockhash, lastValidBlockHeight);
    const bal = await c.getBalance(owner);
    if (bal < 5000 * built.length + 10000) throw new Error("not enough SOL for network fees (need about " + sol(5000 * built.length + 10000) + ")");
    const total = $("total").textContent;
    const txs = built.map(b => b.tx);
    log("Approve " + (txs.length > 1 ? "the " + txs.length + " transactions" : "the transaction") + " in your wallet…");
    const sigs = [];
    if (txs.length > 1 && provider.signAllTransactions) {
      for (const t of await provider.signAllTransactions(txs)) sigs.push(await c.sendRawTransaction(t.serialize()));
    } else {
      for (const tx of txs) {
        if (provider.signAndSendTransaction) { const r = await provider.signAndSendTransaction(tx); sigs.push(r.signature || r); }
        else sigs.push(await c.sendRawTransaction((await provider.signTransaction(tx)).serialize()));
      }
    }
    log("Sent, waiting for confirmation…");
    let failed = 0;
    for (const sig of sigs) {
      const res = await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) failed++;
    }
    const links = sigs.map((g, i) => ({ href: "https://solscan.io/tx/" + encodeURIComponent(g), text: "View on Solscan" + (sigs.length > 1 ? " (" + (i + 1) + ")" : "") }));
    await scan(owner);
    if (failed) log(failed + " of " + sigs.length + " transactions failed; the rest went through.", "bad", links);
    else log("Done ✓ " + total + " is back in your wallet.", "ok", links);
  } catch (e) {
    log("Error: " + (e.message || e), "bad");
    updateTotal();
  }
};

renderPrograms();
