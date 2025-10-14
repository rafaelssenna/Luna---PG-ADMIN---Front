// Configuration
// Se você estiver executando o front-end e o back-end no mesmo domínio (ex.: Railway ou Vercel),
// deixe a URL base vazia para que as chamadas usem a mesma origem. Caso contrário, defina a
// variável de ambiente API_BASE_URL no HTML ou no window antes de carregar este script.
const API_BASE_URL = (window.API_BASE_URL !== undefined ? window.API_BASE_URL : "");

// ====== Novos: Automação no front ======
const AUTO_INTERVAL_MS = 30000; // 30s (ajuste se quiser)
const autoTimers = {}; // { [slug]: intervalId }

function settingsKey(slug) {
  return `luna_pg_client_settings__${slug}`;
}
function loadLocalSettings(slug) {
  try {
    return JSON.parse(localStorage.getItem(settingsKey(slug))) || {
      autoRun: false,
      iaAuto: false,
      instanceUrl: "",
      lastRunAt: null,
    };
  } catch {
    return { autoRun: false, iaAuto: false, instanceUrl: "", lastRunAt: null };
  }
}
function saveLocalSettings(slug, partial) {
  const next = { ...loadLocalSettings(slug), ...(partial || {}) };
  localStorage.setItem(settingsKey(slug), JSON.stringify(next));
  return next;
}
function startAutoFor(slug) {
  stopAutoFor(slug);
  autoTimers[slug] = setInterval(async () => {
    try {
      const { iaAuto } = loadLocalSettings(slug);
      // O backend ignora campos extras; enviamos iaAuto para futura compatibilidade
      await api("/api/loop", {
        method: "POST",
        body: JSON.stringify({ client: slug, iaAuto }),
      });
      // Atualiza status e telas
      if (state.selected === slug) {
        const iso = new Date().toISOString();
        state.settings = saveLocalSettings(slug, { lastRunAt: iso });
        renderSettings();
        await Promise.all([
          loadQueue(),
          loadTotals(),
          (async () => {
            const stats = await api(`/api/stats?client=${slug}`);
            state.kpis = stats;
            renderKPIs();
          })(),
        ]);
      }
      await loadClients();
    } catch (e) {
      console.error("Auto-run erro:", e);
    }
  }, AUTO_INTERVAL_MS);
}
function stopAutoFor(slug) {
  if (autoTimers[slug]) {
    clearInterval(autoTimers[slug]);
    delete autoTimers[slug];
  }
}
function applyAutoState(slug) {
  const { autoRun } = loadLocalSettings(slug);
  if (autoRun) startAutoFor(slug);
  else stopAutoFor(slug);
}

// ======================================

// State Management
const state = {
  clients: [],
  selected: null,
  queue: { items: [], page: 1, total: 0, pageSize: 25, search: "" },
  totals: { items: [], page: 1, total: 0, pageSize: 25, search: "", sent: "all" },
  kpis: { totais: 0, enviados: 0, pendentes: 0, fila: 0 },
  // Novos: espelho do que fica no localStorage por cliente
  settings: { autoRun: false, iaAuto: false, instanceUrl: "", lastRunAt: null },
};

