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

// initialize CLI authenticator for Google OAuth
const cliAuth = new CLIAuthenticator();

// global authentication state variables
let oauth2Client = null;
let gmailClient = null;
let authenticatedUserEmail = null;

// authenticate with Gmail on server startup
async function initializeAuthentication() {
    try {
        console.log('Initializing Gmail authentication...');
        
        // authenticate using CLI flow will prompt user if no stored tokens
        oauth2Client = await cliAuth.authenticate();
        gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
        authenticatedUserEmail = await cliAuth.getUserEmail(gmailClient);
        
        console.log(`✅ Successfully authenticated as: ${authenticatedUserEmail}`);
        return true;
    } catch (error) {
        console.error('❌ Authentication failed:', error.message);
        console.log('💡 Please ensure you complete the authentication flow when prompted.');
        process.exit(1); // exit since authentication is required for this server
    }
}

// email tools class that provides Gmail functionality
class Tools {
    // convert string to base64 url format for Gmail API
    toBase64Url(str) {
        return Buffer.from(str)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    }

    // check if Gmail authentication is properly set up
    checkAuth() {
        return gmailClient && authenticatedUserEmail;
    }

    // create and send a new email
    async createEmail(receivers, carbonCopy, subject, content) {
        try {
            // check if user is authenticated
            if (!this.checkAuth()) {
                return "❌ Not authenticated. Please restart the server to authenticate.";
            }

            // format recipients
            const to = receivers.join(", ");
            const cc = carbonCopy && carbonCopy.length > 0 ? carbonCopy.join(", ") : "";

            // construct email message in RFC 2822 format
            const message =
                `From: ${authenticatedUserEmail}\r\n` +
                `To: ${to}\r\n` +
                (cc ? `Cc: ${cc}\r\n` : "") +
                `Subject: ${subject}\r\n` +
                `Content-Type: text/plain; charset="UTF-8"\r\n\r\n${content}`;

            // encode message for Gmail API
            const encodedMessage = this.toBase64Url(message);

            // send the email via Gmail API
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

    // reply to an existing email
    async replyEmail(emailId, content) {
        try {
            // check if user is authenticated
            if (!this.checkAuth()) {
                return "❌ Not authenticated. Please restart the server to authenticate.";
            }
    
            // get the original email details
            const originalEmail = await this.getEmail(emailId);
            
            if (typeof originalEmail === 'string') {
                return originalEmail; // error message from getEmail
            }
    
            // extract sender's email address from the original email
            const fromEmail = originalEmail.sender;
            
            // helper function to extract email from "Name <email@domain.com>" format
            const extractEmail = (emailString) => {
                const match = emailString.match(/<(.+?)>/);
                return match ? match[1] : emailString;
            };
            
            const replyTo = extractEmail(fromEmail);
    
            // create the reply message with proper headers
            const replyMessage = [
                `To: ${replyTo}`,
                `In-Reply-To: ${emailId}`,
                '',
                content
            ].join('\r\n');
    
            // encode the reply message
            const encodedMessage = this.toBase64Url(replyMessage);
    
            // send the reply via Gmail API
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

    // search for emails in the inbox using Gmail query syntax
    async searchEmail(query, maxResults = 10) {
        try {
            // check if user is authenticated
            if (!this.checkAuth()) {
                return "❌ Not authenticated. Please restart the server to authenticate.";
            }
            
            // get list of email IDs matching the search query
            const listResp = await gmailClient.users.messages.list({
                userId: "me",
                q: query,
                maxResults: maxResults,
            });
            
            const messages = listResp.data.messages || [];
            
            if (messages.length === 0) {
                return [];
            }
            
            // get full details for each email found
            const emailDetails = [];
            for (const message of messages) {
                // fetch complete email data
                const detail = await gmailClient.users.messages.get({
                    userId: "me",
                    id: message.id,
                });
                
                const headers = detail.data.payload.headers;
                const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
                
                // extract email body content
                let body = "";
                if (detail.data.payload.body.data) {
                    body = Buffer.from(detail.data.payload.body.data, 'base64').toString();
                } else if (detail.data.payload.parts) {
                    // handle multipart messages
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
                
                // build email summary object
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

    // get complete details of a specific email by ID
    async getEmail(emailId) {
        try {
            // check if user is authenticated
            if (!this.checkAuth()) {
                return "❌ Not authenticated. Please restart the server to authenticate.";
            }
            
            // fetch the email from Gmail API
            const message = await gmailClient.users.messages.get({
                userId: "me",
                id: emailId,
            });
            
            const headers = message.data.payload.headers;
            const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
            
            // extract email body content
            let body = "";
            if (message.data.payload.body.data) {
                body = Buffer.from(message.data.payload.body.data, 'base64').toString();
            } else if (message.data.payload.parts) {
                // handle multipart messages
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
            
            // return structured email data
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

// create and configure the MCP server with email tools
async function createMcpServer() {
    // load tools configuration from YAML file
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

    // create instance of email tools
    const tools = new Tools();

    // initialize MCP server with metadata
    const server = new McpServer({
        name: "gmail-mcp-server",
        version: "1.0.0"
    }, {
        capabilities: {
            tools: {}
        }
    });

    // register createEmail tool with schema validation
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

    // register getEmail tool with schema validation
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

    // register replyEmail tool with schema validation
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

    // register searchEmail tool with schema validation
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

// initialize Express app and server components
const app = express();
app.use(express.json());
const transports = {}; // store MCP transport sessions
let mcpServer = null;

// initialize authentication on startup
console.log('Server Starting...\n');
await initializeAuthentication();

// create MCP server after successful authentication
mcpServer = await createMcpServer();

// configure CORS middleware for cross-origin requests
app.use(cors({
    origin: "*", // allow all origins for development purposes
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

// main MCP endpoint for handling tool requests
app.post('/mcp', async (req, res) => {
    try {
        // check for existing session ID in headers
        const sessionId = req.headers['mcp-session-id'];
        let transport;

        if (sessionId && transports[sessionId]) {
            // reuse existing transport for this session
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // create new session for initialization request
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sessionId) => {
                    console.log("Session initialized: ", sessionId);
                    transports[sessionId] = transport;
                },
            });

            // clean up transport when session closes
            transport.onclose = () => {
                if (transport.sessionId) {
                    delete transports[transport.sessionId];
                }
            };

            // connect the transport to the MCP server
            await mcpServer.connect(transport);
        } else {
            // invalid request: no session ID and not initialization
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

        // handle the MCP request through the transport
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

// health check endpoint to monitor server status
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

// simple authentication status endpoint for frontend
app.get('/status', (_req, res) => {
    res.json({ 
        authenticated: !!gmailClient, 
        userEmail: authenticatedUserEmail,
        method: 'cli'
    });
});

// logout endpoint: clears stored tokens and exits server
app.post('/logout', async (_req, res) => {
    try {
        // clear stored authentication tokens
        await cliAuth.clearStoredTokens();
        console.log('✅ Logged out successfully. Server will exit, restart to re-authenticate.');
        
        res.json({ 
            success: true, 
            message: 'Logged out successfully. Please restart the server to re-authenticate.' 
        });
        
        // exit server after short delay to allow response to be sent
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

// streaming chat endpoint for realtime AI agent responses
app.post('/api/chat/stream', async (req, res) => {
    try {
        const { message, sessionId } = req.body;
        
        // validate that message is provided
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        // generate unique session ID if not provided
        const actualSessionId = sessionId || `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // set up Server-Sent Events headers for streaming
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Credentials': 'true'
        });

        // send initial connection confirmation with session ID
        res.write(`data: ${JSON.stringify({ 
            type: 'connected',
            sessionId: actualSessionId 
        })}\n\n`);

        let fullResponse = '';
        
        try {
            // stream agent response with realtime updates
            await streamAgent(
                message,
                (chunk) => {
                    // send incremental response chunks to client
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

            // send completion signal with final response
            res.write(`data: ${JSON.stringify({ 
                type: 'complete', 
                content: fullResponse,
                sessionId: actualSessionId,
                timestamp: new Date().toISOString()
            })}\n\n`);
            
        } catch (streamError) {
            // send error message to client
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

// start the server
const PORT = 3001;

app.listen(PORT, () => {
    console.log(`Server ready and authenticated as: ${authenticatedUserEmail}\n`);
    console.log('The server will automatically prompt for authentication on startup if needed.\n');

    console.log(`Server running at: https://${process.env.USERNAME}-${PORT}.${process.env.PROXY_DOMAIN}`)
});