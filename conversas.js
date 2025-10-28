/* conversas.js — versão final (sem login) — Luna */
(() => {
  // ===== Config =====
  function getApiBase() {
    const qsApi = new URLSearchParams(window.location.search).get("api");
    if (qsApi) {
      try {
        const u = new URL(qsApi, window.location.href);
        if (["http:", "https:"].includes(u.protocol)) return u.toString().replace(/\/+$/, "");
      } catch {}
    }
    return "https://luna-admin-backend-production.up.railway.app/api";
  }
  const API = getApiBase();
  const CLIENT_SLUG = new URLSearchParams(window.location.search).get("client") || "";

  function systemNameFromInstanceUrl(u) {
    try { return (new URL(u).hostname.split(".")[0] || "").toLowerCase(); } catch { return ""; }
  }

  // ===== Estado =====
  const state = {
    // instâncias
    instances: [],
    baseInstances: [],
    filteredInstances: [],
    instanceFilterHint: "",
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

  // ===== Elementos =====
  const els = {
    appAlert: document.getElementById("appAlert"),
    appAlertText: document.getElementById("appAlertText"),

    screenInstances: document.getElementById("screen-instances"),
    screenWorkspace: document.getElementById("screen-workspace"),

    // instâncias
    instanceList: document.getElementById("instanceList"),
    instanceSearch: document.getElementById("instanceSearch"),
    btnRefresh: document.getElementById("btnRefresh"),
    btnLogout: document.getElementById("btnLogout"),

    // workspace
    btnBack: document.getElementById("btnBack"),
    sidebarInstanceName: document.getElementById("sidebarInstanceName"),
    sidebarInstanceStatus: document.getElementById("sidebarInstanceStatus"),

    btnExport: document.getElementById("btnExport"),
    chatSearch: document.getElementById("chatSearch"),

    exportProgress: document.getElementById("exportProgress"),
    exportProgressLabel: document.getElementById("exportProgressLabel"),
    exportProgressBar: document.getElementById("exportProgressBar"),
    exportProgressCounts: document.getElementById("exportProgressCounts"),
    exportProgressPct: document.getElementById("exportProgressPct"),
    exportCancelBtn: document.getElementById("exportCancelBtn"),

    chatList: document.getElementById("chatList"),
    nextPage: document.getElementById("nextPage"),
    prevPage: document.getElementById("prevPage"),
    pageInfo: document.getElementById("pageInfo"),

    messages: document.getElementById("messages"),
    chatTitle: document.getElementById("chatTitle"),
    chatSubtitle: document.getElementById("chatSubtitle"),
  };

  /* ===== Helpers ===== */
  function showAlert(msg, type = "warning", timeout = 6000) {
    if (!els.appAlert || !els.appAlertText) return;
    els.appAlertText.textContent = String(msg);
    els.appAlert.className = `app-alert ${type}`;
    els.appAlert.classList.remove("hidden");
    if (timeout > 0) {
      clearTimeout(showAlert._t);
      showAlert._t = setTimeout(() => els.appAlert.classList.add("hidden"), timeout);
    }
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tryParseJSON = (v) => { if (!v) return null; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };
  const toArray = (x) => Array.isArray(x) ? x : x == null ? [] : [x];
  const isConnected = (statusObj) => {
    if (statusObj && typeof statusObj.connected !== "undefined") return statusObj.connected === true;
    try { const s = JSON.stringify(statusObj || {}).toLowerCase(); return s.includes('"connected":true') || s.includes("online"); } catch { return false; }
  };
  function resolveInstanceAvatar(inst) { return inst?.avatarUrl||inst?.profilePicUrl||inst?.picture||inst?.picUrl||inst?.photoUrl||inst?.imageUrl||inst?.icon||null; }
  function resolveChatAvatar(c) { return c?.avatarUrl||c?.profilePicUrl||c?.picture||c?.picUrl||c?.photoUrl||c?.wa_profilePicUrl||c?.imageUrl||null; }
  function safeUrl(u){ if(!u) return null; try{ const url=new URL(u,window.location.href); if(["http:","https:"].includes(url.protocol)) return url.toString(); }catch{} return null; }
  function proxifyMedia(u){ const url=safeUrl(u); if(!url) return null; try{ const parsed=new URL(url); if(parsed.origin===window.location.origin) return url; return `${API}/media/proxy?url=${encodeURIComponent(parsed.toString())}`; }catch{ return url; } }
  function formatTime(ts){ if(!ts) return ""; let ms=Number(ts); if(!Number.isFinite(ms)) return String(ts); if(ms<1e12) ms*=1000; const d=new Date(ms); if(Number.isNaN(d.getTime())) return String(ts); return d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}); }
  function getChatId(c){ return c?._chatId||c?.wa_chatid||c?.wa_fastid||c?.jid||c?.wa_id||c?.number||c?.id||c?.chatid||c?.wa_jid||""; }
  function getMsgId(m){ return m?.id||m?.msgId||m?.messageId||m?.key?.id||m?.wa_msgid||m?.wa_keyid||m?.wamid||null; }

  // ===== Mobile =====
  const isSmallScreen = () => window.matchMedia("(max-width: 768px)").matches;
  const getSidebarEl = () => document.querySelector("#screen-workspace .wa-sidebar");
  function showSidebarOnMobile(){ const sb=getSidebarEl(); if(sb) sb.style.display=""; state.mobileSidebarHidden=false; }
  function hideSidebarOnMobile(){ if(!isSmallScreen()) return; const sb=getSidebarEl(); if(sb) sb.style.display="none"; state.mobileSidebarHidden=true; }
  window.addEventListener("resize", () => { if (!isSmallScreen()) showSidebarOnMobile(); });

  /* ===== Filtro por cliente ===== */
  async function computeInstanceFilter() {
    if (!CLIENT_SLUG) { state.instanceFilterHint = ""; return; }
    try {
      const r = await fetch(`${API}/client-settings?client=${encodeURIComponent(CLIENT_SLUG)}`);
      if (!r.ok) return;
      const st = await r.json();
      const url = st.instanceUrl || st.instance_url || "";
      state.instanceFilterHint = systemNameFromInstanceUrl(url) || "";
    } catch { state.instanceFilterHint = ""; }
  }

  /* ===== Render: Instâncias ===== */
  function renderInstances() {
    const base = state.baseInstances.length ? state.baseInstances : state.instances;
    const instances = state.filteredInstances.length ? state.filteredInstances : base;

    if (!instances.length) {
      els.instanceList.innerHTML = `<div class="wa-empty-state"><p>Nenhuma instância encontrada</p></div>`;
      return;
    }

    const sorted = [...instances].sort((a,b)=> (isConnected(a.status)===isConnected(b.status))?0:(isConnected(a.status)?-1:1));

    els.instanceList.innerHTML = sorted.map((inst) => {
      const on = isConnected(inst.status);
      const avatar = resolveInstanceAvatar(inst);
      return `
        <div class="wa-instance-card" data-id="${escapeHtml(inst.id)}" role="option" aria-label="${escapeHtml(inst.name || inst.id)}">
          <div class="wa-instance-card-avatar">
            ${ avatar
              ? `<img class="wa-avatar-img" src="${escapeHtml(avatar)}" alt="Avatar da instância" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />`
              : `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM9 11H7V9h2v2zm4 0h-2V9h2v2zm4 0h-2V9h2v2z"/></svg>`
            }
          </div>
          <div class="wa-instance-card-content">
            <h3 class="wa-instance-card-name">${escapeHtml(inst.name || inst.id)}</h3>
            <p class="wa-instance-card-system">${inst.systemName ? `@${escapeHtml(inst.systemName)}` : "Sistema"}</p>
            <span class="wa-badge ${on ? "online":"offline"}">${on ? "Online":"Offline"}</span>
          </div>
        </div>`;
    }).join("");
  }

  /* ===== Render: Chats ===== */
  function renderChats() {
    const start = state.chatPage * state.pageSize;
    const list = state.filteredChats.length ? state.filteredChats : state.chats;
    const end = Math.min(start + state.pageSize, list.length);
    const page = list.slice(start, end);

    if (!page.length) {
      els.chatList.innerHTML = `<div class="wa-empty-state"><p>Nenhum chat encontrado</p></div>`;
      els.prevPage.disabled = true; els.nextPage.disabled = true; els.pageInfo.textContent = "0 / 0"; return;
    }

    els.chatList.innerHTML = page.map((c) => {
      const name = c.lead_name || c.wa_name || c.name || c.phone || getChatId(c) || "Chat";
      const preview = c.wa_lastMessageTextVote || c.wa_lastMsgPreview || c.lastMessage || "";
      const chatId = getChatId(c);
      const isActive = state.currentChatId === chatId;
      const avatar = resolveChatAvatar(c);
      return `
        <div class="wa-chat-item ${isActive ? "active" : ""}" data-chatid="${escapeHtml(chatId)}" role="option" aria-label="${escapeHtml(name)}">
          <div class="wa-chat-item-avatar">
            ${ avatar
              ? `<img class="wa-avatar-img" src="${escapeHtml(avatar)}" alt="Foto do chat" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />`
              : `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>`
            }
          </div>
          <div class="wa-chat-item-content">
            <div class="wa-chat-item-header"><span class="wa-chat-item-name">${escapeHtml(name)}</span></div>
            ${preview ? `<div class="wa-chat-item-preview">${escapeHtml(preview)}</div>` : ""}
            ${chatId ? `<div class="wa-chat-item-meta">${escapeHtml(chatId)}</div>` : ""}
          </div>
        </div>`;
    }).join("");

    els.prevPage.disabled = state.chatPage === 0;
    els.nextPage.disabled = end >= list.length;
    els.pageInfo.textContent = `${end} de ${list.length}`;
  }

  /* ===== Render: Mensagens (texto + mídia + placeholders simples) ===== */
  function buildMediaHtml(m, c) {
    const mime = m?.mimeType || c?.mimetype || c?.mime || m?.messageType || "";
    const candidateUrl = m?.mediaUrl || m?.url || c?.url || c?.mediaUrl || c?.fileUrl || m?.fileUrl || c?.image || c?.video || c?.audio || null;
    const url = proxifyMedia(candidateUrl);
    const mimeLower = String(mime).toLowerCase();
    let html = "", isMedia = false;

    if (url) {
      if (mimeLower.includes("image") || /image|jpeg|png|gif|webp/i.test(url)) { isMedia = true; html = `<img class="wa-msg-image" src="${escapeHtml(url)}" alt="Imagem" loading="lazy" />`; }
      else if (mimeLower.includes("video") || /mp4|webm|video/i.test(url)) { isMedia = true; html = `<video class="wa-msg-video" src="${escapeHtml(url)}" controls playsinline></video>`; }
      else if (mimeLower.includes("audio") || /audio|mp3|ogg|wav/i.test(url)) { isMedia = true; html = `<audio class="wa-msg-audio" src="${escapeHtml(url)}" controls></audio>`; }
      else { isMedia = true; const fn = c?.filename || m?.filename || (candidateUrl ? String(candidateUrl).split("/").pop() : "arquivo"); html = `<div class="wa-file-card">📎 <a href="${escapeHtml(url)}" target="_blank" rel="noopener">Abrir arquivo (${escapeHtml(fn)})</a></div>`; }
    } else {
      const filename = (c?.filename || m?.filename || "");
      const looksLikeVideoName = /(\.mp4|\.webm|\.mov|\.mkv)$/i.test(filename);
      if (mimeLower.includes("video") || looksLikeVideoName) { isMedia = true; html = `<div class="wa-file-card">📹 Vídeo enviado</div>`; }
    }
    return { html, isMedia };
  }
  function pickBestText(m) {
    const c = (m?.content && typeof m.content === "object") ? m.content : {};
    const raw = m?.text ?? m?.body ?? m?.message ?? (typeof c === "object" ? (c?.text ?? c?.caption ?? "") : c);
    return (typeof raw === "string") ? raw.trim() : "";
  }
  function renderMessages(list) {
    if (!Array.isArray(list) || !list.length) {
      els.messages.innerHTML = `<div class="wa-empty-state"><p>Nenhuma mensagem para exibir</p></div>`;
      return;
    }
    els.messages.innerHTML = list.map((m) => {
      const fromMe = m?.fromMe === true || m?.sender?.fromMe === true || m?.me === true;
      const direction = fromMe ? "outgoing" : "incoming";
      const ts = m?.messageTimestamp || m?.timestamp || m?.wa_timestamp || m?.createdAt || m?.date || "";
      const c = (m?.content && typeof m.content === "object") ? m.content : {};
      const text = pickBestText(m);
      const timeStr = formatTime(ts);
      const { html: mediaHtml, isMedia } = buildMediaHtml(m, c);

      // placeholder simples para mensagens interativas vazias
      const type = String(m?.messageType || m?.type || c?.type || "").toLowerCase();
      const hasInteractiveMarks = type.includes("interactive") || type.includes("nativeflow") || Array.isArray(c?.buttons) || Array.isArray(c?.sections) || Array.isArray(c?.rows);
      const card = hasInteractiveMarks ? `<div class="nf-card"><div class="nf-card__body">Caixa enviada</div></div>` : "";

      const pills = [];
      if (hasInteractiveMarks) pills.push("Caixinha");
      if (isMedia) pills.push("Mídia");
      const pillsHtml = pills.length ? `<div class="wa-type-pill">${pills.join(" • ")}</div>` : "";

      const inner =
        pillsHtml +
        (text ? `<div class="wa-message-text">${escapeHtml(text)}</div>` : "") +
        mediaHtml +
        card +
        `<div class="wa-message-meta">${escapeHtml(timeStr)}</div>`;

      return `
        <div class="wa-message ${direction}" data-mid="${escapeHtml(getMsgId(m) || "")}">
          <div class="wa-message-bubble ${hasInteractiveMarks ? "interactive" : ""}">
            ${inner}
          </div>
        </div>`;
    }).join("");
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  /* ===== API ===== */
  async function loadInstances() {
    if (els.instanceList) els.instanceList.innerHTML = `<div class="wa-empty-state"><p>Carregando...</p></div>`;
    try {
      const res = await fetch(`${API}/instances`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      state.instances = Array.isArray(json.instances) ? json.instances : [];

      if (state.instanceFilterHint) {
        const hint = state.instanceFilterHint.toLowerCase();
        state.baseInstances = state.instances.filter(i => {
          const sys = String(i.systemName || "").toLowerCase();
          const nm  = String(i.name || "").toLowerCase();
          return sys.includes(hint) || nm.includes(hint);
        });
      } else {
        state.baseInstances = [...state.instances];
      }
      state.filteredInstances = [];
      renderInstances();

      if (state.baseInstances.length === 1) {
        const only = state.baseInstances[0];
        setTimeout(() => document.querySelector(`.wa-instance-card[data-id="${CSS.escape(String(only.id))}"]`)?.click(), 0);
      }
    } catch (err) {
      els.instanceList.innerHTML = `<div class="wa-empty-state"><p>Erro ao carregar instâncias</p></div>`;
      showAlert(
        "Falha ao carregar instâncias. Se abriu o arquivo direto (file://) ou seu domínio não está na whitelist do backend (FRONT_ORIGINS), o navegador bloqueia por CORS. Hospede o front em http(s) ou ajuste FRONT_ORIGINS.",
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
      state.chats = []; state.filteredChats = []; renderChats();
      showAlert("Erro ao carregar chats desta instância.", "warning", 6000);
    }
  }

  async function loadMessages(instanceId, chatObj) {
    const candidates = [
      chatObj?._chatId, chatObj?.wa_chatid, chatObj?.wa_fastid, chatObj?.jid,
      chatObj?.wa_id, chatObj?.number, chatObj?.id, chatObj?.chatid, chatObj?.wa_jid
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

  /* ===== Exportação de TODOS os chats da instância ===== */
  let exportAbort = { cancel: false };
  function showExportProgress(show) {
    if (!els.exportProgress) return;
    if (show) {
      els.exportProgress.classList.remove("hidden");
      els.exportProgress.setAttribute("aria-hidden","false");
    } else {
      els.exportProgress.classList.add("hidden");
      els.exportProgress.setAttribute("aria-hidden","true");
      if (els.exportProgressBar) els.exportProgressBar.style.width = "0%";
      if (els.exportProgressCounts) els.exportProgressCounts.textContent = "0 / 0";
      if (els.exportProgressPct) els.exportProgressPct.textContent = "0%";
    }
  }
  function updateExportProgress(done, total, label = "Exportando…") {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    els.exportProgressBar.style.width = `${pct}%`;
    els.exportProgressPct.textContent = `${pct}%`;
    els.exportProgressCounts.textContent = `${done} / ${total}`;
    els.exportProgressLabel.textContent = label;
  }
  els.exportCancelBtn?.addEventListener("click", () => { exportAbort.cancel = true; els.exportProgressLabel.textContent = "Cancelando…"; });

  function getChatIdCandidates(chatObj) {
    return [chatObj?._chatId, chatObj?.wa_chatid, chatObj?.wa_fastid, chatObj?.jid, chatObj?.wa_id, chatObj?.number, chatObj?.id, chatObj?.chatid, chatObj?.wa_jid].filter(Boolean);
  }

  async function fetchMessagesForChat(instanceId, chatObj) {
    const candidates = getChatIdCandidates(chatObj);
    if (!candidates.length) return [];
    const params = new URLSearchParams();
    params.set("chatId", candidates[0]);
    params.set("alts", candidates.slice(1).join(","));
    params.set("limit", 1000);
    params.set("all", "1");
    const res = await fetch(`${API}/instances/${encodeURIComponent(instanceId)}/messages?` + params.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.messages)
      ? json.messages
      : Array.isArray(json?.messages?.messages)
        ? json.messages.messages
        : Array.isArray(json?.messages?.content)
          ? json.messages.content
          : [];
  }

  function formatTsForTranscript(ts) {
    if (!ts) return "";
    let ms = Number(ts); if (!Number.isFinite(ms)) return "";
    if (ms < 1e12) ms *= 1000;
    const d = new Date(ms); if (Number.isNaN(d.getTime())) return "";
    const yyyy = d.getFullYear(), mm = String(d.getMonth()+1).padStart(2,"0"), dd = String(d.getDate()).padStart(2,"0");
    const hh = String(d.getHours()).padStart(2,"0"), mi = String(d.getMinutes()).padStart(2,"0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }
  function roleFromMessage(m) { return (m?.fromMe === true || m?.sender?.fromMe === true || m?.me === true) ? "Nós" : "Cliente"; }
  function messageDisplayText(m) {
    const c = (m?.content && typeof m.content === "object") ? m.content : {};
    const raw = m?.text ?? m?.body ?? m?.message ?? (typeof c === "object" ? (c?.text ?? c?.caption ?? "") : c);
    const t = (typeof raw === "string") ? raw.trim() : "";
    if (t) return t;
    const type = String(m?.messageType || m?.type || c?.type || "").toLowerCase();
    if (type.includes("video")) return "📹 [Vídeo enviado]";
    if (type.includes("interactive") || type.includes("nativeflow")) return "[Caixa enviada]";
    return "";
  }

  async function exportAllChatsForInstance(instanceId) {
    await loadChats(instanceId, "");
    const chats = state.filteredChats.length ? state.filteredChats : state.chats;
    if (!chats.length) { showAlert("Não há chats nesta instância para exportar.", "warning", 5000); return; }

    exportAbort = { cancel: false };
    showExportProgress(true);
    updateExportProgress(0, chats.length, `Exportando ${chats.length} chats…`);
    if (els.btnExport) els.btnExport.disabled = true;

    const lines = [];
    lines.push(`# Export - Instância: ${instanceId}`);
    lines.push(`# Gerado em: ${new Date().toISOString()}`);
    lines.push("");

    const CONCURRENCY = 5;
    let processed = 0, idx = 0;

    async function worker() {
      while (idx < chats.length && !exportAbort.cancel) {
        const i = idx++;
        const chat = chats[i];
        const chatId = getChatId(chat);
        const chatName = chat.lead_name || chat.wa_name || chat.name || chat.phone || chatId || "Chat";

        try {
          const messages = await fetchMessagesForChat(instanceId, chat);
          lines.push(`==============================`);
          lines.push(`Chat: ${chatName}`);
          if (chatId) lines.push(`ID: ${chatId}`);
          lines.push(`==============================`);
          for (const m of messages) {
            const ts = m?.messageTimestamp || m?.timestamp || m?.wa_timestamp || m?.createdAt || m?.date || "";
            const tsStr = formatTsForTranscript(ts);
            const role = roleFromMessage(m);
            const text = messageDisplayText(m);
            if (!text) continue;
            lines.push(`${tsStr ? tsStr + " - " : ""}${role}: ${text}`);
          }
          lines.push("");
        } catch (e) {
          lines.push(`==============================`);
          lines.push(`Chat: ${chatName}`);
          if (chatId) lines.push(`ID: ${chatId}`);
          lines.push(`[ERRO AO CARREGAR MENSAGENS: ${String(e)}]`);
          lines.push(`==============================`);
          lines.push("");
        } finally {
          processed++;
          updateExportProgress(processed, chats.length, `Exportando ${chats.length} chats…`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chats.length) }, () => worker()));

    if (exportAbort.cancel) {
      showAlert("Exportação cancelada pelo usuário.", "warning", 6000);
      showExportProgress(false);
      if (els.btnExport) els.btnExport.disabled = false;
      return;
    }

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dt = new Date();
    const stamp = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}_${String(dt.getHours()).padStart(2,"0")}${String(dt.getMinutes()).padStart(2,"0")}`;
    a.href = url; a.download = `transcripts-${instanceId}-all-chats-${stamp}.txt`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    showAlert(`Exportação concluída: ${chats.length} chats processados.`, "success", 6000);
    showExportProgress(false);
    if (els.btnExport) els.btnExport.disabled = false;
  }

  /* ===== Listeners ===== */
  els.btnLogout?.addEventListener("click", () => { // limpa só o front
    state.instances = []; state.baseInstances = []; state.filteredInstances = []; state.instanceFilterHint = "";
    state.currentInstanceId = null; state.chats = []; state.filteredChats = []; state.currentChatId = null;
    els.messages.innerHTML = ""; els.chatList.innerHTML = ""; if (els.btnExport) els.btnExport.disabled = true;
    if (els.chatTitle) els.chatTitle.textContent = "Selecione um chat"; if (els.chatSubtitle) els.chatSubtitle.textContent = "";
    showSidebarOnMobile(); // volta para tela de instâncias
    els.screenWorkspace?.classList.add("hidden"); els.screenInstances?.classList.remove("hidden");
    computeInstanceFilter().finally(loadInstances);
  });
  els.btnRefresh?.addEventListener("click", () => loadInstances());

  els.instanceSearch?.addEventListener("input", (ev) => {
    const q = ev.target.value.toLowerCase().trim();
    const base = state.baseInstances.length ? state.baseInstances : state.instances;
    state.filteredInstances = !q ? [] : base.filter((inst) => {
      const name = String(inst.name || inst.id).toLowerCase();
      const systemName = String(inst.systemName || "").toLowerCase();
      const online = isConnected(inst.status) ? "online" : "offline";
      return name.includes(q) || systemName.includes(q) || online.includes(q);
    });
    renderInstances();
  });

  els.instanceList?.addEventListener("click", async (ev) => {
    const card = ev.target.closest(".wa-instance-card"); if (!card) return;
    state.currentInstanceId = card.dataset.id;
    const inst = (state.baseInstances.length ? state.baseInstances : state.instances)
      .find((i) => String(i.id) === String(state.currentInstanceId));

    if (els.sidebarInstanceName) els.sidebarInstanceName.textContent = inst?.name || inst?.id || "Instância";
    const online = isConnected(inst?.status);
    if (els.sidebarInstanceStatus) {
      els.sidebarInstanceStatus.textContent = online ? "Online" : "Offline";
      els.sidebarInstanceStatus.className = `wa-status ${online ? "online" : "offline"}`;
    }
    if (els.btnExport) els.btnExport.disabled = false;

    const sidebarAv = document.querySelector("#screen-workspace .wa-avatar");
    if (sidebarAv) {
      sidebarAv.innerHTML = "";
      const av = resolveInstanceAvatar(inst);
      if (av) {
        sidebarAv.insertAdjacentHTML("afterbegin", `<img class="wa-avatar-img" src="${escapeHtml(av)}" alt="Avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />`);
      } else {
        sidebarAv.insertAdjacentHTML("afterbegin", `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>`);
      }
    }

    // troca de tela
    els.screenInstances?.classList.add("hidden");
    els.screenWorkspace?.classList.remove("hidden");

    await loadChats(state.currentInstanceId, els.chatSearch?.value);
    els.messages.innerHTML = `<div class="wa-empty-state"><p>Selecione um chat para ver as mensagens</p></div>`;
    if (els.chatTitle) els.chatTitle.textContent = "Selecione um chat";
    if (els.chatSubtitle) els.chatSubtitle.textContent = "";
    state.currentChatId = null;
  });

  els.btnBack?.addEventListener("click", () => {
    if (isSmallScreen() && state.mobileSidebarHidden) { showSidebarOnMobile(); return; }
    els.screenWorkspace?.classList.add("hidden");
    els.screenInstances?.classList.remove("hidden");
  });

  els.chatList?.addEventListener("click", async (ev) => {
    const item = ev.target.closest(".wa-chat-item"); if (!item) return;
    state.currentChatId = item.dataset.chatid;
    const list = state.filteredChats.length ? state.filteredChats : state.chats;
    const chosen = list.find((c) => getChatId(c) === state.currentChatId) || state.chats.find((c) => getChatId(c) === state.currentChatId);

    const title = chosen?.lead_name || chosen?.wa_name || chosen?.name || chosen?.phone || getChatId(chosen) || "Chat";
    if (els.chatTitle) els.chatTitle.textContent = title;
    if (els.chatSubtitle) els.chatSubtitle.textContent = state.currentChatId ? state.currentChatId : "";

    const chatAv = document.querySelector(".wa-chat-avatar");
    if (chatAv) {
      chatAv.innerHTML = "";
      const av = resolveChatAvatar(chosen);
      if (av) chatAv.insertAdjacentHTML("afterbegin", `<img class="wa-avatar-img" src="${escapeHtml(av)}" alt="Foto do chat" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />`);
      else chatAv.insertAdjacentHTML("afterbegin", `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>`);
    }

    renderChats();
    hideSidebarOnMobile();
    await loadMessages(state.currentInstanceId, chosen);
  });

  els.chatSearch?.addEventListener("input", (ev) => {
    const q = ev.target.value.toLowerCase().trim();
    const base = state.chats;
    state.filteredChats = !q ? [] : base.filter((c) => {
      const name = String(c.lead_name || c.wa_name || c.name || c.phone || getChatId(c) || "").toLowerCase();
      const preview = String(c.wa_lastMessageTextVote || c.wa_lastMsgPreview || c.lastMessage || "").toLowerCase();
      const id = String(getChatId(c) || "").toLowerCase();
      return name.includes(q) || preview.includes(q) || id.includes(q);
    });
    state.chatPage = 0;
    renderChats();
  });

  els.nextPage?.addEventListener("click", () => { state.chatPage++; renderChats(); });
  els.prevPage?.addEventListener("click", () => { state.chatPage = Math.max(0, state.chatPage - 1); renderChats(); });

  els.btnExport?.addEventListener("click", async () => {
    if (!state.currentInstanceId) { showAlert("Selecione uma instância primeiro.", "warning", 5000); return; }
    try { await exportAllChatsForInstance(state.currentInstanceId); }
    catch { showAlert("Falha ao exportar todas as conversas desta instância.", "warning", 7000); showExportProgress(false); if (els.btnExport) els.btnExport.disabled = false; }
  });

  /* ===== Init ===== */
  async function init() {
    // Começa direto na tela de instâncias
    els.screenInstances?.classList.remove("hidden");
    els.screenWorkspace?.classList.add("hidden");
    await computeInstanceFilter();
    await loadInstances();
  }
  init();
})();
