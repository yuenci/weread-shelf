// ==UserScript==
// @name         WeRead Local Topic Shelf
// @namespace    local.weread.topic-shelf
// @version      0.3.6
// @description  Add topic groups, reading context notes, and optional Cloudflare KV sync to WeRead shelf.
// @match        *://weread.qq.com/web/shelf*
// @run-at       document-end
// @updateURL    https://github.com/yuenci/weread-shelf/raw/refs/heads/master/weread-local-topic-shelf.user.js
// @downloadURL  https://github.com/yuenci/weread-shelf/raw/refs/heads/master/weread-local-topic-shelf.user.js
// @grant        GM_xmlhttpRequest
// @connect      workers.dev
// ==/UserScript==

(function () {
  "use strict";

  const STORE = {
    groups: "weread_local_topic_shelf_groups_v1",
    notes: "weread_local_book_context_notes_v1",
    cloudConfig: "weread_cloud_sync_config_v1",
    syncMeta: "weread_cloud_sync_meta_v1",
    obsidianCache: "weread_obsidian_catalog_cache_v1",
  };

  const DEFAULT_CLOUD_BASE_URL = "";
  const CLOUD_SCHEMA_VERSION = 2;
  const CLOUD_PUSH_DELAY = 1800;
  const CLOUD_PULL_INTERVAL = 5 * 60 * 1000;

  const SELECTORS = {
    shelfList: ".shelf_list",
    shelfBook: '.shelf_list a.shelfBook[href*="/web/reader/"]',
    bookTitle: ".title",
    bookCover: "img",
  };

  const state = {
    books: [],
    groups: [],
    notes: {},
    db: null,
    selectedGroupId: "",
    formMode: "",
    editingGroupId: "",
    selectedBookIds: new Set(),
    bookFilter: "",
    lastShelfSignature: "",
    entryObserver: null,
    entryRepairTimer: 0,
    storageReady: false,
    storagePromise: null,
    listenersBound: false,
    cloudConfig: {
      enabled: false,
      baseUrl: DEFAULT_CLOUD_BASE_URL,
      token: "",
      key: "",
    },
    syncMeta: null,
    syncStatus: "未配置",
    syncStatusType: "idle",
    syncInFlight: null,
    syncQueued: false,
    cloudPushTimer: 0,
    lastCloudPullAt: 0,
    panelTab: "groups",
    catalogFilter: "in",
    catalogQuery: "",
    catalogLoading: false,
    obsidianCache: {
      books: [],
      contexts: {},
      stats: null,
      resolvedAt: "",
      cached: false,
      error: "",
    },
  };

  const text = {
    floatingButton: "主题阅读",
    panelTitle: "主题阅读 / 我的书架",
    panelSubTitle: "数据优先保存在本机；开启云同步后可在不同设备间自动同步。",
    newGroup: "新建主题",
    refreshShelf: "刷新书架显示",
    loadFullShelf: "加载完整书架",
    close: "关闭",
    groups: "主题组",
    detail: "主题详情",
    recognized: (count) => `当前识别到 ${count} 本书`,
    noGroups: "还没有主题组。",
    noGroupSelected: "选择一个主题组查看详情，或新建一个主题。",
    groupName: "主题名称",
    groupDescription: "主题描述 / 阅读上下文",
    chooseBooks: "选择书籍",
    create: "创建",
    save: "保存",
    cancel: "取消",
    edit: "编辑",
    deleteGroup: "删除主题",
    remove: "移除",
    note: "描述",
    openReader: "进入阅读",
    bookNoteTitle: "书籍阅读上下文",
    whyRead: "我为什么读这本书？它在我的思想地图里承担什么角色？",
    status: "阅读状态 / 动机",
    question: "阅读问题",
    deleteNote: "删除描述",
    saved: "已保存",
    emptyName: "请填写主题名称。",
    emptyBooks: "请至少选择一本书。",
    deleteConfirm: "确定删除这个主题吗？组内书籍会回到普通书架。",
    loading: "正在加载书架...",
    cloudSync: "云同步",
    syncNow: "立即同步",
    cloudSettingsTitle: "Cloudflare KV 云同步",
    catalog: "书目匹配",
  };

  const DB_NAME = "weread_local_topic_shelf_db";
  const DB_VERSION = 1;
  const DB_STORE = "kv";

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createDeviceId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `device_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function defaultSyncMeta() {
    return {
      deviceId: createDeviceId(),
      dirty: false,
      localUpdatedAt: "",
      lastSyncedAt: "",
      tombstones: {
        groups: {},
        notes: {},
      },
    };
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbGet(key, fallback) {
    const tx = state.db.transaction(DB_STORE, "readonly");
    const record = await requestToPromise(tx.objectStore(DB_STORE).get(key));
    return record ? record.value : fallback;
  }

  async function dbSet(key, value) {
    const tx = state.db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put({ key, value: cloneJson(value) });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function readLegacyLocalStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn(
        "[WeRead Local Topic Shelf] Failed to migrate localStorage:",
        key,
        error,
      );
      return fallback;
    }
  }

  async function initStorage() {
    state.db = await openDb();

    let groups = await dbGet(STORE.groups, null);
    let notes = await dbGet(STORE.notes, null);
    const cloudConfig = await dbGet(STORE.cloudConfig, null);
    const syncMeta = await dbGet(STORE.syncMeta, null);
    const obsidianCache = await dbGet(STORE.obsidianCache, null);

    if (groups === null) {
      groups = readLegacyLocalStorage(STORE.groups, []);
      await dbSet(STORE.groups, groups);
      localStorage.removeItem(STORE.groups);
    }

    if (notes === null) {
      notes = readLegacyLocalStorage(STORE.notes, {});
      await dbSet(STORE.notes, notes);
      localStorage.removeItem(STORE.notes);
    }

    state.groups = Array.isArray(groups) ? groups : [];
    state.notes = notes && typeof notes === "object" ? notes : {};
    state.cloudConfig = {
      ...state.cloudConfig,
      ...(cloudConfig && typeof cloudConfig === "object" ? cloudConfig : {}),
    };
    state.syncMeta = {
      ...defaultSyncMeta(),
      ...(syncMeta && typeof syncMeta === "object" ? syncMeta : {}),
      tombstones: {
        groups:
          syncMeta &&
          syncMeta.tombstones &&
          syncMeta.tombstones.groups &&
          typeof syncMeta.tombstones.groups === "object"
            ? syncMeta.tombstones.groups
            : {},
        notes:
          syncMeta &&
          syncMeta.tombstones &&
          syncMeta.tombstones.notes &&
          typeof syncMeta.tombstones.notes === "object"
            ? syncMeta.tombstones.notes
            : {},
      },
    };
    state.obsidianCache = {
      ...state.obsidianCache,
      ...(obsidianCache && typeof obsidianCache === "object"
        ? obsidianCache
        : {}),
      cached: Boolean(obsidianCache),
    };

    if (!syncMeta) await dbSet(STORE.syncMeta, state.syncMeta);
    updateSyncStatus(
      isCloudConfigured() ? "等待同步" : "未配置",
      isCloudConfigured() ? "pending" : "idle",
    );
  }

  async function ensureStorageReady() {
    if (state.storageReady) return;

    if (!state.storagePromise) {
      state.storagePromise = initStorage()
        .then(() => {
          state.storageReady = true;
        })
        .catch((error) => {
          console.error(
            "[WeRead Local Topic Shelf] IndexedDB init failed:",
            error,
          );
          state.storageReady = true;
        });
    }

    await state.storagePromise;
  }

  function getGroups() {
    return state.groups;
  }

  async function saveGroups(groups) {
    state.groups = groups;
    await dbSet(STORE.groups, groups);
    await markLocalChange();
  }

  function getNotes() {
    return state.notes;
  }

  function hasReadingContext(note) {
    return Boolean(
      note &&
        ["note", "status", "question"].some((field) =>
          String(note[field] || "").trim(),
        ),
    );
  }

  async function saveNotes(notes) {
    state.notes = notes;
    await dbSet(STORE.notes, notes);
    await markLocalChange();
  }

  function isCloudConfigured(config = state.cloudConfig) {
    return Boolean(
      config &&
        config.enabled &&
        config.baseUrl &&
        config.token &&
        config.key,
    );
  }

  function updateSyncStatus(message, type = "idle") {
    state.syncStatus = message;
    state.syncStatusType = type;

    document.querySelectorAll("[data-wr-sync-status]").forEach((element) => {
      const textElement = element.querySelector("[data-wr-sync-status-text]");
      if (textElement) textElement.textContent = message;
      else element.textContent = message;
      element.dataset.statusType = type;
      element.title = message;
    });
  }

  async function persistSyncMeta() {
    if (!state.syncMeta) state.syncMeta = defaultSyncMeta();
    await dbSet(STORE.syncMeta, state.syncMeta);
  }

  function scheduleCloudSync(delay = CLOUD_PUSH_DELAY) {
    window.clearTimeout(state.cloudPushTimer);
    if (!isCloudConfigured()) return;

    state.cloudPushTimer = window.setTimeout(() => {
      syncCloud({ reason: "auto" }).catch((error) => {
        console.warn("[WeRead Local Topic Shelf] automatic cloud sync failed:", error);
      });
    }, delay);
  }

  async function markLocalChange() {
    if (!state.syncMeta) state.syncMeta = defaultSyncMeta();
    state.syncMeta.dirty = true;
    state.syncMeta.localUpdatedAt = nowIso();
    await persistSyncMeta();

    if (isCloudConfigured()) {
      updateSyncStatus("本地有待同步修改", "pending");
      scheduleCloudSync();
    }
  }

  function markDeleted(type, id, deletedAt = nowIso()) {
    if (!state.syncMeta) state.syncMeta = defaultSyncMeta();
    if (!state.syncMeta.tombstones) {
      state.syncMeta.tombstones = { groups: {}, notes: {} };
    }
    if (!state.syncMeta.tombstones[type]) {
      state.syncMeta.tombstones[type] = {};
    }
    state.syncMeta.tombstones[type][id] = deletedAt;
  }

  function normalizeTombstones(value) {
    return {
      groups:
        value && value.groups && typeof value.groups === "object"
          ? value.groups
          : {},
      notes:
        value && value.notes && typeof value.notes === "object"
          ? value.notes
          : {},
    };
  }

  function normalizeBaseUrl(value) {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") {
      throw new Error("云同步地址必须使用 HTTPS。");
    }
    if (url.username || url.password) {
      throw new Error("云同步地址中不能包含用户名或密码。");
    }
    if (
      url.hostname !== "workers.dev" &&
      !url.hostname.endsWith(".workers.dev")
    ) {
      throw new Error("云同步地址必须是 Cloudflare 的 workers.dev 域名。");
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }

  function cloudApiRequest(method, config, path, body) {
    const url = `${normalizeBaseUrl(config.baseUrl)}${path}`;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 20000,
        onload(response) {
          let parsed = null;
          try {
            parsed = response.responseText
              ? JSON.parse(response.responseText)
              : null;
          } catch (error) {
            reject(new Error(`云端返回了无法解析的数据（HTTP ${response.status}）。`));
            return;
          }

          if (
            response.status < 200 ||
            response.status >= 300 ||
            !parsed ||
            parsed.success !== true
          ) {
            const details =
              parsed && Array.isArray(parsed.details)
                ? `：${parsed.details.join("；")}`
                : "";
            reject(
              new Error(
                `${(parsed && parsed.error) || `云端请求失败（HTTP ${response.status}）`}${details}`,
              ),
            );
            return;
          }

          resolve({ status: response.status, body: parsed });
        },
        onerror() {
          reject(new Error("无法连接 Cloudflare Worker。"));
        },
        ontimeout() {
          reject(new Error("连接 Cloudflare Worker 超时。"));
        },
      });
    });
  }

  async function applyWereadSyncResponse(payload) {
    const nextGroups = Array.isArray(payload.groups) ? payload.groups : [];
    const nextNotes =
      payload.notes && typeof payload.notes === "object" ? payload.notes : {};
    const nextTombstones = normalizeTombstones(payload.tombstones);
    const changed =
      JSON.stringify(state.groups) !== JSON.stringify(nextGroups) ||
      JSON.stringify(state.notes) !== JSON.stringify(nextNotes) ||
      JSON.stringify(state.syncMeta.tombstones) !==
        JSON.stringify(nextTombstones);

    state.groups = nextGroups;
    state.notes = nextNotes;
    state.syncMeta.tombstones = nextTombstones;
    if (!changed) return;

    await Promise.all([
      dbSet(STORE.groups, nextGroups),
      dbSet(STORE.notes, nextNotes),
    ]);
    if (!state.formMode && !document.getElementById("wr-topic-note-modal")) {
      refreshShelf();
    } else {
      renderShelfGroups();
      applyHiddenBooks();
      renderBookNoteIcons();
    }
  }

  function getObsidianContext(bookId) {
    return state.obsidianCache.contexts[bookId] || null;
  }

  function hasObsidianReadingContext(context) {
    return Boolean(
      context &&
        (String(context.context || "").trim() ||
          String(context.question || "").trim()),
    );
  }

  function getBookContextSummary(bookId) {
    const obsidian = getObsidianContext(bookId);
    if (hasObsidianReadingContext(obsidian)) {
      return String(obsidian.context || "").trim();
    }
    return String((getNotes()[bookId] || {}).note || "").trim();
  }

  function buildBookNote(
    existing,
    book,
    values,
    obsidianAuthoritative,
    updatedAt = nowIso(),
  ) {
    return {
      book,
      note: obsidianAuthoritative
        ? String(existing.note || "")
        : String(values.note || "").trim(),
      status: String(values.status || "").trim(),
      question: obsidianAuthoritative
        ? String(existing.question || "")
        : String(values.question || "").trim(),
      updatedAt,
    };
  }

  async function resolveObsidianCatalog({ render = true } = {}) {
    if (!isCloudConfigured()) return null;
    state.catalogLoading = true;
    if (render) renderPanel();

    try {
      const config = { ...state.cloudConfig };
      const path = `/api/v2/libraries/${encodeURIComponent(config.key)}/obsidian/resolve`;
      const result = await cloudApiRequest("POST", config, path, {
        schemaVersion: CLOUD_SCHEMA_VERSION,
        shelfBooks: state.books.map((book) => ({ id: book.id, title: book.title })),
      });
      state.obsidianCache = {
        books: Array.isArray(result.body.books) ? result.body.books : [],
        contexts:
          result.body.contexts && typeof result.body.contexts === "object"
            ? result.body.contexts
            : {},
        stats: result.body.stats || null,
        resolvedAt: result.body.resolvedAt || nowIso(),
        cached: false,
        error: "",
      };
      await dbSet(STORE.obsidianCache, state.obsidianCache);
      renderBookNoteIcons();
      return state.obsidianCache;
    } catch (error) {
      state.obsidianCache.cached = true;
      state.obsidianCache.error = error.message;
      throw error;
    } finally {
      state.catalogLoading = false;
      if (render) renderPanel();
    }
  }

  async function performCloudSync() {
    const config = { ...state.cloudConfig };
    const syncStartedLocalUpdatedAt = state.syncMeta.localUpdatedAt;
    const path = `/api/v2/libraries/${encodeURIComponent(config.key)}/weread/sync`;
    const result = await cloudApiRequest("POST", config, path, {
      schemaVersion: CLOUD_SCHEMA_VERSION,
      deviceId: state.syncMeta.deviceId,
      groups: state.groups,
      notes: state.notes,
      tombstones: state.syncMeta.tombstones,
    });
    await applyWereadSyncResponse(result.body);

    try {
      await resolveObsidianCatalog({ render: false });
    } catch (error) {
      console.warn("[WeRead Local Topic Shelf] Obsidian catalog refresh failed:", error);
    }

    state.syncMeta.dirty =
      state.syncMeta.localUpdatedAt !== syncStartedLocalUpdatedAt;
    state.syncMeta.lastSyncedAt = nowIso();
    await persistSyncMeta();
    state.lastCloudPullAt = Date.now();
    if (state.syncMeta.dirty) {
      updateSyncStatus("同步期间产生了新修改，正在继续同步", "pending");
      scheduleCloudSync(250);
    } else {
      updateSyncStatus(
        `已同步 ${new Date().toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        })}`,
        "success",
      );
    }
  }

  async function syncCloud({ reason = "manual" } = {}) {
    await ensureStorageReady();

    if (!isCloudConfigured()) {
      updateSyncStatus("未配置", "idle");
      if (reason === "manual") openCloudSettings();
      return;
    }

    if (state.syncInFlight) {
      state.syncQueued = true;
      return state.syncInFlight;
    }

    updateSyncStatus("正在同步...", "syncing");
    state.syncInFlight = performCloudSync()
      .catch((error) => {
        updateSyncStatus(`同步失败：${error.message}`, "error");
        throw error;
      })
      .finally(() => {
        state.syncInFlight = null;
        if (state.syncQueued) {
          state.syncQueued = false;
          scheduleCloudSync(250);
        }
      });

    return state.syncInFlight;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function iconSvg(name, className = "wr-topic-icon") {
    const icons = {
      cloud:
        '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
      info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
      library:
        '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
      plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
      refresh:
        '<path d="M21 12a9 9 0 0 0-15.17-6.55L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.17 6.55L21 16"/><path d="M16 16h5v5"/>',
      trash:
        '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
      x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    };
    return `<svg class="${escapeHtml(className)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ""}</svg>`;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getMountRoot() {
    if (document.body && document.body.nodeType === Node.ELEMENT_NODE) {
      return document.body;
    }

    if (
      document.documentElement &&
      document.documentElement.nodeType === Node.ELEMENT_NODE
    ) {
      return document.documentElement;
    }

    return null;
  }

  function safeAppend(parent, child, label) {
    if (!parent || typeof parent.appendChild !== "function") {
      console.warn(
        "[WeRead Local Topic Shelf] Missing mount parent:",
        label,
        parent,
      );
      return false;
    }

    try {
      parent.appendChild(child);
      return true;
    } catch (error) {
      console.error(
        "[WeRead Local Topic Shelf] append failed:",
        label,
        parent,
        error,
      );
      return false;
    }
  }

  function injectStyle() {
    if (document.getElementById("wr-local-topic-style")) return;

    const style = document.createElement("style");
    style.id = "wr-local-topic-style";
    style.textContent = `
      :root {
        --wr-topic-blue: #2f80ed;
        --wr-topic-orange: #f59e0b;
        --wr-topic-text: #1f2933;
        --wr-topic-muted: #697586;
        --wr-topic-border: #e6e9ef;
        --wr-topic-bg: #ffffff;
      }

      .wr-topic-entry {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        position: fixed;
        right: 24px;
        bottom: 28px;
        z-index: 2147483600;
        box-sizing: border-box;
        min-height: 40px;
        padding: 0 18px;
        border: 0;
        border-radius: 999px;
        background: var(--wr-topic-blue) !important;
        color: #fff !important;
        font-size: 14px;
        line-height: 1;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        box-shadow: 0 8px 24px rgba(47, 128, 237, .28);
      }

      .wr-topic-entry:hover {
        filter: brightness(.97);
      }

      .wr-topic-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483601;
        background: rgba(20, 27, 38, .28);
        display: flex;
        justify-content: flex-end;
      }

      .wr-topic-panel {
        width: min(980px, calc(100vw - 40px));
        height: 100vh;
        background: #fbfbfa;
        color: var(--wr-topic-text);
        box-shadow: -18px 0 48px rgba(15, 23, 42, .16);
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }

      .wr-topic-panel * {
        box-sizing: border-box;
      }

      .wr-topic-icon {
        width: 16px;
        height: 16px;
        display: block;
        flex: 0 0 auto;
      }

      .wr-topic-panel-header {
        position: relative;
        padding: 22px 26px 16px;
        border-bottom: 1px solid var(--wr-topic-border);
        background: #fff;
      }

      .wr-topic-header-main {
        min-width: 0;
        display: grid;
        grid-template-columns: minmax(220px, 1fr) auto minmax(300px, 1fr);
        align-items: center;
        gap: 20px;
        padding-right: 32px;
      }

      .wr-topic-header-title {
        min-width: 0;
      }

      .wr-topic-header-title p {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wr-topic-panel-title-row,
      .wr-topic-toolbar,
      .wr-topic-detail-head,
      .wr-topic-modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .wr-topic-panel h2,
      .wr-topic-panel h3 {
        margin: 0;
        font-weight: 650;
        letter-spacing: 0;
      }

      .wr-topic-panel h2 {
        font-size: 22px;
      }

      .wr-topic-panel h3 {
        font-size: 17px;
      }

      .wr-topic-panel p {
        margin: 7px 0 0;
        color: var(--wr-topic-muted);
        line-height: 1.6;
      }

      .wr-topic-shelf-tools {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
      }

      .wr-topic-header-tool {
        min-height: 34px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 0;
        border-radius: 6px;
        padding: 0 9px;
        background: transparent;
        color: #344054;
        font-size: 12px;
        white-space: nowrap;
        cursor: pointer;
      }

      .wr-topic-header-tool:hover,
      .wr-topic-header-tool:focus-visible {
        background: #eef5ff;
        color: var(--wr-topic-blue);
        outline: none;
      }

      .wr-topic-header-tool-icon {
        color: var(--wr-topic-blue);
        font-size: 15px;
        line-height: 1;
      }

      .wr-topic-header-actions {
        min-width: 0;
        display: flex;
        justify-content: flex-end;
      }

      .wr-topic-sync-group {
        min-width: 0;
        display: inline-flex;
        align-items: stretch;
        overflow: hidden;
        border: 1px solid #e9edf3;
        border-radius: 999px;
        background: #f7f9fc;
      }

      .wr-topic-sync-group .wr-topic-sync-status {
        min-height: 30px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 0 9px;
      }

      .wr-topic-sync-dot {
        flex: 0 0 5px;
        width: 5px;
        height: 5px;
        border-radius: 999px;
        background: #98a2b3;
      }

      .wr-topic-sync-status[data-status-type="success"] .wr-topic-sync-dot {
        background: #22a447;
      }

      .wr-topic-sync-status[data-status-type="pending"] .wr-topic-sync-dot,
      .wr-topic-sync-status[data-status-type="syncing"] .wr-topic-sync-dot {
        background: #d79b00;
      }

      .wr-topic-sync-status[data-status-type="error"] .wr-topic-sync-dot {
        background: #d92d20;
      }

      .wr-topic-sync-action {
        min-height: 30px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: 0;
        border-left: 1px solid #e2e7ef;
        padding: 0 9px;
        background: transparent;
        color: #344054;
        font-size: 11px;
        white-space: nowrap;
        cursor: pointer;
      }

      .wr-topic-sync-action:hover,
      .wr-topic-sync-action:focus-visible {
        background: #eef5ff;
        color: var(--wr-topic-blue);
        outline: none;
      }

      .wr-topic-close-btn {
        position: absolute;
        top: 16px;
        right: 16px;
        width: 32px;
        height: 32px;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 6px;
        padding: 0;
        background: transparent;
        color: #526070;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
      }

      .wr-topic-close-btn:hover,
      .wr-topic-close-btn:focus-visible {
        background: #f2f4f7;
        color: #17202a;
        outline: none;
      }

      .wr-topic-tabs {
        display: flex;
        gap: 18px;
        margin-top: 16px;
        border-bottom: 1px solid var(--wr-topic-border);
      }

      .wr-topic-tab {
        min-height: 34px;
        border: 0;
        border-bottom: 2px solid transparent;
        padding: 0 2px;
        background: transparent;
        color: var(--wr-topic-muted);
        font-size: 13px;
        cursor: pointer;
      }

      .wr-topic-tab.active {
        border-bottom-color: var(--wr-topic-blue);
        color: var(--wr-topic-text);
        font-weight: 650;
      }

      .wr-topic-sync-status {
        align-self: center;
        max-width: 290px;
        overflow: hidden;
        color: var(--wr-topic-muted);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wr-topic-sync-status[data-status-type="success"] {
        color: #237a4b;
      }

      .wr-topic-sync-status[data-status-type="pending"],
      .wr-topic-sync-status[data-status-type="syncing"] {
        color: #9a6700;
      }

      .wr-topic-sync-status[data-status-type="error"] {
        color: #c0392b;
      }

      .wr-topic-btn {
        border: 1px solid var(--wr-topic-border);
        border-radius: 6px;
        min-height: 34px;
        padding: 0 13px;
        background: #fff;
        color: var(--wr-topic-text);
        font-size: 13px;
        cursor: pointer;
      }

      .wr-topic-btn:hover {
        border-color: #cad1dc;
        background: #f7f9fc;
      }

      .wr-topic-btn.primary {
        border-color: var(--wr-topic-blue);
        background: var(--wr-topic-blue);
        color: #fff;
      }

      .wr-topic-btn.danger {
        border-color: #f2c3bf;
        color: #c0392b;
      }

      .wr-topic-btn.ghost {
        border-color: transparent;
        background: transparent;
      }

      .wr-topic-panel-body {
        min-height: 0;
        min-width: 0;
        flex: 1;
        display: grid;
        grid-template-columns: 320px minmax(0, 1fr);
        overflow: hidden;
      }

      .wr-topic-sidebar,
      .wr-topic-detail {
        min-height: 0;
        min-width: 0;
        padding: 22px 24px;
      }

      .wr-topic-sidebar {
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .wr-topic-detail {
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .wr-topic-sidebar {
        border-right: 1px solid var(--wr-topic-border);
        background: #fff;
      }

      .wr-topic-count {
        margin: 0 0 16px;
        color: var(--wr-topic-muted);
        font-size: 13px;
      }

      .wr-topic-sidebar > h3 {
        flex: 0 0 auto;
        margin-bottom: 12px;
      }

      .wr-topic-group-scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 2px 7px 8px 2px;
        scrollbar-gutter: stable;
      }

      .wr-topic-group-scroll,
      .wr-topic-group-book-list {
        scrollbar-width: thin;
        scrollbar-color: rgba(82, 96, 112, .48) transparent;
      }

      .wr-topic-group-scroll::-webkit-scrollbar,
      .wr-topic-group-book-list::-webkit-scrollbar {
        width: 4px;
        height: 4px;
      }

      .wr-topic-group-scroll::-webkit-scrollbar-track,
      .wr-topic-group-book-list::-webkit-scrollbar-track {
        background: transparent;
      }

      .wr-topic-group-scroll::-webkit-scrollbar-thumb,
      .wr-topic-group-book-list::-webkit-scrollbar-thumb {
        border-radius: 999px;
        background: rgba(82, 96, 112, .48);
      }

      .wr-topic-sidebar-create {
        flex: 0 0 auto;
        margin-top: 12px;
        padding: 10px 2px 2px;
        border-top: 1px solid var(--wr-topic-border);
        background: #fff;
      }

      .wr-topic-new-group-btn {
        width: 100%;
        min-height: 48px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 9px;
        border: 1px solid rgba(47, 128, 237, .36);
        border-radius: 7px;
        background: #fff;
        color: var(--wr-topic-blue);
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: border-color .16s ease, background .16s ease, color .16s ease;
      }

      .wr-topic-new-group-btn:hover,
      .wr-topic-new-group-btn:focus-visible {
        border-color: var(--wr-topic-blue);
        background: var(--wr-topic-blue);
        color: #fff;
        outline: none;
      }

      .wr-topic-new-group-icon {
        width: 19px;
        height: 19px;
      }

      .wr-topic-group-list {
        width: 100%;
        min-width: 0;
        display: grid;
        gap: 10px;
      }

      .wr-topic-group-card {
        width: 100%;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        box-sizing: border-box;
        text-align: left;
        white-space: normal;
        border: 1px solid var(--wr-topic-border);
        border-radius: 8px;
        padding: 13px;
        background: #fff;
        cursor: pointer;
      }

      .wr-topic-group-card.active,
      .wr-topic-group-card:hover {
        border-color: rgba(47, 128, 237, .45);
        box-shadow: 0 8px 22px rgba(15, 23, 42, .06);
      }

      .wr-topic-group-name {
        display: block;
        max-width: 100%;
        overflow: hidden;
        color: var(--wr-topic-text);
        font-weight: 650;
        line-height: 1.35;
        overflow-wrap: anywhere;
        white-space: normal;
      }

      .wr-topic-group-desc {
        display: -webkit-box;
        max-width: 100%;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        margin-top: 6px;
        color: var(--wr-topic-muted);
        font-size: 12px;
        line-height: 1.5;
        overflow-wrap: anywhere;
        white-space: normal;
      }

      .wr-topic-group-meta {
        display: block;
        max-width: 100%;
        overflow: hidden;
        margin-top: 8px;
        color: #8a94a6;
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wr-topic-catalog {
        height: 100%;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 22px 26px 30px;
        background: #fbfbfa;
      }

      .wr-topic-catalog-head,
      .wr-topic-catalog-controls,
      .wr-topic-catalog-stats {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .wr-topic-catalog-head {
        justify-content: space-between;
        margin-bottom: 16px;
      }

      .wr-topic-catalog-head p {
        margin: 4px 0 0;
        font-size: 12px;
      }

      .wr-topic-catalog-stats {
        margin-bottom: 16px;
      }

      .wr-topic-catalog-stat {
        min-width: 112px;
        border-left: 3px solid #cad1dc;
        padding: 6px 10px;
        background: #fff;
      }

      .wr-topic-catalog-stat strong,
      .wr-topic-catalog-stat span {
        display: block;
      }

      .wr-topic-catalog-stat strong {
        font-size: 18px;
      }

      .wr-topic-catalog-stat span {
        margin-top: 2px;
        color: var(--wr-topic-muted);
        font-size: 11px;
      }

      .wr-topic-catalog-controls {
        margin-bottom: 14px;
      }

      .wr-topic-catalog-search {
        flex: 1 1 260px;
        max-width: 420px;
      }

      .wr-topic-catalog-filter.active {
        border-color: var(--wr-topic-blue);
        color: var(--wr-topic-blue);
        background: rgba(47, 128, 237, .06);
      }

      .wr-topic-catalog-list {
        border-top: 1px solid var(--wr-topic-border);
      }

      .wr-topic-catalog-book-list {
        margin-top: 14px;
        padding-bottom: 14px;
      }

      .wr-topic-catalog-book-list + .wr-topic-catalog-row {
        border-top: 1px solid var(--wr-topic-border);
      }

      .wr-topic-catalog-row {
        min-width: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 16px;
        padding: 13px 4px;
        border-bottom: 1px solid var(--wr-topic-border);
      }

      .wr-topic-catalog-row > div:first-child {
        min-width: 0;
      }

      .wr-topic-catalog-title,
      .wr-topic-catalog-match {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wr-topic-catalog-title {
        color: var(--wr-topic-text);
        font-size: 14px;
        font-weight: 600;
      }

      .wr-topic-catalog-match {
        margin-top: 4px;
        color: var(--wr-topic-muted);
        font-size: 12px;
      }

      .wr-topic-catalog-badges {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }

      .wr-topic-badge {
        border-radius: 4px;
        padding: 3px 7px;
        background: #edf1f7;
        color: #526070;
        font-size: 11px;
        white-space: nowrap;
      }

      .wr-topic-badge.in-shelf {
        background: #e8f6ee;
        color: #237a4b;
      }

      .wr-topic-badge.has-context {
        background: #fff3d6;
        color: #8a5b00;
      }

      .wr-topic-source-note {
        margin: 0 0 12px !important;
        border-left: 3px solid var(--wr-topic-blue);
        padding: 8px 10px;
        background: #eef5ff;
        color: #315b89 !important;
        font-size: 12px;
      }

      .wr-topic-input[readonly],
      .wr-topic-textarea[readonly] {
        background: #f5f7fa;
        color: #344054;
        cursor: default;
      }

      .wr-topic-empty {
        padding: 28px 0;
        color: var(--wr-topic-muted);
        font-size: 14px;
      }

      .wr-topic-form {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .wr-topic-form-scroll {
        min-height: 0;
        flex: 1;
        overflow: auto;
        display: grid;
        gap: 14px;
        padding: 0 2px 16px 0;
      }

      .wr-topic-field {
        display: grid;
        gap: 7px;
      }

      .wr-topic-field label {
        color: #344054;
        font-size: 13px;
        font-weight: 600;
      }

      .wr-topic-input,
      .wr-topic-textarea {
        width: 100%;
        border: 1px solid #d9dee8;
        border-radius: 7px;
        padding: 10px 11px;
        background: #fff;
        color: var(--wr-topic-text);
        font-size: 14px;
        line-height: 1.5;
        outline: none;
      }

      .wr-topic-input:focus,
      .wr-topic-textarea:focus {
        border-color: rgba(47, 128, 237, .72);
        box-shadow: 0 0 0 3px rgba(47, 128, 237, .12);
      }

      .wr-topic-book-search {
        margin-bottom: 10px;
      }

      .wr-topic-book-search-meta {
        margin: -2px 0 10px;
        color: var(--wr-topic-muted);
        font-size: 12px;
      }

      .wr-topic-textarea {
        min-height: 126px;
        resize: vertical;
      }

      .wr-topic-book-picker,
      .wr-topic-book-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 12px;
      }

      .wr-topic-book-option,
      .wr-topic-book-row {
        border: 1px solid var(--wr-topic-border);
        border-radius: 8px;
        background: #fff;
        overflow: hidden;
      }

      .wr-topic-book-option {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 9px;
        text-align: left;
        cursor: pointer;
      }

      .wr-topic-book-option.selected {
        border-color: var(--wr-topic-blue);
        box-shadow: 0 0 0 2px rgba(47, 128, 237, .12);
      }

      .wr-topic-book-cover {
        flex: 0 0 38px;
        width: 38px;
        height: 56px;
        object-fit: cover;
        border-radius: 3px;
        background: #edf1f7;
      }

      .wr-topic-book-info {
        min-width: 0;
      }

      .wr-topic-book-title {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--wr-topic-text);
        font-size: 13px;
        font-weight: 600;
        line-height: 1.35;
      }

      .wr-topic-book-author {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 5px;
        color: var(--wr-topic-muted);
        font-size: 12px;
        white-space: nowrap;
      }

      .wr-topic-detail-desc {
        margin: 12px 0 20px;
        color: var(--wr-topic-muted);
        line-height: 1.7;
        white-space: pre-wrap;
      }

      .wr-topic-book-row {
        display: flex;
        flex-direction: column;
      }

      .wr-topic-book-main {
        display: flex;
        gap: 11px;
        padding: 10px;
        text-align: left;
        cursor: pointer;
      }

      .wr-topic-book-actions {
        display: flex;
        gap: 7px;
        padding: 0 10px 10px;
      }

      .wr-topic-group-book-list {
        flex: 1 1 auto;
        min-height: 0;
        grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
        align-content: start;
        overflow-x: hidden;
        overflow-y: auto;
        padding-right: 6px;
      }

      .wr-topic-group-book-card {
        position: relative;
        min-width: 0;
        min-height: 148px;
        display: grid;
        grid-template-columns: 82px minmax(0, 1fr);
        gap: 12px;
        border: 1px solid var(--wr-topic-border);
        border-radius: 8px;
        padding: 12px;
        background: #fff;
        transition: border-color .16s ease, box-shadow .16s ease;
      }

      .wr-topic-group-book-card:hover,
      .wr-topic-group-book-card:focus-within {
        border-color: rgba(47, 128, 237, .34);
        box-shadow: 0 8px 22px rgba(15, 23, 42, .07);
      }

      .wr-topic-group-book-cover-action,
      .wr-topic-group-book-title-action,
      .wr-topic-group-book-context {
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }

      .wr-topic-group-book-cover-action {
        align-self: start;
      }

      .wr-topic-group-book-cover {
        display: block;
        width: 82px;
        height: 122px;
        object-fit: cover;
        border-radius: 4px;
        background: #edf1f7;
        box-shadow: 0 3px 10px rgba(15, 23, 42, .12);
      }

      .wr-topic-group-book-content {
        min-width: 0;
        display: flex;
        flex-direction: column;
      }

      .wr-topic-group-book-title-action {
        max-width: 100%;
        padding-right: 48px;
        color: var(--wr-topic-text);
        font-size: 13px;
        font-weight: 650;
        line-height: 1.4;
      }

      .wr-topic-group-book-title-action:hover {
        color: var(--wr-topic-blue);
      }

      .wr-topic-group-book-context {
        display: -webkit-box;
        flex: 1;
        min-height: 0;
        margin-top: 8px;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 5;
        overflow: hidden;
        color: #526070;
        font-size: 12px;
        line-height: 1.55;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      .wr-topic-group-book-context:hover {
        color: #315b89;
      }

      .wr-topic-group-book-context.is-empty {
        color: #8a94a6;
      }

      .wr-topic-group-book-remove {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 28px;
        height: 28px;
        min-height: 28px;
        display: grid;
        place-items: center;
        padding: 0;
        opacity: 0;
        pointer-events: none;
        transform: translateY(-2px);
        transition: opacity .16s ease, transform .16s ease;
      }

      .wr-topic-group-book-card:hover .wr-topic-group-book-remove,
      .wr-topic-group-book-card:focus-within .wr-topic-group-book-remove {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
      }

      .wr-topic-group-book-remove .wr-topic-icon {
        width: 14px;
        height: 14px;
      }

      .wr-topic-modal {
        position: fixed;
        inset: 0;
        z-index: 2147483602;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 22px;
        background: rgba(20, 27, 38, .34);
        overflow: hidden;
      }

      .wr-topic-modal-card {
        width: min(620px, calc(100vw - 44px));
        max-height: min(760px, calc(100vh - 44px));
        overflow-x: hidden;
        overflow-y: auto;
        border-radius: 10px;
        background: #fff;
        padding: 22px;
        box-shadow: 0 24px 80px rgba(15, 23, 42, .24);
      }

      .wr-topic-modal-card * {
        max-width: 100%;
        box-sizing: border-box;
      }

      .wr-topic-cloud-card {
        width: min(560px, calc(100vw - 44px));
      }

      .wr-topic-modal-head h3 {
        color: var(--wr-topic-text);
      }

      .wr-topic-cloud-form {
        display: grid;
        gap: 15px;
        margin-top: 18px;
      }

      .wr-topic-checkbox {
        display: flex;
        align-items: center;
        gap: 9px;
        color: #344054;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
      }

      .wr-topic-checkbox input {
        width: 16px;
        height: 16px;
        accent-color: var(--wr-topic-blue);
      }

      .wr-topic-field-hint {
        margin: 0 !important;
        color: var(--wr-topic-muted);
        font-size: 12px;
        line-height: 1.55 !important;
      }

      .wr-topic-field-hint code {
        color: #344054;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        word-break: break-all;
      }

      .wr-topic-security-note {
        border-left: 3px solid #f0b429;
        padding: 9px 11px;
        background: #fffbeb;
        color: #725300;
        font-size: 12px;
        line-height: 1.6;
      }

      .wr-topic-modal-book {
        display: flex;
        gap: 13px;
        align-items: center;
        margin: 14px 0 16px;
        min-width: 0;
      }

      .wr-topic-modal-book img {
        width: 52px;
        height: 76px;
        object-fit: cover;
        border-radius: 4px;
        background: #edf1f7;
      }

      .wr-topic-form-actions,
      .wr-topic-modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 9px;
        flex: 0 0 auto;
        z-index: 2;
        margin: 0;
        padding: 14px 0 0;
        border-top: 1px solid rgba(230, 233, 239, .92);
        background: #fbfbfa;
      }

      .wr-topic-folder-cover {
        width: 128px;
        height: 185px;
        box-sizing: border-box;
        border: 2px solid var(--wr-topic-blue);
        border-radius: 4px;
        padding: 8px;
        background: #fff;
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr 1fr;
        gap: 6px;
        box-shadow: 0 8px 22px rgba(47, 128, 237, .18);
      }

      .wr-topic-mini-cover {
        width: 100%;
        height: 100%;
        min-width: 0;
        object-fit: cover;
        border-radius: 2px;
        background: linear-gradient(145deg, #eef3fb, #dfe8f6);
      }

      .wr-topic-shelf-group {
        order: -2 !important;
        cursor: pointer;
      }

      .shelfBook.wr-book-has-context {
        order: -1 !important;
      }

      .wr-topic-folder-title {
        margin-top: 8px;
      }

      a.shelfBook {
        position: relative;
      }

      .wr-book-context-icon {
        position: absolute;
        right: 4px;
        top: 4px;
        width: 26px;
        height: 26px;
        z-index: 999;
        display: grid;
        place-items: center;
        border-radius: 999px;
        border: 2px solid #fff;
        padding: 0;
        background: var(--wr-topic-blue);
        color: #fff;
        cursor: pointer;
        opacity: 0;
        box-shadow: 0 4px 12px rgba(0, 0, 0, .22);
        transition: opacity .16s ease, background .16s ease;
      }

      .wr-book-context-icon .wr-topic-icon {
        width: 15px;
        height: 15px;
      }

      .shelfBook:hover .wr-book-context-icon {
        opacity: 1;
      }

      .wr-book-context-icon.has-note {
        opacity: 1;
        background: var(--wr-topic-blue);
        box-shadow:
          0 0 0 2px rgba(255, 255, 255, .95),
          0 6px 16px rgba(47, 128, 237, .4),
          0 2px 6px rgba(0, 0, 0, .22);
      }

      @media (max-width: 760px) {
        .wr-topic-entry {
          right: 14px;
          bottom: 18px;
        }

        .wr-topic-panel {
          width: 100vw;
        }

        .wr-topic-panel-header {
          padding: 18px 26px 12px;
        }

        .wr-topic-header-main {
          grid-template-columns: 1fr;
          align-items: stretch;
          gap: 10px;
          padding-right: 0;
        }

        .wr-topic-header-title {
          padding-right: 34px;
        }

        .wr-topic-shelf-tools {
          justify-content: flex-start;
        }

        .wr-topic-header-actions {
          justify-content: flex-start;
        }

        .wr-topic-sync-group {
          max-width: 100%;
        }

        .wr-topic-sync-group .wr-topic-sync-status {
          min-width: 0;
          flex: 1 1 auto;
        }

        .wr-topic-sync-status [data-wr-sync-status-text] {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .wr-topic-panel-body {
          grid-template-columns: 1fr;
        }

        .wr-topic-sidebar {
          max-height: 34vh;
          border-right: 0;
          border-bottom: 1px solid var(--wr-topic-border);
        }

        .wr-topic-catalog-row {
          grid-template-columns: 1fr;
          gap: 8px;
        }

        .wr-topic-catalog-badges {
          justify-content: flex-start;
        }

        .wr-topic-group-book-list {
          grid-template-columns: 1fr;
        }
      }

      @media (hover: none) {
        .wr-topic-group-book-remove {
          opacity: 1;
          pointer-events: auto;
          transform: none;
        }
      }
    `;

    safeAppend(document.head || getMountRoot(), style, "style");
  }

  function styleTopicEntryButton(button) {
    button.className = "wr-topic-entry";
    button.style.setProperty("display", "inline-flex", "important");
    button.style.setProperty("align-items", "center", "important");
    button.style.setProperty("justify-content", "center", "important");
    button.style.setProperty("box-sizing", "border-box", "important");
    button.style.setProperty("width", "auto", "important");
    button.style.setProperty("min-height", "40px", "important");
    button.style.setProperty("padding", "0 18px", "important");
    button.style.setProperty("border", "0", "important");
    button.style.setProperty("border-radius", "999px", "important");
    button.style.setProperty("background", "#2f80ed", "important");
    button.style.setProperty("background-color", "#2f80ed", "important");
    button.style.setProperty("color", "#fff", "important");
    button.style.setProperty("font-size", "14px", "important");
    button.style.setProperty("line-height", "1", "important");
    button.style.setProperty("font-weight", "500", "important");
    button.style.setProperty("white-space", "nowrap", "important");
    button.style.setProperty("cursor", "pointer", "important");
    button.style.setProperty("pointer-events", "auto", "important");
    button.style.setProperty("position", "fixed", "important");
    button.style.setProperty("right", "24px", "important");
    button.style.setProperty("bottom", "28px", "important");
    button.style.setProperty("z-index", "2147483600", "important");
    button.style.setProperty("box-shadow", "0 8px 24px rgba(47, 128, 237, .28)", "important");
  }

  function activateTopicEntry(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
    }

    openPanel().catch((error) => {
      console.error("[WeRead Local Topic Shelf] open panel failed:", error);
    });
  }

  function bindTopicEntryEvents(button) {
    button.onclick = activateTopicEntry;
    button.onpointerdown = (event) => {
      event.stopPropagation();
    };
    button.onmousedown = (event) => {
      event.stopPropagation();
    };
    button.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      activateTopicEntry(event);
    };
  }

  function ensureFloatingButton() {
    let button = document.getElementById("wr-topic-floating-button");

    if (!button) {
      button = document.createElement("button");
      button.id = "wr-topic-floating-button";
      button.className = "wr-topic-entry";
      button.type = "button";
      button.setAttribute("role", "button");
      button.setAttribute("tabindex", "0");
      button.textContent = text.floatingButton;
    }

    button.dataset.wrAction = "open-panel";
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.textContent = text.floatingButton;
    bindTopicEntryEvents(button);
    styleTopicEntryButton(button);

    if (button.parentNode !== getMountRoot()) {
      safeAppend(getMountRoot(), button, "topic entry");
    }
  }

  function getBookIdFromHref(href) {
    const match = String(href || "").match(/\/web\/reader\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function extractBook(link) {
    const href = link.getAttribute("href") || "";
    const url = new URL(href, window.location.origin).href;
    const id = getBookIdFromHref(url);
    const titleEl = link.querySelector(SELECTORS.bookTitle);
    const authorEl = link.querySelector(
      '.author, [class*="author"], [class*="Author"]',
    );
    const img = link.querySelector(SELECTORS.bookCover);
    const title =
      (titleEl &&
        (titleEl.getAttribute("title") || titleEl.textContent || "").trim()) ||
      (link.getAttribute("title") || link.textContent || "").trim() ||
      id;

    return {
      id,
      title,
      author: authorEl ? authorEl.textContent.trim() : "",
      url,
      cover: img ? img.src : "",
    };
  }

  function scanBooks() {
    const seen = new Set();
    const books = [];

    document.querySelectorAll(SELECTORS.shelfBook).forEach((link) => {
      const book = extractBook(link);
      if (!book.id || seen.has(book.id)) return;
      seen.add(book.id);
      books.push(book);
    });

    state.books = books;
    return books;
  }

  function findBook(bookId) {
    const fromShelf = state.books.find((book) => book.id === bookId);
    if (fromShelf) return fromShelf;

    for (const group of getGroups()) {
      const fromGroup = (group.books || []).find((book) => book.id === bookId);
      if (fromGroup) return fromGroup;
    }

    const note = getNotes()[bookId];
    return note ? note.book : null;
  }

  function createPlaceholderCover(title) {
    const span = document.createElement("span");
    span.className = "wr-topic-mini-cover";
    span.textContent = String(title || "").slice(0, 1);
    span.style.display = "grid";
    span.style.placeItems = "center";
    span.style.color = "#6b7b93";
    span.style.fontSize = "18px";
    span.style.fontWeight = "700";
    return span;
  }

  function renderShelfGroups() {
    const shelfList = document.querySelector(SELECTORS.shelfList);
    if (!shelfList) return;

    shelfList
      .querySelectorAll(".wr-topic-shelf-group")
      .forEach((el) => el.remove());

    const fragment = document.createDocumentFragment();
    getGroups().forEach((group) => {
      const card = document.createElement("div");
      card.className = "shelfBook wr-topic-shelf-group";
      card.dataset.wrAction = "open-group";
      card.dataset.groupId = group.id;
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");

      const cover = document.createElement("div");
      cover.className = "wr-topic-folder-cover";
      (group.books || []).slice(0, 4).forEach((book) => {
        if (book.cover) {
          const img = document.createElement("img");
          img.className = "wr-topic-mini-cover";
          img.src = book.cover;
          img.alt = "";
          cover.appendChild(img);
        } else {
          cover.appendChild(createPlaceholderCover(book.title));
        }
      });

      while (cover.children.length < 4) {
        cover.appendChild(createPlaceholderCover(""));
      }

      const titleEl = document.createElement("div");
      titleEl.className = "title wr-topic-folder-title";
      titleEl.title = group.name;
      titleEl.textContent = group.name;

      card.append(cover, titleEl);
      fragment.appendChild(card);
    });

    shelfList.prepend(fragment);
  }

  function groupedBookIds() {
    const ids = new Set();
    getGroups().forEach((group) => {
      (group.books || []).forEach((book) => ids.add(book.id));
    });
    return ids;
  }

  function applyHiddenBooks() {
    const ids = groupedBookIds();
    document.querySelectorAll(SELECTORS.shelfBook).forEach((link) => {
      const id = getBookIdFromHref(link.href);
      if (ids.has(id)) {
        link.style.display = "none";
        link.dataset.wrLocalHidden = "1";
      } else if (link.dataset.wrLocalHidden) {
        link.style.display = "";
        delete link.dataset.wrLocalHidden;
      }
    });
  }

  function renderBookNoteIcons() {
    const notes = getNotes();

    document.querySelectorAll(SELECTORS.shelfBook).forEach((link) => {
      const book = extractBook(link);
      if (!book.id) return;
      const hasContext =
        hasObsidianReadingContext(getObsidianContext(book.id)) ||
        hasReadingContext(notes[book.id]);

      let icon = link.querySelector(".wr-book-context-icon");
      if (!icon) {
        icon = document.createElement("button");
        icon.type = "button";
        icon.className = "wr-book-context-icon";
        icon.dataset.wrAction = "open-book-note";
        icon.title = text.bookNoteTitle;
        if (!safeAppend(link, icon, "book note icon")) return;
      }

      icon.dataset.bookId = book.id;
      icon.innerHTML = iconSvg(hasContext ? "info" : "plus");
      icon.title = hasContext ? "查看阅读信息" : "添加阅读信息";
      icon.setAttribute("aria-label", icon.title);
      icon.classList.toggle("has-note", hasContext);
      link.classList.toggle("wr-book-has-context", hasContext);
    });
  }

  function refreshShelf() {
    scanBooks();
    renderShelfGroups();
    applyHiddenBooks();
    renderBookNoteIcons();
    renderPanel();
  }

  function getShelfSignature() {
    const count = document.querySelectorAll(SELECTORS.shelfBook).length;
    const storageMarker = `${JSON.stringify(state.groups)}|${JSON.stringify(state.notes)}`;
    return `${count}|${storageMarker.length}|${storageMarker.slice(0, 80)}`;
  }

  function bookPickerHtml() {
    const selected = state.selectedBookIds;
    const query = state.bookFilter.trim().toLowerCase();
    const books = query
      ? state.books.filter((book) =>
          `${book.title || ""} ${book.author || ""}`.toLowerCase().includes(query),
        )
      : state.books;

    if (!state.books.length) {
      return `<div class="wr-topic-empty">${text.loading}</div>`;
    }

    if (!books.length) {
      return `
        <div class="wr-topic-book-search-meta">匹配到 0 本，已选 ${selected.size} 本</div>
        <div class="wr-topic-empty">没有找到匹配的书籍。</div>
      `;
    }

    return `
      <div class="wr-topic-book-search-meta">匹配到 ${books.length} 本，已选 ${selected.size} 本</div>
      <div class="wr-topic-book-picker">
        ${books
          .map(
            (book) => `
          <button class="wr-topic-book-option ${selected.has(book.id) ? "selected" : ""}" type="button" data-wr-action="toggle-book" data-book-id="${escapeHtml(book.id)}">
            <img class="wr-topic-book-cover" src="${escapeHtml(book.cover)}" alt="">
            <span class="wr-topic-book-info">
              <span class="wr-topic-book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</span>
              <span class="wr-topic-book-author">${escapeHtml(book.author)}</span>
            </span>
          </button>
        `,
          )
          .join("")}
      </div>
    `;
  }

  function renderGroupForm(group) {
    const isEdit = Boolean(group);

    return `
      <form class="wr-topic-form" data-wr-form="group">
        <div class="wr-topic-form-scroll">
          <div class="wr-topic-field">
            <label for="wr-topic-name">${text.groupName}</label>
            <input id="wr-topic-name" class="wr-topic-input" name="name" value="${escapeHtml(group ? group.name : "")}" autocomplete="off">
          </div>
          <div class="wr-topic-field">
            <label for="wr-topic-desc">${text.groupDescription}</label>
            <textarea id="wr-topic-desc" class="wr-topic-textarea" name="description">${escapeHtml(group ? group.description : "")}</textarea>
          </div>
          <div class="wr-topic-field">
            <label>${text.chooseBooks}</label>
            <input class="wr-topic-input wr-topic-book-search" type="search" data-wr-action="filter-books" placeholder="搜索书名或作者" value="${escapeHtml(state.bookFilter)}" autocomplete="off">
            <div data-wr-book-picker>${bookPickerHtml()}</div>
          </div>
        </div>
        <div class="wr-topic-form-actions">
          <button class="wr-topic-btn ghost" type="button" data-wr-action="cancel-form">${text.cancel}</button>
          <button class="wr-topic-btn primary" type="submit" data-wr-action="submit-group">${isEdit ? text.save : text.create}</button>
        </div>
      </form>
    `;
  }

  function renderGroupList(groups) {
    if (!groups.length) {
      return `<div class="wr-topic-empty">${text.noGroups}</div>`;
    }

    return `
      <div class="wr-topic-group-list">
        ${groups
          .map(
            (group) => `
          <button class="wr-topic-group-card ${group.id === state.selectedGroupId ? "active" : ""}" type="button" data-wr-action="select-group" data-group-id="${escapeHtml(group.id)}">
            <span class="wr-topic-group-name">${escapeHtml(group.name)}</span>
            <span class="wr-topic-group-desc">${escapeHtml(group.description || "暂无描述")}</span>
            <span class="wr-topic-group-meta">${(group.books || []).length} 本书</span>
          </button>
        `,
          )
          .join("")}
      </div>
    `;
  }

  function renderGroupDetail(group) {
    if (state.formMode === "new") return renderGroupForm(null);
    if (state.formMode === "edit" && group) return renderGroupForm(group);

    if (!group) {
      return `<div class="wr-topic-empty">${text.noGroupSelected}</div>`;
    }

    return `
      <div class="wr-topic-detail-head">
        <h3>${escapeHtml(group.name)}</h3>
        <div>
          <button class="wr-topic-btn" type="button" data-wr-action="edit-group" data-group-id="${escapeHtml(group.id)}">${text.edit}</button>
          <button class="wr-topic-btn danger" type="button" data-wr-action="delete-group" data-group-id="${escapeHtml(group.id)}">${text.deleteGroup}</button>
        </div>
      </div>
      <div class="wr-topic-detail-desc">${escapeHtml(group.description || "暂无描述")}</div>
      <div class="wr-topic-book-list wr-topic-group-book-list">
        ${(group.books || [])
          .map((book) => {
            const context = getBookContextSummary(book.id);
            const contextLabel = context || "暂无阅读上下文，点击添加";
            return `
              <article class="wr-topic-group-book-card">
                <button class="wr-topic-group-book-cover-action" type="button" data-wr-action="open-reader" data-url="${escapeHtml(book.url)}" aria-label="进入阅读：${escapeHtml(book.title)}">
                  <img class="wr-topic-group-book-cover" src="${escapeHtml(book.cover)}" alt="">
                </button>
                <div class="wr-topic-group-book-content">
                  <button class="wr-topic-group-book-title-action" type="button" data-wr-action="open-reader" data-url="${escapeHtml(book.url)}" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</button>
                  <button class="wr-topic-group-book-context ${context ? "" : "is-empty"}" type="button" data-wr-action="open-book-note" data-book-id="${escapeHtml(book.id)}" title="打开书籍阅读上下文">${escapeHtml(contextLabel)}</button>
                </div>
                <button class="wr-topic-btn danger wr-topic-group-book-remove" type="button" data-wr-action="remove-book" data-group-id="${escapeHtml(group.id)}" data-book-id="${escapeHtml(book.id)}" title="从主题组移除" aria-label="从主题组移除">${iconSvg("trash")}</button>
              </article>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function catalogBooks() {
    const query = state.catalogQuery.trim().toLocaleLowerCase();
    return (state.obsidianCache.books || [])
      .filter((book) => {
        if (state.catalogFilter === "in" && !book.inShelf) return false;
        if (state.catalogFilter === "out" && book.inShelf) return false;
        if (!query) return true;
        return `${book.sourceTitle || ""} ${book.matchTitle || ""}`
          .toLocaleLowerCase()
          .includes(query);
      })
      .sort((left, right) => {
        if (left.inShelf !== right.inShelf) return left.inShelf ? -1 : 1;
        return String(left.sourceTitle || "").localeCompare(
          String(right.sourceTitle || ""),
          "zh-CN",
        );
      });
  }

  function catalogListHtml() {
    const books = catalogBooks();
    if (!books.length) {
      const message = (state.obsidianCache.books || []).length
        ? "没有符合当前筛选条件的书目。"
        : "还没有 Obsidian 书目数据，请先在 Obsidian 中同步。";
      return `<div class="wr-topic-empty">${message}</div>`;
    }

    const seenShelfBookIds = new Set();
    const shelfBooks = [];
    const rows = [];

    books.forEach((catalogBook) => {
      if (catalogBook.inShelf) {
        let resolvedShelfBook = false;
        (catalogBook.matchedShelfBookIds || []).forEach((bookId) => {
          const shelfBook = findBook(bookId);
          if (!shelfBook) return;
          resolvedShelfBook = true;
          if (seenShelfBookIds.has(bookId)) return;
          seenShelfBookIds.add(bookId);
          shelfBooks.push(shelfBook);
        });
        if (resolvedShelfBook) return;
      }

      rows.push(`
          <div class="wr-topic-catalog-row">
            <div>
              <div class="wr-topic-catalog-title" title="${escapeHtml(catalogBook.sourceTitle || catalogBook.matchTitle)}">${escapeHtml(catalogBook.sourceTitle || catalogBook.matchTitle)}</div>
              <div class="wr-topic-catalog-match" title="${escapeHtml(catalogBook.matchTitle || "")}">匹配书名：${escapeHtml(catalogBook.matchTitle || "未设置")}</div>
            </div>
            <div class="wr-topic-catalog-badges">
              ${catalogBook.hasContext ? '<span class="wr-topic-badge has-context">WHY</span>' : ""}
              <span class="wr-topic-badge ${catalogBook.inShelf ? "in-shelf" : ""}">${catalogBook.inShelf ? "在书架" : "不在书架"}</span>
            </div>
          </div>
        `);
    });

    const shelfCards = shelfBooks.length
      ? `<div class="wr-topic-book-list wr-topic-catalog-book-list">
          ${shelfBooks
            .map(
              (book) => `
                <div class="wr-topic-book-row">
                  <button class="wr-topic-book-main wr-topic-btn ghost" type="button" data-wr-action="open-reader" data-url="${escapeHtml(book.url)}">
                    <img class="wr-topic-book-cover" src="${escapeHtml(book.cover)}" alt="">
                    <span class="wr-topic-book-info">
                      <span class="wr-topic-book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</span>
                      <span class="wr-topic-book-author">${escapeHtml(book.author)}</span>
                    </span>
                  </button>
                  <div class="wr-topic-book-actions">
                    <button class="wr-topic-btn" type="button" data-wr-action="open-book-note" data-book-id="${escapeHtml(book.id)}">${text.note}</button>
                  </div>
                </div>
              `,
            )
            .join("")}
        </div>`
      : "";

    return `${shelfCards}${rows.join("")}`;
  }

  function renderCatalogView() {
    const stats = state.obsidianCache.stats || {
      total: (state.obsidianCache.books || []).length,
      inShelf: (state.obsidianCache.books || []).filter((book) => book.inShelf)
        .length,
      notInShelf: (state.obsidianCache.books || []).filter(
        (book) => !book.inShelf,
      ).length,
      withContext: (state.obsidianCache.books || []).filter(
        (book) => book.hasContext,
      ).length,
      recognizedShelfBooks: state.books.length,
    };
    const sourceLabel = state.obsidianCache.resolvedAt
      ? `${state.obsidianCache.cached ? "缓存于" : "更新于"} ${new Date(state.obsidianCache.resolvedAt).toLocaleString("zh-CN")}`
      : "尚未获取 Obsidian 书目";

    return `
      <section class="wr-topic-catalog">
        <div class="wr-topic-catalog-head">
          <div>
            <h3>Obsidian 书目匹配</h3>
            <p>${escapeHtml(sourceLabel)}${state.obsidianCache.error ? `；刷新失败：${escapeHtml(state.obsidianCache.error)}` : ""}</p>
          </div>
          <div class="wr-topic-catalog-controls">
            <button class="wr-topic-btn" type="button" data-wr-action="refresh-catalog" ${state.catalogLoading ? "disabled" : ""}>${state.catalogLoading ? "正在刷新..." : "刷新匹配"}</button>
          </div>
        </div>
        <div class="wr-topic-catalog-stats">
          <div class="wr-topic-catalog-stat"><strong>${Number(stats.recognizedShelfBooks || state.books.length)}</strong><span>当前识别书籍</span></div>
          <div class="wr-topic-catalog-stat"><strong>${Number(stats.inShelf || 0)}</strong><span>在微信书架</span></div>
          <div class="wr-topic-catalog-stat"><strong>${Number(stats.notInShelf || 0)}</strong><span>不在微信书架</span></div>
          <div class="wr-topic-catalog-stat"><strong>${Number(stats.withContext || 0)}</strong><span>包含 WHY</span></div>
        </div>
        <div class="wr-topic-catalog-controls">
          <input class="wr-topic-input wr-topic-catalog-search" type="search" data-wr-action="filter-catalog" placeholder="搜索 Obsidian 书名或匹配书名" value="${escapeHtml(state.catalogQuery)}" autocomplete="off">
          ${[
            ["all", "全部"],
            ["in", "在书架"],
            ["out", "不在书架"],
          ]
            .map(
              ([value, label]) =>
                `<button class="wr-topic-btn wr-topic-catalog-filter ${state.catalogFilter === value ? "active" : ""}" type="button" data-wr-action="catalog-filter" data-filter="${value}">${label}</button>`,
            )
            .join("")}
        </div>
        <div class="wr-topic-catalog-list" data-wr-catalog-list>${catalogListHtml()}</div>
      </section>
    `;
  }

  function suggestedCloudKey() {
    const suffix =
      window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return `weread_shelf/${suffix}`;
  }

  function openCloudSettings() {
    const existing = document.getElementById("wr-topic-cloud-modal");
    if (existing) existing.remove();

    const config = state.cloudConfig || {};
    const modal = document.createElement("div");
    modal.className = "wr-topic-modal";
    modal.id = "wr-topic-cloud-modal";
    modal.innerHTML = `
      <div class="wr-topic-modal-card wr-topic-cloud-card" role="dialog" aria-modal="true" aria-label="${text.cloudSettingsTitle}">
        <div class="wr-topic-modal-head">
          <h3>${text.cloudSettingsTitle}</h3>
          <button class="wr-topic-btn" type="button" data-wr-action="close-cloud-settings">${text.close}</button>
        </div>
        <form class="wr-topic-cloud-form" data-wr-form="cloud">
          <label class="wr-topic-checkbox">
            <input type="checkbox" name="enabled" ${config.enabled ? "checked" : ""}>
            <span>启用自动云同步</span>
          </label>
          <div class="wr-topic-field">
            <label for="wr-cloud-base-url">Worker API 地址</label>
            <input id="wr-cloud-base-url" class="wr-topic-input" name="baseUrl" type="url" value="${escapeHtml(config.baseUrl || "")}" autocomplete="url" placeholder="https://your-worker.workers.dev">
            <p class="wr-topic-field-hint">请输入你自己的 Cloudflare Worker HTTPS 地址（*.workers.dev）。</p>
          </div>
          <div class="wr-topic-field">
            <label for="wr-cloud-token">Bearer Token</label>
            <input id="wr-cloud-token" class="wr-topic-input" name="token" type="password" value="" autocomplete="off" placeholder="${config.token ? "已保存；留空表示不修改" : "输入 Worker 专用 Token"}">
          </div>
          <div class="wr-topic-field">
            <label for="wr-cloud-key">跨设备共享 Key</label>
            <input id="wr-cloud-key" class="wr-topic-input" name="key" value="${escapeHtml(config.key || suggestedCloudKey())}" autocomplete="off">
            <p class="wr-topic-field-hint">在其他设备上填写完全相同的 Token 和 Key。Key 中的 <code>/</code> 会自动编码。</p>
          </div>
          <div class="wr-topic-security-note">
            Token 会保存在当前浏览器的 IndexedDB 中，不会写进脚本文件。请使用专门为本插件创建的 Worker Token，不要使用 Cloudflare 账户管理 Token。
          </div>
          <div class="wr-topic-modal-actions">
            <button class="wr-topic-btn ghost" type="button" data-wr-action="close-cloud-settings">${text.cancel}</button>
            <button class="wr-topic-btn primary" type="submit">保存并同步</button>
          </div>
        </form>
      </div>
    `;
    safeAppend(getMountRoot(), modal, "cloud settings modal");
  }

  function closeCloudSettings() {
    const modal = document.getElementById("wr-topic-cloud-modal");
    if (modal) modal.remove();
  }

  async function saveCloudSettings(form) {
    const enabled = form.elements.enabled.checked;
    const baseUrl = form.elements.baseUrl.value.trim();
    const token =
      form.elements.token.value.trim() ||
      (state.cloudConfig && state.cloudConfig.token) ||
      "";
    const key = form.elements.key.value.trim();

    if (enabled && (!baseUrl || !token || !key)) {
      alert("请完整填写 Worker 地址、Token 和跨设备共享 Key。");
      return;
    }

    let normalizedBaseUrl = "";
    if (baseUrl) {
      try {
        normalizedBaseUrl = normalizeBaseUrl(baseUrl);
      } catch (error) {
        alert(error.message);
        return;
      }
    }

    state.cloudConfig = {
      enabled,
      baseUrl: normalizedBaseUrl,
      token,
      key,
    };
    await dbSet(STORE.cloudConfig, state.cloudConfig);

    window.clearTimeout(state.cloudPushTimer);
    if (!enabled) {
      updateSyncStatus("云同步已关闭", "idle");
      closeCloudSettings();
      renderPanel();
      return;
    }

    state.syncMeta.dirty = true;
    state.syncMeta.localUpdatedAt = nowIso();
    await persistSyncMeta();
    updateSyncStatus("正在同步...", "syncing");

    try {
      await syncCloud({ reason: "manual" });
      closeCloudSettings();
    } catch (error) {
      alert(`云同步配置已保存，但首次同步失败：${error.message}`);
    }
  }

  function renderPanel() {
    const panel = document.getElementById("wr-topic-panel-root");
    if (!panel) return;

    const groups = getGroups();
    const selected =
      groups.find((group) => group.id === state.selectedGroupId) ||
      groups[0] ||
      null;

    if (selected && !state.selectedGroupId) state.selectedGroupId = selected.id;
    if (
      !groups.some((group) => group.id === state.selectedGroupId) &&
      groups[0]
    ) {
      state.selectedGroupId = groups[0].id;
    }

    const current =
      groups.find((group) => group.id === state.selectedGroupId) || null;

    panel.innerHTML = `
      <div class="wr-topic-overlay" data-wr-action="close-panel">
        <aside class="wr-topic-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(text.panelTitle)}">
          <header class="wr-topic-panel-header">
            <div class="wr-topic-header-main">
              <div class="wr-topic-header-title">
                <h2>${text.panelTitle}</h2>
                <p>${text.panelSubTitle}</p>
              </div>
              <div class="wr-topic-shelf-tools" role="group" aria-label="书架工具">
                <button class="wr-topic-header-tool" type="button" data-wr-action="refresh-shelf">${iconSvg("refresh", "wr-topic-icon wr-topic-header-tool-icon")}<span>刷新书架</span></button>
                <button class="wr-topic-header-tool" type="button" data-wr-action="load-full-shelf">${iconSvg("library", "wr-topic-icon wr-topic-header-tool-icon")}<span>完整书架</span></button>
              </div>
              <div class="wr-topic-header-actions">
                <div class="wr-topic-sync-group" role="group" aria-label="云同步工具">
                  <span class="wr-topic-sync-status" data-wr-sync-status data-status-type="${escapeHtml(state.syncStatusType)}" title="${escapeHtml(state.syncStatus)}"><span class="wr-topic-sync-dot" aria-hidden="true"></span><span data-wr-sync-status-text>${escapeHtml(state.syncStatus)}</span></span>
                  <button class="wr-topic-sync-action" type="button" data-wr-action="sync-cloud">${iconSvg("refresh")}<span>${text.syncNow}</span></button>
                  <button class="wr-topic-sync-action" type="button" data-wr-action="open-cloud-settings">${iconSvg("cloud")}<span>${text.cloudSync}</span></button>
                </div>
              </div>
            </div>
            <button class="wr-topic-close-btn" type="button" data-wr-action="close-panel" title="${text.close}" aria-label="${text.close}">${iconSvg("x")}</button>
            <div class="wr-topic-tabs" role="tablist">
              <button class="wr-topic-tab ${state.panelTab === "groups" ? "active" : ""}" type="button" role="tab" aria-selected="${state.panelTab === "groups"}" data-wr-action="switch-tab" data-tab="groups">${text.groups}</button>
              <button class="wr-topic-tab ${state.panelTab === "catalog" ? "active" : ""}" type="button" role="tab" aria-selected="${state.panelTab === "catalog"}" data-wr-action="switch-tab" data-tab="catalog">${text.catalog}</button>
            </div>
          </header>
          ${
            state.panelTab === "catalog"
              ? renderCatalogView()
              : `<div class="wr-topic-panel-body">
                  <section class="wr-topic-sidebar">
                    <div class="wr-topic-count">${text.recognized(state.books.length)}</div>
                    <h3>${text.groups}</h3>
                    <div class="wr-topic-group-scroll">
                      ${renderGroupList(groups)}
                    </div>
                    <div class="wr-topic-sidebar-create">
                      <button class="wr-topic-new-group-btn" type="button" data-wr-action="new-group">
                        ${iconSvg("plus", "wr-topic-icon wr-topic-new-group-icon")}
                        <span>${text.newGroup}</span>
                      </button>
                    </div>
                  </section>
                  <section class="wr-topic-detail">
                    ${renderGroupDetail(current)}
                  </section>
                </div>`
          }
        </aside>
      </div>
    `;
  }

  async function openPanel() {
    let root = document.getElementById("wr-topic-panel-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "wr-topic-panel-root";
      if (!safeAppend(getMountRoot(), root, "panel root")) return;
    }

    if (root) {
      root.innerHTML = `
        <div class="wr-topic-overlay">
          <aside class="wr-topic-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(text.panelTitle)}">
            <header class="wr-topic-panel-header">
              <div class="wr-topic-panel-title-row">
                <div>
                  <h2>${text.panelTitle}</h2>
                  <p>${text.loading}</p>
                </div>
                <button class="wr-topic-btn" type="button" data-wr-action="close-panel">${text.close}</button>
              </div>
            </header>
          </aside>
        </div>
      `;
    }

    try {
      state.formMode = "";
      scanBooks();
      renderPanel();
      await ensureStorageReady();
      refreshShelf();
      renderPanel();
    } catch (error) {
      console.error("[WeRead Local Topic Shelf] render panel failed:", error);
    }
  }

  function closePanel() {
    const root = document.getElementById("wr-topic-panel-root");
    if (root) root.remove();
    state.formMode = "";
    state.editingGroupId = "";
  }

  function updateBookPicker() {
    const picker = document.querySelector("[data-wr-book-picker]");
    if (picker) picker.innerHTML = bookPickerHtml();
  }

  async function saveGroupFromForm(form) {
    const name = form.elements.name.value.trim();
    const description = form.elements.description.value.trim();

    if (!name) {
      alert(text.emptyName);
      return;
    }

    if (!state.selectedBookIds.size) {
      alert(text.emptyBooks);
      return;
    }

    const groups = getGroups();
    const now = new Date().toISOString();
    const books = [...state.selectedBookIds]
      .map((id) => findBook(id))
      .filter(Boolean);

    if (state.formMode === "edit") {
      const group = groups.find((item) => item.id === state.editingGroupId);
      if (!group) return;
      group.name = name;
      group.description = description;
      group.books = books;
      group.updatedAt = now;
      state.selectedGroupId = group.id;
    } else {
      const group = {
        id: `topic_${Date.now()}`,
        name,
        description,
        books,
        createdAt: now,
        updatedAt: now,
      };
      groups.unshift(group);
      state.selectedGroupId = group.id;
    }

    await saveGroups(groups);
    state.formMode = "";
    state.editingGroupId = "";
    refreshShelf();
  }

  async function removeBookFromGroup(groupId, bookId) {
    const groups = getGroups();
    const group = groups.find((item) => item.id === groupId);
    if (!group) return;

    group.books = (group.books || []).filter((book) => book.id !== bookId);
    group.updatedAt = new Date().toISOString();

    if (!group.books.length) {
      const keep = confirm(
        "这个主题已经没有书了，是否删除主题？点击取消则保留空主题。",
      );
      if (keep) {
        markDeleted("groups", groupId, group.updatedAt);
        await saveGroups(groups.filter((item) => item.id !== groupId));
      } else {
        await saveGroups(groups);
      }
    } else {
      await saveGroups(groups);
    }

    refreshShelf();
  }

  async function deleteGroup(groupId) {
    if (!confirm(text.deleteConfirm)) return;

    const groups = getGroups().filter((group) => group.id !== groupId);
    markDeleted("groups", groupId);
    await saveGroups(groups);
    state.selectedGroupId = groups[0] ? groups[0].id : "";
    state.formMode = "";
    refreshShelf();
  }

  function openBookNote(bookId) {
    const book = findBook(bookId);
    if (!book) return;

    const notes = getNotes();
    const note = notes[bookId] || { note: "", status: "", question: "" };
    const obsidian = getObsidianContext(bookId);
    const obsidianAuthoritative = hasObsidianReadingContext(obsidian);
    const contextValue = obsidianAuthoritative ? obsidian.context : note.note;
    const questionValue = obsidianAuthoritative
      ? obsidian.question
      : note.question;

    const modal = document.createElement("div");
    modal.className = "wr-topic-modal";
    modal.id = "wr-topic-note-modal";
    modal.innerHTML = `
      <div class="wr-topic-modal-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(text.bookNoteTitle)}">
        <div class="wr-topic-modal-head">
          <h3>${text.bookNoteTitle}</h3>
          <button class="wr-topic-btn" type="button" data-wr-action="close-note-modal">${text.close}</button>
        </div>
        <div class="wr-topic-modal-book">
          <img src="${escapeHtml(book.cover)}" alt="">
          <div>
            <span class="wr-topic-book-title">${escapeHtml(book.title)}</span>
            <span class="wr-topic-book-author">${escapeHtml(book.author)}</span>
          </div>
        </div>
        <form class="wr-topic-form" data-wr-form="note" data-book-id="${escapeHtml(bookId)}" data-obsidian-authoritative="${obsidianAuthoritative ? "1" : "0"}">
          ${obsidianAuthoritative ? `<p class="wr-topic-source-note">阅读上下文和阅读问题来自 Obsidian，只读展示。原有本地内容仍被保留。</p>` : ""}
          <div class="wr-topic-field">
            <label for="wr-note-main">${text.whyRead}</label>
            <textarea id="wr-note-main" class="wr-topic-textarea" name="note" ${obsidianAuthoritative ? "readonly" : ""}>${escapeHtml(contextValue || "")}</textarea>
          </div>
          <div class="wr-topic-field">
            <label for="wr-note-status">${text.status}</label>
            <input id="wr-note-status" class="wr-topic-input" name="status" value="${escapeHtml(note.status || "")}">
          </div>
          <div class="wr-topic-field">
            <label for="wr-note-question">${text.question}</label>
            <textarea id="wr-note-question" class="wr-topic-textarea" name="question" ${obsidianAuthoritative ? "readonly" : ""}>${escapeHtml(questionValue || "")}</textarea>
          </div>
          <div class="wr-topic-modal-actions">
            <button class="wr-topic-btn danger" type="button" data-wr-action="delete-book-note" data-book-id="${escapeHtml(bookId)}">${obsidianAuthoritative ? "清除本地状态" : text.deleteNote}</button>
            <button class="wr-topic-btn primary" type="submit">${text.save}</button>
          </div>
        </form>
      </div>
    `;
    safeAppend(getMountRoot(), modal, "note modal");
  }

  function closeNoteModal() {
    const modal = document.getElementById("wr-topic-note-modal");
    if (modal) modal.remove();
  }

  async function saveBookNote(form) {
    const bookId = form.dataset.bookId;
    const book = findBook(bookId);
    if (!book) return;

    const notes = getNotes();
    const existing = notes[bookId] || { note: "", question: "" };
    const obsidianAuthoritative = form.dataset.obsidianAuthoritative === "1";
    notes[bookId] = buildBookNote(
      existing,
      book,
      {
        note: form.elements.note.value,
        status: form.elements.status.value,
        question: form.elements.question.value,
      },
      obsidianAuthoritative,
    );

    if (
      !notes[bookId].note &&
      !notes[bookId].status &&
      !notes[bookId].question
    ) {
      markDeleted("notes", bookId, notes[bookId].updatedAt);
      delete notes[bookId];
    }

    await saveNotes(notes);
    closeNoteModal();
    refreshShelf();
  }

  async function deleteBookNote(bookId) {
    const notes = getNotes();
    markDeleted("notes", bookId);
    delete notes[bookId];
    await saveNotes(notes);
    closeNoteModal();
    refreshShelf();
  }

  async function waitForShelfList(timeout = 10000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const shelfList = document.querySelector(SELECTORS.shelfList);
      if (shelfList) return shelfList;
      await sleep(300);
    }

    return document.querySelector(SELECTORS.shelfList);
  }

  async function autoLoadFullShelf() {
    let lastCount = 0;
    let stableTimes = 0;

    for (let i = 0; i < 50; i++) {
      const count = document.querySelectorAll(SELECTORS.shelfBook).length;

      if (count === lastCount) stableTimes += 1;
      else stableTimes = 0;

      lastCount = count;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(700);

      if (stableTimes >= 5) break;
    }

    window.scrollTo(0, 0);
    await sleep(300);
    refreshShelf();
  }

  async function onClick(event) {
    const actionEl = event.target.closest("[data-wr-action]");
    if (!actionEl) return;

    const action = actionEl.dataset.wrAction;

    if (
      actionEl.closest("#wr-topic-panel-root") ||
      actionEl.closest("#wr-topic-note-modal") ||
      actionEl.closest("#wr-topic-cloud-modal") ||
      actionEl.classList.contains("wr-topic-entry") ||
      actionEl.classList.contains("wr-book-context-icon") ||
      actionEl.classList.contains("wr-topic-shelf-group")
    ) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (action === "open-panel") await openPanel();
    if (action === "open-cloud-settings") openCloudSettings();
    if (action === "close-cloud-settings") closeCloudSettings();
    if (action === "sync-cloud") {
      try {
        await syncCloud({ reason: "manual" });
      } catch (error) {
        alert(`云同步失败：${error.message}`);
      }
    }
    if (
      action === "close-panel" &&
      (actionEl === event.target || actionEl.tagName === "BUTTON")
    )
      closePanel();
    if (action === "new-group") {
      state.panelTab = "groups";
      state.formMode = "new";
      state.editingGroupId = "";
      state.selectedBookIds = new Set();
      state.bookFilter = "";
      renderPanel();
    }
    if (action === "refresh-shelf") refreshShelf();
    if (action === "load-full-shelf") autoLoadFullShelf();
    if (action === "switch-tab") {
      state.panelTab = actionEl.dataset.tab === "catalog" ? "catalog" : "groups";
      renderPanel();
    }
    if (action === "catalog-filter") {
      state.catalogFilter = actionEl.dataset.filter || "all";
      renderPanel();
    }
    if (action === "refresh-catalog") {
      if (!isCloudConfigured()) {
        alert("请先配置并启用 Cloudflare KV 云同步。");
        openCloudSettings();
      } else {
        try {
          await resolveObsidianCatalog();
        } catch (error) {
          alert(`刷新书目匹配失败：${error.message}`);
        }
      }
    }
    if (action === "select-group" || action === "open-group") {
      state.selectedGroupId = actionEl.dataset.groupId;
      state.formMode = "";
      await openPanel();
    }
    if (action === "edit-group") {
      state.selectedGroupId = actionEl.dataset.groupId;
      state.formMode = "edit";
      state.editingGroupId = actionEl.dataset.groupId;
      const group = getGroups().find(
        (item) => item.id === actionEl.dataset.groupId,
      );
      state.selectedBookIds = new Set(
        group ? (group.books || []).map((book) => book.id) : [],
      );
      state.bookFilter = "";
      renderPanel();
    }
    if (action === "cancel-form") {
      state.formMode = "";
      renderPanel();
    }
    if (action === "toggle-book") {
      const id = actionEl.dataset.bookId;
      if (state.selectedBookIds.has(id)) state.selectedBookIds.delete(id);
      else state.selectedBookIds.add(id);
      updateBookPicker();
    }
    if (action === "submit-group") {
      const form = actionEl.closest('[data-wr-form="group"]');
      if (form) form.requestSubmit();
    }
    if (action === "delete-group") await deleteGroup(actionEl.dataset.groupId);
    if (action === "remove-book")
      await removeBookFromGroup(
        actionEl.dataset.groupId,
        actionEl.dataset.bookId,
      );
    if (action === "open-reader") {
      const opened = window.open(
        actionEl.dataset.url,
        "_blank",
        "noopener,noreferrer",
      );
      if (opened) opened.opener = null;
    }
    if (action === "open-book-note") openBookNote(actionEl.dataset.bookId);
    if (action === "close-note-modal") closeNoteModal();
    if (action === "delete-book-note")
      await deleteBookNote(actionEl.dataset.bookId);
  }

  async function onSubmit(event) {
    const form = event.target.closest("[data-wr-form]");
    if (!form) return;

    event.preventDefault();
    event.stopPropagation();

    if (form.dataset.wrForm === "group") await saveGroupFromForm(form);
    if (form.dataset.wrForm === "note") await saveBookNote(form);
    if (form.dataset.wrForm === "cloud") await saveCloudSettings(form);
  }

  function onInput(event) {
    const actionEl = event.target.closest(
      '[data-wr-action="filter-books"], [data-wr-action="filter-catalog"]',
    );
    if (!actionEl) return;

    if (actionEl.dataset.wrAction === "filter-books") {
      state.bookFilter = actionEl.value || "";
      updateBookPicker();
      return;
    }

    state.catalogQuery = actionEl.value || "";
    const list = document.querySelector("[data-wr-catalog-list]");
    if (list) list.innerHTML = catalogListHtml();
  }

  function onKeydown(event) {
    if (event.key !== "Escape") return;
    if (document.getElementById("wr-topic-cloud-modal")) {
      closeCloudSettings();
    } else if (document.getElementById("wr-topic-note-modal")) {
      closeNoteModal();
    } else if (document.getElementById("wr-topic-panel-root")) {
      closePanel();
    }
  }

  function bindEventListeners() {
    if (state.listenersBound) return;

    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeydown, true);
    state.listenersBound = true;
  }

  async function init() {
    injectStyle();
    bindEventListeners();
    ensureFloatingButton();
    await ensureStorageReady();
    await waitForShelfList();
    refreshShelf();
    if (isCloudConfigured()) scheduleCloudSync(300);

    window.setInterval(() => {
      ensureFloatingButton();
      const signature = getShelfSignature();
      if (signature === state.lastShelfSignature) return;
      state.lastShelfSignature = signature;
      refreshShelf();
    }, 1500);

    window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        isCloudConfigured() &&
        Date.now() - state.lastCloudPullAt >= CLOUD_PULL_INTERVAL
      ) {
        syncCloud({ reason: "interval" }).catch((error) => {
          console.warn("[WeRead Local Topic Shelf] periodic cloud sync failed:", error);
        });
      }
    }, 60 * 1000);

    window.addEventListener("online", () => scheduleCloudSync(300));
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - state.lastCloudPullAt >= CLOUD_PULL_INTERVAL
      ) {
        scheduleCloudSync(300);
      }
    });
  }

  init();
})();
