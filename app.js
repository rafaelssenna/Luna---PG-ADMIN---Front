/* app.js — Luna (com limite diário por cliente + loader discreto + quota na aba Progresso)
   Arquivo completo
*/

const API_BASE_URL = (window.API_BASE_URL !== undefined ? window.API_BASE_URL : "");

// Utilitários DOM
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Toasts e Loader
function showToast(msg, type = "info") {
  const box = $("#toast-container");
  if (!box) { console[type === "error" ? "error" : "log"](msg); return; }
  const el = document.createElement("div");
  el.className = "toast";
  el.style.borderLeftColor = (type === "error" ? "var(--danger)" :
                              type === "warning" ? "var(--warning)" : "var(--accent)");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
function showLoading() { const o = $("#loading-overlay"); if (o) o.style.display = "flex"; }
function hideLoading() { const o = $("#loading-overlay"); if (o) o.style.display = "none"; }

// API helper com overlay
async function api(path, options = {}) {
  showLoading();
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // algumas rotas podem devolver 204 sem body
    const ct = (res.headers.get && res.headers.get("content-type")) || "";
    if (!ct || res.status === 204) return {};
    return await res.json();
  } catch (e) {
    console.error(e);
    showToast(`Erro: ${e.message}`, "error");
    throw e;
  } finally { hideLoading(); }
}

// Helper: dispara POST sem mostrar overlay e sem travar a UI
async function postJsonNoWait(path, body, { timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (_) {
    /* timeout esperado */
  } finally {
    clearTimeout(t);
  }
}

// Normaliza a URL do gateway: adiciona http(s) e /send/text se faltar
function normalizeInstanceUrl(raw) {
  if (!raw) return "";
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const url = new URL(u);
    if (!url.pathname || url.pathname === "/") url.pathname = "/send/text";
    u = url.toString();
  } catch {}
  return u.replace(/\/$/, "");
}

// Estado global
const state = {
  clients: [],
  selected: null,
  queue: { items: [], page: 1, total: 0, pageSize: 15, search: "" },
  totals: { items: [], page: 1, total: 0, pageSize: 15, search: "", sent: "all" },
  kpis: { totais: 0, enviados: 0, fila: 0, pendentes: 0, last_sent_at: null },
  settings: {
    autoRun: false, iaAuto: false, instanceUrl: "", instanceToken: "",
    instanceAuthHeader: "token", instanceAuthScheme: "", dailyLimit: 30
  }
};

// >>> Flags para evitar buscas concorrentes de leads
let leadsBusy = false;
let lastLeadParams = null;

// >>> Atualização periódica da cota quando a aba Progresso está ativa
let quotaInterval = null;

// >>> FUNÇÃO ADICIONADA: atualiza o texto do botão de loop conforme o estado no servidor
async function refreshLoopCta() {
  const btn = $("#btnRunLoop");
  if (!state.selected || !btn) return;
  try {
    const s = await api(`/api/loop-state?client=${encodeURIComponent(state.selected)}`);
    if (s.loop_status === 'running') {
      btn.disabled = true;
      btn.textContent = '▶️ Executando...';
    } else {
      btn.disabled = false;
      if ((s.remaining_today || 0) > 0) {
        btn.textContent = `▶️ Continuar Loop (${s.remaining_today} restantes)`;
      } else {
        btn.textContent = '▶️ Executar Loop';
      }
    }
  } catch (e) {
    // fallback de interface
    btn.disabled = false;
    btn.textContent = '▶️ Executar Loop';
  }
}

