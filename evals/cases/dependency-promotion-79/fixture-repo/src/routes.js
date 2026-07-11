import { createOrder, prisma, publishOrderCreated, cacheLatestOrder } from "./server.js";
import { recordOrderAnalyticsEvent } from "./analytics.js";

export async function handleCreateOrder(request, response) {
  const order = createOrder(request.body);
  await prisma.order.create({ data: order });
  await publishOrderCreated(order);
  await cacheLatestOrder(order);
  await recordOrderAnalyticsEvent(order);
  response.status(201).json(order);
}
