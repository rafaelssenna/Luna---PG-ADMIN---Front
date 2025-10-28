// conversas.js — Supervisão WhatsApp (instância por cliente + hints system/inst + autologin)

/* ====== Helpers de URL/API a partir do querystring ====== */
// ?api=https://backend.com/api  | ?client=cliente_slug | ?autologin=1 | ?system=hint | ?inst=nome/ID
function getApiBase() {
  const qsApi = new URLSearchParams(window.location.search).get("api");
  if (qsApi) {
    try {
      const u = new URL(qsApi, window.location.href);
      if (["http:", "https:"].includes(u.protocol)) {
        return u.toString().replace(/\/+$/, ""); // remove barras finais
      }
    } catch {}
  }
  // fallback: relativo
  return "/api";
}
const API = getApiBase();
const CLIENT_SLUG = new URLSearchParams(location.search).get("client") || "";
const AUTOLOGIN   = /^(1|true|yes)$/i.test(new URLSearchParams(location.search).get("autologin") || "");
const SYSTEM_HINT = (new URLSearchParams(location.search).get("system") || "").trim().toLowerCase();
const INST_HINT   = (new URLSearchParams(location.search).get("inst")   || "").trim().toLowerCase();

/* ====== Utils ====== */
function showAlert(msg, type = "warning", timeout = 6000) {
  const box = document.getElementById("appAlert");
  const txt = document.getElementById("appAlertText");
  if (!box || !txt) return;
  txt.textContent = String(msg);
  box.className = `app-alert ${type}`;
  box.classList.remove("hidden");
  if (timeout > 0) {
    clearTimeout(showAlert._t);
    showAlert._t = setTimeout(() => box.classList.add("hidden"), timeout);
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u, window.location.href);
    if (["http:", "https:"].includes(url.protocol)) return url.toString();
  } catch {}
  return null;
}
function proxifyMedia(u) {
  const url = safeUrl(u);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin === window.location.origin) return url;
    return `${API}/media/proxy?url=${encodeURIComponent(parsed.toString())}`;
  } catch { return url; }
}
function toArray(x) { return Array.isArray(x) ? x : x == null ? [] : [x]; }

function formatTime(ts) {
  if (!ts) return "";
  let ms = Number(ts);
  if (!Number.isFinite(ms)) return String(ts);
  if (ms < 10 ** 12) ms *= 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// Deriva "system" da instance_url (ex.: https://hia-clientes.uazapi.com → "hia-clientes")
function systemNameFromInstanceUrl(u) {
  try {
    const host = new URL(u).hostname || "";
    return (host.split(".")[0] || "").toLowerCase();
  } catch { return ""; }
}

// Polyfill simples para CSS.escape (evita erro em navegadores antigos)
if (!window.CSS) window.CSS = {};
if (typeof window.CSS.escape !== "function") {
  window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_\-]/g, (ch) => "\\" + ch);
}

/* ====== Estado ====== */
const state = {
  screen: "login",              // 'login' | 'instances' | 'chats'
  isAuthenticated: false,

  // instâncias
  instances: [],
  baseInstances: [],            // pré-filtradas por cliente/hints
  filteredInstances: [],
  instanceFilterHint: "",       // hint de system
  currentInstanceId: null,

  // chats
  chats: [],
  filteredChats: [],
  chatPage: 0,
  pageSize: 50,
  currentChatId: null,

  // mobile
  mobileSidebarHidden: false
};

