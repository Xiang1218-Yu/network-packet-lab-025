import { Fragment, useEffect, useMemo, useState, type ChangeEvent, type CSSProperties } from 'react';
import type {
  PacketOrigin,
  PacketOriginKind,
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  ResolvedOrigin,
  SimulatedPacket,
  TimelineEvent
} from '../../shared/types';

const API_BASE = import.meta.env?.VITE_API_BASE ?? 'http://localhost:3001';

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

const ORIGIN_KINDS: PacketOriginKind[] = ['sample', 'user-input', 'import', 'derived'];

const originLabels: Record<ResolvedOrigin['kind'], string> = {
  sample: '内置样例',
  'user-input': '用户输入',
  import: '导入快照',
  derived: '派生帧',
  unknown: '来源未知'
};

/** 会话中的一帧：服务端报文 + 客户端规范化后的来源视图。 */
interface SessionFrame {
  packet: SimulatedPacket;
  origin: ResolvedOrigin;
}

interface LineageStep {
  id: string;
  summary?: string;
  originKind?: ResolvedOrigin['kind'];
  missing?: boolean;
  deleted?: boolean;
}

/**
 * 规范化服务端返回的 origin。旧版 API 响应缺少该字段、kind 无法识别、
 * 或 derived 帧缺少 parentId 时，一律降级为 unknown，绝不猜测来源。
 */
export function normalizeOrigin(value: unknown): ResolvedOrigin {
  if (!value || typeof value !== 'object') return { kind: 'unknown' };
  const candidate = value as Partial<PacketOrigin>;
  if (!candidate.kind || !ORIGIN_KINDS.includes(candidate.kind as PacketOriginKind)) return { kind: 'unknown' };
  if (candidate.kind === 'derived' && typeof candidate.parentId !== 'string') return { kind: 'unknown' };
  return {
    kind: candidate.kind as PacketOriginKind,
    ...(typeof candidate.sampleId === 'string' ? { sampleId: candidate.sampleId } : {}),
    ...(typeof candidate.parentId === 'string' ? { parentId: candidate.parentId } : {}),
    ...(typeof candidate.importedFrom === 'string' ? { importedFrom: candidate.importedFrom } : {}),
    recordedAt: typeof candidate.recordedAt === 'string' ? candidate.recordedAt : ''
  };
}

/** 沿 parentId 向上解析血缘链（根在前）。父帧不在会话中时标记 missing / deleted（断链）。 */
export function resolveLineage(frame: SessionFrame, frames: SessionFrame[], tombstones: Set<string>): LineageStep[] {
  const byId = new Map(frames.map((item) => [item.packet.id, item]));
  const steps: LineageStep[] = [];
  const seen = new Set<string>([frame.packet.id]);
  let current = frame;
  while (current.origin.kind !== 'unknown' && current.origin.parentId) {
    const parentId = current.origin.parentId;
    const parent = byId.get(parentId);
    if (!parent) {
      steps.push({ id: parentId, missing: true, deleted: tombstones.has(parentId) });
      break;
    }
    steps.push({ id: parent.packet.id, summary: parent.packet.summary, originKind: parent.origin.kind });
    if (seen.has(parent.packet.id)) break;
    seen.add(parent.packet.id);
    current = parent;
  }
  return steps.reverse();
}

function originDetail(origin: ResolvedOrigin): string {
  switch (origin.kind) {
    case 'sample': return `内置样例 · ${origin.sampleId ?? '未知样例'} · 记录于 ${origin.recordedAt || '—'}`;
    case 'user-input': return `用户手工输入 · 记录于 ${origin.recordedAt || '—'}`;
    case 'import': return `导入快照 · 来自文件 ${origin.importedFrom ?? '未知'} · 记录于 ${origin.recordedAt || '—'}`;
    case 'derived': return `派生帧 · 父帧 ${origin.parentId} · 记录于 ${origin.recordedAt || '—'}`;
    default: return '旧版 API 响应未提供来源字段，已按未知状态降级，不做来源猜测';
  }
}

