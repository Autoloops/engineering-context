import { setTimeout as sleep } from "node:timers/promises";
import type { EmbeddingConfig } from "../../config/greplica-config.js";
import { openDatabase } from "../../storage/sqlite/db.js";
import { WorkerLease } from "../../utils/worker-lease.js";

interface LocalModelLockOptions {
  wait: boolean;
}

interface LocalModelLockResult<T> {
  acquired: boolean;
  value?: T;
}

const heldLocks = new Set<string>();
const localModelLockLeaseMs = 5 * 60 * 1000;
const localModelLockHeartbeatMs = 30 * 1000;
const localModelLockRetryMs = 1000;

export async function withLocalModelLock<T>(
  config: EmbeddingConfig,
  options: LocalModelLockOptions,
  callback: () => Promise<T>,
): Promise<LocalModelLockResult<T>> {
  const name = localModelLockName(config);
  if (heldLocks.has(name)) {
    return {
      acquired: true,
      value: await callback(),
    };
  }

  const db = openDatabase();
  const lease = new WorkerLease(db, name, localModelLockLeaseMs);
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    let acquired = lease.acquire();
    while (!acquired && options.wait) {
      await sleep(localModelLockRetryMs);
      acquired = lease.acquire();
    }
    if (!acquired) return { acquired: false };

    heldLocks.add(name);
    heartbeat = setInterval(() => {
      lease.renew();
    }, localModelLockHeartbeatMs);
    heartbeat.unref();

    return {
      acquired: true,
      value: await callback(),
    };
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (heldLocks.delete(name)) lease.release();
    db.close();
  }
}

function localModelLockName(config: EmbeddingConfig): string {
  return `local-embedding-model:${config.model}:${config.dimensions}`;
}
