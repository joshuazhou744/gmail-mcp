import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { loadMcpTools } from "@langchain/mcp-adapters";

import dotenv from "dotenv";
dotenv.config();

// load environment variables and set configuration
const SERVER_URL = process.env.REACT_APP_SERVER_URL;
const MCP_SERVER_URL = `${SERVER_URL}/mcp`;
const LLM_MODEL = "gpt-5-nano";

// singleton pattern variables to ensure only one agent instance exists
let agentInstance = null;
let clientInstance = null;
let isInitializing = false;

// initialize the AI agent with email tools
const initializeAgent = async () => {
    // return existing agent if already initialized
    if (agentInstance) return agentInstance;
    
    // wait for existing initialization to complete if in progress
    if (isInitializing) {
        while (isInitializing) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return agentInstance;
    }

    isInitializing = true;
    
    try {
        // create the language model instance
        const model = new ChatOpenAI({
            model: LLM_MODEL
        });

        // set up transport to connect to MCP server
        const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL));
        
        // create MCP client for email tools
        clientInstance = new Client({
            name: "email-assistant",
            version: "1.0.0"
        });

        // connect the client to the MCP server
        await clientInstance.connect(transport);
        
        // load email tools from the MCP server
        const tools = await loadMcpTools("email", clientInstance, {
            throwOnLoadError: true,
            prefixToolNameWithServerName: false,
            additionalToolNamePrefix: "",
            useStandardContentBlocks: false,
        });

        // create the ReAct agent with model, tools, and memory
        agentInstance = createReactAgent({
            llm: model,
            tools: tools,
            checkpointer: new MemorySaver(),
            initialMessages: [
                {
                    role: "user",
                    content: "You are a helpful assistant that can help with email management. Display all outputs nicely formatted in markdown format."
                }
            ]
        });
        
        // return the agent instance
        return agentInstance;
    } catch (error) {
        console.error("Failed to initialize agent:", error);
        throw error;
    } finally {
        isInitializing = false;
    }
};

// stream agent responses in real-time to the client
export const streamAgent = async (message, onChunk, threadId) => {
    try {
        // get the initialized agent instance
        const agent = await initializeAgent();
        
        // start streaming the agent response
        const stream = await agent.stream(
            { messages: [{ role: "user", content: message }] },
            { 
                configurable: { thread_id: threadId },
                streamMode: "values"
            }
        );

        let fullResponse = "";
        
        // process each chunk of the streaming response
        for await (const chunk of stream) {
            if (chunk.messages && chunk.messages.length > 0) {
                const lastMessage = chunk.messages[chunk.messages.length - 1];
                
                // send new content to client if it has changed
                if (lastMessage.content && lastMessage.content !== fullResponse) {
                    fullResponse = lastMessage.content;
                    onChunk(fullResponse);
                }
            }
        }
        
        return fullResponse;
    } catch (error) {
        console.error("Error streaming agent:", error);
        throw new Error(`Agent streaming error: ${error.message}`);
    }
};