// ====== API Helper ======
async function api(path, options = {}) {
  showLoading();
  try {
    const url = `${API_BASE_URL}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("[v0] API Error:", error);
    showToast(`Erro: ${error.message}`, "error");
    throw error;
  } finally {
    hideLoading();
  }
}

// ====== Configurações no Servidor ======
async function loadServerSettings(slug) {
  return api(`/api/client-settings?client=${slug}`);
}
async function saveServerSettings(slug, { autoRun, iaAuto, instanceUrl }) {
  return api(`/api/client-settings`, {
    method: "POST",
    body: JSON.stringify({
      client: slug,
      autoRun: !!autoRun,
      iaAuto: !!iaAuto,
      instanceUrl: instanceUrl || null,
    }),
  });
}
async function syncSettingsFromServer(slug) {
  try {
    const s = await loadServerSettings(slug);
    // Salva apenas as preferências persistidas (autoRun, iaAuto, instanceUrl, lastRunAt) no localStorage
    const next = saveLocalSettings(slug, {
      autoRun: !!s.autoRun,
      iaAuto: !!s.iaAuto,
      instanceUrl: s.instanceUrl || "",
      lastRunAt: s.lastRunAt || null,
    });
    // Replica o status do loop retornado pelo servidor no estado (não persistimos no localStorage)
    state.settings = { ...next, loopStatus: s.loopStatus || "idle" };
    renderSettings();
    applyAutoState(slug);
  } catch (e) {
    // Falhou? segue com localStorage
    state.settings = loadLocalSettings(slug);
    renderSettings();
    applyAutoState(slug);
  }
}

// ====== Toasts / Loading / Util ======
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  const iconMap = {
    success: "check-circle",
    error: "x-circle",
    warning: "alert-circle",
    info: "info",
  };

  toast.innerHTML = `
    <i data-lucide="${iconMap[type]}"></i>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = "slideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function showLoading() {
  document.getElementById("loading-overlay").style.display = "flex";
}
function hideLoading() {
  document.getElementById("loading-overlay").style.display = "none";
}

function normalizeSlug(input) {
  let slug = input.trim().toLowerCase();
  if (!slug.startsWith("cliente_")) slug = `cliente_${slug}`;
  const validPattern = /^cliente_[a-z0-9_]+$/;
  if (!validPattern.test(slug)) {
    throw new Error("Slug inválido. Use apenas letras minúsculas, números e underscores.");
  }
  return slug;
}

function formatDate(dateString) {
  if (!dateString) return "-";
  const date = new Date(dateString);
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ====== NOVOS: Aba Config (injetada) ======
function injectConfigTabOnce() {
  // Se já existe, não injeta de novo
  if (document.querySelector('.tab[data-tab="config"]') && document.getElementById("tab-config")) {
    return;
  }

  const tabs = document.querySelector(".tabs");
  const clientView = document.getElementById("client-view");
  if (!tabs || !clientView) return;

  // Botão da aba
  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.tab = "config";
  btn.innerHTML = `<i data-lucide="settings"></i>Config`;
  tabs.appendChild(btn);

  // Conteúdo da aba
  const content = document.createElement("div");
  content.id = "tab-config";
  content.className = "tab-content";
  content.innerHTML = `
    <div class="form-card">
      <h3>Configurações do Cliente</h3>

      <div class="checkbox-group">
        <label>
          <input type="checkbox" id="auto-run-toggle">
          <span>Execução automática do loop</span>
        </label>
      </div>

      <div class="checkbox-group" style="margin-top:.5rem;">
        <label>
          <input type="checkbox" id="ia-auto-toggle">
          <span>IA automática</span>
        </label>
      </div>

      <div class="form-group" style="margin-top:1rem;">
        <label for="instance-url">Instância (URL de envio da IA)</label>
        <input type="url" id="instance-url" placeholder="https://minha-instancia.exemplo/send">
      </div>

      <div style="margin-top:1rem; display:flex; gap:.5rem; align-items:center;">
        <button id="save-settings" class="btn btn-primary">
          <i data-lucide="save"></i>
          <span>Salvar</span>
        </button>
        <button id="run-now" class="btn btn-secondary">
          <i data-lucide="play-circle"></i>
          <span>Executar Agora</span>
        </button>
        <span id="settings-status" style="color: var(--muted); font-size:.9rem; margin-left:.25rem;"></span>
      </div>
    </div>
  `;
  clientView.appendChild(content);

  // Navegação da aba (sem depender do bind inicial)
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    document.getElementById("tab-config").classList.add("active");
  });

  // Ações
  document.getElementById("save-settings").addEventListener("click", async () => {
    const values = {
      autoRun: document.getElementById("auto-run-toggle").checked,
      iaAuto: document.getElementById("ia-auto-toggle").checked,
      instanceUrl: document.getElementById("instance-url").value.trim(),
    };
    try { await saveServerSettings(state.selected, values); } catch {}
    const next = saveLocalSettings(state.selected, values);
    state.settings = next;
    applyAutoState(state.selected);
    renderSettings();
    showToast("Configurações salvas", "success");
  });

  document.getElementById("run-now").addEventListener("click", () => runLoop(state.selected));

  // Render ícones dessa aba
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

function renderSettings() {
  // Se a aba ainda não existe, não faz nada
  const autoEl = document.getElementById("auto-run-toggle");
  const iaEl = document.getElementById("ia-auto-toggle");
  const instanceEl = document.getElementById("instance-url");
  const statusEl = document.getElementById("settings-status");
  if (!autoEl || !iaEl || !statusEl) return;

  const cfg = state.settings || { autoRun: false, iaAuto: false, instanceUrl: "", lastRunAt: null, loopStatus: "idle" };

  autoEl.checked = !!cfg.autoRun;
  iaEl.checked = !!cfg.iaAuto;
  if (instanceEl) instanceEl.value = cfg.instanceUrl || "";
  const last = cfg.lastRunAt ? formatDate(cfg.lastRunAt) : "-";
  const st = cfg.loopStatus || "idle";
  // Exibe o status atual do loop e a data da última execução
  statusEl.textContent = `Status: ${st} | Última execução: ${last}`;
}
// ==========================================

// Inicia o loop de processamento para um cliente (já existia; mantido)
async function runLoop(clientSlug) {
  try {
    const slug = clientSlug || state.selected;
    if (!slug) throw new Error("Nenhum cliente selecionado");
    const { iaAuto } = loadLocalSettings(slug);
    await api("/api/loop", {
      method: "POST",
      body: JSON.stringify({ client: slug, iaAuto }),
    });
    // Registra última execução local
    const iso = new Date().toISOString();
    state.settings = saveLocalSettings(slug, { lastRunAt: iso });
    // Após iniciar o loop, pedimos ao servidor o status atualizado
    try {
      const serv = await loadServerSettings(slug);
      // Atualiza estado local com status retornado (mas não persistimos loopStatus no localStorage)
      state.settings = { ...state.settings, loopStatus: serv.loopStatus || state.settings.loopStatus || "idle" };
    } catch {}
    renderSettings();

    showToast(`Loop iniciado para ${slug}`, "success");

    if (state.selected === slug) {
      await Promise.all([
        loadQueue(),
        loadTotals(),
        loadClients(),
        (async () => {
          const stats = await api(`/api/stats?client=${slug}`);
          state.kpis = stats;
          renderKPIs();
        })(),
      ]);
    } else {
      await loadClients();
    }
  } catch (error) {
    console.error("[v0] Failed to run loop:", error);
  }
}

// Load Clients
async function loadClients() {
  try {
    const clients = await api("/api/clients");
    state.clients = clients.sort((a, b) => a.slug.localeCompare(b.slug));
    renderClientList();

    // Auto-select first client if none selected
    if (!state.selected && state.clients.length > 0) {
      selectClient(state.clients[0].slug);
    } else if (state.selected) {
      await loadClientData(state.selected);
    }
  } catch (error) {
    console.error("[v0] Failed to load clients:", error);
  }
}

// Render Client List
function renderClientList() {
  const container = document.getElementById("client-list");
  const searchTerm = document.getElementById("client-search").value.toLowerCase();
  const filteredClients = state.clients.filter((client) => client.slug.toLowerCase().includes(searchTerm));

  if (filteredClients.length === 0) {
    container.innerHTML =
      '<div style="padding: 1rem; text-align: center; color: var(--muted);">Nenhum cliente encontrado</div>';
    return;
  }

  container.innerHTML = filteredClients
    .map((client) => {
      const active = state.selected === client.slug ? "active" : "";
      const badge = client.queueCount !== undefined ? `<span class="client-badge">${client.queueCount}</span>` : "";
      const loopButton = `<button class="btn-icon run-loop-btn" data-slug="${client.slug}" title="Executar loop" aria-label="Executar loop"><i data-lucide="play-circle"></i></button>`;
      // Indicador de status: usa a propriedade loopStatus retornada do backend (default: idle)
      const status = client.loopStatus || "idle";
      const statusDot = `<span class="status-dot status-${status}"></span>`;
      return `
        <div class="client-item ${active}" data-slug="${client.slug}" role="listitem">
          <span class="client-name">${statusDot}${client.slug}</span>
          <div class="client-actions">
            ${badge}
            ${loopButton}
          </div>
        </div>
      `;
    })
    .join("");

  // Click para selecionar cliente
  container.querySelectorAll(".client-item").forEach((item) => {
    item.addEventListener("click", () => {
      selectClient(item.dataset.slug);
    });
  });
  // Botão ▶ executar loop
  container.querySelectorAll(".run-loop-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slug = btn.dataset.slug;
      runLoop(slug);
    });
  });
  // Ícones
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

