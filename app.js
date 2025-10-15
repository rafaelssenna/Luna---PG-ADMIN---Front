// Updated App.js with HUD reposition and enriched progress info
// Configuration
const API_BASE_URL = (window.API_BASE_URL !== undefined ? window.API_BASE_URL : "");

// ====== Novos: Automação no front ======
const AUTO_INTERVAL_MS = 30000; // 30s
const HUD_POLL_MS = 5000; // 5s para atualizar progresso quando loop estiver "running"
const autoTimers = {}; // { [slug]: intervalId }

function settingsKey(slug) {
  return `luna_pg_client_settings__${slug}`;
}
function lastSentKey(slug) {
  return `luna_pg_last_sent__${slug}`;
}
function loadLastSent(slug) {
  try { return JSON.parse(localStorage.getItem(lastSentKey(slug))) || null; } catch { return null; }
}
function saveLastSent(slug, obj) {
  try { localStorage.setItem(lastSentKey(slug), JSON.stringify(obj)); } catch {}
  if (state.selected === slug) {
    state.lastSent = obj;
    renderLoopHud();
  }
}
function loadLocalSettings(slug) {
  try {
    return JSON.parse(localStorage.getItem(settingsKey(slug))) || {
      autoRun: false,
      iaAuto: false,
      instanceUrl: "",
      instanceToken: "",
      instanceAuthHeader: "token",
      instanceAuthScheme: "",
      lastRunAt: null,
    };
  } catch {
    return {
      autoRun: false,
      iaAuto: false,
      instanceUrl: "",
      instanceToken: "",
      instanceAuthHeader: "token",
      instanceAuthScheme: "",
      lastRunAt: null,
    };
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
      // Se o cliente em execução estiver selecionado, inicializa a UI de progresso
      if (state.selected === slug) {
        initProgress(slug);
        connectProgressStream(slug);
      }
      await api("/api/loop", {
        method: "POST",
        body: JSON.stringify({ client: slug, iaAuto }),
      });
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
  // Novos
  settings: {
    autoRun: false,
    iaAuto: false,
    instanceUrl: "",
    instanceToken: "",
    instanceAuthHeader: "token",
    instanceAuthScheme: "",
    lastRunAt: null,
    loopStatus: "idle",
  },
  lastSent: null, // {name, phone, at}
  hudTimer: null, // polling do HUD
  pendingQueueAction: null, // usado no modal de remover
};

// ====== Progresso em Tempo Real ======
// Fonte SSE de progresso corrente e dados acumulados. Estes
// variáveis globais são usados para controlar a conexão aberta
// com o backend e para armazenar os eventos recebidos, de modo a
// atualizar a UI (barra de progresso e tabela) conforme os envios
// são processados.
let progressSource = null;
const progressData = {
  total: 0,
  processed: 0,
  events: [],
};

/**
 * Inicializa o painel de progresso para o cliente selecionado.
 * Calcula o total a partir do número de itens atualmente na fila
 * (state.kpis.fila) e limpa qualquer progresso anterior. Oculta
 * ou revela o painel dependendo se há itens a processar.
 */
function initProgress(slug) {
  // calcula quantidade de itens a processar; usa fila atual
  const total = Number(state.kpis?.fila || 0);
  progressData.total = total;
  progressData.processed = 0;
  progressData.events = [];
  // limpa tabela e barra
  const tbody = document.getElementById('progress-table-body');
  if (tbody) tbody.innerHTML = '';
  const bar = document.getElementById('progress-bar-fill');
  if (bar) bar.style.width = '0%';
  // mostra ou esconde o painel
  const panel = document.getElementById('progress-panel');
  if (panel) {
    if (total > 0) panel.style.display = 'block';
    else panel.style.display = 'none';
  }
}

/**
 * Atualiza a UI de progresso com um novo evento de envio. Incrementa
 * o contador de processados e ajusta a largura da barra com base no
 * total previamente calculado. Também adiciona uma nova linha na
 * tabela de progresso contendo o nome, telefone e status.
 */
function updateProgressUI(evt) {
  progressData.events.push(evt);
  progressData.processed += 1;
  // Atualiza barra de progresso
  const fill = document.getElementById('progress-bar-fill');
  if (fill && progressData.total > 0) {
    const pct = Math.min(100, Math.round((progressData.processed / progressData.total) * 100));
    fill.style.width = `${pct}%`;
  }
  // Adiciona linha na tabela
  const tbody = document.getElementById('progress-table-body');
  if (tbody) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = evt.name || '-';
    const tdPhone = document.createElement('td');
    tdPhone.textContent = evt.phone || '-';
    const tdStatus = document.createElement('td');
    const span = document.createElement('span');
    let cls = 'status-success';
    if (evt.status === 'error') cls = 'status-error';
    if (evt.status === 'skipped') cls = 'status-skipped';
    span.className = cls;
    span.textContent = evt.status === 'success' ? 'Sucesso' : (evt.status === 'error' ? 'Erro' : 'Ignorado');
    tdStatus.appendChild(span);
    tr.appendChild(tdName);
    tr.appendChild(tdPhone);
    tr.appendChild(tdStatus);
    tbody.appendChild(tr);
    // Desloca scroll para o final para exibir o evento mais recente
    const panel = document.getElementById('progress-panel');
    if (panel) panel.scrollTop = panel.scrollHeight;
  }
  // Se todos os itens foram processados, oculta o painel após breve pausa
  if (progressData.total > 0 && progressData.processed >= progressData.total) {
    setTimeout(() => {
      const p = document.getElementById('progress-panel');
      if (p) p.style.display = 'none';
      // encerra o stream SSE uma vez concluído
      disconnectProgressStream();
    }, 4000);
  }
}

