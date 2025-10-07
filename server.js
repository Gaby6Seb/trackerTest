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

async function runApiRequests() {
    if (io.engine.clientsCount === 0) {
        console.log("No clients connected, skipping API requests.");
        return;
    }

    console.log("--- Starting API Request Cycle ---");

    try {
        console.log("Attempting authentication...");
        const authHeaders = { "Apikey": API_KEY };
        const authUrl = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
        const authResponse = await axios.post(authUrl, authData, { headers: authHeaders });
        const accessToken = authResponse.data.access_token;
        const bearerToken = `Bearer ${accessToken}`;
        const commonHeaders = { "Apikey": API_KEY, "Authorization": bearerToken, "Content-Type": "application/json" };
        console.log("Authentication successful.");

        // --- 1. Fetch Dashboard data ---
        console.log("Fetching dashboard data for current user context...");
        const dashboardUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/dashboard`;
        const dashboardResponse = await axios.get(dashboardUrl, { headers: commonHeaders });
        const dashboardData = dashboardResponse.data;

        const richDataMap = new Map();
        const targets = dashboardData.targets || [];
        const myTeam = dashboardData.myTeam || [];
        const currentPlayer = dashboardData.currentPlayer;

        // Populate richDataMap with dashboard players
        if (currentPlayer) {
            richDataMap.set(currentPlayer.id, currentPlayer);
            // console.log(`  Added current player to richDataMap: ${currentPlayer.id}`); // Keep verbose logging off by default
        }
        targets.forEach(p => {
            if (p && p.id) {
                richDataMap.set(p.id, p);
                // console.log(`  Added target to richDataMap: ${p.id} (${p.first_name || 'N/A'})`);
            }
        });
        myTeam.forEach(p => {
            if (p && p.id) {
                richDataMap.set(p.id, p);
                // console.log(`  Added teammate to richDataMap: ${p.id} (${p.first_name || 'N/A'})`);
            }
        });
        console.log(`Initialized richDataMap with ${richDataMap.size} players from dashboard (current player, targets, teammates).`);

        // --- 2. Fetch ALL other players from game roster using PAGINATION ---
        console.log("Fetching ALL other players from game roster using pagination...");
        let allOtherTeams = [];
        let currentCursor = 0; // Start at the first "page" or "offset"
        let hasMorePages = true;
        let pageCount = 0;

        while (hasMorePages) {
            pageCount++;
            const playersUrl = `${SPLASHIN_API_URL}/games/${GAME_ID}/players?cursor=${currentCursor}&filter=all&sort=alphabetical&group=team`;
            // console.log(`  Fetching page ${pageCount} with cursor ${currentCursor}...`); // Verbose
            const playersResponse = await axios.get(playersUrl, { headers: commonHeaders });

            const pageData = playersResponse.data;
            if (pageData && pageData.teams && pageData.teams.length > 0) {
                console.log(`  Fetched page ${pageCount} with cursor ${currentCursor}, found ${pageData.teams.length} teams.`);
                allOtherTeams.push(...pageData.teams);
                // IMPORTANT: Increment cursor for the next iteration to get the next page
                currentCursor++;
            } else {
                // If no teams are returned in the current page, it means we've reached the end
                console.log(`  No more teams found on page ${pageCount} with cursor ${currentCursor}. Stopping pagination.`);
                hasMorePages = false;
            }
        }
        console.log(`Finished fetching other players. Total teams found: ${allOtherTeams.length}`);

        // Add players from these other teams to richDataMap, avoiding duplicates
        const totalPlayersBeforeOther = richDataMap.size;
        allOtherTeams.flatMap(team => team.players || []).forEach(p => {
            if (p && p.id && !richDataMap.has(p.id)) { // Ensure player object and ID exist
                richDataMap.set(p.id, p);
                // console.log(`    Added new player from /players: ${p.id} (${p.first_name || 'N/A'})`); // Very verbose, enable if needed
            }
        });
        console.log(`Added ${richDataMap.size - totalPlayersBeforeOther} new players from /players endpoint.`);
        console.log(`Total unique players in richDataMap (from dashboard + all other players): ${richDataMap.size}`);

        if (richDataMap.size === 0) {
            console.log("No players found in the game roster.");
            io.emit('locationUpdate', { located: [], notLocated: [] }); // Send empty arrays
            return;
        }

        // --- 3. Fetch all Locations ---
        console.log("Fetching raw location updates from Supabase...");
        const locationUrl = `${SUPABASE_URL}/rest/v1/rpc/get_user_locations_for_game_minimal_v2`;
        const locationResponse = await axios.post(locationUrl, { gid: GAME_ID }, { headers: commonHeaders });
        const locationResults = locationResponse.data;
        console.log(`Received ${locationResults.length} raw location updates from Supabase.`);

        const targetIds = new Set(targets.map(p => p.id).filter(Boolean));
        const teammateIds = new Set(myTeam.map(p => p.id).filter(Boolean));

        console.log(`Dashboard identifies ${targetIds.size} targets: ${Array.from(targetIds).map(id => richDataMap.get(id)?.first_name || id).join(', ')}`);
        console.log(`Dashboard identifies ${teammateIds.size} teammates: ${Array.from(teammateIds).map(id => richDataMap.get(id)?.first_name || id).join(', ')}`);

        let droppedNoRichData = 0;
        let droppedInvalidLocation = 0;
        let targetsOnMapCount = 0;
        let teammatesOnMapCount = 0;
        let neutralsOnMapCount = 0;

        const locatedPlayers = [];
        const notLocatedPlayers = []; // Collect players with invalid locations or missing rich data

        locationResults.forEach(locData => {
            const isTarget = targetIds.has(locData.u);
            const isTeammate = teammateIds.has(locData.u);
            const isSpecialPlayer = isTarget || isTeammate;

            let richData = richDataMap.get(locData.u);

            // Fail-safe: If a special player has location but no richData, create minimal richData
            if (isSpecialPlayer && !richData) {
                console.warn(`CRITICAL WARNING: Rich data NOT found for special player ${locData.u} (Role: ${isTarget ? 'Target' : 'Teammate'}) in richDataMap. Using fallback data.`);
                richData = {
                    id: locData.u,
                    first_name: `Player`,
                    last_name: locData.u.substring(0, 8),
                    team_name: isTeammate ? 'My Team' : (isTarget ? 'Target Team' : 'Unknown'),
                    team_color: isTeammate ? '#4CAF50' : (isTarget ? '#F44336' : '#9E9E9E'),
                    avatar_path_small: null,
                };
            }

            if (!richData) {
                droppedNoRichData++;
                // Add to notLocatedPlayers if rich data is completely missing (not even a fallback for special player)
                notLocatedPlayers.push({
                    u: locData.u,
                    firstName: 'Unknown',
                    lastName: locData.u.substring(0, 8),
                    teamName: 'Unknown',
                    teamColor: '#999999',
                    reason: 'No rich data found'
                });
                return;
            }

            const lat = parseFloat(locData.l);
            const lng = parseFloat(locData.lo);

            // Check if coordinates are valid
            if (isNaN(lat) || isNaN(lng)) {
                droppedInvalidLocation++;
                console.warn(`  Dropping player ${locData.u}: Invalid coordinates (lat: ${locData.l}, lng: ${locData.lo}).`);
                // Add to notLocatedPlayers list
                notLocatedPlayers.push({
                    u: locData.u,
                    firstName: richData.first_name || 'Player',
                    lastName: richData.last_name || (richData.id ? richData.id.substring(0, 8) : 'Unknown'),
                    teamName: richData.team_name || 'N/A',
                    teamColor: richData.team_color || '#3388ff',
                    reason: 'Invalid coordinates'
                });
                return;
            }

            let role = 'neutral';
            if (isTarget) {
                role = 'target';
                targetsOnMapCount++;
            } else if (isTeammate) {
                role = 'teammate';
                teammatesOnMapCount++;
            } else {
                neutralsOnMapCount++;
            }

            locatedPlayers.push({
                u: locData.u,
                lat: lat,
                lng: lng,
                firstName: richData.first_name || 'Player',
                lastName: richData.last_name || (richData.id ? richData.id.substring(0, 8) : 'Unknown'),
                teamName: richData.team_name || 'N/A',
                teamColor: richData.team_color || (isTeammate ? '#4CAF50' : (isTarget ? '#F44336' : '#3388ff')),
                avatarUrl: richData.avatar_path_small ? AVATAR_BASE_URL + richData.avatar_path_small : null,
                role: role,
                status: locData.a,
                speed: parseFloat(locData.s || '0'),
                batteryLevel: parseFloat(locData.bl || '0'),
                isCharging: locData.ic,
                updatedAt: locData.up,
                accuracy: parseFloat(locData.ac || '0'),
                heading: parseFloat(locData.h || '0'),
            });
        });

        // Emit an object with two arrays: located and notLocated
        io.emit('locationUpdate', { located: locatedPlayers, notLocated: notLocatedPlayers });

        console.log(`SUMMARY: Total raw locations from Supabase: ${locationResults.length}`);
        console.log(`SUMMARY: Dropped because no rich data (not in dashboard or /players list): ${droppedNoRichData}`);
        console.log(`SUMMARY: Dropped because invalid/null coordinates: ${droppedInvalidLocation}`);
        console.log(`SUMMARY: Successfully processed and broadcast ${locatedPlayers.length} players to map.`);
        console.log(`SUMMARY:   Targets successfully placed on map: ${targetsOnMapCount}`);
        console.log(`SUMMARY:   Teammates successfully placed on map: ${teammatesOnMapCount}`);
        console.log(`SUMMARY:   Neutrals successfully placed on map: ${neutralsOnMapCount}`);
        console.log(`SUMMARY: ${notLocatedPlayers.length} players listed as not located.`);
        console.log("--- End API Request Cycle ---");

    } catch (error) {
        console.error("API Error during runApiRequests:");
        if (error.response) {
            console.error("Server responded with error status:", error.response.status);
            console.error("Error Data:", JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
            console.error("No response received from server for request:", error.request);
        } else {
            console.error("Error setting up API request:", error.message);
        }
        console.log("--- End API Request Cycle with Error ---");
    }
}

io.on('connection', (socket) => {
    console.log(`A user connected. Kicking off initial data fetch.`);
    runApiRequests();
    socket.on('disconnect', () => console.log(`User disconnected.`));
});

setInterval(runApiRequests, 7000);
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));