// Select Client
async function selectClient(slug) {
  state.selected = slug;

  // Reset pagination
  state.queue.page = 1;
  state.queue.search = "";
  state.totals.page = 1;
  state.totals.search = "";
  state.totals.sent = "all";

  // Update UI
  renderClientList();
  document.getElementById("empty-state").style.display = "none";
  document.getElementById("client-view").style.display = "block";
  document.getElementById("client-title").textContent = slug;

  // Clear search inputs
  document.getElementById("queue-search").value = "";
  document.getElementById("totals-search").value = "";
  document.getElementById("totals-filter").value = "all";

  // Garante que a aba Config exista
  injectConfigTabOnce();

  // Carrega dados e configurações do cliente
  await loadClientData(slug);
  await syncSettingsFromServer(slug);
}

// Load Client Data
async function loadClientData(slug) {
  try {
    // KPIs
    const stats = await api(`/api/stats?client=${slug}`);
    state.kpis = stats;
    renderKPIs();

    // Fila
    await loadQueue();

    // Totais
    await loadTotals();
  } catch (error) {
    console.error("[v0] Failed to load client data:", error);
  }
}

// Render KPIs
function renderKPIs() {
  const totalsEl   = document.getElementById("kpi-totais");
  const enviadosEl = document.getElementById("kpi-enviados");
  const pendEl     = document.getElementById("kpi-pendentes");
  const filaEl     = document.getElementById("kpi-fila");
  if (totalsEl) totalsEl.textContent = state.kpis.totais || 0;
  if (enviadosEl) enviadosEl.textContent = state.kpis.enviados || 0;
  // A região "Pendentes" pode não existir no HTML; checa antes de escrever
  if (pendEl) pendEl.textContent = state.kpis.pendentes || 0;
  if (filaEl) filaEl.textContent = state.kpis.fila || 0;
}

