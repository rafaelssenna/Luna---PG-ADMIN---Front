/* progress.bundle.js — Modo COMPATÍVEL com a sua aba "Progresso"
   - Não injeta UI se #tab-progress já existe (usa seus elementos)
   - Conecta ao SSE:  GET /api/progress?client=:slug
   - Atualiza cota:   GET /api/quota?client=:slug
   - Atualiza elementos existentes:
       #quota-fill, #quota-sent, #quota-cap, #quota-remaining, #quota-updated
       #planned-list, #last-event, #progress-feed
   - Agora também:
       • Pré-carrega no feed os "Enviados (hoje)" via GET /api/sent-today
         (ao abrir a aba, ao iniciar e ao encerrar um loop)
       • Evita duplicar linhas no feed com um set de chaves
*/

(() => {
  const API_BASE = (window.API_BASE_URL !== undefined ? window.API_BASE_URL : "");
  let es = null;
  let lastSlug = null;
  let quotaTimer = null;

  // Estado para controle de exibição dos próximos envios.
  let plannedExpanded = false;
  let plannedData = [];

  // Chaves já exibidas no feed (evita duplicar)
  // chave = phone|YYYY-MM-DD|status
  const feedKeys = new Set();

  // ---- util DOM ----
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
  const fmtDT = (iso) => { try { return new Date(iso).toLocaleString("pt-BR"); } catch { return iso || ""; } };
  const fmtT  = (iso) => { try { return new Date(iso).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}); } catch { return iso || ""; } };

  function currentSlug() {
    const t = $("#clientTitle")?.textContent?.trim();
    if (t && t !== "—") return t;
    const active = $("#clientList .active");
    if (active) return active.dataset.slug || active.textContent.trim();
    return null;
  }

  // ---- UI updates (usa seus elementos existentes) ----
  function setQuota({cap=30, sent=0, remaining=null}) {
    const capEl = $("#quota-cap");
    const sentEl = $("#quota-sent");
    const remEl = $("#quota-remaining");
    const fill = $("#quota-fill");
    const upd = $("#quota-updated");

    if (capEl) capEl.textContent = cap;
    if (sentEl) sentEl.textContent = sent;
    if (remEl && remaining != null) remEl.textContent = remaining;
    if (fill) fill.style.width = `${cap>0 ? Math.min(100, Math.max(0,(sent/cap)*100)) : 0}%`;
    if (upd) upd.textContent = new Date().toLocaleString("pt-BR");
  }

  function setPlanned(list=[]) {
    const ul = $("#planned-list");
    if (!ul) return;
    plannedData = Array.isArray(list) ? list : [];
    if (!plannedData.length) {
      ul.innerHTML = `<li class="muted">sem agendamentos ainda…</li>`;
      return;
    }
    if (plannedExpanded) {
      renderPlannedFull(plannedData);
    } else {
      renderPlannedCompact(plannedData);
    }
  }

  // Helpers para formatar horários relativos (em minutos) e HH:MM
  function relMinutes(iso) {
    try {
      const now = Date.now();
      const t = new Date(iso).getTime();
      const diff = Math.round((t - now) / 60000);
      if (diff <= 0) return "agora";
      if (diff === 1) return "em 1 min";
      return `em ${diff} min`;
    } catch {
      return "";
    }
  }
  function hhmm(iso) {
    try {
      return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso || "";
    }
  }

  // Renderização compacta: mostra o próximo envio e duas pílulas
  function renderPlannedCompact(list) {
    const ul = $("#planned-list");
    if (!ul) return;
    ul.innerHTML = "";
    const top3 = list.slice(0, 3);

    const liNext = document.createElement("li");
    liNext.className = "planned-next";
    liNext.innerHTML = `
      <span class="time">${hhmm(top3[0])}</span>
      <span class="rel muted">${relMinutes(top3[0])}</span>
    `;
    ul.appendChild(liNext);

    if (top3.length > 1) {
      const liPills = document.createElement("li");
      liPills.className = "pill-row";
      for (let i = 1; i < top3.length; i++) {
        const span = document.createElement("span");
        span.className = "pill";
        span.textContent = hhmm(top3[i]);
        span.title = relMinutes(top3[i]);
        liPills.appendChild(span);
      }
      ul.appendChild(liPills);
    }

    const remain = list.length - top3.length;
    if (remain > 0) {
      const liToggle = document.createElement("li");
      liToggle.innerHTML = `<button type="button" class="planned-toggle">ver todos (+${remain})</button>`;
      liToggle.querySelector("button").addEventListener("click", () => {
        plannedExpanded = true;
        renderPlannedFull(plannedData);
      });
      ul.appendChild(liToggle);
    }
  }

  // Renderização completa: lista todos os horários com scroll
  function renderPlannedFull(list) {
    const ul = $("#planned-list");
    if (!ul) return;
    ul.innerHTML = "";
    const box = document.createElement("div");
    box.className = "planned-all";
    const inner = document.createElement("ul");
    inner.className = "planned-list";
    list.forEach((iso, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${hhmm(iso)}</span><span class="muted">#${i+1}</span>`;
      inner.appendChild(li);
    });
    box.appendChild(inner);
    const liToggle = document.createElement("li");
    liToggle.innerHTML = `<button type="button" class="planned-toggle">mostrar menos</button>`;
    liToggle.querySelector("button").addEventListener("click", () => {
      plannedExpanded = false;
      renderPlannedCompact(plannedData);
    });
    const hostLi = document.createElement("li");
    hostLi.appendChild(box);
    ul.appendChild(hostLi);
    ul.appendChild(liToggle);
  }

  // --- Feed (com controle de duplicidade e opção de append/prepend) ---
  function feedKey(phone, at, status) {
    const day = (() => { try { return new Date(at).toISOString().slice(0,10); } catch { return ""; }})();
    return `${phone || "-"}|${day}|${status || "-"}`;
  }

  function pushFeed({at, name, phone, status}, { prepend = true } = {}) {
    const host = $("#progress-feed");
    if (!host) return;

    // evita duplicar
    const key = feedKey(phone, at, status);
    if (feedKeys.has(key)) return;
    feedKeys.add(key);

    const row = document.createElement("div");
    row.className = "item";
    const cls = status === "success" ? "success" : (status === "skipped" ? "skipped" : "error");
    row.innerHTML = `
      <div class="when">${fmtDT(at)}</div>
      <div><span class="who">${esc(name || "-")}</span> <span class="muted">${esc(phone || "-")}</span></div>
      <div class="status ${cls}">${status}</div>`;

    if (prepend) host.prepend(row); else host.appendChild(row);

    const last = $("#last-event");
    if (last && prepend) {
      last.innerHTML = `${fmtDT(at)} • <strong>${esc(name || "-")}</strong> <span class="muted">${esc(phone || "-")}</span> — <span class="status ${cls}">${status}</span>`;
    }
  }

  function clearFeed() {
    const host = $("#progress-feed");
    if (host) host.innerHTML = `<div class="muted">Aguardando eventos…</div>`;
    feedKeys.clear();
  }

  // ---- Quota fetch ----
  function refreshQuota(debounceMs=0) {
    const slug = currentSlug();
    if (!slug) return;
    if (quotaTimer) clearTimeout(quotaTimer);
    quotaTimer = setTimeout(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/quota?client=${encodeURIComponent(slug)}`);
        if (!r.ok) return;
        const j = await r.json();
        setQuota({ cap: j.cap ?? 30, sent: (j.cap ?? 30) - (j.remaining ?? 0), remaining: j.remaining ?? 0 });
      } catch {}
    }, debounceMs);
  }

  // ---- Pré-carregar "Enviados (hoje)" no FEED ----
  async function loadSentTodayIntoFeed(limit = 100) {
    const slug = currentSlug();
    if (!slug) return;
    try {
      const r = await fetch(`${API_BASE}/api/sent-today?client=${encodeURIComponent(slug)}&limit=${limit}`);
      if (!r.ok) return;
      const j = await r.json();
      const items = Array.isArray(j.items) ? j.items : [];

      // Inserimos do mais antigo para o mais novo, para que os SSE novos fiquem no topo depois
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        pushFeed(
          { at: it.updated_at, name: it.name || "-", phone: it.phone || "-", status: "success" },
          { prepend: false }
        );
      }
    } catch {}
  }

  // ---- SSE ----
  function connect(force=false) {
    const slug = currentSlug();
    if (!slug) return;
    if (!force && es && lastSlug === slug) return;
    disconnect();

    lastSlug = slug;
    const url = `${API_BASE}/api/progress?client=${encodeURIComponent(slug)}`;
    es = new EventSource(url);

    es.addEventListener("open", () => {
      refreshQuota(0);
      // Ao abrir a conexão, também pré-carrega o histórico de HOJE
      loadSentTodayIntoFeed(100);
    });

    es.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data || "{}");
        handleEvent(data);
      } catch {}
    });
    es.addEventListener("error", () => {
      disconnect();
      setTimeout(() => { if (currentSlug()) connect(true); }, 3000);
    });
  }

  function disconnect() {
    if (es) { try { es.close(); } catch {} }
    es = null;
  }

  function handleEvent(evt) {
    const type = evt?.type || "item";
    if (type === "start") {
      clearFeed();
      // Mostra o que já foi enviado hoje ANTES dos novos eventos
      loadSentTodayIntoFeed(100);
      refreshQuota(0);
      return;
    }
    if (type === "schedule") {
      setPlanned(Array.isArray(evt.planned) ? evt.planned : []);
      if (typeof evt.remainingToday === "number" && typeof evt.cap === "number") {
        setQuota({ cap: evt.cap, sent: Math.max(0, evt.cap - evt.remainingToday), remaining: evt.remainingToday });
      }
      return;
    }
    if (type === "item") {
      pushFeed({
        at: evt.at || new Date().toISOString(),
        name: evt.name || "-",
        phone: evt.phone || "-",
        status: evt.status || (evt.ok ? "success" : "error")
      }, { prepend: true });
      refreshQuota(300);
      return;
    }
    if (type === "end") {
      // Atualiza a cota e puxa o estado final de hoje (caso algo tenha sido enviado perto do fim)
      refreshQuota(0);
      loadSentTodayIntoFeed(100);
      return;
    }
  }

  // ---- integração com as suas tabs ----
  function setupTabHooks() {
    const btn = document.getElementById("tabButtonProgress");
    if (btn) {
      btn.addEventListener("click", () => {
        setTimeout(() => { connect(true); }, 50);
      });
    }
  }

  // ---- integração com o botão "Executar Loop" ----
  function setupRunHook() {
    const run = document.getElementById("btnRunLoop");
    if (run) {
      run.addEventListener("click", () => {
        setTimeout(() => { connect(true); refreshQuota(300); }, 500);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (document.getElementById("tab-progress")) {
      setupTabHooks();
      setupRunHook();
      const active = document.querySelector('.tab-btn.active[data-tab="progress"]');
      if (active) connect(true);
    }
  });

  // disponibiliza para debug
  window.ProgressAddon = { connect: () => connect(true), disconnect, refreshQuota };
})();
