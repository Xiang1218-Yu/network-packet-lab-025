import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  DeletePacketResponse,
  ImportRequest,
  LineageNode,
  PacketLineage,
  PacketOriginKind,
  PacketResponse,
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  SimulatedPacket,
  TimelineEvent
} from '../../shared/types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

const originLabels: Record<PacketOriginKind | 'unknown', string> = {
  sample: '内置样例',
  'user-input': '用户输入',
  import: '导入快照',
  derived: '派生帧',
  unknown: '未知来源'
};

const ORIGIN_KINDS: PacketOriginKind[] = ['sample', 'user-input', 'import', 'derived'];

type OriginInfo =
  | { status: 'known'; kind: PacketOriginKind; lineage: PacketLineage }
  | { status: 'unknown' };

/**
 * Normalizes the lineage of a packet. Responses from older API versions do
 * not carry lineage at all — those degrade to "unknown" instead of letting
 * the UI guess an origin from context.
 */
function originOf(packet: SimulatedPacket | null): OriginInfo {
  const lineage = packet?.lineage;
  if (!packet || !lineage || !ORIGIN_KINDS.includes(lineage.kind)) return { status: 'unknown' };
  return { status: 'known', kind: lineage.kind, lineage };
}

function nodeLabel(node: LineageNode): string {
  if (node.missing) return `已删除帧 ${node.id}`;
  switch (node.kind) {
    case 'sample': return `样例 ${node.sampleId ?? node.id}`;
    case 'import': return `导入 ${node.importedFrom ?? '未知文件'}`;
    case 'user-input': return '用户输入';
    case 'derived': return node.derivation === 'sanitized' ? '脱敏副本' : '编辑副本';
    default: return '未知来源';
  }
}

/** Origin chain for display, falling back to a single self node when the chain is absent. */
function chainOf(packet: SimulatedPacket, origin: Extract<OriginInfo, { status: 'known' }>): LineageNode[] {
  const chain = origin.lineage.chain;
  if (Array.isArray(chain) && chain.length) return chain;
  return [{
    id: packet.id,
    kind: origin.kind,
    ...(origin.lineage.sampleId ? { sampleId: origin.lineage.sampleId } : {}),
    ...(origin.lineage.importedFrom ? { importedFrom: origin.lineage.importedFrom } : {}),
    ...(origin.lineage.derivation ? { derivation: origin.lineage.derivation } : {})
  }];
}

/** Provenance block embedded into exported content. */
function provenanceOf(packet: SimulatedPacket) {
  const origin = originOf(packet);
  if (origin.status === 'unknown') return { kind: 'unknown', chain: [] as LineageNode[] };
  const { lineage } = origin;
  return {
    kind: origin.kind,
    contentHash: lineage.contentHash,
    ...(lineage.sampleId ? { sampleId: lineage.sampleId } : {}),
    ...(lineage.importedFrom ? { importedFrom: lineage.importedFrom } : {}),
    ...(lineage.parentId ? { parentId: lineage.parentId } : {}),
    ...(lineage.derivation ? { derivation: lineage.derivation } : {}),
    parentMissing: Boolean(lineage.parentMissing),
    chain: chainOf(packet, origin)
  };
}

