const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const axios = require('axios');
const fs = require('fs');

// --- Server Setup (Unchanged) ---
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

// --- API Configuration (Unchanged) ---
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

// --- State Management (Unchanged) ---
let isFetching = false;
let lastSuccessfulData = null;
const FETCH_INTERVAL_MS = 10000;
const LOCATION_MEMORY_FILE = path.join(__dirname, 'last_locations.json');
let playerLastKnownLocationMap = new Map();

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

// --- The Core API Fetching Logic ---
async function runApiRequests() {
    if (isFetching) { return; }

    try {
        isFetching = true;
        console.log("--- Starting API Request Cycle ---");

        // 1. Authentication
        const authHeaders = { "Apikey": API_KEY };
        const authUrl = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
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

        // --- THIS IS THE RESTORED CODE BLOCK ---
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
        // --- END OF RESTORED CODE ---

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
                u: locData.u, firstName: richData.first_name || 'Player', lastName: richData.last_name || ' ', teamName: richData.team_name || 'N/A', teamColor: richData.team_color || '#3388ff', avatarUrl: richData.avatar_path_small ? AVATAR_BASE_URL + richData.avatar_path_small : null, role: role
            };
            
            const isSafe = richData.is_safe || locData.isz;
            const isStealth = (locData.l === null && locData.a === null) && !isSafe;

            if (isSafe || isStealth) {
                const lastKnown = playerLastKnownLocationMap.get(locData.u);
                const playerWithLastKnownCoords = lastKnown ? { ...playerInfo, ...lastKnown } : playerInfo;
                if (isSafe) { safeZonePanelList.push(playerWithLastKnownCoords); } 
                else { stealthedPlayers.push(playerWithLastKnownCoords); }
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

        const dataToEmit = { located: locatedPlayers, notLocated: notLocatedPlayers, stealthed: stealthedPlayers, safeZone: safeZonePanelList };
        lastSuccessfulData = dataToEmit;
        io.emit('locationUpdate', dataToEmit);

        console.log(`Broadcast: ${locatedPlayers.length} located, ${safeZonePanelList.length} safe, ${stealthedPlayers.length} stealth, ${notLocatedPlayers.length} not located.`);
        console.log("--- End API Request Cycle ---");

    } catch (error) {
        console.error("API Error during runApiRequests:", error.message);
        if (error.response) { console.error("Status:", error.response.status, "Data:", JSON.stringify(error.response.data)); }
    } finally {
        isFetching = false;
    }
}

// --- Connection and Server Start (Unchanged) ---
io.on('connection', (socket) => {
    console.log(`A user connected. Total clients: ${io.engine.clientsCount}`);
    if (lastSuccessfulData) {
        socket.emit('locationUpdate', lastSuccessfulData);
    }
});
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    loadMapFromFile();
    console.log("Starting continuous API fetch interval.");
    runApiRequests();
    setInterval(runApiRequests, FETCH_INTERVAL_MS);
});
