const API = "https://api.india.delta.exchange/v2/tickers";
const LOT = { BTC: 0.001, ETH: 0.01 };           // contract size (underlying per lot)
const FEE_RATE = 0.035, FEE_CAP = { BTC: 8, ETH: 0.3 };   // per 1 underlying, opening side only
const fee = (u, price) => Math.min(FEE_RATE * price, FEE_CAP[u]);
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const $ = (s) => document.querySelector(s);
const state = { tab: "BTC", res: { BTC: [], ETH: [] }, spot: {}, scanned: 0, updated: null, timer: null };

const fmt = (n, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d });
const money = (n) => (n < 0 ? "−$" : "$") + fmt(Math.abs(n));
const ek = (e) => +("20" + e.slice(4, 6) + e.slice(2, 4) + e.slice(0, 2));   // DDMMYY -> sortable
const fd = (e) => `${e.slice(0, 2)} ${MON[+e.slice(2, 4) - 1]} ${e.slice(4, 6)}`;

// Symbol format: C-BTC-91200-290925  (type-underlying-strike-DDMMYY)
function parse(t) {
  const p = (t.symbol || "").split("-");
  if (p.length < 4 || (p[0] !== "C" && p[0] !== "P") || !LOT[p[1]]) return null;
  const q = t.quotes || {};
  return {
    u: p[1], type: p[0], exp: p[3], strike: parseFloat(t.strike_price || p[2]),
    bid: parseFloat(q.best_bid) || 0, ask: parseFloat(q.best_ask) || 0,
    bs: parseInt(q.bid_size) || 0, as: parseInt(q.ask_size) || 0,
  };
}

// For every expiry/type, try every equal-width triple K1 < K2 < K3 (K2-K1 = K3-K2, any width).
function scan(opts) {
  const groups = {}, out = { BTC: [], ETH: [] };
  let n = 0;
  for (const o of opts) (groups[o.u + "|" + o.type + "|" + o.exp] ??= new Map()).set(o.strike, o);
  for (const [key, m] of Object.entries(groups)) {
    const [u, type, exp] = key.split("|");
    const s = [...m.keys()].sort((a, b) => a - b);
    for (let j = 1; j < s.length - 1; j++) {
      for (let i = 0; i < j; i++) {
        const k1 = s[i], k2 = s[j], k3 = 2 * k2 - k1, c = m.get(k3);
        if (!c) continue;
        const a = m.get(k1), b = m.get(k2);
        if (a.ask <= 0 || c.ask <= 0 || b.bid <= 0) continue;          // need executable quotes
        const qty = Math.min(a.as, c.as, Math.floor(b.bs / 2));        // sell 2 at the middle
        if (qty < 1) continue;
        const w = k2 - k1, cost = a.ask + c.ask - 2 * b.bid;
        const fees = fee(u, a.ask) + fee(u, c.ask) + 2 * fee(u, b.bid), net = cost + fees;
        out[u].push({ u, type, exp, k1, k2, k3, w, cost, legs: [a, b, c], fees, net, best: w - cost, worst: -cost, rr: cost <= 0 ? Infinity : (w - cost) / cost, qty });
        n++;
      }
    }
  }
  state.scanned = n;
  return out;
}

async function load() {
  clearTimeout(state.timer);
  try {
    const r = await fetch(API, { cache: "no-store" });
    const j = await r.json();
    const opts = [];
    for (const t of j.result || []) {
      if (t.symbol === "BTCUSD" || t.symbol === "ETHUSD") state.spot[t.symbol.slice(0, 3)] = parseFloat(t.mark_price);
      const o = parse(t);
      if (o) opts.push(o);
    }
    state.res = scan(opts);
    state.updated = new Date();
    setStatus("ok", "Live · " + state.updated.toLocaleTimeString());
    render();
  } catch (e) {
    setStatus("err", "Fetch failed – retrying…");
    console.error(e);
  }
  state.timer = setTimeout(load, +$("#f-int").value);
}

// Strike with "bid / ask" printed just below; the price actually used in the cost is highlighted.
const leg = (o, use, mid) => `<span class="leg${mid ? " mid" : ""}"><b>${fmt(o.strike, 0)}</b>` +
  `<small><span class="${use === "bid" ? "use" : ""}">${fmt(o.bid)}</span> / <span class="${use === "ask" ? "use" : ""}">${fmt(o.ask)}</span></small></span>`;

function setStatus(cls, txt) { $("#dot").className = "dot " + cls; $("#status").textContent = txt; }

