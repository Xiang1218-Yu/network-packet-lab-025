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
6. **帧来源与血缘**：每帧携带 `origin` 元数据，区分内置样例（含样例标识）、用户输入、导入快照和派生帧（含父帧 id）。摘要卡、捕获会话列表和导出文件中都展示来源链；对同一 raw 重新解析不会制造虚假的父子关系；父帧从会话中删除后，派生帧显示断链；旧版 API 响应缺少 `origin` 字段时，前端按“来源未知”降级，不猜测来源。
7. **捕获会话**：每次载入 / 解析 / 导入都会进入会话列表，可切换查看、删除单帧，并支持导出会话 JSON（含每帧来源链）与导入快照（导入帧标记来源文件名，撞 id 时自动重映射并保持同批血缘引用）。
8. **解析 API / 模拟数据 API**：Express 服务提供 `/api/parse`、`/api/simulate`、`/api/packets`、`/api/frames/:id` 和 `/api/health`。

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

请求体可附带 `parentId`（当前编辑所基于的帧 id）。服务端按以下规则判定 `origin`：

1. `raw` 与当前场景的内置样例完全一致 → `sample`（未修改的重新解析不会变成派生帧）；
2. `parentId` 指向的父帧确实存在且 `raw` 相对父帧有实际变化 → `derived`；
3. 其余情况（父帧未知、`raw` 与父帧相同、未提供 `parentId`）→ `user-input`。

### 获取某协议的全部示例

```bash
curl 'http://localhost:3001/api/packets?protocol=TCP'
```

### 按 id 查询已生成的帧（血缘核对）

```bash
curl 'http://localhost:3001/api/frames/<frameId>'
```

服务端在内存中保留最近生成的 500 帧；未知或已被淘汰的 id 返回 404。

### 响应中的来源字段

每个 `SimulatedPacket` 都带有 `origin`：

```json
{
  "origin": {
    "kind": "sample | user-input | import | derived",
    "sampleId": "http-request",
    "parentId": "http-request-mujfp0uw1",
    "importedFrom": "session-export.json",
    "recordedAt": "2026-09-27T06:24:29.020Z"
  }
}
```

`sampleId` / `parentId` / `importedFrom` 按 `kind` 可选出现；`import` 由前端在导入快照时写入，服务端只产生其余三种。旧版响应没有 `origin` 字段时，前端会降级为“来源未知”。

## 说明

本项目是教学用模拟器，不执行真实网卡抓包，也不声称校验真实 TCP 校验和。十六进制内容由当前输入字符串的 UTF-8 字节生成，字段解析为面向演示的轻量级解析结果。