// Atualiza cota (Progress → Cota de Hoje)
async function loadQuota() {
  if (!state.selected) return;
  try {
    const s = await api(`/api/loop-state?client=${encodeURIComponent(state.selected)}`);
    const cap = Number(s.cap || 0) || 0;
    const sent = Number(s.sent_today || 0) || 0;
    const remaining = Number(s.remaining_today || 0) || Math.max(cap - sent, 0);
    const pct = cap > 0 ? Math.min(100, Math.round((sent / cap) * 100)) : 0;

    $("#quota-cap") && ($("#quota-cap").textContent = cap);
    $("#quota-sent") && ($("#quota-sent").textContent = sent);
    $("#quota-remaining") && ($("#quota-remaining").textContent = remaining);
    $("#quota-fill") && ($("#quota-fill").style.width = `${pct}%`);
    $("#quota-updated") && ($("#quota-updated").textContent =
      `Atualizado em ${new Date().toLocaleString("pt-BR")}`);

    // também ajusta CTA
    await refreshLoopCta();
  } catch (e) {
    // Silencioso: já há toast no api()
  }
}

// Tab navigation
function activateTab(tab) {
  $$(".tab-btn").forEach(b => b.classList.remove("active"));
  $(`.tab-btn[data-tab="${tab}"]`)?.classList.add("active");
  $$(".tab").forEach(s => s.classList.add("tab-hidden"));
  $(`#tab-${tab}`)?.classList.remove("tab-hidden");

  // Inicia/para auto-refresh da cota quando a aba Progresso está ativa
  if (tab === "progress") {
    loadQuota(); // imediato
    if (!quotaInterval) quotaInterval = setInterval(loadQuota, 30000);
  } else {
    if (quotaInterval) { clearInterval(quotaInterval); quotaInterval = null; }
  }
}

// Clients
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
  if (!ul) return;
  const term = ($("#clientSearch")?.value || "").trim().toLowerCase();
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
    // validação: 1 a 64 caracteres, apenas letras minúsculas, números ou underline
    const ok = /^[a-z0-9_]{1,64}$/.test(slug);
    if (!ok) {
      showToast("Use apenas minúsculas, números e _ (até 64 caracteres)", "warning");
      return;
    }
    await api("/api/clients", { method: "POST", body: JSON.stringify({ slug }) });
    showToast(`Cliente ${slug} criado`, "success");
    await loadClients();
    selectClient(slug);
  } catch {}
}

async function selectClient(slug) {
  state.selected = slug;
  const title = $("#clientTitle");
  if (title) title.textContent = slug || "—";
  renderClientList();
  await Promise.all([
    loadStats(),
    loadQueue(),
    loadTotals(),
    loadServerSettings()
  ]);
  // Atualiza o botão de loop e a cota
  await refreshLoopCta();
  await loadQuota();
}

// KPIs
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
  $("#kpiTotais") && ($("#kpiTotais").textContent = state.kpis.totais || 0);
  $("#kpiEnviados") && ($("#kpiEnviados").textContent = state.kpis.enviados || 0);
  $("#kpiFila") && ($("#kpiFila").textContent = state.kpis.fila || 0);
  $("#kpiLastSent") && ($("#kpiLastSent").textContent = state.kpis.last_sent_at
    ? new Date(state.kpis.last_sent_at).toLocaleString("pt-BR")
    : "—");
}

// Queue
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
  if (!wrap) return;
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
  $("#queuePageInfo") && ($("#queuePageInfo").textContent = `Página ${state.queue.page} de ${totalPages} (${state.queue.total} itens)`);
  $("#queuePrev") && ($("#queuePrev").disabled = state.queue.page <= 1);
  $("#queueNext") && ($("#queueNext").disabled = state.queue.page >= totalPages);

  wrap.querySelectorAll("button[data-act]").forEach(btn => {
    btn.addEventListener("click", async () => {
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
    await Promise.all([loadQueue(), loadTotals(), loadStats(), loadClients(), loadQuota()]);
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
    await Promise.all([loadQueue(), loadStats(), loadClients(), loadQuota()]);
  } catch {}
}

// Totals
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
  if (!wrap) return;
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
  $("#totalsPageInfo") && ($("#totalsPageInfo").textContent = `Página ${state.totals.page} de ${totalPages} (${state.totals.total} itens)`);
  $("#totalsPrev") && ($("#totalsPrev").disabled = state.totals.page <= 1));
  $("#totalsNext") && ($("#totalsNext").disabled = state.totals.page >= totalPages));
}