// Load Queue
async function loadQueue() {
  try {
    const { page, pageSize, search } = state.queue;
    const params = new URLSearchParams({ client: state.selected, page, pageSize, search });
    const response = await api(`/api/queue?${params}`);
    state.queue.items = response.items || response;
    state.queue.total = response.total || response.length || 0;
    renderQueue();
  } catch (error) {
    console.error("[v0] Failed to load queue:", error);
  }
}

// Render Queue
function renderQueue() {
  const tbody = document.getElementById("queue-table-body");
  if (state.queue.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--muted);">Nenhum contato na fila</td></tr>';
  } else {
    tbody.innerHTML = state.queue.items
      .map(
        (item) => `
      <tr>
        <td>${item.name || "-"}</td>
        <td>${item.phone || "-"}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-sm btn-primary" onclick="markAsSent('${item.phone}')">
              <i data-lucide="check"></i>
              Marcar Enviada
            </button>
            <button class="btn btn-sm btn-danger" onclick="removeFromQueue('${item.phone}')">
              <i data-lucide="trash-2"></i>
              Remover
            </button>
          </div>
        </td>
      </tr>
    `
      )
      .join("");
  }

  const totalPages = Math.ceil(state.queue.total / state.queue.pageSize);
  document.getElementById("queue-page-info").textContent = `Página ${state.queue.page} de ${totalPages || 1} (${state.queue.total} itens)`;
  document.getElementById("queue-prev").disabled = state.queue.page === 1;
  document.getElementById("queue-next").disabled = state.queue.page >= totalPages;
}

// Load Totals
async function loadTotals() {
  try {
    const { page, pageSize, search, sent } = state.totals;
    const params = new URLSearchParams({ client: state.selected, page, pageSize, search, sent });
    const response = await api(`/api/totals?${params}`);
    state.totals.items = response.items || response;
    state.totals.total = response.total || response.length || 0;
    renderTotals();
  } catch (error) {
    console.error("[v0] Failed to load totals:", error);
  }
}

