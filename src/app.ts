import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { IncomingMessage } from 'http';
import { Server } from 'http';

// Types
interface ClientConnection {
    ws: WebSocket;
    room: Room;
}

interface ProxyMessage {
    type: 'yahoo_message' | 'room_joined' | 'yahoo_connected' | 'yahoo_disconnected' | 'yahoo_error' | 'yahoo_max_reconnect_reached';
    data?: string;
    message?: string;
    error?: string;
    code?: number;
    reason?: string;
    roomId?: string;
    yahooConnected?: boolean;
    clientsCount?: number;
    draftPosition?: number;
}

interface ClientMessage {
    type: 'yahoo_message' | 'yahoo_reconnect';
    data: string | ReconnectData;
}

interface ReconnectData {
    leagueId: string;
    draftPosition: number;
}

interface Config {
    port: number;
    shutdownTimeoutMs: number;
    env: string;
    maxReconnectAttempts?: number;
    heartbeatInterval?: number;
    connectionTimeout?: number;
}

interface Logger {
    info: (message: any, ...args: any[]) => void;
    error: (message: any, ...args: any[]) => void;
    warn: (message: any, ...args: any[]) => void;
    debug: (message: any, ...args: any[]) => void;
}

// Store active rooms and connections
const rooms = new Map<string, Room>(); // Map<roomId, Room>
const clientConnections = new Map<string, ClientConnection>(); // Map<clientId, ClientConnection>

class Room {
    public readonly id: string;
    public readonly leagueId: string;
    public readonly draftPosition: number; // Primary draft position for Yahoo connection
    public readonly yahooWebSocketUrl: string;
    public readonly platformUserId: string; // Store platform user ID
    public yahooWs: WebSocket | null = null;
    public clients: Map<WebSocket, { clientId: string; draftPosition: number }> = new Map(); // Map of client to their info
    public isConnectingToYahoo: boolean = false;
    public lastHeartbeat: number = Date.now();
    public reconnectAttempts: number = 0;
    public readonly maxReconnectAttempts: number;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private logger: Logger;
    private connectionTimeout: number;
    private isIntentionalDisconnect: boolean = false; // Track if disconnect is intentional
    private hasJoined: boolean = false; // Track if we've sent the join message
    private cleanupTimeout: NodeJS.Timeout | null = null; // Delay room cleanup for rapid reconnections
    
    constructor(
        leagueId: string, 
        draftPosition: number, 
        yahooWebSocketUrl: string, 
        platformUserId: string,
        logger: Logger,
        maxReconnectAttempts: number = 5,
        connectionTimeout: number = 10000
    ) {
        this.id = leagueId; // Room ID is just the league ID
        this.leagueId = leagueId;
        this.draftPosition = draftPosition;
        this.yahooWebSocketUrl = yahooWebSocketUrl;
        this.platformUserId = platformUserId;
        this.logger = logger;
        this.maxReconnectAttempts = maxReconnectAttempts;
        this.connectionTimeout = connectionTimeout;
        
        this.logger.info(`📝 Created room: ${this.id} for Yahoo URL: ${yahooWebSocketUrl}`);
    }

