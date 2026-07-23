// src/runtime/store/memory-store.ts
//
// MemoryStore — the EPHEMERAL `Store` driver. Same interface as SqliteStore,
// no disk. Tests and spikes that are not about durability use this so they
// neither touch the filesystem nor depend on `node:sqlite` being available.
//
// It is a real implementation of the seam, not a stub: swapping it for
// SqliteStore must change nothing above the interface, which is exactly the
// property spike:f105 leans on when it runs the same turns against both.
//
// THE KEYING INVARIANT, again (contract §6, SPIKE-07): the maps below are keyed
// by SESSION ID and nothing else. There is deliberately no provider or engine
// dimension in this structure — that is the property SPIKE-07 checks, and it is
// why two different engines operating on one session id read and write the same
// state.

import { decideMemoryWrite } from '../memory-gate.js';
import { decideHarnessImport } from '../harness-gate.js';
import { buildHarnessSet, mergeHarnessSet } from './harness-set.js';
import type { RuntimeMessage } from '../engine.js';
import type {
  GoldenConsent,
  GoldenItem,
  GoldenItemInput,
  HarnessImportRequest,
  HarnessItem,
  HarnessKind,
  HarnessRemoveSelector,
  HarnessScope,
  HarnessSet,
  HarnessStatus,
  MemoryDeleteSelector,
  MemoryItem,
  MemoryScope,
  MemoryStatus,
  MemoryWriteRequest,
  McpEntry,
  Project,
  SessionRef,
  Store,
  TrustTier,
  UsageRecord,
} from './store.js';

type SessionState = {
  ref: SessionRef;
  messages: RuntimeMessage[];
  usage: UsageRecord[];
};

