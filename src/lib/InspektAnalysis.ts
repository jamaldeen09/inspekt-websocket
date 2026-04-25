import dotenv from "dotenv";
import OpenAI from "openai";
import { AnalysisResult } from "../types";
dotenv.config();

class InspektAnalysis {
    public models = {
        "free": {
            "default": {
                name: "gemini-1.5-flash",
                apiKey: this.getApiKey("gemini-1.5-flash")
            },
            "fallback": {
                "name": "gpt-4o-mini",
                "apiKey": this.getApiKey("gpt-4o-mini")
            },
        },

        "pro": {
            "default": {
                "name": "gpt-4o",
                "apiKey": this.getApiKey("gpt-4o")
            },

            "fallback": {
                "name": "claude-3-haiku",
                "apiKey": this.getApiKey("claude-3-haiku")
            },
        }
    }

    /**
      * Initializes the OpenAI SDK configured for OpenRouter integration.
      * Sets the base URL to OpenRouter's API and includes required headers 
      * for application identification and ranking.
      * 
      * @param apiKey - The OpenRouter-compatible API key for the chosen provider.
      * @returns An OpenAI client instance configured for the OpenRouter gateway.
      */
    public openaiSdk(apiKey: string) {
        return new OpenAI({
            apiKey,
            baseURL: "https://openrouter.ai/api/v1",
            defaultHeaders: {
                "HTTP-Referer": "https://inspekt.app",
                "X-Title": "Inspekt Hub",
            }
        });
    };

    /**
     * Retrieves the specific environment variable for a given LLM provider.
     * Ensures the correct key is mapped to the corresponding model tier.
     * 
     * @param llm - The identifier for the targeted Large Language Model.
     * @returns The API key string from environment variables.
     * @throws {Error} If the environment variable is not defined (via the ! operator).
     */
    public getApiKey(llm: "gpt-4o-mini" | "gemini-1.5-flash" | "gpt-4o" | "claude-3-haiku") {
        switch (llm) {
            case "gpt-4o-mini":
                return process.env.OPENAI_API_KEY_MINI!

            case "gemini-1.5-flash":
                return process.env.GEMINI_API_KEY!

            case "gpt-4o":
                return process.env.OPENAI_API_KEY!

            case "claude-3-haiku":
                return process.env.ANTHROPIC_API_KEY!
        }
    }

    /**
     * Generates minified prompts for the AI analysis engine. 
     * Supports both the high-level 'system' instruction and the data-dense 'user' payload.
     * 
     * @param args.type - The role of the prompt ('system' for instructions, 'user' for data).
     * @param args.data - The captured HTTP transaction details (Required if type is 'user').
     * @returns A minified string optimized for token efficiency.
     * @throws {Error} If type is 'user' but no data is provided.
     */
    static getPrompt(args: {
        type: "system" | "user",
        data?: {
            url: string;
            method: string;
            reqHeaders: any;
            resHeaders: any;
            body: any;
            status: number;
        }
    }) {
        if (args.type === "system") {
            return `You are an expert API response analyst. Receive raw HTTP response data and return a structured JSON analysis. Precise, technical, actionable. No filler. Return ONLY valid JSON in this shape:{"summary":"...","status":{"code":0,"meaning":"...","expected":true},"diagnosis":"...","issues":[],"fixes":[],"headers":{"notable":[],"missing":[],"security_flags":[]},"body":{"explanation":"...","anomalies":[]},"performance_flags":[],"severity":"ok|warning|critical"}`
        }

        if (!args.data) throw new Error("Field required: Data field is required for the user prompt");

        // Note: We use pipe delimiters (|) and condensed keys to save on token overhead
        return `URL:${args.data.url}|Method:${args.data.method}|RequestHeaders:${JSON.stringify(args.data.reqHeaders)}|Status:${args.data.status}|ResponseHeaders:${JSON.stringify(args.data.resHeaders)}|Body:${JSON.stringify(args.data.body)}|Note:If field data is unavailable, use null`.trim();
    };


    /**
     * Sanitizes sensitive data from headers or objects based on a user-defined list of keys.
     * Performs a case-insensitive partial match to catch keys like 'Authorization' or 'x-api-key'.
     * @param obj - The headers or object to sanitize
     * @param redactKeys - Array of strings (e.g., ['auth', 'cookie', 'token']) to look for
     * @returns A shallow copy of the object with sensitive values replaced by a redaction notice
     */
    static scrubHeaders(obj: any, redactKeys: string[]) {
        const newObj = { ...obj };
        for (let key in newObj) {
            if (redactKeys.some(s => key.toLowerCase().includes(s))) {
                newObj[key] = "[REDACTED_BY_INSPEKT]";
            }
        };
        return newObj;
    };

