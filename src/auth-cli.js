import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';

dotenv.config();

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Token storage path
const TOKEN_PATH = path.join(__dirname, '../.gmail-tokens.json');

// Google OAuth2 scopes for Gmail
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify'
];

class CLIAuthenticator {
    constructor() {
        this.clientId = process.env.GOOGLE_CLIENT_ID;
        this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        
        if (!this.clientId || !this.clientSecret) {
            console.error('❌ Missing Google OAuth credentials in environment variables');
            console.log('💡 Make sure your .env file contains:');
            console.log('   GOOGLE_CLIENT_ID=your_client_id');
            console.log('   GOOGLE_CLIENT_SECRET=your_client_secret');
            throw new Error('Missing Google OAuth credentials in environment variables');
        }

        console.log(`🔧 Using Client ID: ${this.clientId.substring(0, 20)}...`);
    }

    /**
     * Load stored tokens from file
     */
    async loadStoredTokens() {
        try {
            const tokenData = await fs.readFile(TOKEN_PATH, 'utf8');
            return JSON.parse(tokenData);
        } catch (error) {
            return null; // No stored tokens
        }
    }

    /**
     * Save tokens to file
     */
    async saveTokens(tokens) {
        try {
            await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
            console.log('✅ Tokens saved successfully');
        } catch (error) {
            console.error('❌ Failed to save tokens:', error.message);
        }
    }

    /**
     * Create OAuth2 client with stored credentials
     */
    async createAuthenticatedClient() {
        const tokens = await this.loadStoredTokens();
        
        if (!tokens) {
            return null;
        }

        const oauth2Client = new google.auth.OAuth2(
            this.clientId,
            this.clientSecret,
            'urn:ietf:wg:oauth:2.0:oob' // For installed app flow
        );

        oauth2Client.setCredentials(tokens);

        // Check if token needs refresh
        try {
            await oauth2Client.getAccessToken();
            return oauth2Client;
        } catch (error) {
            console.log('🔄 Tokens expired, need to re-authenticate');
            return null;
        }
    }

    /**
     * Perform installed application OAuth flow
     */
    async performInstalledAppFlow() {
        console.log('\n🔐 Starting Google OAuth2 Installed Application Flow...\n');

        const oauth2Client = new google.auth.OAuth2(
            this.clientId,
            this.clientSecret,
            'urn:ietf:wg:oauth:2.0:oob'
        );

        // Generate the authorization URL
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent' // Force consent screen to get refresh token
        });

        console.log('📱 Please complete the following steps:');
        console.log(`\n1. Visit this URL: ${authUrl}`);
        console.log('2. Sign in to your Google account');
        console.log('3. Grant permissions to the application');
        console.log('4. Copy the authorization code from the page\n');

        // Try to open the URL automatically
        await this.openUrl(authUrl);

        // Prompt for the authorization code
        const authCode = await this.promptForAuthCode();

        if (!authCode) {
            throw new Error('No authorization code provided');
        }

        console.log('🔄 Exchanging authorization code for tokens...');

        try {
            const { tokens } = await oauth2Client.getToken(authCode.trim());
            
            if (!tokens.refresh_token) {
                console.error('❌ No refresh token received.');
                console.log('💡 This can happen if you\'ve already authorized this app before.');
                console.log('🔧 Go to https://myaccount.google.com/permissions and remove this app, then try again.');
                throw new Error('No refresh token received');
            }

            oauth2Client.setCredentials(tokens);
            await this.saveTokens(tokens);

            console.log('✅ Authentication successful!');
            return oauth2Client;
        } catch (error) {
            console.error('❌ Failed to exchange authorization code:', error.message);
            throw error;
        }
    }

    /**
     * Try to open URL in default browser
     */
    async openUrl(url) {
        try {
            const platform = process.platform;
            let command;

            if (platform === 'darwin') {
                command = `open "${url}"`;
            } else if (platform === 'win32') {
                command = `start "${url}"`;
            } else {
                command = `xdg-open "${url}"`;
            }

            await execAsync(command);
            console.log('🌐 Opening authorization URL in your default browser...\n');
        } catch (error) {
            console.log('⚠️  Could not open browser automatically. Please copy and paste the URL above.\n');
        }
    }

    /**
     * Prompt user for authorization code
     */
    async promptForAuthCode() {
        return new Promise((resolve) => {
            process.stdout.write('📝 Enter the authorization code: ');
            process.stdin.setEncoding('utf8');
            
            const onData = (data) => {
                process.stdin.removeListener('data', onData);
                process.stdin.pause();
                resolve(data.toString().trim());
            };
            
            process.stdin.resume();
            process.stdin.on('data', onData);
        });
    }

    /**
     * Main authentication method - tries stored tokens first, then installed app flow
     */
    async authenticate() {
        console.log('🔍 Checking for stored authentication...');
        
        // Try to use stored tokens first
        let oauth2Client = await this.createAuthenticatedClient();
        
        if (oauth2Client) {
            console.log('✅ Using stored authentication');
            return oauth2Client;
        }

        // No valid stored tokens, perform installed app flow
        console.log('🔐 No valid stored authentication found');
        oauth2Client = await this.performInstalledAppFlow();
        
        return oauth2Client;
    }

    /**
     * Get Gmail client after authentication
     */
    async getGmailClient() {
        const oauth2Client = await this.authenticate();
        
        if (!oauth2Client) {
            throw new Error('Failed to authenticate');
        }

        return google.gmail({ version: 'v1', auth: oauth2Client });
    }

    /**
     * Get user email address
     */
    async getUserEmail(gmailClient) {
        try {
            const profile = await gmailClient.users.getProfile({ userId: 'me' });
            return profile.data.emailAddress;
        } catch (error) {
            console.error('❌ Failed to get user email:', error.message);
            throw error;
        }
    }

    /**
     * Clear stored tokens (for logout)
     */
    async clearStoredTokens() {
        try {
            await fs.unlink(TOKEN_PATH);
            console.log('✅ Stored tokens cleared');
        } catch (error) {
            // File doesn't exist, that's fine
        }
    }
}

export default CLIAuthenticator;