/**
 * Abre uma conexão SSE com o backend para receber eventos de
 * progresso. Se já houver uma conexão aberta, ela será fechada
 * antes de abrir uma nova. A URL inclui o slug do cliente em
 * questão. Cada mensagem recebida é tratada em updateProgressUI.
 */
function connectProgressStream(slug) {
  disconnectProgressStream();
  try {
    const url = `${API_BASE_URL}/api/progress?client=${encodeURIComponent(slug)}`;
    progressSource = new EventSource(url);
    progressSource.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        if (data) updateProgressUI(data);
      } catch (err) {
        console.warn('Falha ao processar evento de progresso:', err);
      }
    };
    progressSource.onerror = () => {
      // Em caso de erro, encerramos a conexão para evitar loops
      disconnectProgressStream();
    };
  } catch (err) {
    console.warn('SSE não suportado ou erro ao conectar', err);
  }
}

/**
 * Fecha a conexão SSE existente (caso exista) e oculta o painel
 * de progresso. Deve ser chamado quando o loop termina ou
 * quando o usuário troca de cliente.
 */
function disconnectProgressStream() {
  if (progressSource) {
    try { progressSource.close(); } catch {}
    progressSource = null;
  }
  const panel = document.getElementById('progress-panel');
  if (panel) panel.style.display = 'none';
}

