import type {
  ExtractorConfig,
  ExtractorContext,
  ExtractorProvider,
  ExtractorResult
} from "../types.js";
import { chatCompletion } from "../ai/chat.js";
import { parseJsonFromModelText } from "../json.js";
import { DEFAULT_EXTRACTION_OUTPUT_TOKENS, extractionBatches, extractionOutputGuidance } from "./context.js";
import { readExtractedMemories } from "./parse.js";
import { EXTRACTOR_SYSTEM_PROMPT } from "./prompt.js";

export function createOpenAICompatibleExtractor(
  config: ExtractorConfig,
  fetchImpl: typeof fetch = fetch
): ExtractorProvider {
  return {
    async extract(context: ExtractorContext): Promise<ExtractorResult> {
      const result: ExtractorResult = { memories: [], rejected: [] };
      for (const batch of extractionBatches(context)) {
        const { content } = await chatCompletion(config, {
          job: "extraction",
          system: EXTRACTOR_SYSTEM_PROMPT + extractionOutputGuidance(config.maxTokens ?? DEFAULT_EXTRACTION_OUTPUT_TOKENS),
          user: JSON.stringify(batch),
          errorLabel: "Extractor",
          invalidResponseMessage: "Invalid extractor response"
        }, { fetchImpl });
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
