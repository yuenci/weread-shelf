const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const source = readFileSync(require("node:path").join(__dirname, "../weread-local-topic-shelf.user.js"), "utf8");

function load() {
  const names = ["state", "normalizeLibraryBook", "reconcileShelfBook", "bookPresentation", "renderGroupDetail", "renderGroupList", "gradedReadingListHtml", "renderLibraryView", "graphLayoutPositions", "filteredGraphData", "graphRelationListHtml", "graphScopeData", "buildLocalDataExport", "filteredLibraryBooks", "gradedReadingBooks"];
  names.push("onClick");
  const context = { console, URL, TextEncoder, TextDecoder, crypto: require("node:crypto").webcrypto, setTimeout, clearTimeout };
  context.window = context;
  context.location = { origin: "https://weread.qq.com", pathname: "/web/shelf" };
  const instrumented = source.replace(/\n  init\(\);\n\}\)\(\);\s*$/u, `\n globalThis.api = { ${names.join(", ")} };\n})();`);
  assert.notEqual(instrumented, source, "test harness must suppress production startup");
  runInNewContext(instrumented, context);
  return context.api;
}
const plain = value => JSON.parse(JSON.stringify(value));
const book = (id, values = {}) => ({ id, title: `Book_${id}`, author: "作者", source: "manual", readerUrl: "", ...values });

test("display title survives scans and exports without changing identity", () => {
  const api = load();
  const original = api.normalizeLibraryBook(book("a", { title: "Original_Book_中英对照", displayTitle: "我的书名", source: "weread" }), "a", "weread");
  const scanned = api.reconcileShelfBook(original, { id: "a", title: "Original_Book_中英对照", url: "https://weread.qq.com/web/reader/a" });
  assert.equal(scanned.displayTitle, "我的书名");
  assert.equal(scanned.normalizedTitle, "original_book_中英对照");
  api.state.libraryBooks = { a: scanned };
  const exported = api.buildLocalDataExport("2026-09-06T00:00:00.000Z");
  assert.equal(exported.data.books.a.displayTitle, "我的书名");
});

test("edition tags and aliases do not mutate stored titles", () => {
  const api = load();
  const original = book("a", { title: "Original_Book_中英对照", displayTitle: "阅读与思考" });
  assert.deepEqual(plain(api.bookPresentation(original)), { title: "阅读与思考", edition: "中英对照" });
  assert.deepEqual(plain(api.bookPresentation({ title: "Original_Book_中文译本" })), { title: "Original Book", edition: "中文译本" });
  assert.equal(original.title, "Original_Book_中英对照");
});

test("cards expose a reader only when a reading URL exists, and escape user content", () => {
  const api = load();
  api.state.libraryBooks = { a: book("a", { displayTitle: '<script>bad</script>', readerUrl: "https://example.com/read?a=1&b=2" }), b: book("b", { detailUrl: "https://example.com/detail" }) };
  const group = api.renderGroupDetail({ id: "g", name: "主题", bookIds: ["a", "b"] });
  assert.equal((group.match(/data-wr-action="open-reader"/g) || []).length, 1);
  assert.match(group, /data-url="https:\/\/example.com\/read\?a=1&amp;b=2"/);
  assert.match(group, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(group, /<script>/);
  for (const html of [api.gradedReadingListHtml(), api.renderLibraryView()]) {
    assert.equal((html.match(/data-wr-action="open-reader"/g) || []).length, 1);
  }
});

test("search finds both custom and original book names", () => {
  const api = load();
  api.state.libraryBooks = { a: book("a", { title: "Original_Book", displayTitle: "阅读与思考" }) };
  for (const query of ["阅读", "Original"]) {
    api.state.libraryQuery = api.state.levelQuery = query;
    assert.deepEqual(plain(api.filteredLibraryBooks().map(b => b.id)), ["a"]);
    assert.deepEqual(plain(api.gradedReadingBooks().map(b => b.id)), ["a"]);
  }
});

function graph() {
  return { nodes: [{ id: "a", title: "起点" }, { id: "b", title: "目标" }, { id: "c", title: "其他" }], relations: [
    { id: "ab", from: { nodeId: "a", title: "起点" }, to: { nodeId: "b", title: "目标" }, type: "extended-reading", reason: "延续问题" },
    { id: "bc", from: { nodeId: "b", title: "目标" }, to: { nodeId: "c", title: "其他" }, type: "author-citation", reason: "背景" },
  ] };
}
test("relationship search retains both endpoints and combines reason and type filters", () => {
  const api = load(), data = graph();
  assert.deepEqual(plain(api.filteredGraphData(data, "起点").nodes.map(n => n.id)), ["a", "b"]);
  assert.deepEqual(plain(api.filteredGraphData(data, "延续", "all").relations.map(r => r.id)), ["ab"]);
  assert.equal(api.filteredGraphData(data, "延续", "author-citation").relations.length, 0);
  assert.equal(api.filteredGraphData(data, "不存在").nodes.length, 0);
  assert.equal(data.relations.length, 2);
});

test("relationship text view contains full reasons and escapes them", () => {
  const api = load(), data = graph();
  data.relations[0].reason = "因为 <img onerror=bad>\n继续探究";
  const html = api.graphRelationListHtml(data);
  assert.match(html, /因为 &lt;img onerror=bad&gt;\n继续探究/);
  assert.match(html, /data-relation-id="ab"/);
  assert.doesNotMatch(html, /<img onerror/);
});

test("graph layout packs broad components without overlap or an unreadable horizontal strip", () => {
  const api = load();
  const nodes = Array.from({ length: 24 }, (_, i) => ({ id: `n${i}` }));
  const relations = nodes.slice(1, 20).map(n => ({ from: { nodeId: "n0" }, to: { nodeId: n.id } }));
  const points = Object.values(api.graphLayoutPositions({ nodes, relations }));
  assert.equal(new Set(points.map(p => `${p.x},${p.y}`)).size, 24);
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    assert.ok(Math.abs(points[i].x - points[j].x) >= 140 || Math.abs(points[i].y - points[j].y) >= 170);
  }
  const width = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x));
  const height = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
  assert.ok(width / height < 3);
  assert.deepEqual(plain(api.graphLayoutPositions({ nodes: [], relations: [] })), {});
});

test("graph layout handles cycles and unknown endpoints", () => {
  const api = load();
  const data = graph();
  data.relations.push({ from: { nodeId: "c" }, to: { nodeId: "a" } }, { from: { nodeId: "missing" }, to: { nodeId: "a" } });
  assert.deepEqual(Object.keys(api.graphLayoutPositions(data)).sort(), ["a", "b", "c"]);
});

test("embedded native controls and graph clicks are not intercepted as backdrop clicks", async () => {
  const api = load();
  const overlay = { dataset: { wrAction: "close-panel" }, classList: { contains: name => name === "wr-topic-overlay" }, tagName: "DIV" };
  overlay.closest = () => overlay;
  for (const tagName of ["BUTTON", "TEXTAREA", "CANVAS"]) {
    const event = { target: { tagName, closest: () => overlay }, preventDefault() { assert.fail(`${tagName} default was canceled`); }, stopPropagation() { assert.fail(`${tagName} propagation was stopped`); } };
    await api.onClick(event);
  }
});
