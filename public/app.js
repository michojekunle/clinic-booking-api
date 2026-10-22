"use strict";
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable; key just won't persist */ } },
};

let apiKey = store.get("apiKey") || "";
let selected = null;
let attemptKey = null; // reused across retries of the same submission so a double-click can't double-book
let booking = null;

$("apiKey").value = apiKey;
if (apiKey) $("keyBox").classList.add("hidden");

async function api(method, path, body, extra = {}) {
  const res = await fetch(path, {
    method,
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function show(el, text, kind) {
  el.replaceChildren();
  if (!text) return;
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.textContent = text;
  el.appendChild(div);
}

const fmt = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

async function loadSlots() {
  const p = $("provider").value;
  const { res, data } = await api("GET", `/slots${p ? `?provider=${encodeURIComponent(p)}` : ""}`);
  const list = $("slots");
  list.replaceChildren();
  if (res.status === 401) { $("keyBox").classList.remove("hidden"); list.textContent = "Enter a valid API key to see slots."; return; }
  if (!res.ok) { list.textContent = "Could not load slots."; return; }

  if (!p) {
    const names = [...new Set(data.slots.map((s) => s.provider))];
    const sel = $("provider");
    if (sel.options.length === 1) names.forEach((n) => sel.add(new Option(n, n)));
  }
  if (!data.slots.length) { list.textContent = "No slots available."; return; }
  const now = Date.now();
  for (const s of data.slots) {
    const past = new Date(s.start).getTime() <= now;
    const li = document.createElement("li");
    li.className = "slot";
    const info = document.createElement("div");
    info.textContent = s.provider;
    const small = document.createElement("small");
    small.textContent = `${fmt(s.start)} – ${new Date(s.end).toLocaleTimeString([], { timeStyle: "short" })}`;
    info.appendChild(small);
    li.appendChild(info);
    if (s.available && !past) {
      const b = document.createElement("button");
      b.textContent = "Book";
      b.addEventListener("click", () => choose(s));
      li.appendChild(b);
    } else {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = past ? "Past" : "Booked";
      li.appendChild(t);
    }
    list.appendChild(li);
  }
}

function choose(slot) {
  selected = slot;
  attemptKey = crypto.randomUUID();
  $("chosen").textContent = `${slot.provider} · ${fmt(slot.start)}`;
  show($("formMsg"));
  $("formBox").classList.remove("hidden");
  $("name").focus();
}

$("saveKey").addEventListener("click", () => {
  apiKey = $("apiKey").value.trim();
  store.set("apiKey", apiKey);
  if (apiKey) $("keyBox").classList.add("hidden");
  loadSlots();
});
$("refresh").addEventListener("click", loadSlots);
$("provider").addEventListener("change", loadSlots);
$("cancelForm").addEventListener("click", () => { $("formBox").classList.add("hidden"); selected = null; });

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selected) return;
  const btn = $("submit");
  btn.disabled = true;
  show($("formMsg"));
  try {
    const payload = { slot_id: selected.id, name: $("name").value, email: $("email").value };
    const { res, data } = await api("POST", "/bookings", payload, { "Idempotency-Key": attemptKey });
    if (res.status === 201) {
      booking = data;
      $("formBox").classList.add("hidden");
      const dl = $("confirm");
      dl.replaceChildren();
      for (const [k, v] of [["Reference", data.id], ["Provider", selected.provider], ["When", fmt(selected.start)], ["Name", data.name], ["Email", data.email], ["Status", data.status]]) {
        const dt = document.createElement("dt"); dt.textContent = k;
        const dd = document.createElement("dd"); dd.textContent = v;
        dl.append(dt, dd);
      }
      show($("confirmMsg"));
      $("cancelBooking").disabled = false;
      $("confirmBox").classList.remove("hidden");
      $("confirmBox").scrollIntoView({ behavior: "smooth" });
      selected = null;
      loadSlots();
    } else if (res.status === 409) {
      show($("formMsg"), "Sorry, that slot was just taken. Please pick another.", "err");
      loadSlots();
    } else if (res.status === 429) {
      show($("formMsg"), `Too many attempts. Try again in ${res.headers.get("Retry-After") || "a minute"}s.`, "err");
    } else {
      show($("formMsg"), data.error || "Something went wrong.", "err");
    }
  } catch {
    show($("formMsg"), "Network error. Please try again.", "err");
  } finally {
    btn.disabled = false;
  }
});

$("cancelBooking").addEventListener("click", async () => {
  if (!booking) return;
  const { res, data } = await api("DELETE", `/bookings/${encodeURIComponent(booking.id)}`);
  if (res.ok) {
    show($("confirmMsg"), "Booking cancelled.", "ok");
    $("cancelBooking").disabled = true;
    loadSlots();
  } else {
    show($("confirmMsg"), data.error || "Could not cancel.", "err");
  }
});

loadSlots();