    async connectToYahoo(): Promise<void> {
        if (this.isConnectingToYahoo || (this.yahooWs && this.yahooWs.readyState === WebSocket.OPEN)) {
            return;
        }

        this.isConnectingToYahoo = true;
        this.logger.info(`🔗 Connecting to Yahoo WebSocket for room ${this.id}...`);

        try {
            // Create connection to Yahoo WITHOUT Origin header
            this.yahooWs = new WebSocket(this.yahooWebSocketUrl, {
                headers: {
                    'User-Agent': 'YahooFantasyProxy/1.0',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    // Explicitly NO Origin header
                },
                timeout: this.connectionTimeout
            });

            this.yahooWs.on('open', () => {
                this.logger.info(`✅ Connected to Yahoo WebSocket for room ${this.id}`);
                this.isConnectingToYahoo = false;
                this.reconnectAttempts = 0;
                this.hasJoined = false; // Reset join status on new connection
                
                // Send join message to Yahoo immediately upon connection
                this.sendJoinMessageToYahoo();
                this.startHeartbeat();
                
                // Notify all clients that Yahoo connection is established
                this.broadcastToClients({
                    type: 'yahoo_connected',
                    message: 'Connected to Yahoo WebSocket'
                });
            });

            this.yahooWs.on('message', (data: WebSocket.RawData) => {
                const message = data.toString();
                this.logger.debug(`📨 Yahoo message for room ${this.id}:`, message.substring(0, 100) + '...');
                
                // Relay message to all clients in this room
                this.broadcastToClients({
                    type: 'yahoo_message',
                    data: message
                });
            });

            this.yahooWs.on('close', (code: number, reason: Buffer) => {
                this.logger.info(`🔌 Yahoo WebSocket closed for room ${this.id}: ${code} - ${reason.toString()}`);
                this.isConnectingToYahoo = false;
                this.stopHeartbeat();
                
                // Notify clients
                this.broadcastToClients({
                    type: 'yahoo_disconnected',
                    code: code,
                    reason: reason.toString()
                });

                // Do NOT automatically reconnect - wait for client to initiate reconnection
                this.logger.info(`⏳ Yahoo disconnected for room ${this.id} - waiting for client to initiate reconnection`);
            });

            this.yahooWs.on('error', (error: Error) => {
                this.logger.error(`❌ Yahoo WebSocket error for room ${this.id}:`, error);
                this.isConnectingToYahoo = false;
                
                this.broadcastToClients({
                    type: 'yahoo_error',
                    error: error.message
                });
            });

        } catch (error) {
            this.logger.error(`❌ Failed to connect to Yahoo for room ${this.id}:`, error);
            this.isConnectingToYahoo = false;
            throw error;
        }
    }

    public sendJoinMessageToYahoo(): void {
        if (this.yahooWs && this.yahooWs.readyState === WebSocket.OPEN && !this.hasJoined) {
            // Yahoo join message format: 8|{LEAGUE_ID}|{DRAFT_POSITION}|{USER_AGENT}|
            // Build from the room's stored parameters
            const userAgent = encodeURIComponent(`YahooFantasyProxy/1.0 (${this.platformUserId})`);
            const joinMessage = `8|${this.leagueId}|${this.draftPosition}|${userAgent}|`;
            
            this.yahooWs.send(joinMessage);
            this.hasJoined = true;
            
            this.logger.info(`📤 Sent Yahoo join message for room ${this.id}:`, {
                leagueId: this.leagueId,
                draftPosition: this.draftPosition,
                platformUserId: this.platformUserId,
                message: joinMessage
            });
        } else if (this.hasJoined) {
            this.logger.debug(`ℹ️ Join message already sent for room ${this.id}`);
        } else {
            this.logger.warn(`⚠️ Cannot send join message to Yahoo - not connected in room ${this.id}`);
        }
    }

    // New method to handle client-initiated reconnection
    public async handleClientReconnectRequest(reconnectData: ReconnectData): Promise<void> {
        this.logger.info(`🔄 Client-initiated reconnection request for room ${this.id}:`, reconnectData);
        
        // Validate the reconnection data
        if (reconnectData.leagueId !== this.leagueId) {
            this.logger.warn(`⚠️ League ID mismatch in reconnect request: expected ${this.leagueId}, got ${reconnectData.leagueId}`);
            throw new Error(`League ID mismatch: expected ${this.leagueId}, got ${reconnectData.leagueId}`);
        }
        
        // Update draft position if it has changed
        if (reconnectData.draftPosition !== this.draftPosition) {
            this.logger.info(`📝 Updating draft position for room ${this.id}: ${this.draftPosition} -> ${reconnectData.draftPosition}`);
            (this as any).draftPosition = reconnectData.draftPosition; // Cast to bypass readonly
        }
        
        // Close existing connection if any
        if (this.yahooWs) {
            this.isIntentionalDisconnect = true;
            this.yahooWs.close(1000, 'Client-initiated reconnection');
            this.yahooWs = null;
        }
        
        // Reset connection state
        this.isIntentionalDisconnect = false;
        this.hasJoined = false;
        
        try {
            // Attempt to reconnect using stored room data
            await this.connectToYahoo();
            this.logger.info(`✅ Client-initiated reconnection successful for room ${this.id}`);
        } catch (error) {
            this.logger.error(`❌ Client-initiated reconnection failed for room ${this.id}:`, error);
            throw error;
        }
    }