let counter = 0;
function mintSessionId(): string {
  counter += 1;
  return `s-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

let memCounter = 0;
function mintMemoryId(): string {
  memCounter += 1;
  return `m-${Date.now().toString(36)}-${memCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

let goldenCounter = 0;
function mintGoldenId(): string {
  goldenCounter += 1;
  return `g-${Date.now().toString(36)}-${goldenCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

let harnessCounter = 0;
function mintHarnessId(): string {
  harnessCounter += 1;
  return `h-${Date.now().toString(36)}-${harnessCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function cloneMemory(item: MemoryItem): MemoryItem {
  return { ...item, provenance: { ...item.provenance } };
}

function cloneGolden(item: GoldenItem): GoldenItem {
  return { ...item };
}

/** Deep-ish clone of a harness item so stored state never aliases a caller's
 * object (matches SqliteStore, which always returns fresh rows). */
function cloneHarness(item: HarnessItem): HarnessItem {
  const out: HarnessItem = {
    ...item,
    provenance: { ...item.provenance },
  };
  if (item.command) out.command = { ...item.command };
  if (item.skill)
    out.skill = {
      ...item.skill,
      ...(item.skill.triggers ? { triggers: [...item.skill.triggers] } : {}),
      ...(item.skill.toolRefs ? { toolRefs: [...item.skill.toolRefs] } : {}),
    };
  if (item.subagent)
    out.subagent = {
      ...item.subagent,
      ...(item.subagent.toolRefs ? { toolRefs: [...item.subagent.toolRefs] } : {}),
    };
  return out;
}

export class MemoryStore implements Store {
  private readonly sessions = new Map<string, SessionState>();
  private readonly mcp = new Map<string, McpEntry>();
  private readonly settings = new Map<string, string>();
  // Projects, keyed by cwd — a SEPARATE key space from sessions. The session↔
  // project relationship lives as SessionRef.cwd (a LINK, never a key for
  // session state), exactly as in SqliteStore.
  private readonly projects = new Map<string, Project>();
  // Scoped memory (Phase 1.5), keyed by its own id — a STORE-LEVEL collection,
  // NOT per-session: user/project/org memory outlives any one session, so it
  // cannot live inside a SessionState. The session-scoped subset is addressed
  // by (scope='session', scopeKey=sessionId). This is what makes the cascade
  // EXEMPTION expressible: dropping a SessionState no longer drops its memory,
  // deleteSession/removeProject delete only the session/project-scoped rows.
  private readonly memoryItems = new Map<string, MemoryItem>();
  // Golden set (Phase 1.5 P15-04), keyed by its own id — a STORE-LEVEL
  // collection, DELIBERATELY separate from memoryItems: no injection/extraction
  // path reads it, which is what makes the excluded-from-learning invariant
  // structural, exactly as the golden_items table is separate in SqliteStore.
  private readonly goldenItems = new Map<string, GoldenItem>();
  // Owned harness (Phase 1.6 HP-01), keyed by its own id — a STORE-LEVEL
  // collection (never per-session): harness has no session scope and user/org
  // harness outlives any session, so it cannot live in a SessionState. This is
  // what makes the cascade EXEMPTION expressible — deleteSession never touches
  // it, removeProject drops only scope='project' rows for the cwd.
  private readonly harnessItems = new Map<string, HarnessItem>();
  private closed = false;

  /** Get (creating if absent) the state for a session. The same object identity
   * is returned across calls, so two different engines operating on one session
   * id share the exact same arrays/records. */
  private state(sessionId: string, providerId = ''): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      const now = Date.now();
      s = {
        ref: { sessionId, providerId, createdAt: now, lastUsedAt: now },
        messages: [],
        usage: [],
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  // -- sessions ------------------------------------------------------------

  createSession(providerId: string, title?: string, cwd?: string): SessionRef {
    const sessionId = mintSessionId();
    const s = this.state(sessionId, providerId);
    if (title !== undefined) s.ref.title = title;
    // cwd is the owning-project LINK, not a key: it does not change how
    // messages/memory/usage are stored (still under this session id only).
    if (cwd !== undefined) s.ref.cwd = cwd;
    return { ...s.ref };
  }

  getSession(sessionId: string): SessionRef | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.ref } : undefined;
  }

  listSessions(): SessionRef[] {
    return [...this.sessions.values()]
      .map((s) => ({ ...s.ref }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  touchSession(sessionId: string, providerId?: string): SessionRef {
    const s = this.state(sessionId, providerId ?? '');
    s.ref.lastUsedAt = Date.now();
    // Only overwritten when a new one is supplied: it records the LAST provider
    // that answered and is never a constraint on the session.
    if (providerId !== undefined) s.ref.providerId = providerId;
    return { ...s.ref };
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    // CASCADE EXEMPTION (phase-1_5-memory-contracts §2/§6): remove ONLY this
    // session's scope='session' memory. user/project/org rows have no session
    // owner and MUST survive a session delete.
    for (const [id, item] of this.memoryItems) {
      if (item.scope === 'session' && item.scopeKey === sessionId) {
        this.memoryItems.delete(id);
      }
    }
    // HARNESS CASCADE EXEMPTION (phase-1_6-harness-contracts §2/§6): a session
    // delete NEVER touches harness. Harness has no session scope, so there is
    // deliberately no harnessItems removal here.
  }

  // -- messages ------------------------------------------------------------

  appendMessage(sessionId: string, msg: RuntimeMessage): void {
    this.state(sessionId).messages.push(msg);
  }

  getMessages(sessionId: string): RuntimeMessage[] {
    return [...this.state(sessionId).messages];
  }

  // -- memory --------------------------------------------------------------

  // Legacy session-scoped API — now the scope='session' view of memoryItems,
  // exactly as in SqliteStore (a working/user/confirmed row, confidence 1). The
  // two drivers must stay observationally identical (spike:f105 / SPIKE-07).

  setMemory(sessionId: string, key: string, value: string): void {
    this.state(sessionId); // ensure the session exists, as before
    this.writeMemoryItem({
      scope: 'session',
      scopeKey: sessionId,
      type: 'working',
      key,
      value,
      provenance: { source: 'user', sessionId },
      confidence: 1,
      status: 'confirmed',
    });
  }

  getMemory(sessionId: string, key: string): string | undefined {
    return this.findMemoryRow('session', sessionId, key)?.value;
  }

  getAllMemory(sessionId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const item of this.memoryItems.values()) {
      if (item.scope === 'session' && item.scopeKey === sessionId) {
        out[item.key] = item.value;
      }
    }
    return out;
  }

  // -- scoped memory (Phase 1.5) -------------------------------------------

  private findMemoryRow(
    scope: MemoryScope,
    scopeKey: string,
    key: string,
  ): MemoryItem | undefined {
    for (const item of this.memoryItems.values()) {
      if (item.scope === scope && item.scopeKey === scopeKey && item.key === key) {
        return item;
      }
    }
    return undefined;
  }

  /** Shared upsert by (scope, scopeKey, key). Preserves id/createdAt on update,
   * bumps updatedAt. Stores a defensively-cloned item and returns a clone. */
  private writeMemoryItem(fields: {
    scope: MemoryScope;
    scopeKey: string;
    type: MemoryItem['type'];
    key: string;
    value: string;
    provenance: MemoryItem['provenance'];
    confidence: number;
    status: MemoryStatus;
  }): MemoryItem {
    const now = Date.now();
    const existing = this.findMemoryRow(fields.scope, fields.scopeKey, fields.key);
    const item: MemoryItem = {
      id: existing ? existing.id : mintMemoryId(),
      scope: fields.scope,
      scopeKey: fields.scopeKey,
      type: fields.type,
      key: fields.key,
      value: fields.value,
      provenance: { ...fields.provenance },
      confidence: fields.confidence,
      status: fields.status,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    this.memoryItems.set(item.id, item);
    return cloneMemory(item);
  }

  putMemory(req: MemoryWriteRequest): MemoryItem {
    const existing = this.findMemoryRow(req.scope, req.scopeKey, req.key);
    const decision = decideMemoryWrite(req, existing);
    if (decision.behavior === 'deny') {
      throw new Error(`memory write denied: ${decision.reason}`);
    }
    return this.writeMemoryItem({
      scope: req.scope,
      scopeKey: req.scopeKey,
      type: req.type,
      key: req.key,
      value: req.value,
      provenance: req.provenance,
      confidence: req.confidence,
      status: decision.status,
    });
  }

  getScopedMemory(
    scope: MemoryScope,
    scopeKey: string,
    opts?: { status?: MemoryStatus },
  ): MemoryItem[] {
    const out: MemoryItem[] = [];
    for (const item of this.memoryItems.values()) {
      if (item.scope !== scope || item.scopeKey !== scopeKey) continue;
      if (opts?.status && item.status !== opts.status) continue;
      out.push(cloneMemory(item));
    }
    // Relevance-agnostic (createdAt asc), as SqliteStore; ranking is the
    // injection step's job, not the store's.
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  confirmMemory(id: string): void {
    const item = this.memoryItems.get(id);
    if (!item || item.status === 'confirmed') return;
    item.status = 'confirmed';
    item.updatedAt = Date.now();
  }

  deleteMemory(sel: MemoryDeleteSelector): void {
    if ('id' in sel) {
      this.memoryItems.delete(sel.id);
      return;
    }
    const source: TrustTier = sel.source;
    for (const [id, item] of this.memoryItems) {
      if (item.provenance.source !== source) continue;
      if (sel.sessionId !== undefined && item.provenance.sessionId !== sel.sessionId)
        continue;
      this.memoryItems.delete(id);
    }
  }

  // -- golden set (Phase 1.5 P15-04) ---------------------------------------
  //
  // Same semantics as SqliteStore's golden_items ops, so the two drivers stay
  // observationally identical (the property spike:f105 / spike:golden lean on).

  addGoldenItem(item: GoldenItemInput): GoldenItem {
    const now = Date.now();
    const stored: GoldenItem = {
      id: mintGoldenId(),
      scopeKey: item.scopeKey,
      taskType: item.taskType,
      input: item.input,
      expected: item.expected,
      // ALWAYS true — the invariant. GoldenItemInput has no such field, so the
      // caller cannot express false; it is stamped here.
      excludedFromLearning: true,
      consent: item.consent ?? 'pending',
      createdAt: now,
      lastScoredAt: null, // Phase 2b reserves it
    };
    this.goldenItems.set(stored.id, stored);
    return cloneGolden(stored);
  }

  listGoldenSet(scopeKey: string, opts?: { consent?: GoldenConsent }): GoldenItem[] {
    const out: GoldenItem[] = [];
    for (const item of this.goldenItems.values()) {
      if (item.scopeKey !== scopeKey) continue;
      if (opts?.consent && item.consent !== opts.consent) continue;
      out.push(cloneGolden(item));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  getGoldenItem(id: string): GoldenItem | undefined {
    const item = this.goldenItems.get(id);
    return item ? cloneGolden(item) : undefined;
  }

  setGoldenConsent(id: string, consent: GoldenConsent): void {
    const item = this.goldenItems.get(id);
    if (!item) return; // no-op if absent
    item.consent = consent;
  }

  removeGoldenItem(id: string): void {
    this.goldenItems.delete(id);
  }

  // -- owned harness (Phase 1.6 HP-01) -------------------------------------
  //
  // Same semantics as SqliteStore's harness_items ops, so the two drivers stay
  // observationally identical.

  private findHarnessRow(
    scope: HarnessScope,
    scopeKey: string,
    kind: HarnessKind,
    name: string,
  ): HarnessItem | undefined {
    for (const item of this.harnessItems.values()) {
      if (
        item.scope === scope &&
        item.scopeKey === scopeKey &&
        item.kind === kind &&
        item.name === name
      ) {
        return item;
      }
    }
    return undefined;
  }

  /** Shared upsert by (scope, scopeKey, kind, name). Preserves id/createdAt on
   * update, bumps updatedAt. Stores a defensively-cloned item; returns a clone. */
  private writeHarnessItem(fields: {
    scope: HarnessScope;
    scopeKey: string;
    kind: HarnessKind;
    name: string;
    description?: string;
    status: HarnessStatus;
    provenance: HarnessItem['provenance'];
    command?: HarnessItem['command'];
    skill?: HarnessItem['skill'];
    subagent?: HarnessItem['subagent'];
  }): HarnessItem {
    const now = Date.now();
    const existing = this.findHarnessRow(
      fields.scope,
      fields.scopeKey,
      fields.kind,
      fields.name,
    );
    const item: HarnessItem = {
      id: existing ? existing.id : mintHarnessId(),
      scope: fields.scope,
      scopeKey: fields.scopeKey,
      kind: fields.kind,
      name: fields.name,
      status: fields.status,
      provenance: { ...fields.provenance },
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    if (fields.description !== undefined) item.description = fields.description;
    if (fields.command !== undefined) item.command = fields.command;
    if (fields.skill !== undefined) item.skill = fields.skill;
    if (fields.subagent !== undefined) item.subagent = fields.subagent;
    const stored = cloneHarness(item);
    this.harnessItems.set(stored.id, stored);
    return cloneHarness(stored);
  }

  putHarnessItem(req: HarnessImportRequest): HarnessItem {
    const existing = this.findHarnessRow(
      req.item.scope,
      req.item.scopeKey,
      req.item.kind,
      req.item.name,
    );
    const decision = decideHarnessImport(req, existing);
    if (decision.behavior === 'deny') {
      throw new Error(`harness import denied: ${decision.reason}`);
    }
    return this.writeHarnessItem({
      scope: req.item.scope,
      scopeKey: req.item.scopeKey,
      kind: req.item.kind,
      name: req.item.name,
      ...(req.item.description !== undefined ? { description: req.item.description } : {}),
      status: decision.status,
      provenance: req.item.provenance,
      ...(req.item.command !== undefined ? { command: req.item.command } : {}),
      ...(req.item.skill !== undefined ? { skill: req.item.skill } : {}),
      ...(req.item.subagent !== undefined ? { subagent: req.item.subagent } : {}),
    });
  }

  listHarness(
    scope: HarnessScope,
    scopeKey: string,
    opts?: { kind?: HarnessKind; status?: HarnessStatus },
  ): HarnessItem[] {
    const out: HarnessItem[] = [];
    for (const item of this.harnessItems.values()) {
      if (item.scope !== scope || item.scopeKey !== scopeKey) continue;
      if (opts?.kind && item.kind !== opts.kind) continue;
      if (opts?.status && item.status !== opts.status) continue;
      out.push(cloneHarness(item));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  getHarnessItem(id: string): HarnessItem | undefined {
    const item = this.harnessItems.get(id);
    return item ? cloneHarness(item) : undefined;
  }

  setHarnessEnabled(id: string, enabled: boolean): void {
    const item = this.harnessItems.get(id);
    if (!item) return; // no-op if absent
    // The ONLY path an imported (external) item becomes enabled (§4 invariant 1).
    item.status = enabled ? 'enabled' : 'disabled';
    item.updatedAt = Date.now();
  }

  removeHarness(sel: HarnessRemoveSelector): void {
    if ('id' in sel) {
      this.harnessItems.delete(sel.id);
      return;
    }
    // delete-by-origin: roll back a whole imported set.
    for (const [id, item] of this.harnessItems) {
      if (item.provenance.origin === sel.origin) this.harnessItems.delete(id);
    }
  }

  exportHarnessSet(
    scope: HarnessScope,
    scopeKey: string,
    opts?: { name: string; version: string; ids?: string[] },
  ): HarnessSet {
    let items = this.listHarness(scope, scopeKey, { status: 'enabled' });
    if (opts?.ids) {
      const wanted = new Set(opts.ids);
      items = items.filter((it) => wanted.has(it.id));
    }
    return buildHarnessSet(items, opts);
  }

  importHarnessSet(
    set: HarnessSet,
    into: { scope: HarnessScope; scopeKey: string },
    opts?: { ids?: string[] },
  ): HarnessItem[] {
    return mergeHarnessSet(set, into, opts, {
      find: (s, k, kind, name) => this.findHarnessRow(s, k, kind, name),
      put: (req) => this.putHarnessItem(req),
    });
  }

  // -- usage (F1-07) -------------------------------------------------------

  appendUsage(sessionId: string, record: UsageRecord): void {
    this.state(sessionId).usage.push(record);
  }

  listUsage(sessionId: string): UsageRecord[] {
    return [...this.state(sessionId).usage];
  }

  // -- app settings (F1-08) ------------------------------------------------

  getSetting(key: string): string | undefined {
    return this.settings.get(key);
  }

  setSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }

  listSettings(): Record<string, string> {
    return Object.fromEntries(this.settings);
  }

  // -- MCP registry --------------------------------------------------------

  listMcpEntries(): McpEntry[] {
    return [...this.mcp.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  upsertMcpEntry(entry: McpEntry): void {
    this.mcp.set(entry.name, entry);
  }

  removeMcpEntry(name: string): void {
    this.mcp.delete(name);
  }

  // -- projects (keyed by cwd; contract §6.1) ------------------------------

  listProjects(): Project[] {
    return [...this.projects.values()]
      .map((p) => ({ ...p }))
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  upsertProject(
    cwd: string,
    patch?: Partial<Omit<Project, 'cwd' | 'createdAt'>>,
  ): Project {
    const now = Date.now();
    const existing = this.projects.get(cwd);
    if (!existing) {
      const created: Project = {
        cwd,
        createdAt: now,
        lastOpenedAt: patch?.lastOpenedAt ?? now,
        pinned: patch?.pinned ?? false,
      };
      if (patch?.title !== undefined) created.title = patch.title;
      this.projects.set(cwd, created);
      return { ...created };
    }
    // Apply only the patched fields; leave createdAt and (unless patched)
    // lastOpenedAt untouched. Idempotent.
    if (patch?.title !== undefined) existing.title = patch.title;
    if (patch?.pinned !== undefined) existing.pinned = patch.pinned;
    if (patch?.lastOpenedAt !== undefined) existing.lastOpenedAt = patch.lastOpenedAt;
    return { ...existing };
  }

  touchProject(cwd: string): Project {
    return this.upsertProject(cwd, { lastOpenedAt: Date.now() });
  }

  removeProject(cwd: string): void {
    // CASCADE: drop the project's sessions (and, per session, its scope='session'
    // memory) plus the project's own scope='project' memory. Sessions are NOT
    // reparented. CASCADE EXEMPTION (§2/§6): user/org memory is NOT project-owned
    // and is never touched here.
    const doomedSessions: string[] = [];
    for (const [sessionId, s] of this.sessions) {
      if (s.ref.cwd === cwd) doomedSessions.push(sessionId);
    }
    const doomed = new Set(doomedSessions);
    for (const sessionId of doomedSessions) this.sessions.delete(sessionId);
    for (const [id, item] of this.memoryItems) {
      const isDoomedSession =
        item.scope === 'session' && doomed.has(item.scopeKey);
      const isThisProject = item.scope === 'project' && item.scopeKey === cwd;
      if (isDoomedSession || isThisProject) this.memoryItems.delete(id);
    }
    // HARNESS CASCADE EXEMPTION (phase-1_6-harness-contracts §2/§6): drop only
    // this project's OWN scope='project' harness (scopeKey = cwd). user/org
    // harness is NOT project-owned and MUST survive; harness has no session
    // scope, so doomed sessions carry none.
    for (const [id, item] of this.harnessItems) {
      if (item.scope === 'project' && item.scopeKey === cwd) {
        this.harnessItems.delete(id);
      }
    }
    this.projects.delete(cwd);
  }

  // -- session ↔ project links ---------------------------------------------

  listSessionsByProject(cwd: string): SessionRef[] {
    return [...this.sessions.values()]
      .filter((s) => s.ref.cwd === cwd)
      .map((s) => ({ ...s.ref }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  setSessionProject(sessionId: string, cwd: string | null): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    // Only the link moves; messages and memory are untouched.
    if (cwd === null) delete s.ref.cwd;
    else s.ref.cwd = cwd;
  }

  // -- pinned sessions -----------------------------------------------------

  setSessionPinned(sessionId: string, pinned: boolean): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.ref.pinned = pinned;
  }

  listPinnedSessions(): SessionRef[] {
    return [...this.sessions.values()]
      .filter((s) => s.ref.pinned === true)
      .map((s) => ({ ...s.ref }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  // -- lifecycle -----------------------------------------------------------

  close(): void {
    this.closed = true;
  }

  /** True once close() has run. Nothing enforces it — an in-memory store has no
   * handle to leak — but it keeps the two drivers observationally similar. */
  get isClosed(): boolean {
    return this.closed;
  }
}
