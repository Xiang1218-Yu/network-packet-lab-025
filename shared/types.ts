export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';

/**
 * How a frame entered the system:
 * - `sample`     — built-in simulated sample served by /api/simulate or /api/packets
 * - `user-input` — raw text typed or pasted by the user and sent to /api/parse
 * - `import`     — snapshot imported from a local file via /api/import
 * - `derived`    — created from another frame (edited re-parse or sanitized copy)
 */
export type PacketOriginKind = 'sample' | 'user-input' | 'import' | 'derived';

/**
 * One hop of a resolved origin chain. `kind` is `unknown` and `missing` is set
 * when the referenced frame has been deleted and can no longer be inspected.
 */
export interface LineageNode {
  id: string;
  kind: PacketOriginKind | 'unknown';
  sampleId?: string;
  importedFrom?: string;
  derivation?: string;
  missing?: boolean;
}

/**
 * Provenance attached to every packet the server emits. `parentMissing` and
 * `chain` are resolved at read time, so they reflect deletions immediately.
 */
export interface PacketLineage {
  kind: PacketOriginKind;
  /** Fingerprint of the raw bytes; identical re-parses share this hash. */
  contentHash: string;
  /** kind === 'sample': stable identifier of the built-in sample, e.g. "HTTP/request". */
  sampleId?: string;
  /** kind === 'import': name of the file this snapshot was imported from. */
  importedFrom?: string;
  /** kind === 'derived': id of the parent frame. */
  parentId?: string;
  /** kind === 'derived': how the frame was derived, e.g. "edited" or "sanitized". */
  derivation?: string;
  /** True when parentId references a frame that no longer exists. */
  parentMissing?: boolean;
  /** Resolved origin chain from the root frame down to (and including) this frame. */
  chain?: LineageNode[];
}

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
  /**
   * Provenance of this frame. Optional because older API responses do not
   * carry it — clients must treat a missing lineage as "unknown origin"
   * instead of guessing from which endpoint served the packet.
   */
  lineage?: PacketLineage;
}

export interface ParseRequest {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
  /**
   * Id of the frame the raw text was loaded from, when any. The server uses
   * it to link genuine edits to their parent — and to avoid fabricating a
   * parent-child relation when the raw content is unchanged.
   */
  parentId?: string;
}

export interface ImportRequest {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
  fileName?: string;
}

/** Response of POST /api/parse and the derive endpoint. */
export interface PacketResponse {
  data: SimulatedPacket;
  /** True when the server returned an existing frame instead of creating one. */
  reused?: boolean;
}

/** Response of DELETE /api/packets/:id. */
export interface DeletePacketResponse {
  data: {
    deleted: string;
    /** Frames whose origin chain referenced the deleted id, re-serialized. */
    affected: SimulatedPacket[];
  };
}