// ====== API Helpers ======
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
// Versão silenciosa (não mostra overlay nem toast) — para polling do HUD
async function apiSilent(path, options = {}) {
  try {
    const url = `${API_BASE_URL}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return await response.json();
  } catch (err) {
    // silencioso, apenas loga
    console.debug("[silent] API error:", err.message);
    return null;
  }
}

// ====== Configurações no Servidor ======
async function loadServerSettings(slug) {
  return api(`/api/client-settings?client=${slug}`);
}
async function saveServerSettings(slug, { autoRun, iaAuto, instanceUrl, instanceToken, instanceAuthHeader, instanceAuthScheme }) {
  return api(`/api/client-settings`, {
    method: "POST",
    body: JSON.stringify({
      client: slug,
      autoRun: !!autoRun,
      iaAuto: !!iaAuto,
      instanceUrl: instanceUrl || null,
      instanceToken: instanceToken || null,
      instanceAuthHeader: (instanceAuthHeader || "token"),
      instanceAuthScheme: (instanceAuthScheme ?? ""),
    }),
  });
}
async function syncSettingsFromServer(slug) {
  try {
    const s = await loadServerSettings(slug);
    const next = saveLocalSettings(slug, {
      autoRun: !!s.autoRun,
      iaAuto: !!s.iaAuto,
      instanceUrl: s.instanceUrl || "",
      instanceToken: s.instanceToken || "",
      instanceAuthHeader: s.instanceAuthHeader || "token",
      instanceAuthScheme: s.instanceAuthScheme || "",
      lastRunAt: s.lastRunAt || null,
    });
    state.settings = { ...next, loopStatus: s.loopStatus || "idle" };
    renderSettings();
    applyAutoState(slug);
    applyHudPolling(); // iniciar/parar polling do HUD conforme status
  } catch (e) {
    state.settings = loadLocalSettings(slug);
    renderSettings();
    applyAutoState(slug);
    applyHudPolling();
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
function formatShortTime(dateString) {
  if (!dateString) return "-";
  const date = new Date(dateString);
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}

// ====== NOVOS: HUD do Loop (integrado ao cartão "Enviados") ======
/**
 * Insere dinamicamente uma barra de progresso dentro do cartão de KPI
 * “Enviados”. A HUD flutuante anterior foi descontinuada em favor
 * desta implementação integrada. Esta função procura o elemento
 * #kpi-enviados e injeta um bloco .kpi-progress contendo a barra
 * de progresso, o texto X/Y e a hora do último envio. Caso a
 * barra já exista, não fará nada.
 */
function injectLoopHudOnce() {
  // localiza o valor de KPI “Enviados”
  const kpiValue = document.getElementById("kpi-enviados");
  if (!kpiValue) return;
  // encontra o cartão pai
  const card = kpiValue.closest(".kpi-card");
  if (!card) return;
  // se já houver uma barra de progresso, evita duplicar
  if (card.querySelector(".kpi-progress")) return;
  // cria a estrutura de progresso
  const progress = document.createElement("div");
  progress.className = "kpi-progress";
  progress.innerHTML = `
    <div class="progress-bar"><div class="progress-fill" id="kpi-progress-fill"></div></div>
    <div class="progress-info">
      <span id="kpi-progress-text">0/0</span>
      <span id="kpi-last-time">—</span>
    </div>
  `;
  card.appendChild(progress);
}

/**
 * Atualiza a barra de progresso embutida com os valores atuais de
 * totais e enviados. Também atualiza o texto do último envio.
 */
function renderLoopHud() {
  injectLoopHudOnce();
  const fillEl = document.getElementById("kpi-progress-fill");
  const textEl = document.getElementById("kpi-progress-text");
  const lastEl = document.getElementById("kpi-last-time");
  if (!fillEl || !textEl || !lastEl) return;

  const totais = Number(state.kpis.totais || 0);
  const enviados = Number(state.kpis.enviados || 0);
  const progress = totais > 0 ? Math.round((enviados / totais) * 100) : 0;

  // ajusta a largura da barra e o texto X/Y
  fillEl.style.width = `${progress}%`;
  textEl.textContent = `${enviados}/${totais}`;

  // formata a data do último envio
  const k = state.kpis || {};
  const lastAt = k.last_sent_at || state.lastSent?.at || null;
  if (lastAt) {
    lastEl.textContent = formatDate(lastAt);
  } else {
    lastEl.textContent = "—";
  }
}

function startHudPolling() {
  stopHudPolling();
  state.hudTimer = setInterval(async () => {
    try {
      if (!state.selected) return;
      const stats = await apiSilent(`/api/stats?client=${state.selected}`);
      if (stats) {
        // Se o backend já enviar last_sent_*, usamos
        state.kpis = { ...state.kpis, ...stats };
        renderKPIs(); // mantém KPIs sincronizados
      }
      renderLoopHud();
    } catch (e) {
      console.debug("HUD polling erro:", e?.message || e);
    }
  }, HUD_POLL_MS);
}
function stopHudPolling() {
  if (state.hudTimer) {
    clearInterval(state.hudTimer);
    state.hudTimer = null;
  }
}
function applyHudPolling() {
  const running = (state.settings?.loopStatus || "idle") === "running";
  if (running) startHudPolling();
  else stopHudPolling();
}

// ====== NOVOS: Aba Config (injetada) ======
function injectConfigTabOnce() {
  if (document.querySelector('.tab[data-tab="config"]') && document.getElementById("tab-config")) {
    return;
  }

  const tabs = document.querySelector(".tabs");
  const clientView = document.getElementById("client-view");
  if (!tabs || !clientView) return;

  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.tab = "config";
  btn.innerHTML = `<i data-lucide="settings"></i>Config`;
  tabs.appendChild(btn);

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
        <input type="url" id="instance-url" placeholder="https://minha-instancia.exemplo/send/text">
      </div>

      <div class="form-group" style="margin-top:.5rem;">
        <label for="instance-token">Token da Instância</label>
        <input type="text" id="instance-token" placeholder="cole o token da instância aqui">
      </div>

      <div class="form-group" style="margin-top:.5rem;">
        <label for="instance-header">Cabeçalho do Token</label>
        <input type="text" id="instance-header" placeholder="token ou Authorization" value="token">
      </div>

      <div class="form-group" style="margin-top:.5rem;">
        <label for="instance-scheme">Esquema (opcional)</label>
        <input type="text" id="instance-scheme" placeholder="Bearer (ou deixe vazio)">
      </div>

      <div style="margin-top:1rem; display:flex; gap:.5rem; align-items:center; flex-wrap: wrap;">
        <button id="save-settings" class="btn btn-primary">
          <i data-lucide="save"></i>
          <span>Salvar</span>
        </button>
        <button id="run-now" class="btn btn-secondary">
          <i data-lucide="play-circle"></i>
          <span>Executar Agora</span>
        </button>
        <button id="delete-client" class="btn btn-danger" title="Apagar tabelas e configurações deste cliente">
          <i data-lucide="trash-2"></i>
          <span>Apagar Tabela</span>
        </button>
        <span id="settings-status" style="color: var(--muted); font-size:.9rem; margin-left:.25rem;"></span>
      </div>
    </div>
  `;
  clientView.appendChild(content);

  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    document.getElementById("tab-config").classList.add("active");
  });

  document.getElementById("save-settings").addEventListener("click", async () => {
    const values = {
      autoRun: document.getElementById("auto-run-toggle").checked,
      iaAuto: document.getElementById("ia-auto-toggle").checked,
      instanceUrl: document.getElementById("instance-url").value.trim(),
      instanceToken: document.getElementById("instance-token").value.trim(),
      instanceAuthHeader: document.getElementById("instance-header").value.trim() || "token",
      instanceAuthScheme: document.getElementById("instance-scheme").value.trim(),
    };
    try { await saveServerSettings(state.selected, values); } catch {}
    const next = saveLocalSettings(state.selected, values);
    state.settings = next;
    applyAutoState(state.selected);
    renderSettings();
    renderLoopHud();
    applyHudPolling();
    showToast("Configurações salvas", "success");
  });

  document.getElementById("run-now").addEventListener("click", () => {
    runLoop(state.selected);
  });

  // Botão Apagar Tabela (com dupla confirmação e limpeza do estado local)
  document.getElementById("delete-client").addEventListener("click", async () => {
    try {
      const slug = state.selected;
      if (!slug) return;

      const confirm1 = window.confirm(
        `Tem certeza que deseja APAGAR as tabelas "${slug}" e "${slug}_totais" e remover as configurações deste cliente?\n\n` +
        `Esta ação NÃO pode ser desfeita.`
      );
      if (!confirm1) return;

      const typed = window.prompt(`Para confirmar, digite o slug do cliente exatamente como abaixo:\n\n${slug}`);
      if (typed !== slug) {
        showToast("Confirmação cancelada.", "warning");
        return;
      }

      await api("/api/delete-client", {
        method: "DELETE",
        body: JSON.stringify({ client: slug }),
      });

      // Limpa estado local e timers
      stopAutoFor(slug);
      localStorage.removeItem(settingsKey(slug));
      localStorage.removeItem(lastSentKey(slug));
      state.lastSent = null;
      stopHudPolling();

      showToast(`Tabelas de ${slug} apagadas com sucesso`, "success");

      // Recarrega clientes e seleciona outro (ou mostra vazio)
      await loadClients();
      if (state.clients.length > 0) {
        selectClient(state.clients[0].slug);
      } else {
        state.selected = null;
        document.getElementById("client-view").style.display = "none";
        document.getElementById("empty-state").style.display = "block";
      }
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("HTTP 409")) {
        showToast("Não é possível apagar enquanto o loop está em execução. Tente novamente em instantes.", "warning");
      } else {
        showToast("Falha ao apagar as tabelas do cliente", "error");
      }
      console.error("delete-client error:", e);
    }
  });

  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

