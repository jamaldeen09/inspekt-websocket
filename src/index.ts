import { WebSocketServer } from 'ws';
import { AnalysisMode, AuthData, ConfigOptions, ConnectionType } from './types';
import { validateApiKey } from './lib/utils';
import { verifyDashboardAccess, verifySdkAccess } from './lib/supabase/authentication';

// Websocket server init
const wss = new WebSocketServer({ port: 4090 });
const connections = new Map<string, WebSocket>();

wss.on("connection", async (ws, req) => {
    // Confirm a url exists mostly for ts errors 
    // but it still needs to be handled gracefully
    // because the url is essential
    if (!req.url) {
        ws.close();
        return;
    };

    // Extract the search params
    const { searchParams } = new URL(req.url, `http://${req.headers.host}`);


    // Get all the values that we care about
    const type = searchParams.get("type") as ConnectionType | null;
    const apiKey = searchParams.get("apiKey");
    const token = searchParams.get("token");
    const analysisMode = searchParams.get("analysisMode") ?? "errors" as AnalysisMode;
    const redactKeys = searchParams.get("redactKeys");

    // -- Validate the compulsory fields 

    // ** TYPE - Can only be "dashboard" or "sdk"
    if (!type || !(["dashboard", "sdk"].includes(type))) {
        ws.close(1008, "Type can only be: dashboard or sdk. Please provide a valid type");
        return;
    };

    // ** API KEY - Extremely crucial for both the sdk and the dashboard stream
    const validationRes = validateApiKey(apiKey);
    if (validationRes) {
        ws.close(validationRes.code, validationRes.msg);
        return;
    }

    // ** TOKEN - This is crucial for dashboard streams but optional for sdk streams
    if (type === "dashboard" && !token) {
        ws.close(1008, "Token is required because type has been set to dashboard");
        return;
    };

    // ** REDACT KEYS - This is crucial and must be provided, although in the sdk
    // **               it isn't compulsory and that's because the internal sdk logic
    // **               already provides default's so if the array is empty it's safe
    // **               to assume someone has malicious intent
    if (!redactKeys) {
        ws.close(1008, "The redactKeys option must be provided and cannot be empty");
        return;
    };

    // Parse the redactKeys value because we expect an array
    let parsed: (any)[] | null = null;
    try {
        parsed = JSON.parse(redactKeys);
    } catch (err) {
        const msg = err?.message;
        ws.close(1008, msg);
        return;
    }

    if (!Array.isArray(parsed)) {
        ws.close(1008, "The redactKeys option must be an array");
        return;
    };

    if (parsed.some((key) => typeof key !== "string")) {
        ws.close(1008, "The redactKeys option must be an array of strings");
        return;
    }

    // -- Authenticate the person trying to connect
    let authData: AuthData | null = null;

    // ** Dashboard stream verification
    if (type === "dashboard") {
        const res = await verifyDashboardAccess(apiKey ?? "", token ?? "");

        // Handle unsuccesfull authentication
        if (!res.success || !res.data) {
            // Default code to server errors
            ws.close(res.code ?? 1011, res.msg);
            return;
        };

        authData = res.data;
    }

    // ** SDK stream verification
    if (type === "sdk") {
        const res = await verifySdkAccess(apiKey ?? "");
        // Handle unsuccesfull authentication
        if (!res.success || !res.data) {
            // Default code to server errors
            ws.close(res.code ?? 1011, res.msg);
            return;
        };

        authData = res.data;
    };

    // ** EDGECASE: If somehow authData is null or undefined even after verification
    if (!authData) {
        ws.close(1011, "An unexpected error occured during verification. Please try again shortly");
        return;
    };
});


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
     * This sends/emits a message to a connected socket/sockets
     * @param userId - The userId of the connection 
     * @param data - Data being emitted/sent 
     */
    public emit (userId: string, data: string | Object) {
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
    static isWsConnected (ws: WebSocket) {
        return ws.readyState === ws.OPEN;
    }

    /**
     * This method decodes buffers or binary data, processes and then
     * parses it into structured JSON
     * @param data - The JSON data being decoded
     */
    static decode (data: Buffer | ArrayBuffer) {
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
    static encode (data: Object) {
        const stringifiedJson = JSON.stringify(data);
        const concatenatedBuffer = Buffer.concat([Buffer.from([0]), Buffer.from(stringifiedJson)]);
        return concatenatedBuffer;
    };

    public async analzye () {
        try {} catch (err) {
            
        }
    }
}