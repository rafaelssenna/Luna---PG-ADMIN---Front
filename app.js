/* ==========================================
   Luna – Painel (Dark UI)
   app.js
   ========================================== */

// Base da API (se usar proxy, deixe vazio)
const API_BASE_URL = (window.API_BASE_URL !== undefined ? window.API_BASE_URL : "");

// ---- Timers / Polling ----
const AUTO_INTERVAL_MS = 30000;   // auto-run de loop (cliente com auto habilitado)
const HUD_POLL_MS      = 5000;    // polling leve para KPIs/HUD

const autoTimers = {};            // { [slug]: intervalId }

// ---- Helpers de storage/local ----
function settingsKey(slug){ return `luna_pg_client_settings__${slug}` }
function lastSentKey(slug){ return `luna_pg_last_sent__${slug}` }

function loadLocalSettings(slug){
  try{
    return JSON.parse(localStorage.getItem(settingsKey(slug))) || {
      autoRun:false, iaAuto:false, instanceUrl:"", instanceToken:"",
      instanceAuthHeader:"token", instanceAuthScheme:"", lastRunAt:null
    };
  }catch{
    return { autoRun:false, iaAuto:false, instanceUrl:"", instanceToken:"",
      instanceAuthHeader:"token", instanceAuthScheme:"", lastRunAt:null };
  }
}
function saveLocalSettings(slug, partial){
  const next = { ...loadLocalSettings(slug), ...(partial || {}) };
  localStorage.setItem(settingsKey(slug), JSON.stringify(next));
  return next;
}
function loadLastSent(slug){
  try{ return JSON.parse(localStorage.getItem(lastSentKey(slug))) || null; }catch{ return null; }
}
function saveLastSent(slug, obj){
  try{ localStorage.setItem(lastSentKey(slug), JSON.stringify(obj)); }catch{}
  if (state.selected === slug){ state.lastSent = obj; renderLoopHud(); renderProgressCard(); }
}

// ---- Estado global ----
const state = {
  clients: [],
  selected: null,
  queue:   { items:[], page:1, total:0, pageSize:25, search:"" },
  totals:  { items:[], page:1, total:0, pageSize:25, search:"", sent:"all" },
  kpis:    { totais:0, enviados:0, pendentes:0, fila:0 },
  settings:{ autoRun:false, iaAuto:false, instanceUrl:"", instanceToken:"",
             instanceAuthHeader:"token", instanceAuthScheme:"", lastRunAt:null, loopStatus:"idle" },
  lastSent: null,     // { name, phone, at }
  hudTimer: null,     // polling do HUD
  pendingQueueAction: null // usado no modal de remover
};

// ---- API helper ----
async function api(path, options = {}){
  showLoading();
  try{
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: { "Content-Type":"application/json", ...(options.headers||{}) }
    });
    if(!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return await response.json();
  }catch(err){
    console.error("[API] error:", err);
    showToast(err.message || "Falha de rede", "error");
    throw err;
  }finally{ hideLoading(); }
}

// Polling silencioso (sem overlay/toast)
async function apiSilent(path, options = {}){
  try{
    const r = await fetch(`${API_BASE_URL}${path}`, {
      ...options, headers:{ "Content-Type":"application/json", ...(options.headers||{}) }
    });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }catch{ return null; }
}

// ---- Util ----
function showLoading(){ const el = document.getElementById("loading-overlay"); el && (el.style.display="flex"); }
function hideLoading(){ const el = document.getElementById("loading-overlay"); el && (el.style.display="none"); }

function showToast(msg, type="info"){
  const wrap = document.getElementById("toast-container");
  if(!wrap) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(()=>el.remove(), 4200);
}

