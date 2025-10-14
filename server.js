const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const OneSignal = require('@onesignal/node-onesignal');

// --- OneSignal Configuration ---
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || "95e17686-f5df-4181-a59a-f89457df2973";
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY || "os_v2_app_sxqxnbxv35aydjm27ckfpxzjomfttadpbojucjufkbq3psl4gtplmwxjdmqnlpogbp6k4n32ytgx3uy2gatb3hrj5bc3cngyvzzc7ji";

let oneSignalClient = null;
if (ONESIGNAL_APP_ID && ONESIGNAL_REST_API_KEY) {
    const configuration = OneSignal.createConfiguration({
        authMethods: {
            app_key: {
                tokenProvider: {
                    getToken() {
                        return ONESIGNAL_REST_API_KEY;
                    }
                }
            }
        }
    });
    oneSignalClient = new OneSignal.DefaultApi(configuration);
    console.log("OneSignal client configured successfully.");
} else {
    console.warn("OneSignal environment variables not set. Push notifications will be disabled.");
}

// --- Load Login Configurations ---
const LOGINS_FILE = path.join(__dirname, 'logins.json');
let loginConfigs = {};

if (process.env.LOGINS_JSON) {
    try {
        loginConfigs = JSON.parse(process.env.LOGINS_JSON);
        console.log(`Loaded ${Object.keys(loginConfigs).length} login configurations from environment variable.`);
    } catch (err) {
        console.error("FATAL ERROR: Could not parse LOGINS_JSON environment variable.", err);
        process.exit(1);
    }
} else {
    try {
        loginConfigs = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf8'));
        console.log(`Loaded ${Object.keys(loginConfigs).length} login configurations from local logins.json file.`);
    } catch (err) {
        console.error("FATAL ERROR: Could not read logins.json file. Make sure it exists or LOGINS_JSON env var is set.", err);
        process.exit(1);
    }
}

// --- Persistent Token Management ---
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

// --- Helper function for distance calculation ---
function calculateDistanceMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Radius of the Earth in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// --- Login Endpoint ---
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
        const isMaster = !!userConfig.isMaster;
        res.json({
            token: token,
            username: username,
            isMaster: isMaster,
            displayName: userConfig.displayName,
            canSeeAllPlayers: isMaster || !!userConfig.canSeeAllPlayers,
            canSeeLastKnownLocation: isMaster || !!userConfig.canSeeLastKnownLocation,
            canUseNotifications: isMaster || !!userConfig.canUseNotifications
        });
    } else {
        res.status(401).json({ message: 'Invalid credentials' });
    }
});

// --- Token Login Endpoint ---
app.post('/token-login', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: 'Token is required' });

    const tokenData = persistentTokens.get(token);

    if (tokenData && new Date(tokenData.expiresAt) > new Date()) {
        const userConfig = loginConfigs[tokenData.username];
        if (userConfig) {
            console.log(`User ${tokenData.username} logged in via token.`);
            const isMaster = !!userConfig.isMaster;
            res.json({
                username: tokenData.username,
                isMaster: isMaster,
                displayName: userConfig.displayName,
                canSeeAllPlayers: isMaster || !!userConfig.canSeeAllPlayers,
                canSeeLastKnownLocation: isMaster || !!userConfig.canSeeLastKnownLocation,
                canUseNotifications: isMaster || !!userConfig.canUseNotifications
            });
        } else {
            persistentTokens.delete(token);
            saveTokensToFile();
            res.status(401).json({ message: 'User no longer exists' });
        }
    } else {
        if (tokenData) {
            persistentTokens.delete(token);
            saveTokensToFile();
        }
        res.status(401).json({ message: 'Invalid or expired token' });
    }
});

// --- Logout Endpoint ---
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
    email: process.env.API_EMAIL || "gabrielpchicas@gmail.com",
    password: process.env.API_PASSWORD || "Pennyfart12@",
    goture_meta_security: {},
};

