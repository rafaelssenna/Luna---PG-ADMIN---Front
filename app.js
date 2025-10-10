// Configuration
const API_BASE_URL = "https://luna-pg-admin-back-production.up.railway.app" // Configure your API base URL here (e.g., 'https://your-n8n-instance.com')

// State Management
const state = {
  clients: [],
  selected: null,
  queue: { items: [], page: 1, total: 0, pageSize: 25, search: "" },
  totals: { items: [], page: 1, total: 0, pageSize: 25, search: "", sent: "all" },
  kpis: { totais: 0, enviados: 0, pendentes: 0, fila: 0 },
}

// Utility: API Helper
async function api(path, options = {}) {
  showLoading()
  try {
    const url = `${API_BASE_URL}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json()
    return data
  } catch (error) {
    console.error("[v0] API Error:", error)
    showToast(`Erro: ${error.message}`, "error")
    throw error
  } finally {
    hideLoading()
  }
}

// Utility: Toast Notifications
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container")
  const toast = document.createElement("div")
  toast.className = `toast ${type}`

  const iconMap = {
    success: "check-circle",
    error: "x-circle",
    warning: "alert-circle",
    info: "info",
  }

  toast.innerHTML = `
    <i data-lucide="${iconMap[type]}"></i>
    <span>${message}</span>
  `

  container.appendChild(toast)

  setTimeout(() => {
    toast.style.animation = "slideIn 0.3s ease reverse"
    setTimeout(() => toast.remove(), 300)
  }, 4000)
}

// Utility: Loading Overlay
function showLoading() {
  document.getElementById("loading-overlay").style.display = "flex"
}

function hideLoading() {
  document.getElementById("loading-overlay").style.display = "none"
}

// Utility: Normalize Client Slug
function normalizeSlug(input) {
  let slug = input.trim().toLowerCase()

  // Add 'cliente_' prefix if not present
  if (!slug.startsWith("cliente_")) {
    slug = `cliente_${slug}`
  }

  // Validate format
  const validPattern = /^cliente_[a-z0-9_]+$/
  if (!validPattern.test(slug)) {
    throw new Error("Slug inválido. Use apenas letras minúsculas, números e underscores.")
  }

  return slug
}

// Utility: Format Date
function formatDate(dateString) {
  if (!dateString) return "-"
  const date = new Date(dateString)
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

// Load Clients
async function loadClients() {
  try {
    const clients = await api("/api/clients")
    state.clients = clients.sort((a, b) => a.slug.localeCompare(b.slug))
    renderClientList()

    // Auto-select first client if none selected
    if (!state.selected && state.clients.length > 0) {
      selectClient(state.clients[0].slug)
    } else if (state.selected) {
      // Refresh current client data
      await loadClientData(state.selected)
    }
  } catch (error) {
    console.error("[v0] Failed to load clients:", error)
  }
}

// Render Client List
function renderClientList() {
  const container = document.getElementById("client-list")
  const searchTerm = document.getElementById("client-search").value.toLowerCase()

  const filteredClients = state.clients.filter((client) => client.slug.toLowerCase().includes(searchTerm))

  if (filteredClients.length === 0) {
    container.innerHTML =
      '<div style="padding: 1rem; text-align: center; color: var(--muted);">Nenhum cliente encontrado</div>'
    return
  }

  container.innerHTML = filteredClients
    .map(
      (client) => `
    <div class="client-item ${state.selected === client.slug ? "active" : ""}" 
         data-slug="${client.slug}"
         role="listitem">
      <span class="client-name">${client.slug}</span>
      ${client.queueCount !== undefined ? `<span class="client-badge">${client.queueCount}</span>` : ""}
    </div>
  `,
    )
    .join("")

  // Add click handlers
  container.querySelectorAll(".client-item").forEach((item) => {
    item.addEventListener("click", () => {
      selectClient(item.dataset.slug)
    })
  })
}

// Select Client
async function selectClient(slug) {
  state.selected = slug

  // Reset pagination
  state.queue.page = 1
  state.queue.search = ""
  state.totals.page = 1
  state.totals.search = ""
  state.totals.sent = "all"

  // Update UI
  renderClientList()
  document.getElementById("empty-state").style.display = "none"
  document.getElementById("client-view").style.display = "block"
  document.getElementById("client-title").textContent = slug

  // Clear search inputs
  document.getElementById("queue-search").value = ""
  document.getElementById("totals-search").value = ""
  document.getElementById("totals-filter").value = "all"

  // Load client data
  await loadClientData(slug)
}

// Load Client Data
async function loadClientData(slug) {
  try {
    // Load KPIs
    const stats = await api(`/api/stats?client=${slug}`)
    state.kpis = stats
    renderKPIs()

    // Load Queue
    await loadQueue()

    // Load Totals
    await loadTotals()
  } catch (error) {
    console.error("[v0] Failed to load client data:", error)
  }
}

// Render KPIs
function renderKPIs() {
  document.getElementById("kpi-totais").textContent = state.kpis.totais || 0
  document.getElementById("kpi-enviados").textContent = state.kpis.enviados || 0
  document.getElementById("kpi-pendentes").textContent = state.kpis.pendentes || 0
  document.getElementById("kpi-fila").textContent = state.kpis.fila || 0
}

// Load Queue
async function loadQueue() {
  try {
    const { page, pageSize, search } = state.queue
    const params = new URLSearchParams({
      client: state.selected,
      page,
      pageSize,
      search,
    })

    const response = await api(`/api/queue?${params}`)
    state.queue.items = response.items || response
    state.queue.total = response.total || response.length || 0

    renderQueue()
  } catch (error) {
    console.error("[v0] Failed to load queue:", error)
  }
}

// Render Queue
function renderQueue() {
  const tbody = document.getElementById("queue-table-body")

  if (state.queue.items.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="3" style="text-align: center; color: var(--muted);">Nenhum contato na fila</td></tr>'
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
    `,
      )
      .join("")
  }

  // Update pagination
  const totalPages = Math.ceil(state.queue.total / state.queue.pageSize)
  document.getElementById("queue-page-info").textContent =
    `Página ${state.queue.page} de ${totalPages || 1} (${state.queue.total} itens)`

  document.getElementById("queue-prev").disabled = state.queue.page === 1
  document.getElementById("queue-next").disabled = state.queue.page >= totalPages
}

