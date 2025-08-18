import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { loadMcpTools } from "@langchain/mcp-adapters";

import dotenv from "dotenv";
dotenv.config();

// configuration
const SERVER_URL = process.env.REACT_APP_SERVER_URL;
const MCP_SERVER_URL = `${SERVER_URL}/mcp`;
const LLM_MODEL = "gpt-5-nano";


// Singleton pattern for agent initialization
let agentInstance = null;
let clientInstance = null;
let isInitializing = false;

const initializeAgent = async () => {
    if (agentInstance) return agentInstance;
    if (isInitializing) {
        // Wait for existing initialization to complete
        while (isInitializing) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return agentInstance;
    }

    isInitializing = true;
    
    try {
        const model = new ChatOpenAI({
            model: LLM_MODEL
        });

        const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL));
        
        clientInstance = new Client({
            name: "email-assistant",
            version: "1.0.0"
        });

        await clientInstance.connect(transport);
        
        const tools = await loadMcpTools("email", clientInstance, {
            throwOnLoadError: true,
            prefixToolNameWithServerName: false,
            additionalToolNamePrefix: "",
            useStandardContentBlocks: false,
        });

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

        return agentInstance;
    } catch (error) {
        console.error("Failed to initialize agent:", error);
        throw error;
    } finally {
        isInitializing = false;
    }
};

export const streamAgent = async (message, onChunk, threadId) => {
    try {
        const agent = await initializeAgent();
        
        const stream = await agent.stream(
            { messages: [{ role: "user", content: message }] },
            { 
                configurable: { thread_id: threadId },
                streamMode: "values"
            }
        );

        let fullResponse = "";
        for await (const chunk of stream) {
            if (chunk.messages && chunk.messages.length > 0) {
                const lastMessage = chunk.messages[chunk.messages.length - 1];
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