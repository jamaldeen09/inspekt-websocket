import { ExtendedWs } from "../types";

class ConnectionManager {
    public sdkConnections = new Map<string, ExtendedWs>();
    public dashboardConnections = new Map<string, Set<ExtendedWs>>();
    private _heartbeatInterval: NodeJS.Timeout | null = null;

    /**
     * Initializes a singleton background monitor to prune inactive connections.
     * 
     * @description
     * This method starts a global 30-second cycle that iterates through every active
     * SDK and Dashboard connection. It relies on a "guilty until proven innocent" 
     * approach: every socket is marked as dead (`isAlive = false`) and must prove 
     * it is still active by sending a "ping" before the next cycle. 
     */
    public startHeartbeat() {
        if (this._heartbeatInterval) return;

        this._heartbeatInterval = setInterval(() => {
            // For Maps (Sdk): (value, key, map)
            this.sdkConnections.forEach((ws, userId) => {
                this.manage(ws, this.sdkConnections, userId);
            });

            // For Nested Sets (Dashboards):
            this.dashboardConnections.forEach((clientSet, userId) => {
                clientSet.forEach((ws) => {
                    this.manage(ws, clientSet);
                });

                // Cleanup: If a user has 0 dashboard tabs open, delete the empty Set
                if (clientSet.size === 0) {
                    this.dashboardConnections.delete(userId);
                }
            });
        }, 30000);
    }

    /**
     * Registers a newly authenticated socket into the appropriate connection pool.
     * 
     * @param {"sdk" | "dashboard"} args.connectionList - The target pool for the socket.
     * @param {string} args.userId - The unique identifier (API Key or UUID) for the owner.
     * @param {ExtendedWs} args.socket - The WebSocket instance to be managed.
     * @description
     * Handles the logic for mapping sockets to users. 
     * - For SDKs: Enforces a 1-to-1 relationship (prevents duplicate connections).
     * - For Dashboards: Adds the socket to a Set, allowing a single user to maintain 
     *   multiple active sessions (e.g., across different browser tabs).
     */
    public newSocket({ connectionList, userId, socket }: {
        connectionList: "sdk" | "dashboard",
        userId: string,
        socket: ExtendedWs
    }) {
        if (connectionList === "sdk") {
            this.sdkConnections.set(userId, socket);
            return;
        } else {
            const sockets = this.dashboardConnections.get(userId);
            // Substance check: You likely need to initialize the Set if it doesn't exist
            if (!sockets || sockets.size === 0) {
                this.dashboardConnections.set(userId, new Set([socket]));
                return;
            };

            sockets.add(socket);
        }
    };

    /**
      * Returns a boolean that confirms if 
      * a websocket connection is connected/alive
      * @param ws 
    */
    static isWsConnected(ws: ExtendedWs) {
        return ws.readyState === ws.OPEN;
    }

    /**
     * Evaluates the health of a single socket and resets its heartbeat flag.
     * 
     * @param {ExtendedWs} ws - The WebSocket instance to evaluate.
     * @private
     * @description
     * The core execution logic for the heartbeat monitor. If a socket's `isAlive` 
     * property is still false from the previous interval, the connection is 
     * forcefully terminated and the socket is deleted for it's pool. Otherwise, it is reset to false.
     */
    private manage(ws: ExtendedWs, collection: Map<any, any> | Set<any>, key?: any) {
        if (ws.isAlive === false) {
            ws.terminate();

            // Dynamically remove from whichever collection it's in
            if (collection instanceof Map) {
                collection.delete(key);
            } else if (collection instanceof Set) {
                collection.delete(ws);
            }

            console.log(`[Connection] Dead socket removed from pool. Current size: ${collection.size}`);
            return;
        }

        ws.isAlive = false;
    }
}

const connectionManager = new ConnectionManager();
export { ConnectionManager, connectionManager };