import { createOrder, publishOrderCreated } from "./server.js";

export async function handleCreateOrder(request, response) {
  const order = createOrder(request.body);
  await publishOrderCreated(order);
  response.status(201).json(order);
}
