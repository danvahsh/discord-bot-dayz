require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');

const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const CHANNEL_ID        = process.env.LEADERBOARD_CHANNEL_ID;
const GUILD_ID          = process.env.GUILD_ID;
const API_KEY           = process.env.BOT_API_KEY;
const PORT              = process.env.BOT_PORT || 3005;

const STATS_FILE        = path.join(__dirname, 'stats.json');
const STATE_FILE        = path.join(__dirname, 'bot-state.json');

// ── Logging ────────────────────────────────────────────────────────────────────

function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg)    { console.log(`[${ts()}] ${msg}`); }
function logErr(msg) { console.error(`[${ts()}] ${msg}`); }

// ── Discord client ─────────────────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Persistent stats ───────────────────────────────────────────────────────────

function loadStats() {
    try {
        return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    } catch {
        return { players: {} };
    }
}

function saveStats(stats) {
    stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// ── Leaderboard message state ──────────────────────────────────────────────────

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Slash command definitions ──────────────────────────────────────────────────

const commands = [
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Show detailed stats for a player')
        .addStringOption(o => o
            .setName('player')
            .setDescription('Player name (partial match)')
            .setRequired(true)),

    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show the current kill leaderboard'),

    new SlashCommandBuilder()
        .setName('top')
        .setDescription('Show leaderboard sorted by a specific category')
        .addStringOption(o => o
            .setName('category')
            .setDescription('Sort by kills, kd, or distance')
            .setRequired(true)
            .addChoices(
                { name: 'Kills',           value: 'kills' },
                { name: 'K/D Ratio',       value: 'kd' },
                { name: 'Longest Kill',    value: 'distance' },
            )),
];

async function registerCommands() {
    if (!GUILD_ID) {
        logErr('GUILD_ID not set — skipping slash command registration.');
        return;
    }
    try {
        const rest = new REST().setToken(DISCORD_TOKEN);
        await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
            body: commands.map(c => c.toJSON()),
        });
        log('Slash commands registered.');
    } catch (err) {
        logErr(`Failed to register slash commands: ${err.message}`);
    }
}

// ── Embed builders ─────────────────────────────────────────────────────────────

const medals = ['🥇', '🥈', '🥉'];

function buildLeaderboardRows(players) {
    return players.map((p, i) => {
        const kd = p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);
        const rank = medals[i] ?? `**${i + 1}.**`;

        const favWeapon = p.weapons
            ? Object.entries(p.weapons).sort((a, b) => b[1] - a[1])[0]?.[0]
            : null;
        const longest = p.longestKill > 0 ? `${p.longestKill}m` : null;

        const extras = [favWeapon ? `🔫 ${favWeapon}` : null, longest ? `📏 ${longest}` : null]
            .filter(Boolean).join('  ');

        return `${rank} **${p.name}** — ${p.kills}K / ${p.deaths}D  *(K/D: ${kd})*${extras ? `  ${extras}` : ''}`;
    });
}

function buildLiveEmbed(stats) {
    const sorted = Object.values(stats.players)
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
        .slice(0, 15);

    const rows = buildLeaderboardRows(sorted);

    return new EmbedBuilder()
        .setTitle('🏆 Kill Leaderboard')
        .setDescription(rows.length ? rows.join('\n') : '*No kills recorded yet.*')
        .setColor(0xE74C3C)
        .setFooter({ text: 'Live · All-time stats' })
        .setTimestamp(stats.lastUpdated ? new Date(stats.lastUpdated) : new Date());
}

function buildTopEmbed(stats, category) {
    const sorters = {
        kills:    (a, b) => b.kills - a.kills,
        kd:       (a, b) => (b.kills / Math.max(b.deaths, 1)) - (a.kills / Math.max(a.deaths, 1)),
        distance: (a, b) => (b.longestKill ?? 0) - (a.longestKill ?? 0),
    };
    const titles = {
        kills:    '🏆 Top Kills',
        kd:       '⚔️ Top K/D Ratio',
        distance: '📏 Longest Kills',
    };

    const sorted = Object.values(stats.players).sort(sorters[category]).slice(0, 15);
    const rows = buildLeaderboardRows(sorted);

    return new EmbedBuilder()
        .setTitle(titles[category])
        .setDescription(rows.length ? rows.join('\n') : '*No data yet.*')
        .setColor(0xE67E22)
        .setFooter({ text: 'All-time stats' })
        .setTimestamp();
}

function buildStatsEmbed(player, rank) {
    const kd = player.deaths > 0
        ? (player.kills / player.deaths).toFixed(2)
        : player.kills.toFixed(2);

    const topWeapons = player.weapons
        ? Object.entries(player.weapons)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([w, n]) => `${w} (${n})`)
            .join('\n')
        : 'No data';

    const embed = new EmbedBuilder()
        .setTitle(`📋 ${player.name}`)
        .setColor(0x3498DB)
        .addFields(
            { name: 'Rank',          value: rank !== null ? `#${rank + 1}` : 'Unranked',          inline: true },
            { name: 'Kills',         value: String(player.kills),                                  inline: true },
            { name: 'Deaths',        value: String(player.deaths),                                 inline: true },
            { name: 'K/D Ratio',     value: kd,                                                    inline: true },
            { name: 'Longest Kill',  value: player.longestKill > 0 ? `${player.longestKill}m` : 'N/A', inline: true },
            { name: '\u200b',        value: '\u200b',                                              inline: true },
            { name: 'Top Weapons',   value: topWeapons,                                            inline: false },
        )
        .setFooter({ text: 'All-time stats' })
        .setTimestamp();

    return embed;
}

