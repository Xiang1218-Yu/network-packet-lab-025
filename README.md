# Network Packet Lab · 网络协议数据包可视化实验室

项目 10：一个用于学习和演示网络协议解析过程的可视化实验室。当前版本聚焦模拟 HTTP / TCP 数据包，提供输入、场景选择、协议层级字段树、十六进制数据、解析时间线，以及可供 React 管理界面调用的 Node.js API。

## 技术栈

- **前端**：React 18、Vite、TypeScript
- **后端**：Node.js、Express、TypeScript
- **工程**：前后端共享 `shared/types.ts` 类型，根目录统一管理脚本

## 目录结构

```text
network-packet-lab/
├── client/
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       └── styles.css
├── server/
│   └── index.ts
├── shared/
│   └── types.ts
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
└── .gitignore
```

## 功能

1. **模拟数据选择**：在 HTTP / TCP 协议之间切换，并选择请求、响应或 TCP 握手场景。
2. **数据包输入**：编辑原始 HTTP 文本或 TCP 模拟摘要，点击“解析数据包”重新生成可视化结果。
3. **协议字段树**：HTTP 展示起始行、Header、Payload；TCP 展示 Ethernet、IPv4、TCP 和 Payload 层级，并支持折叠。
4. **十六进制视图**：以 offset、hex bytes、ASCII 三列展示当前 payload 的 UTF-8 字节。
5. **传输时间线**：展示抓包、解析、传输层解码和结构化输出等阶段。
6. **来源与血缘**：每个帧都携带 `lineage` 元数据，区分内置样例、用户输入、导入快照与派生帧（含父帧链）；摘要卡、捕获会话列表和导出 JSON 中都会展示来源链。
7. **捕获会话**：会话面板记录本次捕获的所有帧，支持载入、生成脱敏副本和删除；删除父帧后派生帧会显示断链。
8. **解析 API / 模拟数据 API**：Express 服务提供 `/api/parse`、`/api/simulate`、`/api/packets`、`/api/import`、`/api/packets/:id/derive` 和 `/api/health`。

## 来源与血缘模型

每个数据包的 `lineage` 字段描述其来源（`kind`）：

| kind | 含义 | 附加字段 |
| --- | --- | --- |
| `sample` | 内置模拟样例 | `sampleId`（如 `HTTP/request`） |
| `user-input` | 用户手工输入 | — |
| `import` | 从本地文件导入的快照 | `importedFrom`（文件名） |
| `derived` | 从其他帧派生（编辑或脱敏） | `parentId`、`derivation`（`edited` / `sanitized`） |

- `contentHash` 是原始字节的指纹：**用相同的 raw 重新解析不会制造新的父子关系**，服务端直接返回已有帧（响应带 `reused: true`）。
- `chain` 是从根帧到当前帧的完整来源链；`parentMissing` 为 `true` 或链中节点带 `missing` 表示父帧已被删除（断链）。
- 旧版 API 响应不包含 `lineage` 字段，客户端会将其显示为“未知来源”，不会根据接口路径猜测。

## 启动方式

当前只完整落盘项目文件，**没有安装依赖**。准备运行时，在本目录执行：

```bash
npm install
```

然后打开两个终端：

```bash
# 终端 1：启动 API 服务（默认 3001）
npm run dev:server

# 终端 2：启动 Vite 管理界面（默认 5173）
npm run dev:client
```

浏览器访问 `http://localhost:5173`。如需更换 API 地址，可设置 `VITE_API_BASE`，例如：

```bash
VITE_API_BASE=http://localhost:3001 npm run dev:client
```

生产构建：

```bash
npm run build
npm start
```

> `npm start` 会启动编译后的 API 服务；前端静态产物位于 `dist/client`，可交给任意静态服务器托管。

## API 示例

### 获取模拟数据

```bash
curl 'http://localhost:3001/api/simulate?protocol=HTTP&scenario=request'
curl 'http://localhost:3001/api/simulate?protocol=TCP&scenario=handshake'
```

### 解析输入数据包

```bash
curl -X POST 'http://localhost:3001/api/parse' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"HTTP","scenario":"request","raw":"GET /health HTTP/1.1\\r\\nHost: lab.local\\r\\n\\r\\n"}'
```

### 获取某协议的全部示例

```bash
curl 'http://localhost:3001/api/packets?protocol=TCP'
```

### 导入快照

```bash
curl -X POST 'http://localhost:3001/api/import' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"TCP","scenario":"request","raw":"TCP 172.16.0.5:9000 > 172.16.0.9:443 | Seq=1 Ack=1 | Flags=ACK | Win=1000 | Len=24","fileName":"capture-01.log"}'
```

### 生成脱敏副本（派生帧）

```bash
curl -X POST 'http://localhost:3001/api/packets/sample-http-request/derive'
```

### 查询 / 删除单个帧

```bash
curl 'http://localhost:3001/api/packets/sample-http-request'
curl -X DELETE 'http://localhost:3001/api/packets/sample-http-request'
```

删除响应会返回 `affected`：来源链经过被删帧的所有派生帧，已按断链状态重新序列化（`parentMissing: true`，链上节点带 `missing`）。

## 说明

本项目是教学用模拟器，不执行真实网卡抓包，也不声称校验真实 TCP 校验和。十六进制内容由当前输入字符串的 UTF-8 字节生成，字段解析为面向演示的轻量级解析结果。
