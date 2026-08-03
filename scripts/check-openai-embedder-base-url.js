import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

const root = new URL("..", import.meta.url);
const { OpenAIEmbedder, DEFAULT_OPENAI_BASE_URL, resolveOpenAIBaseUrl } = await import(
  new URL("dist/libs/knowledge-graph/graph-context/openai-embedder.js", root)
);

delete process.env.OPENAI_BASE_URL;
assert.equal(resolveOpenAIBaseUrl(), DEFAULT_OPENAI_BASE_URL, "unset OPENAI_BASE_URL should keep the OpenAI default");
assert.equal(resolveOpenAIBaseUrl("https://example.test/v1/"), "https://example.test/v1", "trailing slashes should be trimmed");

process.env.OPENAI_BASE_URL = "https://env.example.test/v1";
assert.equal(resolveOpenAIBaseUrl(), "https://env.example.test/v1", "OPENAI_BASE_URL should override the default");
assert.equal(
  resolveOpenAIBaseUrl("https://option.example.test/v1"),
  "https://option.example.test/v1",
  "an explicit baseUrl option should win over the environment"
);

const requests = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [index, 1, 2, 3] })) }));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1/`;

try {
  const embedder = new OpenAIEmbedder({ model: "test-embedding", dimensions: 4, batchSize: 2 });
  const embeddings = await embedder.embedBatch(["alpha", "beta", "gamma"]);

  assert.equal(requests.length, 2, "batchSize 2 should split three inputs across two requests");
  assert.deepEqual(
    requests.map((request) => request.url),
    ["/v1/embeddings", "/v1/embeddings"],
    "requests should go to <OPENAI_BASE_URL>/embeddings"
  );
  assert.equal(requests[0].authorization, "Bearer test-key", "the API key should still be sent as a bearer token");
  assert.deepEqual(requests[0].body.input, ["alpha", "beta"], "the first request should carry the first batch");
  assert.equal(requests[0].body.model, "test-embedding", "the configured model should be forwarded");
  assert.equal(embeddings.length, 3, "every input should produce an embedding");
  assert.deepEqual(embeddings[0], [0, 1, 2, 3], "embeddings should be returned in input order");
} finally {
  server.close();
  await once(server, "close");
}

console.log("OpenAI embedder base URL checks passed.");
