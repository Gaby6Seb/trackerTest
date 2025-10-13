const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');

// --- Load Login Configurations ---
const LOGINS_FILE = path.join(__dirname, 'logins.json');
let loginConfigs = {};

// Try to load from environment variable first (for Railway)
if (process.env.LOGINS_JSON) {
    try {
        loginConfigs = JSON.parse(process.env.LOGINS_JSON);
        console.log(`Loaded ${Object.keys(loginConfigs).length} login configurations from environment variable.`);
    } catch (err) {
        console.error("FATAL ERROR: Could not parse LOGINS_JSON environment variable.", err);
        process.exit(1);
    }
}
// Fallback to local file (for local development)
else {
    try {
        loginConfigs = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf8'));
        console.log(`Loaded ${Object.keys(loginConfigs).length} login configurations from local logins.json file.`);
    } catch (err) {
        console.error("FATAL ERROR: Could not read logins.json file. Make sure it exists or LOGINS_JSON env var is set.", err);
        process.exit(1);
    }
}

// --- NEW: Persistent Token Management ---
const TOKEN_FILE = path.join(__dirname, 'persistent_tokens.json');
let persistentTokens = new Map(); // token -> { username, expiresAt }

function saveTokensToFile() {
    const array = Array.from(persistentTokens.entries());
    fs.writeFile(TOKEN_FILE, JSON.stringify(array), 'utf8', (err) => {
        if (err) console.error("Error saving persistent tokens:", err);
    });
}

function loadTokensFromFile() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const data = fs.readFileSync(TOKEN_FILE, 'utf8');
            const array = JSON.parse(data);
            persistentTokens = new Map(array);
            // Prune expired tokens on load
            const now = new Date();
            let prunedCount = 0;
            persistentTokens.forEach((value, key) => {
                if (new Date(value.expiresAt) < now) {
                    persistentTokens.delete(key);
                    prunedCount++;
                }
            });
            if (prunedCount > 0) {
                console.log(`Pruned ${prunedCount} expired tokens.`);
                saveTokensToFile();
            }
            console.log(`Loaded ${persistentTokens.size} persistent tokens.`);
        }
    } catch (err) {
        console.error("Error reading persistent tokens file:", err);
    }
}


// --- Server Setup ---
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'];
    if (process.env.NODE_ENV === 'production' && proto !== 'https') {
        res.redirect(301, `https://${req.hostname}${req.url}`);
        return;
    }
    next();
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
// NEW: Serve dashboard.html from a specific route
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));


// --- UPDATED: Login Endpoint ---
app.post('/login', (req, res) => {
    const { username, password, rememberMe } = req.body;
    const userConfig = loginConfigs[username];

    if (userConfig && userConfig.password === password) {
        let token = null;
        if (rememberMe) {
            token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
            persistentTokens.set(token, { username, expiresAt });
            saveTokensToFile();
            console.log(`Generated new persistent token for user: ${username}`);
        }

        res.json({
            token: token,
            username: username,
            isMaster: !!userConfig.isMaster,
            displayName: userConfig.displayName,
            canSeeAllPlayers: !!userConfig.canSeeAllPlayers,
            canSeeLastKnownLocation: !!userConfig.canSeeLastKnownLocation,
            canUseNotifications: !!userConfig.canUseNotifications // <-- NEW
        });
    } else {
        res.status(401).json({ message: 'Invalid credentials' });
    }
});

// --- NEW: Token Login Endpoint ---
app.post('/token-login', (req, res) => {
    const { token } = req.body;
    if (!token) {
        return res.status(400).json({ message: 'Token is required' });
    }

    const tokenData = persistentTokens.get(token);

    if (tokenData && new Date(tokenData.expiresAt) > new Date()) {
        const userConfig = loginConfigs[tokenData.username];
        if (userConfig) {
            console.log(`User ${tokenData.username} logged in via token.`);
            res.json({
                username: tokenData.username,
                isMaster: !!userConfig.isMaster,
                displayName: userConfig.displayName,
                canSeeAllPlayers: !!userConfig.canSeeAllPlayers,
                canSeeLastKnownLocation: !!userConfig.canSeeLastKnownLocation,
                canUseNotifications: !!userConfig.canUseNotifications // <-- NEW
            });
        } else {
            // User may have been deleted from logins.json
            persistentTokens.delete(token);
            saveTokensToFile();
            res.status(401).json({ message: 'User no longer exists' });
        }
    } else {
        if (tokenData) { // Token expired
            persistentTokens.delete(token);
            saveTokensToFile();
        }
        res.status(401).json({ message: 'Invalid or expired token' });
    }
});

