/* app.js — Luna (compatível com seu HTML/IDs)
   Endpoints esperados:
     GET  /api/clients
     GET  /api/stats?client=:slug
     GET  /api/queue?client=:slug&page=&pageSize=&search=
     DELETE /api/queue  { client, phone, markSent }
     GET  /api/totals?client=:slug&page=&pageSize=&search=&sent=(all|sim|nao)
     POST /api/contacts { client, name, phone, niche }
     POST /api/import   formData(file, client)
     GET  /api/client-settings?client=:slug
     POST /api/client-settings { client, autoRun, iaAuto, instanceUrl, instanceToken, instanceAuthHeader, instanceAuthScheme }
     POST /api/loop     { client, iaAuto? }
*/

const API_BASE_URL = (window.API_BASE_URL !== undefined ? window.API_BASE_URL : "");

// -------- util DOM / UI ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function showToast(msg, type = "info") {
  const box = $("#toast-container");
  const el = document.createElement("div");
  el.className = "toast";
  el.style.borderLeftColor = (type === "error" ? "var(--danger)" :
                              type === "warning" ? "var(--warning)" : "var(--accent)");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
function showLoading() { $("#loading-overlay").style.display = "flex"; }
function hideLoading() { $("#loading-overlay").style.display = "none"; }

async function api(path, options = {}) {
  showLoading();
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(e);
    showToast(`Erro: ${e.message}`, "error");
    throw e;
  } finally { hideLoading(); }
}

// -------- estado ----------
const state = {
  clients: [],
  selected: null,
  queue: { items: [], page: 1, total: 0, pageSize: 15, search: "" },
  totals: { items: [], page: 1, total: 0, pageSize: 15, search: "", sent: "all" },
  kpis: { totais: 0, enviados: 0, fila: 0, pendentes: 0, last_sent_at: null },
  settings: {
    autoRun: false, iaAuto: false, instanceUrl: "", instanceToken: "",
    instanceAuthHeader: "token", instanceAuthScheme: ""
  }
};

// -------- tabs ----------
function activateTab(tab) {
  // botões
  $$(".tab-btn").forEach(b => b.classList.remove("active"));
  $(`.tab-btn[data-tab="${tab}"]`)?.classList.add("active");
  // seções
  $$(".tab").forEach(s => s.classList.add("tab-hidden"));
  $(`#tab-${tab}`)?.classList.remove("tab-hidden");
}

// -------- clients ----------
async function loadClients() {
  try {
    const clients = await api("/api/clients");
    state.clients = Array.isArray(clients) ? clients : [];
    renderClientList();
    if (!state.selected && state.clients.length) {
      selectClient(state.clients[0].slug);
    }
  } catch {}
}

function renderClientList() {
  const ul = $("#clientList");
  const term = $("#clientSearch").value.trim().toLowerCase();
  const list = state.clients
    .filter(c => c.slug.toLowerCase().includes(term))
    .map(c => {
      const li = document.createElement("li");
      li.dataset.slug = c.slug;
      li.className = (state.selected === c.slug ? "active" : "");
      li.innerHTML = `<span>${c.slug}</span><span class="badge">${c.queueCount ?? 0}</span>`;
      li.addEventListener("click", () => selectClient(c.slug));
      return li;
    });
  ul.innerHTML = "";
  list.forEach(li => ul.appendChild(li));
}

async function createClient(slugRaw) {
  try {
    let slug = String(slugRaw || "").trim().toLowerCase();
    if (!slug) return;
    if (!slug.startsWith("cliente_")) slug = `cliente_${slug}`;
    const ok = /^cliente_[a-z0-9_]+$/.test(slug);
    if (!ok) { showToast("Use apenas minúsculas, números e _", "warning"); return; }
    await api("/api/clients", { method: "POST", body: JSON.stringify({ slug }) });
    showToast(`Cliente ${slug} criado`, "success");
    await loadClients();
    selectClient(slug);
  } catch {}
}

