const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const axios = require('axios');

// --- Server Setup ---
const app = express();
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

// --- API Configuration ---
const SUPABASE_URL = "https://erspvsdfwaqjtuhymubj.supabase.co";
const SPLASHIN_API_URL = "https://splashin.app/api/v3";
const API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyc3B2c2Rmd2FxanR1aHltdWJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE2ODM1ODY0MjcsImV4cCI6MTk5OTE2MjQyN30.2AItrHcB7A5bSZ_dfd455kvLL8fXLL7IrfMBoFmkGww";
const GAME_ID = "c8862e51-4f00-42e7-91ed-55a078d57efc";
const AVATAR_BASE_URL = "https://erspvsdfwaqjtuhymubj.supabase.co/storage/v1/object/public/avatars/";

const authData = {
    email: process.env.API_EMAI,
    password: process.env.API_PASSWORD,
    goture_meta_security: {},
};

// --- State Management ---
let isFetching = false;
let lastSuccessfulData = null;
let fetchInterval = null;
const FETCH_INTERVAL_MS = 10000;
// --- NEW: In-memory store for last known locations ---
const playerLastKnownLocationMap = new Map();

// --- The Core API Fetching Logic ---
async function runApiRequests() {
    if (isFetching) { return; }
    if (io.engine.clientsCount === 0) { return; }

    try {
        isFetching = true;
        console.log("--- Starting API Request Cycle ---");

        // 1. Authentication
        const authHeaders = { "Apikey": API_KEY };
        const authUrl = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;

        // Log the email being used for debugging, but NEVER log the password
        console.log(`Attempting authentication for email: ${authData.email}`);

        const authResponse = await axios.post(authUrl, authData, { headers: authHeaders });
        const accessToken = authResponse.data.access_token;
        const bearerToken = `Bearer ${accessToken}`;
        const commonHeaders = { "Apikey": API_KEY, "Authorization": bearerToken, "Content-Type": "application/json" };
        
        // 2. Fetch All Player Data for Roster
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

        // 3. Request Fresh Location Updates
        const allPlayerUids = Array.from(richDataMap.keys());
        const locationRequestUrl = `${SUPABASE_URL}/rest/v1/rpc/location-request`;
        const requestPromises = allPlayerUids.map(uid =>
            axios.post(locationRequestUrl, { uid: uid, queue_name: "location-request" }, { headers: commonHeaders })
        );
        await Promise.allSettled(requestPromises);

        // 4. Fetch all Locations
        const locationUrl = `${SUPABASE_URL}/rest/v1/rpc/get_user_locations_for_game_minimal_v2`;
        const locationResponse = await axios.post(locationUrl, { gid: GAME_ID }, { headers: commonHeaders });
        const locationResults = locationResponse.data;
        console.log(`Received ${locationResults.length} location records from Supabase.`);

        // 5. Process and categorize players
        // ... (rest of the try block is the same as before) ...
        const targetIds = new Set(targets.map(p => p.id).filter(Boolean));
        const teammateIds = new Set(myTeam.map(p => p.id).filter(Boolean));

        const locatedPlayers = [];
        const notLocatedPlayers = [];
        const stealthedPlayers = [];
        const safeZonePanelList = [];

        locationResults.forEach(locData => {
            const richData = richDataMap.get(locData.u);
            if (!richData) {
                notLocatedPlayers.push({ u: locData.u, firstName: 'Unknown', lastName: locData.u.substring(0, 8), teamName: 'Unknown', teamColor: '#999999', reason: 'No rich data found' });
                return;
            }

            const playerInfo = {
                u: locData.u,
                firstName: richData.first_name || 'Player',
                lastName: richData.last_name || ' ',
                teamName: richData.team_name || 'N/A',
                teamColor: richData.team_color || '#3388ff',
                avatarUrl: richData.avatar_path_small ? AVATAR_BASE_URL + richData.avatar_path_small : null,
            };

            const lat = parseFloat(locData.l);
            const lng = parseFloat(locData.lo);
            const hasCoords = !isNaN(lat) && !isNaN(lng);

            if (hasCoords) {
                playerLastKnownLocationMap.set(locData.u, { lat, lng });
            }

            const isSafe = richData.is_safe || locData.isz;
            const isStealth = (locData.l === null && locData.a === null) && !isSafe;

            if (isSafe || isStealth) {
                const lastKnown = playerLastKnownLocationMap.get(locData.u);
                const playerWithLastKnownCoords = lastKnown ? { ...playerInfo, ...lastKnown } : playerInfo;
                
                if (isSafe) {
                    safeZonePanelList.push(playerWithLastKnownCoords);
                } else {
                    stealthedPlayers.push(playerWithLastKnownCoords);
                }
            } else if (hasCoords) {
                let role = 'neutral';
                if (targetIds.has(locData.u)) role = 'target';
                else if (teammateIds.has(locData.u)) role = 'teammate';
                
                locatedPlayers.push({
                    ...playerInfo, lat, lng, role,
                    status: locData.a,
                    speed: parseFloat(locData.s || '0'),
                    batteryLevel: parseFloat(locData.bl || '0'),
                    isCharging: locData.ic,
                    updatedAt: locData.up,
                    accuracy: parseFloat(locData.ac || '0'),
                    isSafeZone: false
                });
            } else {
                notLocatedPlayers.push({ ...playerInfo, reason: 'No location data available' });
            }
        });
        
        const dataToEmit = {
            located: locatedPlayers,
            notLocated: notLocatedPlayers,
            stealthed: stealthedPlayers,
            safeZone: safeZonePanelList
        };
        lastSuccessfulData = dataToEmit;
        io.emit('locationUpdate', dataToEmit);

        console.log(`Broadcast: ${locatedPlayers.length} located, ${safeZonePanelList.length} safe, ${stealthedPlayers.length} stealth, ${notLocatedPlayers.length} not located.`);
        console.log("--- End API Request Cycle ---");

    } catch (error) {
        // --- THIS IS THE IMPROVED CATCH BLOCK ---
        console.error("API Error during runApiRequests:", error.message);
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.error("--- API Response Error Details ---");
            console.error("Status:", error.response.status);
            console.error("Data:", JSON.stringify(error.response.data, null, 2)); // This will often give the exact reason, e.g., "Invalid email"
            console.error("Headers:", error.response.headers);
        } else if (error.request) {
            // The request was made but no response was received
            console.error("API Error: No response received from server. Request details:", error.request);
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error('API Error: Error setting up the request:', error.message);
        }
    } finally {
        isFetching = false;
    }
}

// --- Connection Logic (Unchanged) ---
io.on('connection', (socket) => {
    console.log(`A user connected. Total clients: ${io.engine.clientsCount}`);

    if (lastSuccessfulData) {
        socket.emit('locationUpdate', lastSuccessfulData);
    }

    if (!fetchInterval) {
        console.log("Client connected. Starting data fetch interval.");
        runApiRequests(); 
        fetchInterval = setInterval(runApiRequests, FETCH_INTERVAL_MS);
    }

    socket.on('disconnect', () => {
        console.log(`User disconnected. Total clients remaining: ${io.engine.clientsCount}`);
        
        setTimeout(() => {
            if (io.engine.clientsCount === 0 && fetchInterval) {
                clearInterval(fetchInterval);
                fetchInterval = null;
                console.log("Last client disconnected. API fetch interval stopped.");
            }
        }, 500); 
    });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));

