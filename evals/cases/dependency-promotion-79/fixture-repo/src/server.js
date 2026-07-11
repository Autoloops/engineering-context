import { createClient } from "redis";

const redisClient = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
await redisClient.connect();

export async function publishOrderCreated(order) {
  // Publishes to the "orders.created" channel so downstream workers can
  // process the order asynchronously. The server cannot start without a
  // working Redis connection - see docker-compose.yml for the redis service.
  await redisClient.publish("orders.created", JSON.stringify(order));
}

export function createOrder(body) {
  const order = { id: crypto.randomUUID(), ...body, status: "created" };
  return order;
}
