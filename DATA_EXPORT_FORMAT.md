# 微信读书助手本地数据导出格式

本文档描述 `weread-library-YYYY-MM-DD-HHmmss.json`。该文件用于把微信读书助手中的阅读数据交给其他软件读取，不是包含同步凭据的完整软件备份。

配套的机器可读校验文件见 [`weread-library-export.schema.json`](./weread-library-export.schema.json)。

## 格式识别

读取文件后，软件应先检查：

```js
payload.format === "weread-local-library-export"
payload.version === 1
```

未知 `format` 应拒绝导入；高于软件支持范围的 `version` 应提示升级解析器。对于已经支持的版本，应忽略不认识的附加字段，以便兼容后续小幅扩展。

## 顶层结构

```ts
interface WeReadLibraryExportV1 {
  format: "weread-local-library-export";
  version: 1;
  exportedAt: string; // ISO 8601 UTC 时间
  data: {
    books: Record<string, LibraryBook>;
    groups: TopicGroup[];
    notes: Record<string, BookNote>;
    readingLevels: Record<string, ReadingLevelRecord>;
    relations: ReadingRelation[];
  };
}
```

`books` 是主档。其他集合均通过书籍 ID 引用它。除非另有说明，所有 ID 都应按不透明字符串处理，不要截取、重新生成或推断含义。

## 书籍主档

```ts
type BookSource = "weread" | "manual";

interface LibraryBook {
  id: string;
  title: string;
  normalizedTitle: string;
  author: string;
  coverUrl: string;
  wereadCoverUrl: string;
  manualCoverUrl: string;
  detailUrl: string;
  readerUrl: string;
  source: BookSource;
  wereadBookId: string;
  ignoredWereadBookIds: string[];
  createdAt: string;
  updatedAt: string;
}
```

- `books` 的对象键必须等于对应记录的 `id`。
- `id` 是本地稳定主键。外部书通常以 `local_` 开头，但解析器不应依赖此前缀。
- `normalizedTitle` 仅用于搜索和候选匹配。显示时使用 `title`，不要按标题自动合并书籍。
- `source` 为 `manual` 时代表手动添加的外部书；关联微信读书后会变为 `weread`，但 `id` 可以继续保留原本的本地 ID。
- `wereadBookId` 为空表示尚未关联微信读书版本。
- `coverUrl` 是当前实际使用的封面。`manualCoverUrl` 是用户覆盖值，`wereadCoverUrl` 是微信读书来源值。
- URL 可以是空字符串；非空时应为 HTTPS。

## 主题组

```ts
interface TopicGroup {
  id: string;
  name: string;
  description: string;
  bookIds: string[];
  pinnedBookIds?: string[];
  createdAt: string;
  updatedAt: string;
}
```

`bookIds` 中的每个值引用 `data.books[bookId]`。`pinnedBookIds` 是主题组内置顶书籍的有序子集，数组越靠前，显示位置越靠前；字段缺失等同于空数组。`description` 是主题组描述，不是单本书的阅读上下文。

## 单本书阅读上下文

```ts
interface BookSnapshot {
  id: string;
  title: string;
  author?: string;
  url?: string;
  cover?: string;
  // 可能包含来自书籍主档的其他兼容字段
}

interface BookNote {
  book?: BookSnapshot;
  note: string;
  question: string;
  updatedAt: string;
}
```

- `notes` 的对象键是书籍 ID，并引用 `data.books`。
- `note` 对应“我为什么读这本书”。
- `question` 对应“阅读问题”。
- `book` 是兼容旧客户端的显示快照，可能缺失或过期。解析器应以 `books[bookId]` 为准。
- 仅存在于 Obsidian 匹配缓存、没有保存进本地 `notes` 的内容不包含在导出文件中。

## 阅读分级

```ts
type ReadingLevel = "deep" | "light" | "casual";

interface ReadingLevelRecord {
  book?: BookSnapshot;
  level: ReadingLevel;
  updatedAt: string;
}
```

`readingLevels` 的对象键是书籍 ID：

| 值 | 中文含义 |
| --- | --- |
| `deep` | 深度阅读 |
| `light` | 轻度阅读 |
| `casual` | 随便读读 |

没有出现在 `readingLevels` 中的书籍表示“未分级”。不要期待或写入 `unclassified` 记录。

## 阅读关系

```ts
type RelationType =
  | "extended-reading"
  | "author-citation"
  | "question-driven";

interface RelationBookRef {
  nodeId: string;
  bookId: string;
  title: string;
  normalizedTitle: string;
  detailUrl: string;
  coverUrl: string;
}

interface ReadingRelation {
  id: string;
  fromBookId: string;
  toBookId: string;
  from: RelationBookRef;
  to: RelationBookRef;
  type: RelationType;
  reason: string;
  createdAt: string;
  updatedAt: string;
}
```

- 关系是有向边：`fromBookId -> toBookId`，含义是“前一本书把我带向后一本书”。
- 对于当前书，指向它的边是“阅读脉络”，从它指出的边是“下一站”。
- `fromBookId` 和 `toBookId` 是权威引用；`from` 和 `to` 是便于显示的兼容快照。
- `extended-reading`、`author-citation`、`question-driven` 分别表示延伸阅读、作者引用和问题驱动。
- 正向与反向关系是两条独立记录。

## 最小示例

```json
{
  "format": "weread-local-library-export",
  "version": 1,
  "exportedAt": "2026-09-04T08:30:45.000Z",
  "data": {
    "books": {
      "book_a": {
        "id": "book_a",
        "title": "示例书籍",
        "normalizedTitle": "示例书籍",
        "author": "示例作者",
        "coverUrl": "",
        "wereadCoverUrl": "",
        "manualCoverUrl": "",
        "detailUrl": "",
        "readerUrl": "",
        "source": "manual",
        "wereadBookId": "",
        "ignoredWereadBookIds": [],
        "createdAt": "2026-09-01T00:00:00.000Z",
        "updatedAt": "2026-09-01T00:00:00.000Z"
      }
    },
    "groups": [],
    "notes": {
      "book_a": {
        "note": "我想借这本书理解一个问题。",
        "question": "作者的核心论证是什么？",
        "updatedAt": "2026-09-02T00:00:00.000Z"
      }
    },
    "readingLevels": {
      "book_a": {
        "level": "deep",
        "updatedAt": "2026-09-02T00:00:00.000Z"
      }
    },
    "relations": []
  }
}
```

## 推荐解析顺序

1. 解析 JSON，并检查 `format` 与 `version`。
2. 使用 JSON Schema 校验结构；校验失败时保留原文件并报告具体路径。
3. 先建立 `books` 主档索引。
4. 再读取主题组、上下文和分级，通过对象键或 `bookIds` 关联书籍。
5. 最后读取关系，通过 `fromBookId` 和 `toBookId` 建立有向图。
6. 遇到缺失书籍引用时保留原记录并标记为 unresolved，不要按标题静默合并。
7. 导入其他系统时保留未知字段和原始 ID，避免未来无法无损回写。

## 不包含的数据

导出文件不会包含 Cloudflare 地址、密钥或 Token、设备 ID、同步状态、删除墓碑、Obsidian 匹配缓存以及搜索或弹窗等临时界面状态。该文件当前也不定义回写微信读书助手的导入行为。
