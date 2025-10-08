const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const axios = require('axios');

// --- Server Setup ---
const app = express();

app.use((req, res, next) => {
    // In production, Railway uses a reverse proxy that sets this header.
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
    email: process.env.API_EMAIL,
    password: process.env.API_PASSWORD,
    goture_meta_security: {},
};

// --- State Management for Concurrency Control ---
let isFetching = false; 
let lastSuccessfulData = null; 
let fetchInterval = null;
const FETCH_INTERVAL_MS = 10000;

// --- The Core API Fetching Logic ---
async function runApiRequests() {
    if (isFetching) {
        console.log("API fetch already in progress. Skipping this interval.");
        return;
    }
    if (io.engine.clientsCount === 0) {
        console.log("No clients connected, skipping API requests.");
        return;
    }

    try {
        isFetching = true; 
        console.log("--- Starting API Request Cycle ---");

        // --- 1. Authentication ---
        console.log("Attempting authentication...");
        const authHeaders = { "Apikey": API_KEY };
        const authUrl = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
        const authResponse = await axios.post(authUrl, authData, { headers: authHeaders });
        const accessToken = authResponse.data.access_token;
        const bearerToken = `Bearer ${accessToken}`;
        const commonHeaders = { "Apikey": API_KEY, "Authorization": bearerToken, "Content-Type": "application/json" };
        console.log("Authentication successful.");

        // --- 2. Fetch All Player Data ---
        console.log("Fetching all player data to build roster...");
        // ... (Code to fetch dashboard and all other players remains the same)
        const dashboardUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/dashboard`;
        const dashboardResponse = await axios.get(dashboardUrl, { headers: commonHeaders });
        const richDataMap = new Map();
        const targets = dashboardResponse.data.targets || [];
        const myTeam = dashboardResponse.data.myTeam || [];
        if (dashboardResponse.data.currentPlayer) richDataMap.set(dashboardResponse.data.currentPlayer.id, dashboardResponse.data.currentPlayer);
        targets.forEach(p => p && p.id && richDataMap.set(p.id, p));
        myTeam.forEach(p => p && p.id && richDataMap.set(p.id, p));

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
        console.log(`Total unique players in roster: ${richDataMap.size}`);
        // --- End Player Fetching ---

        if (richDataMap.size === 0) {
            console.log("No players found in the game roster.");
            lastSuccessfulData = { located: [], notLocated: [] };
            io.emit('locationUpdate', lastSuccessfulData);
            return;
        }

        // --- 3. NEW: Request Fresh Location Updates ---
        console.log(`Requesting fresh location updates for ${richDataMap.size} players...`);
        const allPlayerUids = Array.from(richDataMap.keys());
        const locationRequestUrl = `${SUPABASE_URL}/rest/v1/rpc/location-request`;

        // Create an array of POST request promises, one for each player
        const requestPromises = allPlayerUids.map(uid => {
            const requestData = {
                uid: uid,
                queue_name: "location-request"
            };
            return axios.post(locationRequestUrl, requestData, { headers: commonHeaders });
        });

        try {
            // Execute all requests in parallel and wait for them to settle.
            // Using 'allSettled' is safer than 'all' because it won't stop if one request fails.
            const results = await Promise.allSettled(requestPromises);
            const failedRequests = results.filter(r => r.status === 'rejected').length;
            if (failedRequests > 0) {
                console.warn(`${failedRequests} location requests failed. Continuing anyway.`);
            } else {
                console.log("Successfully sent all location requests.");
            }
        } catch (e) {
             // This catch is a fallback, but allSettled should prevent it from being hit for individual failures.
             console.error("An unexpected error occurred while sending location requests.", e);
        }
        // --- END NEW SECTION ---


        // --- 4. Fetch all Locations ---
        console.log("Fetching raw location updates from Supabase...");
        const locationUrl = `${SUPABASE_URL}/rest/v1/rpc/get_user_locations_for_game_minimal_v2`;
        const locationResponse = await axios.post(locationUrl, { gid: GAME_ID }, { headers: commonHeaders });
        const locationResults = locationResponse.data;
        console.log(`Received ${locationResults.length} raw location updates.`);

        // ... (The rest of the processing logic remains the same)
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
        
        const dataToEmit = { located: locatedPlayers, notLocated: notLocatedPlayers };
        lastSuccessfulData = dataToEmit; 
        io.emit('locationUpdate', dataToEmit);

        console.log(`Successfully processed and broadcast ${locatedPlayers.length} players to map.`);
        console.log("--- End API Request Cycle ---");

    } catch (error) {
        console.error("API Error during runApiRequests:", error.message);
    } finally {
        isFetching = false;
    }
}

// --- Connection and Disconnection Logic (Unchanged) ---
io.on('connection', (socket) => {
    console.log(`A user connected. Total clients: ${io.engine.clientsCount}`);
    if (lastSuccessfulData) {
        socket.emit('locationUpdate', lastSuccessfulData);
        console.log("Sent cached data to the new user.");
    }
    if (io.engine.clientsCount === 1) {
        console.log("First client connected. Kicking off initial data fetch and starting interval.");
        runApiRequests();
        fetchInterval = setInterval(runApiRequests, FETCH_INTERVAL_MS);
    }
    socket.on('disconnect', () => {
        console.log(`User disconnected. Total clients remaining: ${io.engine.clientsCount}`);
        if (io.engine.clientsCount === 0) {
            if (fetchInterval) {
                clearInterval(fetchInterval);
                fetchInterval = null;
                console.log("Last client disconnected. API fetch interval stopped.");
            }
        }
    });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
