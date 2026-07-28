import type Database from "better-sqlite3";
import type { InstallPlatform } from "./paths.js";

export class PlatformIntegrationStore {
  constructor(private readonly db: Database.Database) {}

  record(platform: InstallPlatform): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO platform_integrations (platform, installed_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(platform) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(platform, now, now);
  }

  preferred(): InstallPlatform | undefined {
    const row = this.db.prepare(
      "SELECT platform FROM platform_integrations ORDER BY updated_at DESC, platform LIMIT 1",
    ).get() as { platform: InstallPlatform } | undefined;
    return row?.platform;
  }

  list(): InstallPlatform[] {
    return (this.db.prepare("SELECT platform FROM platform_integrations ORDER BY platform").all() as Array<{
      platform: InstallPlatform;
    }>).map((row) => row.platform);
  }
}
