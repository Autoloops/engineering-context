export type JudgeProvider = "openai" | "anthropic";

export interface JudgeVerdict {
  correct: boolean;
  reasoning: string;
}

export interface JudgeRequest {
  question: string;
  goldAnswer: string;
  candidateAnswer: string;
}

const JUDGE_SYSTEM =
  "You are grading whether a coding agent's answer to a recall question matches the known correct answer. " +
  "Return JSON only. Mark correct=true when the candidate answer states the same key fact(s) as the gold answer " +
  "(PR numbers, file names, identifiers, and decisions must match), allowing for paraphrase and extra correct detail. " +
  "Mark correct=false when the candidate is wrong, missing the key fact, refuses, or says it does not know.";

const JUDGE_TOOL_NAME = "record_verdict";

function judgeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      correct: { type: "boolean" },
      reasoning: { type: "string" },
    },
    required: ["correct", "reasoning"],
  };
}

function userPayload(request: JudgeRequest): string {
  return JSON.stringify({
    question: request.question,
    gold_answer: request.goldAnswer,
    candidate_answer: request.candidateAnswer,
  });
}

export async function requestJudge(
  provider: JudgeProvider,
  apiKey: string,
  model: string,
  request: JudgeRequest,
): Promise<JudgeVerdict> {
  return provider === "anthropic"
    ? requestAnthropicJudge(apiKey, model, request)
    : requestOpenAiJudge(apiKey, model, request);
}

async function requestOpenAiJudge(apiKey: string, model: string, request: JudgeRequest): Promise<JudgeVerdict> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: userPayload(request) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "coding_life_answer_judge",
          strict: true,
          schema: judgeSchema(),
        },
      },
    }),
  });

  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`OpenAI judge request failed: ${JSON.stringify(body)}`);
  }

  return JSON.parse(extractOpenAiOutputText(body)) as JudgeVerdict;
}

async function requestAnthropicJudge(apiKey: string, model: string, request: JudgeRequest): Promise<JudgeVerdict> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: JUDGE_SYSTEM,
      tools: [
        {
          name: JUDGE_TOOL_NAME,
          description: "Record the grading verdict for the candidate answer.",
          input_schema: judgeSchema(),
        },
      ],
      tool_choice: { type: "tool", name: JUDGE_TOOL_NAME },
      messages: [{ role: "user", content: userPayload(request) }],
    }),
  });

  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Anthropic judge request failed: ${JSON.stringify(body)}`);
  }

  return extractAnthropicVerdict(body);
}

function extractOpenAiOutputText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string" && body.output_text.length > 0) return body.output_text;

  const output = body.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (!isRecord(item)) continue;
      const content = item.content;
      if (!Array.isArray(content)) continue;
      for (const piece of content) {
        if (isRecord(piece) && typeof piece.text === "string") parts.push(piece.text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }

  throw new Error(`Could not extract judge output text from response: ${JSON.stringify(body)}`);
}

function extractAnthropicVerdict(body: Record<string, unknown>): JudgeVerdict {
  const content = body.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === "tool_use" && block.name === JUDGE_TOOL_NAME && isRecord(block.input)) {
        return block.input as unknown as JudgeVerdict;
      }
    }
  }

  throw new Error(`Could not extract judge verdict from Anthropic response: ${JSON.stringify(body)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