// Render Totals
function renderTotals() {
  const tbody = document.getElementById("totals-table-body");
  if (state.totals.items.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" style="text-align: center; color: var(--muted);">Nenhum registro encontrado</td></tr>';
  } else {
    tbody.innerHTML = state.totals.items
      .map(
        (item) => `
      <tr>
        <td>${item.name || "-"}</td>
        <td>${item.phone || "-"}</td>
        <td>${item.niche || "-"}</td>
        <td>
          <span class="badge ${item.mensagem_enviada ? "success" : "pending"}">
            ${item.mensagem_enviada ? "Enviado" : "Pendente"}
          </span>
        </td>
        <td>${formatDate(item.updated_at)}</td>
      </tr>
    `
      )
      .join("");
  }

  const totalPages = Math.ceil(state.totals.total / state.totals.pageSize);
  document.getElementById("totals-page-info").textContent =
    `Página ${state.totals.page} de ${totalPages || 1} (${state.totals.total} itens)`;
  document.getElementById("totals-prev").disabled = state.totals.page === 1;
  document.getElementById("totals-next").disabled = state.totals.page >= totalPages;
}

// Mark as Sent
window.markAsSent = async (phone) => {
  try {
    await api("/api/queue", {
      method: "DELETE",
      body: JSON.stringify({ client: state.selected, phone, markSent: true }),
    });
    showToast("Contato marcado como enviado", "success");
    state.totals.sent = "all";
    await Promise.all([
      loadQueue(),
      loadTotals(),
      loadClients(),
      (async () => {
        const stats = await api(`/api/stats?client=${state.selected}`);
        state.kpis = stats;
        renderKPIs();
      })(),
    ]);
  } catch (error) {
    console.error("[v0] Failed to mark as sent:", error);
  }
};

// Remove from Queue
window.removeFromQueue = (phone) => {
  const modal = document.getElementById("queue-action-modal");
  const checkboxGroup = document.getElementById("mark-sent-checkbox");
  const checkbox = document.getElementById("mark-as-sent");

  document.getElementById("modal-title").textContent = "Remover da Fila";
  document.getElementById("modal-message").textContent = "Deseja remover este contato da fila?";

  checkboxGroup.style.display = "block";
  checkbox.checked = false;

  modal.classList.add("active");

  const confirmBtn = document.getElementById("modal-confirm");
  confirmBtn.onclick = async () => {
    try {
      await api("/api/queue", {
        method: "DELETE",
        body: JSON.stringify({ client: state.selected, phone, markSent: checkbox.checked }),
      });
      showToast("Contato removido da fila", "success");
      modal.classList.remove("active");
      if (checkbox.checked) state.totals.sent = "all";
      await Promise.all([
        loadQueue(),
        loadTotals(),
        loadClients(),
        (async () => {
          const stats = await api(`/api/stats?client=${state.selected}`);
          state.kpis = stats;
          renderKPIs();
        })(),
      ]);
    } catch (error) {
      console.error("[v0] Failed to remove from queue:", error);
    }
  };
};

// Create Client
async function createClient(slug) {
  try {
    const normalizedSlug = normalizeSlug(slug);
    await api("/api/clients", { method: "POST", body: JSON.stringify({ slug: normalizedSlug }) });
    showToast(`Cliente ${normalizedSlug} criado com sucesso`, "success");
    await loadClients();
    selectClient(normalizedSlug);
  } catch (error) {
    console.error("[v0] Failed to create client:", error);
  }
}

// Add Contact
async function addContact(name, phone, niche) {
  try {
    const response = await api("/api/contacts", {
      method: "POST",
      body: JSON.stringify({ client: state.selected, name, phone, niche: niche || null }),
    });

    const statusMessages = {
      inserted: "Contato adicionado com sucesso",
      skipped_conflict: "Contato já existe (conflito de telefone)",
      skipped_already_known: "Contato já conhecido no histórico",
    };

    const message = statusMessages[response.status] || "Contato processado";
    const type = response.status === "inserted" ? "success" : "warning";
    showToast(message, type);

    if (response.status === "inserted") {
      await loadClientData(state.selected);
      await loadClients();
    }
  } catch (error) {
    console.error("[v0] Failed to add contact:", error);
  }
}

// Import CSV
async function importCSV(file) {
  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("client", state.selected);

    showLoading();
    const response = await fetch(`${API_BASE_URL}/api/import`, { method: "POST", body: formData });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const result = await response.json();
    hideLoading();

    document.getElementById("import-result").style.display = "block";
    document.getElementById("import-inserted").textContent = result.inserted || 0;
    document.getElementById("import-skipped").textContent = result.skipped || 0;
    document.getElementById("import-errors").textContent = result.errors || 0;

    showToast("Importação concluída", "success");
    await loadClientData(state.selected);
    await loadClients();
  } catch (error) {
    hideLoading();
    console.error("[v0] Failed to import CSV:", error);
    showToast(`Erro na importação: ${error.message}`, "error");
  }
}

