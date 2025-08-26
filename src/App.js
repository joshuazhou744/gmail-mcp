import { useState, useEffect } from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import "./global.css"
import Chat from './Chat.js'

function App() {
  // App states to track different processes and store values
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [serverStatus, setServerStatus] = useState(false)

  // load env variable
  const BASE_URL = process.env.REACT_APP_SERVER_URL

  useEffect(() => {
    // check if server is even running
    const checkServerStatus = async () => {
      try {
        // get health endpoint of the server
        const response = await fetch(`${BASE_URL}/health`, {
          method: "GET",
          headers: { "Content-Type": "application/json" }
        })
        
        if (response.ok) {
          // if server is running, set the server status
          const data = await response.json()
          setServerStatus(data.status === 'ok')
        } else {
          // else set server status to false
          setServerStatus(false)
        }
      } catch (error) {
        console.log('Server not available: ', error)
        setServerStatus(false)
      }
    }
    
    // check if server is authenticated
    const checkAuth = async () => {
      try {
        // get authentication status of the server
        const response = await fetch(`${BASE_URL}/status`, {
          method: "GET",
          headers: { "Content-Type": "application/json" }
        })
        
        if (response.ok) {
          // if server is authenticated, set the authentication status and user email
          const data = await response.json()
          setIsAuthenticated(data.authenticated)
          setUserEmail(data.userEmail)
        } else {
          // else set the authentication status and user email to false and empty
          setIsAuthenticated(false)
          setUserEmail('')
        }
      } catch (error) {
        console.log('Server not authenticated: ', error)
        setIsAuthenticated(false)
        setUserEmail('')
      }
    }

    // check if server is running and authenticated
    checkServerStatus()
    checkAuth()
  }, [BASE_URL, serverStatus])

  // handle logout request
  const handleGoogleLogout = async () => {
    try {
      // send logout request to the server
      await fetch(`${BASE_URL}/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      })
    } catch (error) {
      console.log('Logout request failed: ', error)
    }
    
    // set the authentication status and user email to false and empty
    setIsAuthenticated(false)
    setUserEmail('')
  }

  return (
    <div className="main">
      <h1>Email Management Assistant</h1>

      <nav className="navbar">
        <Link to="/" className="nav-link">
          Login
        </Link>
        <Link to="/chat" className="nav-link">
          Chat
        </Link>
      </nav>

      <Routes>
        <Route path="/" element={
          <div className="card">
            <div className="status-section">
              <h3>Server Status</h3>
              {serverStatus ? (
                <p className="success-message">
                  MCP Server is running
                </p>
              ) : (
                <p className="error-message">
                  MCP Server is not running, please start the server
                </p>
              )}
            </div>

            <div className="status-section">
              <h3>Authentication Status</h3>
              {!serverStatus ? (
                <p className="warning-message">
                  ⏳ Start server first to check authentication
                </p>
              ) : isAuthenticated ? (
                <div>
                  <p className="success-message">
                    ✅ Authenticated as: {userEmail}
                  </p>
                  <button 
                    onClick={handleGoogleLogout}
                    className="pointer-button button"
                  >
                    Logout
                  </button>
                </div>
              ) : (
                <p className="error-message">
                  ❌ Not authenticated - please authenticate with Gmail
                </p>
              )}
            </div>
          </div>
        } />
        <Route path="/chat" element={<Chat isAuthenticated={isAuthenticated} userEmail={userEmail}/>}/>
      </Routes>
    </div>
  );
}

export default App;