async function selectClient(slug) {
  state.selected = slug;
  $("#clientTitle").textContent = slug || "—";
  renderClientList();
  await Promise.all([
    loadStats(),
    loadQueue(),
    loadTotals(),
    loadServerSettings()
  ]);
}

// -------- stats / KPIs ----------
async function loadStats() {
  if (!state.selected) return;
  try {
    const s = await api(`/api/stats?client=${encodeURIComponent(state.selected)}`);
    state.kpis = {
      totais: s.totais ?? 0,
      enviados: s.enviados ?? 0,
      fila: s.fila ?? 0,
      pendentes: s.pendentes ?? Math.max((s.totais ?? 0) - (s.enviados ?? 0), 0),
      last_sent_at: s.last_sent_at ?? null
    };
    renderKPIs();
  } catch {}
}
function renderKPIs() {
  $("#kpiTotais").textContent = state.kpis.totais || 0;
  $("#kpiEnviados").textContent = state.kpis.enviados || 0;
  $("#kpiFila").textContent = state.kpis.fila || 0;
  $("#kpiLastSent").textContent = state.kpis.last_sent_at
    ? new Date(state.kpis.last_sent_at).toLocaleString("pt-BR")
    : "—";
}

// -------- queue ----------
async function loadQueue() {
  if (!state.selected) return;
  const { page, pageSize, search } = state.queue;
  const q = new URLSearchParams({ client: state.selected, page, pageSize, search });
  try {
    const res = await api(`/api/queue?${q}`);
    const items = res.items || res || [];
    state.queue.items = items;
    state.queue.total = res.total ?? items.length ?? 0;
    renderQueue();
  } catch {}
}

function renderQueue() {
  const wrap = $("#queueBody");
  if (!state.queue.items.length) {
    wrap.innerHTML = `<div class="row"><div class="muted" style="grid-column:1/4">Nenhum contato na fila</div></div>`;
  } else {
    wrap.innerHTML = state.queue.items.map(item => {
      const name = item.name || "-";
      const phone = item.phone || "-";
      return `
        <div class="row">
          <div>${name}</div>
          <div>${phone}</div>
          <div>
            <button class="primary" data-phone="${phone}" data-name="${name}" data-act="mark">Marcar Enviado</button>
            <button class="secondary" data-phone="${phone}" data-name="${name}" data-act="remove">Remover</button>
          </div>
        </div>`;
    }).join("");
  }
  const totalPages = Math.max(1, Math.ceil((state.queue.total || 0) / state.queue.pageSize));
  $("#queuePageInfo").textContent = `Página ${state.queue.page} de ${totalPages} (${state.queue.total} itens)`;
  $("#queuePrev").disabled = state.queue.page <= 1;
  $("#queueNext").disabled = state.queue.page >= totalPages;

  // delegação de eventos
  wrap.querySelectorAll("button[data-act]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const phone = btn.dataset.phone; const name = btn.dataset.name;
      const act = btn.dataset.act;
      if (act === "mark") {
        await markAsSent(phone, name);
      } else if (act === "remove") {
        await removeFromQueue(phone);
      }
    });
  });
}

async function markAsSent(phone, name="") {
  if (!state.selected || !phone) return;
  try {
    await api("/api/queue", {
      method: "DELETE",
      body: JSON.stringify({ client: state.selected, phone, markSent: true })
    });
    showToast("Contato marcado como enviado", "success");
    await Promise.all([loadQueue(), loadTotals(), loadStats(), loadClients()]);
  } catch {}
}

async function removeFromQueue(phone) {
  if (!state.selected || !phone) return;
  try {
    await api("/api/queue", {
      method: "DELETE",
      body: JSON.stringify({ client: state.selected, phone, markSent: false })
    });
    showToast("Contato removido da fila", "success");
    await Promise.all([loadQueue(), loadStats(), loadClients()]);
  } catch {}
}

