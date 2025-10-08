const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const axios = require('axios');

// --- Server Setup ---
const app = express();
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
    email: process.env.API_EMAIL,
    password: process.env.API_PASSWORD,
    goture_meta_security: {},
};

// --- NEW: State Management for Concurrency Control ---

// The "Lock": A flag to ensure only one API fetch runs at a time.
let isFetching = false; 

// The "Cache": Stores the result of the last successful API fetch.
let lastSuccessfulData = null; 

// The "Timer": A reference to our setInterval so we can start/stop it.
let fetchInterval = null;
const FETCH_INTERVAL_MS = 10000; // Increased to 10 seconds as requested

// --- The Core API Fetching Logic (Modified with Lock) ---

async function runApiRequests() {
    // 1. Check the Lock
    if (isFetching) {
        console.log("API fetch already in progress. Skipping this interval.");
        return;
    }

    // This is a safety check. If no one is connected, stop trying.
    if (io.engine.clientsCount === 0) {
        console.log("No clients connected, skipping API requests.");
        return;
    }

    try {
        // 2. Set the Lock
        isFetching = true; 
        console.log("--- Starting API Request Cycle ---");

        // ... [THE ENTIRE API LOGIC FROM YOUR ORIGINAL FILE REMAINS UNCHANGED HERE] ...
        console.log("Attempting authentication...");
        const authHeaders = { "Apikey": API_KEY };
        const authUrl = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
        const authResponse = await axios.post(authUrl, authData, { headers: authHeaders });
        const accessToken = authResponse.data.access_token;
        const bearerToken = `Bearer ${accessToken}`;
        const commonHeaders = { "Apikey": API_KEY, "Authorization": bearerToken, "Content-Type": "application/json" };
        console.log("Authentication successful.");

        console.log("Fetching dashboard data for current user context...");
        const dashboardUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/dashboard`;
        const dashboardResponse = await axios.get(dashboardUrl, { headers: commonHeaders });
        const dashboardData = dashboardResponse.data;

        const richDataMap = new Map();
        const targets = dashboardData.targets || [];
        const myTeam = dashboardData.myTeam || [];
        const currentPlayer = dashboardData.currentPlayer;
        
        if (currentPlayer) richDataMap.set(currentPlayer.id, currentPlayer);
        targets.forEach(p => p && p.id && richDataMap.set(p.id, p));
        myTeam.forEach(p => p && p.id && richDataMap.set(p.id, p));
        console.log(`Initialized richDataMap with ${richDataMap.size} players from dashboard.`);

        console.log("Fetching ALL other players from game roster using pagination...");
        let allOtherTeams = [];
        let currentCursor = 0;
        let hasMorePages = true;
        
        while (hasMorePages) {
            const playersUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/players?cursor=${currentCursor}&filter=all&sort=alphabetical&group=team`;
            const playersResponse = await axios.get(playersUrl, { headers: commonHeaders });
            const pageData = playersResponse.data;
            if (pageData && pageData.teams && pageData.teams.length > 0) {
                allOtherTeams.push(...pageData.teams);
                currentCursor++;
            } else {
                hasMorePages = false;
            }
        }
        
        allOtherTeams.flatMap(team => team.players || []).forEach(p => {
            if (p && p.id && !richDataMap.has(p.id)) richDataMap.set(p.id, p);
        });
        console.log(`Total unique players in richDataMap: ${richDataMap.size}`);

        if (richDataMap.size === 0) {
            console.log("No players found in the game roster.");
            const emptyData = { located: [], notLocated: [] };
            io.emit('locationUpdate', emptyData);
            lastSuccessfulData = emptyData; // Cache the empty result
            return;
        }

        console.log("Fetching raw location updates from Supabase...");
        const locationUrl = `${SUPABASE_URL}/rest/v1/rpc/get_user_locations_for_game_minimal_v2`;
        const locationResponse = await axios.post(locationUrl, { gid: GAME_ID }, { headers: commonHeaders });
        const locationResults = locationResponse.data;
        console.log(`Received ${locationResults.length} raw location updates.`);

        const targetIds = new Set(targets.map(p => p.id).filter(Boolean));
        const teammateIds = new Set(myTeam.map(p => p.id).filter(Boolean));
        const locatedPlayers = [];
        const notLocatedPlayers = [];

        locationResults.forEach(locData => {
            let richData = richDataMap.get(locData.u);
            if (!richData) {
                notLocatedPlayers.push({ u: locData.u, firstName: 'Unknown', lastName: locData.u.substring(0, 8), teamName: 'Unknown', teamColor: '#999999', reason: 'No rich data found' });
                return;
            }
            const lat = parseFloat(locData.l);
            const lng = parseFloat(locData.lo);
            if (isNaN(lat) || isNaN(lng)) {
                notLocatedPlayers.push({ u: locData.u, firstName: richData.first_name || 'Player', lastName: richData.last_name || ' ', teamName: richData.team_name || 'N/A', teamColor: richData.team_color || '#3388ff', reason: 'Invalid coordinates' });
                return;
            }
            let role = 'neutral';
            if (targetIds.has(locData.u)) role = 'target';
            else if (teammateIds.has(locData.u)) role = 'teammate';

            locatedPlayers.push({ u: locData.u, lat, lng, firstName: richData.first_name || 'Player', lastName: richData.last_name || '', teamName: richData.team_name || 'N/A', teamColor: richData.team_color || '#3388ff', avatarUrl: richData.avatar_path_small ? AVATAR_BASE_URL + richData.avatar_path_small : null, role, status: locData.a, speed: parseFloat(locData.s || '0'), batteryLevel: parseFloat(locData.bl || '0'), isCharging: locData.ic, updatedAt: locData.up, accuracy: parseFloat(locData.ac || '0'), heading: parseFloat(locData.h || '0') });
        });

        // --- Important Update ---
        const dataToEmit = { located: locatedPlayers, notLocated: notLocatedPlayers };
        
        // 3. Update the Cache with the fresh data
        lastSuccessfulData = dataToEmit; 

        // 4. Broadcast the fresh data to ALL clients
        io.emit('locationUpdate', dataToEmit);

        console.log(`Successfully processed and broadcast ${locatedPlayers.length} players to map.`);
        console.log("--- End API Request Cycle ---");

    } catch (error) {
        console.error("API Error during runApiRequests:", error.message);
        // Don't update cache on error, keep the last known good data
    } finally {
        // 5. Release the Lock, allowing the next fetch to run
        isFetching = false;
    }
}

// --- MODIFIED: Connection and Disconnection Logic ---

io.on('connection', (socket) => {
    console.log(`A user connected. Total clients: ${io.engine.clientsCount}`);

    // Immediately send the latest cached data to the new user.
    // This provides an instant view without waiting for the next API call.
    if (lastSuccessfulData) {
        socket.emit('locationUpdate', lastSuccessfulData);
        console.log("Sent cached data to the new user.");
    }

    // If this is the VERY FIRST user to connect, start the interval.
    if (io.engine.clientsCount === 1) {
        console.log("First client connected. Kicking off initial data fetch and starting interval.");
        runApiRequests(); // Run immediately for the first user
        fetchInterval = setInterval(runApiRequests, FETCH_INTERVAL_MS);
    }

    socket.on('disconnect', () => {
        console.log(`User disconnected. Total clients remaining: ${io.engine.clientsCount}`);
        
        // If the LAST user has disconnected, stop the interval to save resources.
        if (io.engine.clientsCount === 0) {
            if (fetchInterval) {
                clearInterval(fetchInterval);
                fetchInterval = null; // Clear the reference
                console.log("Last client disconnected. API fetch interval stopped.");
            }
        }
    });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
