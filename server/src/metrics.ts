export class Metrics {
  readonly startedAt = Date.now();
  connections = 0;
  totalConnections = 0;
  messagesIn = 0;
  messagesOut = 0;
  bytesIn = 0;
  bytesOut = 0;
  busIn = 0;
  busOut = 0;
  updatesPersisted = 0;
  compactions = 0;
  flushErrors = 0;
  /** Edits persisted on room close that no other instance had written. */
  recovered = 0;
  rateLimited = 0;

  snapshot(extra: Record<string, unknown> = {}) {
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      connections: this.connections,
      totalConnections: this.totalConnections,
      messagesIn: this.messagesIn,
      messagesOut: this.messagesOut,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      busIn: this.busIn,
      busOut: this.busOut,
      updatesPersisted: this.updatesPersisted,
      compactions: this.compactions,
      flushErrors: this.flushErrors,
      recovered: this.recovered,
      rateLimited: this.rateLimited,
      ...extra,
    };
  }
}
