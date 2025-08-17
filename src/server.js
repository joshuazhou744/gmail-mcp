import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod";
import { randomUUID } from 'crypto';
import { google } from "googleapis";
import { htmlToText } from 'html-to-text';
import CLIAuthenticator from './auth-cli.js';
import fs from 'fs';
import yaml from "js-yaml";
import dotenv from "dotenv";
import cors from "cors";
import { streamAgent } from './agent.js';

dotenv.config();

// Initialize CLI authenticator
const cliAuth = new CLIAuthenticator();

// Global auth state
let oauth2Client = null;
let gmailClient = null;
let authenticatedUserEmail = null;

// Auto-authenticate on startup
async function initializeAuthentication() {
    try {
        console.log('🚀 Initializing Gmail authentication...');
        
        // Authenticate using CLI flow - will prompt if no stored tokens
        oauth2Client = await cliAuth.authenticate();
        gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
        authenticatedUserEmail = await cliAuth.getUserEmail(gmailClient);
        
        console.log(`✅ Successfully authenticated as: ${authenticatedUserEmail}`);
        return true;
    } catch (error) {
        console.error('❌ Authentication failed:', error.message);
        console.log('💡 Please ensure you complete the authentication flow when prompted.');
        process.exit(1); // Exit since we require authentication for this server
    }
}

class Tools {
    // Convert string to base64 url (for email encoding)
    toBase64Url(str) {
        return Buffer.from(str)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    }

    // Check if auth states are set
    checkAuth() {
        return gmailClient && authenticatedUserEmail;
    }

    async createEmail(receivers, carbonCopy, subject, content) {
        try {
            if (!this.checkAuth()) {
                return "❌ Not authenticated. Please restart the server to authenticate.";
            }

            const to = receivers.join(", ");
            const cc = carbonCopy && carbonCopy.length > 0 ? carbonCopy.join(", ") : "";

            const message =
                `From: ${authenticatedUserEmail}\r\n` +
                `To: ${to}\r\n` +
                (cc ? `Cc: ${cc}\r\n` : "") +
                `Subject: ${subject}\r\n` +
                `Content-Type: text/plain; charset="UTF-8"\r\n\r\n${content}`;

            const encodedMessage = this.toBase64Url(message);

            await gmailClient.users.messages.send({
                userId: "me",
                requestBody: { raw: encodedMessage },
            });

            return `Email sent successfully!`;
        } catch (error) {
            console.error("Error sending email:", error);
            return `Failed to send email: ${error.message}`;
        }
    }

    async replyEmail(emailId, content) {
        try {
            if (!this.checkAuth()) {
                return "❌ Not authenticated. Please restart the server to authenticate.";
            }
    
            const originalEmail = await this.getEmail(emailId);
            
            if (typeof originalEmail === 'string') {
                return originalEmail; // Error message from getEmail
            }
    
            // Extract email addresses from the "From" header
            const fromEmail = originalEmail.sender;
            
            // Extract email from "Name <email@domain.com>" format
            const extractEmail = (emailString) => {
                const match = emailString.match(/<(.+?)>/);
                return match ? match[1] : emailString;
            };
            
            const replyTo = extractEmail(fromEmail);
    
            // Create the reply message
            const replyMessage = [
                `To: ${replyTo}`,
                `In-Reply-To: ${emailId}`,
                '',
                content
            ].join('\r\n');
    
            const encodedMessage = this.toBase64Url(replyMessage);
    
            await gmailClient.users.messages.send({
                userId: "me",
                requestBody: { 
                    raw: encodedMessage,
                    threadId: originalEmail.threadId 
                },
            });
    
            return "Reply sent successfully!";
        } catch (error) {
            console.error("Error sending reply:", error);
            return `Failed to send reply: ${error.message}`;
        }
    }

    async searchEmail(query, maxResults = 10) {
        try {
            if (!this.checkAuth()) {
                return "❌ Not authenticated. Please restart the server to authenticate.";
            }
            
            // Get a list of emails with the query
            const listResp = await gmailClient.users.messages.list({
                userId: "me",
                q: query,
                maxResults: maxResults,
            });
            
            const messages = listResp.data.messages || [];
            
            if (messages.length === 0) {
                return [];
            }
            
            // Get the full details for each message
            const emailDetails = [];
            for (const message of messages) {
                const detail = await gmailClient.users.messages.get({
                    userId: "me",
                    id: message.id,
                });
                
                const headers = detail.data.payload.headers;
                const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
                
                // Get the body
                let body = "";
                if (detail.data.payload.body.data) {
                    body = Buffer.from(detail.data.payload.body.data, 'base64').toString();
                } else if (detail.data.payload.parts) {
                    for (const part of detail.data.payload.parts) {
                        if (part.mimeType === 'text/plain' && part.body.data) {
                            body = Buffer.from(part.body.data, 'base64').toString();
                            break;
                        } else if (part.mimeType === 'text/html' && part.body.data) {
                            const htmlBody = Buffer.from(part.body.data, 'base64').toString();
                            body = htmlToText(htmlBody);
                            break;
                        }
                    }
                }
                
                emailDetails.push({
                    id: message.id,
                    sender: getHeader("from"),
                    receiver: getHeader("to"),
                    subject: getHeader("subject"),
                    date: getHeader("date"),
                    body: body.substring(0, 500) + (body.length > 500 ? "..." : "")
                });
            }
            
            return emailDetails;
        } catch (error) {
            console.error("Error searching emails:", error);
            return `Failed to search emails: ${error.message}`;
        }
    }