function renderSettings() {
  const autoEl = document.getElementById("auto-run-toggle");
  const iaEl = document.getElementById("ia-auto-toggle");
  const instanceEl = document.getElementById("instance-url");
  const tokenEl = document.getElementById("instance-token");
  const headerEl = document.getElementById("instance-header");
  const schemeEl = document.getElementById("instance-scheme");
  const statusEl = document.getElementById("settings-status");
  if (!autoEl || !iaEl || !statusEl) return;

  const cfg = state.settings || {
    autoRun: false, iaAuto: false, instanceUrl: "",
    instanceToken: "", instanceAuthHeader: "token", instanceAuthScheme: "",
    lastRunAt: null, loopStatus: "idle"
  };

  autoEl.checked = !!cfg.autoRun;
  iaEl.checked = !!cfg.iaAuto;
  if (instanceEl) instanceEl.value = cfg.instanceUrl || "";
  if (tokenEl) tokenEl.value = cfg.instanceToken || "";
  if (headerEl) headerEl.value = (cfg.instanceAuthHeader || "token");
  if (schemeEl) schemeEl.value = (cfg.instanceAuthScheme || "");

  const last = cfg.lastRunAt ? formatDate(cfg.lastRunAt) : "-";
  const st = cfg.loopStatus || "idle";
  statusEl.textContent = `Status: ${st} | Última execução: ${last}`;
}
// ==========================================

