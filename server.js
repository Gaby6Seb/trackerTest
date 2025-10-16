const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const OneSignal = require('@onesignal/node-onesignal');
const helmet = require('helmet');

// --- OneSignal Configuration (Unchanged) ---
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
let oneSignalClient = null;
if (ONESIGNAL_APP_ID && ONESIGNAL_REST_API_KEY) {
    try {
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
    } catch (err) {
        console.error("Failed to initialize OneSignal client:", err.message);
        oneSignalClient = null;
    }
} else {
    console.warn("OneSignal environment variables not set. Push notifications will be disabled.");
}

// --- Load Login Configurations (Unchanged) ---
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

// --- Persistent Token Management (Unchanged) ---
const TOKEN_FILE = path.join(__dirname, 'persistent_tokens.json');
let persistentTokens = new Map();
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

// --- Server Setup (Unchanged) ---
const app = express();
app.use(helmet.contentSecurityPolicy({
    directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.onesignal.com", "https://*.onesignal.com", "https://unpkg.com", "https://cdnjs.cloudflare.com", ],
        workerSrc: ["'self'", "blob:", "https://cdn.onesignal.com", "https://*.onesignal.com", ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://onesignal.com", "https://*.onesignal.com", ],
        imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org", "https://erspvsdfwaqjtuhymubj.supabase.co", "https://*.onesignal.com", ],
        frameSrc: ["'self'", "https://onesignal.com", "https://*.onesignal.com"],
        connectSrc: ["'self'", "wss://trackertest-production-6d3f.up.railway.app", "https://*.onesignal.com", "https://erspvsdfwaqjtuhymubj.supabase.co", ],
    },
}));
app.use(express.json());
app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'];
    if (process.env.NODE_ENV === 'production' && proto !== 'https') {
        return res.redirect(301, `https://${req.hostname}${req.url}`);
    }
    next();
});
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*"
    }
});
const PORT = process.env.PORT || 3000;
app.get('/OneSignalSDKWorker.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'public', 'OneSignalSDKWorker.js'));
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// --- Helper & Login/Logout Endpoints (Unchanged) ---
function calculateDistanceMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
app.post('/login', (req, res) => {
    const {
        username,
        password,
        rememberMe
    } = req.body;
    const userConfig = loginConfigs[username];
    if (userConfig && userConfig.password === password) {
        let token = null;
        if (rememberMe) {
            token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            persistentTokens.set(token, {
                username,
                expiresAt
            });
            saveTokensToFile();
        }
        const isMaster = !!userConfig.isMaster;
        res.json({
            token,
            username,
            isMaster,
            displayName: userConfig.displayName,
            canSeeAllPlayers: isMaster || !!userConfig.canSeeAllPlayers,
            canSeeLastKnownLocation: isMaster || !!userConfig.canSeeLastKnownLocation,
            canUseNotifications: isMaster || !!userConfig.canUseNotifications
        });
    } else {
        res.status(401).json({
            message: 'Invalid credentials'
        });
    }
});
app.post('/token-login', (req, res) => {
    const {
        token
    } = req.body;
    if (!token) return res.status(400).json({
        message: 'Token is required'
    });
    const tokenData = persistentTokens.get(token);
    if (tokenData && new Date(tokenData.expiresAt) > new Date()) {
        const userConfig = loginConfigs[tokenData.username];
        if (userConfig) {
            const isMaster = !!userConfig.isMaster;
            res.json({
                username: tokenData.username,
                isMaster,
                displayName: userConfig.displayName,
                canSeeAllPlayers: isMaster || !!userConfig.canSeeAllPlayers,
                canSeeLastKnownLocation: isMaster || !!userConfig.canSeeLastKnownLocation,
                canUseNotifications: isMaster || !!userConfig.canUseNotifications
            });
        } else {
            persistentTokens.delete(token);
            saveTokensToFile();
            res.status(401).json({
                message: 'User no longer exists'
            });
        }
    } else {
        if (tokenData) persistentTokens.delete(token);
        saveTokensToFile();
        res.status(401).json({
            message: 'Invalid or expired token'
        });
    }
});
app.post('/logout', (req, res) => {
    const {
        token
    } = req.body;
    if (token && persistentTokens.has(token)) {
        persistentTokens.delete(token);
        saveTokensToFile();
    }
    res.status(200).json({
        message: 'Logged out successfully'
    });
});

// --- Notification Sending Logic (Unchanged) ---
async function sendPushNotification(externalUserIds, heading, content) {
    if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
        const errorMsg = "OneSignal environment variables are not set.";
        console.error(errorMsg);
        throw new Error(errorMsg);
    }
    if (!externalUserIds || externalUserIds.length === 0) {
        const errorMsg = "Cannot send notification to empty user list.";
        console.warn(errorMsg);
        throw new Error(errorMsg);
    }
    try {
        console.log(`Sending notification via Axios to external_id(s): [${externalUserIds.join(', ')}]`);
        const response = await axios.post("https://onesignal.com/api/v1/notifications", {
            app_id: ONESIGNAL_APP_ID,
            include_aliases: {
                external_id: externalUserIds
            },
            target_channel: "push",
            headings: {
                en: heading
            },
            contents: {
                en: content
            },
        }, {
            headers: {
                "Authorization": `Basic ${ONESIGNAL_REST_API_KEY}`,
                "Content-Type": "application/json",
            },
        });
        console.log(`Push notification sent successfully. ID: ${response.data.id}, Recipients: ${response.data.recipients}`);
        return response.data;
    } catch (error) {
        console.error("--- OneSignal Push Notification FAILED (using Axios) ---");
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Error Message:", error.message);
        }
        console.error("------------------------------------------------------");
        const errorMessage = error.response?.data?.errors?.[0] || error.message;
        throw new Error(errorMessage);
    }
}
app.post('/test-notification', async (req, res) => {
    const {
        externalId
    } = req.body;
    if (!externalId) {
        return res.status(400).json({
            message: 'External ID is required.'
        });
    }
    try {
        await sendPushNotification([externalId], 'Test Notification', 'This is a test notification from the server.');
        res.json({
            success: true,
            message: 'Test notification sent'
        });
    } catch (err) {
        console.error("Failed to send test notification:", err);
        res.status(500).json({
            success: false,
            message: 'Failed to send test notification',
            error: err.message
        });
    }
});

