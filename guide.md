# Build a Gmail MCP to enable an Email Handling Agent

**Estimated Time: 30 mins**

## Introduction

As AI agents become more and more widespread, their capabilities must expand to meet the demand and usage. **Model Context Protocol (MCP)** Servers are a new standard for providing tools and capabilities to agentic clients. Think of them as Application Programming Interfaces (API) specially designed for AI agents. Where APIs host endpoints for **CRUD (Create, Read...)** actions, MCPs host tools, resources, and prompts that agents can call with structured inputs and receive structured outputs.

The most common use of MCP servers are to host **tools** that agents can call on for a response. For example, a `createEmail` tool could provide the agent with the capability to create and send an email just by giving in specific inputs, e.g. sender, receiver, subject, body. MCP servers can also provide **resources** that are documents of information the agent can quickly access and read. **Prompts** are less used but they...

MCP servers use different transports for different use cases. **HTTP** transport is typically used for publicly deployed MCP servers that can be accessed remotely from anywhere, these servers usually stream their responses. To configure these server's you only need the URL which the MCP server is hosted on.  **Standard Input/Output (STDIO)** transport is typically used in local deployments of MCP servers, it requires an initialization command. **Single Server Event (SSE)** transport is uncommon nowadays and is typically only used in development environments for quick testing.

### Example
[**Context7**](link), a popular MCP server that hosts up-to-date framework/library documentation, can be added to a client like Cursor in the `mcp.json` file like so:

```json
{
  "mcpServers": {
    "context7-local-stdio": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "context7-remote-http": {
      "url": "http://context7-url.com"
    },
  }
}

```

## What we'll be building

In this lab, we will be creating an MCP server with tools that connect directly to the **Gmail API**, enabling an agent to send, read, and reply to our emails. We'll create a custom client using **LangGraph's** ReAct agent and host the User Interface (UI) on a ReactJS app so we can interact with our agent. 

For our MCP server, we'll be using Anthropic's MCP **Software Development Kit (SDK)** in a Node.js environment. We'll host the tools on the `/mcp` endpoint of an express server and handle authorization and login with an `/auth` endpoint. For the agent we'll create another endpoint to chat with our agent which will also be hosted in the backend Node.js environment so our API keys aren't at risk of exposure in the frontend. This endpoint will be on `/agent` and we'll initialize our agent inside the server.

For the client, it'll be a simple vanilla JavaScript ReactJS App that uses React Router to switch between a **login** and **chat** window. The login window will require a script from google to prompt a user login and then send an **authorization code** to our server to get a **refresh token** so we get authorization to use our Gmail account to perform actions.

You may be wondering how the client knows what the MCP server is about, the tools it provides, and how to call on those tools? Typically the server sends all that information when a client establishes a connection with it regardless of the transport. Or they'll host all the information and documentation on a separate endpoint like `/info`. Our custom client will use a LangGraph ReAct agent with structured tools that we'll configure after calling from the MCP server.

## Learning Objectives
By the end of this lab you'll:
- Understand what MCP server's are, how they work, and their typical use cases
- Configure a Google Developer Client with the Gmail API to perform email actions
- Use the MCP SDK to create a server with custom tools that interact with the Gmail API
- Create a ReactJS app to login to Gmail, obtain and authorization code, authenticate the server, and display a chat window to interact with the agent
- Create an Express server to host your tools under an endpoint, handle authorization, and handle chat completions with the agent
- Create a LangGraph ReAct agent with MCP tools to perform Gmail actions

## Prerequisites
Before starting this project, you should have:
- A good understanding of how client-server HTTP interactions work
- A good understanding of JavaScript and HTML/CSS in a web development context
- Access to a modern browser to run this CloudIDE environment
- Minimal knowledge of Node environments and the ReactJS framework

# Setup

First let's create our ReactJS app where we'll build everything from (including the backend). Run the following command in the terminal to initialize a React App:
```bash
npx create-react-app gmail-mcp-app
```

The installation may take awhile, maybe ~2mins. After installation run the following command to clone into the app, install our version pinned dependencies, and create an `.env` file to store our environment variables:

```bash
cd gmail-mcp-app
npm install @langchain/core==0.3.70
    @langchain/langgraph==0.4.4
    @langchain/openai==0.6.7
    @modelcontextprotocol/sdk==1.17.3
    @testing-library/dom==10.4.1
    @testing-library/jest-dom==6.7.0
    @testing-library/react==16.3.0
    @testing-library/user-event==13.5.0
    express==5.1.0
    googleapis==156.0.0
    html-to-text==9.0.5
    react==19.1.1
    react-dom==19.1.1
    react-markdown==10.1.0
    react-router-dom==7.8.0
    react-scripts==5.0.1
    zod==3.25.76

touch .env
```

Next open the `package.json` file with the button below:

openFile::{path="gmail-mcp-app/package.json}

Find the `scripts` sections and add the following script:

```json
"server": "node src/server.js"
```

Next we'll get rid of all unnecessary files. Run the following command to navigate to the `src/` directory and remove all unnecessary files:

```bash
cd src
rm App.css index.css reportWebVitals.js
```

Still in `/src`, run the following command to add the files we'll be working with throughout the project:

```bash
touch Chat.js global.css agent.js server.js
```

# Part 1: Login and Chat UI

First, let's build out our user interface that handles the login page and the chat window. There is very little processing logic here as we'll handle most secure processes on the server side.

Let's start with the `index.js` file, it's short and simple:

openFile::{path="gmail-mcp-app/src/index.js"}

```javascript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
```

As you can see it shouldn't change too much from the boilerplate code. We only import React Router and wrap everything in a `BrowserRouter` tag to enable link routing.

Moving onto our main frontend component, `App.js`. This component will handle the Login and authentication of the server:

openFile::{path="gmail-mcp-app/src/App.js"}

```javascript
import React from 'react'
import { useState, useEffect } from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import "./global.css"
import Chat from './Chat.js'
```

We import:
- The `React` module
- Two commonly used React hooks `useState` and `useEffect`
- Some React Router modules
- Our `global.css` file for styling
- Our chat component in `Chat.js` that we'll build later

Next let's setup some configuration and states that we'll use within the Login component:

```javascript
function App() {
  // App states to track different processes and store values
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [serverStatus, setServerStatus] = useState(false)
  const [messages, setMessages] = useState([])

  // load env variables
  const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID
  const BASE_URL = process.env.REACT_APP_SERVER_URL

  // define oauth scopes
  const SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send"
  ].join(" ")
```

Here we define our states that will constantly change and update our UI behaviour accordingly. We also instantiate some variables from our `.env` file. Lastly, we define a global variable of the scopes we're requesting from the Gmail authorization code used to authenticate our server.