function formatDate(iso){
  if(!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
}
function formatShortTime(iso){
  if(!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
}
function escapeAttr(s){ return String(s??"").replace(/"/g,"&quot;"); }
function normalizeSlug(input){
  let slug = String(input||"").trim().toLowerCase();
  if(!slug.startsWith("cliente_")) slug = `cliente_${slug}`;
  if(!/^cliente_[a-z0-9_]+$/.test(slug)) throw new Error("Slug inválido. Use minúsculas, números e _");
  return slug;
}

// ---- Auto-run ----
function startAutoFor(slug){
  stopAutoFor(slug);
  autoTimers[slug] = setInterval(async()=>{
    try{
      const { iaAuto } = loadLocalSettings(slug);
      await api("/api/loop",{ method:"POST", body:JSON.stringify({ client:slug, iaAuto }) });
      if(state.selected===slug){
        state.settings = saveLocalSettings(slug, { lastRunAt:new Date().toISOString() });
        renderSettings();
        await Promise.all([ loadQueue(), loadTotals(), refreshStats(slug) ]);
      }
      await loadClients();
    }catch(e){ console.error("[auto-run]", e); }
  }, AUTO_INTERVAL_MS);
}
function stopAutoFor(slug){
  if(autoTimers[slug]){ clearInterval(autoTimers[slug]); delete autoTimers[slug]; }
}
function applyAutoState(slug){ loadLocalSettings(slug).autoRun ? startAutoFor(slug) : stopAutoFor(slug); }

// ---- Settings no servidor ----
async function loadServerSettings(slug){ return api(`/api/client-settings?client=${slug}`) }
async function saveServerSettings(slug, payload){
  return api(`/api/client-settings`, { method:"POST", body:JSON.stringify({ client:slug, ...payload }) });
}
async function syncSettingsFromServer(slug){
  try{
    const s = await loadServerSettings(slug);
    const next = saveLocalSettings(slug,{
      autoRun:!!s.autoRun, iaAuto:!!s.iaAuto, instanceUrl:s.instanceUrl||"",
      instanceToken:s.instanceToken||"", instanceAuthHeader:s.instanceAuthHeader||"token",
      instanceAuthScheme:s.instanceAuthScheme||"", lastRunAt:s.lastRunAt||null
    });
    state.settings = { ...next, loopStatus: s.loopStatus || "idle" };
  }catch{
    state.settings = loadLocalSettings(slug);
  }
  renderSettings();
  applyAutoState(slug);
  applyHudPolling();
}

// =======================================================
// HUD antigo (mantido/compatível) – mas ficará oculto via CSS
// =======================================================
function injectLoopHudOnce(){
  if(document.getElementById("loop-hud")) return;
  const root = document.querySelector(".client-view"); if(!root) return;
  const w = document.createElement("div"); w.id = "loop-hud-wrapper";
  const hud = document.createElement("div");
  hud.id = "loop-hud";
  hud.className = "loop-hud";
  hud.innerHTML = `
    <div class="hud-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span class="hud-title" style="color:#94a3b8;font-weight:700;font-size:13px">Progresso</span>
      <span class="hud-percent" id="hud-percent" style="font-weight:800">0%</span>
    </div>
    <div class="hud-bar" style="height:10px;border:1px solid #1f2b3b;border-radius:999px;background:#101826;overflow:hidden">
      <div id="hud-bar-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#22c55e,#22a7c5);transition:width .35s ease"></div>
    </div>
    <div class="hud-meta" style="display:flex;justify-content:space-between;margin-top:8px;font-size:13px;color:#94a3b8">
      <span id="hud-last">Último envio: —</span>
      <span id="hud-now"></span>
    </div>`;
  w.appendChild(hud); root.appendChild(w);
}
function renderLoopHud(){
  injectLoopHudOnce();
  const pct  = document.getElementById("hud-percent");
  const fill = document.getElementById("hud-bar-fill");
  const last = document.getElementById("hud-last");
  const now  = document.getElementById("hud-now");
  if(!pct||!fill||!last||!now) return;

  const t = +state.kpis.totais||0, e = +state.kpis.enviados||0;
  const p = t>0 ? Math.round(e*100/t) : 0;
  pct.textContent = `${p}%`; fill.style.width = `${p}%`;

  const k = state.kpis||{};
  const lastPhone = k.last_sent_phone || state.lastSent?.phone || null;
  const lastAt    = k.last_sent_at    || state.lastSent?.at    || null;
  last.textContent = `Último envio: ${ lastPhone ? `${lastPhone} — ${formatShortTime(lastAt)}` : "—" }`;
  now.textContent  = new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
}

// Polling leve do HUD/KPIs
function startHudPolling(){
  stopHudPolling();
  state.hudTimer = setInterval(async()=>{
    if(!state.selected) return;
    const stats = await apiSilent(`/api/stats?client=${state.selected}`);
    if(stats){ state.kpis = { ...state.kpis, ...stats }; renderKPIs(); }
  }, HUD_POLL_MS);
}
function stopHudPolling(){ if(state.hudTimer){ clearInterval(state.hudTimer); state.hudTimer=null; } }
function applyHudPolling(){ (state.settings?.loopStatus==="running") ? startHudPolling() : stopHudPolling(); }

// =======================================================
// NOVO – Cartão de Progresso (fica no grid de KPIs, à direita)
// =======================================================
function injectProgressCardOnce(){
  const grid = document.querySelector(".kpi-grid"); if(!grid) return;
  if(document.getElementById("progress-card")) return;

  const card = document.createElement("div");
  card.id = "progress-card";
  card.className = "kpi-card";
  card.innerHTML = `
    <div class="progress-top">
      <span class="progress-label">Progresso</span>
      <span class="progress-percent" id="progress-percent">0%</span>
    </div>
    <div class="progress-bar-wrapper">
      <div class="progress-bar-fill" id="progress-bar-fill"></div>
    </div>
    <div class="progress-info">
      <div><span class="progress-info-label">Último envio:</span> <span class="progress-last-phone" id="progress-last-phone">—</span></div>
      <div><span class="progress-datetime" id="progress-datetime"></span></div>
    </div>`;
  grid.appendChild(card);
}

function renderProgressCard(){
  injectProgressCardOnce();

  const pctEl   = document.getElementById("progress-percent");
  const barEl   = document.getElementById("progress-bar-fill");
  const phoneEl = document.getElementById("progress-last-phone");
  const dtEl    = document.getElementById("progress-datetime");
  if(!pctEl||!barEl||!phoneEl||!dtEl) return;

  const t = +state.kpis.totais||0, e = +state.kpis.enviados||0;
  const p = t>0 ? Math.round(e*100/t) : 0;
  pctEl.textContent = `${p}%`;
  barEl.style.width = `${p}%`;

  const running = (state.settings?.loopStatus || "idle")==="running";
  barEl.classList.toggle("active", running);

  const k = state.kpis||{};
  const lastPhone = k.last_sent_phone || state.lastSent?.phone || null;
  const lastAt    = k.last_sent_at    || state.lastSent?.at    || null;

  phoneEl.textContent = lastPhone || "—";
  dtEl.textContent    = lastAt ? formatDate(lastAt) : "";
}

// =======================================================
// Aba de Config (cliente) – opcional
// =======================================================
function injectConfigTabOnce(){
  if(document.getElementById("tab-config")) return;
  const tabs = document.querySelector(".tabs");
  const root = document.getElementById("client-view");
  if(!tabs||!root) return;

  const btn = document.createElement("button");
  btn.className="tab"; btn.dataset.tab="config"; btn.textContent="Config";
  tabs.appendChild(btn);

  const content = document.createElement("div");
  content.id="tab-config"; content.className="tab-content";
  content.innerHTML = `
    <div class="form-card">
      <h3>Configurações do Cliente</h3>
      <div class="checkbox-group">
        <label><input type="checkbox" id="auto-run-toggle"> <span>Execução automática do loop</span></label>
      </div>
      <div class="checkbox-group" style="margin-top:8px">
        <label><input type="checkbox" id="ia-auto-toggle"> <span>IA automática</span></label>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label for="instance-url">Instância (URL de envio da IA)</label>
        <input type="url" id="instance-url" placeholder="https://minha-instancia.exemplo/send/text">
      </div>
      <div class="form-group">
        <label for="instance-token">Token da Instância</label>
        <input type="text" id="instance-token" placeholder="cole o token da instância">
      </div>
      <div class="form-group">
        <label for="instance-header">Cabeçalho do Token</label>
        <input type="text" id="instance-header" value="token">
      </div>
      <div class="form-group">
        <label for="instance-scheme">Esquema (opcional)</label>
        <input type="text" id="instance-scheme" placeholder="Bearer (ou deixe vazio)">
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <button class="btn btn-primary" id="save-settings">Salvar</button>
        <button class="btn btn-secondary" id="run-now">Executar Agora</button>
        <button class="btn btn-danger" id="delete-client">Apagar Tabela</button>
        <span id="settings-status" style="color:var(--muted);font-size:.9rem"></span>
      </div>
    </div>
  `;
  document.getElementById("client-view").appendChild(content);

  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c=>c.classList.remove("active"));
    btn.classList.add("active"); content.classList.add("active");
  });

  document.getElementById("save-settings").addEventListener("click", async()=>{
    const payload = {
      autoRun:document.getElementById("auto-run-toggle").checked,
      iaAuto:document.getElementById("ia-auto-toggle").checked,
      instanceUrl:document.getElementById("instance-url").value.trim(),
      instanceToken:document.getElementById("instance-token").value.trim(),
      instanceAuthHeader:document.getElementById("instance-header").value.trim() || "token",
      instanceAuthScheme:document.getElementById("instance-scheme").value.trim()
    };
    try{ await saveServerSettings(state.selected, payload); }catch{}
    state.settings = saveLocalSettings(state.selected, payload);
    renderSettings(); renderProgressCard(); showToast("Configurações salvas","success");
  });

  document.getElementById("run-now").addEventListener("click", ()=> runLoop(state.selected) );

  document.getElementById("delete-client").addEventListener("click", async()=>{
    const slug = state.selected; if(!slug) return;
    if(!confirm(`APAGAR tabelas do cliente ${slug}? Essa ação não pode ser desfeita.`)) return;
    const again = prompt(`Digite o slug para confirmar:\n${slug}`); if(again!==slug) return;
    try{
      await api("/api/delete-client",{ method:"DELETE", body:JSON.stringify({ client:slug }) });
      stopAutoFor(slug); localStorage.removeItem(settingsKey(slug)); localStorage.removeItem(lastSentKey(slug));
      state.selected=null; state.lastSent=null; stopHudPolling(); showToast("Tabelas apagadas","success");
      await loadClients(); document.getElementById("client-view").style.display="none"; document.getElementById("empty-state").style.display="block";
    }catch{ showToast("Falha ao apagar tabelas","error"); }
  });
}

function renderSettings(){
  const a=document.getElementById("auto-run-toggle"),
        i=document.getElementById("ia-auto-toggle"),
        u=document.getElementById("instance-url"),
        t=document.getElementById("instance-token"),
        h=document.getElementById("instance-header"),
        s=document.getElementById("instance-scheme"),
        st=document.getElementById("settings-status");
  if(!a||!i||!st) return;
  const cfg = state.settings || {};
  a.checked=!!cfg.autoRun; i.checked=!!cfg.iaAuto;
  if(u) u.value=cfg.instanceUrl||""; if(t) t.value=cfg.instanceToken||"";
  if(h) h.value=cfg.instanceAuthHeader||"token"; if(s) s.value=cfg.instanceAuthScheme||"";
  st.textContent = `Status: ${cfg.loopStatus||"idle"} | Última execução: ${cfg.lastRunAt?formatDate(cfg.lastRunAt):"-"}`;
}

// =======================================================
// Core – Clients / KPIs / Queue / Totals
// =======================================================
async function loadClients(){
  try{
    const list = await api("/api/clients");
    state.clients = (list||[]).sort((a,b)=>a.slug.localeCompare(b.slug));
    renderClientList();
    if(!state.selected && state.clients.length) selectClient(state.clients[0].slug);
    else if(state.selected) await loadClientData(state.selected);
  }catch(e){ console.error("loadClients",e); }
}

function renderClientList(){
  const container = document.getElementById("client-list");
  const q = (document.getElementById("client-search")?.value || "").toLowerCase();
  const items = state.clients.filter(c => c.slug.toLowerCase().includes(q));
  if(!container) return;
  container.innerHTML = items.length ? items.map(c=>{
    const active = c.slug===state.selected ? "active" : "";
    const badge = (c.queueCount!==undefined) ? `<span class="client-badge">${c.queueCount}</span>` : "";
    const status = c.loopStatus || "idle";
    const dot = `<span class="status-dot status-${status}"></span>`;
    return `
      <div class="client-item ${active}" data-slug="${c.slug}">
        <span class="client-name">${dot}${c.slug}</span>
        <div class="client-actions">
          ${badge}
          <button class="btn-icon run-loop-btn" data-slug="${c.slug}" title="Executar loop">▶</button>
        </div>
      </div>`;
  }).join("") : `<div style="padding:12px;color:var(--muted)">Nenhum cliente</div>`;

  container.querySelectorAll(".client-item").forEach(el=>{
    el.addEventListener("click",()=>selectClient(el.dataset.slug));
  });
  container.querySelectorAll(".run-loop-btn").forEach(btn=>{
    btn.addEventListener("click",(e)=>{ e.stopPropagation(); runLoop(btn.dataset.slug); });
  });
}

async function selectClient(slug){
  state.selected = slug;
  state.queue.page=1; state.queue.search="";
  state.totals.page=1; state.totals.search=""; state.totals.sent="all";

  document.getElementById("empty-state").style.display="none";
  document.getElementById("client-view").style.display="block";
  document.getElementById("client-title").textContent = slug;

  injectLoopHudOnce();
  injectConfigTabOnce();
  injectProgressCardOnce();

  state.lastSent = loadLastSent(slug);
  renderLoopHud(); renderProgressCard();

  await loadClientData(slug);
  await syncSettingsFromServer(slug);
}

async function refreshStats(slug){
  const stats = await api(`/api/stats?client=${slug}`);
  state.kpis = stats||{ totais:0,enviados:0,pendentes:0,fila:0 };
  renderKPIs();
}

async function loadClientData(slug){
  try{
    await refreshStats(slug);
    await loadQueue(); await loadTotals();
  }catch(e){ console.error("loadClientData", e); }
}

function renderKPIs(){
  const totalsEl   = document.getElementById("kpi-totais");
  const enviadosEl = document.getElementById("kpi-enviados");
  const pendEl     = document.getElementById("kpi-pendentes");
  const filaEl     = document.getElementById("kpi-fila");

  if(totalsEl)   totalsEl.textContent   = state.kpis.totais   || 0;
  if(enviadosEl) enviadosEl.textContent = state.kpis.enviados || 0;
  if(pendEl)     pendEl.textContent     = state.kpis.pendentes|| 0;
  if(filaEl)     filaEl.textContent     = state.kpis.fila     || 0;

  renderLoopHud();      // compatibilidade (oculto por CSS)
  renderProgressCard(); // cartão oficial
}

// ---- Queue ----
async function loadQueue(){
  try{
    const { page,pageSize,search } = state.queue;
    const params = new URLSearchParams({ client:state.selected, page, pageSize, search });
    const resp = await api(`/api/queue?${params}`);
    state.queue.items = resp.items || resp || [];
    state.queue.total = resp.total || state.queue.items.length || 0;
    renderQueue();
  }catch(e){ console.error("loadQueue",e); }
}

function renderQueue(){
  const tbody = document.getElementById("queue-table-body");
  if(!tbody) return;
  if(!state.queue.items.length){
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--muted)">Nenhum contato na fila</td></tr>`;
  }else{
    tbody.innerHTML = state.queue.items.map(it=>`
      <tr>
        <td>${it.name||"-"}</td>
        <td>${it.phone||"-"}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-sm btn-primary" data-phone="${escapeAttr(it.phone)}" data-name="${escapeAttr(it.name||"")}"
                    onclick="markAsSentFromBtn(this)">Marcar Enviada</button>
            <button class="btn btn-sm btn-danger" data-phone="${escapeAttr(it.phone)}" data-name="${escapeAttr(it.name||"")}"
                    onclick="removeFromQueueFromBtn(this)">Remover</button>
          </div>
        </td>
      </tr>`).join("");
  }
  const totalPages = Math.ceil((state.queue.total||0) / state.queue.pageSize);
  document.getElementById("queue-page-info").textContent = `Página ${state.queue.page} de ${totalPages||1} (${state.queue.total} itens)`;
  document.getElementById("queue-prev").disabled = state.queue.page<=1;
  document.getElementById("queue-next").disabled = state.queue.page>=totalPages;
}

