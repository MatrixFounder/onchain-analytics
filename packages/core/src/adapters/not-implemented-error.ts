/**
 * Thrown by an adapter's own HTTP step or normalization step when that member is stubbed in M1
 * (ARCHITECTURE.md §3.2/§11 — `dash-platform`'s live gRPC transport and `dune`'s live Query API
 * are both deferred past M1). Both adapters' own `isAvailable()` already returns
 * `{ ok: false }` unconditionally, so `CapabilityRegistry.resolve()` never actually reaches this
 * code path in M1 — it exists purely so a direct, out-of-band call fails loudly and explicitly
 * (never silently returning something meaningless), matching this package's "explicit
 * degradation, never silent" convention (R-24).
 */
export class NotImplementedInM1Error extends Error {
  constructor(adapterId: string, member: 'fetch' | 'normalize') {
    super(`${adapterId}.${member}() is not implemented in M1 (see ARCHITECTURE.md §3.2/§11)`);
    this.name = 'NotImplementedInM1Error';
  }
}
