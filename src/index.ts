import { WebSocketServer } from 'ws';
import { AnalysisMode, AuthData, ConfigOptions, ConnectionType, ExtendedWs, JsonSocketMessage } from './types';
import { validateApiKey } from './lib/utils';
import { verifyDashboardAccess, verifySdkAccess } from './lib/supabase/authentication';
import InspektStream from './lib/InsektStream';
import { connectionManager } from './lib/ConnectionManager';

// Websocket server init
const wss = new WebSocketServer({ port: 4090 });

// Mount the heartbeat that manages socket connections
connectionManager.startHeartbeat();

wss.on("connection", (ws: ExtendedWs, req) => {
    // We catch the packets now, and process them later
    // AFTER confirming the identity of the socket
    let unprocessesMsgs: any[] = [];
    let inspektStreamInstance: InspektStream | null = null;

    // Message event
    ws.onmessage = (event) => {
        const message = typeof event.data === "string" ? event.data : InspektStream.decode(event.data);

        // Allow pings
        if (message === "ping") {
            if (inspektStreamInstance) inspektStreamInstance.handlePing(ws, inspektStreamInstance.authData.userId);
            else unprocessesMsgs.push(message);
            return;
        }

        // Now that we know it has to be a json
        // message we make sure the event is valid 
        const isValidEvent =
            typeof message === "object" &&
            message !== null &&
            "event" in message &&
            message.event === "new:analysis" && "data" in message;

        if (!isValidEvent) return;

        if (inspektStreamInstance) {
            inspektStreamInstance.log(message.data);
        } else { unprocessesMsgs.push(message) }
    };

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
    const keyId = searchParams.get("keyId");

    // -- Validate the compulsory fields 

    // ** TYPE - Can only be "dashboard" or "sdk"
    if (!type || !(["dashboard", "sdk"].includes(type))) {
        ws.close(1008, "Type can only be: dashboard or sdk. Please provide a valid type");
        return;
    };

    if (type === "sdk") {
        // ** API KEY - Extremely crucial for both the dashboard stream
        const res = validateApiKey(apiKey);
        if (res) {
            ws.close(res.code, res.msg);
            return;
        };
    }

    if (type === "dashboard") {
        if (!token) {
            // ** TOKEN - This is crucial for dashboard streams but optional for sdk streams
            ws.close(1008, "Token is required because type has been set to dashboard");
            return;
        } else if (!keyId) {
            // ** KEYID - This is extremely crucial for dashboard streams because
            //            this is how we know which key the logs belong to
            ws.close(4002, "Key ID is missing");
            return;
        }
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

    // Authenticate the socket
    (async () => {
        // -- Authenticate the person trying to connect
        let authData: AuthData | null = null;

        // ** Dashboard stream verification
        if (type === "dashboard") {
            const res = await verifyDashboardAccess(keyId ?? "", token ?? "");

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

        // -- Create a new inspekt stream
        inspektStreamInstance = new InspektStream(authData!, {
            redactKeys: parsed,
            analysisMode: analysisMode as ConfigOptions["analysisMode"],
            type,
            apiKey: apiKey ?? "",
        });

        // Set the isAlive property to true
        console.log(`[Connection]: User ${authData!.userId} is connected`);
        ws.isAlive = true;

        // Add the socket a the appropriate pool
        connectionManager.newSocket({
            connectionList: inspektStreamInstance.configOptions.type,
            userId: inspektStreamInstance.authData.userId,
            socket: ws,
        });

        // -- Process the unprocessed messages
        unprocessesMsgs.forEach((msg) => {

            // Handle unprocessed ping messages
            if (typeof msg === "string" && msg === "ping") {
                inspektStreamInstance!.handlePing(ws, authData!.userId);
                return;
            }

            // Handle unprocessed json messages
            else {
                const typed = msg as JsonSocketMessage;
                switch (typed.event) {
                    case "new:analysis":
                        inspektStreamInstance!.log(typed.data);
                        break;
                }
            };
        });

        // Reset the unprocessed messages
        unprocessesMsgs = [];
    })();
});