/* ====== Elementos ====== */
const els = {
  appAlert: document.getElementById("appAlert"),
  appAlertText: document.getElementById("appAlertText"),

  // login
  screenLogin: document.getElementById("screen-login"),
  loginForm: document.getElementById("loginForm"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),

  // telas
  screenInstances: document.getElementById("screen-instances"),
  screenWorkspace: document.getElementById("screen-workspace"),

  // instâncias
  instanceList: document.getElementById("instanceList"),
  instanceSearch: document.getElementById("instanceSearch"),
  btnRefresh: document.getElementById("btnRefresh"),
  btnLogout: document.getElementById("btnLogout"),

  // workspace sidebar
  btnBack: document.getElementById("btnBack"),
  sidebarInstanceName: document.getElementById("sidebarInstanceName"),
  sidebarInstanceStatus: document.getElementById("sidebarInstanceStatus"),

  // workspace header
  btnExport: document.getElementById("btnExport"),
  chatSearch: document.getElementById("chatSearch"),

  // export (opcional)
  exportProgress: document.getElementById("exportProgress"),
  exportProgressLabel: document.getElementById("exportProgressLabel"),
  exportProgressBar: document.getElementById("exportProgressBar"),
  exportProgressCounts: document.getElementById("exportProgressCounts"),
  exportProgressPct: document.getElementById("exportProgressPct"),
  exportCancelBtn: document.getElementById("exportCancelBtn"),

  // chats
  chatList: document.getElementById("chatList"),
  nextPage: document.getElementById("nextPage"),
  prevPage: document.getElementById("prevPage"),
  pageInfo: document.getElementById("pageInfo"),

  // mensagens
  messages: document.getElementById("messages"),
  chatTitle: document.getElementById("chatTitle"),
  chatSubtitle: document.getElementById("chatSubtitle"),
};

/* ====== Mobile helpers ====== */
function isSmallScreen() { return window.matchMedia("(max-width: 768px)").matches; }
function getSidebarEl()   { return document.querySelector("#screen-workspace .wa-sidebar"); }
function showSidebarOnMobile() { const sb = getSidebarEl(); if (sb) sb.style.display = ""; state.mobileSidebarHidden = false; }
function hideSidebarOnMobile() { if (!isSmallScreen()) return; const sb = getSidebarEl(); if (sb) sb.style.display = "none"; state.mobileSidebarHidden = true; }
window.addEventListener("resize", () => { if (!isSmallScreen()) showSidebarOnMobile(); });

/* ====== IDs de chat/mensagem ====== */
function getChatId(c) {
  return (
    c?._chatId ||
    c?.wa_chatid ||
    c?.wa_fastid ||
    c?.jid ||
    c?.wa_id ||
    c?.number ||
    c?.id ||
    c?.chatid ||
    c?.wa_jid ||
    ""
  );
}
function getMsgId(m) {
  return (m?.id || m?.msgId || m?.messageId || m?.key?.id || m?.wa_msgid || m?.wa_keyid || m?.wamid || null);
}

/* ====== Status & Avatares ====== */
function isConnected(statusObj) {
  if (statusObj && typeof statusObj.connected !== "undefined") return statusObj.connected === true;
  try {
    const s = JSON.stringify(statusObj || {}).toLowerCase();
    if (s.includes('"connected":true') || s.includes("online")) return true;
  } catch {}
  return false;
}
function resolveInstanceAvatar(inst) {
  return (
    inst?.avatarUrl || inst?.profilePicUrl || inst?.picture || inst?.picUrl || inst?.photoUrl || inst?.imageUrl || inst?.icon || null
  );
}
function resolveChatAvatar(c) {
  return (
    c?.avatarUrl || c?.profilePicUrl || c?.picture || c?.picUrl || c?.photoUrl || c?.wa_profilePicUrl || c?.imageUrl || null
  );
}