// Contatos / CSV
async function addContact() {
  if (!state.selected) return;
  const name  = ($("#addName")?.value || "").trim();
  const phone = ($("#addPhone")?.value || "").trim();
  const niche = ($("#addNiche")?.value || "").trim();
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
    if ($("#addName"))  $("#addName").value  = "";
    if ($("#addPhone")) $("#addPhone").value = "";
    if ($("#addNiche")) $("#addNiche").value = "";
    await Promise.all([loadStats(), loadQueue(), loadTotals(), loadClients(), loadQuota()]);
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
    if ($("#csvResult")) {
      $("#csvResult").textContent =
        `Inseridos: ${result.inserted || 0} | Ignorados: ${result.skipped || 0} | Erros: ${result.errors || 0}`;
    }
    showToast("Importação concluída", "success");
    await Promise.all([loadStats(), loadQueue(), loadTotals(), loadClients(), loadQuota()]);
  } catch (e) {
    showToast(`Erro na importação`, "error");
  } finally { hideLoading(); }
}

// Config
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
      instanceAuthScheme: s.instanceAuthScheme || "",
      dailyLimit: Number.isFinite(Number(s.dailyLimit)) ? Number(s.dailyLimit) : 30
    };
  } catch {
    state.settings = { autoRun:false, iaAuto:false, instanceUrl:"", instanceToken:"", instanceAuthHeader:"token", instanceAuthScheme:"", dailyLimit:30 };
  }
  $("#cfgAutoRun")     && ($("#cfgAutoRun").checked = !!state.settings.autoRun);
  $("#cfgIaAuto")      && ($("#cfgIaAuto").checked = !!state.settings.iaAuto);
  $("#cfgInstanceUrl") && ($("#cfgInstanceUrl").value = state.settings.instanceUrl || "");
  $("#cfgAuthHeader")  && ($("#cfgAuthHeader").value = state.settings.instanceAuthHeader || "token");
  $("#cfgToken")       && ($("#cfgToken").value = state.settings.instanceToken || "");
  $("#cfgAuthScheme")  && ($("#cfgAuthScheme").value = state.settings.instanceAuthScheme || "");
  $("#cfgDailyLimit")  && ($("#cfgDailyLimit").value = (state.settings.dailyLimit ?? 30));
  $("#cfgMeta")        && ($("#cfgMeta").textContent = "");
}

async function saveServerSettings() {
  if (!state.selected) return;
  // dailyLimit: deixa em branco para manter valor atual
  let dailyLimitRaw = ($("#cfgDailyLimit")?.value || "").trim();
  let dailyLimit = Number.isFinite(parseInt(dailyLimitRaw, 10)) ? Math.max(1, Math.min(10000, parseInt(dailyLimitRaw, 10))) : null;

  const payload = {
    client: state.selected,
    autoRun: $("#cfgAutoRun")?.checked || false,
    iaAuto: $("#cfgIaAuto")?.checked || false,
    instanceUrl: normalizeInstanceUrl(($("#cfgInstanceUrl")?.value || "")),
    instanceToken: ($("#cfgToken")?.value || "").trim(),
    instanceAuthHeader: ($("#cfgAuthHeader")?.value || "token").trim() || "token",
    instanceAuthScheme: ($("#cfgAuthScheme")?.value || "").trim(),
    dailyLimit
  };
  try {
    await api("/api/client-settings", { method: "POST", body: JSON.stringify(payload) });
    showToast("Configurações salvas", "success");
    await Promise.all([loadServerSettings(), loadQuota(), refreshLoopCta()]);
  } catch {}
}

/* runLoop: dispara o loop via backend sem travar a UI */
async function runLoop() {
  if (!state.selected) return;
  const iaAuto = $("#cfgIaAuto")?.checked || false;
  postJsonNoWait("/api/loop", { client: state.selected, iaAuto });
  showToast(`Loop solicitado para ${state.selected}`, "success");
  Promise.allSettled([ loadStats(), loadQueue(), loadTotals(), loadClients(), loadQuota() ]);
  // Atualiza CTA após disparar loop
  await refreshLoopCta();
}