// -------- totals ----------
async function loadTotals() {
  if (!state.selected) return;
  const { page, pageSize, search, sent } = state.totals;
  const q = new URLSearchParams({ client: state.selected, page, pageSize, search, sent });
  try {
    const res = await api(`/api/totals?${q}`);
    const items = res.items || res || [];
    state.totals.items = items;
    state.totals.total = res.total ?? items.length ?? 0;
    renderTotals();
  } catch {}
}

function renderTotals() {
  const wrap = $("#totalsBody");
  if (!state.totals.items.length) {
    wrap.innerHTML = `<div class="row"><div class="muted" style="grid-column:1/6">Nenhum registro encontrado</div></div>`;
  } else {
    wrap.innerHTML = state.totals.items.map(item => {
      const name = item.name || "-";
      const phone = item.phone || "-";
      const niche = item.niche || "-";
      const sent = !!item.mensagem_enviada;
      const updated = item.updated_at ? new Date(item.updated_at).toLocaleString("pt-BR") : "-";
      const badge = `<span class="status ${sent ? "success" : "skipped"}">${sent ? "Enviado" : "Pendente"}</span>`;
      return `
        <div class="row" style="grid-template-columns: 1.5fr 1.2fr 1fr .8fr 1.2fr">
          <div>${name}</div>
          <div>${phone}</div>
          <div>${niche}</div>
          <div>${badge}</div>
          <div>${updated}</div>
        </div>`;
    }).join("");
  }
  const totalPages = Math.max(1, Math.ceil((state.totals.total || 0) / state.totals.pageSize));
  $("#totalsPageInfo").textContent = `Página ${state.totals.page} de ${totalPages} (${state.totals.total} itens)`;
  $("#totalsPrev").disabled = state.totals.page <= 1;
  $("#totalsNext").disabled = state.totals.page >= totalPages;
}

// -------- contatos / CSV ----------
async function addContact() {
  if (!state.selected) return;
  const name  = $("#addName").value.trim();
  const phone = $("#addPhone").value.trim();
  const niche = $("#addNiche").value.trim();
  if (!name || !phone) { showToast("Informe nome e telefone", "warning"); return; }
  try {
    const r = await api("/api/contacts", {
      method: "POST",
      body: JSON.stringify({ client: state.selected, name, phone, niche: niche || null })
    });
    const msg = r.status === "inserted" ? "Contato adicionado" :
                r.status === "skipped_conflict" ? "Telefone já existe" :
                r.status === "skipped_already_known" ? "Já presente no histórico" : "Processado";
    showToast(msg, r.status === "inserted" ? "success" : "warning");
    $("#addName").value = ""; $("#addPhone").value = ""; $("#addNiche").value = "";
    await Promise.all([loadStats(), loadQueue(), loadTotals(), loadClients()]);
  } catch {}
}

async function importCSV(file) {
  if (!state.selected || !file) return;
  showLoading();
  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("client", state.selected);
    const res = await fetch(`${API_BASE_URL}/api/import`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    $("#csvResult").textContent =
      `Inseridos: ${result.inserted || 0} | Ignorados: ${result.skipped || 0} | Erros: ${result.errors || 0}`;
    showToast("Importação concluída", "success");
    await Promise.all([loadStats(), loadQueue(), loadTotals(), loadClients()]);
  } catch (e) {
    showToast(`Erro na importação`, "error");
  } finally { hideLoading(); }
}

