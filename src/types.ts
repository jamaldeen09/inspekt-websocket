export type ConnectionType = "sdk" | "dashboard";
export type AnalysisMode = "errors" | "always" | "never"

export interface ConfigOptions {
    type: ConnectionType; // ** MUST EXIST
    apiKey: string; // ** MUST EXIST
    token?: string; // ** MUST ONLY EXISTS IF TYPE IS SET TO "dashboard"
    analysisMode: AnalysisMode // ** OPTIONAL: DEFAULTS TO "errors" IF NOT SET
    redactKeys: string[] // ** MUST EXIST: INSPEKT-JS ADDS DEFAULT KEYS TO REDACT SO THIS IS NOT OPTIONAL
}

export interface AuthData { 
    userId: string; 
    keyId: string;
    userPlan: "free" | "pro";
}

export type ValidationRes = { msg: string; code: number } | null;
export interface AnalysisResult {
    success: boolean;
    data?: any;
    message: string;
    error?: {
        code: string;
        statusCode: number;
        details?: any;
    };
};
