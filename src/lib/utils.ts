import { ValidationRes } from "../types";

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