function App() {
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [scenario, setScenario] = useState<PacketScenario>('request');
  const [rawInput, setRawInput] = useState('');
  const [frames, setFrames] = useState<SessionFrame[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tombstones, setTombstones] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<'overview' | 'hex'>('overview');

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const activeFrame = frames.find((frame) => frame.packet.id === activeId) ?? null;
  const packet = activeFrame?.packet ?? null;
  const activeOrigin: ResolvedOrigin = activeFrame?.origin ?? { kind: 'unknown' };
  const activeLineage = useMemo(
    () => (activeFrame ? resolveLineage(activeFrame, frames, tombstones) : []),
    [activeFrame, frames, tombstones]
  );

  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${API_BASE}${path}`, init);
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`);
    return response.json() as Promise<{ data: SimulatedPacket }>;
  };

  const ingestPacket = (next: SimulatedPacket) => {
    setFrames((previous) => [...previous, { packet: next, origin: normalizeOrigin(next.origin) }]);
    setActiveId(next.id);
    setRawInput(next.raw);
  };

  const loadSample = async (nextProtocol = protocol, nextScenario = scenario) => {
    setLoading(true);
    setError('');
    try {
      const result = await request(
        `/api/simulate?protocol=${nextProtocol}&scenario=${nextScenario}`
      );
      ingestPacket(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载模拟数据失败');
    } finally {
      setLoading(false);
    }
  };

  const parsePacket = async () => {
    setLoading(true);
    setError('');
    // 把当前帧 id 交给服务端：只有 raw 相对父帧有实际变化时才会形成派生关系，
    // 原样重新解析不会制造虚假的父子关系。
    const body: ParseRequest = { protocol, scenario, raw: rawInput, ...(packet ? { parentId: packet.id } : {}) };
    try {
      const result = await request('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      ingestPacket(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  };

  const removeFrame = (id: string) => {
    const remaining = frames.filter((frame) => frame.packet.id !== id);
    setFrames(remaining);
    setTombstones((previous) => new Set(previous).add(id));
    if (activeId === id) setActiveId(remaining.length ? remaining[remaining.length - 1].packet.id : null);
  };

  const selectFrame = (frame: SessionFrame) => {
    setActiveId(frame.packet.id);
    setRawInput(frame.packet.raw);
  };

  const importFrames = async (file: File) => {
    setError('');
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const list = Array.isArray(parsed) ? parsed : (parsed as { frames?: unknown[] } | null)?.frames;
      if (!Array.isArray(list) || !list.length) throw new Error('文件中没有可导入的数据帧');
      const packets = list.filter(
        (item): item is SimulatedPacket =>
          Boolean(item) && typeof (item as SimulatedPacket).id === 'string' && typeof (item as SimulatedPacket).raw === 'string'
      );
      if (!packets.length) throw new Error('文件格式不正确：帧缺少 id / raw 字段');
      // 与现有会话撞 id 时重新分配，并同步改写同批导入帧的 parentId 引用
      const existingIds = new Set(frames.map((frame) => frame.packet.id));
      const idMap = new Map<string, string>();
      for (const item of packets) {
        if (!existingIds.has(item.id)) { existingIds.add(item.id); continue; }
        let suffix = 2;
        let nextId = `${item.id}-imp${suffix}`;
        while (existingIds.has(nextId)) nextId = `${item.id}-imp${++suffix}`;
        idMap.set(item.id, nextId);
        existingIds.add(nextId);
      }
      const recordedAt = new Date().toISOString();
      const imported: SessionFrame[] = packets.map((item) => {
        const prior = normalizeOrigin(item.origin);
        const priorParent = prior.kind !== 'unknown' ? prior.parentId : undefined;
        const origin: PacketOrigin = {
          kind: 'import',
          importedFrom: file.name,
          recordedAt,
          ...(priorParent ? { parentId: idMap.get(priorParent) ?? priorParent } : {})
        };
        return { packet: { ...item, id: idMap.get(item.id) ?? item.id }, origin };
      });
      setFrames((previous) => [...previous, ...imported]);
      setActiveId(imported[imported.length - 1].packet.id);
      setRawInput(imported[imported.length - 1].packet.raw);
    } catch (cause) {
      setError(cause instanceof Error ? `导入快照失败：${cause.message}` : '导入快照失败');
    }
  };

  const handleImportFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void importFrames(file);
  };

  const exportSession = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      frameCount: frames.length,
      frames: frames.map((frame) => ({
        ...frame.packet,
        origin: frame.origin,
        lineage: resolveLineage(frame, frames, tombstones).map((step) =>
          step.missing
            ? { id: step.id, missing: true, note: step.deleted ? '父帧已在会话中删除（断链）' : '父帧不在当前会话（断链）' }
            : { id: step.id, summary: step.summary, originKind: step.originKind }
        )
      }))
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `packet-lab-session-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
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
            <button className="button ghost" onClick={() => void loadSample()} disabled={loading}>↻ 载入模拟包</button>
            <button className="button primary" onClick={() => void parsePacket()} disabled={loading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          </div>
        </section>

        {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}

        <section className="panel session-panel">
          <div className="panel-heading">
            <div><p className="section-kicker">CAPTURE SESSION</p><h3>捕获会话 · 来源链</h3></div>
            <div className="session-actions">
              <span className="badge">{frames.length} 帧</span>
              <label className="button ghost session-import">
                ⇪ 导入快照
                <input type="file" accept="application/json,.json" hidden onChange={handleImportFile} />
              </label>
              <button className="button ghost" onClick={exportSession} disabled={!frames.length}>⇓ 导出会话</button>
            </div>
          </div>
          {frames.length === 0 ? (
            <div className="empty-state">还没有帧。载入样例或解析数据包后会出现在这里。</div>
          ) : (
            <div className="session-list">
              {frames.map((frame) => {
                const broken = resolveLineage(frame, frames, tombstones).find((step) => step.missing);
                const parentId = frame.origin.kind !== 'unknown' ? frame.origin.parentId : undefined;
                return (
                  <div key={frame.packet.id} className={`session-item ${frame.packet.id === activeId ? 'active' : ''}`}>
                    <button className="session-select" onClick={() => selectFrame(frame)}>
                      <OriginBadge origin={frame.origin} />
                      <span className="session-summary">{frame.packet.summary}</span>
                      <span className="session-meta">
                        <span>{frame.packet.id}</span>
                        {parentId && (
                          broken
                            ? <em className="link-broken">⚠ 父帧{broken.deleted ? '已删除' : '不在会话'} · 断链</em>
                            : <em className="link-ok">↳ 父帧 {parentId}</em>
                        )}
                      </span>
                    </button>
                    <button className="session-delete" onClick={() => removeFrame(frame.packet.id)} title="从会话中删除该帧">✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="workspace-grid">
          <div className="left-column">
            <div className="panel packet-input-panel">
              <div className="panel-heading"><div><p className="section-kicker">01 / INPUT STREAM</p><h3>数据包输入</h3></div><span className="badge">{protocol}</span></div>
              <textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始数据包输入" />
              <div className="input-footer"><span>{rawInput.length} chars · editable payload</span><button onClick={() => setRawInput('')}>清空输入</button></div>
            </div>
            <div className="panel timeline-panel">
              <div className="panel-heading"><div><p className="section-kicker">02 / EVENT TRACE</p><h3>传输时间线</h3></div><span className="trace-id">{packet?.id ?? 'WAITING'}</span></div>
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
              <div className="provenance-block">
                <div className="provenance-head">
                  <span className="provenance-label">FRAME ORIGIN / 帧来源</span>
                  {activeFrame && <OriginBadge origin={activeOrigin} />}
                </div>
                <p className="provenance-detail">{activeFrame ? originDetail(activeOrigin) : '等待数据包'}</p>
                {activeFrame && activeOrigin.kind !== 'unknown' && (
                  <div className="lineage-chain">
                    {activeLineage.length === 0 && <span className="lineage-root">会话起点 · 无父帧</span>}
                    {activeLineage.map((step) => (
                      <Fragment key={step.id}>
                        <span className={`lineage-node ${step.missing ? 'broken' : ''}`}>
                          {step.missing ? `⚠ ${step.id}（${step.deleted ? '已删除' : '不在会话'}）` : (step.summary ?? step.id)}
                        </span>
                        <span className="lineage-arrow">→</span>
                      </Fragment>
                    ))}
                    <span className="lineage-node current">当前帧</span>
                  </div>
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

function OriginBadge({ origin }: { origin: ResolvedOrigin }) {
  return <span className={`origin-badge origin-${origin.kind}`}>{originLabels[origin.kind]}</span>;
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