    /**
     * Limits the payload size sent to the AI to prevent context-window overflow and high token costs.
     * Handles both raw strings (HTML/Text) and JSON objects, appending a warning if truncation occurs.
     * @param data - The response body or data to be processed
     * @param limit - Character limit before truncation (defaults to 8000)
     * @returns A stringified and potentially truncated version of the input data
     */
    static truncateData(data: any, limit?: number): string {
        const LIMIT = limit ?? 8000;

        // If it's already a string (like HTML), slice it
        if (typeof data === 'string') {
            return data.length > LIMIT
                ? data.slice(0, LIMIT) + "\n[NOTICE: HTML truncated for analysis]"
                : data;
        }

        // If it's an object/array, stringify it
        const stringified = JSON.stringify(data);

        if (stringified.length > LIMIT) {
            return stringified.slice(0, LIMIT) +
                `\n[WARNING: JSON body truncated. Only the first ${LIMIT} characters were sent for analysis]`;
        }

        return stringified;
    }

    /**
     * Executes the AI analysis by passing sanitized and truncated data to the LLM.
     * Uses a fallback mechanism: if the primary model fails, it retries with the backup provider.
     * 
     * @param plan - The user's subscription tier ('free' or 'pro')
     * @param rawData - The raw captured HTTP data from the SDK
     * @param redactKeys - List of keys to scrub before sending to the AI provider
     */
    /**
 * Executes the AI analysis with a robust fallback mechanism.
 * Categorizes errors to decide if a retry is viable or if it should fail immediately.
 */
    public async analyze(
        plan: "free" | "pro",
        rawData: any,
        redactKeys: string[]
    ): Promise<AnalysisResult> {
        const tier = this.models[plan];
        const primary = tier.default;
        const fallback = tier.fallback;

        const sanitizedData = {
            ...rawData,
            reqHeaders: InspektAnalysis.scrubHeaders(rawData.reqHeaders, redactKeys),
            resHeaders: InspektAnalysis.scrubHeaders(rawData.resHeaders, redactKeys),
            body: InspektAnalysis.truncateData(rawData.body)
        };

        const systemPrompt = InspektAnalysis.getPrompt({ type: "system" });
        const userPrompt = InspektAnalysis.getPrompt({ type: "user", data: sanitizedData });

        /**
         * Internal helper to execute the request. 
         * Throws a structured error so the parent can handle fallbacks.
         */
        const runAttempt = async (modelName: string, apiKey: string) => {
            const startTime = Date.now();
            const openai = this.openaiSdk(apiKey);
            const completion = await openai.chat.completions.create({
                model: modelName,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                response_format: { type: "json_object" }
            });
            const endTime = Date.now();
            const tokensUsed = completion.usage?.total_tokens ?? null;
            const modelUsed = modelName
            const content = completion.choices[0]?.message?.content;

            if (!content) {
                throw new Error("AI_EMPTY_RESPONSE");
            }

            return {
                content: JSON.parse(content.replace(/```json|```/g, "").trim()),
                tokensUsed,
                modelUsed,
                analysisTime: endTime - startTime,
            }
        };

        /**
         * Formats raw errors into your specific V1 requirements
         */
        const formatError = (err: any): AnalysisResult => {
            const status = err?.status || err?.response?.status;
            const msg = err?.message || "";

            if (msg === "AI_EMPTY_RESPONSE") return { 
                msg: "AI returned an empty diagnosis. None of your diagnoses were lost", 
                error: { code: "EMPTY_RESPONSE" } 
            };

            if (status === 429) return {
                msg: "The AI analysis is currently rate-limited. Please wait a moment",
                error: { code: "RATE_LIMITED" }
            };

            if ([502, 503, 504].includes(status)) return {
                msg: "The AI model is currently overloaded or unavailable. Try again later.",
                error: { code: "MODEL_UNAVAILABLE" }
            };

            if (status === 400 && msg.includes("context_length")) return {
                msg: "The API response was too large for the AI to analyze",
                error: { code: "CONTEXT_WINDOW_EXCEEDED" }
            };

            return { 
                msg: "AI Analysis failed due to an internal error", 
                error: { code: "AI_ANALYSIS_FAILED" } 
            };
        };

        try {
            // --- ATTEMPT 1: Primary ---
            const data = await runAttempt(primary.name, primary.apiKey);
            return { msg: "Analysis successful", data };
        } catch (primaryErr: any) {
            const categorized = formatError(primaryErr);
            const status = primaryErr?.status || primaryErr?.response?.status;

            // Log invalid api key errors
            if (status === 401) {
                console.error(`[AI_ANALYSIS_ERROR]: Invalid API key`);
            }

            // Decide: Should we fallback? 
            // We fallback on 429 (rate limit), 5xx (overload), or general failures.
            // We DO NOT fallback on 401 (bad key) or 400 (context too big) because they will fail again.
            const shouldRetry = ["RATE_LIMITED", "MODEL_UNAVAILABLE", "AI_ANALYSIS_FAILED"].includes(categorized.error!.code);

            if (shouldRetry) {
                console.warn(`[AI RETRY]: Primary ${primary.name} failed. Trying fallback ${fallback.name}...`);
                try {
                    // --- ATTEMPT 2: Fallback ---
                    const data = await runAttempt(fallback.name, fallback.apiKey);
                    return { msg: "Analysis successful (via fallback)", data };
                } catch (fallbackErr) {
                    return formatError(fallbackErr);
                }
            }

            return categorized;
        }
    }
}


export default InspektAnalysis