// Inicia o loop de processamento para um cliente
async function runLoop(clientSlug) {
  try {
    const slug = clientSlug || state.selected;
    if (!slug) throw new Error("Nenhum cliente selecionado");
    const { iaAuto } = loadLocalSettings(slug);
    // Antes de iniciar o loop no backend, inicializa a UI de progresso e abre o stream SSE
    initProgress(slug);
    connectProgressStream(slug);

    await api("/api/loop", {
      method: "POST",
      body: JSON.stringify({ client: slug, iaAuto }),
    });
    const iso = new Date().toISOString();
    state.settings = saveLocalSettings(slug, { lastRunAt: iso });
    try {
      const serv = await loadServerSettings(slug);
      state.settings = { ...state.settings, loopStatus: serv.loopStatus || state.settings.loopStatus || "idle" };
    } catch {}
    renderSettings();
    renderLoopHud();
    applyHudPolling();

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

  container.querySelectorAll(".client-item").forEach((item) => {
    item.addEventListener("click", () => {
      selectClient(item.dataset.slug);
    });
  });
  container.querySelectorAll(".run-loop-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slug = btn.dataset.slug;
      runLoop(slug);
    });
  });
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

// Select Client
async function selectClient(slug) {
  // Ao selecionar um novo cliente, encerra qualquer conexão SSE ativa
  disconnectProgressStream();
  state.selected = slug;

  state.queue.page = 1;
  state.queue.search = "";
  state.totals.page = 1;
  state.totals.search = "";
  state.totals.sent = "all";

  renderClientList();
  document.getElementById("empty-state").style.display = "none";
  document.getElementById("client-view").style.display = "block";
  document.getElementById("client-title").textContent = slug;

  document.getElementById("queue-search").value = "";
  document.getElementById("totals-search").value = "";
  document.getElementById("totals-filter").value = "all";

  injectLoopHudOnce();
  injectConfigTabOnce();

  state.lastSent = loadLastSent(slug);
  renderLoopHud();

  await loadClientData(slug);
  await syncSettingsFromServer(slug);
  applyHudPolling();
}