// ---- Totals (histórico) ----
async function loadTotals(){
  try{
    const { page,pageSize,search,sent } = state.totals;
    const params = new URLSearchParams({ client:state.selected, page, pageSize, search, sent });
    const resp = await api(`/api/totals?${params}`);
    state.totals.items = resp.items || resp || [];
    state.totals.total = resp.total || state.totals.items.length || 0;
    renderTotals();
  }catch(e){ console.error("loadTotals",e); }
}
function renderTotals(){
  const tbody = document.getElementById("totals-table-body");
  if(!tbody) return;
  if(!state.totals.items.length){
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted)">Nenhum registro</td></tr>`;
  }else{
    tbody.innerHTML = state.totals.items.map(it=>`
      <tr>
        <td>${it.name||"-"}</td>
        <td>${it.phone||"-"}</td>
        <td>${it.niche||"-"}</td>
        <td><span class="badge ${it.mensagem_enviada?'success':'pending'}">${it.mensagem_enviada?'Enviado':'Pendente'}</span></td>
        <td>${formatDate(it.updated_at)}</td>
      </tr>`).join("");
  }
  const totalPages = Math.ceil((state.totals.total||0)/state.totals.pageSize);
  document.getElementById("totals-page-info").textContent = `Página ${state.totals.page} de ${totalPages||1} (${state.totals.total} itens)`;
  document.getElementById("totals-prev").disabled = state.totals.page<=1;
  document.getElementById("totals-next").disabled = state.totals.page>=totalPages;
}

