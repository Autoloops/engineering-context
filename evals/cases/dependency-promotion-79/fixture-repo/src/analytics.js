import { createClient } from "@clickhouse/client";

// Ships order analytics events for reporting. ClickHouse is declared as a
// service in docker-compose.yml.
const clickhouse = createClient({ url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123" });

export async function recordOrderAnalyticsEvent(order) {
  await clickhouse.insert({
    table: "order_events",
    values: [{ order_id: order.id, customer: order.customer, status: order.status }],
    format: "JSONEachRow",
  });
}
