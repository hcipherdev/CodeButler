import { chatCompletion } from "../ai/chat.js";
import { anthropicAwsRequestConfig, type AnthropicAwsHttpClient } from "../providers/anthropic-aws.js";
import { parseJsonFromModelText } from "../json.js";
import { DEFAULT_EXTRACTION_OUTPUT_TOKENS, extractionBatches, extractionOutputGuidance } from "./context.js";
import { readExtractedMemories } from "./parse.js";
import { EXTRACTOR_SYSTEM_PROMPT } from "./prompt.js";
import type {
  ExtractorConfig,
  ExtractorContext,
  ExtractorProvider,
  ExtractorResult
} from "../types.js";

export function createAnthropicAwsExtractor(
  config: ExtractorConfig,
  httpClient?: AnthropicAwsHttpClient
): ExtractorProvider {
  return {
    async extract(context: ExtractorContext): Promise<ExtractorResult> {
      const requestConfig = anthropicAwsRequestConfig({ ...config, maxTokens: config.maxTokens ?? DEFAULT_EXTRACTION_OUTPUT_TOKENS });
      const result: ExtractorResult = { memories: [], rejected: [] };
      for (const batch of extractionBatches(context)) {
        const { content } = await chatCompletion(config, {
          job: "extraction",
          maxTokens: requestConfig.maxTokens,
          system: EXTRACTOR_SYSTEM_PROMPT + extractionOutputGuidance(requestConfig.maxTokens),
          user: JSON.stringify(batch),
          errorLabel: "Extractor",
          invalidResponseMessage: "Invalid AnthropicAWS response"
        }, { anthropicHttpClient: httpClient });
        const parsed = parseJsonFromModelText(content);
        const extracted = readExtractedMemories(parsed, batch);
        const offset = result.memories.length + result.rejected.length;
        result.memories.push(...extracted.memories);
        result.rejected.push(...extracted.rejected.map(item => ({ ...item, index: item.index + offset })));
      }
      return result;
    }
  };
}
