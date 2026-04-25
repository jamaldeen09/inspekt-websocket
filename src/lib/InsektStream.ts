import { AuthData, ConfigOptions, ExtendedWs } from "../types";
import { ConnectionManager, connectionManager } from "./ConnectionManager";
import adminClient from "./supabase/client";
import InspektAnalysis from "./InspektAnalysis";

const inspektAnalysis = new InspektAnalysis();
class InspektStream {

    // -- Auth data and other options
    private _authData: AuthData;
    public configOptions: ConfigOptions;

    constructor(authData: AuthData, configOptions: ConfigOptions) {
        this._authData = authData;
        this.configOptions = configOptions;
    };

    get authData() {
        return this._authData
    }

    /**
      * Responds to a client heartbeat and updates the connection status.
      * 
      * @param ws - The specific WebSocket connection instance, extended with an `isAlive` property.
      * @param userId - The unique identifier for the user to whom the "pong" response should be emitted.
      * @description
      * This method acts as the "Pong" in the heartbeat cycle. By setting `isAlive` to true, 
      * it prevents the `startHeartbeat` monitor from terminating the connection during 
      * its next sweep.
      */
    public handlePing(ws: ExtendedWs, userId: string) {
        ws.isAlive = true;
        this.emit(userId, "pong");
        return;
    }

    /**
     * This sends/emits a message to a connected socket/sockets
     * @param userId - The userId of the connection 
     * @param data - Data being emitted/sent 
     */
    public emit(userId: string, data: string | Object) {
        const type = this.configOptions.type;
        const finalData = typeof data === "string" ? data : InspektStream.encode(data);

        if (type === "dashboard") {
            const sockets = connectionManager.dashboardConnections.get(userId);
            if (!sockets || sockets.size === 0) {
                console.warn(`[Socket message emittion failed]: Attempted to emit a message to: ${userId}, but no sockets were found (DASHBOARD)`);
                return;
            }

            return sockets.forEach((socket) => {
                const isConnected = ConnectionManager.isWsConnected(socket);
                if (isConnected) socket.send(finalData);
            });
        } else {
            const socket = connectionManager.sdkConnections.get(userId);
            if (!socket) {
                console.warn(`[Socket message emittion failed]: Attempted to emit a message to: ${userId}, but socket was not found (SDK)`);
                return;
            }

            const isConnected = ConnectionManager.isWsConnected(socket);
            if (isConnected) socket.send(finalData);
        }
    }

    /**
     * This method decodes buffers or binary data, processes and then
     * parses it into structured JSON
     * @param data - The JSON data being decoded
     */
    static decode(data: any) {
        const parsed = JSON.parse(data.toString());
        return parsed;
    }

    /**
     * This method encodes JSON data because the native ws package
     * only sends data as a Buffer or a string. We need structured
     * JSON for inspekt because it'll hold ai analysis data
     * @param data - The JSON data being encoded 
     */
    static encode(data: Object) {
        const stringifiedJson = JSON.stringify(data);
        return Buffer.from(stringifiedJson);
    };

    /**
      * Processes the raw log, executes AI analysis, updates the user's 
      * diagnosis record in Supabase, and emits the result via WebSocket.
      */
    public async log(data: {
        url: string;
        method: string;
        reqHeaders: any;
        resHeaders: any;
        body: any;
        responseTime: number;
        status: number;
        metadata: any;
    }) {
        const { userId, userPlan, keyId } = this._authData;
        const { redactKeys, analysisMode } = this.configOptions;
        const isErr = data.status >= 400

        // Execute AI Analysis ONLY on "errors" or "always" mode
        if ((isErr && analysisMode === "errors") || analysisMode === "always") {
            const result = await inspektAnalysis.analyze(userPlan, data, redactKeys);

            // Handle Analysis Failures
            if (result && result.error) {
                console.error(`[LOG ANALYSIS FAILED]: ${result.msg}`);

                return this.emit(userId, {
                    event: "analysis:error",
                    data: { analysis: null, msg: result.msg, error: result.error }
                });
            }

            // Log entry for db/supabase
            const logEntry = {
                user_id: userId,
                api_key_id: keyId,
                url: data.url,
                method: data.method,
                status: data.status,
                request_headers: data.reqHeaders,
                response_headers: data.resHeaders,
                response_time: data.responseTime,
                diagnosis_time: result.data.diagnosisTime,
                model_used: result.data.modelUsed ?? null,
                tokens_used: result.data.tokensUsed ?? null,
                body: data.body,
                analysis: result.data,
            }

            // Persist the actual log record
            // This keeps a history of the API call and the AI's diagnosis
            const { data: logRecord, error: logError } = await adminClient
                .from("logs")
                .insert(logEntry)
                .select()
                .single();

            if (logError) {
                console.error(`[DB LOG INSERT FAILED]:`, logError);
            }

            // Deduct a diagnosis credit from the user
            await adminClient.rpc('decrement_diagnoses', { user_id: userId, row_count: 1 });

            return this.emit(userId, {
                event: "analysis:success",
                data: {
                    msg: "Successfully analyzed",
                    analysis: result.data.content,
                    metadata: { logId: logRecord?.id, ...data.metadata }
                }
            });
        }

        // Handle skips
        let skipReason = `Analysis mode is set to '${analysisMode}'.`;
        const type = data.status >= 300 && 
        data.status <= 399 ? "Redirect" : 
        data.status >= 200 && 
        data.status <= 299 ? "Success" : "Error"

        if (analysisMode === "never") {
            skipReason = "AI Analysis is currently disabled in your configuration.";
        } else if (analysisMode === "errors" && !isErr) {
            skipReason = `Analysis skipped: Response status is ${data.status} (${type}), but analysisMode is set to 'errors' only.`;
        };

        return this.emit(userId, {
            event: "no:analysis",
            data: { analysis: null, msg: `${skipReason} This request has been logged without a diagnosis`}
        });
    }
}


export default InspektStream