// --- NEW: Logout Endpoint ---
app.post('/logout', (req, res) => {
    const { token } = req.body;
    if (token && persistentTokens.has(token)) {
        persistentTokens.delete(token);
        saveTokensToFile();
        console.log(`Invalidated persistent token.`);
    }
    res.status(200).json({ message: 'Logged out successfully' });
});

// --- API Configuration ---
const SUPABASE_URL = "https://erspvsdfwaqjtuhymubj.supabase.co";
const SPLASHIN_API_URL = "https://splashin.app/api/v3";
const API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyc3B2c2Rmd2FxanR1aHltdWJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE2ODM1ODY0MjcsImV4cCI6MTk5OTE2MjQyN30.2AItrHcB7A5bSZ_dfd455kvLL8fXLL7IrfMBoFmkGww";
const GAME_ID = "c8862e51-4f00-42e7-91ed-55a078d57efc";
const AVATAR_BASE_URL = "https://erspvsdfwaqjtuhymubj.supabase.co/storage/v1/object/public/avatars/";
const authData = {
    email: process.env.API_EMAIL,
    password: process.env.API_PASSWORD,
    goture_meta_security: {},
};
// --- NEW: OneSignal Configuration ---
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;


// --- State Management ---
let isFetching = false;
let lastSuccessfulData = null;
const FETCH_INTERVAL_MS = 10000;
const LOCATION_MEMORY_FILE = path.join(__dirname, 'last_locations.json');
let playerLastKnownLocationMap = new Map();
const stealthExpirationMap = new Map();
const STEALTH_REFETCH_INTERVAL_MS = 2 * 60 * 1000;
let previouslyLocatedPlayerIds = new Set(); // <-- NEW for notification state

function saveMapToFile() {
    const array = Array.from(playerLastKnownLocationMap.entries());
    fs.writeFile(LOCATION_MEMORY_FILE, JSON.stringify(array), 'utf8', (err) => {
        if (err) console.error("Error saving location memory:", err);
    });
}

function loadMapFromFile() {
    try {
        if (fs.existsSync(LOCATION_MEMORY_FILE)) {
            const data = fs.readFileSync(LOCATION_MEMORY_FILE, 'utf8');
            const array = JSON.parse(data);
            playerLastKnownLocationMap = new Map(array);
            console.log(`Loaded ${playerLastKnownLocationMap.size} locations from memory.`);
        }
    } catch (err) {
        console.error("Error reading location memory file:", err);
    }
}


// --- Data Filtering & Resolution Logic ---
function filterDataForUser(fullData, userFilterConfig) {
    if (userFilterConfig.isMaster) {
        return fullData;
    }

    const myTeamId = userFilterConfig.myTeamId;
    const targetTeamIds = userFilterConfig.targetTeamIds || new Set();
    const allowedTeamIds = new Set([myTeamId, ...targetTeamIds]);
    const shouldFilterByTeam = !userFilterConfig.canSeeAllPlayers;

    const processPlayers = (players) => {
        if (!players) return [];
        let processed = players;
        if (shouldFilterByTeam) {
            processed = processed.filter(p => allowedTeamIds.has(p.teamId));
        }
        return processed.map(p => {
            let role = 'neutral';
            if (p.teamId === myTeamId) {
                role = 'teammate';
            } else if (targetTeamIds.has(p.teamId)) {
                role = 'target';
            }
            return { ...p, role };
        });
    };

    const result = {
        located: processPlayers(fullData.located),
        notLocated: processPlayers(fullData.notLocated),
        stealthed: processPlayers(fullData.stealthed),
        safeZone: processPlayers(fullData.safeZone),
    };

    if (!userFilterConfig.canSeeLastKnownLocation) {
        const stripCoords = (player) => {
            const { lat, lng, ...rest } = player;
            return rest;
        };
        result.stealthed = result.stealthed.map(stripCoords);
        result.safeZone = result.safeZone.map(stripCoords);
    }

    return result;
}


