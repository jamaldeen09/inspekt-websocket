import { AuthData, ConfigOptions } from "../../types";
import adminClient from "../supabase/client";
import InspektAnalysis from "./inspekt-analysis";
import { WebSocket } from "ws";

const inspektAnalysis = new InspektAnalysis();
class InspektStream {
    // -- Connections tracking
    public sdkConnections: Map<string, WebSocket> = new Map();
    public dashboardConnections: Map<string, Set<WebSocket>> = new Map();

    // -- Auth data and other options
    private _authData: AuthData;
    public configOptions: ConfigOptions;

    constructor(authData: AuthData, configOptions: ConfigOptions) {
        this._authData = authData;
        this.configOptions = configOptions;
    };

    /**
     * Handles storing a new connection for tracking
     * @param ws 
     */
    public newSocketUser (ws: WebSocket) {
        const { userId } = this._authData

        if (this.configOptions.type === "dashboard") {
            const sockets = this.dashboardConnections.get(userId);

            if (sockets && sockets.size > 0) {
                return sockets.add(ws);
            } else {
                return this.dashboardConnections.set(userId, new Set([ws]));
            }
        } else {
            if (this.sdkConnections.has(this._authData.userId)) return;
            return this.sdkConnections.set(userId, ws);
        }
    };

    public removeSocketUser (ws: WebSocket) {
        const { userId } = this._authData;

        if (this.configOptions.type === "dashboard") {
            const sockets = this.dashboardConnections.get(userId);
            if (sockets && sockets.size > 0) {
                return sockets.delete(ws);
            };
        } else {
            return this.sdkConnections.delete(userId);
        }
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
            const sockets = this.dashboardConnections.get(userId);
            if (!sockets || sockets.size === 0) {
                console.warn(`[Socket message emittion failed]: Attempted to emit a message to: ${userId}, but no sockets were found (DASHBOARD)`);
                return;
            }

            return sockets.forEach((socket) => {
                const isConnected = InspektStream.isWsConnected(socket);
                if (isConnected) socket.send(finalData);
            });
        } else {
            const socket = this.sdkConnections.get(userId);
            if (!socket) {
                console.warn(`[Socket message emittion failed]: Attempted to emit a message to: ${userId}, but socket was not found (SDK)`);
                return;
            }

            const isConnected = InspektStream.isWsConnected(socket);
            if (isConnected) socket.send(finalData);
        }
    }

    /**
     * Returns a boolean that confirms if 
     * a websocket connection is connected/alive
     * @param ws 
     */
    static isWsConnected(ws: WebSocket) {
        return ws.readyState === ws.OPEN;
    }

    /**
     * This method decodes buffers or binary data, processes and then
     * parses it into structured JSON
     * @param data - The JSON data being decoded
     */
    static decode(data: Buffer | ArrayBuffer) {
        const firstByte = data[0];
        if (firstByte !== 0) return null // This means we didn't receive JSON data, hence we can't process it

        const payload = data.slice(0).toString() // Grab the actual bufferized json data;
        const parsed = JSON.parse(payload) // parse it

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
        const concatenatedBuffer = Buffer.concat([Buffer.from([0]), Buffer.from(stringifiedJson)]);
        return concatenatedBuffer;
    };

    /**
      * Processes the raw log, executes AI analysis, updates the user's 
      * diagnosis record in Supabase, and emits the result via WebSocket.
      */
    /**
     * Processes the raw log: Executes AI analysis, deducts a diagnosis credit,
     * persists the log to the database, and emits the result to the dashboard.
     */
    public async log(data: {
        url: string;
        method: string;
        reqHeaders: any;
        resHeaders: any;
        body: any;
        status: number;
    }) {
        const { userId, userPlan } = this._authData;
        const { redactKeys, analysisMode } = this.configOptions;


        // Execute AI Analysis ONLY on "errors" or "always" mode
        if (analysisMode === "errors" || analysisMode === "always") {
            const result = await inspektAnalysis.analyze(userPlan, data, redactKeys);

            // Handle Analysis Failures
            if (result && !result.success) {
                console.error(`[LOG_ANALYSIS_FAILED]: ${result.message}`);
                return this.emit(userId, { type: "analysis:error", msg: result.message, error: result.error });
            }

            // Persist the actual log record
            // This keeps a history of the API call and the AI's diagnosis
            const { data: logRecord, error: logError } = await adminClient
                .from("logs")
                .insert({
                    user_id: userId,
                    url: data.url,
                    method: data.method,
                    status: data.status,
                    request_headers: data.reqHeaders,
                    response_headers: data.resHeaders,
                    body: data.body,
                    analysis: result.data,
                    severity: result.data.severity || "ok"
                })
                .select()
                .single();

            if (logError) {
                console.error(`[DB_LOG_INSERT_FAILED]:`, logError);
            }

            // Deduct a diagnosis credit from the user
            // Using .rpc() is safer for atomic increments/decrements
            await adminClient.rpc('decrement_diagnoses', { user_id: userId, row_count: 1 });

            return this.emit(userId, {
                event: "analysis:success",
                msg: "Successfully analyzed",
                payload: { ...result.data, logId: logRecord?.id }
            });
        }


        // Emit the success payload
        // We include the logRecord ID so the frontend can reference the DB entry
        return this.emit(userId, { event: "no:analysis", payload: null, msg: `Analyis mode has been set to: ${analysisMode}. None of your diagnoses were lost` });
    }
}


export default InspektStream