// Download CSV Template
function downloadCSVTemplate() {
  const csv = "name,phone,niche\nJoão Silva,11999999999,Tecnologia\nMaria Santos,11988888888,Saúde";
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "modelo_contatos.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// Event Listeners
document.addEventListener("DOMContentLoaded", () => {
  // Inject da aba Config logo no início
  injectConfigTabOnce();

  // Initialize Lucide icons
  const lucide = window.lucide;
  lucide && lucide.createIcons && lucide.createIcons();

  // Refresh button
  document.getElementById("refresh-btn").addEventListener("click", async () => {
    await loadClients();
    if (state.selected) {
      await loadClientData(state.selected);
      await syncSettingsFromServer(state.selected);
    }
  });

  // Client search
  document.getElementById("client-search").addEventListener("input", renderClientList);

  // New client form
  document.getElementById("new-client-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const slug = document.getElementById("new-client-slug").value;
    createClient(slug);
    e.target.reset();
  });

  // Tabs (existentes)
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.tab;
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.addEventListener("click", () => {}); // noop (mantém assinatura)
      tab.classList.add("active");
      document.querySelectorAll(".tab-content").forEach((content) => content.classList.remove("active"));
      document.getElementById(`tab-${tabName}`).classList.add("active");
    });
  });

  // Queue search
  document.getElementById("queue-search").addEventListener("input", (e) => {
    state.queue.search = e.target.value;
    state.queue.page = 1;
    loadQueue();
  });

  // Queue pagination
  document.getElementById("queue-prev").addEventListener("click", () => {
    if (state.queue.page > 1) {
      state.queue.page--;
      loadQueue();
    }
  });
  document.getElementById("queue-next").addEventListener("click", () => {
    const totalPages = Math.ceil(state.queue.total / state.queue.pageSize);
    if (state.queue.page < totalPages) {
      state.queue.page++;
      loadQueue();
    }
  });

  // Totals search
  document.getElementById("totals-search").addEventListener("input", (e) => {
    state.totals.search = e.target.value;
    state.totals.page = 1;
    loadTotals();
  });

  // Totals filter
  document.getElementById("totals-filter").addEventListener("change", (e) => {
    state.totals.sent = e.target.value;
    state.totals.page = 1;
    loadTotals();
  });

  // Totals pagination
  document.getElementById("totals-prev").addEventListener("click", () => {
    if (state.totals.page > 1) {
      state.totals.page--;
      loadTotals();
    }
  });
  document.getElementById("totals-next").addEventListener("click", () => {
    const totalPages = Math.ceil(state.totals.total / state.totals.pageSize);
    if (state.totals.page < totalPages) {
      state.totals.page++;
      loadTotals();
    }
  });

  // Add contact form
  document.getElementById("add-contact-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("contact-name").value;
    const phone = document.getElementById("contact-phone").value;
    const niche = document.getElementById("contact-niche").value;
    addContact(name, phone, niche);
    e.target.reset();
  });

  // CSV file input
  document.getElementById("csv-file").addEventListener("change", (e) => {
    const fileName = e.target.files[0]?.name || "Selecione um arquivo CSV";
    document.getElementById("file-name").textContent = fileName;
  });

  // Import CSV form
  document.getElementById("import-csv-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const file = document.getElementById("csv-file").files[0];
    if (file) importCSV(file);
  });

  // Download template
  document.getElementById("download-template").addEventListener("click", downloadCSVTemplate);

  // Modal controls
  document.getElementById("modal-close").addEventListener("click", () => {
    document.getElementById("queue-action-modal").classList.remove("active");
  });
  document.getElementById("modal-cancel").addEventListener("click", () => {
    document.getElementById("queue-action-modal").classList.remove("active");
  });
  document.getElementById("queue-action-modal").addEventListener("click", (e) => {
    if (e.target.id === "queue-action-modal") e.target.classList.remove("active");
  });

  // Initial load + auto refresh
  loadClients();
  setInterval(loadClients, 10000);

  // Limpa timers ao sair
  window.addEventListener("beforeunload", () => {
    Object.keys(autoTimers).forEach((slug) => stopAutoFor(slug));
  });
});