// ---- Ações: marcar enviada / remover ----
window.markAsSentFromBtn = async (btn)=>{
  const phone = btn?.dataset?.phone, name = btn?.dataset?.name || "";
  await window.markAsSent(phone, name);
};
window.markAsSent = async (phone, name="")=>{
  try{
    await api("/api/queue",{ method:"DELETE", body:JSON.stringify({ client:state.selected, phone, markSent:true }) });
    saveLastSent(state.selected,{ name, phone, at:new Date().toISOString() });
    showToast("Contato marcado como enviado","success");
    state.totals.sent="all";
    await Promise.all([ loadQueue(), loadTotals(), loadClients(), refreshStats(state.selected) ]);
  }catch(e){ console.error("markAsSent", e); }
};

window.removeFromQueueFromBtn = (btn)=>{
  state.pendingQueueAction = { phone:btn?.dataset?.phone, name:btn?.dataset?.name || "" };
  window.removeFromQueue(state.pendingQueueAction.phone);
};
window.removeFromQueue = (phone)=>{
  const modal=document.getElementById("queue-action-modal");
  const checkboxGroup = document.getElementById("mark-sent-checkbox");
  const checkbox = document.getElementById("mark-as-sent");
  document.getElementById("modal-title").textContent="Remover da Fila";
  document.getElementById("modal-message").textContent="Deseja remover este contato da fila?";
  checkboxGroup.style.display="block"; checkbox.checked=false;
  modal.classList.add("active");

  document.getElementById("modal-confirm").onclick = async ()=>{
    try{
      await api("/api/queue",{ method:"DELETE", body:JSON.stringify({ client:state.selected, phone, markSent:checkbox.checked }) });
      if(checkbox.checked && state.pendingQueueAction && state.pendingQueueAction.phone===phone){
        saveLastSent(state.selected,{ name:state.pendingQueueAction.name||"", phone, at:new Date().toISOString() });
      }
      state.pendingQueueAction=null;
      showToast("Contato removido da fila","success");
      modal.classList.remove("active");
      if(checkbox.checked) state.totals.sent="all";
      await Promise.all([ loadQueue(), loadTotals(), loadClients(), refreshStats(state.selected) ]);
    }catch(e){ console.error("removeFromQueue",e); }
  };
};

