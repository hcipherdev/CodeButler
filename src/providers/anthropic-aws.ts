import https from "node:https";

export interface AnthropicAwsMessageRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  apiKeyEnv: string;
  workspaceIdEnv: string;
  regionEnv: string;
  baseUrl?: string | undefined;
}

export interface AnthropicAwsMessageResponse {
  content?: unknown;
}

export interface AnthropicAwsHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type AnthropicAwsHttpClient = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<AnthropicAwsHttpResponse>;

export type AnthropicAwsMessageRunner = (
  request: AnthropicAwsMessageRequest,
  httpClient?: AnthropicAwsHttpClient
) => Promise<AnthropicAwsMessageResponse>;

export async function runAnthropicAwsMessage(
  request: AnthropicAwsMessageRequest,
  httpClient: AnthropicAwsHttpClient = nodeHttpsRequest
): Promise<AnthropicAwsMessageResponse> {
  const apiKey = readRequiredEnv(request.apiKeyEnv, "Anthropic AWS API key");
  const workspaceId = readRequiredEnv(request.workspaceIdEnv, "Anthropic AWS workspace ID");
  const region = readRequiredEnv(request.regionEnv, "AWS region");
  const baseUrl =
    request.baseUrl?.trim() ||
    process.env.ANTHROPIC_AWS_BASE_URL?.trim() ||
    `https://aws-external-anthropic.${region}.api.aws`;

  const body = JSON.stringify({
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages
  });

  const response = await httpClient(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body).toString(),
      "anthropic-version": "2023-06-01",
      "anthropic-workspace-id": workspaceId,
      "user-agent": "AnthropicAWS/CodeButler",
      "X-Api-Key": apiKey
    },
    body
  });

  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(`AnthropicAWS request failed with status ${response.status}${body ? `: ${body}` : ""}`);
  }
  return (await response.json()) as AnthropicAwsMessageResponse;
}

async function nodeHttpsRequest(
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
): Promise<AnthropicAwsHttpResponse> {
  const parsedUrl = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: init.method,
        headers: init.headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(text) as unknown,
            text: async () => text
          });
        });
      }
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

export function readAnthropicAwsText(payload: AnthropicAwsMessageResponse): string {
  if (typeof payload.content === "string") return payload.content;
  if (!Array.isArray(payload.content)) {
    throw new Error("Invalid AnthropicAWS response");
  }
  const text = payload.content
    .map((item) => {
      const part = asRecord(item);
      return typeof part?.text === "string" ? part.text : "";
    })
    .join("\n")
    .trim();
  if (!text) throw new Error("Invalid AnthropicAWS response");
  return text;
}

export function anthropicAwsRequestConfig(config: {
  model: string;
  apiKeyEnv: string;
  workspaceIdEnv?: string | undefined;
  regionEnv?: string | undefined;
  baseUrl?: string | undefined;
  maxTokens?: number | undefined;
}): Pick<
  AnthropicAwsMessageRequest,
  "model" | "apiKeyEnv" | "workspaceIdEnv" | "regionEnv" | "baseUrl" | "maxTokens"
> {
  return {
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    workspaceIdEnv: config.workspaceIdEnv ?? "ANTHROPIC_AWS_WORKSPACE_ID",
    regionEnv: config.regionEnv ?? "AWS_REGION",
    baseUrl: config.baseUrl,
    maxTokens: config.maxTokens ?? 2048
  };
}

function readRequiredEnv(envName: string, label: string): string {
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(`${label} is missing; set ${envName}`);
  }
  return value;
}

async function readErrorBody(response: AnthropicAwsHttpResponse): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 500);
  } catch {
    return "";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