/* ====== Mensagens: helpers ====== */
function messageDisplayText(m) {
  // tenta vários campos comuns
  const t =
    m?.text || m?.body || m?.message ||
    (m?.content && typeof m.content === "string" ? m.content : null) ||
    m?.content?.text ||
    m?.caption ||
    "";
  return typeof t === "string" ? t : JSON.stringify(t ?? "");
}
function roleFromMessage(m) {
  const fromMe = m?.fromMe === true || m?.sender?.fromMe === true || m?.me === true || m?.key?.fromMe === true;
  return fromMe ? "user" : "client";
}
function buildMediaHtml(m) {
  // cobre image/audio/video/document por campos comuns
  const media =
    m?.image?.url || m?.video?.url || m?.audio?.url || m?.document?.url ||
    m?.imageUrl || m?.videoUrl || m?.audioUrl || m?.documentUrl ||
    m?.url || m?.mediaUrl;

  if (!media) return "";

  const guessedType =
    m?.image || /image/i.test(m?.mimetype || m?.mime || "") ? "image" :
    m?.video || /video/i.test(m?.mimetype || m?.mime || "") ? "video" :
    m?.audio || /audio/i.test(m?.mimetype || m?.mime || "") ? "audio" :
    "file";

  const src = escapeHtml(proxifyMedia(media));

  if (guessedType === "image") {
    return `<div style="margin-top:6px"><img src="${src}" alt="imagem" style="max-width:380px;border-radius:8px;"/></div>`;
  }
  if (guessedType === "video") {
    return `<div style="margin-top:6px"><video src="${src}" controls style="max-width:420px;border-radius:8px;"></video></div>`;
  }
  if (guessedType === "audio") {
    return `<div style="margin-top:6px"><audio src="${src}" controls></audio></div>`;
  }
  const name = escapeHtml(m?.fileName || m?.filename || "arquivo");
  return `<div style="margin-top:6px"><a class="wa-btn" href="${src}" target="_blank" rel="noopener">Baixar ${name}</a></div>`;
}

/* ====== Render: Instâncias ====== */
function renderInstances() {
  const base = state.baseInstances.length ? state.baseInstances : state.instances;
  const instances = state.filteredInstances.length ? state.filteredInstances : base;

  if (!instances.length) {
    els.instanceList.innerHTML = `<div class="wa-empty-state"><p>Nenhuma instância encontrada</p></div>`;
    return;
  }

  const sorted = [...instances].sort((a, b) => {
    const aOn = isConnected(a.status);
    const bOn = isConnected(b.status);
    if (aOn && !bOn) return -1;
    if (!aOn && bOn) return 1;
    return 0;
  });

  els.instanceList.innerHTML = sorted.map((inst) => {
    const on = isConnected(inst.status);
    const statusClass = on ? "online" : "offline";
    const statusLabel = on ? "Online" : "Offline";
    const avatar = resolveInstanceAvatar(inst);

    return `
      <div class="wa-instance-card" data-id="${escapeHtml(inst.id)}" role="option" aria-label="${escapeHtml(inst.name || inst.id)}">
        <div class="wa-instance-card-avatar">
          ${
            avatar
              ? `<img class="wa-avatar-img" src="${escapeHtml(avatar)}" alt="Avatar da instância" />`
              : `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
                   <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM9 11H7V9h2v2zm4 0h-2V9h2v2zm4 0h-2V9h2v2z"/>
                 </svg>`
          }
        </div>
        <div class="wa-instance-card-content">
          <h3 class="wa-instance-card-name" style="margin:0 0 4px 0">${escapeHtml(inst.name || inst.id)}</h3>
          <p class="wa-instance-card-system" style="margin:0;opacity:.7">${inst.systemName ? `@${escapeHtml(inst.systemName)}` : "Sistema"}</p>
          <span class="wa-badge ${statusClass}">${statusLabel}</span>
        </div>
      </div>
    `;
  }).join("");
}