// ── Update live leaderboard message ───────────────────────────────────────────

async function updateLeaderboard() {
    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel) {
        logErr(`Could not fetch leaderboard channel (ID: ${CHANNEL_ID}) — make sure LEADERBOARD_CHANNEL_ID is set in Pterodactyl's Variables tab and the bot has access to that channel.`);
        return;
    }

    const embed = buildLiveEmbed(loadStats());
    const state = loadState();

    if (state.leaderboardMessageId) {
        try {
            const msg = await channel.messages.fetch(state.leaderboardMessageId);
            await msg.edit({ embeds: [embed] });
            return;
        } catch {
            // Message was deleted — fall through and create a new one
        }
    }

    const msg = await channel.send({ embeds: [embed] });
    saveState({ leaderboardMessageId: msg.id });
    log(`Leaderboard message created: ${msg.id}`);
}

// ── Slash command handler ──────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const stats = loadStats();

    if (interaction.commandName === 'stats') {
        const query = interaction.options.getString('player').toLowerCase();
        const all = Object.values(stats.players);
        const match = all.find(p => p.name.toLowerCase() === query)
            ?? all.find(p => p.name.toLowerCase().includes(query));

        if (!match) {
            return interaction.reply({ content: `No player found matching **${query}**.`, ephemeral: true });
        }

        const sorted = all.sort((a, b) => b.kills - a.kills);
        const rank = sorted.findIndex(p => p.name === match.name);
        return interaction.reply({ embeds: [buildStatsEmbed(match, rank)], ephemeral: true });
    }

    if (interaction.commandName === 'leaderboard') {
        return interaction.reply({ embeds: [buildLiveEmbed(stats)], ephemeral: true });
    }

    if (interaction.commandName === 'top') {
        const category = interaction.options.getString('category');
        return interaction.reply({ embeds: [buildTopEmbed(stats, category)], ephemeral: true });
    }
});

// ── HTTP server (receives events from DayZ mod) ────────────────────────────────

const app = express();
app.use(express.json());

app.post('/kill', (req, res) => {
    const { apiKey, killerName, killerId, victimName, victimId, cause, weapon, distance, locX, locZ } = req.body;

    if (API_KEY && apiKey !== API_KEY) {
        logErr('Unauthorized kill event received — API key mismatch.');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (cause === 'ping') {
        log('[OK] DayZ mod connected successfully — kill tracker is reachable.');
        return res.sendStatus(200);
    }

    const stats = loadStats();

    // Always record the victim's death
    if (victimId) {
        stats.players[victimId] ??= { name: victimName, kills: 0, deaths: 0, longestKill: 0, weapons: {}, lastKillPos: null, lastDeathPos: null };
        stats.players[victimId].name = victimName;
        stats.players[victimId].deaths++;
    }

    // Only credit a PvP kill to the killer (not suicides, zombies, animals, etc.)
    if (cause === 'pvp' && killerId && killerId !== victimId) {
        stats.players[killerId] ??= { name: killerName, kills: 0, deaths: 0, longestKill: 0, weapons: {}, lastKillPos: null };
        const k = stats.players[killerId];
        k.name = killerName;
        k.kills++;

        if (distance && distance > (k.longestKill ?? 0))
            k.longestKill = distance;

        if (weapon) {
            k.weapons ??= {};
            k.weapons[weapon] = (k.weapons[weapon] ?? 0) + 1;
        }

        if (locX !== undefined && locZ !== undefined)
            k.lastKillPos = { x: locX, z: locZ };
    }

    if (victimId) {
        stats.players[victimId].lastDeathPos = (locX !== undefined && locZ !== undefined)
            ? { x: locX, z: locZ }
            : null;
    }

    saveStats(stats);

    if (client.isReady()) {
        updateLeaderboard().catch(err => logErr(`Failed to update leaderboard: ${err.message}`));
    }

    res.sendStatus(200);
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => log(`Kill tracker listening on port ${PORT}`));

// ── Discord login ──────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
    log('========== DAYZ LEADERBOARD BOT STARTED ==========');
    log(`Logged in as: ${client.user.tag}`);
    log(`Listening on port: ${PORT}`);
    log(`Pterodactyl: Bot Started`);
    log(`Servers: ${client.guilds.cache.map(g => `${g.name} (${g.id})`).join(', ') || 'none — bot has not been invited to any server'}`);
    log('===================================================');
    await registerCommands();
    updateLeaderboard().catch(err => logErr(`Failed to update leaderboard: ${err.message}`));
});

client.login(DISCORD_TOKEN);
