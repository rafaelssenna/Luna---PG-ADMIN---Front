/* progress.bundle.js — Modo COMPATÍVEL com a sua aba "Progresso"
   - Não injeta UI se #tab-progress já existe (usa seus elementos)
   - Conecta ao SSE:  GET /api/progress?client=:slug
   - Atualiza cota:   GET /api/quota?client=:slug
   - Atualiza elementos existentes:
       #quota-fill, #quota-sent, #quota-cap, #quota-remaining, #quota-updated
       #planned-list, #last-event, #progress-feed
   - Integra com suas tabs (mostra dados ao abrir a aba Progresso)
*/

(() => {
  const API_BASE = (window.API_BASE_URL !== undefined ? window.API_BASE_URL : "");
  let es = null;
  let lastSlug = null;
  let quotaTimer = null;

  // Estado para controle de exibição dos próximos envios.  
  // plannedExpanded indica se a lista completa está visível.
  // plannedData armazena a lista completa recebida do backend.
  let plannedExpanded = false;
  let plannedData = [];

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
    // Armazena a lista para alternar entre compacto e completo
    plannedData = Array.isArray(list) ? list : [];
    if (!plannedData.length) {
      ul.innerHTML = `<li class="muted">sem agendamentos ainda…</li>`;
      return;
    }
    // Quando existir dados, renderiza conforme o estado atual
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

  // Renderização compacta: mostra o próximo envio em destaque e dois seguintes como pílulas
  function renderPlannedCompact(list) {
    const ul = $("#planned-list");
    if (!ul) return;
    ul.innerHTML = "";
    const top3 = list.slice(0, 3);

    // Principal: próximo envio
    const liNext = document.createElement("li");
    liNext.className = "planned-next";
    liNext.innerHTML = `
      <span class="time">${hhmm(top3[0])}</span>
      <span class="rel muted">${relMinutes(top3[0])}</span>
    `;
    ul.appendChild(liNext);

    // Segunda linha: pílulas para os próximos dois
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

    // Botão para expandir lista completa
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
    // Caixa rolável contendo a lista completa
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

    // Botão para reduzir lista
    const liToggle = document.createElement("li");
    liToggle.innerHTML = `<button type="button" class="planned-toggle">mostrar menos</button>`;
    liToggle.querySelector("button").addEventListener("click", () => {
      plannedExpanded = false;
      renderPlannedCompact(plannedData);
    });

    // Inserir no host
    const hostLi = document.createElement("li");
    hostLi.appendChild(box);
    ul.appendChild(hostLi);
    ul.appendChild(liToggle);
  }

  function pushFeed({at, name, phone, status}) {
    const host = $("#progress-feed");
    if (!host) return;
    const row = document.createElement("div");
    row.className = "item";
    const cls = status === "success" ? "success" : (status === "skipped" ? "skipped" : "error");
    row.innerHTML = `
      <div class="when">${fmtDT(at)}</div>
      <div><span class="who">${esc(name || "-")}</span> <span class="muted">${esc(phone || "-")}</span></div>
      <div class="status ${cls}">${status}</div>`;
    host.prepend(row);
    const last = $("#last-event");
    if (last) last.innerHTML =
      `${fmtDT(at)} • <strong>${esc(name || "-")}</strong> <span class="muted">${esc(phone || "-")}</span> — <span class="status ${cls}">${status}</span>`;
  }

  function clearFeed() {
    const host = $("#progress-feed");
    if (host) host.innerHTML = `<div class="muted">Aguardando eventos…</div>`;
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

  // ---- SSE ----
  function connect(force=false) {
    const slug = currentSlug();
    if (!slug) return;
    if (!force && es && lastSlug === slug) return;
    disconnect();

    lastSlug = slug;
    const url = `${API_BASE}/api/progress?client=${encodeURIComponent(slug)}`;
    es = new EventSource(url);

    es.addEventListener("open", () => refreshQuota(0));
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
      });
      refreshQuota(300);
      return;
    }
    if (type === "end") {
      refreshQuota(0);
      return;
    }
  }

  // ---- integração com as suas tabs ----
  function setupTabHooks() {
    // Abre conexão quando clicar em "Progresso"
    const btn = document.getElementById("tabButtonProgress");
    if (btn) {
      btn.addEventListener("click", () => {
        // apenas ao mostrar a aba
        setTimeout(() => { connect(true); }, 50);
      });
    }

    // Se clicar em qualquer outra aba, não precisamos derrubar a conexão (pode desejar ver feed em background),
    // mas reduzimos reconexões desnecessárias reiniciando apenas quando a aba Progresso for aberta de novo.
  }

  // ---- integração com o botão "Executar Loop" (garante que o feed esteja visível) ----
  function setupRunHook() {
    const run = document.getElementById("btnRunLoop");
    if (run) {
      run.addEventListener("click", () => {
        // após o backend iniciar, conectamos/atualizamos o feed
        setTimeout(() => { connect(true); refreshQuota(300); }, 500);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    // se a aba já existir, opera em modo compatível
    if (document.getElementById("tab-progress")) {
      setupTabHooks();
      setupRunHook();
      // opcional: se a aba Progresso já estiver ativa no carregamento
      const active = document.querySelector('.tab-btn.active[data-tab="progress"]');
      if (active) connect(true);
    } else {
      // fallback: se no futuro remover a aba, não fazemos nada (modo seguro)
    }
  });

  // disponibiliza para debug
  window.ProgressAddon = { connect: () => connect(true), disconnect, refreshQuota };
})();