    async getEmail(emailId) {
        try {
            if (!this.checkAuth()) {
                return "❌ Not authenticated. Please restart the server to authenticate.";
            }
            
            const message = await gmailClient.users.messages.get({
                userId: "me",
                id: emailId,
            });
            
            const headers = message.data.payload.headers;
            const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
            
            // Get the body
            let body = "";
            if (message.data.payload.body.data) {
                body = Buffer.from(message.data.payload.body.data, 'base64').toString();
            } else if (message.data.payload.parts) {
                for (const part of message.data.payload.parts) {
                    if (part.mimeType === 'text/plain' && part.body.data) {
                        body = Buffer.from(part.body.data, 'base64').toString();
                        break;
                    } else if (part.mimeType === 'text/html' && part.body.data) {
                        const htmlBody = Buffer.from(part.body.data, 'base64').toString();
                        body = htmlToText(htmlBody);
                        break;
                    }
                }
            }
            
            return {
                id: emailId,
                sender: getHeader("from"),
                receiver: getHeader("to"),
                subject: getHeader("subject"),
                date: getHeader("date"),
                body: body,
                threadId: message.data.threadId
            };
        } catch (error) {
            console.error("Error getting email:", error);
            return `Failed to get email: ${error.message}`;
        }
    }
}

async function createMcpServer() {
    let toolsConfig;
    try {
        const yamlContent = fs.readFileSync('./tools-config.yaml', 'utf8');
        toolsConfig = yaml.load(yamlContent);
    } catch (error) {
        console.warn('Warning: Could not load tools-config.yaml, using defaults');
        toolsConfig = {
            tools: {
                createEmail: { description: 'Create and send an email' },
                replyEmail: { description: 'Reply to an email' },
                getEmail: { description: 'Get an email by ID' },
                searchEmail: { description: 'Search emails in inbox' }
            }
        };
    }

    const tools = new Tools();

    const server = new McpServer({
        name: "gmail-mcp-server",
        version: "1.0.0"
    }, {
        capabilities: {
            tools: {}
        }
    });

    server.registerTool("createEmail",
        {
            title: "Create and send email",
            description: toolsConfig.tools.createEmail.description,
            inputSchema: {
                receivers: z.array(z.string()).describe(toolsConfig.tools.createEmail.inputSchema.receivers.description),
                carbonCopy: z.array(z.string()).optional().describe(toolsConfig.tools.createEmail.inputSchema.carbonCopy.description),
                subject: z.string().describe(toolsConfig.tools.createEmail.inputSchema.subject.description),
                content: z.string().describe(toolsConfig.tools.createEmail.inputSchema.content.description)
            }
        },
        async ({receivers, carbonCopy, subject, content}) => ({
            content: [{type: "text", text: await tools.createEmail(receivers, carbonCopy || [], subject, content)}]
        })
    );

    server.registerTool("getEmail",
        {
            title: "Get email details",
            description: toolsConfig.tools.getEmail.description,
            inputSchema: {
                emailId: z.string().describe(toolsConfig.tools.getEmail.inputSchema.emailId.description)
            }
        },
        async ({emailId}) => ({
            content: [{type: "text", text: JSON.stringify(await tools.getEmail(emailId))}]
        })
        
    )

    server.registerTool("replyEmail",
        {
            title: "Reply to email",
            description: toolsConfig.tools.replyEmail.description,
            inputSchema: {
                emailId: z.string().describe(toolsConfig.tools.replyEmail.inputSchema.emailId.description),
                content: z.string().describe(toolsConfig.tools.replyEmail.inputSchema.content.description)
            }
        },
        async ({emailId, content}) => ({
            content: [{type: "text", text: JSON.stringify(await tools.replyEmail(emailId, content))}]
        })
        
    )

    server.registerTool("searchEmail",
        {
            title: "Search inbox for emails",
            description: toolsConfig.tools.searchEmail.description,
            inputSchema: {
                query: z.string().describe(toolsConfig.tools.searchEmail.inputSchema.query.description),
                maxResults: z.number().optional().default(10).describe(toolsConfig.tools.searchEmail.inputSchema.maxResults.description)
            }
        },
        async ({query, maxResults}) => ({
            content: [{type: "text", text: JSON.stringify(await tools.searchEmail(query, maxResults))}]
        })
    )

    return server;
}

