import React from 'react'
import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'

function Chat({ isAuthenticated, userEmail, messages, setMessages }) {
    const [inputMessage, setInputMessage] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [sessionId, setSessionId] = useState(null)
    const messagesEndRef = useRef(null);
    const abortControllerRef = useRef(null);

    const BASE_URL = process.env.REACT_APP_SERVER_URL

    const sendMessage = async () => {
        // check if user is authenticated and message is not empty
        if (!inputMessage.trim() || !isAuthenticated) return

        try {
            setIsLoading(true)
            // add user message to messages
            setMessages(prev => [...prev, `User: ${inputMessage}`])

            // clear input message immediately for better UX
            const messageToSend = inputMessage;
            setInputMessage('')
            

            // create abort controller for the request
            abortControllerRef.current = new AbortController();

            // stream agent response
            const response = await fetch(`${BASE_URL}/api/chat/stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                    message: messageToSend,
                    sessionId: sessionId // Will be null for first message, server will generate one
                }),
                signal: abortControllerRef.current.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            let agentMessageIndex = -1;
            setMessages(prev => {
                const newMessages = [...prev, `Agent: ...`];
                agentMessageIndex = newMessages.length - 1;
                return newMessages;
            })

            let fullResponse = '';
            let hasSeenUserMessage = false;
            const userMessageToSend = messageToSend;

            // Create update functions outside the loop to avoid ESLint warnings
            const updateAgentMessage = (content) => {
                setMessages(prev => {
                    const newMessages = [...prev];
                    newMessages[agentMessageIndex] = `Agent: ${content}`;
                    return newMessages;
                });
            };

            const updateErrorMessage = (error) => {
                setMessages(prev => {
                    const newMessages = [...prev];
                    newMessages[agentMessageIndex] = `Error: ${error}`;
                    return newMessages;
                });
            };

            while (true) {
                const {done, value} = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            
                            if (data.type === 'connected' && data.sessionId) {
                                // Store the session ID for subsequent messages
                                setSessionId(data.sessionId);
                            } else if (data.type === 'chunk' || data.type === 'complete') {
                                // Skip if this is the user's message echoed back
                                if (data.content === userMessageToSend && !hasSeenUserMessage) {
                                    hasSeenUserMessage = true;
                                    continue;
                                }
                                fullResponse = data.content;
                                updateAgentMessage(fullResponse);
                                
                                // Update session ID if provided in complete response
                                if (data.type === 'complete' && data.sessionId) {
                                    setSessionId(data.sessionId);
                                }
                            } else if (data.type === 'error') {
                                updateErrorMessage(data.error);
                                break;
                            }
                        } catch (e) {
                            console.error('Error parsing SSE data:', e);
                        }
                    }
                }
            }
            
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('Request aborted');
            } else {
                console.error('Chat error:', error)
                setMessages(prev => [...prev, `Error: ${error.message}`])
            }
        } finally {
            setIsLoading(false)
        }
    }

    const stopStreaming = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        setIsLoading(false);
    }

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };
      
    useEffect(() => {
        scrollToBottom();
    }, [messages]);
    
    return (
        <div className="chat-container">
            <h2>Email Management Chat</h2>
      
            {!isAuthenticated ? (
                <div className="auth-required">
                    <h3>Authentication Required</h3>
                    <p>Please go to the Home page and authenticate with Gmail to use the chat features.</p>
                </div>
            ) : (
                <>
                    <div className="auth-message">
                        ✓ Authenticated as: {userEmail}
                    </div>
                
                    <div className="chat-messages">
                        {messages.length === 0 ? (
                            <p>Start chatting to manage your emails.</p>
                        ) : (
                            messages.map((msg, index) => {
                                const isUser = msg.startsWith('User:');
                                return (
                                    <div
                                        key={index}
                                        className="chat-message"
                                        style={{ backgroundColor: isUser ? '#e3f2fd' : '#f5f5f5' }}
                                    >
                                        {isUser ? msg : (
                                            msg === 'Agent: ...' ? (
                                                <div>
                                                    <span>Agent: </span>
                                                    <span className="loading-dots">
                                                        <span>.</span>
                                                        <span>.</span>
                                                        <span>.</span>
                                                    </span>
                                                </div>
                                            ) : (
                                                <ReactMarkdown>{msg}</ReactMarkdown>
                                            )
                                        )}
                                    </div>
                                )
                            })
                        )}
                        <div ref={messagesEndRef} />
                    </div>
                
                <div className="chat-input-container">
                    <input
                        type="text"
                        value={inputMessage}
                        onChange={(e) => setInputMessage(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                        placeholder="Ask about your emails..."
                        className="chat-input"
                        disabled={isLoading}
                    />
                    {isLoading ? (
                        <button 
                            onClick={stopStreaming}
                            className="send-button pointer-button button"
                            style={{ backgroundColor: '#f44366' }}
                        >
                            Stop
                        </button>
                    ) : (
                        <button 
                            onClick={sendMessage} 
                            disabled={!inputMessage.trim()}
                            className="send-button pointer-button button"
                        >
                            Send
                        </button>
                    )}
                </div>
                </>
            )}
        </div>
    )
}

export default Chat