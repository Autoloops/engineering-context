import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export class WorkerLease {
  private readonly owner = randomUUID();

  constructor(
    private readonly db: Database.Database,
    private readonly name: string,
    private readonly leaseMs = 5 * 60 * 1000,
  ) {}

  acquire(now = new Date()): boolean {
    return this.db.transaction((acquiredAt: Date) => {
      const timestamp = acquiredAt.toISOString();
      const lockedUntilAt = new Date(acquiredAt.getTime() + this.leaseMs).toISOString();
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO agent_worker_locks (name, owner, locked_until_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(this.name, this.owner, lockedUntilAt, timestamp);
      if (inserted.changes === 1) return true;

      const updated = this.db
        .prepare(
          `UPDATE agent_worker_locks
           SET owner = ?, locked_until_at = ?, updated_at = ?
           WHERE name = ? AND locked_until_at <= ?`,
        )
        .run(this.owner, lockedUntilAt, timestamp, this.name, timestamp);
      return updated.changes === 1;
    })(now) as boolean;
  }

  release(now = new Date()): void {
    const timestamp = now.toISOString();
    this.db
      .prepare(
        `UPDATE agent_worker_locks
         SET locked_until_at = ?, updated_at = ?
         WHERE name = ? AND owner = ?`,
      )
      .run(timestamp, timestamp, this.name, this.owner);
  }

  renew(now = new Date()): boolean {
    const timestamp = now.toISOString();
    const lockedUntilAt = new Date(now.getTime() + this.leaseMs).toISOString();
    const updated = this.db
      .prepare(
        `UPDATE agent_worker_locks
         SET locked_until_at = ?, updated_at = ?
         WHERE name = ? AND owner = ?`,
      )
      .run(lockedUntilAt, timestamp, this.name, this.owner);
    return updated.changes === 1;
  }
}