// Load Totals
async function loadTotals() {
  try {
    const { page, pageSize, search, sent } = state.totals
    const params = new URLSearchParams({
      client: state.selected,
      page,
      pageSize,
      search,
      sent,
    })

    const response = await api(`/api/totals?${params}`)
    state.totals.items = response.items || response
    state.totals.total = response.total || response.length || 0

    renderTotals()
  } catch (error) {
    console.error("[v0] Failed to load totals:", error)
  }
}

// Render Totals
function renderTotals() {
  const tbody = document.getElementById("totals-table-body")

  if (state.totals.items.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" style="text-align: center; color: var(--muted);">Nenhum registro encontrado</td></tr>'
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
    `,
      )
      .join("")
  }

  // Update pagination
  const totalPages = Math.ceil(state.totals.total / state.totals.pageSize)
  document.getElementById("totals-page-info").textContent =
    `Página ${state.totals.page} de ${totalPages || 1} (${state.totals.total} itens)`

  document.getElementById("totals-prev").disabled = state.totals.page === 1
  document.getElementById("totals-next").disabled = state.totals.page >= totalPages
}

// Mark as Sent
window.markAsSent = async (phone) => {
  try {
    await api("/api/queue", {
      method: "DELETE",
      body: JSON.stringify({
        client: state.selected,
        phone,
      }),
    })

    showToast("Contato marcado como enviado", "success")

    // Reload data
    await loadClientData(state.selected)
    await loadClients() // Update queue counts
  } catch (error) {
    console.error("[v0] Failed to mark as sent:", error)
  }
}

// Remove from Queue
window.removeFromQueue = (phone) => {
  const modal = document.getElementById("queue-action-modal")
  const checkboxGroup = document.getElementById("mark-sent-checkbox")
  const checkbox = document.getElementById("mark-as-sent")

  document.getElementById("modal-title").textContent = "Remover da Fila"
  document.getElementById("modal-message").textContent = "Deseja remover este contato da fila?"

  checkboxGroup.style.display = "block"
  checkbox.checked = false

  modal.classList.add("active")

  // Set confirm handler
  const confirmBtn = document.getElementById("modal-confirm")
  confirmBtn.onclick = async () => {
    try {
      await api("/api/queue", {
        method: "DELETE",
        body: JSON.stringify({
          client: state.selected,
          phone,
          markSent: checkbox.checked,
        }),
      })

      showToast("Contato removido da fila", "success")
      modal.classList.remove("active")

      // Reload data
      await loadClientData(state.selected)
      await loadClients()
    } catch (error) {
      console.error("[v0] Failed to remove from queue:", error)
    }
  }
}

// Create Client
async function createClient(slug) {
  try {
    const normalizedSlug = normalizeSlug(slug)

    await api("/api/clients", {
      method: "POST",
      body: JSON.stringify({ slug: normalizedSlug }),
    })

    showToast(`Cliente ${normalizedSlug} criado com sucesso`, "success")

    // Reload clients and select new one
    await loadClients()
    selectClient(normalizedSlug)
  } catch (error) {
    console.error("[v0] Failed to create client:", error)
  }
}

// Add Contact
async function addContact(name, phone, niche) {
  try {
    const response = await api("/api/contacts", {
      method: "POST",
      body: JSON.stringify({
        client: state.selected,
        name,
        phone,
        niche: niche || null,
      }),
    })

    const statusMessages = {
      inserted: "Contato adicionado com sucesso",
      skipped_conflict: "Contato já existe (conflito de telefone)",
      skipped_already_known: "Contato já conhecido no histórico",
    }

    const message = statusMessages[response.status] || "Contato processado"
    const type = response.status === "inserted" ? "success" : "warning"

    showToast(message, type)

    // Reload data if inserted
    if (response.status === "inserted") {
      await loadClientData(state.selected)
      await loadClients()
    }
  } catch (error) {
    console.error("[v0] Failed to add contact:", error)
  }
}

// Import CSV
async function importCSV(file) {
  try {
    const formData = new FormData()
    formData.append("file", file)
    formData.append("client", state.selected)

    showLoading()
    const response = await fetch(`${API_BASE_URL}/api/import`, {
      method: "POST",
      body: formData,
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const result = await response.json()
    hideLoading()

    // Show results
    document.getElementById("import-result").style.display = "block"
    document.getElementById("import-inserted").textContent = result.inserted || 0
    document.getElementById("import-skipped").textContent = result.skipped || 0
    document.getElementById("import-errors").textContent = result.errors || 0

    showToast("Importação concluída", "success")

    // Reload data
    await loadClientData(state.selected)
    await loadClients()
  } catch (error) {
    hideLoading()
    console.error("[v0] Failed to import CSV:", error)
    showToast(`Erro na importação: ${error.message}`, "error")
  }
}

// Download CSV Template
function downloadCSVTemplate() {
  const csv = "name,phone,niche\nJoão Silva,11999999999,Tecnologia\nMaria Santos,11988888888,Saúde"
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = "modelo_contatos.csv"
  a.click()
  URL.revokeObjectURL(url)
}

// Event Listeners
document.addEventListener("DOMContentLoaded", () => {
  // Initialize Lucide icons
  const lucide = window.lucide // Declare the lucide variable
  lucide.createIcons()

  // Refresh button
  document.getElementById("refresh-btn").addEventListener("click", loadClients)

  // Client search
  document.getElementById("client-search").addEventListener("input", renderClientList)

  // New client form
  document.getElementById("new-client-form").addEventListener("submit", (e) => {
    e.preventDefault()
    const slug = document.getElementById("new-client-slug").value
    createClient(slug)
    e.target.reset()
  })

  // Tabs
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.tab

      // Update active tab
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"))
      tab.classList.add("active")

      // Update active content
      document.querySelectorAll(".tab-content").forEach((content) => {
        content.classList.remove("active")
      })
      document.getElementById(`tab-${tabName}`).classList.add("active")
    })
  })

  // Queue search
  document.getElementById("queue-search").addEventListener("input", (e) => {
    state.queue.search = e.target.value
    state.queue.page = 1
    loadQueue()
  })

  // Queue pagination
  document.getElementById("queue-prev").addEventListener("click", () => {
    if (state.queue.page > 1) {
      state.queue.page--
      loadQueue()
    }
  })

  document.getElementById("queue-next").addEventListener("click", () => {
    const totalPages = Math.ceil(state.queue.total / state.queue.pageSize)
    if (state.queue.page < totalPages) {
      state.queue.page++
      loadQueue()
    }
  })

  // Totals search
  document.getElementById("totals-search").addEventListener("input", (e) => {
    state.totals.search = e.target.value
    state.totals.page = 1
    loadTotals()
  })

  // Totals filter
  document.getElementById("totals-filter").addEventListener("change", (e) => {
    state.totals.sent = e.target.value
    state.totals.page = 1
    loadTotals()
  })

  // Totals pagination
  document.getElementById("totals-prev").addEventListener("click", () => {
    if (state.totals.page > 1) {
      state.totals.page--
      loadTotals()
    }
  })

  document.getElementById("totals-next").addEventListener("click", () => {
    const totalPages = Math.ceil(state.totals.total / state.totals.pageSize)
    if (state.totals.page < totalPages) {
      state.totals.page++
      loadTotals()
    }
  })

  // Add contact form
  document.getElementById("add-contact-form").addEventListener("submit", (e) => {
    e.preventDefault()
    const name = document.getElementById("contact-name").value
    const phone = document.getElementById("contact-phone").value
    const niche = document.getElementById("contact-niche").value

    addContact(name, phone, niche)
    e.target.reset()
  })

  // CSV file input
  document.getElementById("csv-file").addEventListener("change", (e) => {
    const fileName = e.target.files[0]?.name || "Selecione um arquivo CSV"
    document.getElementById("file-name").textContent = fileName
  })

  // Import CSV form
  document.getElementById("import-csv-form").addEventListener("submit", (e) => {
    e.preventDefault()
    const file = document.getElementById("csv-file").files[0]
    if (file) {
      importCSV(file)
    }
  })

  // Download template
  document.getElementById("download-template").addEventListener("click", downloadCSVTemplate)

  // Modal controls
  document.getElementById("modal-close").addEventListener("click", () => {
    document.getElementById("queue-action-modal").classList.remove("active")
  })

  document.getElementById("modal-cancel").addEventListener("click", () => {
    document.getElementById("queue-action-modal").classList.remove("active")
  })

  // Close modal on backdrop click
  document.getElementById("queue-action-modal").addEventListener("click", (e) => {
    if (e.target.id === "queue-action-modal") {
      e.target.classList.remove("active")
    }
  })

  // Initial load
  loadClients()

  // Auto-refresh every 10 seconds
  setInterval(loadClients, 10000)
})
