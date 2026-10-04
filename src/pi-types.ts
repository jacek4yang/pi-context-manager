// Structural type for the read-only session manager surface we depend on.
// Pi exports ReadonlySessionManager from its internal types but not through
// the package index; we depend only on this shape, never on internals.
export interface ReadonlySessionManager {
  getSessionId(): string | undefined;
  getBranch(): Array<{ type: string; id: string; customType?: string; data?: unknown }>;
  buildSessionProjection(): {
    entries: Array<{ sourceEntry: { id: string }; messages: Array<{ role: string }> }>;
    messages: Array<{ role: string }>;
  };
}
