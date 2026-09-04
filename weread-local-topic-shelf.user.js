// ==UserScript==
// @name         WeRead Local Topic Shelf
// @namespace    local.weread.topic-shelf
// @version      0.6.2
// @description  Add a local book library, topic groups, reading context, and optional Cloudflare KV sync to WeRead shelf.
// @match        *://weread.qq.com/web/shelf*
// @run-at       document-end
// @updateURL    https://github.com/yuenci/weread-shelf/raw/refs/heads/master/weread-local-topic-shelf.user.js
// @downloadURL  https://github.com/yuenci/weread-shelf/raw/refs/heads/master/weread-local-topic-shelf.user.js
// @require      https://cdn.jsdelivr.net/npm/cytoscape@3.34.2/dist/cytoscape.min.js
// @grant        GM_xmlhttpRequest
// @connect      workers.dev
// @connect      res.weread.qq.com
// @connect      cdn.weread.qq.com
// @connect      *.tencent-cloud.com
// ==/UserScript==

(function () {
  "use strict";

  const STORE = {
    groups: "weread_local_topic_shelf_groups_v1",
    notes: "weread_local_book_context_notes_v1",
    relations: "weread_local_reading_relations_v1",
    readingLevels: "weread_local_reading_levels_v1",
    libraryBooks: "weread_local_library_books_v1",
    cloudConfig: "weread_cloud_sync_config_v1",
    syncMeta: "weread_cloud_sync_meta_v1",
    obsidianCache: "weread_obsidian_catalog_cache_v1",
  };

  const DEFAULT_CLOUD_BASE_URL = "";
  const CLOUD_SCHEMA_VERSION = 2;
  const CLOUD_PUSH_DELAY = 1800;
  const CLOUD_PULL_INTERVAL = 5 * 60 * 1000;
  const READING_LEVELS = new Set(["deep", "light", "casual"]);

  const SELECTORS = {
    shelfList: ".shelf_list",
    shelfBook: '.shelf_list a.shelfBook[href*="/web/reader/"]',
    bookTitle: ".title",
    bookCover: "img",
  };

  const state = {
    books: [],
    libraryBooks: {},
    groups: [],
    notes: {},
    relations: [],
    readingLevels: {},
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
    levelFilter: "all",
    levelQuery: "",
    libraryFilter: "all",
    libraryQuery: "",
    editingBookId: "",
    bookModalReturn: null,
    catalogLoading: false,
    obsidianCache: {
      books: [],
      contexts: {},
      stats: null,
      resolvedAt: "",
      cached: false,
      error: "",
    },
    noteNavigationStack: [],
    noteDrafts: {},
    graph: null,
    graphContext: null,
    routeActive: false,
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
    question: "阅读问题",
    lineage: "阅读脉络",
    nextStop: "下一站",
    addDiscovery: "添加发现",
    viewGraph: "查看关系图",
    libraryGraph: "全库关系",
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
    gradedReading: "分级阅读",
    bookManagement: "书籍管理",
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
        relations: {},
        levels: {},
        books: {},
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
    let relations = await dbGet(STORE.relations, null);
    let readingLevels = await dbGet(STORE.readingLevels, null);
    let libraryBooks = await dbGet(STORE.libraryBooks, null);
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

    if (relations === null) {
      relations = [];
      await dbSet(STORE.relations, relations);
    }

    if (readingLevels === null) {
      readingLevels = {};
      await dbSet(STORE.readingLevels, readingLevels);
    }

    state.groups = Array.isArray(groups) ? groups : [];
    state.notes = notes && typeof notes === "object" ? notes : {};
    state.relations = Array.isArray(relations) ? relations : [];
    state.readingLevels =
      readingLevels && typeof readingLevels === "object" && !Array.isArray(readingLevels)
        ? readingLevels
        : {};
    state.libraryBooks =
      libraryBooks && typeof libraryBooks === "object" && !Array.isArray(libraryBooks)
        ? libraryBooks
        : {};
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
        relations:
          syncMeta &&
          syncMeta.tombstones &&
          syncMeta.tombstones.relations &&
          typeof syncMeta.tombstones.relations === "object"
            ? syncMeta.tombstones.relations
            : {},
        levels:
          syncMeta &&
          syncMeta.tombstones &&
          syncMeta.tombstones.levels &&
          typeof syncMeta.tombstones.levels === "object"
            ? syncMeta.tombstones.levels
            : {},
        books:
          syncMeta &&
          syncMeta.tombstones &&
          syncMeta.tombstones.books &&
          typeof syncMeta.tombstones.books === "object"
            ? syncMeta.tombstones.books
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

    const migrated = await migrateLibraryState();
    if (libraryBooks === null || migrated) {
      await Promise.all([
        dbSet(STORE.libraryBooks, state.libraryBooks),
        dbSet(STORE.groups, state.groups),
        dbSet(STORE.notes, state.notes),
        dbSet(STORE.relations, state.relations),
        dbSet(STORE.readingLevels, state.readingLevels),
      ]);
      state.syncMeta.dirty = true;
      state.syncMeta.localUpdatedAt = nowIso();
    }
    if (!syncMeta || libraryBooks === null || migrated) {
      await dbSet(STORE.syncMeta, state.syncMeta);
    }
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
        ["note", "question"].some((field) =>
          String(note[field] || "").trim(),
        ),
    );
  }

  async function saveNotes(notes) {
    state.notes = notes;
    await dbSet(STORE.notes, notes);
    await markLocalChange();
  }

  async function saveRelations(relations) {
    state.relations = relations;
    await dbSet(STORE.relations, relations);
    await markLocalChange();
  }

  async function saveReadingLevels(readingLevels) {
    state.readingLevels = readingLevels;
    await dbSet(STORE.readingLevels, readingLevels);
    await markLocalChange();
  }

  async function saveLibraryBooks(libraryBooks) {
    state.libraryBooks = libraryBooks;
    await dbSet(STORE.libraryBooks, libraryBooks);
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
      state.syncMeta.tombstones = {
        groups: {},
        notes: {},
        relations: {},
        levels: {},
        books: {},
      };
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
      relations:
        value && value.relations && typeof value.relations === "object"
          ? value.relations
          : {},
      levels:
        value && value.levels && typeof value.levels === "object"
          ? value.levels
          : {},
      books:
        value && value.books && typeof value.books === "object"
          ? value.books
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
    const before = JSON.stringify({
      groups: state.groups,
      notes: state.notes,
      relations: state.relations,
      levels: state.readingLevels,
      books: state.libraryBooks,
      tombstones: state.syncMeta.tombstones,
    });
    const nextGroups = Array.isArray(payload.groups) ? payload.groups : [];
    const nextNotes =
      payload.notes && typeof payload.notes === "object" ? payload.notes : {};
    const nextRelations = Array.isArray(payload.relations)
      ? payload.relations
      : state.relations;
    const nextReadingLevels =
      payload.levels && typeof payload.levels === "object" && !Array.isArray(payload.levels)
        ? payload.levels
        : state.readingLevels;
    const nextLibraryBooks =
      payload.books && typeof payload.books === "object" && !Array.isArray(payload.books)
        ? payload.books
        : state.libraryBooks;
    const nextTombstones = normalizeTombstones(payload.tombstones);
    if (
      !Array.isArray(payload.relations) &&
      (!payload.tombstones || !payload.tombstones.relations)
    ) {
      nextTombstones.relations = state.syncMeta.tombstones.relations || {};
    }
    if (
      (!payload.levels || typeof payload.levels !== "object" || Array.isArray(payload.levels)) &&
      (!payload.tombstones || !payload.tombstones.levels)
    ) {
      nextTombstones.levels = state.syncMeta.tombstones.levels || {};
    }
    if (
      (!payload.books || typeof payload.books !== "object" || Array.isArray(payload.books)) &&
      (!payload.tombstones || !payload.tombstones.books)
    ) {
      nextTombstones.books = state.syncMeta.tombstones.books || {};
    }
    const remoteRelations = JSON.stringify(nextRelations);
    const remoteBooks = JSON.stringify(nextLibraryBooks);
    const remoteTombstones = JSON.stringify(nextTombstones);

    state.groups = nextGroups;
    state.notes = nextNotes;
    state.relations = nextRelations;
    state.readingLevels = nextReadingLevels;
    state.libraryBooks = nextLibraryBooks;
    state.syncMeta.tombstones = nextTombstones;
    await migrateLibraryState();
    const migrationNeedsPush =
      JSON.stringify(state.relations) !== remoteRelations ||
      JSON.stringify(state.libraryBooks) !== remoteBooks ||
      JSON.stringify(state.syncMeta.tombstones) !== remoteTombstones;
    const changed =
      before !==
      JSON.stringify({
        groups: state.groups,
        notes: state.notes,
        relations: state.relations,
        levels: state.readingLevels,
        books: state.libraryBooks,
        tombstones: state.syncMeta.tombstones,
      });
    if (!changed) return { changed: false, migrationNeedsPush };

    await Promise.all([
      dbSet(STORE.groups, state.groups),
      dbSet(STORE.notes, state.notes),
      dbSet(STORE.relations, state.relations),
      dbSet(STORE.readingLevels, state.readingLevels),
      dbSet(STORE.libraryBooks, state.libraryBooks),
    ]);
    if (!isShelfEnhancementRoute()) {
      deactivateShelfEnhancements();
      return { changed: true, migrationNeedsPush };
    }
    if (!state.formMode && !document.getElementById("wr-topic-note-modal")) {
      refreshShelf();
    } else {
      renderShelfGroups();
      applyHiddenBooks();
      renderBookNoteIcons();
    }
    return { changed: true, migrationNeedsPush };
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

  function bookHasReadingContext(bookId) {
    return (
      hasObsidianReadingContext(getObsidianContext(bookId)) ||
      hasReadingContext(getNotes()[bookId])
    );
  }

  function groupBooks(group) {
    if (!group) return [];
    if (Array.isArray(group.bookIds)) {
      return group.bookIds.map((id) => findBook(id)).filter(Boolean);
    }
    return Array.isArray(group.books) ? group.books : [];
  }

  function groupContextProgress(group) {
    const books = groupBooks(group);
    return {
      completed: books.filter((book) => bookHasReadingContext(book.id)).length,
      total: books.length,
    };
  }

  function isShelfEnhancementRoute(pathname = window.location.pathname) {
    return String(pathname || "").replace(/\/+$/, "") === "/web/shelf";
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
        libraryBooks: libraryBookList().map((book) => ({ id: book.id, title: book.title })),
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
      groups: state.groups.map((group) => ({
        ...group,
        books: groupBooks(group).map(legacyBookSnapshot).filter(Boolean),
      })),
      notes: state.notes,
      relations: state.relations,
      levels: state.readingLevels,
      books: state.libraryBooks,
      tombstones: state.syncMeta.tombstones,
    });
    const applied = await applyWereadSyncResponse(result.body);
    if (applied && applied.migrationNeedsPush) {
      state.syncMeta.localUpdatedAt = nowIso();
    }

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
      edit:
        '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
      arrowLeft: '<path d="m15 18-6-6 6-6"/>',
      external:
        '<path d="M15 3h6v6"/><path d="m10 14 11-11"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
      fit:
        '<circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/>',
      fullscreen:
        '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
      exitFullscreen:
        '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M16 3v3a2 2 0 0 0 2 2h3"/><path d="M8 21v-3a2 2 0 0 0-2-2H3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
      info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
      library:
        '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
      bookOpen:
        '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3Z"/><path d="M21 18a1 1 0 0 0 1-1V5a2 2 0 0 0-2-2h-5a3 3 0 0 0-3 3v15a3 3 0 0 1 3-3Z"/>',
      check: '<path d="m20 6-11 11-5-5"/>',
      chevronRight: '<path d="m9 18 6-6-6-6"/>',
      moreVertical:
        '<circle cx="12" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>',
      network:
        '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="m12 7-6 10"/><path d="m12 7 6 10"/><path d="M7 19h10"/>',
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

      .wr-topic-panel button:not(:disabled),
      .wr-topic-modal button:not(:disabled),
      .wr-topic-entry,
      .wr-book-context-icon,
      .wr-topic-shelf-group,
      a.shelfBook[href] {
        cursor: pointer !important;
      }

      .wr-topic-panel button:disabled,
      .wr-topic-modal button:disabled {
        cursor: not-allowed !important;
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
        min-height: 32px;
        display: flex;
        align-items: center;
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
        line-height: 32px;
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
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
      }

      .wr-topic-header-tool {
        height: 32px;
        min-height: 32px;
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
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
      }

      .wr-topic-sync-group {
        min-width: 0;
        height: 32px;
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
        top: 22px;
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
        padding-bottom: 0;
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
        padding: 0;
        border-top: 1px solid var(--wr-topic-border);
        background: #fff;
      }

      .wr-topic-new-group-btn {
        width: 100%;
        min-height: 44px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 0;
        border-radius: 0;
        padding: 0 10px;
        background: transparent;
        color: #7d8796;
        font-size: 12px;
        font-weight: 400;
        cursor: pointer;
        transition: color .16s ease;
      }

      .wr-topic-new-group-btn:hover,
      .wr-topic-new-group-btn:focus-visible {
        color: var(--wr-topic-blue);
        outline: none;
      }

      .wr-topic-new-group-btn:focus-visible {
        box-shadow: inset 0 0 0 1px rgba(47, 128, 237, .28);
      }

      .wr-topic-new-group-icon {
        width: 14px;
        height: 14px;
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
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        color: #8a94a6;
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wr-topic-group-footer {
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-top: 8px;
      }

      .wr-topic-group-progress {
        flex: 0 0 auto;
        color: #526070;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
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

      .wr-topic-graded {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: 22px 26px 0;
        background: #fbfbfa;
      }

      .wr-topic-graded-head,
      .wr-topic-graded-controls,
      .wr-topic-graded-stats,
      .wr-topic-graded-filters {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .wr-topic-graded-head {
        justify-content: space-between;
        margin-bottom: 14px;
      }

      .wr-topic-graded-head p {
        margin: 4px 0 0;
        color: var(--wr-topic-muted);
        font-size: 12px;
      }

      .wr-topic-graded-stats {
        margin-bottom: 14px;
      }

      .wr-topic-graded-stat {
        min-width: 112px;
        border: 0;
        border-left: 3px solid #cad1dc;
        padding: 6px 10px;
        background: #fff;
        color: inherit;
        text-align: left;
      }

      .wr-topic-graded-stat:hover,
      .wr-topic-graded-stat.active {
        border-left-color: var(--wr-topic-blue);
        background: rgba(47, 128, 237, .05);
      }

      .wr-topic-graded-stat strong,
      .wr-topic-graded-stat span {
        display: block;
      }

      .wr-topic-graded-stat strong {
        font-size: 18px;
      }

      .wr-topic-graded-stat span {
        margin-top: 2px;
        color: var(--wr-topic-muted);
        font-size: 11px;
      }

      .wr-topic-graded-controls {
        margin-bottom: 14px;
      }

      .wr-topic-graded-search {
        flex: 1 1 240px;
        max-width: 380px;
      }

      .wr-topic-graded-list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 0 5px 28px 0;
        scrollbar-width: thin;
        scrollbar-color: rgba(82, 96, 112, .48) transparent;
      }

      .wr-topic-graded-list::-webkit-scrollbar {
        width: 4px;
      }

      .wr-topic-graded-list::-webkit-scrollbar-thumb {
        border-radius: 999px;
        background: rgba(82, 96, 112, .48);
      }

      .wr-topic-graded-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .wr-topic-graded-card {
        min-width: 0;
        height: 142px;
        display: grid;
        grid-template-columns: 78px minmax(0, 1fr);
        gap: 12px;
        border: 1px solid var(--wr-topic-border);
        border-radius: 8px;
        padding: 10px;
        overflow: hidden;
        background: #fff;
        color: inherit;
        text-align: left;
      }

      .wr-topic-graded-card:hover,
      .wr-topic-graded-card:focus-visible {
        border-color: rgba(47, 128, 237, .42);
        box-shadow: 0 6px 18px rgba(15, 23, 42, .06);
      }

      .wr-topic-graded-cover {
        width: 78px;
        height: 120px;
        display: grid;
        place-items: center;
        border-radius: 4px;
        object-fit: cover;
        background: #edf1f7;
        color: #6b7b93;
        font-size: 20px;
        font-weight: 700;
      }

      .wr-topic-graded-content {
        min-width: 0;
        height: 120px;
        display: flex;
        flex-direction: column;
      }

      .wr-topic-graded-title {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        font-size: 13px;
        font-weight: 650;
        line-height: 1.4;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .wr-topic-graded-author {
        overflow: hidden;
        margin-top: 3px;
        color: var(--wr-topic-muted);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wr-topic-graded-context {
        display: -webkit-box;
        flex: 1 1 auto;
        min-height: 0;
        margin-top: 6px;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        overflow: hidden;
        color: #526070;
        font-size: 10px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }

      .wr-topic-graded-context.is-empty {
        color: #8a94a6;
      }

      .wr-topic-level-badge {
        align-self: flex-start;
        flex: 0 0 auto;
        margin-top: 5px;
        border-radius: 4px;
        padding: 2px 6px;
        background: #edf1f7;
        color: #526070;
        font-size: 10px;
        line-height: 1.4;
      }

      .wr-topic-level-badge.deep {
        background: #e9f2ff;
        color: #1768c5;
      }

      .wr-topic-level-badge.light {
        background: #eaf8f0;
        color: #16794a;
      }

      .wr-topic-level-badge.casual {
        background: #fff4df;
        color: #946200;
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

      .wr-topic-detail-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .wr-topic-detail-icon-btn {
        width: 30px;
        height: 30px;
        min-height: 30px;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 0;
        font-size: 0;
        line-height: 0;
      }

      .wr-topic-detail-icon-btn .wr-topic-icon {
        width: 15px;
        height: 15px;
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
        padding: 0 6px 30px 0;
      }

      .wr-topic-group-book-card {
        position: relative;
        min-width: 0;
        height: 148px;
        min-height: 148px;
        display: grid;
        grid-template-columns: 82px minmax(0, 1fr);
        gap: 12px;
        border: 1px solid var(--wr-topic-border);
        border-radius: 8px;
        padding: 12px;
        overflow: visible;
        background: #fff;
        transition: border-color .16s ease, box-shadow .16s ease;
      }

      .wr-topic-group-book-card:hover,
      .wr-topic-group-book-card:focus-within {
        z-index: 3;
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
        height: 122px;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .wr-topic-group-book-title-action {
        display: -webkit-box;
        max-width: 100%;
        padding-right: 48px;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        overflow: hidden;
        color: var(--wr-topic-text);
        font-size: 13px;
        font-weight: 650;
        line-height: 1.4;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .wr-topic-group-book-title-action:hover {
        color: var(--wr-topic-blue);
      }

      .wr-topic-group-book-context {
        display: -webkit-box;
        flex: 1 1 0;
        min-height: 0;
        max-width: 100%;
        margin-top: 8px;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 5;
        overflow: hidden;
        color: #526070;
        font-size: 10px;
        line-height: 1.5;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      .wr-topic-group-book-context:hover {
        color: #315b89;
      }

      .wr-topic-group-book-context.is-empty {
        color: #8a94a6;
      }

      .wr-topic-group-book-menu {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 5;
      }

      .wr-topic-group-book-menu-button {
        width: 28px;
        height: 28px;
        min-height: 28px;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 0;
        font-size: 0;
        line-height: 0;
        opacity: 0;
        pointer-events: none;
        transform: translateY(-2px);
        transition: opacity .16s ease, transform .16s ease;
      }

      .wr-topic-group-book-card:hover .wr-topic-group-book-menu-button,
      .wr-topic-group-book-card:focus-within .wr-topic-group-book-menu-button {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
      }

      .wr-topic-group-book-menu-button .wr-topic-icon {
        width: 14px;
        height: 14px;
      }

      .wr-topic-book-menu-popover,
      .wr-topic-level-submenu {
        position: absolute;
        z-index: 10;
        width: 150px;
        border: 1px solid var(--wr-topic-border);
        border-radius: 6px;
        padding: 4px;
        background: #fff;
        box-shadow: 0 10px 28px rgba(15, 23, 42, .16);
      }

      .wr-topic-book-menu-popover {
        top: 32px;
        right: 0;
      }

      .wr-topic-level-submenu {
        top: -5px;
        right: calc(100% + 6px);
      }

      .wr-topic-book-menu-popover[hidden],
      .wr-topic-level-submenu[hidden] {
        display: none;
      }

      .wr-topic-book-menu-item {
        width: 100%;
        min-height: 32px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        border: 0;
        border-radius: 4px;
        padding: 6px 8px;
        background: transparent;
        color: var(--wr-topic-text);
        font-size: 12px;
        text-align: left;
      }

      .wr-topic-book-menu-item:hover,
      .wr-topic-book-menu-item:focus-visible {
        background: #f3f6fa;
      }

      .wr-topic-book-menu-item.danger {
        color: var(--wr-topic-danger);
      }

      .wr-topic-book-menu-item .wr-topic-icon {
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

      .wr-topic-cloud-summary {
        margin: 8px 0 0 !important;
        color: var(--wr-topic-muted);
        font-size: 12px;
        line-height: 1.6;
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

      .wr-topic-modal-book-info {
        min-width: 0;
        flex: 1 1 auto;
      }

      .wr-topic-modal-book-tools {
        flex: 0 0 auto;
        display: flex;
        align-items: flex-end;
        gap: 8px;
      }

      .wr-topic-modal-level {
        display: grid;
        gap: 4px;
        color: var(--wr-topic-muted);
        font-size: 11px;
      }

      .wr-topic-modal-level .wr-topic-input {
        width: 116px;
        min-height: 32px;
        padding: 5px 26px 5px 8px;
        font-size: 12px;
      }

      .wr-topic-modal-reader-btn {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
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
        border-radius: 999px;
        border: 2px solid #fff;
        background: var(--wr-topic-blue);
        color: #fff;
        font-size: 15px;
        line-height: 21px;
        text-align: center;
        cursor: pointer;
        opacity: 0;
        box-shadow: 0 4px 12px rgba(0, 0, 0, .22);
        transition: opacity .16s ease, background .16s ease;
      }

      .shelfBook:hover .wr-book-context-icon {
        opacity: 1;
      }

      .wr-book-context-icon.has-note {
        opacity: 1;
        background: var(--wr-topic-blue);
        font-family: Georgia, "Times New Roman", serif;
        font-size: 16px;
        font-weight: 700;
        box-shadow:
          0 0 0 2px rgba(255, 255, 255, .95),
          0 6px 16px rgba(47, 128, 237, .4),
          0 2px 6px rgba(0, 0, 0, .22);
      }

      .wr-topic-nested-modal {
        z-index: 2147483605;
      }

      .wr-topic-note-card {
        height: min(780px, calc(100vh - 44px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .wr-topic-note-heading,
      .wr-topic-note-actions > div,
      .wr-topic-btn:has(.wr-topic-icon) {
        display: flex;
        align-items: center;
        gap: 7px;
      }

      .wr-topic-icon-btn {
        width: 32px;
        height: 32px;
        min-width: 32px;
        display: grid;
        place-items: center;
        border: 1px solid var(--wr-topic-border);
        border-radius: 6px;
        padding: 0;
        background: #fff;
        color: #526070;
      }

      .wr-topic-icon-btn:hover,
      .wr-topic-icon-btn:focus-visible {
        border-color: #b9c4d2;
        color: var(--wr-topic-blue);
        outline: none;
      }

      .wr-topic-modal-book-cover,
      .wr-topic-modal-book .wr-topic-modal-book-cover {
        flex: 0 0 52px;
        width: 52px;
        height: 76px;
      }

      .wr-topic-cover-placeholder {
        display: grid;
        place-items: center;
        border-radius: 4px;
        background: #edf1f7;
        color: #68778b;
        font-weight: 700;
      }

      .wr-topic-note-scroll {
        min-height: 0;
        flex: 1 1 auto;
        display: grid;
        align-content: start;
        gap: 15px;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 2px 6px 14px 0;
        scrollbar-width: thin;
      }

      .wr-topic-relation-slot {
        display: contents;
      }

      .wr-topic-relation-section h4 {
        margin: 0 0 9px;
        color: #344054;
        font-size: 13px;
      }

      .wr-topic-relation-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
        gap: 9px;
      }

      .wr-topic-relation-card {
        position: relative;
        min-width: 0;
        border: 1px solid var(--wr-topic-border);
        border-radius: 8px;
        overflow: hidden;
        background: #fff;
      }

      .wr-topic-relation-card:hover,
      .wr-topic-relation-card:focus-within {
        border-color: rgba(47, 128, 237, .42);
      }

      .wr-topic-relation-main {
        width: 100%;
        min-width: 0;
        min-height: 92px;
        display: grid;
        grid-template-columns: 48px minmax(0, 1fr);
        align-items: start;
        gap: 10px;
        border: 0;
        padding: 10px;
        background: transparent;
        text-align: left;
      }

      .wr-topic-relation-cover {
        width: 48px;
        height: 70px;
        object-fit: cover;
        border-radius: 3px;
        box-shadow: 0 2px 7px rgba(15, 23, 42, .12);
      }

      .wr-topic-relation-content {
        min-width: 0;
        display: grid;
        gap: 4px;
      }

      .wr-topic-relation-content strong {
        padding-right: 58px;
        overflow: hidden;
        color: var(--wr-topic-text);
        font-size: 12px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .wr-topic-relation-type {
        width: fit-content;
        border-radius: 4px;
        padding: 2px 5px;
        background: #eaf2ff;
        color: #2269bd;
        font-size: 10px;
      }

      .wr-topic-relation-type.author-citation {
        background: #fff2dd;
        color: #a45c00;
      }

      .wr-topic-relation-type.question-driven {
        background: #e8f6ee;
        color: #237a4b;
      }

      .wr-topic-relation-reason {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        overflow: hidden;
        color: var(--wr-topic-muted);
        font-size: 10px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }

      .wr-topic-relation-actions {
        position: absolute;
        top: 6px;
        right: 6px;
        display: flex;
        gap: 3px;
        opacity: 0;
        pointer-events: none;
      }

      .wr-topic-relation-card:hover .wr-topic-relation-actions,
      .wr-topic-relation-card:focus-within .wr-topic-relation-actions {
        opacity: 1;
        pointer-events: auto;
      }

      .wr-topic-relation-actions button {
        width: 25px;
        height: 25px;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        border: 1px solid var(--wr-topic-border);
        border-radius: 5px;
        padding: 0;
        background: rgba(255, 255, 255, .96);
        color: #526070;
        font-size: 0;
        line-height: 0;
      }

      .wr-topic-relation-actions button.danger {
        color: #d92d20;
      }

      .wr-topic-relation-actions .wr-topic-icon {
        width: 13px;
        height: 13px;
      }

      .wr-topic-note-actions {
        justify-content: space-between;
        flex-wrap: wrap;
      }

      .wr-topic-note-actions > div:last-child {
        margin-left: auto;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .wr-topic-relation-editor {
        width: min(600px, calc(100vw - 44px));
      }

      .wr-topic-relation-form {
        display: grid;
        gap: 14px;
        margin-top: 14px;
      }

      .wr-topic-relation-current {
        margin: 12px 0 0 !important;
        font-size: 12px;
      }

      .wr-topic-segmented,
      .wr-topic-relation-types {
        min-width: 0;
        display: flex;
        gap: 7px;
        border: 0;
        padding: 0;
        margin: 0;
      }

      .wr-topic-segmented legend,
      .wr-topic-relation-types legend {
        width: 100%;
        margin-bottom: 7px;
        color: #344054;
        font-size: 13px;
        font-weight: 600;
      }

      .wr-topic-segmented label,
      .wr-topic-relation-types label {
        position: relative;
        min-width: 0;
      }

      .wr-topic-segmented input,
      .wr-topic-relation-types input {
        position: absolute;
        opacity: 0;
      }

      .wr-topic-segmented span,
      .wr-topic-relation-types span {
        min-height: 34px;
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--wr-topic-border);
        border-radius: 6px;
        padding: 0 11px;
        background: #fff;
        color: #526070;
        font-size: 12px;
      }

      .wr-topic-segmented input:checked + span,
      .wr-topic-relation-types input:checked + span {
        border-color: var(--wr-topic-blue);
        background: #eef5ff;
        color: #1769c2;
      }

      .wr-topic-relation-reason-input {
        min-height: 96px;
      }

      .wr-topic-graph-card {
        box-sizing: border-box;
        width: min(1060px, calc(100vw - 44px));
        height: min(760px, calc(100vh - 44px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 10px;
        padding: 18px;
        background: #fff;
        box-shadow: 0 24px 80px rgba(15, 23, 42, .24);
      }

      .wr-topic-graph-card:fullscreen,
      .wr-topic-graph-card.is-fullscreen {
        width: 100vw;
        height: 100vh;
        max-width: none;
        max-height: none;
        border-radius: 0;
        padding: 20px;
        background: #fff;
      }

      .wr-topic-graph-card.is-fullscreen {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
      }

      .wr-topic-graph-card * {
        box-sizing: border-box;
      }

      .wr-topic-graph-toolbar {
        display: grid;
        grid-template-columns: minmax(180px, 1fr) 150px 34px 34px 34px;
        gap: 8px;
        margin-top: 15px;
      }

      .wr-topic-graph-toolbar .wr-topic-input,
      .wr-topic-graph-toolbar .wr-topic-icon-btn {
        height: 34px;
        min-height: 34px;
        padding-top: 0;
        padding-bottom: 0;
      }

      .wr-topic-graph-body {
        min-height: 0;
        flex: 1 1 auto;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 260px;
        gap: 12px;
        margin-top: 12px;
      }

      .wr-topic-graph-canvas {
        min-width: 0;
        min-height: 420px;
        border: 1px solid var(--wr-topic-border);
        border-radius: 8px;
        background: #fafbfd;
      }

      .wr-topic-graph-inspector {
        min-width: 0;
        overflow-x: hidden;
        overflow-y: auto;
        border-left: 1px solid var(--wr-topic-border);
        padding: 10px 4px 10px 14px;
        color: var(--wr-topic-muted);
        font-size: 12px;
      }

      .wr-topic-graph-inspector p {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .wr-topic-graph-inspector-content {
        min-width: 0;
        display: flex;
        align-items: flex-start;
        gap: 10px;
        color: var(--wr-topic-text);
        overflow-wrap: anywhere;
      }

      .wr-topic-graph-outside {
        display: block;
        width: fit-content;
        margin-top: 6px;
        border-radius: 4px;
        padding: 2px 5px;
        background: #eef1f5;
        color: #697586;
        font-size: 10px;
      }

      .wr-topic-graph-inspector-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        margin-top: 14px;
      }

      .wr-topic-graph-edge-title {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
        align-items: center;
        gap: 6px;
        margin-bottom: 10px;
        color: var(--wr-topic-text);
        overflow-wrap: anywhere;
      }

      .wr-topic-graph-error,
      .wr-topic-graph-empty {
        display: grid;
        place-items: center;
        min-height: 260px;
        color: var(--wr-topic-muted);
        text-align: center;
      }

      .wr-topic-field-heading,
      .wr-topic-library-head,
      .wr-topic-library-controls,
      .wr-topic-library-card-actions,
      .wr-topic-link-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .wr-topic-field-heading,
      .wr-topic-library-head {
        justify-content: space-between;
      }

      .wr-topic-text-action {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 0;
        background: transparent;
        color: var(--wr-topic-muted);
        font-size: 12px;
        cursor: pointer;
      }

      .wr-topic-text-action:hover,
      .wr-topic-text-action:focus-visible {
        color: var(--wr-topic-blue);
      }

      .wr-topic-text-action .wr-topic-icon {
        width: 14px;
        height: 14px;
      }

      .wr-topic-library {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
        gap: 14px;
        padding: 20px 24px;
        overflow: hidden;
      }

      .wr-topic-library-head h3,
      .wr-topic-library-head p {
        margin: 0;
      }

      .wr-topic-library-head p {
        margin-top: 4px;
        font-size: 12px;
      }

      .wr-topic-library-controls {
        flex-wrap: wrap;
      }

      .wr-topic-library-search {
        min-width: 220px;
        flex: 1;
      }

      .wr-topic-library-list {
        min-height: 0;
        flex: 1;
        overflow-y: auto;
        scrollbar-width: thin;
      }

      .wr-topic-library-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .wr-topic-library-card {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        min-height: 104px;
        padding: 10px;
        border: 1px solid var(--wr-topic-border);
        border-radius: 6px;
        background: #fff;
      }

      .wr-topic-library-main {
        min-width: 0;
        display: grid;
        grid-template-columns: 64px minmax(0, 1fr);
        gap: 10px;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }

      .wr-topic-library-cover {
        width: 64px;
        height: 84px;
        object-fit: cover;
        border-radius: 3px;
      }

      .wr-topic-library-content {
        min-width: 0;
      }

      .wr-topic-library-title {
        display: block;
        color: var(--wr-topic-text);
        font-size: 13px;
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      .wr-topic-library-meta,
      .wr-topic-library-context {
        display: -webkit-box;
        margin-top: 5px;
        color: var(--wr-topic-muted);
        font-size: 11px;
        line-height: 1.45;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }

      .wr-topic-library-card-actions {
        align-self: start;
      }

      .wr-topic-link-banner {
        padding: 10px 12px;
        border: 1px solid #bfdbfe;
        border-radius: 6px;
        background: #eff6ff;
        color: #1e3a5f;
        font-size: 12px;
      }

      .wr-topic-book-editor {
        width: min(560px, calc(100vw - 32px));
      }

      .wr-topic-book-editor-form {
        display: grid;
        gap: 12px;
      }

      .wr-topic-link-editor {
        width: min(680px, calc(100vw - 32px));
      }

      .wr-topic-link-compare {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin: 12px 0;
      }

      .wr-topic-link-book {
        padding: 10px;
        border: 1px solid var(--wr-topic-border);
        border-radius: 6px;
      }

      .wr-topic-relation-candidates {
        display: grid;
        gap: 4px;
        margin-top: 6px;
      }

      .wr-topic-relation-candidate {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        padding: 8px 10px;
        border: 1px solid var(--wr-topic-border);
        border-radius: 5px;
        background: #fff;
        color: var(--wr-topic-text);
        text-align: left;
        cursor: pointer;
      }

      .wr-topic-relation-candidate:hover {
        border-color: var(--wr-topic-blue);
      }

      @media (max-width: 840px) {
        .wr-topic-nested-modal {
          padding: 12px;
        }
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

        .wr-topic-close-btn {
          top: 18px;
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

        .wr-topic-graded-grid {
          grid-template-columns: 1fr;
        }

        .wr-topic-library-grid,
        .wr-topic-link-compare {
          grid-template-columns: 1fr;
        }

        .wr-topic-modal-book {
          align-items: flex-start;
          flex-wrap: wrap;
        }

        .wr-topic-modal-book-tools {
          margin-left: auto;
          justify-content: flex-end;
        }

        .wr-topic-note-actions {
          align-items: stretch;
        }

        .wr-topic-note-actions > div {
          width: 100%;
        }

        .wr-topic-note-actions > div:last-child {
          justify-content: flex-end;
        }

        .wr-topic-relation-list {
          grid-template-columns: 1fr;
        }

        .wr-topic-graph-card {
          width: calc(100vw - 24px);
          height: calc(100vh - 24px);
          padding: 14px;
        }

        .wr-topic-graph-toolbar {
          grid-template-columns: minmax(0, 1fr) 126px 34px 34px 34px;
        }

        .wr-topic-graph-body {
          grid-template-columns: 1fr;
          grid-template-rows: minmax(360px, 1fr) auto;
        }

        .wr-topic-graph-inspector {
          max-height: 170px;
          border-top: 1px solid var(--wr-topic-border);
          border-left: 0;
          padding: 10px 4px;
        }
      }

      @media (hover: none) {
        .wr-topic-group-book-menu-button,
        .wr-topic-relation-actions {
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
    if (!isShelfEnhancementRoute()) {
      document.getElementById("wr-topic-floating-button")?.remove();
      return;
    }

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
      cover: img && img.getAttribute("src") ? img.src : "",
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

  async function reconcileShelfBooks() {
    const next = { ...state.libraryBooks };
    let changed = false;
    const timestamp = nowIso();
    state.books.forEach((shelfBook) => {
      const existing =
        Object.values(next).find((book) => book.wereadBookId === shelfBook.id) ||
        next[shelfBook.id];
      const id = existing ? existing.id : shelfBook.id;
      const normalized = reconcileShelfBook(existing, shelfBook, timestamp);
      const comparableExisting = existing
        ? { ...existing, updatedAt: normalized.updatedAt }
        : null;
      if (!comparableExisting || JSON.stringify(comparableExisting) !== JSON.stringify(normalized)) {
        next[id] = normalized;
        delete state.syncMeta.tombstones.books[id];
        changed = true;
      }
    });
    if (!changed) return false;
    await saveLibraryBooks(next);
    return true;
  }

  function findBook(bookId) {
    const direct = getLibraryBook(bookId);
    if (direct) return libraryBookView(direct);
    const linked = Object.values(state.libraryBooks).find(
      (book) => book.wereadBookId === bookId,
    );
    if (linked) return libraryBookView(linked);
    const fromShelf = state.books.find((book) => book.id === bookId);
    return fromShelf || null;
  }

  function readingLevelLabel(level) {
    return {
      deep: "深度阅读",
      light: "轻度阅读",
      casual: "随便读读",
      unclassified: "未分级",
    }[level] || "未分级";
  }

  function readingLevelForBook(bookId) {
    const level = state.readingLevels[bookId]?.level;
    return READING_LEVELS.has(level) ? level : "unclassified";
  }

  function readingLevelOptionsHtml(bookId) {
    const current = readingLevelForBook(bookId);
    return [
      ["unclassified", "未分级"],
      ["deep", "深度阅读"],
      ["light", "轻度阅读"],
      ["casual", "随便读读"],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`,
      )
      .join("");
  }

  function snapshotReadingLevelBook(book) {
    return {
      id: String(book.id || ""),
      title: String(book.title || ""),
      author: String(book.author || ""),
      url: String(book.url || ""),
      cover: String(book.cover || ""),
    };
  }

  async function setReadingLevel(bookId, nextLevel) {
    const normalizedLevel = READING_LEVELS.has(nextLevel)
      ? nextLevel
      : "unclassified";
    const currentLevel = readingLevelForBook(bookId);
    if (currentLevel === normalizedLevel) return;

    const next = { ...state.readingLevels };
    const updatedAt = nowIso();
    if (normalizedLevel === "unclassified") {
      if (!next[bookId]) return;
      delete next[bookId];
      markDeleted("levels", bookId, updatedAt);
    } else {
      const book = findBook(bookId);
      if (!book) throw new Error("找不到这本书，无法保存阅读分级。");
      next[bookId] = {
        book: snapshotReadingLevelBook(book),
        level: normalizedLevel,
        updatedAt,
      };
      delete state.syncMeta.tombstones.levels[bookId];
    }

    await saveReadingLevels(next);
    closeBookMenus();
    renderPanel();
  }

  function gradedReadingLibraryBooks() {
    const library = libraryBookList();
    if (library.length) return library;
    const byId = new Map();
    state.books.forEach((book) => byId.set(book.id, book));
    Object.values(getNotes()).forEach((note) => {
      if (note && note.book && !byId.has(note.book.id)) byId.set(note.book.id, note.book);
    });
    return [...byId.values()];
  }

  function gradedReadingStats(books = gradedReadingLibraryBooks()) {
    const stats = { deep: 0, light: 0, casual: 0, unclassified: 0, total: books.length };
    books.forEach((book) => {
      stats[readingLevelForBook(book.id)] += 1;
    });
    return stats;
  }

  function gradedReadingBooks() {
    const query = state.levelQuery.trim().toLocaleLowerCase();
    const order = { deep: 0, light: 1, casual: 2, unclassified: 3 };
    return gradedReadingLibraryBooks()
      .filter((book) => {
        const level = readingLevelForBook(book.id);
        if (state.levelFilter !== "all" && level !== state.levelFilter) return false;
        if (!query) return true;
        return `${book.title || ""} ${book.author || ""}`
          .toLocaleLowerCase()
          .includes(query);
      })
      .sort((left, right) => {
        const levelDifference =
          order[readingLevelForBook(left.id)] - order[readingLevelForBook(right.id)];
        return levelDifference || left.title.localeCompare(right.title, "zh-CN");
      });
  }

  function normalizeTitle(value) {
    return String(value || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("en-US");
  }

  function libraryBookView(book) {
    if (!book) return null;
    return {
      ...book,
      id: String(book.id || ""),
      title: String(book.title || ""),
      author: String(book.author || ""),
      cover: String(book.coverUrl || book.cover || ""),
      url: String(book.readerUrl || book.detailUrl || book.url || ""),
    };
  }

  function readerUrlForBook(book) {
    if (!book) return "";
    return Object.prototype.hasOwnProperty.call(book, "readerUrl")
      ? String(book.readerUrl || "")
      : String(book.url || "");
  }

  function normalizeLibraryBook(book, fallbackId = "", fallbackSource = "manual") {
    if (!book || typeof book !== "object") return null;
    const id = String(book.id || book.bookId || fallbackId || "").trim();
    const title = String(book.title || "").trim();
    if (!id || !title) return null;
    const timestamp = String(book.updatedAt || book.createdAt || nowIso());
    const legacyUrl = String(book.url || "");
    const wereadBookId = String(
      book.wereadBookId ||
        (fallbackSource === "weread" || /weread\.qq\.com\/web\/reader\//.test(legacyUrl)
          ? id
          : ""),
    );
    const source = book.source === "weread" || wereadBookId ? "weread" : "manual";
    const manualCoverUrl = source === "weread" ? String(book.manualCoverUrl || "") : "";
    const wereadCoverUrl =
      source === "weread"
        ? String(
            book.wereadCoverUrl ||
              (!manualCoverUrl ? book.coverUrl || book.cover || "" : ""),
          )
        : "";
    return {
      id,
      title,
      normalizedTitle: normalizeTitle(title),
      author: String(book.author || "").trim(),
      coverUrl: String(manualCoverUrl || book.coverUrl || book.cover || wereadCoverUrl || ""),
      wereadCoverUrl,
      manualCoverUrl,
      detailUrl: String(book.detailUrl || ""),
      readerUrl: String(book.readerUrl || legacyUrl || ""),
      source,
      wereadBookId,
      ignoredWereadBookIds: Array.isArray(book.ignoredWereadBookIds)
        ? [...new Set(book.ignoredWereadBookIds.map(String).filter(Boolean))]
        : [],
      createdAt: String(book.createdAt || timestamp),
      updatedAt: timestamp,
    };
  }

  function editedLibraryBookCover(existing, coverUrl) {
    const value = String(coverUrl || "");
    if (!existing || existing.source !== "weread") {
      return { coverUrl: value, wereadCoverUrl: "", manualCoverUrl: "" };
    }
    const wereadCoverUrl = String(
      existing.wereadCoverUrl ||
        (!existing.manualCoverUrl ? existing.coverUrl || existing.cover || "" : ""),
    );
    const manualCoverUrl = value && value !== wereadCoverUrl ? value : "";
    return {
      coverUrl: manualCoverUrl || wereadCoverUrl,
      wereadCoverUrl,
      manualCoverUrl,
    };
  }

  function reconcileShelfBook(existing, shelfBook, timestamp = nowIso()) {
    const id = existing ? existing.id : shelfBook.id;
    const manualCoverUrl = String((existing && existing.manualCoverUrl) || "");
    const wereadCoverUrl = String(
      shelfBook.cover ||
        (existing && existing.wereadCoverUrl) ||
        (existing && !manualCoverUrl ? existing.coverUrl : "") ||
        "",
    );
    return normalizeLibraryBook(
      {
        ...(existing || {}),
        id,
        title: shelfBook.title || (existing && existing.title),
        author: shelfBook.author || (existing && existing.author),
        coverUrl: manualCoverUrl || wereadCoverUrl,
        wereadCoverUrl,
        manualCoverUrl,
        readerUrl: shelfBook.url || (existing && existing.readerUrl),
        source: "weread",
        wereadBookId: shelfBook.id,
        createdAt: (existing && existing.createdAt) || timestamp,
        updatedAt: timestamp,
      },
      id,
      "weread",
    );
  }

  function libraryBookList() {
    return Object.values(state.libraryBooks)
      .map((book) => libraryBookView(book))
      .filter(Boolean)
      .sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  }

  function getLibraryBook(bookId) {
    return state.libraryBooks[String(bookId || "")] || null;
  }

  function legacyBookSnapshot(book) {
    const view = libraryBookView(book);
    return view
      ? { id: view.id, title: view.title, author: view.author, url: view.url, cover: view.cover }
      : null;
  }

  async function sha256Hex(value) {
    if (window.crypto && window.crypto.subtle) {
      const digest = await window.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(String(value)),
      );
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    }
    return sha256Fallback(String(value));
  }

  function sha256Fallback(value) {
    const bytes = new TextEncoder().encode(value);
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const data = new Uint8Array(paddedLength);
    data.set(bytes);
    data[bytes.length] = 0x80;
    const view = new DataView(data.buffer);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    const h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const rotateRight = (number, shift) => (number >>> shift) | (number << (32 - shift));
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        words[index] = view.getUint32(offset + index * 4, false);
      }
      for (let index = 16; index < 64; index += 1) {
        const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
        const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, currentH] = h;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (currentH + sum1 + choice + k[index] + words[index]) >>> 0;
        const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sum0 + majority) >>> 0;
        currentH = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      [a, b, c, d, e, f, g, currentH].forEach((value, index) => {
        h[index] = (h[index] + value) >>> 0;
      });
    }
    return h.map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  async function relationIdForBookIds(fromBookId, toBookId) {
    return `rel_${await sha256Hex(`${fromBookId}\u0000${toBookId}`)}`;
  }

  async function relationRefForLibraryBook(book) {
    const view = libraryBookView(book);
    return {
      nodeId: `book_${await sha256Hex(view.id)}`,
      bookId: view.id,
      title: view.title,
      normalizedTitle: normalizeTitle(view.title),
      detailUrl: String(view.detailUrl || view.readerUrl || ""),
      coverUrl: String(view.coverUrl || ""),
    };
  }

  async function migrateLibraryState() {
    const before = JSON.stringify({
      books: state.libraryBooks,
      groups: state.groups,
      notes: state.notes,
      relations: state.relations,
      levels: state.readingLevels,
    });
    const books = {};
    Object.entries(state.libraryBooks || {}).forEach(([id, book]) => {
      const normalized = normalizeLibraryBook(book, id, book && book.source);
      if (normalized) books[normalized.id] = normalized;
    });

    const register = (candidate, fallbackId = "", source = "manual") => {
      const normalized = normalizeLibraryBook(candidate, fallbackId, source);
      if (!normalized) return null;
      const existing = books[normalized.id];
      books[normalized.id] = existing
        ? {
            ...normalized,
            ...existing,
            title: existing.title || normalized.title,
            normalizedTitle: normalizeTitle(existing.title || normalized.title),
            author: existing.author || normalized.author,
            coverUrl: existing.coverUrl || normalized.coverUrl,
            detailUrl: existing.detailUrl || normalized.detailUrl,
            readerUrl: existing.readerUrl || normalized.readerUrl,
            wereadBookId: existing.wereadBookId || normalized.wereadBookId,
            ignoredWereadBookIds: [
              ...new Set([
                ...(existing.ignoredWereadBookIds || []),
                ...(normalized.ignoredWereadBookIds || []),
              ]),
            ],
          }
        : normalized;
      return books[normalized.id];
    };

    state.groups.forEach((group) => {
      (Array.isArray(group.books) ? group.books : []).forEach((book) =>
        register(book, book && book.id, "weread"),
      );
    });
    Object.values(state.notes || {}).forEach((note) => {
      if (note && note.book) register(note.book, note.book.id, "weread");
    });
    Object.values(state.readingLevels || {}).forEach((record) => {
      if (record && record.book) register(record.book, record.book.id, "weread");
    });

    const relationBookId = async (ref) => {
      if (ref && ref.bookId) {
        const registered = register(ref, ref.bookId, "weread");
        if (registered) return registered.id;
      }
      const title = String((ref && ref.title) || "").trim();
      const matches = Object.values(books).filter(
        (book) => book.normalizedTitle === normalizeTitle(title),
      );
      if (matches.length === 1) return matches[0].id;
      const seed = String((ref && ref.nodeId) || normalizeTitle(title));
      const id = `local_legacy_${(await sha256Hex(seed)).slice(0, 32)}`;
      const registered = register(
        {
          id,
          title,
          detailUrl: String((ref && ref.detailUrl) || ""),
          coverUrl: String((ref && ref.coverUrl) || ""),
          source: "manual",
        },
        id,
        "manual",
      );
      return registered ? registered.id : "";
    };

    const migratedRelations = new Map();
    for (const relation of state.relations || []) {
      const fromBookId = relation.fromBookId || (await relationBookId(relation.from));
      const toBookId = relation.toBookId || (await relationBookId(relation.to));
      if (!fromBookId || !toBookId || fromBookId === toBookId) continue;
      const fromBook = books[fromBookId] || register(relation.from, fromBookId, "manual");
      const toBook = books[toBookId] || register(relation.to, toBookId, "manual");
      const id = await relationIdForBookIds(fromBookId, toBookId);
      const migrated = {
        ...relation,
        id,
        fromBookId,
        toBookId,
        from: await relationRefForLibraryBook(fromBook),
        to: await relationRefForLibraryBook(toBook),
      };
      const existing = migratedRelations.get(id);
      if (!existing || timestampValue(migrated.updatedAt) >= timestampValue(existing.updatedAt)) {
        migratedRelations.set(id, migrated);
      }
      if (relation.id && relation.id !== id) markDeleted("relations", relation.id, migrated.updatedAt);
    }

    state.libraryBooks = books;
    state.groups = state.groups.map((group) => {
      const bookIds = Array.isArray(group.bookIds)
        ? group.bookIds.filter((id) => books[id])
        : (group.books || []).map((book) => String(book.id || "")).filter((id) => books[id]);
      const migrated = { ...group, bookIds: [...new Set(bookIds)] };
      delete migrated.books;
      return migrated;
    });
    state.relations = [...migratedRelations.values()];

    Object.entries(state.notes || {}).forEach(([id, note]) => {
      if (!books[id] && note && note.book) register(note.book, id, "weread");
      if (note && note.book && books[id]) note.book = legacyBookSnapshot(books[id]);
    });
    Object.entries(state.readingLevels || {}).forEach(([id, record]) => {
      if (!books[id] && record && record.book) register(record.book, id, "weread");
      if (record && record.book && books[id]) record.book = legacyBookSnapshot(books[id]);
    });
    state.libraryBooks = books;

    return before !==
      JSON.stringify({
        books: state.libraryBooks,
        groups: state.groups,
        notes: state.notes,
        relations: state.relations,
        levels: state.readingLevels,
      });
  }

  async function nodeIdForTitle(title) {
    return `book_${await sha256Hex(normalizeTitle(title))}`;
  }

  async function relationIdForNodes(fromNodeId, toNodeId) {
    return `rel_${await sha256Hex(`${fromNodeId}\u0000${toNodeId}`)}`;
  }

  function allKnownBooks() {
    const candidates = [];
    const add = (book) => {
      if (!book || !String(book.title || "").trim()) return;
      candidates.push({
        id: String(book.id || book.bookId || ""),
        title: String(book.title || "").trim(),
        author: String(book.author || ""),
        url: String(book.url || book.detailUrl || ""),
        cover: String(book.cover || book.coverUrl || ""),
      });
    };
    libraryBookList().forEach(add);
    Object.values(getNotes()).forEach((note) => add(note && note.book));
    Object.values(state.readingLevels).forEach((record) => add(record && record.book));
    (state.obsidianCache.books || []).forEach((item) =>
      add({ title: item.matchTitle || item.sourceTitle }),
    );
    state.relations.forEach((relation) => {
      add(relation.from);
      add(relation.to);
    });

    const byTitle = new Map();
    candidates.forEach((book) => {
      const normalized = normalizeTitle(book.title);
      if (!normalized) return;
      const existing = byTitle.get(normalized);
      if (!existing || (!existing.id && book.id)) byTitle.set(normalized, book);
    });
    return [...byTitle.values()].sort((left, right) =>
      left.title.localeCompare(right.title, "zh-CN"),
    );
  }

  function findBookByNormalizedTitle(normalizedTitle) {
    const candidates = libraryBookList();
    Object.values(getNotes()).forEach((note) => {
      if (note && note.book) candidates.push(note.book);
    });
    Object.values(state.readingLevels).forEach((record) => {
      if (record && record.book) candidates.push(record.book);
    });
    return candidates.find(
      (book) => normalizeTitle(book.title) === normalizedTitle && book.id,
    );
  }

  function relationRefBook(ref) {
    return (
      (ref.bookId && findBook(ref.bookId)) ||
      findBookByNormalizedTitle(ref.normalizedTitle) || {
        id: ref.bookId || "",
        title: ref.title,
        author: "",
        url: ref.detailUrl || "",
        cover: ref.coverUrl || "",
      }
    );
  }

  async function createRelationRef(book) {
    const stored = getLibraryBook(book && (book.id || book.bookId));
    return relationRefForLibraryBook(stored || normalizeLibraryBook(book, book.id, book.source));
  }

  function relationsForBook(book) {
    const bookId = String((book && book.id) || "");
    const normalized = normalizeTitle(book && book.title);
    return {
      incoming: state.relations.filter(
        (relation) =>
          (bookId && (relation.toBookId === bookId || relation.to.bookId === bookId)) ||
          (!bookId && relation.to.normalizedTitle === normalized),
      ),
      outgoing: state.relations.filter(
        (relation) =>
          (bookId && (relation.fromBookId === bookId || relation.from.bookId === bookId)) ||
          (!bookId && relation.from.normalizedTitle === normalized),
      ),
    };
  }

  function relationTypeLabel(type) {
    return {
      "extended-reading": "延伸阅读",
      "author-citation": "作者引用",
      "question-driven": "问题驱动",
    }[type] || "阅读发现";
  }

  function validateOptionalHttpsUrl(value, label) {
    const input = String(value || "").trim();
    if (!input) return "";
    if (input.length > 2048) throw new Error(`${label}不能超过 2048 个字符。`);
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new Error(`${label}不是有效网址。`);
    }
    if (url.protocol !== "https:") throw new Error(`${label}必须使用 HTTPS。`);
    return url.href;
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
      groupBooks(group).slice(0, 4).forEach((book) => {
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
      groupBooks(group).forEach((book) => ids.add(book.wereadBookId || book.id));
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
      const shelfBook = extractBook(link);
      const book = findBook(shelfBook.id) || shelfBook;
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
      icon.textContent = hasContext ? "i" : "+";
      icon.title = hasContext ? "查看阅读信息" : "添加阅读信息";
      icon.setAttribute("aria-label", icon.title);
      icon.classList.toggle("has-note", hasContext);
      link.classList.toggle("wr-book-has-context", hasContext);
    });
  }

  function deactivateShelfEnhancements() {
    if (
      !state.routeActive &&
      !document.querySelector(
        "#wr-topic-floating-button, #wr-local-topic-style, .wr-topic-shelf-group, .wr-book-context-icon, [data-wr-local-hidden]",
      )
    ) {
      return;
    }

    document
      .querySelectorAll(".wr-topic-shelf-group, .wr-book-context-icon")
      .forEach((element) => element.remove());
    document.querySelectorAll("a.shelfBook").forEach((link) => {
      if (link.dataset.wrLocalHidden) {
        link.style.display = "";
        delete link.dataset.wrLocalHidden;
      }
      link.classList.remove("wr-book-has-context");
    });

    if (state.graph) {
      state.graph.destroy();
      state.graph = null;
    }
    [
      "wr-topic-floating-button",
      "wr-topic-panel-root",
      "wr-topic-note-modal",
      "wr-topic-cloud-modal",
      "wr-topic-relation-modal",
      "wr-topic-graph-modal",
      "wr-topic-book-editor-modal",
      "wr-topic-book-link-modal",
      "wr-local-topic-style",
    ].forEach((id) => document.getElementById(id)?.remove());

    state.routeActive = false;
    state.lastShelfSignature = "";
    state.formMode = "";
    state.editingGroupId = "";
    state.noteNavigationStack = [];
    state.noteDrafts = {};
    state.graphContext = null;
  }

  function refreshShelf() {
    if (!isShelfEnhancementRoute()) {
      deactivateShelfEnhancements();
      return;
    }
    scanBooks();
    renderShelfGroups();
    applyHiddenBooks();
    renderBookNoteIcons();
    renderPanel();
    reconcileShelfBooks()
      .then((changed) => {
        if (!changed) return;
        renderShelfGroups();
        applyHiddenBooks();
        renderBookNoteIcons();
        renderPanel();
      })
      .catch((error) => {
        console.warn("[WeRead Local Topic Shelf] shelf import failed:", error);
      });
  }

  function getShelfSignature() {
    const count = document.querySelectorAll(SELECTORS.shelfBook).length;
    const storageMarker = `${JSON.stringify(state.groups)}|${JSON.stringify(state.notes)}`;
    return `${count}|${storageMarker.length}|${storageMarker.slice(0, 80)}`;
  }

  function bookPickerHtml() {
    const selected = state.selectedBookIds;
    const query = state.bookFilter.trim().toLowerCase();
    const library = libraryBookList();
    const books = query
      ? library.filter((book) =>
          `${book.title || ""} ${book.author || ""}`.toLowerCase().includes(query),
        )
      : library;

    if (!library.length) {
      return `<div class="wr-topic-empty">本地书库还没有书籍。</div>`;
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
            ${coverMarkup(book, "wr-topic-book-cover")}
            <span class="wr-topic-book-info">
              <span class="wr-topic-book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</span>
              <span class="wr-topic-book-author">${escapeHtml(book.author || (book.source === "manual" ? "外部书" : "微信读书"))}</span>
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
            <div class="wr-topic-field-heading"><label>${text.chooseBooks}</label><button class="wr-topic-text-action" type="button" data-wr-action="add-library-book" data-return="group">${iconSvg("plus")}<span>添加书籍</span></button></div>
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
          .map((group) => {
            const progress = groupContextProgress(group);
            return `
          <button class="wr-topic-group-card ${group.id === state.selectedGroupId ? "active" : ""}" type="button" data-wr-action="select-group" data-group-id="${escapeHtml(group.id)}">
            <span class="wr-topic-group-name">${escapeHtml(group.name)}</span>
            <span class="wr-topic-group-desc">${escapeHtml(group.description || "暂无描述")}</span>
            <span class="wr-topic-group-footer">
              <span class="wr-topic-group-meta">${progress.total} 本书</span>
              <span class="wr-topic-group-progress" title="有阅读上下文 ${progress.completed} / ${progress.total} 本">${progress.completed}/${progress.total}</span>
            </span>
          </button>
        `;
          })
          .join("")}
      </div>
    `;
  }

  function readingLevelMenuHtml(book, groupId) {
    const current = readingLevelForBook(book.id);
    const levelItems = [
      ["deep", "深度阅读"],
      ["light", "轻度阅读"],
      ["casual", "随便读读"],
      ["unclassified", "清除分级"],
    ]
      .map(
        ([value, label]) => `
          <button class="wr-topic-book-menu-item" type="button" role="menuitemradio" aria-checked="${current === value}" data-wr-action="set-reading-level" data-book-id="${escapeHtml(book.id)}" data-level="${value}">
            <span>${label}</span>
            ${current === value ? iconSvg("check") : ""}
          </button>`,
      )
      .join("");

    return `
      <div class="wr-topic-group-book-menu">
        <button class="wr-topic-btn wr-topic-group-book-menu-button" type="button" data-wr-action="toggle-book-menu" title="书籍操作" aria-label="书籍操作" aria-haspopup="menu" aria-expanded="false">${iconSvg("moreVertical")}</button>
        <div class="wr-topic-book-menu-popover" data-wr-book-menu role="menu" hidden>
          <button class="wr-topic-book-menu-item" type="button" role="menuitem" data-wr-action="toggle-level-submenu" aria-haspopup="menu" aria-expanded="false">
            <span>阅读分级</span>
            ${iconSvg("chevronRight")}
          </button>
          <div class="wr-topic-level-submenu" data-wr-level-submenu role="menu" hidden>${levelItems}</div>
          <button class="wr-topic-book-menu-item danger" type="button" role="menuitem" data-wr-action="remove-book" data-group-id="${escapeHtml(groupId)}" data-book-id="${escapeHtml(book.id)}">
            <span>移出主题组</span>
            ${iconSvg("trash")}
          </button>
        </div>
      </div>`;
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
        <div class="wr-topic-detail-actions">
          <button class="wr-topic-btn wr-topic-detail-icon-btn" type="button" data-wr-action="open-graph" data-scope="group" data-group-id="${escapeHtml(group.id)}" title="查看主题组关系" aria-label="查看主题组关系">${iconSvg("network")}</button>
          <button class="wr-topic-btn wr-topic-detail-icon-btn" type="button" data-wr-action="edit-group" data-group-id="${escapeHtml(group.id)}" title="${text.edit}" aria-label="${text.edit}">${iconSvg("edit")}</button>
          <button class="wr-topic-btn danger wr-topic-detail-icon-btn" type="button" data-wr-action="delete-group" data-group-id="${escapeHtml(group.id)}" title="${text.deleteGroup}" aria-label="${text.deleteGroup}">${iconSvg("trash")}</button>
        </div>
      </div>
      <div class="wr-topic-detail-desc">${escapeHtml(group.description || "暂无描述")}</div>
      <div class="wr-topic-book-list wr-topic-group-book-list">
        ${groupBooks(group)
          .map((book) => {
            const context = getBookContextSummary(book.id);
            const contextLabel = context || "暂无阅读上下文，点击添加";
            return `
              <article class="wr-topic-group-book-card">
                <button class="wr-topic-group-book-cover-action" type="button" data-wr-action="open-book-note" data-book-id="${escapeHtml(book.id)}" aria-label="打开书籍阅读上下文：${escapeHtml(book.title)}">
                  ${coverMarkup(book, "wr-topic-group-book-cover")}
                </button>
                <div class="wr-topic-group-book-content">
                  <button class="wr-topic-group-book-title-action" type="button" data-wr-action="open-book-note" data-book-id="${escapeHtml(book.id)}" title="打开书籍阅读上下文：${escapeHtml(book.title)}">${escapeHtml(book.title)}</button>
                  <button class="wr-topic-group-book-context ${context ? "" : "is-empty"}" type="button" data-wr-action="open-book-note" data-book-id="${escapeHtml(book.id)}" title="打开书籍阅读上下文">${escapeHtml(contextLabel)}</button>
                </div>
                ${readingLevelMenuHtml(book, group.id)}
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
      recognizedLibraryBooks: libraryBookList().length,
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
          <div class="wr-topic-catalog-stat"><strong>${Number(stats.recognizedLibraryBooks || libraryBookList().length)}</strong><span>本地书库书籍</span></div>
          <div class="wr-topic-catalog-stat"><strong>${Number(stats.inShelf || 0)}</strong><span>已匹配本地</span></div>
          <div class="wr-topic-catalog-stat"><strong>${Number(stats.notInShelf || 0)}</strong><span>未匹配本地</span></div>
          <div class="wr-topic-catalog-stat"><strong>${Number(stats.withContext || 0)}</strong><span>包含 WHY</span></div>
        </div>
        <div class="wr-topic-catalog-controls">
          <input class="wr-topic-input wr-topic-catalog-search" type="search" data-wr-action="filter-catalog" placeholder="搜索 Obsidian 书名或匹配书名" value="${escapeHtml(state.catalogQuery)}" autocomplete="off">
          ${[
            ["all", "全部"],
            ["in", "在书库"],
            ["out", "不在书库"],
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

  function gradedReadingListHtml() {
    const books = gradedReadingBooks();
    if (!books.length) {
      return `<div class="wr-topic-empty">没有符合当前筛选条件的书籍。</div>`;
    }

    return `<div class="wr-topic-graded-grid">
      ${books
        .map((book) => {
          const level = readingLevelForBook(book.id);
          const context = getBookContextSummary(book.id);
          return `
            <button class="wr-topic-graded-card" type="button" data-wr-action="open-book-note" data-book-id="${escapeHtml(book.id)}" aria-label="打开书籍阅读上下文：${escapeHtml(book.title)}">
              ${coverMarkup(book, "wr-topic-graded-cover")}
              <span class="wr-topic-graded-content">
                <span class="wr-topic-graded-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</span>
                ${book.author ? `<span class="wr-topic-graded-author">${escapeHtml(book.author)}</span>` : ""}
                <span class="wr-topic-graded-context ${context ? "" : "is-empty"}">${escapeHtml(context || "暂无阅读上下文")}</span>
                <span class="wr-topic-level-badge ${level}">${readingLevelLabel(level)}</span>
              </span>
            </button>`;
        })
        .join("")}
    </div>`;
  }

  function renderGradedReadingView() {
    const stats = gradedReadingStats();
    const filters = [
      ["all", "全部", stats.total],
      ["deep", "深度阅读", stats.deep],
      ["light", "轻度阅读", stats.light],
      ["casual", "随便读读", stats.casual],
      ["unclassified", "未分级", stats.unclassified],
    ];
    return `
      <section class="wr-topic-graded">
        <div class="wr-topic-graded-head">
          <div>
            <h3>分级阅读</h3>
            <p>按今晚可用的精力，选择合适的书继续阅读。</p>
          </div>
        </div>
        <div class="wr-topic-graded-stats" aria-label="阅读分级统计">
          ${filters
            .slice(1)
            .map(
              ([value, label, count]) => `
                <button class="wr-topic-graded-stat ${state.levelFilter === value ? "active" : ""}" type="button" data-wr-action="level-filter" data-filter="${value}">
                  <strong>${count}</strong><span>${label}</span>
                </button>`,
            )
            .join("")}
        </div>
        <div class="wr-topic-graded-controls">
          <input class="wr-topic-input wr-topic-graded-search" type="search" data-wr-action="filter-levels" placeholder="搜索书名或作者" value="${escapeHtml(state.levelQuery)}" autocomplete="off">
          <div class="wr-topic-graded-filters" role="group" aria-label="筛选阅读分级">
            ${filters
              .map(
                ([value, label, count]) =>
                  `<button class="wr-topic-btn wr-topic-catalog-filter ${state.levelFilter === value ? "active" : ""}" type="button" data-wr-action="level-filter" data-filter="${value}">${label} ${count}</button>`,
              )
              .join("")}
          </div>
        </div>
        <div class="wr-topic-graded-list" data-wr-graded-list>${gradedReadingListHtml()}</div>
      </section>`;
  }

  function pendingBookLinks() {
    const books = libraryBookList();
    const wereadBooks = books.filter((book) => book.source === "weread" && book.wereadBookId);
    return books
      .filter((book) => book.source === "manual" && !book.wereadBookId)
      .flatMap((manual) =>
        wereadBooks
          .filter(
            (weread) =>
              weread.id !== manual.id &&
              weread.normalizedTitle === manual.normalizedTitle &&
              !(manual.ignoredWereadBookIds || []).includes(weread.wereadBookId),
          )
          .map((weread) => ({ manual, weread })),
      );
  }

  function filteredLibraryBooks() {
    const query = state.libraryQuery.trim().toLocaleLowerCase();
    return libraryBookList().filter((book) => {
      if (state.libraryFilter === "weread" && book.source !== "weread") return false;
      if (state.libraryFilter === "manual" && book.source !== "manual") return false;
      if (query && !`${book.title} ${book.author}`.toLocaleLowerCase().includes(query)) return false;
      return true;
    });
  }

  function libraryBookCardHtml(book) {
    const context = getBookContextSummary(book.id);
    return `
      <article class="wr-topic-library-card">
        <button class="wr-topic-library-main" type="button" data-wr-action="open-book-note" data-book-id="${escapeHtml(book.id)}" aria-label="打开书籍阅读上下文：${escapeHtml(book.title)}">
          ${coverMarkup(book, "wr-topic-library-cover")}
          <span class="wr-topic-library-content">
            <span class="wr-topic-library-title">${escapeHtml(book.title)}</span>
            <span class="wr-topic-library-meta">${escapeHtml(book.author || "未知作者")} · ${book.source === "weread" ? "微信读书" : "外部书"}</span>
            <span class="wr-topic-library-context">${escapeHtml(context || "暂无阅读上下文")}</span>
          </span>
        </button>
        <div class="wr-topic-library-card-actions">
          <button class="wr-topic-icon-btn" type="button" data-wr-action="edit-library-book" data-book-id="${escapeHtml(book.id)}" title="编辑书籍" aria-label="编辑书籍">${iconSvg("edit")}</button>
          <button class="wr-topic-icon-btn danger" type="button" data-wr-action="delete-library-book" data-book-id="${escapeHtml(book.id)}" title="删除书籍" aria-label="删除书籍">${iconSvg("trash")}</button>
        </div>
      </article>`;
  }

  function renderLibraryView() {
    const pending = pendingBookLinks();
    const filters = [
      ["all", "全部"],
      ["weread", "微信读书"],
      ["manual", "外部书"],
      ["pending", `待关联 ${pending.length}`],
    ];
    const pendingHtml = pending.length
      ? `<div class="wr-topic-library-grid">${pending
          .map(
            ({ manual, weread }) => `
              <article class="wr-topic-link-banner">
                <strong>${escapeHtml(manual.title)}</strong><br>
                外部书可能对应微信读书版本${weread.author ? ` · ${escapeHtml(weread.author)}` : ""}
                <div class="wr-topic-link-actions">
                  <button class="wr-topic-btn primary" type="button" data-wr-action="review-book-link" data-manual-id="${escapeHtml(manual.id)}" data-weread-id="${escapeHtml(weread.id)}">确认关联</button>
                  <button class="wr-topic-btn" type="button" data-wr-action="ignore-book-link" data-manual-id="${escapeHtml(manual.id)}" data-weread-id="${escapeHtml(weread.id)}">不是同一本</button>
                </div>
              </article>`,
          )
          .join("")}</div>`
      : `<div class="wr-topic-empty">没有待确认的微信读书版本。</div>`;
    const books = filteredLibraryBooks();
    return `
      <section class="wr-topic-library">
        <div class="wr-topic-library-head">
          <div><h3>书籍管理</h3><p>统一维护微信读书书籍和手动添加的外部书。</p></div>
          <button class="wr-topic-btn" type="button" data-wr-action="add-library-book" data-return="library">${iconSvg("plus")}<span>添加书籍</span></button>
        </div>
        <div class="wr-topic-library-controls">
          <input class="wr-topic-input wr-topic-library-search" type="search" data-wr-action="filter-library" placeholder="搜索书名或作者" value="${escapeHtml(state.libraryQuery)}" autocomplete="off">
          ${filters
            .map(
              ([value, label]) => `<button class="wr-topic-btn wr-topic-catalog-filter ${state.libraryFilter === value ? "active" : ""}" type="button" data-wr-action="library-filter" data-filter="${value}">${label}</button>`,
            )
            .join("")}
        </div>
        <div class="wr-topic-library-list" data-wr-library-list>
          ${
            state.libraryFilter === "pending"
              ? pendingHtml
              : books.length
                ? `<div class="wr-topic-library-grid">${books.map(libraryBookCardHtml).join("")}</div>`
                : `<div class="wr-topic-empty">没有符合当前筛选条件的书籍。</div>`
          }
        </div>
      </section>`;
  }

  function openLibraryBookEditor({ bookId = "", returnTo = "library", prefillTitle = "" } = {}) {
    const existing = getLibraryBook(bookId);
    state.editingBookId = existing ? existing.id : "";
    state.bookModalReturn = { type: returnTo };
    document.getElementById("wr-topic-book-editor-modal")?.remove();
    const book = existing || {
      title: prefillTitle,
      author: "",
      coverUrl: "",
      detailUrl: "",
      readerUrl: "",
    };
    const modal = document.createElement("div");
    modal.className = "wr-topic-modal wr-topic-nested-modal";
    modal.id = "wr-topic-book-editor-modal";
    modal.innerHTML = `
      <div class="wr-topic-modal-card wr-topic-book-editor" role="dialog" aria-modal="true" aria-label="${existing ? "编辑书籍" : "添加书籍"}">
        <div class="wr-topic-modal-head">
          <h3>${existing ? "编辑书籍" : "添加书籍"}</h3>
          <button class="wr-topic-icon-btn" type="button" data-wr-action="close-book-editor" title="关闭" aria-label="关闭">${iconSvg("x")}</button>
        </div>
        <form class="wr-topic-book-editor-form" data-wr-form="library-book" data-book-id="${escapeHtml(existing ? existing.id : "")}">
          <div class="wr-topic-field"><label for="wr-library-title">书名</label><input id="wr-library-title" class="wr-topic-input" name="title" maxlength="300" value="${escapeHtml(book.title)}" required autocomplete="off"></div>
          <div class="wr-topic-field"><label for="wr-library-author">作者</label><input id="wr-library-author" class="wr-topic-input" name="author" maxlength="300" value="${escapeHtml(book.author)}" autocomplete="off"></div>
          <div class="wr-topic-field"><label for="wr-library-cover">封面 URL</label><input id="wr-library-cover" class="wr-topic-input" name="coverUrl" type="url" maxlength="2048" value="${escapeHtml(book.coverUrl)}" placeholder="https://...">${existing && existing.source === "weread" ? '<p class="wr-topic-field-hint">手动修改后会优先使用此封面；清空可恢复微信读书封面。</p>' : ""}</div>
          <div class="wr-topic-field"><label for="wr-library-detail">书籍详情 URL</label><input id="wr-library-detail" class="wr-topic-input" name="detailUrl" type="url" maxlength="2048" value="${escapeHtml(book.detailUrl)}" placeholder="https://..."></div>
          <div class="wr-topic-field"><label for="wr-library-reader">阅读入口 URL</label><input id="wr-library-reader" class="wr-topic-input" name="readerUrl" type="url" maxlength="2048" value="${escapeHtml(book.readerUrl)}" placeholder="https://..."></div>
          <div class="wr-topic-modal-actions"><button class="wr-topic-btn" type="button" data-wr-action="close-book-editor">取消</button><button class="wr-topic-btn primary" type="submit">保存</button></div>
        </form>
      </div>`;
    safeAppend(getMountRoot(), modal, "library book editor");
  }

  function closeLibraryBookEditor() {
    document.getElementById("wr-topic-book-editor-modal")?.remove();
    state.editingBookId = "";
    state.bookModalReturn = null;
  }

  async function persistBookDependentState() {
    await Promise.all([
      dbSet(STORE.libraryBooks, state.libraryBooks),
      dbSet(STORE.groups, state.groups),
      dbSet(STORE.notes, state.notes),
      dbSet(STORE.readingLevels, state.readingLevels),
      dbSet(STORE.relations, state.relations),
    ]);
    await markLocalChange();
  }

  async function refreshBookSnapshots(bookId) {
    const book = getLibraryBook(bookId);
    if (!book) return;
    if (state.notes[bookId] && state.notes[bookId].book) {
      state.notes[bookId].book = legacyBookSnapshot(book);
    }
    if (state.readingLevels[bookId] && state.readingLevels[bookId].book) {
      state.readingLevels[bookId].book = legacyBookSnapshot(book);
    }
    for (const relation of state.relations) {
      if (relation.fromBookId === bookId) relation.from = await relationRefForLibraryBook(book);
      if (relation.toBookId === bookId) relation.to = await relationRefForLibraryBook(book);
    }
  }

  async function saveLibraryBookFromForm(form) {
    const title = form.elements.title.value.trim();
    if (!title) return;
    let coverUrlInput;
    let detailUrl;
    let readerUrl;
    try {
      coverUrlInput = validateOptionalHttpsUrl(form.elements.coverUrl.value, "封面 URL");
      detailUrl = validateOptionalHttpsUrl(form.elements.detailUrl.value, "书籍详情 URL");
      readerUrl = validateOptionalHttpsUrl(form.elements.readerUrl.value, "阅读入口 URL");
    } catch (error) {
      alert(error.message);
      return;
    }
    const existing = getLibraryBook(form.dataset.bookId);
    if (!existing) {
      const duplicate = libraryBookList().find((book) => book.normalizedTitle === normalizeTitle(title));
      if (duplicate && !confirm(`书库中已有同名书籍“${duplicate.title}”。仍要作为另一版本创建吗？`)) return;
    }
    const timestamp = nowIso();
    const id = existing
      ? existing.id
      : `local_${window.crypto && typeof window.crypto.randomUUID === "function" ? window.crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
    const coverFields = editedLibraryBookCover(existing, coverUrlInput);
    state.libraryBooks[id] = normalizeLibraryBook(
      {
        ...(existing || {}),
        id,
        title,
        author: form.elements.author.value.trim(),
        ...coverFields,
        detailUrl,
        readerUrl,
        source: existing ? existing.source : "manual",
        createdAt: (existing && existing.createdAt) || timestamp,
        updatedAt: timestamp,
      },
      id,
      existing ? existing.source : "manual",
    );
    delete state.syncMeta.tombstones.books[id];
    await refreshBookSnapshots(id);
    const returnType = state.bookModalReturn && state.bookModalReturn.type;
    await persistBookDependentState();
    closeLibraryBookEditor();
    if (returnType === "group") {
      state.selectedBookIds.add(id);
      updateBookPicker();
    } else if (returnType === "relation") {
      const relationForm = document.querySelector('#wr-topic-relation-modal [data-wr-form="relation"]');
      if (relationForm) {
        relationForm.dataset.targetBookId = id;
        relationForm.elements.title.value = title;
        renderRelationCandidates(relationForm.elements.title);
        relationForm.requestSubmit();
      }
    }
    renderPanel();
  }

  async function deleteLibraryBook(bookId) {
    const book = getLibraryBook(bookId);
    if (!book) return;
    if (book.wereadBookId && state.books.some((item) => item.id === book.wereadBookId)) {
      alert("这本书仍在当前微信读书书架中。请先从微信读书书架移除，再删除本地主档。");
      return;
    }
    const affectedGroups = state.groups.filter((group) => (group.bookIds || []).includes(bookId));
    const relationCount = state.relations.filter(
      (relation) => relation.fromBookId === bookId || relation.toBookId === bookId,
    ).length;
    const summary = `将同时移出 ${affectedGroups.length} 个主题组，删除 ${state.notes[bookId] ? 1 : 0} 条上下文、${state.readingLevels[bookId] ? 1 : 0} 条分级和 ${relationCount} 条关系。`;
    if (!confirm(`确定删除“${book.title}”吗？\n${summary}`)) return;
    if (!confirm("此操作会同步到其他设备，确定继续吗？")) return;
    const timestamp = nowIso();
    state.groups = state.groups.map((group) =>
      (group.bookIds || []).includes(bookId)
        ? { ...group, bookIds: group.bookIds.filter((id) => id !== bookId), updatedAt: timestamp }
        : group,
    );
    if (state.notes[bookId]) {
      delete state.notes[bookId];
      markDeleted("notes", bookId, timestamp);
    }
    if (state.readingLevels[bookId]) {
      delete state.readingLevels[bookId];
      markDeleted("levels", bookId, timestamp);
    }
    state.relations = state.relations.filter((relation) => {
      const remove = relation.fromBookId === bookId || relation.toBookId === bookId;
      if (remove) markDeleted("relations", relation.id, timestamp);
      return !remove;
    });
    delete state.libraryBooks[bookId];
    markDeleted("books", bookId, timestamp);
    delete state.obsidianCache.contexts[bookId];
    await dbSet(STORE.obsidianCache, state.obsidianCache);
    await persistBookDependentState();
    renderPanel();
    refreshShelf();
  }

  function conflictChoiceHtml(name, label, manualValue, wereadValue, allowCombine = false) {
    if (!manualValue || !wereadValue || manualValue === wereadValue) return "";
    return `
      <div class="wr-topic-field">
        <label>${label}</label>
        <select class="wr-topic-input" name="${name}">
          <option value="manual">保留外部书版本</option>
          <option value="weread">保留微信读书版本</option>
          ${allowCombine ? '<option value="combine">合并两边内容</option>' : ""}
        </select>
      </div>`;
  }

  function openBookLinkEditor(manualId, wereadId) {
    const manual = getLibraryBook(manualId);
    const weread = getLibraryBook(wereadId);
    if (!manual || !weread) return;
    const manualNote = state.notes[manualId] || {};
    const wereadNote = state.notes[wereadId] || {};
    const manualLevel = readingLevelForBook(manualId);
    const wereadLevel = readingLevelForBook(wereadId);
    document.getElementById("wr-topic-book-link-modal")?.remove();
    const modal = document.createElement("div");
    modal.className = "wr-topic-modal wr-topic-nested-modal";
    modal.id = "wr-topic-book-link-modal";
    modal.innerHTML = `
      <div class="wr-topic-modal-card wr-topic-link-editor" role="dialog" aria-modal="true" aria-label="关联微信读书版本">
        <div class="wr-topic-modal-head"><h3>关联微信读书版本</h3><button class="wr-topic-icon-btn" type="button" data-wr-action="close-book-link" title="关闭" aria-label="关闭">${iconSvg("x")}</button></div>
        <div class="wr-topic-link-compare">
          <div class="wr-topic-link-book"><strong>外部书</strong><p>${escapeHtml(manual.title)}</p><p>${escapeHtml(manual.author || "未知作者")}</p></div>
          <div class="wr-topic-link-book"><strong>微信读书</strong><p>${escapeHtml(weread.title)}</p><p>${escapeHtml(weread.author || "未知作者")}</p></div>
        </div>
        <form class="wr-topic-book-editor-form" data-wr-form="book-link" data-manual-id="${escapeHtml(manualId)}" data-weread-id="${escapeHtml(wereadId)}">
          ${conflictChoiceHtml("noteChoice", "我为什么读这本书", manualNote.note, wereadNote.note, true)}
          ${conflictChoiceHtml("questionChoice", "阅读问题", manualNote.question, wereadNote.question, true)}
          ${conflictChoiceHtml("levelChoice", "阅读分级", manualLevel === "unclassified" ? "" : manualLevel, wereadLevel === "unclassified" ? "" : wereadLevel)}
          <p class="wr-topic-field-hint">确认后保留外部书的稳定 ID，主题组和阅读关系会自动合并。</p>
          <div class="wr-topic-modal-actions"><button class="wr-topic-btn" type="button" data-wr-action="close-book-link">取消</button><button class="wr-topic-btn primary" type="submit">确认关联</button></div>
        </form>
      </div>`;
    safeAppend(getMountRoot(), modal, "book link editor");
  }

  function chooseMergedValue(manualValue, wereadValue, choice) {
    if (!manualValue) return String(wereadValue || "");
    if (!wereadValue || manualValue === wereadValue) return String(manualValue);
    if (choice === "weread") return String(wereadValue);
    if (choice === "combine") return `${manualValue}\n\n${wereadValue}`;
    return String(manualValue);
  }

  async function mergeLinkedBooks(form) {
    const manualId = form.dataset.manualId;
    const wereadId = form.dataset.wereadId;
    const manual = getLibraryBook(manualId);
    const weread = getLibraryBook(wereadId);
    if (!manual || !weread) return;
    const timestamp = nowIso();
    const manualNote = state.notes[manualId] || {};
    const wereadNote = state.notes[wereadId] || {};
    const mergedBook = normalizeLibraryBook(
      {
        ...manual,
        title: weread.title || manual.title,
        author: weread.author || manual.author,
        coverUrl: weread.coverUrl || manual.coverUrl,
        detailUrl: weread.detailUrl || manual.detailUrl,
        readerUrl: weread.readerUrl || manual.readerUrl,
        source: "weread",
        wereadBookId: weread.wereadBookId,
        updatedAt: timestamp,
      },
      manualId,
      "weread",
    );
    state.libraryBooks[manualId] = mergedBook;

    state.groups = state.groups.map((group) => {
      const ids = (group.bookIds || []).map((id) => (id === wereadId ? manualId : id));
      const changed = ids.some((id, index) => id !== (group.bookIds || [])[index]);
      return changed ? { ...group, bookIds: [...new Set(ids)], updatedAt: timestamp } : group;
    });

    if (manualNote.note || manualNote.question || wereadNote.note || wereadNote.question) {
      state.notes[manualId] = {
        ...manualNote,
        book: legacyBookSnapshot(mergedBook),
        note: chooseMergedValue(manualNote.note, wereadNote.note, form.elements.noteChoice?.value),
        question: chooseMergedValue(manualNote.question, wereadNote.question, form.elements.questionChoice?.value),
        updatedAt: timestamp,
      };
      delete state.syncMeta.tombstones.notes[manualId];
    }
    if (state.notes[wereadId]) {
      delete state.notes[wereadId];
      markDeleted("notes", wereadId, timestamp);
    }

    const manualLevel = state.readingLevels[manualId];
    const wereadLevel = state.readingLevels[wereadId];
    const levelChoice = form.elements.levelChoice?.value;
    const chosenLevel =
      levelChoice === "weread" ? wereadLevel : manualLevel || wereadLevel;
    if (chosenLevel) {
      state.readingLevels[manualId] = {
        ...chosenLevel,
        book: legacyBookSnapshot(mergedBook),
        updatedAt: timestamp,
      };
      delete state.syncMeta.tombstones.levels[manualId];
    }
    if (state.readingLevels[wereadId]) {
      delete state.readingLevels[wereadId];
      markDeleted("levels", wereadId, timestamp);
    }

    const rewired = new Map();
    const rewiredSourceTimes = new Map();
    for (const relation of state.relations) {
      const fromBookId = relation.fromBookId === wereadId ? manualId : relation.fromBookId;
      const toBookId = relation.toBookId === wereadId ? manualId : relation.toBookId;
      if (fromBookId === toBookId) {
        markDeleted("relations", relation.id, timestamp);
        continue;
      }
      const id = await relationIdForBookIds(fromBookId, toBookId);
      const nextRelation = {
        ...relation,
        id,
        fromBookId,
        toBookId,
        from: await relationRefForLibraryBook(state.libraryBooks[fromBookId]),
        to: await relationRefForLibraryBook(state.libraryBooks[toBookId]),
        updatedAt: relation.id === id ? relation.updatedAt : timestamp,
      };
      const sourceTime = timestampValue(relation.updatedAt);
      if (!rewired.has(id) || sourceTime >= (rewiredSourceTimes.get(id) || 0)) {
        rewired.set(id, nextRelation);
        rewiredSourceTimes.set(id, sourceTime);
      }
      if (relation.id !== id) markDeleted("relations", relation.id, timestamp);
    }
    state.relations = [...rewired.values()];
    delete state.libraryBooks[wereadId];
    markDeleted("books", wereadId, timestamp);
    delete state.syncMeta.tombstones.books[manualId];
    if (state.obsidianCache.contexts[wereadId] && !state.obsidianCache.contexts[manualId]) {
      state.obsidianCache.contexts[manualId] = state.obsidianCache.contexts[wereadId];
    }
    delete state.obsidianCache.contexts[wereadId];
    await dbSet(STORE.obsidianCache, state.obsidianCache);
    await persistBookDependentState();
    document.getElementById("wr-topic-book-link-modal")?.remove();
    renderPanel();
    refreshShelf();
  }

  async function ignoreBookLink(manualId, wereadId) {
    const manual = getLibraryBook(manualId);
    const weread = getLibraryBook(wereadId);
    if (!manual || !weread || !weread.wereadBookId) return;
    state.libraryBooks[manualId] = {
      ...manual,
      ignoredWereadBookIds: [
        ...new Set([...(manual.ignoredWereadBookIds || []), weread.wereadBookId]),
      ],
      updatedAt: nowIso(),
    };
    await saveLibraryBooks(state.libraryBooks);
    renderPanel();
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
        <p class="wr-topic-cloud-summary">${text.panelSubTitle}</p>
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
              </div>
              <div class="wr-topic-shelf-tools" role="group" aria-label="书架工具">
                <button class="wr-topic-header-tool" type="button" data-wr-action="refresh-shelf">${iconSvg("refresh", "wr-topic-icon wr-topic-header-tool-icon")}<span>刷新书架</span></button>
                <button class="wr-topic-header-tool" type="button" data-wr-action="load-full-shelf">${iconSvg("library", "wr-topic-icon wr-topic-header-tool-icon")}<span>完整书架</span></button>
                <button class="wr-topic-header-tool" type="button" data-wr-action="open-graph" data-scope="all">${iconSvg("network", "wr-topic-icon wr-topic-header-tool-icon")}<span>${text.libraryGraph}</span></button>
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
              <button class="wr-topic-tab ${state.panelTab === "levels" ? "active" : ""}" type="button" role="tab" aria-selected="${state.panelTab === "levels"}" data-wr-action="switch-tab" data-tab="levels">${text.gradedReading}</button>
              <button class="wr-topic-tab ${state.panelTab === "library" ? "active" : ""}" type="button" role="tab" aria-selected="${state.panelTab === "library"}" data-wr-action="switch-tab" data-tab="library">${text.bookManagement}</button>
            </div>
          </header>
          ${
            state.panelTab === "catalog"
              ? renderCatalogView()
              : state.panelTab === "levels"
                ? renderGradedReadingView()
                : state.panelTab === "library"
                  ? renderLibraryView()
                : `<div class="wr-topic-panel-body">
                  <section class="wr-topic-sidebar">
                    <div class="wr-topic-count">微信书架 ${state.books.length} 本 · 本地书库 ${libraryBookList().length} 本</div>
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
    if (!isShelfEnhancementRoute()) return;
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
    const bookIds = [...state.selectedBookIds].filter((id) => getLibraryBook(id));

    if (state.formMode === "edit") {
      const group = groups.find((item) => item.id === state.editingGroupId);
      if (!group) return;
      group.name = name;
      group.description = description;
      group.bookIds = bookIds;
      group.updatedAt = now;
      state.selectedGroupId = group.id;
    } else {
      const group = {
        id: `topic_${Date.now()}`,
        name,
        description,
        bookIds,
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

    group.bookIds = (group.bookIds || []).filter((id) => id !== bookId);
    group.updatedAt = new Date().toISOString();

    if (!group.bookIds.length) {
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

  function coverMarkup(book, className) {
    if (book.cover) {
      return `<img class="${className}" src="${escapeHtml(book.cover)}" alt="">`;
    }
    return `<span class="${className} wr-topic-cover-placeholder" aria-hidden="true">${escapeHtml(String(book.title || "书").slice(0, 1))}</span>`;
  }

  function relationCardsHtml(relations, direction) {
    return relations
      .map((relation) => {
        const ref = direction === "incoming" ? relation.from : relation.to;
        const book = relationRefBook(ref);
        const action = book.id
          ? "open-related-book"
          : ref.detailUrl
            ? "open-external"
            : "edit-relation";
        return `
          <article class="wr-topic-relation-card" data-relation-id="${escapeHtml(relation.id)}">
            <button class="wr-topic-relation-main" type="button" data-wr-action="${action}" data-book-id="${escapeHtml(book.id || "")}" data-url="${escapeHtml(ref.detailUrl || "")}" data-relation-id="${escapeHtml(relation.id)}">
              ${coverMarkup(book, "wr-topic-relation-cover")}
              <span class="wr-topic-relation-content">
                <strong title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</strong>
                <span class="wr-topic-relation-type ${escapeHtml(relation.type)}">${relationTypeLabel(relation.type)}</span>
                <span class="wr-topic-relation-reason" title="${escapeHtml(relation.reason)}">${escapeHtml(relation.reason)}</span>
              </span>
            </button>
            <span class="wr-topic-relation-actions">
              ${!book.id && ref.detailUrl ? `<button type="button" data-wr-action="open-external" data-url="${escapeHtml(ref.detailUrl)}" title="打开书籍详情" aria-label="打开书籍详情">${iconSvg("external")}</button>` : ""}
              <button type="button" data-wr-action="edit-relation" data-relation-id="${escapeHtml(relation.id)}" title="编辑发现" aria-label="编辑发现">${iconSvg("edit")}</button>
              <button class="danger" type="button" data-wr-action="delete-relation" data-relation-id="${escapeHtml(relation.id)}" title="删除发现" aria-label="删除发现">${iconSvg("trash")}</button>
            </span>
          </article>`;
      })
      .join("");
  }

  function relationSectionHtml(book, direction) {
    const relations = relationsForBook(book)[direction];
    if (!relations.length) return "";
    const title = direction === "incoming" ? text.lineage : text.nextStop;
    return `
      <section class="wr-topic-relation-section">
        <h4>${title}</h4>
        <div class="wr-topic-relation-list" data-wr-relation-list="${direction}">${relationCardsHtml(relations, direction)}</div>
      </section>`;
  }

  function relationSlotHtml(book, direction) {
    return `<div class="wr-topic-relation-slot" data-wr-relation-slot="${direction}">${relationSectionHtml(book, direction)}</div>`;
  }

  function snapshotNoteDraft() {
    const form = document.querySelector('#wr-topic-note-modal [data-wr-form="note"]');
    if (!form) return;
    state.noteDrafts[form.dataset.bookId] = {
      note: form.elements.note.value,
      question: form.elements.question.value,
    };
  }

  function renderBookNoteContent(bookId) {
    const book = findBook(bookId);
    if (!book) return "";
    const readerUrl = readerUrlForBook(book);
    const notes = getNotes();
    const note = notes[bookId] || { note: "", question: "" };
    const draft = state.noteDrafts[bookId] || {};
    const obsidian = getObsidianContext(bookId);
    const obsidianAuthoritative = hasObsidianReadingContext(obsidian);
    const contextValue = obsidianAuthoritative
      ? obsidian.context
      : Object.prototype.hasOwnProperty.call(draft, "note")
        ? draft.note
        : note.note;
    const questionValue = obsidianAuthoritative
      ? obsidian.question
      : Object.prototype.hasOwnProperty.call(draft, "question")
        ? draft.question
        : note.question;
    return `
      <div class="wr-topic-modal-card wr-topic-note-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(text.bookNoteTitle)}">
        <div class="wr-topic-modal-head">
          <div class="wr-topic-note-heading">
            ${state.noteNavigationStack.length ? `<button class="wr-topic-icon-btn" type="button" data-wr-action="back-book-note" title="返回上一本书" aria-label="返回上一本书">${iconSvg("arrowLeft")}</button>` : ""}
            <h3>${text.bookNoteTitle}</h3>
          </div>
          <button class="wr-topic-btn" type="button" data-wr-action="close-note-modal">${text.close}</button>
        </div>
        <div class="wr-topic-modal-book">
          ${coverMarkup(book, "wr-topic-modal-book-cover")}
          <div class="wr-topic-modal-book-info">
            <span class="wr-topic-book-title">${escapeHtml(book.title)}</span>
            <span class="wr-topic-book-author">${escapeHtml(book.author)}</span>
          </div>
          <div class="wr-topic-modal-book-tools">
            <label class="wr-topic-modal-level">
              <span>阅读分级</span>
              <select class="wr-topic-input" data-wr-reading-level-select data-book-id="${escapeHtml(book.id)}" aria-label="阅读分级">
                ${readingLevelOptionsHtml(book.id)}
              </select>
            </label>
            ${readerUrl ? `<button class="wr-topic-btn wr-topic-modal-reader-btn" type="button" data-wr-action="open-reader" data-url="${escapeHtml(readerUrl)}">${iconSvg("bookOpen")}<span>${text.openReader}</span></button>` : ""}
            ${book.detailUrl && book.detailUrl !== readerUrl ? `<button class="wr-topic-btn" type="button" data-wr-action="open-external" data-url="${escapeHtml(book.detailUrl)}">${iconSvg("external")}<span>查看详情</span></button>` : ""}
          </div>
        </div>
        <form class="wr-topic-form" data-wr-form="note" data-book-id="${escapeHtml(bookId)}" data-obsidian-authoritative="${obsidianAuthoritative ? "1" : "0"}">
          <div class="wr-topic-note-scroll">
            ${relationSlotHtml(book, "incoming")}
            ${obsidianAuthoritative ? `<p class="wr-topic-source-note">阅读上下文和阅读问题来自 Obsidian，只读展示。原有本地内容仍被保留。</p>` : ""}
            <div class="wr-topic-field">
              <label for="wr-note-main">${text.whyRead}</label>
              <textarea id="wr-note-main" class="wr-topic-textarea" name="note" ${obsidianAuthoritative ? "readonly" : ""}>${escapeHtml(contextValue || "")}</textarea>
            </div>
            <div class="wr-topic-field">
              <label for="wr-note-question">${text.question}</label>
              <textarea id="wr-note-question" class="wr-topic-textarea" name="question" ${obsidianAuthoritative ? "readonly" : ""}>${escapeHtml(questionValue || "")}</textarea>
            </div>
            ${relationSlotHtml(book, "outgoing")}
          </div>
          <div class="wr-topic-modal-actions wr-topic-note-actions">
            <div>
              <button class="wr-topic-btn danger" type="button" data-wr-action="delete-book-note" data-book-id="${escapeHtml(bookId)}">${obsidianAuthoritative ? "清除本地状态" : text.deleteNote}</button>
            </div>
            <div>
              <button class="wr-topic-btn" type="button" data-wr-action="add-relation" data-book-id="${escapeHtml(bookId)}">${iconSvg("plus")}<span>${text.addDiscovery}</span></button>
              <button class="wr-topic-btn" type="button" data-wr-action="open-graph" data-scope="book" data-book-id="${escapeHtml(bookId)}">${iconSvg("network")}<span>${text.viewGraph}</span></button>
              <button class="wr-topic-btn primary" type="submit">${text.save}</button>
            </div>
          </div>
        </form>
      </div>`;
  }

  function openBookNote(bookId, { preserveHistory = false } = {}) {
    if (!findBook(bookId)) return;
    let modal = document.getElementById("wr-topic-note-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.className = "wr-topic-modal";
      modal.id = "wr-topic-note-modal";
      if (!preserveHistory) state.noteNavigationStack = [];
      if (!safeAppend(getMountRoot(), modal, "note modal")) return;
    }
    modal.innerHTML = renderBookNoteContent(bookId);
  }

  function refreshNoteRelationSections(bookId) {
    const form = document.querySelector('#wr-topic-note-modal [data-wr-form="note"]');
    const book = findBook(bookId);
    if (!form || !book || form.dataset.bookId !== bookId) return;
    for (const direction of ["incoming", "outgoing"]) {
      const slot = document.querySelector(
        `#wr-topic-note-modal [data-wr-relation-slot="${direction}"]`,
      );
      if (slot) slot.innerHTML = relationSectionHtml(book, direction);
    }
  }

  function closeNoteModal() {
    const modal = document.getElementById("wr-topic-note-modal");
    if (modal) modal.remove();
    state.noteNavigationStack = [];
    state.noteDrafts = {};
  }

  function relationCandidateBooks(input) {
    const form = input.form;
    const query = normalizeTitle(input.value);
    const currentBookId = form ? form.dataset.currentBookId : "";
    return libraryBookList()
      .filter(
        (book) =>
          book.id !== currentBookId &&
          (!query || normalizeTitle(`${book.title} ${book.author}`).includes(query)),
      )
      .slice(0, 8);
  }

  function renderRelationCandidates(input) {
    const container = input.form?.querySelector("[data-wr-relation-candidates]");
    if (!container) return;
    const books = relationCandidateBooks(input);
    const query = input.value.trim();
    container.innerHTML = `
      ${books
        .map(
          (book) => `<button class="wr-topic-relation-candidate" type="button" data-wr-action="select-relation-book" data-book-id="${escapeHtml(book.id)}"><span><strong>${escapeHtml(book.title)}</strong>${book.author ? `<br><small>${escapeHtml(book.author)}</small>` : ""}</span><span>${book.source === "weread" ? "微信读书" : "外部书"}</span></button>`,
        )
        .join("")}
      ${query ? `<button class="wr-topic-text-action" type="button" data-wr-action="create-relation-book">${iconSvg("plus")}<span>将“${escapeHtml(query)}”创建为外部书籍</span></button>` : ""}
    `;
  }

  function relationEndpointByNodeId(nodeId) {
    for (const relation of state.relations) {
      if (relation.from.nodeId === nodeId) return relation.from;
      if (relation.to.nodeId === nodeId) return relation.to;
    }
    return null;
  }

  function openRelationModal({ bookId = "", nodeId = "", relationId = "", direction = "outgoing" } = {}) {
    const editing = state.relations.find((relation) => relation.id === relationId) || null;
    const nodeRef = nodeId ? relationEndpointByNodeId(nodeId) : null;
    const currentBook = findBook(bookId || (nodeRef && nodeRef.bookId));
    if (!currentBook) return;

    let actualDirection = direction;
    if (editing && editing.toBookId === currentBook.id) actualDirection = "incoming";
    const otherRef = editing
      ? actualDirection === "incoming"
        ? editing.from
        : editing.to
      : null;
    const otherBook = otherRef ? findBook(otherRef.bookId) : null;
    closeRelationModal();
    const modal = document.createElement("div");
    modal.className = "wr-topic-modal wr-topic-nested-modal";
    modal.id = "wr-topic-relation-modal";
    modal.innerHTML = `
      <div class="wr-topic-modal-card wr-topic-relation-editor" role="dialog" aria-modal="true" aria-label="${editing ? "编辑发现" : text.addDiscovery}">
        <div class="wr-topic-modal-head">
          <h3>${editing ? "编辑发现" : text.addDiscovery}</h3>
          <button class="wr-topic-icon-btn" type="button" data-wr-action="close-relation-modal" title="关闭" aria-label="关闭">${iconSvg("x")}</button>
        </div>
        <p class="wr-topic-relation-current">当前书籍：<strong>${escapeHtml(currentBook.title)}</strong></p>
        <form class="wr-topic-relation-form" data-wr-form="relation" data-current-book-id="${escapeHtml(currentBook.id)}" data-target-book-id="${escapeHtml(otherBook ? otherBook.id : "")}" data-original-relation-id="${escapeHtml(editing ? editing.id : "")}">
          <fieldset class="wr-topic-segmented">
            <legend>方向</legend>
            <label><input type="radio" name="direction" value="outgoing" ${actualDirection === "outgoing" ? "checked" : ""}><span>这本书带我去</span></label>
            <label><input type="radio" name="direction" value="incoming" ${actualDirection === "incoming" ? "checked" : ""}><span>我从这本书来</span></label>
          </fieldset>
          <div class="wr-topic-field">
            <label for="wr-relation-title">书名</label>
            <input id="wr-relation-title" class="wr-topic-input" name="title" maxlength="300" value="${escapeHtml(otherBook ? otherBook.title : "")}" required autocomplete="off" data-wr-action="relation-title">
            <div class="wr-topic-relation-candidates" data-wr-relation-candidates></div>
          </div>
          <div class="wr-topic-field">
            <label for="wr-relation-reason">为什么想继续？</label>
            <textarea id="wr-relation-reason" class="wr-topic-textarea wr-topic-relation-reason-input" name="reason" maxlength="4000" required>${escapeHtml(editing ? editing.reason : "")}</textarea>
          </div>
          <fieldset class="wr-topic-relation-types">
            <legend>关系</legend>
            ${[
              ["extended-reading", "延伸阅读"],
              ["author-citation", "作者引用"],
              ["question-driven", "问题驱动"],
            ].map(([value, label], index) => `<label><input type="radio" name="type" value="${value}" ${(editing ? editing.type === value : index === 0) ? "checked" : ""}><span>${label}</span></label>`).join("")}
          </fieldset>
          <div class="wr-topic-modal-actions">
            <button class="wr-topic-btn" type="button" data-wr-action="close-relation-modal">${text.cancel}</button>
            <button class="wr-topic-btn primary" type="submit">${text.save}</button>
          </div>
        </form>
      </div>`;
    safeAppend(getMountRoot(), modal, "relation modal");
    const input = modal.querySelector('[data-wr-action="relation-title"]');
    if (input) renderRelationCandidates(input);
  }

  function closeRelationModal() {
    const modal = document.getElementById("wr-topic-relation-modal");
    if (modal) modal.remove();
  }

  function fillRelationCandidate(input) {
    const form = input.form;
    if (!form) return;
    const selected = findBook(form.dataset.targetBookId);
    if (!selected || selected.title !== input.value) form.dataset.targetBookId = "";
    renderRelationCandidates(input);
  }

  function activateExistingRelation(form) {
    const currentBookId = form.dataset.currentBookId;
    const targetBookId = form.dataset.targetBookId;
    if (!currentBookId || !targetBookId) return;
    const outgoing = form.elements.direction.value === "outgoing";
    const duplicate = state.relations.find((relation) =>
      outgoing
        ? relation.fromBookId === currentBookId && relation.toBookId === targetBookId
        : relation.fromBookId === targetBookId && relation.toBookId === currentBookId,
    );
    if (!duplicate) return;
    form.dataset.originalRelationId = duplicate.id;
    form.elements.reason.value = duplicate.reason;
    form.elements.type.value = duplicate.type;
    const heading = form.closest(".wr-topic-relation-editor")?.querySelector("h3");
    if (heading) heading.textContent = "编辑发现";
  }

  async function saveRelationFromForm(form) {
    const title = form.elements.title.value.trim();
    const reason = form.elements.reason.value.trim();
    if (!title || !reason || !form.elements.type.value) {
      alert("请填写书名、为什么想继续，并选择关系。");
      return;
    }
    if (title.length > 300 || reason.length > 4000) {
      alert("书名最多 300 字符，原因最多 4000 字符。");
      return;
    }
    if (!form.dataset.originalRelationId && state.relations.length >= 5000) {
      alert("阅读关系已达到 5000 条上限，请先整理已有关系。");
      return;
    }

    const currentBook = findBook(form.dataset.currentBookId);
    let targetBook = findBook(form.dataset.targetBookId);
    if (!targetBook) {
      const exactMatches = libraryBookList().filter(
        (book) => book.normalizedTitle === normalizeTitle(title),
      );
      if (exactMatches.length === 1) {
        targetBook = exactMatches[0];
        form.dataset.targetBookId = targetBook.id;
      } else if (exactMatches.length > 1) {
        alert("书库中有多个同名版本，请先从候选项中选择一本。");
        return;
      }
    }
    if (!targetBook) {
      openLibraryBookEditor({ returnTo: "relation", prefillTitle: title });
      return;
    }
    if (!currentBook) return;
    if (currentBook.id === targetBook.id) {
      alert("不能把一本书关联到它自己。");
      return;
    }

    const currentRef = await createRelationRef(currentBook);
    const targetRef = await createRelationRef(targetBook);
    const outgoing = form.elements.direction.value === "outgoing";
    const from = outgoing ? currentRef : targetRef;
    const to = outgoing ? targetRef : currentRef;
    const fromBookId = outgoing ? currentBook.id : targetBook.id;
    const toBookId = outgoing ? targetBook.id : currentBook.id;
    const id = await relationIdForBookIds(fromBookId, toBookId);
    const originalId = form.dataset.originalRelationId;
    const original = state.relations.find((relation) => relation.id === originalId);
    const duplicate = state.relations.find((relation) => relation.id === id);
    const timestamp = nowIso();
    const next = {
      id,
      fromBookId,
      toBookId,
      from,
      to,
      type: form.elements.type.value,
      reason,
      createdAt: (duplicate || original || {}).createdAt || timestamp,
      updatedAt: timestamp,
    };

    let relations = state.relations.filter(
      (relation) => relation.id !== id && relation.id !== originalId,
    );
    if (originalId && originalId !== id) markDeleted("relations", originalId, timestamp);
    delete state.syncMeta.tombstones.relations[id];
    relations.push(next);
    await saveRelations(relations);
    closeRelationModal();
    refreshNoteRelationSections(form.dataset.currentBookId);
    refreshOpenGraph();
  }

  async function deleteRelation(relationId) {
    const relation = state.relations.find((item) => item.id === relationId);
    if (!relation || !confirm("确定删除这条阅读发现吗？")) return;
    const timestamp = nowIso();
    markDeleted("relations", relationId, timestamp);
    await saveRelations(state.relations.filter((item) => item.id !== relationId));
    const form = document.querySelector('#wr-topic-note-modal [data-wr-form="note"]');
    if (form) refreshNoteRelationSections(form.dataset.bookId);
    refreshOpenGraph();
  }

  function graphScopeData({ scope = "all", bookId = "", groupId = "" } = {}) {
    let relations = [...state.relations];
    const group = getGroups().find((item) => item.id === groupId);
    const groupMembers = groupBooks(group);
    const groupBookIds = new Set([
      ...((group && Array.isArray(group.bookIds) ? group.bookIds : [])),
      ...groupMembers.map((book) => String(book.id || "")),
    ]);
    const groupTitles = new Set(
      groupMembers.map((book) => normalizeTitle(book.title)).filter(Boolean),
    );
    const endpointBookId = (relation, side) =>
      String(relation[`${side}BookId`] || relation[side]?.bookId || "");
    const endpointInGroup = (relation, side) => {
      const ref = relation[side] || {};
      const endpointId = endpointBookId(relation, side);
      return (
        (endpointId && groupBookIds.has(endpointId)) ||
        groupTitles.has(ref.normalizedTitle || normalizeTitle(ref.title))
      );
    };
    if (scope === "book") {
      const book = findBook(bookId);
      const normalized = normalizeTitle(book && book.title);
      relations = relations.filter(
        (relation) =>
          endpointBookId(relation, "from") === (book && book.id) ||
          endpointBookId(relation, "to") === (book && book.id) ||
          relation.from?.normalizedTitle === normalized ||
          relation.to?.normalizedTitle === normalized,
      );
    } else if (scope === "group") {
      relations = relations.filter(
        (relation) => endpointInGroup(relation, "from") || endpointInGroup(relation, "to"),
      );
    }

    const nodes = new Map();
    relations.forEach((relation) => {
      for (const [side, ref] of [["from", relation.from], ["to", relation.to]]) {
        const book = relationRefBook(ref);
        const outside = scope === "group" && !endpointInGroup(relation, side);
        nodes.set(ref.nodeId, {
          id: ref.nodeId,
          label: outside ? `组外 · ${book.title}` : book.title,
          title: book.title,
          cover: book.cover || ref.coverUrl || "",
          url: book.url || ref.detailUrl || "",
          bookId: book.id || "",
          outside,
        });
      }
    });
    return { scope, bookId, groupId, group, relations, nodes: [...nodes.values()] };
  }

  function graphHasCycle(nodes, relations) {
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(nodes.map((node) => [node.id, []]));
    relations.forEach((relation) => {
      indegree.set(relation.to.nodeId, (indegree.get(relation.to.nodeId) || 0) + 1);
      if (!outgoing.has(relation.from.nodeId)) outgoing.set(relation.from.nodeId, []);
      outgoing.get(relation.from.nodeId).push(relation.to.nodeId);
    });
    const queue = [...indegree.entries()]
      .filter(([, degree]) => degree === 0)
      .map(([id]) => id);
    let visited = 0;
    while (queue.length) {
      const id = queue.shift();
      visited += 1;
      (outgoing.get(id) || []).forEach((next) => {
        const degree = indegree.get(next) - 1;
        indegree.set(next, degree);
        if (degree === 0) queue.push(next);
      });
    }
    return visited !== nodes.length;
  }

  function graphLayoutOptions(data) {
    return graphHasCycle(data.nodes, data.relations)
      ? {
          name: "cose",
          animate: false,
          padding: 36,
          nodeRepulsion: 7500,
          idealEdgeLength: 140,
          nodeOverlap: 30,
          nodeDimensionsIncludeLabels: true,
        }
      : {
          name: "breadthfirst",
          directed: true,
          animate: false,
          padding: 36,
          spacingFactor: 1.3,
          nodeDimensionsIncludeLabels: true,
        };
  }

  function graphTitle(data) {
    if (data.scope === "book") {
      const book = findBook(data.bookId);
      return book ? `${book.title} · 阅读关系` : "当前书籍关系";
    }
    if (data.scope === "group") {
      return `${data.group ? data.group.name : "主题组"} · 阅读关系`;
    }
    return "全库阅读关系";
  }

  function graphElements(data) {
    const nodes = data.nodes.map((node) => ({
      group: "nodes",
      data: {
        ...node,
        image: node.graphImage || node.cover || "none",
      },
      classes: node.outside ? "outside" : "",
    }));
    const edges = data.relations.map((relation) => ({
      group: "edges",
      data: {
        id: relation.id,
        source: relation.from.nodeId,
        target: relation.to.nodeId,
        type: relation.type,
        label: relationTypeLabel(relation.type),
        reason: relation.reason,
      },
      classes: relation.type,
    }));
    return [...nodes, ...edges];
  }

  const graphCoverCache = new Map();

  function requiresGraphCoverProxy(value) {
    try {
      const url = new URL(String(value || ""));
      return (
        url.protocol === "https:" &&
        ["res.weread.qq.com", "cdn.weread.qq.com"].includes(url.hostname)
      );
    } catch (error) {
      return false;
    }
  }

  function graphCoverDataUrl(url) {
    if (!requiresGraphCoverProxy(url)) return Promise.resolve(url);
    if (graphCoverCache.has(url)) return graphCoverCache.get(url);
    const pending = new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: 15000,
        onload(response) {
          if (
            response.status < 200 ||
            response.status >= 300 ||
            !response.response ||
            typeof response.response.byteLength !== "number"
          ) {
            resolve(url);
            return;
          }
          const contentTypeMatch = String(response.responseHeaders || "").match(
            /^content-type:\s*([^;\r\n]+)/im,
          );
          const responseType = contentTypeMatch ? contentTypeMatch[1].trim() : "";
          const blob = new Blob([response.response], {
            type: responseType.startsWith("image/") ? responseType : "image/jpeg",
          });
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : url);
          reader.onerror = () => resolve(url);
          reader.readAsDataURL(blob);
        },
        onerror() {
          resolve(url);
        },
        ontimeout() {
          resolve(url);
        },
      });
    });
    graphCoverCache.set(url, pending);
    return pending;
  }

  function hydrateGraphCoverImages(graph, nodes) {
    nodes.forEach((node) => {
      if (!requiresGraphCoverProxy(node.cover)) return;
      graphCoverDataUrl(node.cover).then((image) => {
        if (!image || image === node.cover || state.graph !== graph || graph.destroyed()) return;
        const element = graph.getElementById(node.id);
        if (element && element.length) element.data("image", image);
      });
    });
  }

  function graphInspectorHtml(kind, data) {
    if (kind === "node") {
      return `
        <div class="wr-topic-graph-inspector-content">
          ${coverMarkup({ title: data.title, cover: data.cover }, "wr-topic-relation-cover")}
          <div><strong>${escapeHtml(data.title)}</strong>${data.outside ? '<span class="wr-topic-graph-outside">组外</span>' : ""}</div>
        </div>
        <div class="wr-topic-graph-inspector-actions">
          ${data.bookId ? `<button class="wr-topic-btn" type="button" data-wr-action="open-graph-book" data-book-id="${escapeHtml(data.bookId)}">打开上下文</button>` : ""}
          ${data.url ? `<button class="wr-topic-btn" type="button" data-wr-action="open-external" data-url="${escapeHtml(data.url)}">${iconSvg("external")}<span>书籍详情</span></button>` : ""}
        </div>`;
    }
    const relation = state.relations.find((item) => item.id === data.id);
    if (!relation) return "";
    return `
      <div class="wr-topic-graph-edge-title"><strong>${escapeHtml(relation.from.title)}</strong><span>→</span><strong>${escapeHtml(relation.to.title)}</strong></div>
      <span class="wr-topic-relation-type ${escapeHtml(relation.type)}">${relationTypeLabel(relation.type)}</span>
      <p>${escapeHtml(relation.reason)}</p>
      <div class="wr-topic-graph-inspector-actions">
        <button class="wr-topic-btn" type="button" data-wr-action="edit-relation" data-relation-id="${escapeHtml(relation.id)}">${iconSvg("edit")}<span>编辑</span></button>
        <button class="wr-topic-btn danger" type="button" data-wr-action="delete-relation" data-relation-id="${escapeHtml(relation.id)}">${iconSvg("trash")}<span>删除</span></button>
      </div>`;
  }

  function updateGraphInspector(kind, data) {
    const inspector = document.querySelector("[data-wr-graph-inspector]");
    if (inspector) inspector.innerHTML = graphInspectorHtml(kind, data);
  }

  function initializeGraph(data) {
    const container = document.querySelector("[data-wr-graph-canvas]");
    if (!container) return;
    const cytoscapeFactory = window.cytoscape;
    if (typeof cytoscapeFactory !== "function") {
      container.innerHTML = '<div class="wr-topic-graph-error">关系图库未能加载。书籍上下文中的关系卡片仍可正常使用。</div>';
      return;
    }
    if (state.graph) state.graph.destroy();
    state.graph = cytoscapeFactory({
      container,
      elements: graphElements(data),
      minZoom: 0.2,
      maxZoom: 3,
      layout: graphLayoutOptions(data),
      style: [
        {
          selector: "node",
          style: {
            width: 70,
            height: 94,
            shape: "round-rectangle",
            "background-color": "#edf1f7",
            "background-image": "data(image)",
            "background-fit": "cover",
            "border-width": 2,
            "border-color": "#8aaee0",
            label: "data(label)",
            color: "#1f2933",
            "font-size": 10,
            "text-wrap": "ellipsis",
            "text-max-width": 92,
            "text-valign": "bottom",
            "text-margin-y": 10,
          },
        },
        { selector: "node.outside", style: { "border-color": "#c8d0db", opacity: 0.72 } },
        { selector: "node:selected", style: { "border-color": "#2f80ed", "border-width": 4 } },
        {
          selector: "edge",
          style: {
            width: 2,
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "line-color": "#2f80ed",
            "target-arrow-color": "#2f80ed",
            label: "data(label)",
            color: "#526070",
            "font-size": 9,
            "text-background-color": "#fff",
            "text-background-opacity": 0.9,
            "text-background-padding": 2,
          },
        },
        { selector: "edge.author-citation", style: { "line-color": "#e68724", "target-arrow-color": "#e68724" } },
        { selector: "edge.question-driven", style: { "line-color": "#2d9a5b", "target-arrow-color": "#2d9a5b" } },
        { selector: ".wr-graph-hidden", style: { display: "none" } },
      ],
    });
    hydrateGraphCoverImages(state.graph, data.nodes);

    let lastTap = { id: "", at: 0 };
    state.graph.on("tap", "node", (event) => {
      const node = event.target;
      const item = node.data();
      updateGraphInspector("node", item);
      const now = Date.now();
      if (lastTap.id === item.id && now - lastTap.at < 320) {
        if (item.bookId) {
          closeGraphModal();
          openBookNote(item.bookId);
        } else if (item.url) {
          openExternalUrl(item.url);
        } else {
          const relation = data.relations.find(
            (entry) => entry.from.nodeId === item.id || entry.to.nodeId === item.id,
          );
          if (relation) openRelationModal({ nodeId: item.id, relationId: relation.id });
        }
      }
      lastTap = { id: item.id, at: now };
    });
    state.graph.on("tap", "edge", (event) =>
      updateGraphInspector("edge", event.target.data()),
    );
  }

  function openGraph(context = { scope: "all" }) {
    closeGraphModal();
    const data = graphScopeData(context);
    state.graphContext = { ...context };
    const modal = document.createElement("div");
    modal.className = "wr-topic-modal wr-topic-nested-modal";
    modal.id = "wr-topic-graph-modal";
    modal.innerHTML = `
      <div class="wr-topic-graph-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(graphTitle(data))}">
        <div class="wr-topic-modal-head">
          <h3>${escapeHtml(graphTitle(data))}</h3>
          <button class="wr-topic-icon-btn" type="button" data-wr-action="close-graph" title="关闭" aria-label="关闭">${iconSvg("x")}</button>
        </div>
        ${data.relations.length ? `
          <div class="wr-topic-graph-toolbar">
            <input class="wr-topic-input" type="search" data-wr-action="graph-search" placeholder="搜索书名" aria-label="搜索书名">
            <select class="wr-topic-input" data-wr-action="graph-filter" aria-label="筛选关系类型">
              <option value="all">全部关系</option>
              <option value="extended-reading">延伸阅读</option>
              <option value="author-citation">作者引用</option>
              <option value="question-driven">问题驱动</option>
            </select>
            <button class="wr-topic-icon-btn" type="button" data-wr-action="graph-fit" title="适应画布" aria-label="适应画布">${iconSvg("fit")}</button>
            <button class="wr-topic-icon-btn" type="button" data-wr-action="graph-layout" title="重新布局" aria-label="重新布局">${iconSvg("network")}</button>
            <button class="wr-topic-icon-btn" type="button" data-wr-action="graph-fullscreen" title="全屏查看" aria-label="全屏查看" aria-pressed="false">${iconSvg("fullscreen")}</button>
          </div>
          <div class="wr-topic-graph-body">
            <div class="wr-topic-graph-canvas" data-wr-graph-canvas></div>
            <aside class="wr-topic-graph-inspector" data-wr-graph-inspector><p>选择一本书或一条关系查看详情。</p></aside>
          </div>` : '<div class="wr-topic-graph-empty">这个范围内还没有阅读关系。</div>'}
      </div>`;
    if (!safeAppend(getMountRoot(), modal, "graph modal")) return;
    if (data.relations.length) window.setTimeout(() => initializeGraph(data), 0);
  }

  function closeGraphModal() {
    if (state.graph) {
      state.graph.destroy();
      state.graph = null;
    }
    const modal = document.getElementById("wr-topic-graph-modal");
    if (modal) modal.remove();
    state.graphContext = null;
  }

  function graphCardIsFullscreen(card) {
    return Boolean(
      card &&
        (document.fullscreenElement === card || card.classList.contains("is-fullscreen")),
    );
  }

  function updateGraphFullscreenButton() {
    const card = document.querySelector("#wr-topic-graph-modal .wr-topic-graph-card");
    const button = document.querySelector('[data-wr-action="graph-fullscreen"]');
    if (!card || !button) return;
    const active = graphCardIsFullscreen(card);
    const label = active ? "退出全屏" : "全屏查看";
    button.innerHTML = iconSvg(active ? "exitFullscreen" : "fullscreen");
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(active));
  }

  function refreshGraphViewport() {
    window.requestAnimationFrame(() => {
      if (!state.graph) return;
      state.graph.resize();
      state.graph.fit(undefined, 36);
    });
  }

  async function toggleGraphFullscreen() {
    const card = document.querySelector("#wr-topic-graph-modal .wr-topic-graph-card");
    if (!card) return;
    try {
      if (document.fullscreenElement === card) {
        await document.exitFullscreen();
      } else if (typeof card.requestFullscreen === "function") {
        await card.requestFullscreen();
      } else {
        card.classList.toggle("is-fullscreen");
        updateGraphFullscreenButton();
        refreshGraphViewport();
      }
    } catch (error) {
      console.warn("[WeRead Local Topic Shelf] fullscreen unavailable:", error);
      card.classList.toggle("is-fullscreen");
      updateGraphFullscreenButton();
      refreshGraphViewport();
    }
  }

  function onGraphFullscreenChange() {
    updateGraphFullscreenButton();
    refreshGraphViewport();
  }

  function refreshOpenGraph() {
    const context = state.graphContext ? { ...state.graphContext } : null;
    if (context) openGraph(context);
  }

  function filterGraph() {
    if (!state.graph) return;
    const query = normalizeTitle(
      document.querySelector('[data-wr-action="graph-search"]')?.value || "",
    );
    const type =
      document.querySelector('[data-wr-action="graph-filter"]')?.value || "all";
    state.graph.elements().removeClass("wr-graph-hidden");
    state.graph.edges().forEach((edge) => {
      if (type !== "all" && edge.data("type") !== type) {
        edge.addClass("wr-graph-hidden");
      }
    });
    state.graph.nodes().forEach((node) => {
      const hasVisibleEdge = node.connectedEdges().some((edge) => !edge.hasClass("wr-graph-hidden"));
      const matches = !query || normalizeTitle(node.data("title")).includes(query);
      if (!hasVisibleEdge || !matches) node.addClass("wr-graph-hidden");
    });
    state.graph.edges().forEach((edge) => {
      if (
        edge.source().hasClass("wr-graph-hidden") ||
        edge.target().hasClass("wr-graph-hidden")
      ) {
        edge.addClass("wr-graph-hidden");
      }
    });
  }

  function openExternalUrl(url) {
    if (!url) return;
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
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
        question: form.elements.question.value,
      },
      obsidianAuthoritative,
    );

    if (
      !notes[bookId].note &&
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
      if (!isShelfEnhancementRoute()) {
        deactivateShelfEnhancements();
        return;
      }
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

  function closeBookMenus(exceptRoot = null) {
    document.querySelectorAll(".wr-topic-group-book-menu").forEach((root) => {
      if (root === exceptRoot) return;
      const menu = root.querySelector("[data-wr-book-menu]");
      const submenu = root.querySelector("[data-wr-level-submenu]");
      const menuButton = root.querySelector('[data-wr-action="toggle-book-menu"]');
      const submenuButton = root.querySelector('[data-wr-action="toggle-level-submenu"]');
      if (menu) menu.hidden = true;
      if (submenu) submenu.hidden = true;
      if (menuButton) menuButton.setAttribute("aria-expanded", "false");
      if (submenuButton) submenuButton.setAttribute("aria-expanded", "false");
    });
  }

  function toggleBookMenu(button) {
    const root = button.closest(".wr-topic-group-book-menu");
    const menu = root && root.querySelector("[data-wr-book-menu]");
    if (!root || !menu) return;
    const shouldOpen = menu.hidden;
    closeBookMenus(root);
    menu.hidden = !shouldOpen;
    button.setAttribute("aria-expanded", String(shouldOpen));
  }

  function toggleLevelSubmenu(button) {
    const root = button.closest(".wr-topic-group-book-menu");
    const submenu = root && root.querySelector("[data-wr-level-submenu]");
    if (!submenu) return;
    const shouldOpen = submenu.hidden;
    submenu.hidden = !shouldOpen;
    button.setAttribute("aria-expanded", String(shouldOpen));
  }

  function actionNeedsDefaultPrevention(actionEl) {
    return !["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(actionEl.tagName);
  }

  async function onClick(event) {
    if (!isShelfEnhancementRoute()) return;
    const actionEl = event.target.closest("[data-wr-action]");
    if (!actionEl) {
      closeBookMenus();
      return;
    }

    if (!actionEl.closest(".wr-topic-group-book-menu")) closeBookMenus();

    const action = actionEl.dataset.wrAction;

    if (
      actionEl.closest("#wr-topic-panel-root") ||
      actionEl.closest("#wr-topic-note-modal") ||
      actionEl.closest("#wr-topic-cloud-modal") ||
      actionEl.closest("#wr-topic-relation-modal") ||
      actionEl.closest("#wr-topic-graph-modal") ||
      actionEl.closest("#wr-topic-book-editor-modal") ||
      actionEl.closest("#wr-topic-book-link-modal") ||
      actionEl.classList.contains("wr-topic-entry") ||
      actionEl.classList.contains("wr-book-context-icon") ||
      actionEl.classList.contains("wr-topic-shelf-group")
    ) {
      if (actionNeedsDefaultPrevention(actionEl)) event.preventDefault();
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
      const nextTab = actionEl.dataset.tab;
      state.panelTab = ["groups", "catalog", "levels", "library"].includes(nextTab)
        ? nextTab
        : "groups";
      renderPanel();
    }
    if (action === "catalog-filter") {
      state.catalogFilter = actionEl.dataset.filter || "all";
      renderPanel();
    }
    if (action === "level-filter") {
      state.levelFilter = actionEl.dataset.filter || "all";
      renderPanel();
    }
    if (action === "library-filter") {
      state.libraryFilter = actionEl.dataset.filter || "all";
      renderPanel();
    }
    if (action === "add-library-book") {
      openLibraryBookEditor({ returnTo: actionEl.dataset.return || "library" });
    }
    if (action === "edit-library-book") {
      openLibraryBookEditor({ bookId: actionEl.dataset.bookId, returnTo: "library" });
    }
    if (action === "delete-library-book") await deleteLibraryBook(actionEl.dataset.bookId);
    if (action === "review-book-link") {
      openBookLinkEditor(actionEl.dataset.manualId, actionEl.dataset.wereadId);
    }
    if (action === "ignore-book-link") {
      await ignoreBookLink(actionEl.dataset.manualId, actionEl.dataset.wereadId);
    }
    if (action === "close-book-editor") closeLibraryBookEditor();
    if (action === "close-book-link") document.getElementById("wr-topic-book-link-modal")?.remove();
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
        group ? (group.bookIds || []).slice() : [],
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
    if (action === "toggle-book-menu") toggleBookMenu(actionEl);
    if (action === "toggle-level-submenu") toggleLevelSubmenu(actionEl);
    if (action === "set-reading-level") {
      try {
        await setReadingLevel(actionEl.dataset.bookId, actionEl.dataset.level);
      } catch (error) {
        alert(`阅读分级保存失败：${error.message}`);
      }
    }
    if (action === "remove-book")
      await removeBookFromGroup(
        actionEl.dataset.groupId,
        actionEl.dataset.bookId,
      );
    if (action === "open-reader" || action === "open-external")
      openExternalUrl(actionEl.dataset.url);
    if (action === "open-book-note") openBookNote(actionEl.dataset.bookId);
    if (action === "open-related-book") {
      const form = document.querySelector('#wr-topic-note-modal [data-wr-form="note"]');
      if (form) {
        snapshotNoteDraft();
        state.noteNavigationStack.push(form.dataset.bookId);
      }
      openBookNote(actionEl.dataset.bookId, { preserveHistory: true });
    }
    if (action === "back-book-note") {
      snapshotNoteDraft();
      const previous = state.noteNavigationStack.pop();
      if (previous) openBookNote(previous, { preserveHistory: true });
    }
    if (action === "add-relation") {
      openRelationModal({ bookId: actionEl.dataset.bookId, direction: "outgoing" });
    }
    if (action === "select-relation-book") {
      const form = actionEl.closest('[data-wr-form="relation"]');
      const book = findBook(actionEl.dataset.bookId);
      if (form && book) {
        form.dataset.targetBookId = book.id;
        form.elements.title.value = book.title;
        const candidates = form.querySelector("[data-wr-relation-candidates]");
        if (candidates) candidates.innerHTML = "";
        activateExistingRelation(form);
      }
    }
    if (action === "create-relation-book") {
      const form = actionEl.closest('[data-wr-form="relation"]');
      openLibraryBookEditor({
        returnTo: "relation",
        prefillTitle: form ? form.elements.title.value.trim() : "",
      });
    }
    if (action === "edit-relation") {
      const noteForm = document.querySelector('#wr-topic-note-modal [data-wr-form="note"]');
      openRelationModal({
        bookId: noteForm ? noteForm.dataset.bookId : "",
        relationId: actionEl.dataset.relationId,
      });
    }
    if (action === "delete-relation") await deleteRelation(actionEl.dataset.relationId);
    if (action === "close-relation-modal") closeRelationModal();
    if (action === "open-graph") {
      openGraph({
        scope: actionEl.dataset.scope || "all",
        bookId: actionEl.dataset.bookId || "",
        groupId: actionEl.dataset.groupId || "",
      });
    }
    if (action === "close-graph") closeGraphModal();
    if (action === "graph-fit" && state.graph) state.graph.fit(undefined, 36);
    if (action === "graph-fullscreen") await toggleGraphFullscreen();
    if (action === "graph-layout" && state.graph && state.graphContext) {
      state.graph.layout(graphLayoutOptions(graphScopeData(state.graphContext))).run();
    }
    if (action === "open-graph-book") {
      closeGraphModal();
      openBookNote(actionEl.dataset.bookId);
    }
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
    if (form.dataset.wrForm === "relation") await saveRelationFromForm(form);
    if (form.dataset.wrForm === "library-book") await saveLibraryBookFromForm(form);
    if (form.dataset.wrForm === "book-link") await mergeLinkedBooks(form);
  }

  function onInput(event) {
    const actionEl = event.target.closest(
      '[data-wr-action="filter-books"], [data-wr-action="filter-catalog"], [data-wr-action="filter-levels"], [data-wr-action="filter-library"], [data-wr-action="relation-title"], [data-wr-action="graph-search"]',
    );
    if (!actionEl) return;

    if (actionEl.dataset.wrAction === "filter-books") {
      state.bookFilter = actionEl.value || "";
      updateBookPicker();
      return;
    }

    if (actionEl.dataset.wrAction === "relation-title") {
      fillRelationCandidate(actionEl);
      return;
    }

    if (actionEl.dataset.wrAction === "graph-search") {
      filterGraph();
      return;
    }

    if (actionEl.dataset.wrAction === "filter-levels") {
      state.levelQuery = actionEl.value || "";
      const list = document.querySelector("[data-wr-graded-list]");
      if (list) list.innerHTML = gradedReadingListHtml();
      return;
    }

    if (actionEl.dataset.wrAction === "filter-library") {
      state.libraryQuery = actionEl.value || "";
      const list = document.querySelector("[data-wr-library-list]");
      if (list) {
        const books = filteredLibraryBooks();
        list.innerHTML = books.length
          ? `<div class="wr-topic-library-grid">${books.map(libraryBookCardHtml).join("")}</div>`
          : `<div class="wr-topic-empty">没有符合当前筛选条件的书籍。</div>`;
      }
      return;
    }

    state.catalogQuery = actionEl.value || "";
    const list = document.querySelector("[data-wr-catalog-list]");
    if (list) list.innerHTML = catalogListHtml();
  }

  async function onChange(event) {
    if (event.target.matches('[data-wr-action="graph-filter"]')) filterGraph();
    if (event.target.matches("[data-wr-reading-level-select]")) {
      try {
        await setReadingLevel(event.target.dataset.bookId, event.target.value);
      } catch (error) {
        alert(`阅读分级保存失败：${error.message}`);
      }
    }
    if (event.target.matches('#wr-topic-relation-modal [name="direction"]')) {
      const form = event.target.closest('[data-wr-form="relation"]');
      if (form) activateExistingRelation(form);
    }
  }

  function onKeydown(event) {
    if (event.key !== "Escape") return;
    if (document.getElementById("wr-topic-book-editor-modal")) {
      closeLibraryBookEditor();
    } else if (document.getElementById("wr-topic-book-link-modal")) {
      document.getElementById("wr-topic-book-link-modal")?.remove();
    } else if (document.getElementById("wr-topic-relation-modal")) {
      closeRelationModal();
    } else if (document.getElementById("wr-topic-graph-modal")) {
      closeGraphModal();
    } else if (document.getElementById("wr-topic-cloud-modal")) {
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
    document.addEventListener("search", onInput, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("fullscreenchange", onGraphFullscreenChange, true);
    state.listenersBound = true;
  }

  async function init() {
    await ensureStorageReady();

    const maintainShelfRoute = () => {
      if (!isShelfEnhancementRoute()) {
        deactivateShelfEnhancements();
        return;
      }

      const enteringRoute = !state.routeActive;
      state.routeActive = true;
      injectStyle();
      bindEventListeners();
      ensureFloatingButton();
      if (!document.querySelector(SELECTORS.shelfList)) return;

      const signature = getShelfSignature();
      if (!enteringRoute && signature === state.lastShelfSignature) return;
      state.lastShelfSignature = signature;
      refreshShelf();
    };

    maintainShelfRoute();
    if (isShelfEnhancementRoute() && isCloudConfigured()) scheduleCloudSync(300);

    window.setInterval(() => {
      maintainShelfRoute();
    }, 500);

    window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        isShelfEnhancementRoute() &&
        isCloudConfigured() &&
        Date.now() - state.lastCloudPullAt >= CLOUD_PULL_INTERVAL
      ) {
        syncCloud({ reason: "interval" }).catch((error) => {
          console.warn("[WeRead Local Topic Shelf] periodic cloud sync failed:", error);
        });
      }
    }, 60 * 1000);

    window.addEventListener("online", () => {
      if (isShelfEnhancementRoute()) scheduleCloudSync(300);
    });
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        isShelfEnhancementRoute() &&
        Date.now() - state.lastCloudPullAt >= CLOUD_PULL_INTERVAL
      ) {
        scheduleCloudSync(300);
      }
    });
  }

  init();
})();