// ---- Loop ----
async function runLoop(slug){
  const s = slug || state.selected; if(!s) return;
  try{
    const { iaAuto } = loadLocalSettings(s);
    await api("/api/loop",{ method:"POST", body:JSON.stringify({ client:s, iaAuto }) });
    state.settings = saveLocalSettings(s,{ lastRunAt:new Date().toISOString() });
    try{ const serv = await loadServerSettings(s); state.settings.loopStatus = serv.loopStatus || state.settings.loopStatus; }catch{}
    renderSettings(); renderProgressCard(); applyHudPolling();
    showToast(`Loop iniciado para ${s}`,"success");
    if(state.selected===s){
      await Promise.all([ loadQueue(), loadTotals(), loadClients(), refreshStats(s) ]);
    }else{
      await loadClients();
    }
  }catch(e){ console.error("runLoop",e); }
}

// ---- CRUD simples ----
async function createClient(slug){
  try{
    const normalized = normalizeSlug(slug);
    await api("/api/clients",{ method:"POST", body:JSON.stringify({ slug:normalized }) });
    showToast(`Cliente ${normalized} criado`,"success");
    await loadClients(); selectClient(normalized);
  }catch(e){ console.error("createClient",e); }
}
async function addContact(name, phone, niche){
  try{
    const r = await api("/api/contacts",{ method:"POST", body:JSON.stringify({ client:state.selected, name, phone, niche:niche||null })});
    const msg = ({ inserted:"Contato adicionado", skipped_conflict:"Telefone já existe", skipped_already_known:"Contato já conhecido" })[r.status] || "Contato processado";
    showToast(msg, r.status==="inserted"?"success":"warning");
    if(r.status==="inserted"){ await loadClientData(state.selected); await loadClients(); }
  }catch(e){ console.error("addContact",e); }
}
async function importCSV(file){
  try{
    const fd = new FormData(); fd.append("file", file); fd.append("client", state.selected);
    showLoading();
    const resp = await fetch(`${API_BASE_URL}/api/import`, { method:"POST", body:fd });
    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const r = await resp.json(); hideLoading();
    document.getElementById("import-result").style.display="block";
    document.getElementById("import-inserted").textContent = r.inserted||0;
    document.getElementById("import-skipped").textContent  = r.skipped ||0;
    document.getElementById("import-errors").textContent   = r.errors  ||0;
    showToast("Importação concluída","success");
    await loadClientData(state.selected); await loadClients();
  }catch(e){ hideLoading(); showToast("Erro na importação","error"); console.error("importCSV",e); }
}
function downloadCSVTemplate(){
  const csv = "name,phone,niche\nJoão Silva,11999999999,Tecnologia\nMaria Santos,11988888888,Saúde";
  const blob = new Blob([csv],{type:"text/csv"}); const url = URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download="modelo_contatos.csv"; a.click(); URL.revokeObjectURL(url);
}

