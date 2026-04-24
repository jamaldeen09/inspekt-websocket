type ValidationRes = { msg: string; code: number } | null;

export function validateApiKey(key: string | null | undefined): ValidationRes {
    const keyLength = 57;
    const prefix = "ins_live_";

    // Missing Key (4002 - Not Found/Missing)
    if (!key || key?.trim() === "") {
        return {
            msg: "API Key is missing. Get one at https://inspekt.app",
            code: 4002
        };
    }

    // Format check (4000 - Bad Request)
    if (!key.startsWith(prefix)) {
        return {
            msg: `Invalid API Key format. Keys should start with "${prefix}"`,
            code: 4000
        };
    }

    // Length check (4000 - Bad Request)
    // We use 4000 because the client *knows* it is sending 
    // something that physically cannot be a valid key.
    if (key.length !== keyLength) {
        const detail = key.length < keyLength ? "short" : "long";
        return {
            msg: `API Key seems too ${detail}. Please check your dashboard`,
            code: 4000
        };
    }

    return null;
}



class AIAnalysis {
    public models: [];


    static getPrompt (args: {
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
    
        if (!args.data) throw new Error("Field requires: Data field is required for the user prompt");
        return `URL:${args.data.url}|Method:${args.data.method}|RequestHeaders:${JSON.stringify(args.data.reqHeaders)}|Status:${args.data.status}|ResponseHeaders:${JSON.stringify(args.data.resHeaders)}|Body:${JSON.stringify(args.data.body)}|Note:If field data is unavailable, use null`.trim();
    };


    static scrubHeaders (obj: any, redactKeys: string[]) {
        const newObj = { ...obj };
        for (let key in newObj) {
            if (redactKeys.some(s => key.toLowerCase().includes(s))) {
                newObj[key] = "[REDACTED_BY_INSPEKT]";
            }
        };
        return newObj;
    };

    static truncateData (data: any, limit?: number): string {
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
}