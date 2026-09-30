// Static page for /lab. It holds no data and no secrets; every action calls
// /lab/api/* with the bearer token typed in by the user (kept in
// sessionStorage only). Written without backticks or dollar-brace so it can
// live in a template literal.
export const LAB_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pretix Test Lab</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1c2430; --muted:#5b6675; --line:#d9dee6; --accent:#2b6cb0; --danger:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14181f; --card:#1d232d; --text:#e6e9ee; --muted:#9aa5b4; --line:#2e3746; --accent:#63a4f0; --danger:#f0716a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.45 system-ui, sans-serif; }
  main { max-width:760px; margin:0 auto; padding:20px 16px 60px; }
  h1 { font-size:1.35rem; margin:0 0 4px; }
  p.sub { color:var(--muted); margin:0 0 18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:14px; }
  .card h2 { font-size:1rem; margin:0 0 4px; }
  .card p { margin:0 0 10px; color:var(--muted); font-size:.9rem; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  label { font-size:.85rem; color:var(--muted); }
  input, select { font:inherit; padding:7px 9px; border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--text); min-width:0; }
  input[type=number] { width:80px; }
  button { font:inherit; padding:8px 14px; border:0; border-radius:7px; background:var(--accent); color:#fff; cursor:pointer; }
  button.danger { background:var(--danger); }
  button:disabled { opacity:.5; cursor:wait; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px; overflow:auto; max-height:320px; font-size:.8rem; white-space:pre-wrap; word-break:break-word; }
</style>
</head>
<body>
<main>
  <h1>Pretix Test Lab</h1>
  <p class="sub">Throwaway test-data actions. Only events in test mode are ever deleted; users, teams and tokens are never touched.</p>

  <div class="card">
    <div class="row">
      <label for="token">Access token</label>
      <input id="token" type="password" placeholder="PRETIX_MCP_TOKEN" autocomplete="off" style="flex:1;min-width:200px">
      <button id="connect">Connect</button>
    </div>
  </div>

  <div class="card">
    <h2>Event</h2>
    <p>Pick the event the actions below apply to, or create a fully wired demo event.</p>
    <div class="row">
      <select id="event"></select>
      <button data-act="demo">Create demo event</button>
    </div>
  </div>

  <div class="card">
    <h2>Fill random data</h2>
    <p>Random buyers and attendees; mixed paid, pending and cancelled orders; multi-ticket orders; variations, seats and dietary / accessibility answers where the event has them.</p>
    <div class="row"><label>Orders</label><input id="seedCount" type="number" value="15" min="1" max="100"><button data-act="seed">Fill</button></div>
  </div>

  <div class="card">
    <h2>Simulate ticket transfer</h2>
    <p>Moves a ticket to a new holder. Leave the order code empty to pick a random one; the QR is reissued unless unticked.</p>
    <div class="row">
      <input id="trOrder" placeholder="Order code (optional)" style="width:170px">
      <input id="trName" placeholder="New holder (optional)">
      <input id="trEmail" placeholder="New email (optional)">
      <label><input id="trReissue" type="checkbox" checked> reissue QR</label>
      <button data-act="transfer">Transfer</button>
    </div>
  </div>

  <div class="card">
    <h2>Simulate check-ins and cancellations</h2>
    <div class="row">
      <label>Check in</label><input id="ciCount" type="number" value="5" min="1" max="100"><button data-act="checkin">Check in</button>
      <label>Cancel</label><input id="caCount" type="number" value="2" min="1" max="100"><button data-act="cancel">Cancel orders</button>
    </div>
  </div>

  <div class="card">
    <h2>Clear test data</h2>
    <p>Deletes every event in test mode together with its orders. Live and non-test events are skipped.</p>
    <div class="row"><input id="clearWord" placeholder='Type CLEAR to confirm'><button class="danger" data-act="clear">Clear test data</button></div>
  </div>

  <pre id="out">Ready.</pre>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var out = $("out");
  var tokenInput = $("token");
  try { tokenInput.value = sessionStorage.getItem("lab-token") || ""; } catch (e) {}

  function log(x) { out.textContent = typeof x === "string" ? x : JSON.stringify(x, null, 2); }

  function api(path, body) {
    return fetch("/lab/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Authorization": "Bearer " + tokenInput.value.trim(), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var data; try { data = JSON.parse(t); } catch (e) { data = t; }
        if (!r.ok) throw new Error(r.status + ": " + (data && data.error ? data.error : t));
        return data;
      });
    });
  }

  function loadEvents(selectSlug) {
    return api("events").then(function (evs) {
      var sel = $("event");
      sel.innerHTML = "";
      evs.forEach(function (e) {
        var o = document.createElement("option");
        o.value = e.slug;
        o.textContent = e.name + " (" + e.slug + ")" + (e.testmode ? "" : " [not test mode]");
        sel.appendChild(o);
      });
      if (selectSlug) sel.value = selectSlug;
      if (!evs.length) log("No events yet. Create the demo event.");
    });
  }

  function run(btn, fn) {
    btn.disabled = true;
    log("Working...");
    fn().then(log, function (e) { log("Error: " + e.message); }).then(function () { btn.disabled = false; });
  }

  $("connect").onclick = function () {
    try { sessionStorage.setItem("lab-token", tokenInput.value.trim()); } catch (e) {}
    loadEvents().then(function () { log("Connected."); }, function (e) { log("Error: " + e.message); });
  };

  var actions = {
    demo: function () { return api("demo", {}).then(function (r) { return loadEvents(r.event).then(function () { return r; }); }); },
    seed: function () { return api("seed", { event: $("event").value, count: +$("seedCount").value }); },
    transfer: function () {
      return api("transfer", {
        event: $("event").value,
        order_code: $("trOrder").value.trim() || undefined,
        name: $("trName").value.trim() || undefined,
        email: $("trEmail").value.trim() || undefined,
        reissue: $("trReissue").checked
      });
    },
    checkin: function () { return api("checkin", { event: $("event").value, count: +$("ciCount").value }); },
    cancel: function () { return api("cancel", { event: $("event").value, count: +$("caCount").value }); },
    clear: function () {
      return api("clear", { confirm: $("clearWord").value.trim() }).then(function (r) {
        $("clearWord").value = "";
        return loadEvents().then(function () { return r; });
      });
    }
  };

  Array.prototype.forEach.call(document.querySelectorAll("button[data-act]"), function (b) {
    b.onclick = function () { run(b, actions[b.getAttribute("data-act")]); };
  });

  if (tokenInput.value) $("connect").click();
})();
</script>
</body>
</html>`;