// --- API Configuration & State Management (Unchanged) ---
const SUPABASE_URL = "https://erspvsdfwaqjtuhymubj.supabase.co";
const SPLASHIN_API_URL = "https://splashin.app/api/v3";
const API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyc3B2c2Rmd2FxanR1aHltdWJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE2ODM1ODY0MjcsImV4cCI6MTk5OTE2MjQyN30.2AItrHcB7A5bSZ_dfd455kvLL8fXLL7IrfMBoFmkGww";
const GAME_ID = "c8862e51-4f00-42e7-91ed-55a078d57efc";
const AVATAR_BASE_URL = "https://erspvsdfwaqjtuhymubj.supabase.co/storage/v1/object/public/avatars/";
const authData = {
    email: process.env.API_EMAIL,
    password: process.env.API_PASSWORD,
    goture_meta_security: {}
};
let isFetching = false;
let lastSuccessfulData = null;
let lastRichDataMap = new Map();
let masterTeamId = null;
let masterTargetIds = new Set();
const FETCH_INTERVAL_MS = 10000;
const LOCATION_MEMORY_FILE = path.join(__dirname, 'last_locations.json');
let playerLastKnownLocationMap = new Map();
let previousPlayerStatusMap = new Map();
const stealthExpirationMap = new Map();
const STEALTH_REFETCH_INTERVAL_MS = 2 * 60 * 1000;
function saveMapToFile() {
    fs.writeFile(LOCATION_MEMORY_FILE, JSON.stringify(Array.from(playerLastKnownLocationMap.entries())), 'utf8', (err) => {
        if (err) console.error("Error saving location memory:", err);
    });
}
function loadMapFromFile() {
    try {
        if (fs.existsSync(LOCATION_MEMORY_FILE)) {
            playerLastKnownLocationMap = new Map(JSON.parse(fs.readFileSync(LOCATION_MEMORY_FILE, 'utf8')));
            console.log(`Loaded ${playerLastKnownLocationMap.size} locations from memory.`);
        }
    } catch (err) {
        console.error("Error reading location memory file:", err);
    }
}