// =======================================================
// Boot
// =======================================================
document.addEventListener("DOMContentLoaded", ()=>{
  injectLoopHudOnce();
  injectConfigTabOnce();
  injectProgressCardOnce();

  document.getElementById("refresh-btn")?.addEventListener("click", async()=>{
    await loadClients();
    if(state.selected){ await loadClientData(state.selected); await syncSettingsFromServer(state.selected); renderLoopHud(); applyHudPolling(); }
  });

  document.getElementById("client-search")?.addEventListener("input", renderClientList);
  document.getElementById("new-client-form")?.addEventListener("submit",(e)=>{
    e.preventDefault();
    const slug = document.getElementById("new-client-slug").value;
    createClient(slug); e.target.reset();
  });

  // Queue pagination/search
  document.getElementById("queue-search")?.addEventListener("input",(e)=>{
    state.queue.search = e.target.value; state.queue.page=1; loadQueue();
  });
  document.getElementById("queue-prev")?.addEventListener("click",()=>{ if(state.queue.page>1){ state.queue.page--; loadQueue(); } });
  document.getElementById("queue-next")?.addEventListener("click",()=>{
    const totalPages = Math.ceil((state.queue.total||0)/state.queue.pageSize);
    if(state.queue.page<totalPages){ state.queue.page++; loadQueue(); }
  });

  // Totals filters/pagination
  document.getElementById("totals-search")?.addEventListener("input",(e)=>{
    state.totals.search=e.target.value; state.totals.page=1; loadTotals();
  });
  document.getElementById("totals-filter")?.addEventListener("change",(e)=>{
    state.totals.sent=e.target.value; state.totals.page=1; loadTotals();
  });
  document.getElementById("totals-prev")?.addEventListener("click",()=>{ if(state.totals.page>1){ state.totals.page--; loadTotals(); } });
  document.getElementById("totals-next")?.addEventListener("click",()=>{
    const totalPages = Math.ceil((state.totals.total||0)/state.totals.pageSize);
    if(state.totals.page<totalPages){ state.totals.page++; loadTotals(); }
  });

  // Add contact
  document.getElementById("add-contact-form")?.addEventListener("submit",(e)=>{
    e.preventDefault();
    addContact(
      document.getElementById("contact-name").value,
      document.getElementById("contact-phone").value,
      document.getElementById("contact-niche").value
    );
    e.target.reset();
  });

  // Import CSV
  document.getElementById("csv-file")?.addEventListener("change",(e)=>{
    document.getElementById("file-name").textContent = e.target.files[0]?.name || "Selecione um arquivo CSV";
  });
  document.getElementById("import-csv-form")?.addEventListener("submit",(e)=>{
    e.preventDefault();
    const file = document.getElementById("csv-file").files[0];
    if(file) importCSV(file);
  });
  document.getElementById("download-template")?.addEventListener("click", downloadCSVTemplate);

  // Modal close
  document.getElementById("modal-close")?.addEventListener("click",()=> document.getElementById("queue-action-modal").classList.remove("active"));
  document.getElementById("modal-cancel")?.addEventListener("click",()=> document.getElementById("queue-action-modal").classList.remove("active"));
  document.getElementById("queue-action-modal")?.addEventListener("click",(e)=>{ if(e.target.id==="queue-action-modal") e.target.classList.remove("active"); });

  // Inicializa
  loadClients();
  setInterval(loadClients, 10000);
  window.addEventListener("beforeunload", ()=>{ Object.keys(autoTimers).forEach(stopAutoFor); stopHudPolling(); });
});
