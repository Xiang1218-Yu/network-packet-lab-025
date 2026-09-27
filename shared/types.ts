export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';

export interface HexRow {
  offset: string;
  bytes: string[];
  ascii: string;
}

export interface ProtocolField {
  id: string;
  key: string;
  value: string;
  description: string;
  children?: ProtocolField[];
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  label: string;
  phase: 'ingress' | 'parse' | 'transport' | 'application' | 'egress';
  detail: string;
}

/**
 * 帧来源类别：
 * - sample：内置样例（raw 与样例完全一致，含未修改的重新解析）
 * - user-input：用户手工输入 / 编辑后的全新内容
 * - import：从导出文件导入的快照
 * - derived：在某一父帧基础上修改得到的派生帧（如脱敏副本）
 */
export type PacketOriginKind = 'sample' | 'user-input' | 'import' | 'derived';

export interface PacketOrigin {
  kind: PacketOriginKind;
  /** 内置样例标识，例如 http-request / tcp-handshake */
  sampleId?: string;
  /** 派生帧指向的父帧 id；父帧被删除或不在当前会话时，客户端应显示断链 */
  parentId?: string;
  /** 导入快照的来源文件名 */
  importedFrom?: string;
  /** 来源记录时间（ISO 8601） */
  recordedAt: string;
}

/**
 * 客户端解析后的来源视图。旧版 API 响应缺少 origin 字段（或字段不完整）时，
 * 客户端必须降级为 { kind: 'unknown' }，而不是猜测来源。
 */
export type ResolvedOrigin = PacketOrigin | { kind: 'unknown' };

export interface SimulatedPacket {
  id: string;
  protocol: Protocol;
  scenario: PacketScenario;
  summary: string;
  raw: string;
  hex: HexRow[];
  fields: ProtocolField[];
  timeline: TimelineEvent[];
  metadata: {
    capturedAt: string;
    source: string;
    destination: string;
    length: number;
    checksum: string;
  };
  origin: PacketOrigin;
}

export interface ParseRequest {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
  /** 当前编辑内容所基于的帧 id；仅当 raw 相对父帧有实际变化时才会形成派生关系 */
  parentId?: string;
}