async function resolveReferenceLogin(loginDetails) {
    console.log(`Attempting to resolve team/target info for login: ${loginDetails.email}`);
    try {
        const authHeaders = { "Apikey": API_KEY };
        const authUrl = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
        const refAuthData = { ...loginDetails, goture_meta_security: {} };
        const authResponse = await axios.post(authUrl, refAuthData, { headers: authHeaders });
        const accessToken = authResponse.data.access_token;
        const bearerToken = `Bearer ${accessToken}`;
        const commonHeaders = { "Apikey": API_KEY, "Authorization": bearerToken };

        const dashboardUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/dashboard`;
        const dashboardResponse = await axios.get(dashboardUrl, { headers: commonHeaders });

        if (!dashboardResponse.data || !dashboardResponse.data.myTeam) {
            throw new Error("Dashboard response did not contain team information.");
        }

        const myTeamId = dashboardResponse.data.myTeam.length > 0 ? dashboardResponse.data.myTeam[0].team_id : null;
        if (!myTeamId) throw new Error("Could not determine team ID from dashboard.");

        const targetTeamIds = new Set();
        if (dashboardResponse.data.targets) {
            dashboardResponse.data.targets.forEach(target => {
                if (target.team_id) targetTeamIds.add(target.team_id);
            });
        }

        console.log(`Successfully resolved login ${loginDetails.email}: Team ID ${myTeamId}, Targets ${[...targetTeamIds].join(', ')}`);
        return { myTeamId, targetTeamIds };
    } catch (error) {
        console.error(`Failed to resolve reference login for ${loginDetails.email}:`, error.message);
        if (error.response) console.error("API Response:", error.response.data);
        return null;
    }
}

// --- NEW: OneSignal Notification Function ---
async function sendPushNotification(title, message, targetUsernames) {
    if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
        console.warn("OneSignal credentials not set. Skipping notification.");
        return;
    }
    if (targetUsernames.length === 0) return;

    // Build the tag filter: ["tag", "username", "=", "user1", "OR", "tag", "username", "=", "user2"]
    const filters = targetUsernames.map(username => ({
        field: "tag",
        key: "username",
        relation: "=",
        value: username
    }));

    const notification = {
        app_id: ONESIGNAL_APP_ID,
        filters: filters.flatMap((filter, index) => (index === 0 ? [filter] : [{ operator: "OR" }, filter])),
        headings: { "en": title },
        contents: { "en": message },
        web_url: `https://${process.env.RAILWAY_STATIC_URL || 'localhost'}/dashboard.html` // Use your production URL
    };

    try {
        await axios.post('https://onesignal.com/api/v1/notifications', notification, {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`,
            },
        });
        console.log(`Sent notification to users: ${targetUsernames.join(', ')}`);
    } catch (error) {
        console.error("Error sending OneSignal notification:", error.response?.data || error.message);
    }
}

// --- The Core API Fetching Logic ---
async function runApiRequests() {
    if (isFetching) { return; }

    try {
        isFetching = true;
        console.log("--- Starting API Request Cycle ---");

        const authHeaders = { "Apikey": API_KEY };
        const authUrl = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
        const authResponse = await axios.post(authUrl, authData, { headers: authHeaders });
        const accessToken = authResponse.data.access_token;
        const bearerToken = `Bearer ${accessToken}`;
        const commonHeaders = { "Apikey": API_KEY, "Authorization": bearerToken, "Content-Type": "application/json" };

        const dashboardUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/dashboard`;
        const dashboardResponse = await axios.get(dashboardUrl, { headers: commonHeaders });
        const richDataMap = new Map();
        const targets = dashboardResponse.data.targets || [];
        const myTeam = dashboardResponse.data.myTeam || [];
        if (dashboardResponse.data.currentPlayer) richDataMap.set(dashboardResponse.data.currentPlayer.id, dashboardResponse.data.currentPlayer);
        targets.forEach(p => p && p.id && richDataMap.set(p.id, p));
        myTeam.forEach(p => p && p.id && richDataMap.set(p.id, p));

        let currentCursor = 0;
        let hasMorePages = true;
        while (hasMorePages) {
            const playersUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/players?cursor=${currentCursor}&filter=all&sort=alphabetical&group=team`;
            const playersResponse = await axios.get(playersUrl, { headers: commonHeaders });
            const pageData = playersResponse.data;
            if (pageData && pageData.teams && pageData.teams.length > 0) {
                pageData.teams.flatMap(team => team.players || []).forEach(p => {
                    if (p && p.id && !richDataMap.has(p.id)) richDataMap.set(p.id, p);
                });
                currentCursor++;
            } else {
                hasMorePages = false;
            }
        }
        console.log(`Total unique players in roster: ${richDataMap.size}`);

        const locationUrl = `${SUPABASE_URL}/rest/v1/rpc/get_user_locations_for_game_minimal_v2`;
        const locationResponse = await axios.post(locationUrl, { gid: GAME_ID }, { headers: commonHeaders });
        const locationResults = locationResponse.data;

        const targetIds = new Set(targets.map(p => p.id).filter(Boolean));
        const teammateIds = new Set(myTeam.map(p => p.id).filter(Boolean));
        const locatedPlayers = [], notLocatedPlayers = [], stealthedPlayers = [], safeZonePanelList = [];
        let mapWasUpdated = false;

        locationResults.forEach(locData => {
            const richData = richDataMap.get(locData.u);
            if (!richData) { return; }

            const lat = parseFloat(locData.l);
            const lng = parseFloat(locData.lo);
            const hasCoords = !isNaN(lat) && !isNaN(lng);

            if (hasCoords) {
                playerLastKnownLocationMap.set(locData.u, { lat, lng, updatedAt: locData.up });
                mapWasUpdated = true;
            }

            let role = 'neutral';
            if (targetIds.has(locData.u)) role = 'target';
            else if (teammateIds.has(locData.u)) role = 'teammate';

            const playerInfo = {
                u: locData.u, firstName: richData.first_name || 'Player', lastName: richData.last_name || ' ', teamName: richData.team_name || 'N/A', teamColor: richData.team_color || '#3388ff', avatarUrl: richData.avatar_path_small ? AVATAR_BASE_URL + richData.avatar_path_small : null, role: role, teamId: richData.team_id
            };

            const isSafe = richData.is_safe || locData.isz;
            const isStealth = (locData.l === null && locData.a === null) && !isSafe;

            if (isSafe || isStealth) {
                const lastKnown = playerLastKnownLocationMap.get(locData.u);
                const playerWithLastKnownCoords = lastKnown ? { ...playerInfo, ...lastKnown } : playerInfo;
                if (isSafe) {
                    safeZonePanelList.push({ ...playerWithLastKnownCoords, isSafeZone: true });
                } else {
                    stealthedPlayers.push({ ...playerWithLastKnownCoords, isSafeZone: false });
                }
            } else if (hasCoords) {
                locatedPlayers.push({
                    ...playerInfo, lat, lng,
                    status: locData.a, speed: parseFloat(locData.s || '0'), batteryLevel: parseFloat(locData.bl || '0'), isCharging: locData.ic, updatedAt: locData.up, accuracy: parseFloat(locData.ac || '0'), isSafeZone: false
                });
            } else {
                notLocatedPlayers.push({ ...playerInfo, reason: 'No location data available' });
            }
        });

        if (mapWasUpdated) { saveMapToFile(); }

        // --- UPDATED: Stealth expiration logic remains the same ---
        const currentStealthedIds = new Set(stealthedPlayers.map(p => p.u));
        for (const player of stealthedPlayers) {
            const existingEntry = stealthExpirationMap.get(player.u);
            const shouldFetch = !existingEntry || (Date.now() - existingEntry.fetchedAt > STEALTH_REFETCH_INTERVAL_MS);
            if (shouldFetch) {
                try {
                    console.log(`Fetching stealth expiration for ${player.firstName}...`);
                    const fullUserDataUrl = `${SUPABASE_URL}/rest/v1/rpc/get_map_user_full_v2`;
                    const response = await axios.post(fullUserDataUrl, { gid: GAME_ID, uid: player.u }, { headers: commonHeaders });
                    if (response.data && response.data.ive) {
                        stealthExpirationMap.set(player.u, { expiresAt: response.data.ive, fetchedAt: Date.now() });
                    }
                    await new Promise(resolve => setTimeout(resolve, 250));
                } catch (err) {
                    console.error(`Failed to fetch stealth data for ${player.u}:`, err.message);
                }
            }
        }
        for (const uid of stealthExpirationMap.keys()) {
            if (!currentStealthedIds.has(uid)) {
                stealthExpirationMap.delete(uid);
            }
        }
        const stealthedPlayersWithTimers = stealthedPlayers.map(player => {
            const expirationData = stealthExpirationMap.get(player.u);
            return { ...player, stealthExpiresAt: expirationData ? expirationData.expiresAt : null };
        });

        const dataToEmit = { located: locatedPlayers, notLocated: notLocatedPlayers, stealthed: stealthedPlayersWithTimers, safeZone: safeZonePanelList };
        lastSuccessfulData = dataToEmit;

        io.sockets.sockets.forEach(socket => {
            if (socket.data.filterConfig) {
                const userData = filterDataForUser(lastSuccessfulData, socket.data.filterConfig);
                socket.emit('locationUpdate', userData);
            }
        });

        console.log(`Broadcasted filtered data to ${io.engine.clientsCount} clients.`);

        // --- NEW: Notification Trigger Logic ---
        const currentlyLocatedPlayerIds = new Set(locatedPlayers.map(p => p.u));
        locatedPlayers.forEach(player => {
            if (player.role === 'target' && !previouslyLocatedPlayerIds.has(player.u)) {
                console.log(`Newly located target: ${player.firstName}. Preparing notification.`);
                const targetTeamId = player.teamId;
                const recipientUsernames = [];

                for (const username in loginConfigs) {
                    const config = loginConfigs[username];
                    if (config.canUseNotifications) {
                        const isMaster = !!config.isMaster;
                        const isTheirTarget = config.targetTeamIds && config.targetTeamIds.has(targetTeamId);

                        if (isMaster || isTheirTarget) {
                            recipientUsernames.push(username);
                        }
                    }
                }
                if (recipientUsernames.length > 0) {
                    const title = `Target Spotted: ${player.firstName}`;
                    const message = `${player.firstName} (${player.teamName}) is now on the map!`;
                    sendPushNotification(title, message, recipientUsernames);
                }
            }
        });
        previouslyLocatedPlayerIds = currentlyLocatedPlayerIds; // Update state for next cycle

        console.log("--- End API Request Cycle ---");

    } catch (error) {
        console.error("API Error during runApiRequests:", error.message);
        if (error.response) { console.error("Status:", error.response.status, "Data:", JSON.stringify(error.response.data)); }
    } finally {
        isFetching = false;
    }
}


// --- Connection and Server Start ---
io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}. Waiting for authentication.`);

    socket.on('authenticate', async (data) => {
        const username = data.username;
        const userConfig = loginConfigs[username];

        if (userConfig) {
            socket.data.username = username;
            console.log(`Socket ${socket.id} authenticated as user: ${username}`);

            let filterConfig;

            if (userConfig.isMaster) {
                filterConfig = {
                    isMaster: true,
                    canSeeAllPlayers: true,
                    canSeeLastKnownLocation: true
                };
            } else {
                 // Use pre-resolved values if they exist
                 const myTeamId = userConfig.team_id;
                 const targetTeamIds = userConfig.targetTeamIds || (userConfig.target_team_ids ? new Set(userConfig.target_team_ids) : new Set());
                 
                 if (myTeamId) {
                    filterConfig = {
                        isMaster: false,
                        myTeamId: myTeamId,
                        targetTeamIds: targetTeamIds,
                        canSeeAllPlayers: !!userConfig.canSeeAllPlayers,
                        canSeeLastKnownLocation: !!userConfig.canSeeLastKnownLocation
                    };
                 } else {
                    console.error(`[${username}] Could not determine team info. Disconnecting.`);
                    socket.emit('auth_error', 'Could not resolve team info.');
                    socket.disconnect();
                    return;
                 }
            }

            socket.data.filterConfig = filterConfig;

            if (lastSuccessfulData) {
                const userData = filterDataForUser(lastSuccessfulData, socket.data.filterConfig);
                socket.emit('locationUpdate', userData);
            }
        } else {
            console.log(`Socket ${socket.id} failed authentication for user: ${username}.`);
            socket.disconnect();
        }
    });

    socket.on('disconnect', () => {
        console.log(`User ${socket.data.username || 'unauthenticated'} disconnected. Total clients: ${io.engine.clientsCount}`);
    });
});

// NEW: Function to resolve reference logins before starting the server
async function initializeLogins() {
    console.log("Initializing and resolving login configurations...");
    for (const username in loginConfigs) {
        const config = loginConfigs[username];
        if (config.reference_login) {
            console.log(`Resolving reference login for ${username}...`);
            const resolvedIds = await resolveReferenceLogin(config.reference_login);
            if (resolvedIds) {
                // Mutate the config object with resolved data
                config.team_id = resolvedIds.myTeamId;
                config.targetTeamIds = resolvedIds.targetTeamIds;
                console.log(`Successfully resolved and updated config for ${username}.`);
            } else {
                console.warn(`Could not resolve reference login for ${username}. They may not see team-specific data.`);
            }
        } else if (config.target_team_ids) {
            // Ensure targetTeamIds is a Set for consistent lookups
            config.targetTeamIds = new Set(config.target_team_ids);
        }
    }
}

server.listen(PORT, async () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    loadMapFromFile();
    loadTokensFromFile();
    await initializeLogins(); // Wait for logins to be processed
    console.log("Starting continuous API fetch interval.");
    runApiRequests();
    setInterval(runApiRequests, FETCH_INTERVAL_MS);
});