    private startHeartbeat(): void {
        this.heartbeatInterval = setInterval(() => {
            if (this.yahooWs && this.yahooWs.readyState === WebSocket.OPEN) {
                this.yahooWs.send('c'); // Yahoo heartbeat
                this.lastHeartbeat = Date.now();
            }
        }, 30000); // Every 30 seconds
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    public addClient(clientWs: WebSocket, clientId: string, clientDraftPosition: number): void {
        // Cancel any pending cleanup if a new client is joining
        if (this.cleanupTimeout) {
            clearTimeout(this.cleanupTimeout);
            this.cleanupTimeout = null;
            this.logger.info(`⏸️ Cancelled pending room cleanup for room ${this.id} - new client joining`);
        }
        
        // If there are existing clients, force disconnect and reconnect to Yahoo
        // This ensures we get a fresh initialization message from the server
        if (this.clients.size > 0 || (this.yahooWs && this.yahooWs.readyState === WebSocket.OPEN)) {
            this.logger.info(`🔄 New client joining room ${this.id} - forcing Yahoo reconnection for fresh initialization`);
            
            // Close existing Yahoo connection
            if (this.yahooWs) {
                this.isIntentionalDisconnect = true;
                this.yahooWs.close(1000, 'New client joined - forcing reconnection');
                this.yahooWs = null;
            }
            
            // Reset connection state
            this.isIntentionalDisconnect = false;
            this.hasJoined = false;
        }
        
        this.clients.set(clientWs, { clientId, draftPosition: clientDraftPosition });
        (clientWs as any).roomId = this.id;
        (clientWs as any).clientId = clientId;
        (clientWs as any).draftPosition = clientDraftPosition;
        
        this.logger.info(`👤 Client ${clientId} (draft position ${clientDraftPosition}) joined room ${this.id}. Total clients: ${this.clients.size}`);
        
        // Always connect/reconnect to Yahoo when a new client joins
        this.connectToYahoo();
        
        // Send current status to the new client
        clientWs.send(JSON.stringify({
            type: 'room_joined',
            roomId: this.id,
            yahooConnected: false, // Will be false since we're reconnecting
            clientsCount: this.clients.size,
            draftPosition: clientDraftPosition
        } as ProxyMessage));
    }

    public removeClient(clientWs: WebSocket): void {
        const clientInfo = this.clients.get(clientWs);
        this.clients.delete(clientWs);
        
        if (clientInfo) {
            this.logger.info(`👤 Client ${clientInfo.clientId} (draft position ${clientInfo.draftPosition}) left room ${this.id}. Remaining clients: ${this.clients.size}`);
        }
        
        // If no clients remain, schedule cleanup with a delay to handle rapid reconnections
        if (this.clients.size === 0) {
            this.logger.info(`⏱️ Room ${this.id} is empty, scheduling cleanup in 2 seconds...`);
            
            // Cancel any existing cleanup timeout
            if (this.cleanupTimeout) {
                clearTimeout(this.cleanupTimeout);
            }
            
            // Schedule cleanup after a delay to handle browser refreshes
            this.cleanupTimeout = setTimeout(() => {
                this.logger.info(`🧹 Cleaning up empty room ${this.id}`);
                this.disconnectFromYahoo();
                this.cleanup();
                rooms.delete(this.id);
            }, 2000); // 2 second delay
        }
    }

    private broadcastToClients(message: ProxyMessage): void {
        const messageStr = JSON.stringify(message);
        this.clients.forEach((clientInfo, clientWs) => {
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(messageStr);
            }
        });
    }

    public sendToYahoo(message: string): void {
        if (this.yahooWs && this.yahooWs.readyState === WebSocket.OPEN) {
            this.logger.debug(`📤 Sending to Yahoo from room ${this.id}:`, message);
            this.yahooWs.send(message);
        } else {
            this.logger.warn(`⚠️ Cannot send to Yahoo - not connected in room ${this.id}`);
        }
    }

    private disconnectFromYahoo(): void {
        this.logger.info(`🔌 Intentionally disconnecting from Yahoo for room ${this.id}`);
        this.isIntentionalDisconnect = true;
        this.hasJoined = false; // Reset join status
        
        if (this.yahooWs) {
            this.yahooWs.close(1000, 'No clients remaining in room');
        }
    }