// --- State Management ---
let isFetching = false;
let lastSuccessfulData = null;
let lastRichDataMap = new Map();
let masterTeamId = null; // The team ID of the server's API account
let masterTargetIds = new Set(); // The target IDs of the server's API account
const FETCH_INTERVAL_MS = 10000;
const LOCATION_MEMORY_FILE = path.join(__dirname, 'last_locations.json');
let playerLastKnownLocationMap = new Map();
let previousPlayerStatusMap = new Map();
const stealthExpirationMap = new Map();
const STEALTH_REFETCH_INTERVAL_MS = 2 * 60 * 1000;

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
    const myTeamId = userFilterConfig.myTeamId;
    const targetTeamIds = userFilterConfig.targetTeamIds || new Set();
    const shouldFilterByTeam = !userFilterConfig.isMaster && !userFilterConfig.canSeeAllPlayers;

    const processPlayers = (players) => {
        if (!players) return [];
        let processed = players;

        if (shouldFilterByTeam) {
            const allowedTeamIds = new Set([myTeamId, ...targetTeamIds]);
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

// --- Notification Processing Logic ---
async function sendPushNotification(playerIds, heading, content) {
    if (!oneSignalClient || playerIds.length === 0) return;

    const notification = {
        app_id: ONESIGNAL_APP_ID,
        include_player_ids: playerIds,
        headings: { en: heading },
        contents: { en: content },
    };

    try {
        console.log(`Sending push notification to ${playerIds.length} player(s)...`);
        await oneSignalClient.createNotification(notification);
    } catch (e) {
        console.error("Error sending OneSignal push notification:", e.body);
    }
}

function processNotifications(fullData) {
    const newPlayerStatusMap = new Map();
    const allPlayersWithLocation = new Map();

    [...fullData.located, ...fullData.safeZone, ...fullData.stealthed].forEach(p => {
        if (p.lat && p.lng) allPlayersWithLocation.set(p.u, { lat: p.lat, lng: p.lng });
        if (p.isSafeZone) newPlayerStatusMap.set(p.u, 'safeZone');
        else if (fullData.stealthed.some(sp => sp.u === p.u)) newPlayerStatusMap.set(p.u, 'stealthed');
        else newPlayerStatusMap.set(p.u, 'located');
    });
    fullData.notLocated.forEach(p => newPlayerStatusMap.set(p.u, 'notLocated'));

    io.sockets.sockets.forEach(socket => {
        const settings = socket.data.notificationSettings;
        if (!settings || !settings.enabled) return;

        if (settings.myPlayerId) {
            const myPlayerLocation = allPlayersWithLocation.get(settings.myPlayerId);
            if (!myPlayerLocation) return;

            const previouslyInRange = socket.data.playersInRange || new Set();
            const currentlyInRange = new Set();

            if (settings.proximityMiles > 0) {
                for (const otherPlayer of fullData.located) {
                    if (otherPlayer.u === settings.myPlayerId) continue;
                    const distance = calculateDistanceMiles(myPlayerLocation.lat, myPlayerLocation.lng, otherPlayer.lat, otherPlayer.lng);
                    if (distance <= settings.proximityMiles) {
                        currentlyInRange.add(otherPlayer.u);
                        if (!previouslyInRange.has(otherPlayer.u)) {
                            socket.emit('proximity_alert', { player: { name: `${otherPlayer.firstName} ${otherPlayer.lastName}`, teamName: otherPlayer.teamName }, distance: distance.toFixed(2) });
                            const oneSignalPlayerId = socket.data.oneSignalPlayerId;
                            if (oneSignalPlayerId) {
                                sendPushNotification([oneSignalPlayerId], 'Proximity Alert!', `${otherPlayer.firstName} ${otherPlayer.lastName} (${otherPlayer.teamName}) is now within ${distance.toFixed(2)} miles of you.`);
                            }
                        }
                    }
                }
            }
            socket.data.playersInRange = currentlyInRange;
        }

        newPlayerStatusMap.forEach((currentStatus, playerId) => {
            if (settings.myPlayerId && playerId === settings.myPlayerId) return;

            const previousStatus = previousPlayerStatusMap.get(playerId) || 'unknown';
            const justWentGhost = (previousStatus === 'located') && (currentStatus === 'stealthed' || currentStatus === 'notLocated');

            if (justWentGhost) {
                const ghostPlayerInfo = lastRichDataMap.get(playerId);
                const ghostLastLocation = playerLastKnownLocationMap.get(playerId);
                if (!ghostPlayerInfo || !ghostLastLocation) return;

                let isInRange = false;
                if (settings.ghostMiles === -1) {
                    isInRange = true;
                } else if (settings.ghostMiles > 0) {
                    const myPlayerLocation = allPlayersWithLocation.get(settings.myPlayerId);
                    if (myPlayerLocation) {
                        const distance = calculateDistanceMiles(myPlayerLocation.lat, myPlayerLocation.lng, ghostLastLocation.lat, ghostLastLocation.lng);
                        if (distance <= settings.ghostMiles) isInRange = true;
                    }
                }

                if (isInRange) {
                    socket.emit('ghost_alert', { player: { name: `${ghostPlayerInfo.first_name} ${ghostPlayerInfo.last_name}`, teamName: ghostPlayerInfo.team_name } });
                    const oneSignalPlayerId = socket.data.oneSignalPlayerId;
                    if (oneSignalPlayerId) {
                        sendPushNotification([oneSignalPlayerId], 'Ghost Alert!', `${ghostPlayerInfo.first_name} ${ghostPlayerInfo.last_name} (${ghostPlayerInfo.team_name}) just went off the grid.`);
                    }
                }
            }
        });
    });
    previousPlayerStatusMap = new Map(newPlayerStatusMap.entries());
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
        
        if (myTeam.length > 0 && myTeam[0].team_id) masterTeamId = myTeam[0].team_id;
        masterTargetIds = new Set(targets.map(p => p.team_id).filter(Boolean));

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
        lastRichDataMap = richDataMap;

        const locationUrl = `${SUPABASE_URL}/rest/v1/rpc/get_user_locations_for_game_minimal_v2`;
        const locationResponse = await axios.post(locationUrl, { gid: GAME_ID }, { headers: commonHeaders });
        const locationResults = locationResponse.data;

        const locatedPlayers = [], notLocatedPlayers = [], stealthedPlayers = [], safeZonePanelList = [];
        let mapWasUpdated = false;

        locationResults.forEach(locData => {
            const richData = richDataMap.get(locData.u);
            if (!richData) return;
            const lat = parseFloat(locData.l), lng = parseFloat(locData.lo);
            const hasCoords = !isNaN(lat) && !isNaN(lng);

            if (hasCoords) {
                playerLastKnownLocationMap.set(locData.u, { lat, lng, updatedAt: locData.up });
                mapWasUpdated = true;
            }
            const playerInfo = { u: locData.u, firstName: richData.first_name || 'Player', lastName: richData.last_name || ' ', teamName: richData.team_name || 'N/A', teamColor: richData.team_color || '#3388ff', avatarUrl: richData.avatar_path_small ? AVATAR_BASE_URL + richData.avatar_path_small : null, teamId: richData.team_id };
            const isSafe = richData.is_safe || locData.isz;
            const isStealth = (locData.l === null && locData.a === null) && !isSafe;

            if (isSafe || isStealth) {
                const lastKnown = playerLastKnownLocationMap.get(locData.u);
                const playerWithCoords = lastKnown ? { ...playerInfo, ...lastKnown } : playerInfo;
                if (isSafe) safeZonePanelList.push({ ...playerWithCoords, isSafeZone: true });
                else stealthedPlayers.push({ ...playerWithCoords, isSafeZone: false });
            } else if (hasCoords) {
                locatedPlayers.push({ ...playerInfo, lat, lng, speed: parseFloat(locData.s || '0'), batteryLevel: parseFloat(locData.bl || '0'), isCharging: locData.ic, updatedAt: locData.up, accuracy: parseFloat(locData.ac || '0'), isSafeZone: false });
            } else {
                notLocatedPlayers.push({ ...playerInfo, reason: 'No location data available' });
            }
        });

        if (mapWasUpdated) saveMapToFile();

        const currentStealthedIds = new Set(stealthedPlayers.map(p => p.u));
        for (const player of stealthedPlayers) {
            const existingEntry = stealthExpirationMap.get(player.u);
            const shouldFetch = !existingEntry || (Date.now() - existingEntry.fetchedAt > STEALTH_REFETCH_INTERVAL_MS);
            if (shouldFetch) {
                try {
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
            if (!currentStealthedIds.has(uid)) stealthExpirationMap.delete(uid);
        }
        const stealthedPlayersWithTimers = stealthedPlayers.map(player => ({ ...player, stealthExpiresAt: stealthExpirationMap.get(player.u)?.expiresAt || null }));

        lastSuccessfulData = { located: locatedPlayers, notLocated: notLocatedPlayers, stealthed: stealthedPlayersWithTimers, safeZone: safeZonePanelList };
        io.sockets.sockets.forEach(socket => {
            if (socket.data.filterConfig) {
                socket.emit('locationUpdate', filterDataForUser(lastSuccessfulData, socket.data.filterConfig));
            }
        });
        processNotifications(lastSuccessfulData);

        console.log(`Broadcasted filtered data to ${io.engine.clientsCount} clients.`);
        console.log("--- End API Request Cycle ---");

    } catch (error) {
        console.error("API Error during runApiRequests:", error.message);
        if (error.response) console.error("Status:", error.response.status, "Data:", JSON.stringify(error.response.data));
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

        if (!userConfig) {
            console.log(`Socket ${socket.id} failed authentication for user: ${username}.`);
            return socket.disconnect();
        }

        socket.data.username = username;
        console.log(`Socket ${socket.id} authenticated as user: ${username}`);
        
        let resolvedIds = null;
        let teammates = [];

        if (userConfig.reference_login) {
            console.log(`[${username}] Using reference login to resolve team info...`);
            resolvedIds = await resolveReferenceLogin(userConfig.reference_login);
        } else if (userConfig.team_id) {
            console.log(`[${username}] Using direct ID configuration.`);
            resolvedIds = { myTeamId: userConfig.team_id, targetTeamIds: new Set(userConfig.target_team_ids || []) };
        } else {
            console.log(`[${username}] No specific team config found. Using server default perspective.`);
            resolvedIds = { myTeamId: masterTeamId, targetTeamIds: masterTargetIds };
        }

        if (!resolvedIds || !resolvedIds.myTeamId) {
            console.error(`[${username}] Could not resolve team info. Disconnecting.`);
            socket.emit('auth_error', 'Could not resolve team info.');
            return socket.disconnect();
        }

        const filterConfig = {
            isMaster: !!userConfig.isMaster,
            myTeamId: resolvedIds.myTeamId,
            targetTeamIds: resolvedIds.targetTeamIds,
            canSeeAllPlayers: !!userConfig.isMaster || !!userConfig.canSeeAllPlayers,
            canSeeLastKnownLocation: !!userConfig.isMaster || !!userConfig.canSeeLastKnownLocation
        };
        socket.data.filterConfig = filterConfig;

        if ((!!userConfig.isMaster || !!userConfig.canUseNotifications) && lastRichDataMap.size > 0) {
            for (const player of lastRichDataMap.values()) {
                if (player.team_id === resolvedIds.myTeamId) {
                    teammates.push({ id: player.id, name: `${player.first_name} ${player.last_name}`.trim() });
                }
            }
        }
        
        socket.emit('auth_success', { teammates });

        if (lastSuccessfulData) {
            const userData = filterDataForUser(lastSuccessfulData, socket.data.filterConfig);
            socket.emit('locationUpdate', userData);
        }
    });

    socket.on('update_notification_settings', (settings) => {
        console.log(`[${socket.data.username}] updated notification settings:`, settings);
        socket.data.notificationSettings = settings;
        socket.data.playersInRange = new Set();
    });
    
    socket.on('register_one_signal', (oneSignalPlayerId) => {
        if (oneSignalPlayerId) {
            socket.data.oneSignalPlayerId = oneSignalPlayerId;
            console.log(`[${socket.data.username || socket.id}] registered for push notifications with ID: ${oneSignalPlayerId}`);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User ${socket.data.username || 'unauthenticated'} disconnected. Total clients: ${io.engine.clientsCount}`);
    });
});

// ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼ FIX START ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
// Wrap the server startup in an async function to fix the race condition.
async function startServer() {
    console.log("Starting server...");
    loadMapFromFile();
    loadTokensFromFile();

    console.log("Performing initial API data fetch before accepting connections...");
    // By awaiting the first run, we ensure lastRichDataMap is populated
    // before any client can connect and authenticate.
    await runApiRequests(); 

    // Now that we have data, we can start the recurring fetch interval.
    setInterval(runApiRequests, FETCH_INTERVAL_MS);

    // And finally, start listening for connections.
    server.listen(PORT, () => {
        console.log(`Server is ready and listening on http://localhost:${PORT}`);
    });
}

// Execute the startup function.
startServer();
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲ FIX END ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