/* ====== Render: Chats ====== */
function renderChats() {
  const start = state.chatPage * state.pageSize;
  const base  = state.filteredChats.length ? state.filteredChats : state.chats;
  const end   = Math.min(start + state.pageSize, base.length);
  const page  = base.slice(start, end);

  if (!page.length) {
    els.chatList.innerHTML = `<div class="wa-empty-state"><p>Nenhum chat encontrado</p></div>`;
    els.prevPage.disabled = true;
    els.nextPage.disabled = true;
    els.pageInfo.textContent = "0 de 0";
    return;
  }

  els.chatList.innerHTML = page.map((c) => {
    const name  = c.lead_name || c.wa_name || c.name || c.phone || getChatId(c) || "Chat";
    const preview = c.wa_lastMessageTextVote || c.wa_lastMsgPreview || c.lastMessage || "";
    const chatId  = getChatId(c);
    const isActive = state.currentChatId === chatId;
    const avatar = resolveChatAvatar(c);

    return `
      <div class="wa-chat-item ${isActive ? "active" : ""}" data-chatid="${escapeHtml(chatId)}" role="option" aria-label="${escapeHtml(name)}">
        <div class="wa-chat-item-avatar">
          ${
            avatar
              ? `<img class="wa-avatar-img" src="${escapeHtml(avatar)}" alt="Foto do chat" />`
              : `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
                   <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
                 </svg>`
          }
        </div>
        <div class="wa-chat-item-content" style="min-width:0">
          <div class="wa-chat-item-header">
            <span class="wa-chat-item-name" style="font-weight:600">${escapeHtml(name)}</span>
          </div>
          ${preview ? `<div class="wa-chat-item-preview" style="opacity:.75; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(preview)}</div>` : ""}
          ${chatId ? `<div class="wa-chat-item-meta" style="opacity:.6">${escapeHtml(chatId)}</div>` : ""}
        </div>
      </div>
    `;
  }).join("");

  els.prevPage.disabled = state.chatPage === 0;
  els.nextPage.disabled = end >= base.length;
  els.pageInfo.textContent = `${end} de ${base.length}`;
}

/* ====== Render: Mensagens ====== */
function renderMessages(list) {
  const wrap = els.messages;
  if (!wrap) return;

  if (!Array.isArray(list) || !list.length) {
    wrap.innerHTML = `<div class="wa-empty-state"><p>Nenhuma mensagem</p></div>`;
    return;
  }
  const html = list.map((m) => {
    const role = roleFromMessage(m);
    const text = escapeHtml(messageDisplayText(m));
    const ts =
      m?.messageTimestamp || m?.timestamp || m?.wa_timestamp || m?.createdAt || m?.date || null;
    const media = buildMediaHtml(m);
    return `
      <div class="msg ${role}">
        <div>${text || "<i>(sem texto)</i>"}</div>
        ${media}
        <div class="meta">${ts ? formatTime(ts) : ""} ${getMsgId(m) ? `· ${escapeHtml(getMsgId(m))}` : ""}</div>
      </div>
    `;
  }).join("");
  wrap.innerHTML = `<div class="messages-col">${html}</div>`;
}

/* ====== API / Filtro por cliente ====== */
async function computeInstanceFilter() {
  // Define hint de sistema a partir do client-settings (instance_url) + ?system=
  let hint = "";
  if (CLIENT_SLUG) {
    try {
      const r = await fetch(`${API}/client-settings?client=${encodeURIComponent(CLIENT_SLUG)}`);
      if (r.ok) {
        const st = await r.json();
        const url = st.instance_url || st.instanceUrl || "";
        hint = systemNameFromInstanceUrl(url) || hint;
      }
    } catch {}
  }
  if (SYSTEM_HINT) hint = SYSTEM_HINT;
  state.instanceFilterHint = hint || "";
}

/* ====== Carregar e auto-selecionar instância ====== */
async function loadInstances() {
  if (els.instanceList)
    els.instanceList.innerHTML = `<div class="wa-empty-state"><p>Carregando...</p></div>`;

  try {
    // 1) Busca lista de instâncias, config do cliente e a resolução exata
    const [resInst, resCfg, resResolve] = await Promise.all([
      fetch(`${API}/instances`),
      CLIENT_SLUG ? fetch(`${API}/client-settings?client=${encodeURIComponent(CLIENT_SLUG)}`) : Promise.resolve(null),
      CLIENT_SLUG ? fetch(`${API}/instances/resolve?client=${encodeURIComponent(CLIENT_SLUG)}`) : Promise.resolve(null),
    ]);

    if (!resInst.ok) throw new Error(`HTTP ${resInst.status}`);
    const json = await resInst.json();
    state.instances = Array.isArray(json.instances) ? json.instances : [];

    // 2) Calcula hint (domínio) pelo endpoint salvo
    let clientUrl = "";
    if (resCfg && resCfg.ok) {
      const s = await resCfg.json();
      clientUrl = s.instance_url || s.instanceUrl || "";
    }
    const hint = clientUrl ? systemNameFromInstanceUrl(clientUrl) : "";
    state.instanceFilterHint = hint;

    // 3) Filtra a lista exibida pelo domínio (quando houver)
    if (hint) {
      const h = hint.toLowerCase();
      state.baseInstances = state.instances.filter((i) => {
        const sys = String(i.systemName || "").toLowerCase();
        const nm  = String(i.name || "").toLowerCase();
        return sys.includes(h) || nm.includes(h);
      });
    } else {
      state.baseInstances = [...state.instances];
    }

    // 4) Renderiza a lista
    state.filteredInstances = [];
    renderInstances();

    // 5) Decide qual instância abrir
    let targetId = null;

    // 5.1 Preferência: backend resolveu por token/systemName
    if (resResolve && resResolve.ok) {
      const r = await resResolve.json();
      targetId = r?.id || null;
    }

    // 5.2 Se não resolveu, tenta o hint de ?inst= (pode ser id ou nome)
    if (!targetId && INST_HINT) {
      const ih = INST_HINT.toLowerCase();
      const byId  = state.instances.find((i) => String(i.id).toLowerCase() === ih);
      const byNm  = state.instances.find((i) => String(i.name || "").toLowerCase().includes(ih));
      targetId = (byId || byNm)?.id || null;
    }

    // 5.3 Se ainda não achou, tenta match exato de systemName do domínio
    if (!targetId && hint) {
      const exactSys = state.instances.find((i) => String(i.systemName || "").toLowerCase() === hint.toLowerCase());
      targetId = exactSys?.id || null;
    }

    // 6) Se tem targetId visível, clica na carta (não abre aleatória)
    if (targetId) {
      const sel = `.wa-instance-card[data-id="${CSS.escape(String(targetId))}"]`;
      const card = document.querySelector(sel);
      if (card) {
        setTimeout(() => card.click(), 0);
      } else {
        showAlert("Instância configurada não está visível na lista. Verifique o domínio/instância.", "warning", 6000);
      }
    } else {
      // se nada for resolvido, apenas mantém a lista filtrada
      if (!state.baseInstances.length) {
        els.instanceList.innerHTML = `<div class="wa-empty-state"><p>Nenhuma instância encontrada para este cliente</p></div>`;
      }
    }
  } catch (err) {
    console.error("Erro ao carregar instâncias", err);
    if (els.instanceList)
      els.instanceList.innerHTML = `<div class="wa-empty-state"><p>Erro ao carregar instâncias</p></div>`;
    showAlert(
      "Falha ao carregar instâncias. Verifique se o domínio/token do cliente estão corretos.",
      "warning",
      9000
    );
  }
}

async function loadChats(instanceId, query) {
  const params = new URLSearchParams();
  params.set("limit", 5000);
  params.set("offset", 0);
  if (query) params.set("q", query);

  try {
    const res = await fetch(`${API}/instances/${encodeURIComponent(instanceId)}/chats?` + params.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    state.chats = json.chats || [];
    state.filteredChats = [];
    state.chatPage = 0;
    renderChats();
  } catch {
    state.chats = [];
    state.filteredChats = [];
    renderChats();
    showAlert("Erro ao carregar chats desta instância.", "warning", 6000);
  }
}

async function loadMessages(instanceId, chatObj) {
  const candidates = [
    chatObj?._chatId, chatObj?.wa_chatid, chatObj?.wa_fastid, chatObj?.jid, chatObj?.wa_id,
    chatObj?.number, chatObj?.id, chatObj?.chatid, chatObj?.wa_jid
  ].filter(Boolean);

  if (!candidates.length) { renderMessages([]); return; }

  const params = new URLSearchParams();
  params.set("chatId", candidates[0]);
  params.set("alts", candidates.slice(1).join(","));
  params.set("limit", 500);
  params.set("all", "1");

  try {
    const res = await fetch(`${API}/instances/${encodeURIComponent(instanceId)}/messages?` + params.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    const list = Array.isArray(json?.messages)
      ? json.messages
      : Array.isArray(json?.messages?.messages)
        ? json.messages.messages
        : Array.isArray(json?.messages?.content)
          ? json.messages.content
          : [];

    renderMessages(list);
  } catch {
    renderMessages([]);
    showAlert("Erro ao carregar mensagens deste chat.", "warning", 6000);
  }
}

/* ====== Exportação simples ====== */
function doExportCurrentInstance() {
  if (!state.currentInstanceId) return;
  // Abre a rota /api/instances/:id/export.txt (servidor monta o arquivo)
  const url = `${API}/instances/${encodeURIComponent(state.currentInstanceId)}/export.txt`;
  window.open(url, "_blank", "noopener");
}

/* ====== Navegação ====== */
function goToLogin() {
  state.screen = "login";
  els.screenLogin?.classList.remove("hidden");
  els.screenInstances?.classList.add("hidden");
  els.screenWorkspace?.classList.add("hidden");
  if (els.username) els.username.value = "";
  if (els.password) els.password.value = "";
}
function goToInstances() {
  state.screen = "instances";
  els.screenLogin?.classList.add("hidden");
  els.screenInstances?.classList.remove("hidden");
  els.screenWorkspace?.classList.add("hidden");

  state.currentInstanceId = null;
  state.chats = [];
  state.filteredChats = [];
  state.currentChatId = null;

  if (els.messages) els.messages.innerHTML = "";
  if (els.chatList) els.chatList.innerHTML = "";
  if (els.btnExport) els.btnExport.disabled = true;
  if (els.chatTitle) els.chatTitle.textContent = "Selecione um chat";
  if (els.chatSubtitle) els.chatSubtitle.textContent = "";
  if (els.chatSearch) els.chatSearch.value = "";
  showSidebarOnMobile();
}
function goToChats() {
  state.screen = "chats";
  els.screenLogin?.classList.add("hidden");
  els.screenInstances?.classList.add("hidden");
  els.screenWorkspace?.classList.remove("hidden");
  showSidebarOnMobile();
}

/* ====== Login simplificado ====== */
let logging = false;
function handleLogin(e) {
  if (e) e.preventDefault();
  if (logging) return;

  const user = (els.username?.value || "").trim();
  const pass = (els.password?.value || "").trim();
  if (!user || !pass) {
    showAlert("Preencha usuário e senha para continuar.", "warning", 5000);
    els.username?.focus();
    return;
  }

  logging = true;
  state.isAuthenticated = true;
  goToInstances();

  // Antes de listar instâncias, calcula o filtro (client-settings) e depois carrega
  computeInstanceFilter()
    .finally(() => loadInstances())
    .finally(() => { logging = false; });
}

function handleLogout() {
  state.isAuthenticated = false;
  state.instances = [];
  state.baseInstances = [];
  state.filteredInstances = [];
  state.instanceFilterHint = "";
  state.currentInstanceId = null;
  state.chats = [];
  state.filteredChats = [];
  state.currentChatId = null;
  goToLogin();
}

/* ====== Listeners ====== */
function wireUp() {
  try { els.loginForm?.setAttribute("novalidate", "true"); } catch {}
  els.loginForm?.addEventListener("submit", handleLogin);
  const btn = els.loginForm?.querySelector(".login-button");
  btn?.addEventListener("click", handleLogin);

  els.btnLogout?.addEventListener("click", handleLogout);
  els.btnRefresh?.addEventListener("click", () => loadInstances());
  els.btnExport?.addEventListener("click", doExportCurrentInstance);

  // Busca de instâncias
  els.instanceSearch?.addEventListener("input", (ev) => {
    const q = ev.target.value.toLowerCase().trim();
    const base = state.baseInstances.length ? state.baseInstances : state.instances;

    if (!q) {
      state.filteredInstances = [];
    } else {
      state.filteredInstances = base.filter((inst) => {
        const name = String(inst.name || inst.id).toLowerCase();
        const systemName = String(inst.systemName || "").toLowerCase();
        const online = isConnected(inst.status) ? "online" : "offline";
        return name.includes(q) || systemName.includes(q) || online.includes(q);
      });
    }
    renderInstances();
  });

  // Click de instância
  els.instanceList?.addEventListener("click", async (ev) => {
    const card = ev.target.closest(".wa-instance-card");
    if (!card) return;

    state.currentInstanceId = card.dataset.id;
    const inst = (state.baseInstances.length ? state.baseInstances : state.instances)
      .find((i) => String(i.id) === String(state.currentInstanceId));

    // header lateral
    if (els.sidebarInstanceName) els.sidebarInstanceName.textContent = inst?.name || inst?.id || "Instância";
    const online = isConnected(inst?.status);
    if (els.sidebarInstanceStatus) {
      els.sidebarInstanceStatus.textContent = online ? "Online" : "Offline";
      els.sidebarInstanceStatus.className = `wa-status ${online ? "online" : "offline"}`;
    }
    if (els.btnExport) els.btnExport.disabled = false;

    // avatar
    const sidebarAv = document.querySelector("#screen-workspace .wa-avatar");
    if (sidebarAv) {
      sidebarAv.innerHTML = "";
      const av = resolveInstanceAvatar(inst);
      if (av) {
        sidebarAv.insertAdjacentHTML("afterbegin",
          `<img class="wa-avatar-img" src="${escapeHtml(av)}" alt="Avatar" />`);
      }
    }

    goToChats();
    await loadChats(state.currentInstanceId, els.chatSearch?.value);
    if (els.messages) els.messages.innerHTML = `<div class="wa-empty-state"><p>Selecione um chat para ver as mensagens</p></div>`;
    if (els.chatTitle) els.chatTitle.textContent = "Selecione um chat";
    if (els.chatSubtitle) els.chatSubtitle.textContent = "";
    state.currentChatId = null;
  });

  els.btnBack?.addEventListener("click", () => {
    if (isSmallScreen() && state.mobileSidebarHidden) { showSidebarOnMobile(); return; }
    goToInstances();
  });

  els.chatList?.addEventListener("click", async (ev) => {
    const item = ev.target.closest(".wa-chat-item");
    if (!item) return;

    state.currentChatId = item.dataset.chatid;
    const list = state.filteredChats.length ? state.filteredChats : state.chats;
    const chosen = list.find((c) => getChatId(c) === state.currentChatId) || state.chats.find((c) => getChatId(c) === state.currentChatId);

    const title = chosen?.lead_name || chosen?.wa_name || chosen?.name || chosen?.phone || getChatId(chosen) || "Chat";

    if (els.chatTitle) els.chatTitle.textContent = title;
    if (els.chatSubtitle) els.chatSubtitle.textContent = state.currentChatId ? state.currentChatId : "";

    // avatar do chat
    const chatAv = document.querySelector(".wa-chat-avatar");
    if (chatAv) {
      chatAv.innerHTML = "";
      const av = resolveChatAvatar(chosen);
      if (av) {
        chatAv.insertAdjacentHTML("afterbegin",
          `<img class="wa-avatar-img" src="${escapeHtml(av)}" alt="Foto do chat" />`);
      }
    }

    // marca ativo
    renderChats();

    // carrega mensagens
    hideSidebarOnMobile();
    await loadMessages(state.currentInstanceId, chosen);
  });

  els.chatSearch?.addEventListener("input", (ev) => {
    const q = ev.target.value.toLowerCase().trim();
    const base = state.chats;
    if (!q) {
      state.filteredChats = [];
    } else {
      state.filteredChats = base.filter((c) => {
        const name = String(c.lead_name || c.wa_name || c.name || c.phone || getChatId(c) || "").toLowerCase();
        const preview = String(c.wa_lastMessageTextVote || c.wa_lastMsgPreview || c.lastMessage || "").toLowerCase();
        const id = String(getChatId(c) || "").toLowerCase();
        return name.includes(q) || preview.includes(q) || id.includes(q);
      });
    }
    state.chatPage = 0;
    renderChats();
  });

  els.nextPage?.addEventListener("click", () => { state.chatPage++; renderChats(); });
  els.prevPage?.addEventListener("click", () => { state.chatPage = Math.max(0, state.chatPage - 1); renderChats(); });

  // (Export com botão já ligado acima)
}

/* ====== Init ====== */
function init() {
  wireUp();

  // Autologin opcional: ?autologin=1
  if (AUTOLOGIN) {
    state.isAuthenticated = true;
    goToInstances();
    computeInstanceFilter().finally(() => loadInstances());
    return;
  }

  // fluxo padrão
  goToLogin();
}
init();