// Load Client Data
async function loadClientData(slug) {
  try {
    const stats = await api(`/api/stats?client=${slug}`);
    state.kpis = stats;
    renderKPIs();
    renderLoopHud();

    await loadQueue();
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
  if (pendEl) pendEl.textContent = state.kpis.pendentes || 0;
  if (filaEl) filaEl.textContent = state.kpis.fila || 0;

  renderLoopHud(); // mantém HUD coerente com KPIs
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
      .map((item) => `
      <tr>
        <td>${item.name || "-"}</td>
        <td>${item.phone || "-"}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-sm btn-primary"
                    data-phone="${escapeAttr(item.phone)}"
                    data-name="${escapeAttr(item.name || "")}"
                    onclick="markAsSentFromBtn(this)">
              <i data-lucide="check"></i>
              Marcar Enviada
            </button>
            <button class="btn btn-sm btn-danger"
                    data-phone="${escapeAttr(item.phone)}"
                    data-name="${escapeAttr(item.name || "")}"
                    onclick="removeFromQueueFromBtn(this)">
              <i data-lucide="trash-2"></i>
              Remover
            </button>
          </div>
        </td>
      </tr>
    `)
      .join("");
  }

  const totalPages = Math.ceil(state.queue.total / state.queue.pageSize);
  document.getElementById("queue-page-info").textContent = `Página ${state.queue.page} de ${totalPages || 1} (${state.queue.total} itens)`;
  document.getElementById("queue-prev").disabled = state.queue.page === 1;
  document.getElementById("queue-next").disabled = state.queue.page >= totalPages;

  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
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

// ====== Ações de Fila (atualizadas para salvar "Último envio") ======
window.markAsSentFromBtn = async (btn) => {
  const phone = btn?.dataset?.phone;
  const name = btn?.dataset?.name || "";
  await window.markAsSent(phone, name);
};

window.markAsSent = async (phone, name = "") => {
  try {
    await api("/api/queue", {
      method: "DELETE",
      body: JSON.stringify({ client: state.selected, phone, markSent: true }),
    });

    // Salva "Último envio" localmente (fallback até o backend devolver isso)
    saveLastSent(state.selected, { name, phone, at: new Date().toISOString() });

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

// Modal de Remover (mantido) + integração com "Último envio" quando checkbox marcado
window.removeFromQueueFromBtn = (btn) => {
  const phone = btn?.dataset?.phone;
  const name = btn?.dataset?.name || "";
  state.pendingQueueAction = { phone, name };
  window.removeFromQueue(phone);
};

// Remove from Queue (abre modal)
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

      // Se marcou "enviada", salva "Último envio" com fallback local
      if (checkbox.checked && state.pendingQueueAction && state.pendingQueueAction.phone === phone) {
        saveLastSent(state.selected, {
          name: state.pendingQueueAction.name || "",
          phone,
          at: new Date().toISOString(),
        });
      }
      state.pendingQueueAction = null;

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
  injectLoopHudOnce();
  injectConfigTabOnce();

  const lucide = window.lucide;
  lucide && lucide.createIcons && lucide.createIcons();

  document.getElementById("refresh-btn").addEventListener("click", async () => {
    await loadClients();
    if (state.selected) {
      await loadClientData(state.selected);
      await syncSettingsFromServer(state.selected);
      renderLoopHud();
      applyHudPolling();
    }
  });

  document.getElementById("client-search").addEventListener("input", renderClientList);

  document.getElementById("new-client-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const slug = document.getElementById("new-client-slug").value;
    createClient(slug);
    e.target.reset();
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.tab;
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.addEventListener("click", () => {});
      tab.classList.add("active");
      document.querySelectorAll(".tab-content").forEach((content) => content.classList.remove("active"));
      document.getElementById(`tab-${tabName}`).classList.add("active");
    });
  });

  document.getElementById("queue-search").addEventListener("input", (e) => {
    state.queue.search = e.target.value;
    state.queue.page = 1;
    loadQueue();
  });

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

  document.getElementById("totals-search").addEventListener("input", (e) => {
    state.totals.search = e.target.value;
    state.totals.page = 1;
    loadTotals();
  });

  document.getElementById("totals-filter").addEventListener("change", (e) => {
    state.totals.sent = e.target.value;
    state.totals.page = 1;
    loadTotals();
  });

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

  document.getElementById("add-contact-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("contact-name").value;
    const phone = document.getElementById("contact-phone").value;
    const niche = document.getElementById("contact-niche").value;
    addContact(name, phone, niche);
    e.target.reset();
  });

  document.getElementById("csv-file").addEventListener("change", (e) => {
    const fileName = e.target.files[0]?.name || "Selecione um arquivo CSV";
    document.getElementById("file-name").textContent = fileName;
  });

  document.getElementById("import-csv-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const file = document.getElementById("csv-file").files[0];
    if (file) importCSV(file);
  });

  document.getElementById("download-template").addEventListener("click", downloadCSVTemplate);

  document.getElementById("modal-close").addEventListener("click", () => {
    document.getElementById("queue-action-modal").classList.remove("active");
  });
  document.getElementById("modal-cancel").addEventListener("click", () => {
    document.getElementById("queue-action-modal").classList.remove("active");
  });
  document.getElementById("queue-action-modal").addEventListener("click", (e) => {
    if (e.target.id === "queue-action-modal") e.target.classList.remove("active");
  });

  loadClients();
  setInterval(loadClients, 10000);

  window.addEventListener("beforeunload", () => {
    Object.keys(autoTimers).forEach((slug) => stopAutoFor(slug));
    stopHudPolling();
  });
});