    public cleanup(): void {
        this.logger.info(`🧹 Cleaning up room ${this.id}`);
        this.isIntentionalDisconnect = true;
        this.hasJoined = false; // Reset join status
        this.stopHeartbeat();
        
        // Clear any pending cleanup timeout
        if (this.cleanupTimeout) {
            clearTimeout(this.cleanupTimeout);
            this.cleanupTimeout = null;
        }
        
        if (this.yahooWs) {
            this.yahooWs.close(1000, 'Room cleanup');
            this.yahooWs = null;
        }
        
        this.clients.clear();
    }

    public getStatus() {
        const clientPositions = Array.from(this.clients.values()).map(client => client.draftPosition);
        return {
            roomId: this.id,
            leagueId: this.leagueId,
            draftPosition: this.draftPosition, // Primary position used for Yahoo connection
            platformUserId: this.platformUserId,
            clientsCount: this.clients.size,
            clientDraftPositions: clientPositions, // All client positions in this room
            yahooConnected: this.yahooWs && this.yahooWs.readyState === WebSocket.OPEN,
            hasJoined: this.hasJoined, // Whether join message was sent
            lastHeartbeat: this.lastHeartbeat,
            reconnectAttempts: this.reconnectAttempts,
            isIntentionalDisconnect: this.isIntentionalDisconnect
        };
    }
}

export class YahooWebSocketProxyApp {
    private app: express.Application;
    private wss: WebSocketServer | null = null;
    private config: Config;
    private logger: Logger;

