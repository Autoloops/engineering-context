import { PrismaClient } from "@prisma/client";
import { Kafka } from "kafkajs";
import { createClient } from "redis";
import { createClient as createClickHouseClient } from "@clickhouse/client";

// Persists orders. Postgres is declared in docker-compose.yml and its
// connection is configured in prisma/schema.prisma - the server cannot
// start without a reachable Postgres instance.
export const prisma = new PrismaClient();

// Publishes order-created events for downstream workers to consume. Kafka
// is declared as a service in docker-compose.yml.
const kafka = new Kafka({ clientId: "order-api", brokers: [process.env.KAFKA_BROKER ?? "localhost:9092"] });
const kafkaProducer = kafka.producer();
await kafkaProducer.connect();

export async function publishOrderCreated(order) {
  await kafkaProducer.send({
    topic: "orders.created",
    messages: [{ value: JSON.stringify(order) }],
  });
}

// Caches the most recent order per customer for fast repeat lookups. Redis
// is declared as a service in docker-compose.yml.
const redisClient = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
await redisClient.connect();

export async function cacheLatestOrder(order) {
  await redisClient.set(`latest-order:${order.customer}`, JSON.stringify(order));
}

export function createOrder(body) {
  return { id: crypto.randomUUID(), ...body, status: "created" };
}
