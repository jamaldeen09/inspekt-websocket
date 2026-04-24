import { createHash } from "crypto";
import adminClient from "./client";

type Res = { 
    success: boolean; 
    msg: string; 
    data?: { userId: string; keyId: string; userPlan: "free" | "pro"}
    code?: number;
}

/**
 * Hashes an API key
 * @param apiKey - The API key being hashed
 */
export async function hashApiKey (apiKey: string) {
    const hashedKey = createHash("sha256").update(apiKey).digest("hex");
    return hashedKey;
};

/**
 * Verifies a connection wishing to get the dashboard stream
 * @param apiKey - The ID of the API key to monitor
 * @param token - The Supabase JWT from the client session
 * @param ws - The WebSocket instance
 */
export async function verifyDashboardAccess(apiKey: string, token: string): Promise<Res> {
    try {
        // Validate the User via the JWT
        const { data: { user }, error: authError } = await adminClient.auth.getUser(token);

        if (authError || !user) {
            return { 
                success: false, 
                msg: "Invalid or expired session token" ,
                code: 4001,
            };
        }

        // Cross-reference ownership in the public.api_keys table
        // Note: Using Service Role client here to bypass RLS for the check
        const hashedKey = hashApiKey(apiKey);
        const { data: keyData, error: dbError } = await adminClient
            .from("api_keys")
            .select("user_id, id")
            .eq("hash", hashedKey)
            .single();

        if (dbError || !keyData) {
            return { 
                success: false, 
                msg: "API key not found", 
                code: 4002,
            };
        }

        // Ensure the authenticated user is the owner of this key
        if (keyData.user_id !== user.id) {
            console.warn(`[Dashboard verification] Unauthorized access attempt: User ${user.id} tried to access key ${apiKey}`);
            return { 
                success: false,
                msg: "Unauthorized: You do not own this API key",
                code: 4003,
            };
        };

        // Fetch the user's plan because it'll be needed
        // for innacting limitations
        const { data } = await adminClient.from("users").select("plan").eq("id", user.id).single();
        if (!data) {
            return {
                success: false,
                msg: "Your account was not found. Please create an account at https://inspekt.app.com",
                code: 4002,
            }
        }

        return { 
            success: true, 
            msg: "Access granted",
            data: { 
                userId: user.id, 
                keyId: keyData.id, 
                userPlan: data.plan,
            }
        };
    } catch (err: any) {
        console.error("Dashboard Verification Error:", err);
        return { 
            success: false, 
            msg: err?.message || "An internal server error occured during verification",
            code: 1011,
        };
    }
};


/**
 * Verifies an SDK connection using the secret API Key string
 * @param apiKey - The full secret key (e.g., 'ins_live_...')
 */
export async function verifySdkAccess(apiKey: string): Promise<Res> {
    try {
        // Check the database for the provided secret key
        // We select 'id' and 'user_id' to confirm existence and for later mapping
        const hashedKey = hashApiKey(apiKey);
        const { data: keyData, error } = await adminClient
            .from("api_keys")
            .select("id, user_id")
            .eq("hash", hashedKey)
            .single();

        if (error || !keyData) {
            return { 
                success: false, 
                msg: "Invalid API Key. Please check your configuration" ,
                code: 4002
            };
        }


        // Fetch the user's plan because it'll be needed
        // for innacting limitations
        const { data } = await adminClient.from("users").select("plan").eq("id", keyData.user_id).single();
        if (!data) {
            return {
                success: false,
                msg: "Your account was not found. Please create an account at https://inspekt.app.com",
                code: 4002,
            }
        }

        // TODO: (Optional) Check if the user is suspended or over limits here
        // TODO-CONTD: This is where you'd integrate the 'refill_at' logic we discussed earlier.

        return { 
            success: true, 
            msg: "SDK Authentication successful",
            data: { 
                keyId: keyData.id, 
                userId: keyData.user_id, 
                userPlan: data.plan 
            }
        };
    } catch (err: any) {
        console.error("SDK Verification Error:", err);
        return { 
            success: false, 
            msg: err?.message || "An internal server error occured during verification",
            code: 1011,
        };
    }
}