    constructor(config: Config, logger: Logger) {
        this.config = config;
        this.logger = logger;
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    private setupMiddleware(): void {
        // Enable CORS for all routes
        this.app.use(cors({
            origin: true,
            credentials: true
        }));

        this.app.use(express.json());
    }

    private setupRoutes(): void {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                activeRooms: rooms.size,
                totalClients: clientConnections.size,
                rooms: Array.from(rooms.keys())
            });
        });

        // Get room status
        this.app.get('/rooms/:roomId/status', (req, res) => {
            const room = rooms.get(req.params.roomId);
            if (!room) {
                return res.status(404).json({ error: 'Room not found' });
            }
            
            res.json(room.getStatus());
        });

        // Get all rooms status
        this.app.get('/rooms', (req, res) => {
            const roomsStatus = Array.from(rooms.values()).map(room => room.getStatus());
            res.json({
                totalRooms: rooms.size,
                rooms: roomsStatus
            });
        });

        // Force cleanup a room (admin endpoint)
        this.app.delete('/rooms/:roomId', (req, res) => {
            const room = rooms.get(req.params.roomId);
            if (!room) {
                return res.status(404).json({ error: 'Room not found' });
            }
            
            this.logger.info(`🗑️ Force cleanup requested for room ${req.params.roomId}`);
            
            // Close all client connections in this room
            room.clients.forEach((clientInfo, clientWs) => {
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.close(1001, 'Room force cleanup');
                }
            });
            
            // Cleanup the room
            room.cleanup();
            rooms.delete(req.params.roomId);
            
            res.json({ 
                message: `Room ${req.params.roomId} has been cleaned up`,
                roomId: req.params.roomId
            });
        });
    }

    public setupWebSocketServer(server: Server): void {
        // WebSocket server for client connections
        this.wss = new WebSocketServer({ 
            server,
            path: '/yahoo/websocket/connection'
        });

        this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
            const url = new URL(request.url!, `http://${request.headers.host}`);
            const params = url.searchParams;
            
            const leagueId = params.get('leagueId');
            const draftPosition = parseInt(params.get('draftPosition') || '0');
            const yahooWebSocketUrl = params.get('websocketUrl');
            const platformUserId = params.get('platformUserId') || 'unknown';
            
            if (!leagueId || !draftPosition || !yahooWebSocketUrl) {
                ws.close(1008, 'Missing required parameters: leagueId, draftPosition, websocketUrl');
                return;
            }

            const clientId = uuidv4();
            const roomId = leagueId; // Room ID is just the league ID
            
            this.logger.info(`🔗 New client connection for room ${roomId}, client: ${clientId}, draft position: ${draftPosition}`);
            
            // Get or create room
            let room = rooms.get(roomId);
            if (!room) {
                room = new Room(
                    leagueId, 
                    draftPosition, // Use this client's draft position for Yahoo connection
                    yahooWebSocketUrl,
                    platformUserId, // Pass platform user ID for join message
                    this.logger,
                    this.config.maxReconnectAttempts || 5,
                    this.config.connectionTimeout || 10000
                );
                rooms.set(roomId, room);
            } else {
                // If room exists but has a different websocket URL, we should recreate it
                // This handles cases where the Yahoo websocket URL might have changed
                if (room.yahooWebSocketUrl !== yahooWebSocketUrl) {
                    this.logger.info(`🔄 Room ${roomId} exists but with different Yahoo URL, recreating room`);
                    room.cleanup();
                    room = new Room(
                        leagueId, 
                        draftPosition,
                        yahooWebSocketUrl,
                        platformUserId,
                        this.logger,
                        this.config.maxReconnectAttempts || 5,
                        this.config.connectionTimeout || 10000
                    );
                    rooms.set(roomId, room);
                }
            }
            
            // Add client to room with their specific draft position
            room.addClient(ws, clientId, draftPosition);
            clientConnections.set(clientId, { ws, room });

            // Handle messages from client
            ws.on('message', (data: WebSocket.RawData) => {
                try {
                    const message = data.toString();
                    this.logger.debug(`📨 Client message from ${clientId}:`, message);
                    
                    // Check if it's a JSON control message or raw Yahoo message
                    try {
                        const jsonMessage: ClientMessage = JSON.parse(message);
                        if (jsonMessage.type === 'yahoo_message') {
                            // Client wants to send a message to Yahoo
                            room!.sendToYahoo(jsonMessage.data as string);
                        } else if (jsonMessage.type === 'yahoo_reconnect') {
                            // Client wants to reconnect to Yahoo
                            const reconnectData = jsonMessage.data as ReconnectData;
                            this.logger.info(`🔄 Client ${clientId} requested Yahoo reconnection:`, reconnectData);
                            
                            room!.handleClientReconnectRequest(reconnectData).catch(error => {
                                this.logger.error(`❌ Failed to handle client reconnection for ${clientId}:`, error);
                                ws.send(JSON.stringify({
                                    type: 'yahoo_error',
                                    error: 'Failed to reconnect to Yahoo'
                                }));
                            });
                        } else {
                            this.logger.debug(`🎛️ Control message from client ${clientId}:`, jsonMessage);
                        }
                    } catch {
                        // Not JSON, treat as raw Yahoo message
                        room!.sendToYahoo(message);
                    }
                } catch (error) {
                    this.logger.error(`❌ Error handling client message from ${clientId}:`, error);
                }
            });

            ws.on('close', (code: number, reason: Buffer) => {
                this.logger.info(`🔌 Client ${clientId} disconnected: ${code} - ${reason.toString()}`);
                room!.removeClient(ws);
                clientConnections.delete(clientId);
            });

            ws.on('error', (error: Error) => {
                this.logger.error(`❌ Client WebSocket error for ${clientId}:`, error);
            });
        });

        this.logger.info(`📡 WebSocket server setup on path: /yahoo/websocket/connection`);
    }

    public get requestListener() {
        return this.app;
    }

    public async shutdown(): Promise<void> {
        this.logger.info('🛑 Shutting down Yahoo WebSocket Proxy...');
        
        // Close all WebSocket connections
        if (this.wss) {
            this.wss.clients.forEach((ws) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close(1001, 'Server shutdown');
                }
            });
            this.wss.close();
        }

        // Cleanup all rooms
        rooms.forEach(room => room.cleanup());
        rooms.clear();
        clientConnections.clear();

        this.logger.info('✅ Yahoo WebSocket Proxy shutdown complete');
    }
}

export async function initApp(config: Config, logger: Logger): Promise<YahooWebSocketProxyApp> {
    logger.info('🚀 Initializing Yahoo WebSocket Proxy App...');
    
    const app = new YahooWebSocketProxyApp(config, logger);
    
    logger.info('✅ Yahoo WebSocket Proxy App initialized');
    return app;
}