/* >>> ADIÇÃO: parar o loop atual via /api/stop-loop */
async function stopLoop() {
  if (!state.selected) return;
  try {
    await fetch(`${API_BASE_URL}/api/stop-loop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: state.selected })
    });
    showToast("Parada do loop solicitada", "warning");
    // Atualiza indicadores rapidamente
    Promise.allSettled([ loadStats(), loadServerSettings(), loadQuota(), refreshLoopCta() ]);
  } catch (e) {
    console.error(e);
    showToast("Falha ao solicitar parada do loop", "error");
  } finally {
    // Atualiza CTA após a tentativa de parada
    await refreshLoopCta();
  }
}

/* >>> ADIÇÃO: Buscar & Salvar Leads (com trava de concorrência) */
async function searchLeadsAndSave() {
  if (!state.selected) { showToast("Selecione um cliente", "warning"); return; }

  const btn    = $("#btnLeadsSearch");
  const region = ($("#leadRegion")?.value || "").trim();
  const niche  = ($("#leadNiche")?.value || "").trim();
  const limit  = parseInt($("#leadLimit")?.value || "100", 10);

  if (!region && !niche) {
    showToast("Informe pelo menos Região ou Nicho", "warning");
    return;
  }

  if (leadsBusy) {
    showToast("Uma busca já está em execução… aguarde terminar.", "warning");
    return;
  }

  // marca como ocupado e desabilita o botão
  leadsBusy = true;
  if (btn) {
    btn.disabled = true;
    btn.dataset.prevText = btn.textContent;
    btn.textContent = "⏳ Buscando…";
  }

  // prévia no UI
  $("#leadsResult") && ($("#leadsResult").textContent = `Buscando: região="${region}", nicho="${niche}", limite=${limit}`);

  try {
    const result = await api("/api/leads", {
      method: "POST",
      body: JSON.stringify({ client: state.selected, region, niche, limit })
    });
    const msg = `Encontrados: ${result.found || 0} | Inseridos: ${result.inserted || 0} | Duplicados/Ignorados: ${result.skipped || 0} | Erros: ${result.errors || 0}`;
    $("#leadsResult") && ($("#leadsResult").textContent = msg);
    showToast(`Leads adicionados: ${result.inserted || 0}`, "success");
    await Promise.all([loadStats(), loadQueue(), loadTotals(), loadClients(), loadQuota()]);
  } catch (e) {
    // api() já trata toasts
  } finally {
    leadsBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.prevText || "🔎 Buscar & Salvar";
      delete btn.dataset.prevText;
    }
  }
}

// Remover cliente
async function deleteClient() {
  const slug = state.selected;
  if (!slug) { showToast("Nenhum cliente selecionado.", "warning"); return; }
  const confirm1 = window.confirm(`Tem certeza que deseja APAGAR as tabelas e dados do cliente "${slug}"?\n\nEsta ação NÃO pode ser desfeita.`);
  if (!confirm1) return;
  const typed = window.prompt(`Para confirmar, digite o slug do cliente exatamente como abaixo:\n\n${slug}`);
  if (typed !== slug) { showToast("Confirmação cancelada.", "warning"); return; }
  try {
    await api("/api/delete-client", { method: "DELETE", body: JSON.stringify({ client: slug }) });
    showToast(`Tabelas de ${slug} apagadas com sucesso`, "success");
    await loadClients();
    if (state.clients.length > 0) selectClient(state.clients[0].slug);
    else {
      state.selected = null;
      const title = $("#clientTitle"); if (title) title.textContent = "—";
      const qb = $("#queueBody");  if (qb)  qb.innerHTML = `<div class="row"><div class="muted" style="grid-column:1/4">Nenhum contato na fila</div></div>`;
      const tb = $("#totalsBody"); if (tb) tb.innerHTML = `<div class="row"><div class="muted" style="grid-column:1/6">Nenhum registro encontrado</div></div>`;
      $("#kpiTotais")  && ($("#kpiTotais").textContent = 0);
      $("#kpiEnviados")&& ($("#kpiEnviados").textContent = 0);
      $("#kpiFila")    && ($("#kpiFila").textContent = 0);
      $("#kpiLastSent")&& ($("#kpiLastSent").textContent = "—");
      $("#quota-fill") && ($("#quota-fill").style.width = "0%");
      $("#quota-sent") && ($("#quota-sent").textContent = "0");
      $("#quota-cap")  && ($("#quota-cap").textContent = "30");
      $("#quota-remaining") && ($("#quota-remaining").textContent = "0");
      $("#quota-updated") && ($("#quota-updated").textContent = "—");
    }
  } catch (err) {
    console.error(err);
    showToast("Erro ao excluir tabelas", "error");
  }
}

// Eventos iniciais
document.addEventListener("DOMContentLoaded", () => {
  $$(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      activateTab(tab);
    });
  });
  activateTab("queue");

  $("#clientSearch") && $("#clientSearch").addEventListener("input", renderClientList);
  $("#btnCreateClient") && $("#btnCreateClient").addEventListener("click", () => createClient($("#newClientInput").value));

  $("#queueSearch") && $("#queueSearch").addEventListener("input", (e) => {
    state.queue.search = e.target.value; state.queue.page = 1; loadQueue();
  });
  $("#queuePrev") && $("#queuePrev").addEventListener("click", () => { if (state.queue.page > 1) { state.queue.page--; loadQueue(); } });
  $("#queueNext") && $("#queueNext").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil((state.queue.total || 0) / state.queue.pageSize));
    if (state.queue.page < totalPages) { state.queue.page++; loadQueue(); }
  });

  $("#totalsSearch") && $("#totalsSearch").addEventListener("input", (e) => {
    state.totals.search = e.target.value; state.totals.page = 1; loadTotals();
  });
  $("#totalsFilter") && $("#totalsFilter").addEventListener("change", (e) => {
    state.totals.sent = e.target.value; state.totals.page = 1; loadTotals();
  });
  $("#totalsPrev") && $("#totalsPrev").addEventListener("click", () => { if (state.totals.page > 1) { state.totals.page--; loadTotals(); } });
  $("#totalsNext") && $("#totalsNext").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil((state.totals.total || 0) / state.totals.pageSize));
    if (state.totals.page < totalPages) { state.totals.page++; loadTotals(); }
  });

  $("#btnAddContact") && $("#btnAddContact").addEventListener("click", addContact);

  $("#csvForm") && $("#csvForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const file = $("#csvFile")?.files?.[0];
    if (!file) { showToast("Selecione um CSV", "warning"); return; }
    importCSV(file);
  });

  $("#btnSaveConfig") && $("#btnSaveConfig").addEventListener("click", saveServerSettings);
  $("#btnRunLoop") && $("#btnRunLoop").addEventListener("click", runLoop);
  /* >>> listener do botão Parar Loop + preventDefault */
  $("#btnStopLoop") && $("#btnStopLoop").addEventListener("click", (e) => { e.preventDefault(); stopLoop(); });

  /* >>> listener do Buscar & Salvar Leads */
  $("#btnLeadsSearch") && $("#btnLeadsSearch").addEventListener("click", searchLeadsAndSave);

  const cfgRow = $("#btnSaveConfig")?.parentElement;
  if (cfgRow && !$("#btnDeleteClient")) {
    const btnDel = document.createElement("button");
    btnDel.id = "btnDeleteClient";
    btnDel.title = "Apagar tabelas e dados deste cliente";
    btnDel.textContent = "🗑️ Apagar Tabela";
    btnDel.className = "secondary";
    btnDel.style.marginLeft = "8px";
    btnDel.style.background = "var(--danger)";
    btnDel.style.color = "#fff";
    btnDel.addEventListener("click", deleteClient);
    cfgRow.appendChild(btnDel);
  }

  $("#btnRefreshAll") && $("#btnRefreshAll").addEventListener("click", async () => {
    await loadClients();
    if (state.selected) {
      await Promise.all([loadStats(), loadQueue(), loadTotals(), loadServerSettings(), loadQuota(), refreshLoopCta()]);
    }
  });

  loadClients();
});