function render() {
  const A = state.tab, all = state.res[A];
  for (const k of ["BTC", "ETH"]) {
    const n = state.res[k].filter((r) => r.cost < 0).length, b = $("#n-" + k);
    b.textContent = n + " arb"; b.classList.toggle("on", n > 0);
  }

  // expiry dropdown (rebuilt only when the list changes so an open menu isn't disturbed)
  const exps = [...new Set(all.map((r) => r.exp))].sort((a, b) => ek(a) - ek(b));
  const fe = $("#f-exp"), sig = A + exps.join();
  if (fe.dataset.sig !== sig) {
    const cur = fe.value;
    fe.innerHTML = '<option value="">All expiries</option>' + exps.map((e) => `<option value="${e}">${fd(e)}</option>`).join("");
    fe.value = exps.includes(cur) ? cur : "";
    fe.dataset.sig = sig;
  }

  const ty = $("#f-type").value, ex = fe.value, arbOnly = $("#f-arb").checked, sort = $("#f-sort").value;
  let rows = all.filter((r) => (!ty || r.type === ty) && (!ex || r.exp === ex) && (!arbOnly || r.cost < 0));
  const cmp = { cost: (a, b) => a.cost - b.cost || b.qty - a.qty, rr: (a, b) => b.rr - a.rr || a.cost - b.cost, profit: (a, b) => b.best - a.best };
  rows.sort(cmp[sort]);
  const arbs = all.filter((r) => r.cost < 0), bestArb = arbs.reduce((m, r) => Math.max(m, -r.cost), 0);
  const lot = LOT[A], real = all.filter((r) => r.net < 0).length;

  $("#stats").innerHTML = `
    <div class="stat"><span>${A} spot</span><b>${state.spot[A] ? "$" + fmt(state.spot[A]) : "—"}</b></div>
    <div class="stat"><span>Butterflies scanned</span><b>${fmt(all.length, 0)}</b></div>
    <div class="stat ${arbs.length ? "hl" : ""}"><span>Arbitrage found</span><b>${arbs.length}</b></div>
    <div class="stat ${bestArb ? "hl" : ""}"><span>Best locked profit</span><b>${bestArb ? "$" + fmt(bestArb) : "—"}</b></div>
    <div class="stat ${real ? "hl" : ""}"><span>Profitable after fees</span><b>${real}</b></div>
    <div class="stat"><span>Lowest cost</span><b>${all.length ? money(Math.min(...all.map((r) => r.cost))) : "—"}</b></div>`;

  $("#rows").innerHTML = rows.length
    ? rows.slice(0, +$("#f-rows").value).map((r, i) => {
        const arb = r.cost < 0;
        return `<tr class="${arb ? "arb" : ""}">
          <td data-l="#">${i + 1}</td>
          <td data-l="Expiry">${fd(r.exp)}</td>
          <td data-l="Type"><span class="pill ${r.type}">${r.type === "C" ? "Call" : "Put"}</span></td>
          <td data-l="Strikes" class="strikes"><div class="legs">${leg(r.legs[0], "ask")}${leg(r.legs[1], "bid", true)}${leg(r.legs[2], "ask")}</div></td>
          <td data-l="Width">${fmt(r.w, 0)}</td>
          <td data-l="Net cost" class="${arb ? "pos" : ""}"><span>${money(r.cost)}<small>${money(r.cost * lot)}/lot</small></span></td>
          <td data-l="Worst" class="${r.worst >= 0 ? "pos" : "neg"}">${money(r.worst)}</td>
          <td data-l="Best" class="pos">${money(r.best)}</td>
          <td data-l="R : R">${arb ? "∞" : fmt(r.rr, 1) + "×"}</td>
          <td data-l="Qty">${fmt(r.qty, 0)}</td>
          <td data-l="Signal">${arb ? '<span class="sig">ARB</span>' : '<span class="sig no">—</span>'}</td></tr>`;
      }).join("")
    : '<tr><td colspan="11" class="empty">No butterflies match these filters right now.</td></tr>';

  // Section 2: actual P/L after opening fees (sorted by cost + fees, lowest first)
  const f2 = all.filter((r) => (!ty || r.type === ty) && (!ex || r.exp === ex))
    .sort((a, b) => a.net - b.net || b.qty - a.qty).slice(0, +$("#f-rows").value);
  $("#rows2").innerHTML = f2.length
    ? f2.map((r, i) => {
        const worst = -r.net, best = r.w - r.net, win = worst > 0;
        return `<tr class="${win ? "arb" : ""}">
          <td data-l="#">${i + 1}</td>
          <td data-l="Expiry">${fd(r.exp)}</td>
          <td data-l="Type"><span class="pill ${r.type}">${r.type === "C" ? "Call" : "Put"}</span></td>
          <td data-l="Strikes" class="strikes"><div class="legs">${leg(r.legs[0], "ask")}${leg(r.legs[1], "bid", true)}${leg(r.legs[2], "ask")}</div></td>
          <td data-l="Net cost">${money(r.cost)}</td>
          <td data-l="Open fees" class="neg">${money(r.fees)}</td>
          <td data-l="Cost + fees" class="${win ? "pos" : ""}"><span>${money(r.net)}<small>${money(r.net * lot)}/lot</small></span></td>
          <td data-l="Worst case" class="${win ? "pos" : "neg"}">${money(worst)}</td>
          <td data-l="Best case" class="${best > 0 ? "pos" : "neg"}">${money(best)}</td>
          <td data-l="Qty">${fmt(r.qty, 0)}</td>
          <td data-l="Total @ qty" class="${win ? "pos" : "neg"}">${money(worst * lot * r.qty)}</td>
          <td data-l="Signal">${win ? '<span class="sig">PROFIT</span>' : '<span class="sig no">—</span>'}</td></tr>`;
      }).join("")
    : '<tr><td colspan="12" class="empty">No butterflies match these filters right now.</td></tr>';
}

document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    state.tab = b.dataset.tab;
    render();
  })
);
["#f-exp", "#f-type", "#f-sort", "#f-rows", "#f-arb"].forEach((s) => $(s).addEventListener("change", render));
$("#f-int").addEventListener("change", load);
load();
