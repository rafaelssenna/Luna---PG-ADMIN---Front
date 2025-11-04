/* utils.js — Utilitários e helpers reutilizáveis para Luna PG-Admin */

/* ====== Debouncing ====== */
/**
 * Cria uma função debounced que atrasa a execução até que tenha passado
 * o tempo especificado desde a última chamada.
 * @param {Function} func - Função a ser debounced
 * @param {number} wait - Tempo de espera em ms
 * @returns {Function} Função debounced
 */
export function debounce(func, wait = 300) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/* ====== Throttling ====== */
/**
 * Cria uma função throttled que só executa no máximo uma vez por intervalo
 * @param {Function} func - Função a ser throttled
 * @param {number} limit - Intervalo mínimo entre execuções em ms
 * @returns {Function} Função throttled
 */
export function throttle(func, limit = 1000) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

/* ====== Retry com backoff exponencial ====== */
/**
 * Tenta executar uma função assíncrona com retry automático
 * @param {Function} fn - Função async a executar
 * @param {number} maxRetries - Número máximo de tentativas
 * @param {number} delay - Delay inicial em ms
 * @returns {Promise} Resultado da função ou erro final
 */
export async function retryWithBackoff(fn, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      const waitTime = delay * Math.pow(2, i);
      console.log(`Tentativa ${i + 1} falhou. Aguardando ${waitTime}ms antes de tentar novamente...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

/* ====== Validações ====== */
/**
 * Valida um slug de cliente (minúsculas, números, underscore)
 * @param {string} slug - Slug a validar
 * @returns {boolean} True se válido
 */
export function isValidSlug(slug) {
  return /^[a-z0-9_]{1,64}$/.test(String(slug || "").trim());
}

/**
 * Valida um número de telefone brasileiro
 * @param {string} phone - Telefone a validar
 * @returns {boolean} True se válido
 */
export function isValidPhone(phone) {
  const cleaned = String(phone || "").replace(/\D/g, "");
  return cleaned.length >= 10 && cleaned.length <= 11;
}

/**
 * Valida email
 * @param {string} email - Email a validar
 * @returns {boolean} True se válido
 */
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

/**
 * Valida URL
 * @param {string} url - URL a validar
 * @returns {boolean} True se válido
 */
export function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/* ====== Formatação ====== */
/**
 * Formata número de telefone brasileiro
 * @param {string} phone - Telefone a formatar
 * @returns {string} Telefone formatado
 */
export function formatPhone(phone) {
  const cleaned = String(phone || "").replace(/\D/g, "");
  if (cleaned.length === 11) {
    return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 7)}-${cleaned.slice(7)}`;
  } else if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 6)}-${cleaned.slice(6)}`;
  }
  return phone;
}

/**
 * Formata data para padrão brasileiro
 * @param {Date|string|number} date - Data a formatar
 * @returns {string} Data formatada
 */
export function formatDate(date) {
  if (!date) return "—";
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString("pt-BR");
}

/**
 * Formata data e hora para padrão brasileiro
 * @param {Date|string|number} date - Data a formatar
 * @returns {string} Data e hora formatadas
 */
export function formatDateTime(date) {
  if (!date) return "—";
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date);
  return d.toLocaleString("pt-BR");
}

/**
 * Formata tempo relativo (ex: "há 5 minutos")
 * @param {Date|string|number} date - Data a formatar
 * @returns {string} Tempo relativo
 */
export function formatRelativeTime(date) {
  if (!date) return "—";
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date);
  
  const now = new Date();
  const diffMs = now - d;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  
  if (diffSec < 60) return "agora mesmo";
  if (diffMin < 60) return `há ${diffMin} minuto${diffMin !== 1 ? 's' : ''}`;
  if (diffHour < 24) return `há ${diffHour} hora${diffHour !== 1 ? 's' : ''}`;
  if (diffDay < 7) return `há ${diffDay} dia${diffDay !== 1 ? 's' : ''}`;
  return formatDate(d);
}

/* ====== Storage helpers ====== */
/**
 * Salva item no localStorage com tratamento de erro
 * @param {string} key - Chave
 * @param {any} value - Valor a salvar
 * @returns {boolean} True se salvou com sucesso
 */
export function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error("Erro ao salvar no localStorage:", e);
    return false;
  }
}

/**
 * Recupera item do localStorage com tratamento de erro
 * @param {string} key - Chave
 * @param {any} defaultValue - Valor padrão se não encontrado
 * @returns {any} Valor recuperado ou padrão
 */
export function storageGet(key, defaultValue = null) {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch (e) {
    console.error("Erro ao ler do localStorage:", e);
    return defaultValue;
  }
}

/**
 * Remove item do localStorage
 * @param {string} key - Chave
 * @returns {boolean} True se removeu com sucesso
 */
export function storageRemove(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (e) {
    console.error("Erro ao remover do localStorage:", e);
    return false;
  }
}

/* ====== DOM helpers ====== */
/**
 * Cria elemento HTML de forma mais fácil
 * @param {string} tag - Tag HTML
 * @param {Object} attrs - Atributos
 * @param {string|HTMLElement[]} children - Conteúdo
 * @returns {HTMLElement} Elemento criado
 */
export function createElement(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === "className") el.className = value;
    else if (key === "style" && typeof value === "object") {
      Object.assign(el.style, value);
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      el.setAttribute(key, value);
    }
  });
  
  if (typeof children === "string") {
    el.textContent = children;
  } else if (Array.isArray(children)) {
    children.forEach(child => {
      if (typeof child === "string") {
        el.appendChild(document.createTextNode(child));
      } else if (child instanceof HTMLElement) {
        el.appendChild(child);
      }
    });
  }
  
  return el;
}

/**
 * Escapa HTML para prevenir XSS
 * @param {string} str - String a escapar
 * @returns {string} String escapada
 */
export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ====== Array/Object helpers ====== */
/**
 * Agrupa array de objetos por chave
 * @param {Array} array - Array a agrupar
 * @param {string} key - Chave para agrupar
 * @returns {Object} Objeto agrupado
 */
export function groupBy(array, key) {
  return array.reduce((result, item) => {
    const group = item[key];
    if (!result[group]) result[group] = [];
    result[group].push(item);
    return result;
  }, {});
}

/**
 * Remove duplicatas de array
 * @param {Array} array - Array com duplicatas
 * @param {string} key - Chave para comparação (opcional)
 * @returns {Array} Array sem duplicatas
 */
export function unique(array, key = null) {
  if (!key) return [...new Set(array)];
  const seen = new Set();
  return array.filter(item => {
    const val = item[key];
    if (seen.has(val)) return false;
    seen.add(val);
    return true;
  });
}

/**
 * Deep clone de objeto
 * @param {Object} obj - Objeto a clonar
 * @returns {Object} Clone profundo
 */
export function deepClone(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (obj instanceof Array) return obj.map(item => deepClone(item));
  if (obj instanceof Object) {
    const cloned = {};
    Object.keys(obj).forEach(key => {
      cloned[key] = deepClone(obj[key]);
    });
    return cloned;
  }
  return obj;
}

/* ====== Clipboard ====== */
/**
 * Copia texto para clipboard
 * @param {string} text - Texto a copiar
 * @returns {Promise<boolean>} True se copiou com sucesso
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // Fallback para navegadores antigos
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      document.body.removeChild(textarea);
      return true;
    } catch (err) {
      document.body.removeChild(textarea);
      return false;
    }
  }
}

/* ====== URL helpers ====== */
/**
 * Obtém parâmetros da URL
 * @returns {Object} Objeto com parâmetros
 */
export function getUrlParams() {
  const params = {};
  const searchParams = new URLSearchParams(window.location.search);
  for (const [key, value] of searchParams) {
    params[key] = value;
  }
  return params;
}

/**
 * Atualiza parâmetros da URL sem recarregar
 * @param {Object} params - Parâmetros a atualizar
 */
export function updateUrlParams(params) {
  const url = new URL(window.location);
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  });
  window.history.replaceState({}, "", url);
}

/* ====== Performance ====== */
/**
 * Executa callback quando elemento entra na viewport
 * @param {HTMLElement} element - Elemento a observar
 * @param {Function} callback - Callback a executar
 * @param {Object} options - Opções do IntersectionObserver
 * @returns {IntersectionObserver} Observer criado
 */
export function onVisible(element, callback, options = {}) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        callback(entry);
      }
    });
  }, options);
  
  observer.observe(element);
  return observer;
}

/**
 * Carrega imagem de forma lazy
 * @param {HTMLImageElement} img - Elemento img
 * @param {string} src - URL da imagem
 */
export function lazyLoadImage(img, src) {
  if ("loading" in HTMLImageElement.prototype) {
    img.loading = "lazy";
    img.src = src;
  } else {
    onVisible(img, () => {
      img.src = src;
    });
  }
}

/* ====== Error tracking ====== */
const errorLog = [];

/**
 * Registra erro no log
 * @param {Error|string} error - Erro a registrar
 * @param {Object} context - Contexto adicional
 */
export function logError(error, context = {}) {
  const errorEntry = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
    timestamp: new Date().toISOString(),
    context,
    url: window.location.href,
    userAgent: navigator.userAgent
  };
  
  errorLog.push(errorEntry);
  console.error("Erro capturado:", errorEntry);
  
  // Mantém apenas os últimos 50 erros
  if (errorLog.length > 50) {
    errorLog.shift();
  }
}

/**
 * Obtém log de erros
 * @returns {Array} Array de erros
 */
export function getErrorLog() {
  return [...errorLog];
}

/**
 * Limpa log de erros
 */
export function clearErrorLog() {
  errorLog.length = 0;
}
