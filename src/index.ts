import { WebSocketServer } from 'ws';
import { AnalysisMode, AnalysisResult, AuthData, ConfigOptions, ConnectionType } from './types';
import { validateApiKey } from './lib/utils';
import { verifyDashboardAccess, verifySdkAccess } from './lib/supabase/authentication';
import InspektStream from './lib/inspekt/inspekt-stream';

// Websocket server init
const wss = new WebSocketServer({ port: 4090 });

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

    // -- Create a new inspekt stream
    const inspektStream = new InspektStream(authData, { 
        redactKeys: parsed, 
        analysisMode: analysisMode as ConfigOptions["analysisMode"],
        type,
        apiKey: apiKey ?? "",
    });

    // Add the verified user to the connections Map()
    inspektStream.newSocketUser(ws);

    // -- Listen for new message events
    ws.onmessage = (event) => {
        const decoded = InspektStream.decode(event.data as any);

        if ("event" in decoded && decoded.event === "analysis:request") {
            return inspektStream.log(decoded.data);
        }
    };


    ws.onclose = (event) => {
        inspektStream.removeSocketUser(ws);
    }
});