const app = express();
app.use(express.json());
const transports = {};
let mcpServer = null;

// Initialize authentication on startup - will prompt if needed
console.log('🔐 Gmail MCP Server Starting...\n');
await initializeAuthentication();

// Create MCP server after successful authentication
mcpServer = await createMcpServer();

// CORS middleware
app.use(cors({
    origin: "*", // allow all origins
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Origin', 
        'X-Requested-With', 
        'Content-Type', 
        'Accept', 
        'Authorization', 
        'mcp-session-id'
    ]
}));

// MCP endpoint
app.post('/mcp', async (req, res) => {
    try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'];
        let transport;

        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // new session initialization request
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sessionId) => {
                    console.log("Session initialized: ", sessionId);
                    transports[sessionId] = transport;
                },
            });

            // clean up transport when closed
            transport.onclose = () => {
                if (transport.sessionId) {
                    delete transports[transport.sessionId];
                }
            };

            // connect to the MCP server
            await mcpServer.connect(transport);
        } else {
            // invalid request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: null,
            });
            return;
        }

        // handle the request
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('MCP request error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                id: req.body?.id || null,
                error: {
                    code: -32603,
                    message: 'Internal error',
                    data: error.message
                }
            });
        }
    }
});

// Health endpoint
app.get('/health', (_req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        services: {
            mcp: mcpServer ? 'connected' : 'disconnected',
            auth: gmailClient ? 'authenticated' : 'not_authenticated',
            gmail: gmailClient ? 'connected' : 'disconnected'
        },
        user: authenticatedUserEmail,
        activeConnections: Object.keys(transports).length
    };
    
    res.json(health);
});

// Simple status endpoint
app.get('/status', (_req, res) => {
    res.json({ 
        authenticated: !!gmailClient, 
        userEmail: authenticatedUserEmail,
        method: 'cli'
    });
});

// Logout endpoint (clears tokens and exits - requires restart)
app.post('/logout', async (_req, res) => {
    try {
        await cliAuth.clearStoredTokens();
        console.log('✅ Logged out successfully. Server will exit - restart to re-authenticate.');
        
        res.json({ 
            success: true, 
            message: 'Logged out successfully. Please restart the server to re-authenticate.' 
        });
        
        // Exit after a short delay to allow response to be sent
        setTimeout(() => {
            process.exit(0);
        }, 1000);
        
    } catch (error) {
        console.error('❌ Logout error:', error.message);
        res.status(500).json({ 
            error: 'Logout failed', 
            message: error.message 
        });
    }
});

app.post('/api/chat/stream', async (req, res) => {
    try {
        const { message, sessionId } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        // Generate unique session ID if not provided
        const actualSessionId = sessionId || `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Set up Server-Sent Events
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Credentials': 'true'
        });

        // Send initial connection confirmation with session ID
        res.write(`data: ${JSON.stringify({ 
            type: 'connected',
            sessionId: actualSessionId 
        })}\n\n`);

        let fullResponse = '';
        
        try {
            await streamAgent(
                message,
                (chunk) => {
                    // Send incremental updates
                    const data = {
                        type: 'chunk',
                        content: chunk,
                        timestamp: new Date().toISOString()
                    };
                    res.write(`data: ${JSON.stringify(data)}\n\n`);
                    fullResponse = chunk;
                },
                actualSessionId
            );

            // Send completion signal
            res.write(`data: ${JSON.stringify({ 
                type: 'complete', 
                content: fullResponse,
                sessionId: actualSessionId,
                timestamp: new Date().toISOString()
            })}\n\n`);
            
        } catch (streamError) {
            res.write(`data: ${JSON.stringify({ 
                type: 'error', 
                error: streamError.message,
            })}\n\n`);
        }

        res.end();
    } catch (error) {
        console.error('Stream error:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Internal server error', 
                message: error.message 
            });
        }
    }
});

const PORT = 3001;

app.listen(PORT, () => {
    console.log(`\n🚀 Gmail MCP Server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📈 Status: http://localhost:${PORT}/status`);
    console.log(`✅ Server ready and authenticated as: ${authenticatedUserEmail}`);
    console.log('\n💡 The server will automatically prompt for authentication on startup if needed.');
    console.log('🔄 Use POST /logout to clear tokens and restart for re-authentication.\n');
});