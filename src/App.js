import { useState, useEffect } from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import "./global.css"
import Chat from './Chat.js'

function App() {
  // App states to track different processes and store values
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [serverStatus, setServerStatus] = useState(false)
  const [messages, setMessages] = useState([])

  // load env variable
  const BASE_URL = process.env.REACT_APP_SERVER_URL

  useEffect(() => {
    // check is server is even running
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
    
    // check is server is authenticated
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
            {!isAuthenticated || !serverStatus ? (
              <div>
                Start and authenticate the MCP server to use email tools
              </div>
            ) : (
              <div>
                <h3>Authenticated as: {userEmail}</h3>
                <p className="success-message">
                  ✓ Ready to use email tools!
                </p>
                <button 
                  onClick={handleGoogleLogout}
                  className="pointer-button button"
                >Logout</button>
              </div>
            )}
          </div>
        } />
        <Route path="/chat" element={<Chat isAuthenticated={isAuthenticated} userEmail={userEmail} messages={messages} setMessages={setMessages} />} />
      </Routes>
    </div>
  );
}

export default App;
