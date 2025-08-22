import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';

dotenv.config();

const execAsync = promisify(exec);

// get current file directory for token storage path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// path where OAuth tokens are stored
const TOKEN_PATH = path.join(__dirname, '../.gmail-tokens.json');

// required Gmail permissions for the application
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify'
];

// handles Google OAuth authentication for Gmail access
class CLIAuthenticator {
    constructor() {
        // load OAuth credentials from environment variables
        this.clientId = process.env.GOOGLE_CLIENT_ID;
        this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        
        // validate that credentials are provided
        if (!this.clientId || !this.clientSecret) {
            console.error('❌ Missing Google OAuth credentials in environment variables');
            console.log('💡 Make sure your .env file contains:');
            console.log('   GOOGLE_CLIENT_ID=your_client_id');
            console.log('   GOOGLE_CLIENT_SECRET=your_client_secret');
            throw new Error('Missing Google OAuth credentials in environment variables');
        }
    }

    // load previously saved OAuth tokens from file
    async loadStoredTokens() {
        try {
            const tokenData = await fs.readFile(TOKEN_PATH, 'utf8');
            return JSON.parse(tokenData);
        } catch (error) {
            return null; // no stored tokens found
        }
    }

    // save OAuth tokens to file for future use
    async saveTokens(tokens) {
        try {
            await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
            console.log('✅ Tokens saved successfully');
        } catch (error) {
            console.error('❌ Failed to save tokens:', error.message);
        }
    }

    // create OAuth2 client using stored tokens
    async createAuthenticatedClient() {
        // load tokens from storage
        const tokens = await this.loadStoredTokens();
        
        if (!tokens) {
            return null;
        }

        // create OAuth2 client with credentials
        const oauth2Client = new google.auth.OAuth2(
            this.clientId,
            this.clientSecret,
            'urn:ietf:wg:oauth:2.0:oob' // for installed app flow
        );

        oauth2Client.setCredentials(tokens);

        // verify token is still valid and refresh if needed
        try {
            await oauth2Client.getAccessToken();
            return oauth2Client;
        } catch (error) {
            console.log('🔄 Tokens expired, need to re-authenticate');
            return null;
        }
    }

    // perform the complete OAuth flow for new authentication
    async performInstalledAppFlow() {
        console.log('\n🔐 Starting Google OAuth2 Installed Application Flow...\n');

        // create OAuth2 client for authentication
        const oauth2Client = new google.auth.OAuth2(
            this.clientId,
            this.clientSecret,
            'urn:ietf:wg:oauth:2.0:oob'
        );

        // generate the authorization URL for user to visit
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent' // force consent screen to get refresh token
        });

        // display instructions to user
        console.log('📱 Please complete the following steps:');
        console.log(`\n1. Visit this URL: ${authUrl}`);
        console.log('2. Sign in to your Google account');
        console.log('3. Grant permissions to the application');
        console.log('4. Copy the authorization code from the page\n');

        // try to open the URL automatically in browser
        await this.openUrl(authUrl);

        // prompt user to enter the authorization code
        const authCode = await this.promptForAuthCode();

        if (!authCode) {
            throw new Error('No authorization code provided');
        }

        console.log('🔄 Exchanging authorization code for tokens...');

        try {
            // exchange authorization code for access and refresh tokens
            const { tokens } = await oauth2Client.getToken(authCode.trim());
            
            // ensure we received a refresh token
            if (!tokens.refresh_token) {
                console.error('❌ No refresh token received.');
                console.log('💡 This can happen if you\'ve already authorized this app before.');
                console.log('🔧 Go to https://myaccount.google.com/permissions and remove this app, then try again.');
                throw new Error('No refresh token received');
            }

            // set credentials and save tokens for future use
            oauth2Client.setCredentials(tokens);
            await this.saveTokens(tokens);

            console.log('✅ Authentication successful!');
            return oauth2Client;
        } catch (error) {
            console.error('❌ Failed to exchange authorization code:', error.message);
            throw error;
        }
    }

    // attempt to open authorization URL in default browser
    async openUrl(url) {
        try {
            // determine the correct command for each operating system
            const platform = process.platform;
            let command;

            if (platform === 'darwin') {
                command = `open "${url}"`;
            } else if (platform === 'win32') {
                command = `start "${url}"`;
            } else {
                command = `xdg-open "${url}"`;
            }

            // execute the browser open command
            await execAsync(command);
            console.log('🌐 Opening authorization URL in your default browser...\n');
        } catch (error) {
            console.log('⚠️  Could not open browser automatically. Please copy and paste the URL above.\n');
        }
    }

    // prompt user to enter the authorization code from browser
    async promptForAuthCode() {
        return new Promise((resolve) => {
            process.stdout.write('📝 Enter the authorization code: ');
            process.stdin.setEncoding('utf8');
            
            // handle user input
            const onData = (data) => {
                process.stdin.removeListener('data', onData);
                process.stdin.pause();
                resolve(data.toString().trim());
            };
            
            // start listening for user input
            process.stdin.resume();
            process.stdin.on('data', onData);
        });
    }

    // main authentication method, tries stored tokens first, then prompts for new auth
    async authenticate() {
        console.log('🔍 Checking for stored authentication...');
        
        // try to use existing stored tokens first
        let oauth2Client = await this.createAuthenticatedClient();
        
        if (oauth2Client) {
            console.log('✅ Using stored authentication');
            return oauth2Client;
        }

        // no valid stored tokens found, start new OAuth flow
        console.log('🔐 No valid stored authentication found');
        oauth2Client = await this.performInstalledAppFlow();
        
        return oauth2Client;
    }

    // get authenticated Gmail client
    async getGmailClient() {
        // authenticate first
        const oauth2Client = await this.authenticate();
        
        if (!oauth2Client) {
            throw new Error('Failed to authenticate');
        }

        // return Gmail API client
        return google.gmail({ version: 'v1', auth: oauth2Client });
    }

    // get the authenticated user's email address
    async getUserEmail(gmailClient) {
        try {
            const profile = await gmailClient.users.getProfile({ userId: 'me' });
            return profile.data.emailAddress;
        } catch (error) {
            console.error('❌ Failed to get user email:', error.message);
            throw error;
        }
    }

    // clear stored tokens from file (used for logout)
    async clearStoredTokens() {
        try {
            await fs.unlink(TOKEN_PATH);
            console.log('✅ Stored tokens cleared');
        } catch (error) {
            // file doesn't exist, that's fine
        }
    }
}

export default CLIAuthenticator;