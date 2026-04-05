require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');

const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const CHANNEL_ID        = process.env.LEADERBOARD_CHANNEL_ID;
const API_KEY           = process.env.BOT_API_KEY;
const PORT              = process.env.BOT_PORT || 3005;

const STATS_FILE        = path.join(__dirname, 'stats.json');
const STATE_FILE        = path.join(__dirname, 'bot-state.json');

// ── Discord client ─────────────────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Persistent stats ───────────────────────────────────────────────────────────
// Keyed by Steam64 ID so players can rename without losing stats.

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

// ── Embed ──────────────────────────────────────────────────────────────────────

function buildEmbed(stats) {
    const sorted = Object.values(stats.players)
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
        .slice(0, 15);

    const medals = ['🥇', '🥈', '🥉'];

    const rows = sorted.map((p, i) => {
        const kd = p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);
        const rank = medals[i] ?? `**${i + 1}.**`;
        return `${rank} **${p.name}** — ${p.kills}K / ${p.deaths}D  *(K/D: ${kd})*`;
    });

    return new EmbedBuilder()
        .setTitle('🏆 Kill Leaderboard')
        .setDescription(rows.length ? rows.join('\n') : '*No kills recorded yet.*')
        .setColor(0xE74C3C)
        .setFooter({ text: 'Live · All-time stats' })
        .setTimestamp(stats.lastUpdated ? new Date(stats.lastUpdated) : new Date());
}

// ── Update Discord message ─────────────────────────────────────────────────────

async function updateLeaderboard() {
    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    if (!channel) {
        console.error('Could not fetch leaderboard channel — check LEADERBOARD_CHANNEL_ID in .env');
        return;
    }

    const embed = buildEmbed(loadStats());
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
    console.log(`Leaderboard message created: ${msg.id}`);
}

// ── HTTP server (receives events from DayZ mod) ────────────────────────────────

const app = express();
app.use(express.json());

app.post('/kill', (req, res) => {
    const { apiKey, killerName, killerId, victimName, victimId, cause } = req.body;

    if (API_KEY && apiKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const stats = loadStats();

    // Always record the victim's death
    if (victimId) {
        stats.players[victimId] ??= { name: victimName, kills: 0, deaths: 0 };
        stats.players[victimId].name = victimName;
        stats.players[victimId].deaths++;
    }

    // Only credit a PvP kill to the killer (not suicides, zombies, animals, etc.)
    if (cause === 'pvp' && killerId && killerId !== victimId) {
        stats.players[killerId] ??= { name: killerName, kills: 0, deaths: 0 };
        stats.players[killerId].name = killerName;
        stats.players[killerId].kills++;
    }

    saveStats(stats);

    if (client.isReady()) {
        updateLeaderboard().catch(console.error);
    }

    res.sendStatus(200);
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Kill tracker listening on port ${PORT}`));

// ── Discord login ──────────────────────────────────────────────────────────────

client.once('ready', () => {
    console.log(`Discord bot ready: ${client.user.tag}`);
    updateLeaderboard().catch(console.error);
});

client.login(DISCORD_TOKEN);