// --- Data Filtering & Resolution Logic (Unchanged) ---
function filterDataForUser(fullData, userFilterConfig) {
    const myTeamId = userFilterConfig.myTeamId;
    const targetTeamIds = userFilterConfig.targetTeamIds || new Set();
    const shouldFilterByTeam = !userFilterConfig.isMaster && !userFilterConfig.canSeeAllPlayers;
    const processPlayers = (players) => {
        if (!players) return [];
        let processed = players.filter(p => shouldFilterByTeam ? new Set([myTeamId, ...targetTeamIds]).has(p.teamId) : true);
        return processed.map(p => {
            let role = p.teamId === myTeamId ? 'teammate' : (targetTeamIds.has(p.teamId) ? 'target' : 'neutral');
            return { ...p,
                role
            };
        });
    };
    const result = {
        located: processPlayers(fullData.located),
        notLocated: processPlayers(fullData.notLocated),
        stealthed: processPlayers(fullData.stealthed),
        safeZone: processPlayers(fullData.safeZone)
    };
    if (!userFilterConfig.canSeeLastKnownLocation) {
        const stripCoords = (player) => {
            const {
                lat,
                lng,
                ...rest
            } = player;
            return rest;
        };
        result.stealthed = result.stealthed.map(stripCoords);
        result.safeZone = result.safeZone.map(stripCoords);
    }
    return result;
}
async function resolveReferenceLogin(loginDetails) {
    try {
        const authHeaders = {
            "Apikey": API_KEY
        };
        const authUrl = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
        const refAuthData = { ...loginDetails,
            goture_meta_security: {}
        };
        const authResponse = await axios.post(authUrl, refAuthData, {
            headers: authHeaders
        });
        const accessToken = authResponse.data.access_token;
        const bearerToken = `Bearer ${accessToken}`;
        const commonHeaders = {
            "Apikey": API_KEY,
            "Authorization": bearerToken
        };
        const dashboardUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/dashboard`;
        const dashboardResponse = await axios.get(dashboardUrl, {
            headers: commonHeaders
        });
        const myTeamId = dashboardResponse.data?.myTeam?.[0]?.team_id;
        if (!myTeamId) throw new Error("Could not determine team ID from dashboard.");
        const targetTeamIds = new Set(dashboardResponse.data.targets?.map(t => t.team_id).filter(Boolean) || []);
        return {
            myTeamId,
            targetTeamIds
        };
    } catch (error) {
        console.error(`Failed to resolve reference login for ${loginDetails.email}:`, error.message);
        return null;
    }
}

// --- FIXED: Notification Processing Logic ---
function processNotifications(fullData) {
    const newPlayerStatusMap = new Map();
    const allPlayersWithLocation = new Map();

    const allPlayersMap = new Map();
    [...fullData.notLocated, ...fullData.located, ...fullData.safeZone, ...fullData.stealthed].forEach(p => allPlayersMap.set(p.u, p));

    allPlayersMap.forEach((p, uid) => {
        if (p.lat && p.lng) allPlayersWithLocation.set(uid, {
            lat: p.lat,
            lng: p.lng
        });

        let status = 'notLocated';
        if (fullData.located.some(pl => pl.u === uid)) status = 'located';
        if (fullData.safeZone.some(pl => pl.u === uid)) status = 'safeZone';
        if (fullData.stealthed.some(pl => pl.u === uid && !pl.isImmune)) status = 'stealthed';
        if (p.isImmune) status = 'immune';

        newPlayerStatusMap.set(uid, status);
    });

    io.sockets.sockets.forEach(socket => {
        const settings = socket.data.notificationSettings;
        if (!settings || !settings.enabled) return;
        const userExternalId = settings.myPlayerId;
        if (!userExternalId) return;
        const receiverLocation = socket.data.liveLocation || allPlayersWithLocation.get(userExternalId);
        const previouslyInRange = socket.data.playersInRange || new Set();
        const currentlyInRange = new Set();
        if (receiverLocation && settings.proximityMiles > 0) {
            fullData.located.forEach(otherPlayer => {
                if (otherPlayer.u === userExternalId) return;
                const distance = calculateDistanceMiles(receiverLocation.lat, receiverLocation.lng, otherPlayer.lat, otherPlayer.lng);
                if (distance <= settings.proximityMiles) {
                    currentlyInRange.add(otherPlayer.u);
                    if (!previouslyInRange.has(otherPlayer.u)) {
                        socket.emit('proximity_alert', {
                            player: {
                                name: `${otherPlayer.firstName} ${otherPlayer.lastName}`,
                                teamName: otherPlayer.teamName
                            },
                            distance: distance.toFixed(2)
                        });
                        sendPushNotification([userExternalId], 'Proximity Alert!', `${otherPlayer.firstName} ${otherPlayer.lastName} (${otherPlayer.teamName}) is now within ${distance.toFixed(2)} miles of you.`);
                    }
                }
            });
        }
        socket.data.playersInRange = currentlyInRange;
        newPlayerStatusMap.forEach((currentStatus, playerId) => {
            if (playerId === userExternalId) return;
            const previousStatus = previousPlayerStatusMap.get(playerId) || 'unknown';
            if (previousStatus === 'located' && (currentStatus === 'stealthed' || currentStatus === 'notLocated')) {
                const ghostPlayerInfo = lastRichDataMap.get(playerId);
                const ghostLastLocation = playerLastKnownLocationMap.get(playerId);
                if (!ghostPlayerInfo || !ghostLastLocation) return;
                let isInRange = settings.ghostMiles === -1;
                if (!isInRange && settings.ghostMiles > 0 && receiverLocation) {
                    const distance = calculateDistanceMiles(receiverLocation.lat, receiverLocation.lng, ghostLastLocation.lat, ghostLastLocation.lng);
                    if (distance <= settings.ghostMiles) isInRange = true;
                }
                if (isInRange) {
                    socket.emit('ghost_alert', {
                        player: {
                            name: `${ghostPlayerInfo.first_name} ${ghostPlayerInfo.last_name}`,
                            teamName: ghostPlayerInfo.team_name
                        }
                    });
                    sendPushNotification([userExternalId], 'Ghost Alert!', `${ghostPlayerInfo.first_name} ${ghostPlayerInfo.last_name} (${ghostPlayerInfo.team_name}) just went off the grid.`);
                }
            }
        });
    });
    previousPlayerStatusMap = new Map(newPlayerStatusMap);
}

// --- FIXED: Core API Fetching Logic ---
async function runApiRequests() {
    if (isFetching) return;
    try {
        isFetching = true;
        console.log("--- Starting API Request Cycle ---");

        // Authentication
        const authHeaders = {
            "Apikey": API_KEY
        };
        const authUrl = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
        const authResponse = await axios.post(authUrl, authData, {
            headers: authHeaders
        });
        const accessToken = authResponse.data.access_token;
        const bearerToken = `Bearer ${accessToken}`;
        const commonHeaders = {
            "Apikey": API_KEY,
            "Authorization": bearerToken,
            "Content-Type": "application/json"
        };

        // Fetch Dashboard Data
        const dashboardUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/dashboard`;
        const dashboardResponse = await axios.get(dashboardUrl, {
            headers: commonHeaders
        });
        const richDataMap = new Map();
        const targets = dashboardResponse.data.targets || [];
        const myTeam = dashboardResponse.data.myTeam || [];
        if (myTeam.length > 0 && myTeam[0].team_id) {
            masterTeamId = myTeam[0].team_id;
        }
        masterTargetIds = new Set(targets.map(p => p.team_id).filter(Boolean));
        if (dashboardResponse.data.currentPlayer) {
            richDataMap.set(dashboardResponse.data.currentPlayer.id, dashboardResponse.data.currentPlayer);
        }
        targets.forEach(p => p && p.id && richDataMap.set(p.id, p));
        myTeam.forEach(p => p && p.id && richDataMap.set(p.id, p));

        // Fetch Player Pages
        let currentCursor = 0;
        let hasMorePages = true;
        while (hasMorePages) {
            const playersUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/players?cursor=${currentCursor}&filter=all&sort=alphabetical&group=team`;
            const playersResponse = await axios.get(playersUrl, {
                headers: commonHeaders
            });
            const pageData = playersResponse.data;
            if (pageData && pageData.teams && pageData.teams.length > 0) {
                pageData.teams.flatMap(team => team.players || []).forEach(p => {
                    if (p && p.id && !richDataMap.has(p.id)) {
                        richDataMap.set(p.id, p);
                    }
                });
                currentCursor++;
            } else {
                hasMorePages = false;
            }
        }
        lastRichDataMap = richDataMap;

        // Fetch Player Locations
        const locationUrl = `${SUPABASE_URL}/rest/v1/rpc/get_user_locations_for_game_minimal_v2`;
        const locationResponse = await axios.post(locationUrl, {
            gid: GAME_ID
        }, {
            headers: commonHeaders
        });
        const locatedPlayers = [];
        const notLocatedPlayers = [];
        const stealthedOrImmunePlayers = [];
        const safeZonePlayers = [];
        let mapWasUpdated = false;

        locationResponse.data.forEach(locData => {
            const richData = richDataMap.get(locData.u);
            if (!richData) return;

            const lat = parseFloat(locData.l);
            const lng = parseFloat(locData.lo);
            const hasCoords = !isNaN(lat) && !isNaN(lng);

            if (hasCoords) {
                playerLastKnownLocationMap.set(locData.u, {
                    lat,
                    lng,
                    updatedAt: locData.up
                });
                mapWasUpdated = true;
            }

            const isImmune = !!(richData.is_safe_expires_at && new Date(richData.is_safe_expires_at) > new Date());
            const isInGeographicSafeZone = richData.is_safe || locData.isz;
            const isStealth = (locData.l === null && locData.a === null);

            const playerInfo = {
                u: locData.u,
                firstName: richData.first_name || 'Player',
                lastName: richData.last_name || ' ',
                teamName: richData.team_name || 'N/A',
                teamColor: richData.team_color || '#3388ff',
                avatarUrl: richData.avatar_path_small ? AVATAR_BASE_URL + richData.avatar_path_small : null,
                teamId: richData.team_id,
                isImmune: isImmune,
                immunityExpiresAt: isImmune ? richData.is_safe_expires_at : null
            };

            if (hasCoords) {
                locatedPlayers.push({ ...playerInfo,
                    lat,
                    lng,
                    speed: parseFloat(locData.s || '0'),
                    batteryLevel: parseFloat(locData.bl || '0'),
                    isCharging: locData.ic,
                    updatedAt: locData.up,
                    accuracy: parseFloat(locData.ac || '0'),
                    isSafeZone: isInGeographicSafeZone
                });
            }

            const lastKnown = playerLastKnownLocationMap.get(locData.u);
            const playerWithLastKnownCoords = lastKnown ? { ...playerInfo,
                ...lastKnown
            } : playerInfo;

            if (isImmune) {
                stealthedOrImmunePlayers.push({ ...playerWithLastKnownCoords,
                    isSafeZone: false
                });
            } else if (isStealth && !isInGeographicSafeZone) {
                stealthedOrImmunePlayers.push({ ...playerWithLastKnownCoords,
                    isSafeZone: false
                });
            } else if (isInGeographicSafeZone) {
                safeZonePlayers.push({ ...playerWithLastKnownCoords,
                    isSafeZone: true
                });
            } else if (!hasCoords) {
                notLocatedPlayers.push({ ...playerInfo,
                    reason: 'No location data available'
                });
            }
        });
        if (mapWasUpdated) saveMapToFile();

        const stealthedForTimerFetch = stealthedOrImmunePlayers.filter(p => !p.isImmune);
        const currentStealthedIds = new Set(stealthedForTimerFetch.map(p => p.u));
        for (const player of stealthedForTimerFetch) {
            const existingEntry = stealthExpirationMap.get(player.u);
            if (!existingEntry || (Date.now() - existingEntry.fetchedAt > STEALTH_REFETCH_INTERVAL_MS)) {
                try {
                    const fullUserDataUrl = `${SUPABASE_URL}/rest/v1/rpc/get_map_user_full_v2`;
                    const response = await axios.post(fullUserDataUrl, {
                        gid: GAME_ID,
                        uid: player.u
                    }, {
                        headers: commonHeaders
                    });
                    if (response.data && response.data.ive) {
                        stealthExpirationMap.set(player.u, {
                            expiresAt: response.data.ive,
                            fetchedAt: Date.now()
                        });
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
        const stealthedPlayersWithTimers = stealthedOrImmunePlayers.map(player => {
            if (!player.isImmune) {
                return { ...player,
                    stealthExpiresAt: stealthExpirationMap.get(player.u)?.expiresAt || null
                };
            }
            return player;
        });

        lastSuccessfulData = {
            located: locatedPlayers,
            notLocated: notLocatedPlayers,
            stealthed: stealthedPlayersWithTimers,
            safeZone: safeZonePlayers
        };
        io.sockets.sockets.forEach(socket => {
            if (socket.data.filterConfig) {
                socket.emit('locationUpdate', filterDataForUser(lastSuccessfulData, socket.data.filterConfig));
            }
        });
        processNotifications(lastSuccessfulData);
        console.log(`Broadcasted to ${io.engine.clientsCount} clients.`);
    } catch (error) {
        console.error("API Error:", error.message);
    } finally {
        isFetching = false;
    }
}

// --- Connection and Server Start (Unchanged) ---
io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}. Waiting for authentication.`);
    socket.on('authenticate', async (data) => {
        const username = data.username;
        const userConfig = loginConfigs[username];
        if (!userConfig) return socket.disconnect();
        socket.data.username = username;
        console.log(`Socket ${socket.id} authenticated as user: ${username}`);
        let resolvedIds = null;
        if (userConfig.reference_login) {
            resolvedIds = await resolveReferenceLogin(userConfig.reference_login);
        } else if (userConfig.team_id) {
            resolvedIds = {
                myTeamId: userConfig.team_id,
                targetTeamIds: new Set(userConfig.target_team_ids || [])
            };
        } else {
            resolvedIds = {
                myTeamId: masterTeamId,
                targetTeamIds: masterTargetIds
            };
        }
        if (!resolvedIds || !resolvedIds.myTeamId) {
            socket.emit('auth_error', 'Could not resolve team info.');
            return socket.disconnect();
        }
        socket.data.filterConfig = {
            isMaster: !!userConfig.isMaster,
            myTeamId: resolvedIds.myTeamId,
            targetTeamIds: resolvedIds.targetTeamIds,
            canSeeAllPlayers: !!userConfig.isMaster || !!userConfig.canSeeAllPlayers,
            canSeeLastKnownLocation: !!userConfig.isMaster || !!userConfig.canSeeLastKnownLocation
        };
        const teammates = Array.from(lastRichDataMap.values()).filter(player => player.team_id === resolvedIds.myTeamId).map(player => ({
            id: player.id,
            name: `${player.first_name} ${player.last_name}`.trim()
        }));
        socket.emit('auth_success', {
            teammates
        });
        if (lastSuccessfulData) {
            socket.emit('locationUpdate', filterDataForUser(lastSuccessfulData, socket.data.filterConfig));
        }
    });
    socket.on('update_notification_settings', (settings) => {
        console.log(`[${socket.data.username}] updated notification settings:`, settings);
        socket.data.notificationSettings = settings;
        socket.data.playersInRange = new Set();
    });
    socket.on('live_location_update', (coords) => {
        if (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number') {
            socket.data.liveLocation = {
                lat: coords.lat,
                lng: coords.lng
            };
        }
    });
    socket.on('stop_live_location', () => {
        delete socket.data.liveLocation;
    });
    socket.on('disconnect', () => {
        console.log(`User ${socket.data.username || 'unauthenticated'} disconnected.`);
    });
});
async function startServer() {
    console.log("Starting server...");
    loadMapFromFile();
    loadTokensFromFile();
    await runApiRequests();
    setInterval(runApiRequests, FETCH_INTERVAL_MS);
    server.listen(PORT, () => console.log(`Server is ready on http://localhost:${PORT}`));
}
startServer();