function download(name: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [scenario, setScenario] = useState<PacketScenario>('request');
  const [rawInput, setRawInput] = useState('');
  const [packet, setPacket] = useState<SimulatedPacket | null>(null);
  const [session, setSession] = useState<SimulatedPacket[]>([]);
  const [inputOriginId, setInputOriginId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeView, setActiveView] = useState<'overview' | 'hex'>('overview');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${API_BASE}${path}`, init);
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`);
    return response.json() as Promise<T>;
  };

  const upsertSession = (frame: SimulatedPacket) => {
    setSession((current) => {
      const index = current.findIndex((item) => item.id === frame.id);
      if (index === -1) return [frame, ...current];
      const next = [...current];
      next[index] = frame;
      return next;
    });
  };

  /** Makes a frame the active one: inspector, input stream and session list. */
  const applyFrame = (frame: SimulatedPacket) => {
    setPacket(frame);
    setRawInput(frame.raw);
    setInputOriginId(frame.id);
    upsertSession(frame);
  };

  const loadSample = async (nextProtocol = protocol, nextScenario = scenario) => {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ data: SimulatedPacket }>(
        `/api/simulate?protocol=${nextProtocol}&scenario=${nextScenario}`
      );
      applyFrame(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载模拟数据失败');
    } finally {
      setLoading(false);
    }
  };

  const parsePacket = async () => {
    setLoading(true);
    setError('');
    setNotice('');
    const body: ParseRequest = {
      protocol,
      scenario,
      raw: rawInput,
      ...(inputOriginId ? { parentId: inputOriginId } : {})
    };
    try {
      const result = await request<PacketResponse>('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      applyFrame(result.data);
      if (result.reused) setNotice('原始内容未变化，返回已有帧，未创建新的派生关系。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  };

  const importFile = async (file: File) => {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const raw = await file.text();
      const body: ImportRequest = { protocol, scenario, raw, fileName: file.name };
      const result = await request<{ data: SimulatedPacket }>('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      applyFrame(result.data);
      setNotice(`已导入快照 ${file.name}。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导入文件失败');
    } finally {
      setLoading(false);
    }
  };

  const deriveSanitized = async (frame: SimulatedPacket) => {
    setError('');
    setNotice('');
    try {
      const result = await request<PacketResponse>(`/api/packets/${frame.id}/derive`, { method: 'POST' });
      applyFrame(result.data);
      setNotice(result.reused ? '已存在内容一致的帧，未创建新的派生帧。' : `已生成脱敏副本 ${result.data.id}。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '生成脱敏副本失败');
    }
  };

  const deleteFrame = async (id: string) => {
    setError('');
    setNotice('');
    try {
      const result = await request<DeletePacketResponse>(`/api/packets/${id}`, { method: 'DELETE' });
      const { deleted, affected } = result.data;
      setSession((current) => current
        .filter((item) => item.id !== deleted)
        .map((item) => affected.find((frame) => frame.id === item.id) ?? item)
      );
      const refreshed = affected.find((frame) => frame.id === packet?.id);
      if (refreshed) setPacket(refreshed);
      setNotice(affected.length
        ? `帧 ${deleted} 已删除，${affected.length} 个派生帧的来源链已断开。`
        : `帧 ${deleted} 已删除。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除帧失败');
    }
  };

  const exportFrame = (frame: SimulatedPacket) => {
    download(`packet-${frame.id}.json`, {
      tool: 'network-packet-lab',
      exportedAt: new Date().toISOString(),
      provenance: provenanceOf(frame),
      frame
    });
  };

  const exportSession = () => {
    download('packet-session.json', {
      tool: 'network-packet-lab',
      exportedAt: new Date().toISOString(),
      frames: session.map((frame) => ({ id: frame.id, provenance: provenanceOf(frame), frame }))
    });
  };

  useEffect(() => {
    void loadSample('HTTP', 'request');
  }, []);

  const changeProtocol = (nextProtocol: Protocol) => {
    const nextScenario = nextProtocol === 'TCP' && scenario === 'response' ? 'handshake' : scenario;
    setProtocol(nextProtocol);
    setScenario(nextScenario);
    void loadSample(nextProtocol, nextScenario);
  };

  const changeScenario = (nextScenario: PacketScenario) => {
    setScenario(nextScenario);
    void loadSample(protocol, nextScenario);
  };

  const clearInput = () => {
    setRawInput('');
    setInputOriginId(null);
  };

  const origin = originOf(packet);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /> <span /> <span /></div>
          <div>
            <p className="eyebrow">PROJECT 10 / PACKET OBSERVATORY</p>
            <h1>网络协议数据包可视化实验室</h1>
          </div>
        </div>
        <div className="connection-status"><i /> API ONLINE <span>localhost:3001</span></div>
      </header>

      <main className="dashboard">
        <section className="hero-copy">
          <div>
            <p className="section-kicker">解析工作台 · INSPECTOR</p>
            <h2>把每一个字节，<em>还原成可读的网络故事。</em></h2>
            <p className="hero-subtitle">选择协议和场景，载入模拟流量，逐层查看字段、时间线与十六进制原始数据。</p>
          </div>
          <div className="hero-stat"><strong>{packet?.metadata.length ?? '—'}</strong><span>BYTES<br />CURRENT FRAME</span></div>
        </section>

        <section className="control-panel panel">
          <div className="control-group">
            <label>协议 <span>PROTOCOL</span></label>
            <div className="segmented-control">
              {(['HTTP', 'TCP'] as Protocol[]).map((item) => (
                <button key={item} className={protocol === item ? 'active' : ''} onClick={() => changeProtocol(item)}>{item}</button>
              ))}
            </div>
          </div>
          <div className="control-group scenario-control">
            <label>模拟场景 <span>SCENARIO</span></label>
            <select value={scenario} onChange={(event) => changeScenario(event.target.value as PacketScenario)}>
              {availableScenarios.map((item) => <option key={item} value={item}>{scenarioLabels[item]}</option>)}
            </select>
          </div>
          <div className="control-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.log,.json,.http,text/plain,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFile(file);
                event.target.value = '';
              }}
            />
            <button className="button ghost" onClick={() => fileInputRef.current?.click()} disabled={loading}>⇪ 导入文件</button>
            <button className="button ghost" onClick={() => void loadSample()} disabled={loading}>↻ 载入模拟包</button>
            <button className="button primary" onClick={() => void parsePacket()} disabled={loading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          </div>
        </section>

        {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}
        {notice && <div className="notice-banner">ℹ {notice} <button onClick={() => setNotice('')}>关闭</button></div>}

        <section className="workspace-grid">
          <div className="left-column">
            <div className="panel packet-input-panel">
              <div className="panel-heading"><div><p className="section-kicker">01 / INPUT STREAM</p><h3>数据包输入</h3></div><span className="badge">{protocol}</span></div>
              <textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始数据包输入" />
              <div className="input-footer"><span>{rawInput.length} chars · editable payload</span><button onClick={clearInput}>清空输入</button></div>
            </div>
            <div className="panel session-panel">
              <div className="panel-heading">
                <div><p className="section-kicker">02 / CAPTURE SESSION</p><h3>捕获会话</h3></div>
                <button className="button ghost small" onClick={exportSession} disabled={!session.length}>导出会话</button>
              </div>
              {session.length === 0 ? <div className="empty-state">本会话还没有捕获任何帧。</div> : (
                <ul className="session-list">
                  {session.map((frame) => {
                    const frameOrigin = originOf(frame);
                    const broken = frameOrigin.status === 'known' &&
                      (frameOrigin.lineage.parentMissing || chainOf(frame, frameOrigin).some((node) => node.missing));
                    return (
                      <li key={frame.id} className={frame.id === packet?.id ? 'active' : ''}>
                        <button className="session-main" onClick={() => applyFrame(frame)}>
                          <span className="session-top">
                            <span className="badge">{frame.protocol}</span>
                            <OriginChip origin={frameOrigin} />
                            {broken && <span className="chip broken">⚠ 断链</span>}
                          </span>
                          <span className="session-summary">{frame.summary}</span>
                          <span className="session-meta">{frame.id} · {frame.metadata.capturedAt}</span>
                        </button>
                        <span className="session-actions">
                          <button onClick={() => void deriveSanitized(frame)} title="生成脱敏副本">脱敏</button>
                          <button className="danger" onClick={() => void deleteFrame(frame.id)} title="删除该帧">删除</button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="panel timeline-panel">
              <div className="panel-heading"><div><p className="section-kicker">03 / EVENT TRACE</p><h3>传输时间线</h3></div><span className="trace-id">{packet?.id ?? 'WAITING'}</span></div>
              <Timeline events={packet?.timeline ?? []} />
            </div>
          </div>

          <div className="right-column">
            <div className="panel packet-summary">
              <div className="summary-top"><div><p className="section-kicker">ACTIVE FRAME</p><h3>{packet?.summary ?? '等待数据包'}</h3></div><div className="live-chip"><i /> DECODED</div></div>
              <div className="metadata-grid">
                <Meta label="SOURCE" value={packet?.metadata.source ?? '—'} />
                <Meta label="DESTINATION" value={packet?.metadata.destination ?? '—'} />
                <Meta label="CAPTURED AT" value={packet?.metadata.capturedAt ?? '—'} />
                <Meta label="CHECKSUM" value={packet?.metadata.checksum ?? '—'} />
              </div>
              <div className="provenance">
                <div className="provenance-head">
                  <span>来源链 / PROVENANCE</span>
                  <span className="summary-actions">
                    <button className="button ghost small" onClick={() => packet && void deriveSanitized(packet)} disabled={!packet}>生成脱敏副本</button>
                    <button className="button ghost small" onClick={() => packet && exportFrame(packet)} disabled={!packet}>导出帧 JSON</button>
                  </span>
                </div>
                {!packet && <p className="lineage-unknown">等待数据包。</p>}
                {packet && origin.status === 'unknown' && (
                  <p className="lineage-unknown">未知来源 —— 该响应未携带来源元数据（可能来自旧版 API），客户端不做推测。</p>
                )}
                {packet && origin.status === 'known' && (
                  <Fragment>
                    <div className="origin-chain">
                      {chainOf(packet, origin).map((node, index, chain) => (
                        <Fragment key={`${node.id}-${index}`}>
                          {index > 0 && <span className="chain-arrow">→</span>}
                          <span className={`chain-node kind-${node.kind} ${node.missing ? 'missing' : ''} ${index === chain.length - 1 ? 'current' : ''}`}>
                            {node.missing ? '⚠ ' : ''}{nodeLabel(node)}
                          </span>
                        </Fragment>
                      ))}
                    </div>
                    {origin.lineage.parentMissing && <p className="lineage-warning">⚠ 父帧已被删除，来源链在此断开。</p>}
                    <p className="lineage-hash">content {origin.lineage.contentHash}</p>
                  </Fragment>
                )}
              </div>
            </div>

            <div className="panel details-panel">
              <div className="tabs"><button className={activeView === 'overview' ? 'selected' : ''} onClick={() => setActiveView('overview')}>协议字段树</button><button className={activeView === 'hex' ? 'selected' : ''} onClick={() => setActiveView('hex')}>十六进制视图</button></div>
              {activeView === 'overview' ? <FieldTree fields={packet?.fields ?? []} /> : <HexView rows={packet?.hex ?? []} />}
            </div>
          </div>
        </section>
      </main>
      <footer className="footer"><span>PACKET LAB / EDUCATIONAL SIMULATOR</span><span>React + Vite + TypeScript · Express API</span></footer>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="meta-item"><span>{label}</span><strong>{value}</strong></div>;
}

function OriginChip({ origin }: { origin: OriginInfo }) {
  const kind = origin.status === 'known' ? origin.kind : 'unknown';
  return <span className={`origin-chip kind-${kind}`}>{originLabels[kind]}</span>;
}

function FieldTree({ fields }: { fields: ProtocolField[] }) {
  if (!fields.length) return <div className="empty-state">解析后将在这里显示协议层级字段。</div>;
  return <div className="field-tree">{fields.map((field) => <FieldNode key={field.id} field={field} depth={0} />)}</div>;
}

function FieldNode({ field, depth }: { field: ProtocolField; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = Boolean(field.children?.length);
  return <div className="field-node" style={{ '--depth': depth } as CSSProperties}>
    <div className="field-row" onClick={() => hasChildren && setExpanded((value) => !value)}>
      <span className={`chevron ${hasChildren ? '' : 'invisible'} ${expanded ? 'open' : ''}`}>⌄</span>
      <span className="field-key">{field.key}</span>
      <span className="field-value">{field.value}</span>
      <span className="field-description">{field.description}</span>
    </div>
    {hasChildren && expanded && <div className="field-children">{field.children!.map((child) => <FieldNode key={child.id} field={child} depth={depth + 1} />)}</div>}
  </div>;
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <div className="empty-state">还没有事件记录。</div>;
  return <div className="timeline">{events.map((event, index) => <div className="timeline-event" key={event.id}><div className="timeline-marker"><span>{String(index + 1).padStart(2, '0')}</span></div><div className="timeline-content"><div><strong>{event.label}</strong><time>{event.timestamp}</time></div><p>{event.detail}</p><span className={`phase phase-${event.phase}`}>{event.phase}</span></div></div>)}</div>;
}

function HexView({ rows }: { rows: SimulatedPacket['hex'] }) {
  if (!rows.length) return <div className="empty-state">没有可显示的十六进制内容。</div>;
  return <div className="hex-view"><div className="hex-header"><span>OFFSET</span><span>HEX BYTES</span><span>ASCII</span></div>{rows.map((row) => <div className="hex-row" key={row.offset}><code>{row.offset}</code><code>{row.bytes.join(' ')}</code><code className="ascii">{row.ascii}</code></div>)}</div>;
}

export default App;
