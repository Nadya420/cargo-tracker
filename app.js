const $ = (id) => document.getElementById(id);
let cargoItems = [];

async function api(url, options = {}) {
  const response = await fetch(url, {headers: {"Content-Type":"application/json"}, ...options});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}
function setLoggedIn(value) {
  $("loginPanel").classList.toggle("hidden", value);
  $("dashboard").classList.toggle("hidden", !value);
  $("logoutBtn").classList.toggle("hidden", !value);
}
async function loadCargo() {
  cargoItems = await api("/api/cargo");
  render();
}
function render() {
  $("totalCount").textContent = cargoItems.length;
  $("movingCount").textContent = cargoItems.filter(x => x.status === "В пути").length;
  $("doneCount").textContent = cargoItems.filter(x => x.status === "Доставлен").length;
  const q = $("searchInput").value.toLowerCase();
  const filtered = cargoItems.filter(x => [x.id,x.name,x.origin,x.destination].join(" ").toLowerCase().includes(q));
  $("cargoRows").innerHTML = filtered.map(x => {
    const cls = x.status === "Доставлен" ? "done" : x.status === "На таможне" ? "customs" : "";
    return `<tr><td><strong>${escapeHtml(x.id)}</strong><small>${escapeHtml(x.name)}</small></td><td>${escapeHtml(x.origin)} → ${escapeHtml(x.destination)}</td><td><span class="pill ${cls}">${escapeHtml(x.status)}</span></td><td>${escapeHtml(x.updated || "—")}</td><td><button class="ghost" onclick="changeStatus('${encodeURIComponent(x.id)}')">Изменить статус</button></td></tr>`;
  }).join("");
  $("emptyState").classList.toggle("hidden", filtered.length > 0);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
window.changeStatus = async (encodedId) => {
  const id = decodeURIComponent(encodedId);
  const item = cargoItems.find(x => x.id === id);
  const statuses = ["Зарегистрирован","В пути","На таможне","Доставлен"];
  const next = statuses[(statuses.indexOf(item.status)+1)%statuses.length];
  try { await api(`/api/cargo/${encodeURIComponent(id)}`, {method:"PATCH", body:JSON.stringify({status:next,updated:new Date().toISOString().slice(0,10)})}); await loadCargo(); }
  catch(e) { alert(e.message); }
};
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("loginError").textContent = "";
  const form = new FormData(e.target);
  try { await api("/api/login", {method:"POST",body:JSON.stringify({username:form.get("username"),password:form.get("password")})}); setLoggedIn(true); await loadCargo(); }
  catch(err) { $("loginError").textContent = err.message; }
});
$("logoutBtn").addEventListener("click", async () => { await api("/api/logout",{method:"POST"}); setLoggedIn(false); });
$("showAdd").addEventListener("click", () => $("addPanel").classList.remove("hidden"));
$("closeAdd").addEventListener("click", () => $("addPanel").classList.add("hidden"));
$("searchInput").addEventListener("input", render);
$("cargoForm").addEventListener("submit", async e => {
  e.preventDefault(); $("formError").textContent = "";
  const data = Object.fromEntries(new FormData(e.target).entries());
  data.updated = new Date().toISOString().slice(0,10);
  try { await api("/api/cargo",{method:"POST",body:JSON.stringify(data)}); e.target.reset(); $("addPanel").classList.add("hidden"); await loadCargo(); }
  catch(err) { $("formError").textContent = err.message; }
});
$("exportBtn").addEventListener("click", async () => {
  try {
    const data = await api("/api/export");
    const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "cargo-export.json"; a.click(); URL.revokeObjectURL(a.href);
  } catch(e) { alert(e.message); }
});
