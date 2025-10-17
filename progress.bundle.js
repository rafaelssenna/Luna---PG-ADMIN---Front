/* progress.bundle.js — Add-on "somente adiciona" para a aba PROGRESSO (SSE)
 * Funciona com o back que expõe:
 *   - GET  /api/progress?client=:slug      (SSE)
 *   - GET  /api/quota?client=:slug
 *   - GET  /api/stats?client=:slug         (opcional, não usado aqui)
 *   - POST /api/loop   { client }          (opcional, botão "Executar agora")
 *
 * Não remove NADA do seu front. Injeta CSS, botão de aba e a seção #tab-progress.
 * Integra com seu tema (classes .tabs, .tab-btn, .tab, .tab-hidden) se existirem;
 * se não existirem, aplica um fallback visual consistente.
 */

(() => {
  const API_BASE = ""; // mesmo host do back. Se usar domínio diferente, coloque aqui.
  const STYLE_ID = "luna-progress-style";
  const TAB_ID = "tab-progress";
  const BTN_ID = "btn-tab-progress";
  const BTN_TEXT = "Progresso";

  let es = null;              // EventSource
  let quotaTimer = null;      // debounce quota
  let lastSlug = null;        // slug usado na conexão atual

  /* ===================== CSS (injetado) ===================== */
  const CSS = `
:root{
  --lp-border:#1e293b; --lp-panel:#0f172a; --lp-bg:#0b1020; --lp-text:#e2e8f0;
  --lp-muted:#94a3b8; --lp-ok:#10b981; --lp-cyan:#22d3ee; --lp-danger:#ef4444;
}
#${TAB_ID}{ display:block }
.luna-card{ background:var(--lp-panel); border:1px solid var(--lp-border); border-radius:12px; padding:12px }
.luna-card-title{ font-weight:600; margin-bottom:8px }
.luna-grid{ display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:12px; margin-bottom:12px }
@media(max-width:1100px){ .luna-grid{ grid-template-columns: 1fr } }
.luna-muted{ color:var(--lp-muted) }
.luna-quota{ display:grid; grid-template-columns: 1fr auto; gap:10px; align-items:center }
.luna-bar{ width:100%; height:10px; background:#1e293b; border-radius:999px; overflow:hidden }
.luna-bar-fill{ height:100%; background:var(--lp-ok); width:0%; transition:width .4s ease }
.luna-list{ list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:6px; max-height:220px; overflow:auto }
.luna-list li{ padding:8px 10px; border-radius:8px; background:#0b1220; border:1px solid var(--lp-border); display:flex; justify-content:space-between; align-items:center }
.luna-feed{ max-height:420px; overflow:auto; display:flex; flex-direction:column; gap:8px }
.luna-feed-item{ display:grid; grid-template-columns: 160px 1fr auto; gap:10px; align-items:center; padding:10px 12px; background:#0b1220; border:1px solid var(--lp-border); border-radius:10px; }
.luna-feed-item .when{ color:var(--lp-muted); white-space:nowrap }
.luna-feed-item .who{ font-weight:600 }
.luna-feed-item .phone{ color:var(--lp-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.luna-chip{ font-size:.75rem; padding:2px 8px; border-radius:999px; border:1px solid transparent }
.luna-chip.ok{ background: rgba(16,185,129,.12); color:#10b981; border-color: rgba(16,185,129,.25) }
.luna-chip.err{ background: rgba(239,68,68,.12); color:#ef4444; border-color: rgba(239,68,68,.25) }
.luna-chip.skip{ background: rgba(148,163,184,.12); color:#94a3b8; border-color: rgba(148,163,184,.25) }

/* Fallback para tabs se sua app não usar .tab / .tab-hidden */
.luna-tab-hidden{ display:none !important }

/* Botões */
.luna-btn{ padding:8px 12px; border-radius:8px; border:1px solid var(--lp-border); background:#0b1220; color:var(--lp-text); cursor:pointer }
.luna-btn.primary{ background:#10b981; color:#032; border-color:#064e3b }
.luna-actions{ display:flex; gap:8px; align-items:center; justify-content:flex-end; margin-bottom:8px }
  `.trim();

  /* ===================== Utils DOM ===================== */
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m]));
  const fmtDT = (iso) => { try{ return new Date(iso).toLocaleString(); }catch{ return iso||"" } };
  const fmtT  = (iso) => { try{ return new Date(iso).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) }catch{ return iso||"" } };

  function getCurrentSlug() {
    // 1) #clientTitle (printado nas suas telas)
    const t = $("#clientTitle")?.textContent?.trim();
    if (t) return t;

    // 2) item ativo na lista de clientes
    const activeItem = $(".client-item.active .client-name") || $("#clientList .client-item.active");
    if (activeItem) return activeItem.textContent.trim();

    // 3) querystring ?client=
    const q = new URLSearchParams(location.search).get("client");
    if (q) return q.trim();

    return null;
  }

  function ensureStyle() {
    if ($( "#" + STYLE_ID )) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function findTabsContainer() {
    // Tenta localizar sua barra de tabs existente
    return $(".tabs") || $("nav[role='tablist']") || $("nav") || $(".page-head");
  }

  function createTabButtonIfNeeded() {
    if ($("#" + BTN_ID)) return $("#" + BTN_ID);
    const tabs = findTabsContainer();
    if (!tabs) return null;

    // clone estilo do primeiro botão
    const refBtn = $(".tabs .tab-btn") || $(".tab-btn") || $(".btn");
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.textContent = BTN_TEXT;

    // Usa as classes reais se existirem, senão fallback
    const cls = refBtn ? refBtn.className : "tab-btn luna-btn";
    btn.className = cls.includes("tab-btn") ? cls : `tab-btn ${cls}`;
    btn.dataset.tab = "progress";
    btn.addEventListener("click", () => showProgressTab());

    // Insere ao final da barra de tabs
    tabs.appendChild(btn);
    return btn;
  }

  function createTabSectionIfNeeded() {
    let sec = $("#" + TAB_ID);
    if (sec) return sec;

    // acha container principal para anexar a seção
    const main = $(".main") || $("main") || $("#app") || document.body;

    sec = document.createElement("section");
    sec.id = TAB_ID;
    sec.className = "tab"; // se sua app usa .tab / .tab-hidden, vai funcionar; senão usamos o fallback CSS
    sec.style.marginTop = "6px";

    sec.innerHTML = `
      <div class="luna-actions">
        <button id="lp-run-loop" class="luna-btn primary" title="Iniciar processamento agora">▶️ Executar agora</button>
        <button id="lp-refresh-quota" class="luna-btn" title="Atualizar cota">⟳ Atualizar</button>
      </div>

      <div class="luna-grid">
        <div class="luna-card">
          <div class="luna-card-title">Cota de Hoje</div>
          <div class="luna-quota">
            <div class="luna-bar"><div id="lp-quota-fill" class="luna-bar-fill"></div></div>
            <div>
              <span id="lp-q-sent">0</span>/<span id="lp-q-cap">30</span>
              — <span id="lp-q-rem">0</span> restantes
            </div>
          </div>
          <div id="lp-q-upd" class="luna-muted" style="margin-top:6px">—</div>
        </div>

        <div class="luna-card">
          <div class="luna-card-title">Próximos envios (hoje)</div>
          <ul id="lp-planned" class="luna-list">
            <li class="luna-muted">Sem agendamentos…</li>
          </ul>
        </div>

        <div class="luna-card">
          <div class="luna-card-title">Último evento</div>
          <div id="lp-last" class="luna-muted">—</div>
        </div>
      </div>

      <div class="luna-card">
        <div class="luna-card-title">Feed em tempo real</div>
        <div id="lp-feed" class="luna-feed"><div class="luna-muted">Aguardando eventos…</div></div>
      </div>
    `.trim();

    // Esconde por padrão se sua app usa .tab / .tab-hidden
    if ($(".tab") && $(".tab-hidden")) {
      sec.classList.add("tab-hidden");
    } else {
      // fallback
      sec.classList.add("luna-tab-hidden");
    }

    main.appendChild(sec);

    // Botões da seção
    $("#lp-refresh-quota").addEventListener("click", () => refreshQuota());
    $("#lp-run-loop").addEventListener("click", async () => {
      const slug = getCurrentSlug();
      if (!slug) return alert("Selecione um cliente.");
      try {
        await fetch(`${API_BASE}/api/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client: slug }),
        });
        // garante que a aba esteja visível e conectada
        showProgressTab(true);
      } catch (e) {
        console.error(e);
        alert("Falha ao iniciar loop.");
      }
    });

    return sec;
  }

  /* ========== Exibição de abas (sem interferir na sua lógica atual) ========== */
  function hideAllTabsExceptProgress() {
    // se sua app usa .tab/.tab-hidden
    if ($(".tab")) {
      $$(".tab").forEach((el) => {
        if (el.id === TAB_ID) el.classList.remove("tab-hidden");
        else el.classList.add("tab-hidden");
      });
    } else {
      // fallback
      $$("section[id^='tab-']").forEach((el) => {
        if (el.id === TAB_ID) el.classList.remove("luna-tab-hidden");
        else el.classList.add("luna-tab-hidden");
      });
    }

    // ativa visual do botão
    const myBtn = $("#" + BTN_ID);
    if (myBtn) {
      const btns = $$(".tabs .tab-btn");
      btns.forEach((b) => b.classList && b.classList.remove("active"));
      myBtn.classList && myBtn.classList.add("active");
    }
  }

  function showProgressTab(force = false) {
    ensureStyle();
    createTabButtonIfNeeded();
    createTabSectionIfNeeded();

    hideAllTabsExceptProgress();

    // conecta SSE quando mostrar
    const slug = getCurrentSlug();
    if (!slug) {
      console.warn("[LunaProgress] Nenhum cliente selecionado.");
      return;
    }
    connectSSE(slug, force);
    refreshQuota();
  }

  /* ===================== SSE / QUOTA ===================== */
  function connectSSE(slug, force = false) {
    if (!force && es && lastSlug === slug) return; // já conectado
    disconnectSSE();
    lastSlug = slug;

    const url = `${API_BASE}/api/progress?client=${encodeURIComponent(slug)}`;
    es = new EventSource(url);

    es.onmessage = (ev) => {
      if (!ev.data) return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleEvent(msg);
    };

    es.onerror = () => {
      // reconecta simples
      disconnectSSE();
      setTimeout(() => {
        if (getCurrentSlug()) connectSSE(getCurrentSlug(), true);
      }, 3000);
    };
  }

  function disconnectSSE() {
    if (es) { try { es.close(); } catch {} }
    es = null;
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case "start":   onStart(evt);   break;
      case "schedule":onSchedule(evt);break;
      case "item":    onItem(evt);    break;
      case "end":     onEnd(evt);     break;
      default: /* ping/others */      break;
    }
  }

  function onStart({ total, at }) {
    const feed = $("#lp-feed");
    if (!feed) return;
    feed.innerHTML = `<div class="luna-muted">Iniciado • total na fila: ${total} • ${fmtDT(at)}</div>`;
    refreshQuota();
  }

  function onSchedule({ planned = [], remainingToday = null, cap = null }) {
    const ul = $("#lp-planned");
    if (!ul) return;
    ul.innerHTML = "";

    if (!planned.length) {
      ul.innerHTML = `<li class="luna-muted">Sem agendamentos…</li>`;
    } else {
      planned.slice(0, 15).forEach((iso, i) => {
        const li = document.createElement("li");
        li.innerHTML = `<span>${fmtT(iso)}</span><span class="luna-muted">#${i + 1}</span>`;
        ul.appendChild(li);
      });
      if (planned.length > 15) {
        const li = document.createElement("li");
        li.className = "luna-muted";
        li.textContent = `+ ${planned.length - 15} horários…`;
        ul.appendChild(li);
      }
    }

    if (remainingToday != null && cap != null) {
      const sent = Math.max(0, cap - remainingToday);
      updateQuotaUI({ cap, sent, remaining: remainingToday });
    }
  }

  function onItem({ name, phone, status, at }) {
    const feed = $("#lp-feed");
    if (!feed) return;

    const chip = status === "success" ? "ok" : status === "error" ? "err" : "skip";
    const row = document.createElement("div");
    row.className = "luna-feed-item";
    row.innerHTML = `
      <div class="when">${fmtDT(at)}</div>
      <div><span class="who">${esc(name || "-")}</span> <span class="phone">${esc(phone || "")}</span></div>
      <div class="luna-chip ${chip}">${status}</div>
    `;
    feed.prepend(row);

    const last = $("#lp-last");
    if (last) last.innerHTML = `${fmtDT(at)} • <strong>${esc(name || "-")}</strong> <span class="luna-muted">${esc(phone || "")}</span> — <span class="luna-chip ${chip}">${status}</span>`;

    refreshQuota(400);
  }

  function onEnd({ processed, at }) {
    const feed = $("#lp-feed");
    if (!feed) return;
    const div = document.createElement("div");
    div.className = "luna-muted";
    div.textContent = `Encerrado • processados: ${processed} • ${fmtDT(at)}`;
    feed.prepend(div);
    refreshQuota();
  }

  function updateQuotaUI({ cap = 30, sent = 0, remaining = null }) {
    const capEl = $("#lp-q-cap"), sEl = $("#lp-q-sent"), rEl = $("#lp-q-rem");
    const bar = $("#lp-quota-fill"), upd = $("#lp-q-upd");
    if (capEl) capEl.textContent = cap;
    if (sEl) sEl.textContent = sent;
    if (rEl && remaining != null) rEl.textContent = remaining;
    if (bar) bar.style.width = `${cap > 0 ? Math.min(100, Math.max(0, (sent / cap) * 100)) : 0}%`;
    if (upd) upd.textContent = new Date().toLocaleString();
  }

  function refreshQuota(delay = 0) {
    const slug = getCurrentSlug();
    if (!slug) return;
    if (quotaTimer) clearTimeout(quotaTimer);
    quotaTimer = setTimeout(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/quota?client=${encodeURIComponent(slug)}`);
        const j = await r.json();
        updateQuotaUI({ cap: j.cap, sent: j.cap - j.remaining, remaining: j.remaining });
      } catch (e) { /* silencioso */ }
    }, delay);
  }

  /* ===================== Inicialização ===================== */
  function tapIntoNavigation() {
    // Se sua barra de tabs já emite cliques, apenas ouvimos para desconectar SSE ao sair.
    const tabs = findTabsContainer();
    if (!tabs) return;
    tabs.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;

      // Se clicou no nosso botão, tratamos nós mesmos
      if (t.id === BTN_ID || t.dataset?.tab === "progress" || t.textContent?.trim() === BTN_TEXT) {
        ev.preventDefault();
        showProgressTab();
        return;
      }

      // Caso seja outra aba, desconecta SSE
      if (t.classList?.contains("tab-btn") || t.dataset?.tab) {
        disconnectSSE();
        const sec = $("#"+TAB_ID);
        if (sec) {
          // esconde nossa seção (respeitando sua infra)
          if ($(".tab") && $(".tab-hidden")) sec.classList.add("tab-hidden");
          else sec.classList.add("luna-tab-hidden");
        }
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    ensureStyle();
    createTabButtonIfNeeded();
    createTabSectionIfNeeded();
    tapIntoNavigation();
    // não abrimos automaticamente; o usuário clica na aba "Progresso"
  });

  // Exponha uma API global opcional (debug)
  window.LunaProgress = {
    show: showProgressTab,
    refreshQuota,
    connect: () => { const s = getCurrentSlug(); if (s) connectSSE(s, true); },
    disconnect: disconnectSSE,
  };
})();