// -------- config ----------
async function loadServerSettings() {
  if (!state.selected) return;
  try {
    const s = await api(`/api/client-settings?client=${encodeURIComponent(state.selected)}`);
    state.settings = {
      autoRun: !!s.autoRun,
      iaAuto: !!s.iaAuto,
      instanceUrl: s.instanceUrl || "",
      instanceToken: s.instanceToken || "",
      instanceAuthHeader: s.instanceAuthHeader || "token",
      instanceAuthScheme: s.instanceAuthScheme || ""
    };
  } catch {
    state.settings = { autoRun:false, iaAuto:false, instanceUrl:"", instanceToken:"", instanceAuthHeader:"token", instanceAuthScheme:"" };
  }
  // popular form
  $("#cfgAutoRun").checked = !!state.settings.autoRun;
  $("#cfgIaAuto").checked = !!state.settings.iaAuto;
  $("#cfgInstanceUrl").value = state.settings.instanceUrl || "";
  $("#cfgAuthHeader").value = state.settings.instanceAuthHeader || "token";
  $("#cfgToken").value = state.settings.instanceToken || "";
  $("#cfgAuthScheme").value = state.settings.instanceAuthScheme || "";
  $("#cfgMeta").textContent = "";
}

async function saveServerSettings() {
  if (!state.selected) return;
  const payload = {
    client: state.selected,
    autoRun: $("#cfgAutoRun").checked,
    iaAuto: $("#cfgIaAuto").checked,
    instanceUrl: $("#cfgInstanceUrl").value.trim(),
    instanceToken: $("#cfgToken").value.trim(),
    instanceAuthHeader: $("#cfgAuthHeader").value.trim() || "token",
    instanceAuthScheme: $("#cfgAuthScheme").value.trim()
  };
  try {
    await api("/api/client-settings", { method: "POST", body: JSON.stringify(payload) });
    showToast("Configurações salvas", "success");
  } catch {}
}

async function runLoop() {
  if (!state.selected) return;
  const iaAuto = $("#cfgIaAuto").checked;
  try {
    await api("/api/loop", { method: "POST", body: JSON.stringify({ client: state.selected, iaAuto }) });
    showToast(`Loop iniciado para ${state.selected}`, "success");
    // atualiza KPIs e fila logo após
    await Promise.all([loadStats(), loadQueue(), loadTotals(), loadClients()]);
  } catch {}
}

// -------- eventos iniciais ----------
document.addEventListener("DOMContentLoaded", () => {
  // Tabs
  $$(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      activateTab(tab);
    });
  });
  activateTab("queue");

  // Sidebar / clientes
  $("#clientSearch").addEventListener("input", renderClientList);
  $("#btnCreateClient").addEventListener("click", () => createClient($("#newClientInput").value));

  // Fila
  $("#queueSearch").addEventListener("input", (e) => {
    state.queue.search = e.target.value; state.queue.page = 1; loadQueue();
  });
  $("#queuePrev").addEventListener("click", () => { if (state.queue.page > 1) { state.queue.page--; loadQueue(); } });
  $("#queueNext").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil((state.queue.total || 0) / state.queue.pageSize));
    if (state.queue.page < totalPages) { state.queue.page++; loadQueue(); }
  });

  // Totais
  $("#totalsSearch").addEventListener("input", (e) => {
    state.totals.search = e.target.value; state.totals.page = 1; loadTotals();
  });
  $("#totalsFilter").addEventListener("change", (e) => {
    state.totals.sent = e.target.value; state.totals.page = 1; loadTotals();
  });
  $("#totalsPrev").addEventListener("click", () => { if (state.totals.page > 1) { state.totals.page--; loadTotals(); } });
  $("#totalsNext").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil((state.totals.total || 0) / state.totals.pageSize));
    if (state.totals.page < totalPages) { state.totals.page++; loadTotals(); }
  });

  // Adicionar contato
  $("#btnAddContact").addEventListener("click", addContact);

  // Import CSV
  $("#csvForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const file = $("#csvFile").files[0];
    if (!file) { showToast("Selecione um CSV", "warning"); return; }
    importCSV(file);
  });

  // Config
  $("#btnSaveConfig").addEventListener("click", saveServerSettings);
  $("#btnRunLoop").addEventListener("click", runLoop);

  // Topbar refresh
  $("#btnRefreshAll").addEventListener("click", async () => {
    await loadClients();
    if (state.selected) {
      await Promise.all([loadStats(), loadQueue(), loadTotals(), loadServerSettings()]);
    }
  });

  // Boot
  loadClients();
});
