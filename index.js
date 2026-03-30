require('dotenv').config();
const {
    Client, GatewayIntentBits, REST, Routes,
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
    StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
    TextInputStyle, PermissionFlagsBits
} = require('discord.js');
const fetch = require('node-fetch');
const http = require('http');

http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);

const TITLE_ID = process.env.PLAYFAB_TITLE_ID;
const SECRET_KEY = process.env.PLAYFAB_SECRET_KEY;
const CLICKER_ROLE_ID = '1485379012019748997';
const CLICK_CHANNEL_ID = '1474902393844924434';
const REPORT_CHANNEL_ID = '1474902394310754333';
const BAN_ALLOWED_ROLES = ['1474902392825712797', '1474902392825712796', '1474902392825712795'];
const GIVE_COINS_ROLES = ['1474902392825712793', '1474902392825712794', '1474902392825712795', '1474902392825712796', '1474902392825712797'];
const TICKET_CATEGORY_ID = '1475020870836555934';
const TRANSCRIPT_CHANNEL_ID = '1475023603627200614';
const OWNER_ROLE = '1474902392825712797';

const cooldowns = new Map();
const coinflipCooldowns = new Map();
const activeGiveaways = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages
    ]
});

async function callCloudScript(playFabId, functionName, params) {
    const response = await fetch(
        `https://${TITLE_ID}.playfabapi.com/Server/ExecuteCloudScript`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-SecretKey': SECRET_KEY },
            body: JSON.stringify({
                PlayFabId: playFabId,
                FunctionName: functionName,
                FunctionParameter: params,
                GeneratePlayStreamEvent: false
            })
        }
    );
    const data = await response.json();
    return data.data.FunctionResult;
}

const BAN_DURATIONS = {
    '1h': { hours: 1, label: '1 Hour' },
    '1d': { hours: 24, label: '1 Day' },
    '1w': { hours: 168, label: '1 Week' },
    '1m': { hours: 720, label: '1 Month' },
    '1y': { hours: 8760, label: '1 Year' },
    'perm': { hours: null, label: 'Permanent' }
};

const TICKET_TYPES = {
    'admin_apply': { label: 'Admin Application', emoji: '👑', color: 0xFFD700 },
    'report_player': { label: 'Report a Player', emoji: '🚨', color: 0xFF0000 },
    'shop_purchase': { label: 'Shop Purchase', emoji: '🛒', color: 0x00FF00 },
    'ban_appeal': { label: 'Ban Appeal', emoji: '⚖️', color: 0x5865F2 }
};

function formatTime(minutes) {
    if (!minutes || minutes === 0) return 'No data';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
}

function generateProgressBar(current, goal) {
    const filled = Math.round((current / goal) * 20);
    const empty = 20 - filled;
    return '🟦'.repeat(filled) + '⬜'.repeat(empty);
}

async function saveTranscript(channel, client) {
    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID);
        const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        let transcript = `📄 Ticket Transcript\n📅 ${new Date().toLocaleString()}\n🏷️ ${channel.name}\n\n`;
        for (const msg of sorted) {
            if (msg.author.bot) continue;
            transcript += `[${msg.createdAt.toLocaleTimeString()}] ${msg.author.tag}: ${msg.content}\n`;
            if (msg.attachments.size > 0) msg.attachments.forEach(a => { transcript += `📎 ${a.url}\n`; });
        }
        const chunks = transcript.match(/[\s\S]{1,1900}/g) || [transcript];
        for (let i = 0; i < chunks.length; i++) {
            const embed = new EmbedBuilder()
                .setTitle(`📄 Transcript: ${channel.name} ${chunks.length > 1 ? `(${i + 1}/${chunks.length})` : ''}`)
                .setColor(0x5865F2)
                .setDescription(`\`\`\`${chunks[i]}\`\`\``)
                .setTimestamp();
            await transcriptChannel.send({ embeds: [embed] });
        }
    } catch (err) { console.error('Transcript error:', err); }
}

client.once('ready', async () => {
    const commands = [
        // General
        new SlashCommandBuilder().setName('help').setDescription('View all available commands'),
        new SlashCommandBuilder().setName('ping').setDescription('Check the bots response time'),
        new SlashCommandBuilder().setName('shop').setDescription('View the Noximal store and available items'),
        new SlashCommandBuilder().setName('leaderboard').setDescription('View leaderboards')
            .addStringOption(opt => opt.setName('type').setDescription('Leaderboard type').setRequired(true)
                .addChoices({ name: 'Clicks', value: 'clicks' }, { name: 'Coins', value: 'coins' })),
        new SlashCommandBuilder().setName('click').setDescription('Check your click count and progress to 100,000!'),
        new SlashCommandBuilder().setName('coinflip').setDescription('Bet your coins on a coin flip!')
            .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of coins to bet').setRequired(true))
            .addStringOption(opt => opt.setName('choice').setDescription('Heads or tails?').setRequired(true)
                .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })),
        new SlashCommandBuilder().setName('poll').setDescription('Create an advanced poll')
            .addStringOption(opt => opt.setName('question').setDescription('The poll question').setRequired(true))
            .addStringOption(opt => opt.setName('option1').setDescription('Option 1').setRequired(true))
            .addStringOption(opt => opt.setName('option2').setDescription('Option 2').setRequired(true))
            .addStringOption(opt => opt.setName('option3').setDescription('Option 3').setRequired(false))
            .addStringOption(opt => opt.setName('option4').setDescription('Option 4').setRequired(false))
            .addIntegerOption(opt => opt.setName('duration').setDescription('Duration in minutes (default 60)').setRequired(false)),
        new SlashCommandBuilder().setName('player-stats').setDescription('View a players public stats')
            .addStringOption(opt => opt.setName('shortcode').setDescription('The 6 digit code shown under the players name').setRequired(true)),
        new SlashCommandBuilder().setName('report').setDescription('Report a player'),
        new SlashCommandBuilder().setName('link').setDescription('Link your PlayFab account to Discord')
            .addStringOption(opt => opt.setName('playfabid').setDescription('Your PlayFab ID').setRequired(true)),
        new SlashCommandBuilder().setName('unlink').setDescription('Unlink your PlayFab account from Discord'),

        // Admin only
        new SlashCommandBuilder().setName('user').setDescription('ADMIN - Look up a player by their short code')
            .addStringOption(opt => opt.setName('code').setDescription('The 6 character player code').setRequired(true)),
        new SlashCommandBuilder().setName('player-info').setDescription('ADMIN - View full player info')
            .addStringOption(opt => opt.setName('shortcode').setDescription('Short code or PlayFab ID').setRequired(true)),
        new SlashCommandBuilder().setName('warn').setDescription('MODERATION - Warn a player')
            .addStringOption(opt => opt.setName('shortcode').setDescription('Players 6 digit code').setRequired(true))
            .addStringOption(opt => opt.setName('reason').setDescription('Reason for the warning').setRequired(true)),
        new SlashCommandBuilder().setName('warnings').setDescription('MODERATION - Check a players warnings')
            .addStringOption(opt => opt.setName('shortcode').setDescription('Players 6 digit code').setRequired(true)),
        new SlashCommandBuilder().setName('clearwarnings').setDescription('MODERATION - Clear a players warnings')
            .addStringOption(opt => opt.setName('shortcode').setDescription('Players 6 digit code').setRequired(true)),
        new SlashCommandBuilder().setName('history').setDescription('MODERATION - View a players full ban and warn history')
            .addStringOption(opt => opt.setName('shortcode').setDescription('Players 6 digit code').setRequired(true)),
        new SlashCommandBuilder().setName('inventory').setDescription('ADMIN - View a players inventory')
            .addStringOption(opt => opt.setName('shortcode').setDescription('Players 6 digit code').setRequired(true)),
        new SlashCommandBuilder().setName('coins').setDescription('ADMIN - Check a players coin balance')
            .addStringOption(opt => opt.setName('shortcode').setDescription('Players 6 digit code').setRequired(true)),
        new SlashCommandBuilder().setName('ban').setDescription('MODERATION - Ban a player from the game')
            .addStringOption(opt => opt.setName('shortcode').setDescription('The 6 digit code').setRequired(true))
            .addStringOption(opt => opt.setName('reason').setDescription('Reason for the ban').setRequired(true)),
        new SlashCommandBuilder().setName('unban').setDescription('MODERATION - Unban a player from the game')
            .addStringOption(opt => opt.setName('shortcode').setDescription('The 6 digit code').setRequired(true)),
        new SlashCommandBuilder().setName('motd').setDescription('ADMIN - Set the in-game Message of the Day')
            .addStringOption(opt => opt.setName('message').setDescription('The message to display in game').setRequired(true)),
        new SlashCommandBuilder().setName('announcement').setDescription('ADMIN - Send an in-game announcement')
            .addStringOption(opt => opt.setName('message').setDescription('The announcement to display in game').setRequired(true)),
        new SlashCommandBuilder().setName('givecoins').setDescription('ADMIN - Give coins to yourself (Mod and above only)')
            .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of coins to give yourself').setRequired(true)),
        new SlashCommandBuilder().setName('wipe').setDescription('OWNER - Wipe all data for a player')
            .addStringOption(opt => opt.setName('shortcode').setDescription('Players 6 digit code').setRequired(true)),
        new SlashCommandBuilder().setName('giveaway').setDescription('ADMIN - Start a coin giveaway')
            .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of coins to give away').setRequired(true))
            .addIntegerOption(opt => opt.setName('duration').setDescription('Duration in minutes').setRequired(true))
            .addStringOption(opt => opt.setName('channel').setDescription('Channel ID to post in (leave blank for current)').setRequired(false)),
        new SlashCommandBuilder().setName('note').setDescription('ADMIN - Add a note to a players profile')
            .addStringOption(opt => opt.setName('shortcode').setDescription('Players 6 digit code').setRequired(true))
            .addStringOption(opt => opt.setName('note').setDescription('The note to add').setRequired(true)),
        new SlashCommandBuilder().setName('notes').setDescription('ADMIN - View all notes on a player')
            .addStringOption(opt => opt.setName('shortcode').setDescription('Players 6 digit code').setRequired(true)),
        new SlashCommandBuilder().setName('lookup').setDescription('ADMIN - Look up a player across platforms')
            .addStringOption(opt => opt.setName('type').setDescription('Lookup type').setRequired(true)
                .addChoices({ name: 'Discord → PlayFab', value: 'discord' }, { name: 'PlayFab → Discord', value: 'playfab' }))
            .addStringOption(opt => opt.setName('id').setDescription('Discord @mention or PlayFab ID').setRequired(true)),

        // Discord management
        new SlashCommandBuilder().setName('lock').setDescription('DISCORD - Lock a channel')
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel to lock (leave blank for current)').setRequired(false)),
        new SlashCommandBuilder().setName('unlock').setDescription('DISCORD - Unlock a channel')
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel to unlock (leave blank for current)').setRequired(false)),
        new SlashCommandBuilder().setName('purge').setDescription('DISCORD - Delete messages from a channel')
            .addIntegerOption(opt => opt.setName('amount').setDescription('Number of messages to delete (max 100)').setRequired(true)),
        new SlashCommandBuilder().setName('nick').setDescription('DISCORD - Change a users nickname')
            .addUserOption(opt => opt.setName('user').setDescription('The user').setRequired(true))
            .addStringOption(opt => opt.setName('nickname').setDescription('New nickname (leave blank to reset)').setRequired(false)),
        new SlashCommandBuilder().setName('dm').setDescription('DISCORD - DM a user from the bot')
            .addUserOption(opt => opt.setName('user').setDescription('The user to DM').setRequired(true))
            .addStringOption(opt => opt.setName('message').setDescription('The message to send').setRequired(true)),

        // Tickets
        new SlashCommandBuilder().setName('ticketpanel').setDescription('TICKETS - Send the ticket panel to the channel'),
        new SlashCommandBuilder().setName('close').setDescription('TICKETS - Close the current ticket'),
        new SlashCommandBuilder().setName('transcript').setDescription('TICKETS - Save a transcript of the current ticket'),
        new SlashCommandBuilder().setName('add').setDescription('TICKETS - Add a user to the ticket')
            .addUserOption(opt => opt.setName('user').setDescription('User to add').setRequired(true)),
        new SlashCommandBuilder().setName('remove').setDescription('TICKETS - Remove a user from the ticket')
            .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true)),
        new SlashCommandBuilder().setName('rename').setDescription('TICKETS - Rename the current ticket channel')
            .addStringOption(opt => opt.setName('name').setDescription('New channel name').setRequired(true)),
        new SlashCommandBuilder().setName('claim').setDescription('TICKETS - Claim this ticket as yours to handle'),
        new SlashCommandBuilder().setName('unclaim').setDescription('TICKETS - Unclaim this ticket'),
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`Bot ready! Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {

       // /help
   if (interaction.isChatInputCommand() && interaction.commandName === 'help') {
       const embed = new EmbedBuilder()
           .setTitle('📖 Noximal Bot — Command List')
           .setColor(0x5865F2)
           .addFields(
               {
                   name: '🌐 General — Everyone',
                   value: [
                       '`/ping` — Check the bots response time',
                       '`/shop` — View the Noximal store',
                       '`/leaderboard` — View click or coin leaderboards',
                       '`/click` — Check your click count and progress',
                       '`/coinflip` — Bet your coins on a coin flip',
                       '`/poll` — Create an advanced poll',
                       '`/player-stats` — View a players public profile',
                       '`/report` — Report a player',
                       '`/link` — Link your PlayFab account to Discord',
                       '`/unlink` — Unlink your PlayFab account',
                       '`/help` — View this command list'
                    ].join('\n')
                },
                {
                    name: '🛡️ Moderation — Trial Mod and above',
                    value: [
                        '`/user` — Look up a player by their short code',
                        '`/player-info` — View full admin profile of a player',
                        '`/warn` — Warn a player (auto bans at 4 warnings)',
                        '`/warnings` — Check a players warnings',
                        '`/clearwarnings` — Clear a players warnings',
                        '`/history` — View a players full ban and warn history',
                        '`/inventory` — View a players inventory',
                        '`/coins` — Check a players coin balance',
                        '`/ban` — Ban a player with duration options',
                        '`/unban` — Unban a player',
                        '`/motd` — Set the in-game Message of the Day',
                        '`/announcement` — Send an in-game announcement',
                        '`/note` — Add a private note to a players profile',
                        '`/notes` — View all notes on a player',
                        '`/lookup` — Look up a player across Discord and PlayFab',
                        '`/giveaway` — Start a coin giveaway',
                        '`/dm` — DM a user from the bot',
                        '`/lock` — Lock a channel',
                        '`/unlock` — Unlock a channel',
                        '`/purge` — Delete messages from a channel',
                        '`/nick` — Change a users nickname'
                    ].join('\n')
                },
                {
                    name: '💰 Mod and above only',
                    value: [
                        '`/givecoins` — Give coins to yourself (must be linked)'
                    ].join('\n')
                },
                {
                    name: '🔨 Owner / Co-Owner / Head Admin only',
                    value: [
                        '`/ban` — Ban a player (duration options)',
                        '`/unban` — Unban a player',
                        '`/wipe` — Wipe all data for a player'
                    ].join('\n')
                },
                {
                    name: '🎫 Tickets — Everyone',
                    value: [
                        '`/close` — Close the current ticket',
                        '`/transcript` — Save a transcript of the current ticket'
                    ].join('\n')
                },
                {
                    name: '🎫 Tickets — Admin only',
                    value: [
                        '`/ticketpanel` — Send the ticket panel to a channel',
                        '`/add` — Add a user to a ticket',
                        '`/remove` — Remove a user from a ticket',
                        '`/rename` — Rename a ticket channel',
                        '`/claim` — Claim a ticket as yours',
                        '`/unclaim` — Unclaim a ticket'
                    ].join('\n')
                }
            )
            .setFooter({ text: 'Noximal Bot • Use commands responsibly' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], flags: 64 });
    }

    // /ping
    if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
        const sent = await interaction.deferReply({ fetchReply: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        await interaction.editReply(`🏓 Pong! **${latency}ms**`);
    }

    // /shop
    if (interaction.isChatInputCommand() && interaction.commandName === 'shop') {
        const embed = new EmbedBuilder()
            .setTitle('💎 Noximal Store')
            .setColor(0x5865F2)
            .setDescription('Welcome to the Noximal Store! Purchase Nox Bits and exclusive items below.')
            .addFields(
                { name: '💎 1,000 Nox Bits', value: '~~$1.99~~ **Out of Stock**', inline: true },
                { name: '💎 2,500 Nox Bits', value: '**$2.50**', inline: true },
                { name: '💎 5,000 Nox Bits', value: '**$5.00**', inline: true },
                { name: '💎 7,500 Nox Bits', value: '**$7.50**', inline: true },
                { name: '💎 10,000 Nox Bits', value: '~~$10.00~~ **$8.99**', inline: true },
                { name: '🎵 Noximal Soundboard', value: '**$4.99**', inline: true },
                { name: '📋 Noximal Menu V1', value: '~~$12.89~~ **$7.99**', inline: true },
                { name: '📋 Noximal Menu V2', value: '~~$16.99~~ **$14.99**', inline: true },
                { name: '\u200b', value: '\u200b', inline: false },
                { name: '🛒 How to Purchase', value: 'Click the link below to visit the store and complete your purchase. Open a **Shop Purchase** ticket after buying to claim your items!', inline: false }
            )
            .setFooter({ text: 'Noximal Store • Prices subject to change' })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('shop_action')
                .setPlaceholder('What would you like to do?')
                .addOptions([
                    { label: 'Visit Store', value: 'visit', emoji: '🛒', description: 'Go to the Noximal store website' },
                    { label: 'Open Purchase Ticket', value: 'ticket', emoji: '🎫', description: 'Claim something you already bought' }
                ])
        );

        await interaction.reply({ embeds: [embed], components: [row] });
    }

    // Shop action
    if (interaction.isStringSelectMenu() && interaction.customId === 'shop_action') {
        if (interaction.values[0] === 'visit') {
            await interaction.reply({ content: '🛒 **Visit the Noximal Store:**\nhttps://noximal-store.mysellauth.com/', flags: 64 });
        } else {
            await interaction.reply({ content: '🎫 Please use **/ticketpanel** channel and open a **Shop Purchase** ticket to claim your purchase!', flags: 64 });
        }
    }

    // /leaderboard
    if (interaction.isChatInputCommand() && interaction.commandName === 'leaderboard') {
        const type = interaction.options.getString('type');
        await interaction.deferReply();
        try {
            if (type === 'clicks') {
                const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetLeaderboard', {});
                const board = result.leaderboard;
                if (!board || board.length === 0) { await interaction.editReply('❌ No leaderboard data yet!'); return; }
                const medals = ['🥇', '🥈', '🥉'];
                const rows = board.map((entry, i) => `${medals[i] || `**#${i + 1}**`} **${entry.DisplayName || 'Unknown'}** — ${entry.StatValue.toLocaleString()} clicks`).join('\n');
                const embed = new EmbedBuilder()
                    .setTitle('🏆 Click Leaderboard')
                    .setColor(0xFFD700)
                    .setDescription(rows)
                    .setTimestamp()
                    .setFooter({ text: 'Top 10 players by click count • Resets monthly' });
                await interaction.editReply({ embeds: [embed] });
            } else {
                const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetCoinLeaderboard', {});
                const board = result.leaderboard;
                if (!board || board.length === 0) { await interaction.editReply('❌ No leaderboard data yet!'); return; }
                const medals = ['🥇', '🥈', '🥉'];
                const rows = board.map((entry, i) => `${medals[i] || `**#${i + 1}**`} **${entry.DisplayName || 'Unknown'}** — ${entry.Coins.toLocaleString()} 🪙`).join('\n');
                const embed = new EmbedBuilder()
                    .setTitle('🪙 Coin Leaderboard')
                    .setColor(0xFFD700)
                    .setDescription(rows)
                    .setTimestamp()
                    .setFooter({ text: 'Top 10 players by coin balance' });
                await interaction.editReply({ embeds: [embed] });
            }
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /click
    if (interaction.isChatInputCommand() && interaction.commandName === 'click') {
        if (interaction.channelId !== CLICK_CHANNEL_ID) {
            await interaction.reply({ content: `❌ This command can only be used in <#${CLICK_CHANNEL_ID}>!`, flags: 64 }); return;
        }
        const now = Date.now();
        const cooldownAmount = 10 * 1000;
        if (cooldowns.has(interaction.user.id)) {
            const expiresAt = cooldowns.get(interaction.user.id);
            if (now < expiresAt) {
                const secondsLeft = ((expiresAt - now) / 1000).toFixed(1);
                await interaction.reply({ content: `⏳ Please wait **${secondsLeft}s** before using /click again!`, flags: 64 }); return;
            }
        }
        cooldowns.set(interaction.user.id, now + cooldownAmount);
        await interaction.deferReply();
        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetClickCount', { discordId: interaction.user.id });
            if (!result.found) { await interaction.editReply('❌ You have not linked your PlayFab account yet! Use **/link <your PlayFab ID>** first.'); return; }
            const count = result.clickCount;
            const goal = 100000;
            const progress = Math.min(count / goal * 100, 100).toFixed(1);
            const progressBar = generateProgressBar(count, goal);
            if (count >= goal) {
                const member = interaction.member;
                if (!member.roles.cache.has(CLICKER_ROLE_ID)) await member.roles.add(CLICKER_ROLE_ID);
            }
            const embed = new EmbedBuilder()
                .setTitle('🖱️ Clicker Stats')
                .setColor(count >= goal ? 0xFFD700 : 0x5865F2)
                .addFields(
                    { name: 'Total Clicks', value: `**${count.toLocaleString()}**`, inline: true },
                    { name: 'Goal', value: `**${goal.toLocaleString()}**`, inline: true },
                    { name: 'Progress', value: `${progressBar} **${progress}%**` }
                )
                .setFooter({ text: count >= goal ? '🎉 You earned the 100,000 Clicker role!' : `${(goal - count).toLocaleString()} clicks to go!` });
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /coinflip
    if (interaction.isChatInputCommand() && interaction.commandName === 'coinflip') {
        const now = Date.now();
        const cooldownAmount = 15 * 1000;
        if (coinflipCooldowns.has(interaction.user.id)) {
            const expiresAt = coinflipCooldowns.get(interaction.user.id);
            if (now < expiresAt) {
                const secondsLeft = ((expiresAt - now) / 1000).toFixed(1);
                await interaction.reply({ content: `⏳ Please wait **${secondsLeft}s** before flipping again!`, flags: 64 }); return;
            }
        }
        coinflipCooldowns.set(interaction.user.id, now + cooldownAmount);

        const amount = interaction.options.getInteger('amount');
        const choice = interaction.options.getString('choice');

        if (amount <= 0) { await interaction.reply({ content: '❌ Bet amount must be greater than 0!', flags: 64 }); return; }

        await interaction.deferReply();
        try {
            const discordMap = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetDiscordLink', { discordId: interaction.user.id });
            if (!discordMap.found) { await interaction.editReply('❌ You need to link your PlayFab account first with **/link**!'); return; }

            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'CoinFlip', {
                playFabId: discordMap.playFabId,
                betAmount: amount,
                choice: choice
            });

            if (!result.success) {
                await interaction.editReply(`❌ ${result.reason === 'Not enough coins' ? 'You don\'t have enough coins to bet that amount!' : 'Something went wrong.'}`);
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`${result.won ? '🎉 You Won!' : '💸 You Lost!'}`)
                .setColor(result.won ? 0x00FF00 : 0xFF0000)
                .addFields(
                    { name: '🪙 Your Choice', value: choice.charAt(0).toUpperCase() + choice.slice(1), inline: true },
                    { name: '🎰 Result', value: result.result.charAt(0).toUpperCase() + result.result.slice(1), inline: true },
                    { name: '💰 Bet', value: amount.toLocaleString(), inline: true },
                    { name: result.won ? '✅ Won' : '❌ Lost', value: amount.toLocaleString(), inline: true },
                    { name: '🏦 New Balance', value: result.newBalance.toLocaleString(), inline: true }
                )
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /poll
    if (interaction.isChatInputCommand() && interaction.commandName === 'poll') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ Only admins can create polls!', flags: 64 }); return; }

        const question = interaction.options.getString('question');
        const option1 = interaction.options.getString('option1');
        const option2 = interaction.options.getString('option2');
        const option3 = interaction.options.getString('option3');
        const option4 = interaction.options.getString('option4');
        const duration = interaction.options.getInteger('duration') || 60;

        const options = [option1, option2, option3, option4].filter(Boolean);
        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
        const votes = new Map(options.map(opt => [opt, new Set()]));

        const endTime = new Date(Date.now() + duration * 60 * 1000);

        const embed = new EmbedBuilder()
            .setTitle(`📊 ${question}`)
            .setColor(0x5865F2)
            .setDescription(options.map((opt, i) => `${emojis[i]} **${opt}**\n▱▱▱▱▱▱▱▱▱▱ 0% (0 votes)`).join('\n\n'))
            .addFields({ name: '⏱️ Ends', value: `<t:${Math.floor(endTime.getTime() / 1000)}:R>`, inline: true })
            .setFooter({ text: 'Vote using the buttons below!' })
            .setTimestamp();

        const rows = [];
        const optionRow = new ActionRowBuilder().addComponents(
            options.map((opt, i) =>
                new StringSelectMenuBuilder()
                    .setCustomId(`poll_vote`)
                    .setPlaceholder('Cast your vote...')
                    .addOptions(options.map((o, j) => ({ label: o, value: `${j}`, emoji: emojis[j] })))
            )[0]
        );

        await interaction.deferReply();
        const msg = await interaction.editReply({ embeds: [embed], components: [optionRow], fetchReply: true });

        // Store poll data
        activeGiveaways.set(msg.id, { question, options, votes, endTime, emojis, type: 'poll' });

        // End poll after duration
        setTimeout(async () => {
            const pollData = activeGiveaways.get(msg.id);
            if (!pollData) return;

            const totalVotes = [...pollData.votes.values()].reduce((a, b) => a + b.size, 0);
            const finalEmbed = new EmbedBuilder()
                .setTitle(`📊 ${question} — Results`)
                .setColor(0xFFD700)
                .setDescription(pollData.options.map((opt, i) => {
                    const count = pollData.votes.get(opt).size;
                    const percent = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                    const bar = '▰'.repeat(Math.round(percent / 10)) + '▱'.repeat(10 - Math.round(percent / 10));
                    return `${emojis[i]} **${opt}**\n${bar} ${percent}% (${count} votes)`;
                }).join('\n\n'))
                .addFields({ name: '📊 Total Votes', value: totalVotes.toString(), inline: true })
                .setFooter({ text: 'Poll ended' })
                .setTimestamp();

            await msg.edit({ embeds: [finalEmbed], components: [] });
            activeGiveaways.delete(msg.id);
        }, duration * 60 * 1000);
    }

    // Poll vote
    if (interaction.isStringSelectMenu() && interaction.customId === 'poll_vote') {
        const msg = interaction.message;
        const pollData = activeGiveaways.get(msg.id);
        if (!pollData || pollData.type !== 'poll') { await interaction.reply({ content: '❌ This poll has ended!', flags: 64 }); return; }

        const optionIndex = parseInt(interaction.values[0]);
        const chosenOption = pollData.options[optionIndex];

        // Remove previous vote
        for (const [opt, voters] of pollData.votes) {
            voters.delete(interaction.user.id);
        }
        pollData.votes.get(chosenOption).add(interaction.user.id);

        const totalVotes = [...pollData.votes.values()].reduce((a, b) => a + b.size, 0);
        const updatedEmbed = new EmbedBuilder()
            .setTitle(`📊 ${pollData.question}`)
            .setColor(0x5865F2)
            .setDescription(pollData.options.map((opt, i) => {
                const count = pollData.votes.get(opt).size;
                const percent = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                const bar = '▰'.repeat(Math.round(percent / 10)) + '▱'.repeat(10 - Math.round(percent / 10));
                return `${pollData.emojis[i]} **${opt}**\n${bar} ${percent}% (${count} votes)`;
            }).join('\n\n'))
            .addFields({ name: '⏱️ Ends', value: `<t:${Math.floor(pollData.endTime.getTime() / 1000)}:R>`, inline: true })
            .setFooter({ text: 'Vote using the dropdown below!' })
            .setTimestamp();

        await msg.edit({ embeds: [updatedEmbed] });
        await interaction.reply({ content: `✅ You voted for **${chosenOption}**!`, flags: 64 });
    }

    // /player-stats (public)
    if (interaction.isChatInputCommand() && interaction.commandName === 'player-stats') {
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply();
        try {
            const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
            const stats = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetPublicPlayerStats', { playFabId: lookup.playFabId });
            const joinDate = new Date(stats.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            const lastLogin = new Date(stats.lastLogin).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            const itemList = stats.inventory && stats.inventory.length > 0
                ? stats.inventory.map(i => `• ${i.DisplayName || i.ItemId}`).join('\n')
                : 'No items';
            const embed = new EmbedBuilder()
                .setTitle(`👤 ${stats.displayName || 'Unknown'}`)
                .setColor(0x5865F2)
                .addFields(
                    { name: '🔑 Short Code', value: `\`${shortCode}\``, inline: true },
                    { name: '🖱️ Clicks', value: stats.clickCount.toLocaleString(), inline: true },
                    { name: '🪙 Coins', value: stats.coins.toLocaleString(), inline: true },
                    { name: '📅 Joined', value: joinDate, inline: true },
                    { name: '🕐 Last Seen', value: lastLogin, inline: true },
                    { name: '⏱️ Playtime', value: formatTime(stats.playtime), inline: true },
                    { name: '🎒 Inventory', value: itemList }
                )
                .setTimestamp()
                .setFooter({ text: 'Public profile • Sensitive info hidden' });
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /player-info (admin)
    if (interaction.isChatInputCommand() && interaction.commandName === 'player-info') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const input = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply({ flags: 64 });
        try {
            let playFabId = input;
            let shortCode = input;
            if (input.length === 6) {
                const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode: input });
                if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
                playFabId = lookup.playFabId;
            }
            const info = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetFullPlayerInfo', { playFabId });
            const joinDate = new Date(info.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            const lastLogin = new Date(info.lastLogin).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            const itemList = info.inventory && info.inventory.length > 0
                ? info.inventory.map(i => `• ${i.DisplayName || i.ItemId}`).join('\n')
                : 'No items';
            const embed = new EmbedBuilder()
                .setTitle(`🔍 Admin Profile: ${info.displayName || 'Unknown'}`)
                .setColor(0xFF0000)
                .addFields(
                    { name: '🔑 Short Code', value: `\`${shortCode}\``, inline: true },
                    { name: '🆔 PlayFab ID', value: `\`${playFabId}\``, inline: true },
                    { name: '🖱️ Clicks', value: info.clickCount.toLocaleString(), inline: true },
                    { name: '🪙 Coins', value: info.coins.toLocaleString(), inline: true },
                    { name: '📅 Joined', value: joinDate, inline: true },
                    { name: '🕐 Last Login', value: lastLogin, inline: true },
                    { name: '⏱️ Playtime', value: formatTime(info.playtime), inline: true },
                    { name: '⚠️ Warnings', value: info.warnings.length.toString(), inline: true },
                    { name: '🔨 Total Bans', value: info.totalBans.toString(), inline: true },
                    { name: '🔒 Active Bans', value: info.activeBans.length > 0 ? '⛔ Yes' : '✅ None', inline: true },
                    { name: '🎒 Inventory', value: itemList },
                    { name: '📝 Notes', value: info.notes.length > 0 ? info.notes.map((n, i) => `${i + 1}. ${n.note} — *${n.addedBy}*`).join('\n') : 'No notes' }
                )
                .setTimestamp()
                .setFooter({ text: 'Admin only • Full player info' });
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /warn
    if (interaction.isChatInputCommand() && interaction.commandName === 'warn') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        const reason = interaction.options.getString('reason');
        await interaction.deferReply();
        try {
            const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'WarnPlayer', {
                playFabId: lookup.playFabId,
                reason,
                warnedBy: interaction.user.tag
            });
            const embed = new EmbedBuilder()
                .setTitle(result.autoBanned ? '🔨 Player Warned & Auto-Banned!' : '⚠️ Player Warned')
                .setColor(result.autoBanned ? 0xFF0000 : 0xFFAA00)
                .addFields(
                    { name: '👤 Player', value: lookup.displayName || 'Unknown', inline: true },
                    { name: '⚠️ Warnings', value: `${result.warningCount}/4`, inline: true },
                    { name: '📋 Reason', value: reason },
                    { name: '🛡️ Warned By', value: `<@${interaction.user.id}>` }
                )
                .setTimestamp();
            if (result.autoBanned) {
                embed.setDescription('⛔ Player has reached 4 warnings and has been automatically banned for **1 week**!');
            }
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /warnings
    if (interaction.isChatInputCommand() && interaction.commandName === 'warnings') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply();
        try {
            const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetWarnings', { playFabId: lookup.playFabId });
            const warnings = result.warnings;
            const embed = new EmbedBuilder()
                .setTitle(`⚠️ Warnings: ${lookup.displayName || 'Unknown'}`)
                .setColor(warnings.length >= 4 ? 0xFF0000 : warnings.length >= 2 ? 0xFFAA00 : 0xFFFF00)
                .setDescription(warnings.length === 0 ? 'No warnings on record.' : warnings.map((w, i) => `**${i + 1}.** ${w.reason}\n*By ${w.warnedBy} • ${new Date(w.date).toLocaleDateString()}*`).join('\n\n'))
                .addFields({ name: '⚠️ Total Warnings', value: `${warnings.length}/4`, inline: true })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /clearwarnings
    if (interaction.isChatInputCommand() && interaction.commandName === 'clearwarnings') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply();
        try {
            const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
            await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'ClearWarnings', { playFabId: lookup.playFabId });
            const embed = new EmbedBuilder()
                .setTitle('✅ Warnings Cleared')
                .setColor(0x00FF00)
                .addFields(
                    { name: '👤 Player', value: lookup.displayName || 'Unknown', inline: true },
                    { name: '🛡️ Cleared By', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /history
    if (interaction.isChatInputCommand() && interaction.commandName === 'history') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply();
        try {
            const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
            const history = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetPlayerHistory', { playFabId: lookup.playFabId });
            const warnText = history.warnings.length > 0
                ? history.warnings.map((w, i) => `**${i + 1}.** ${w.reason} — *${new Date(w.date).toLocaleDateString()}*`).join('\n')
                : 'No warnings';
            const banText = history.bans.length > 0
                ? history.bans.map(b => `• ${b.Reason || 'No reason'} — ${b.Active ? '⛔ Active' : '✅ Expired'}`).join('\n')
                : 'No bans';
            const embed = new EmbedBuilder()
                .setTitle(`📋 History: ${lookup.displayName || 'Unknown'}`)
                .setColor(0xFF0000)
                .addFields(
                    { name: `⚠️ Warnings (${history.warnings.length})`, value: warnText },
                    { name: `🔨 Bans (${history.bans.length})`, value: banText }
                )
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /inventory
    if (interaction.isChatInputCommand() && interaction.commandName === 'inventory') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply();
        try {
            const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
            const info = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetFullPlayerInfo', { playFabId: lookup.playFabId });
            const itemList = info.inventory && info.inventory.length > 0
                ? info.inventory.map(i => `• **${i.DisplayName || i.ItemId}** (x${i.RemainingUses || 1})`).join('\n')
                : 'No items in inventory';
            const embed = new EmbedBuilder()
                .setTitle(`🎒 Inventory: ${info.displayName || 'Unknown'}`)
                .setColor(0x5865F2)
                .setDescription(itemList)
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /coins
    if (interaction.isChatInputCommand() && interaction.commandName === 'coins') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply();
        try {
            const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
            const info = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetFullPlayerInfo', { playFabId: lookup.playFabId });
            const embed = new EmbedBuilder()
                .setTitle(`🪙 Coin Balance: ${info.displayName || 'Unknown'}`)
                .setColor(0xFFD700)
                .addFields({ name: '🪙 Coins', value: info.coins.toLocaleString(), inline: true })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /ban
    if (interaction.isChatInputCommand() && interaction.commandName === 'ban') {
        const hasBanRole = BAN_ALLOWED_ROLES.some(r => interaction.member.roles.cache.has(r));
        if (!hasBanRole) { await interaction.reply({ content: '❌ You do not have permission to ban players.', flags: 64 }); return; }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        const reason = interaction.options.getString('reason');
        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`ban_duration_${shortCode}_${encodeURIComponent(reason)}`)
                .setPlaceholder('Select ban duration...')
                .addOptions([
                    { label: '1 Hour', value: '1h', emoji: '⏰' },
                    { label: '1 Day', value: '1d', emoji: '📅' },
                    { label: '1 Week', value: '1w', emoji: '🗓️' },
                    { label: '1 Month', value: '1m', emoji: '📆' },
                    { label: '1 Year', value: '1y', emoji: '🗃️' },
                    { label: 'Permanent', value: 'perm', emoji: '🔨' }
                ])
        );
        await interaction.reply({ content: `⏱️ **Select ban duration for \`${shortCode}\`:**`, components: [row], flags: 64 });
    }

    // Ban duration selected
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ban_duration_')) {
        const parts = interaction.customId.replace('ban_duration_', '').split('_');
        const shortCode = parts[0];
        const reason = decodeURIComponent(parts.slice(1).join('_'));
        const durationKey = interaction.values[0];
        const duration = BAN_DURATIONS[durationKey];
        await interaction.deferUpdate();
        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!result.found) { await interaction.editReply({ content: '❌ That short code does not exist.', components: [] }); return; }
            await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'BanPlayer', { playFabId: result.playFabId, reason, durationInHours: duration.hours });
            const embed = new EmbedBuilder()
                .setTitle('🔨 Player Banned')
                .setColor(0xFF0000)
                .addFields(
                    { name: '👤 Player', value: result.displayName || 'Unknown', inline: true },
                    { name: '🔑 Short Code', value: `\`${shortCode}\``, inline: true },
                    { name: '⏱️ Duration', value: duration.label, inline: true },
                    { name: '📋 Reason', value: reason },
                    { name: '🛡️ Banned By', value: `<@${interaction.user.id}>` }
                )
                .setTimestamp();
            await interaction.editReply({ embeds: [embed], components: [] });
        } catch (err) { console.error(err); await interaction.editReply({ content: '❌ Something went wrong.', components: [] }); }
    }

    // /unban
    if (interaction.isChatInputCommand() && interaction.commandName === 'unban') {
        const hasBanRole = BAN_ALLOWED_ROLES.some(r => interaction.member.roles.cache.has(r));
        if (!hasBanRole) { await interaction.reply({ content: '❌ You do not have permission to unban players.', flags: 64 }); return; }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply();
        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!result.found) { await interaction.editReply('❌ That short code does not exist.'); return; }
            await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'UnbanPlayer', { playFabId: result.playFabId });
            const embed = new EmbedBuilder()
                .setTitle('✅ Player Unbanned')
                .setColor(0x00FF00)
                .addFields(
                    { name: '👤 Player', value: result.displayName || 'Unknown', inline: true },
                    { name: '🔑 Short Code', value: `\`${shortCode}\``, inline: true },
                    { name: '🛡️ Unbanned By', value: `<@${interaction.user.id}>` }
                )
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /motd
    if (interaction.isChatInputCommand() && interaction.commandName === 'motd') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const message = interaction.options.getString('message');
        await interaction.deferReply();
        try {
            const response = await fetch(`https://${TITLE_ID}.playfabapi.com/Server/SetTitleData`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-SecretKey': SECRET_KEY },
                body: JSON.stringify({ Key: 'MOTD', Value: message })
            });
            const data = await response.json();
            await interaction.editReply(data.code === 200 ? `✅ **MOTD Updated!**\n> ${message}` : '❌ Failed to update MOTD.');
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /announcement
    if (interaction.isChatInputCommand() && interaction.commandName === 'announcement') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const message = interaction.options.getString('message');
        await interaction.deferReply();
        try {
            const response = await fetch(`https://${TITLE_ID}.playfabapi.com/Server/SetTitleData`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-SecretKey': SECRET_KEY },
                body: JSON.stringify({ Key: 'Announcement', Value: message })
            });
            const data = await response.json();
            await interaction.editReply(data.code === 200 ? `📢 **Announcement Sent!**\n> ${message}` : '❌ Failed to send announcement.');
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /givecoins
    if (interaction.isChatInputCommand() && interaction.commandName === 'givecoins') {
        const hasRole = GIVE_COINS_ROLES.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command. Mod and above only!', flags: 64 }); return; }
        await interaction.deferReply({ flags: 64 });
        try {
            const discordMap = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetDiscordLink', { discordId: interaction.user.id });
            if (!discordMap.found) { await interaction.editReply('❌ You need to link your PlayFab account first with **/link**!'); return; }
            const amount = interaction.options.getInteger('amount');
            await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GiveCoins', { playFabId: discordMap.playFabId, amount });
            const embed = new EmbedBuilder()
                .setTitle('🪙 Coins Given!')
                .setColor(0xFFD700)
                .addFields(
                    { name: '👤 Player', value: `<@${interaction.user.id}>`, inline: true },
                    { name: '🪙 Amount', value: amount.toLocaleString(), inline: true }
                )
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /wipe
    if (interaction.isChatInputCommand() && interaction.commandName === 'wipe') {
        if (!interaction.member.roles.cache.has(OWNER_ROLE)) {
            await interaction.reply({ content: '❌ Only the Owner can use this command!', flags: 64 }); return;
        }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply({ flags: 64 });
        try {
            const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
            await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'WipePlayer', { playFabId: lookup.playFabId });
            const embed = new EmbedBuilder()
                .setTitle('🗑️ Player Data Wiped')
                .setColor(0xFF0000)
                .addFields(
                    { name: '👤 Player', value: lookup.displayName || 'Unknown', inline: true },
                    { name: '🛡️ Wiped By', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /giveaway
    if (interaction.isChatInputCommand() && interaction.commandName === 'giveaway') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const amount = interaction.options.getInteger('amount');
        const duration = interaction.options.getInteger('duration');
        const channelId = interaction.options.getString('channel');
        const targetChannel = channelId ? await client.channels.fetch(channelId).catch(() => null) || interaction.channel : interaction.channel;
        const endTime = new Date(Date.now() + duration * 60 * 1000);
        await interaction.deferReply({ flags: 64 });

        const embed = new EmbedBuilder()
            .setTitle('🎉 GIVEAWAY!')
            .setColor(0xFFD700)
            .setDescription(`**${amount.toLocaleString()} 🪙 Nox Bits** are up for grabs!\n\nClick the button below to enter! Winner is selected randomly.\n\n**You must have your PlayFab linked with /link to enter!**`)
            .addFields(
                { name: '⏱️ Ends', value: `<t:${Math.floor(endTime.getTime() / 1000)}:R>`, inline: true },
                { name: '🎯 Entries', value: '0', inline: true },
                { name: '🎖️ Hosted By', value: `<@${interaction.user.id}>`, inline: true }
            )
            .setFooter({ text: 'Click to enter!' })
            .setTimestamp(endTime);

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('giveaway_enter')
                .setPlaceholder('🎉 Click to enter the giveaway!')
                .addOptions([{ label: 'Enter Giveaway', value: 'enter', emoji: '🎉' }])
        );

        const msg = await targetChannel.send({ embeds: [embed], components: [row] });
        activeGiveaways.set(msg.id, { amount, entries: new Set(), endTime, type: 'giveaway', hostId: interaction.user.id });
        await interaction.editReply(`✅ Giveaway started in <#${targetChannel.id}>!`);

        setTimeout(async () => {
            const giveaway = activeGiveaways.get(msg.id);
            if (!giveaway) return;

            if (giveaway.entries.size === 0) {
                await msg.edit({ content: '❌ Giveaway ended with no entries!', components: [] });
                activeGiveaways.delete(msg.id);
                return;
            }

            const entries = [...giveaway.entries];
            const winnerId = entries[Math.floor(Math.random() * entries.length)];

            // Give coins to winner
            try {
                const discordMap = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetDiscordLink', { discordId: winnerId });
                if (discordMap.found) {
                    await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GiveCoins', { playFabId: discordMap.playFabId, amount: giveaway.amount });
                }
            } catch (e) { console.error(e); }

            const winEmbed = new EmbedBuilder()
                .setTitle('🎉 Giveaway Ended!')
                .setColor(0xFFD700)
                .setDescription(`**Winner: <@${winnerId}>**\n\n🪙 **${giveaway.amount.toLocaleString()} Nox Bits** have been added to their account!`)
                .addFields({ name: '📊 Total Entries', value: giveaway.entries.size.toString(), inline: true })
                .setTimestamp();

            await msg.edit({ embeds: [winEmbed], components: [] });
            await targetChannel.send({ content: `🎉 Congratulations <@${winnerId}>! You won **${giveaway.amount.toLocaleString()} 🪙 Nox Bits**!` });
            activeGiveaways.delete(msg.id);
        }, duration * 60 * 1000);
    }

    // Giveaway enter
    if (interaction.isStringSelectMenu() && interaction.customId === 'giveaway_enter') {
        const msg = interaction.message;
        const giveaway = activeGiveaways.get(msg.id);
        if (!giveaway || giveaway.type !== 'giveaway') { await interaction.reply({ content: '❌ This giveaway has ended!', flags: 64 }); return; }

        if (giveaway.entries.has(interaction.user.id)) {
            await interaction.reply({ content: '❌ You are already entered in this giveaway!', flags: 64 }); return;
        }

        const discordMap = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetDiscordLink', { discordId: interaction.user.id }).catch(() => null);
        if (!discordMap || !discordMap.found) {
            await interaction.reply({ content: '❌ You need to link your PlayFab account with **/link** to enter!', flags: 64 }); return;
        }

        giveaway.entries.add(interaction.user.id);

        const embed = EmbedBuilder.from(msg.embeds[0])
            .spliceFields(1, 1, { name: '🎯 Entries', value: giveaway.entries.size.toString(), inline: true });
        await msg.edit({ embeds: [embed] });
        await interaction.reply({ content: '✅ You have entered the giveaway! Good luck! 🎉', flags: 64 });
    }

    // /note
    if (interaction.isChatInputCommand() && interaction.commandName === 'note') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        const note = interaction.options.getString('note');
        await interaction.deferReply({ flags: 64 });
        try {
            const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
            await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'AddNote', { playFabId: lookup.playFabId, note, addedBy: interaction.user.tag });
            await interaction.editReply(`✅ Note added to **${lookup.displayName || 'Unknown'}**'s profile!`);
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /notes
    if (interaction.isChatInputCommand() && interaction.commandName === 'notes') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply({ flags: 64 });
        try {
            const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!lookup.found) { await interaction.editReply('❌ No player found with that code.'); return; }
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetNotes', { playFabId: lookup.playFabId });
            const notes = result.notes;
            const embed = new EmbedBuilder()
                .setTitle(`📝 Notes: ${lookup.displayName || 'Unknown'}`)
                .setColor(0x5865F2)
                .setDescription(notes.length === 0 ? 'No notes on record.' : notes.map((n, i) => `**${i + 1}.** ${n.note}\n*By ${n.addedBy} • ${new Date(n.date).toLocaleDateString()}*`).join('\n\n'))
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /lookup
    if (interaction.isChatInputCommand() && interaction.commandName === 'lookup') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const type = interaction.options.getString('type');
        const id = interaction.options.getString('id').trim();
        await interaction.deferReply({ flags: 64 });
        try {
            if (type === 'discord') {
                const discordId = id.replace(/[<@!>]/g, '');
                const discordMap = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetDiscordLink', { discordId });
                if (!discordMap.found) { await interaction.editReply('❌ No PlayFab account linked to that Discord user!'); return; }
                const lookup = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'ValidatePlayFabId', { playFabId: discordMap.playFabId });
                const embed = new EmbedBuilder()
                    .setTitle('🔍 Discord → PlayFab Lookup')
                    .setColor(0x5865F2)
                    .addFields(
                        { name: '👤 Discord', value: `<@${discordId}>`, inline: true },
                        { name: '🎮 Display Name', value: lookup.displayName || 'Unknown', inline: true },
                        { name: '🆔 PlayFab ID', value: `\`${discordMap.playFabId}\``, inline: true }
                    )
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            } else {
                const existing = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'ValidatePlayFabId', { playFabId: id });
                if (!existing.valid) { await interaction.editReply('❌ That PlayFab ID does not exist!'); return; }

                // Search DiscordMap for matching PlayFabId
                const response = await fetch(`https://${TITLE_ID}.playfabapi.com/Server/GetTitleData`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-SecretKey': SECRET_KEY },
                    body: JSON.stringify({ Keys: ['DiscordMap'] })
                });
                const data = await response.json();
                let discordId = null;
                if (data.data && data.data.Data && data.data.Data['DiscordMap']) {
                    const map = JSON.parse(data.data.Data['DiscordMap']);
                    for (const [dId, pfId] of Object.entries(map)) {
                        if (pfId === id) { discordId = dId; break; }
                    }
                }

                const embed = new EmbedBuilder()
                    .setTitle('🔍 PlayFab → Discord Lookup')
                    .setColor(0x5865F2)
                    .addFields(
                        { name: '🆔 PlayFab ID', value: `\`${id}\``, inline: true },
                        { name: '🎮 Display Name', value: existing.displayName || 'Unknown', inline: true },
                        { name: '👤 Discord', value: discordId ? `<@${discordId}>` : 'Not linked', inline: true }
                    )
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            }
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /lock
    if (interaction.isChatInputCommand() && interaction.commandName === 'lock') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        await interaction.deferReply();
        try {
            await channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false });
            await interaction.editReply(`🔒 <#${channel.id}> has been locked!`);
        } catch (err) { console.error(err); await interaction.editReply('❌ Failed to lock channel.'); }
    }

    // /unlock
    if (interaction.isChatInputCommand() && interaction.commandName === 'unlock') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        await interaction.deferReply();
        try {
            await channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: null });
            await interaction.editReply(`🔓 <#${channel.id}> has been unlocked!`);
        } catch (err) { console.error(err); await interaction.editReply('❌ Failed to unlock channel.'); }
    }

    // /purge
    if (interaction.isChatInputCommand() && interaction.commandName === 'purge') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const amount = Math.min(interaction.options.getInteger('amount'), 100);
        await interaction.deferReply({ flags: 64 });
        try {
            const deleted = await interaction.channel.bulkDelete(amount, true);
            await interaction.editReply(`✅ Deleted **${deleted.size}** messages!`);
        } catch (err) { console.error(err); await interaction.editReply('❌ Failed to delete messages. Messages older than 14 days cannot be bulk deleted.'); }
    }

    // /nick
    if (interaction.isChatInputCommand() && interaction.commandName === 'nick') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const user = interaction.options.getUser('user');
        const nickname = interaction.options.getString('nickname') || null;
        await interaction.deferReply();
        try {
            const member = await interaction.guild.members.fetch(user.id);
            await member.setNickname(nickname);
            await interaction.editReply(nickname ? `✅ Changed <@${user.id}>'s nickname to **${nickname}**` : `✅ Reset <@${user.id}>'s nickname`);
        } catch (err) { console.error(err); await interaction.editReply('❌ Failed to change nickname.'); }
    }

    // /dm
    if (interaction.isChatInputCommand() && interaction.commandName === 'dm') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const user = interaction.options.getUser('user');
        const message = interaction.options.getString('message');
        await interaction.deferReply({ flags: 64 });
        try {
            const embed = new EmbedBuilder()
                .setTitle('📨 Message from Noximal Staff')
                .setColor(0x5865F2)
                .setDescription(message)
                .setFooter({ text: `Sent by ${interaction.user.tag}` })
                .setTimestamp();
            await user.send({ embeds: [embed] });
            await interaction.editReply(`✅ Message sent to <@${user.id}>!`);
        } catch (err) { console.error(err); await interaction.editReply('❌ Failed to DM that user. They may have DMs disabled.'); }
    }

    // /user
    if (interaction.isChatInputCommand() && interaction.commandName === 'user') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }
        const code = interaction.options.getString('code').toUpperCase();
        await interaction.deferReply();
        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode: code });
            if (result.found) {
                await interaction.editReply(`✅ **Player Found**\n**Short Code:** \`${code}\`\n**Display Name:** ${result.displayName || 'None set'}\n**PlayFab ID:** \`${result.playFabId}\``);
            } else {
                await interaction.editReply(`❌ No player found with code \`${code}\``);
            }
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /link
    if (interaction.isChatInputCommand() && interaction.commandName === 'link') {
        const playFabId = interaction.options.getString('playfabid').trim();
        await interaction.deferReply({ flags: 64 });
        try {
            const validate = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'ValidatePlayFabId', { playFabId });
            if (!validate.valid) { await interaction.editReply('❌ That PlayFab ID does not exist. Please check and try again.'); return; }
            await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LinkDiscord', { discordId: interaction.user.id, playFabId });
            await interaction.editReply(`✅ Linked as **${validate.displayName || playFabId}**! Use **/click** to check your count!`);
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /unlink
    if (interaction.isChatInputCommand() && interaction.commandName === 'unlink') {
        await interaction.deferReply({ flags: 64 });
        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'UnlinkDiscord', { discordId: interaction.user.id });
            await interaction.editReply(result.success ? '✅ Your PlayFab account has been unlinked!' : '❌ You don\'t have a linked account to unlink!');
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong.'); }
    }

    // /report
    if (interaction.isChatInputCommand() && interaction.commandName === 'report') {
        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('report_type')
                .setPlaceholder('Select a reason...')
                .addOptions([
                    { label: 'Cheating', description: 'Player is cheating or exploiting', value: 'Cheating', emoji: '🎮' },
                    { label: 'Toxicity', description: 'Player is being toxic or harassing others', value: 'Toxicity', emoji: '🤬' },
                    { label: 'Inappropriate Name', description: 'Player has an inappropriate username', value: 'Inappropriate Name', emoji: '🏷️' },
                    { label: 'Other', description: 'Something else', value: 'Other', emoji: '❓' }
                ])
        );
        await interaction.reply({ content: '📋 **What are you reporting this player for?**', components: [row], flags: 64 });
    }

    // Report dropdown
    if (interaction.isStringSelectMenu() && interaction.customId === 'report_type') {
        const selectedReason = interaction.values[0];
        const modal = new ModalBuilder()
            .setCustomId(`report_modal_${selectedReason}`)
            .setTitle(`Report: ${selectedReason}`);
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('short_code').setLabel('Player\'s 6 digit ID (shown under their name)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 8E4036').setMinLength(6).setMaxLength(6).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('details').setLabel('Describe what happened').setStyle(TextInputStyle.Paragraph).setPlaceholder('Please describe the situation in detail...').setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('additional').setLabel('Additional Info (optional)').setStyle(TextInputStyle.Paragraph).setPlaceholder('Any extra info, timestamps, witnesses etc...').setRequired(false)
            )
        );
        await interaction.showModal(modal);
    }

    // Report modal submit
    if (interaction.isModalSubmit() && interaction.customId.startsWith('report_modal_')) {
        const reason = interaction.customId.replace('report_modal_', '');
        const shortCode = interaction.fields.getTextInputValue('short_code').trim().toUpperCase();
        const details = interaction.fields.getTextInputValue('details');
        const additional = interaction.fields.getTextInputValue('additional') || 'None provided';
        await interaction.deferReply({ flags: 64 });
        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });
            if (!result.found) { await interaction.editReply('❌ That ID code is invalid. Make sure you copied the 6 digit yellow code shown under their name!'); return; }
            const reportChannel = await client.channels.fetch(REPORT_CHANNEL_ID);
            const embed = new EmbedBuilder()
                .setTitle('🚨 New Player Report')
                .setColor(0xFF0000)
                .addFields(
                    { name: '📋 Reason', value: reason, inline: true },
                    { name: '👤 Reported By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: '🎮 Reported Player', value: result.displayName || 'Unknown', inline: true },
                    { name: '🔑 Short Code', value: `\`${shortCode}\``, inline: true },
                    { name: '🆔 PlayFab ID', value: `\`${result.playFabId}\``, inline: true },
                    { name: '📝 Details', value: details },
                    { name: 'ℹ️ Additional Info', value: additional }
                )
                .setTimestamp()
                .setFooter({ text: `Report submitted by ${interaction.user.tag}` });
            await reportChannel.send({ embeds: [embed] });
            await interaction.editReply('✅ Your report has been submitted! Our moderation team will review it shortly.');
        } catch (err) { console.error(err); await interaction.editReply('❌ Something went wrong while submitting your report.'); }
    }

    // ==================== TICKET SYSTEM ====================

    // /ticketpanel
    if (interaction.isChatInputCommand() && interaction.commandName === 'ticketpanel') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 }); return; }

        const embed = new EmbedBuilder()
            .setTitle('🎫 Support Tickets')
            .setColor(0x5865F2)
            .setDescription('Need help? Open a ticket below and our staff will assist you as soon as possible!')
            .addFields(
                { name: '👑 Admin Application', value: 'Apply to become a staff member', inline: true },
                { name: '🚨 Report a Player', value: 'Report someone breaking rules', inline: true },
                { name: '🛒 Shop Purchase', value: 'Claim or report a shop purchase', inline: true },
                { name: '⚖️ Ban Appeal', value: 'Appeal a ban from the game', inline: true },
                { name: '⚠️ Important', value: '• Be honest and provide accurate information\n• False reports may result in punishment\n• Be patient while waiting for a response', inline: false }
            )
            .setFooter({ text: 'Click the dropdown below to open a ticket' })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('ticket_open')
                .setPlaceholder('🎯 Select a ticket type to open...')
                .addOptions([
                    { label: 'Admin Application', value: 'admin_apply', emoji: '👑', description: 'Apply to become a server administrator' },
                    { label: 'Report a Player', value: 'report_player', emoji: '🚨', description: 'Report a player for rule violations' },
                    { label: 'Shop Purchase', value: 'shop_purchase', emoji: '🛒', description: 'Claim or report an issue with a shop purchase' },
                    { label: 'Ban Appeal', value: 'ban_appeal', emoji: '⚖️', description: 'Appeal a ban from the game' }
                ])
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: '✅ Ticket panel sent!', flags: 64 });
    }

    // Ticket open dropdown
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_open') {
        const ticketType = interaction.values[0];
        const ticketInfo = TICKET_TYPES[ticketType];

        const modal = new ModalBuilder()
            .setCustomId(`ticket_modal_${ticketType}`)
            .setTitle(`${ticketInfo.emoji} ${ticketInfo.label}`);

        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('player_code')
                    .setLabel('Your 6 digit player code OR PlayFab ID')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('The yellow code shown above your head in game e.g. 8E4036')
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('description')
                    .setLabel('Describe your issue or request')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Please provide as much detail as possible...')
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('additional')
                    .setLabel('Additional Info (optional)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Any extra info, evidence, links etc...')
                    .setRequired(false)
            )
        );

        await interaction.showModal(modal);
    }

    // Ticket modal submit
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_modal_')) {
        const ticketType = interaction.customId.replace('ticket_modal_', '');
        const ticketInfo = TICKET_TYPES[ticketType];
        const playerCode = interaction.fields.getTextInputValue('player_code').trim();
        const description = interaction.fields.getTextInputValue('description');
        const additional = interaction.fields.getTextInputValue('additional') || 'None provided';

        await interaction.deferReply({ flags: 64 });

        try {
            const guild = interaction.guild;
            const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
            const username = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
            const channelName = `${ticketType.replace('_', '-')}-${username}`;

            const permissionOverwrites = [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
            ];

            for (const roleId of adminRoleIds) {
                permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
            }

            const ticketChannel = await guild.channels.create({
                name: channelName,
                type: 0,
                parent: TICKET_CATEGORY_ID,
                permissionOverwrites
            });

            const adminPings = adminRoleIds.map(id => `<@&${id}>`).join(' ');

            const ticketEmbed = new EmbedBuilder()
                .setTitle(`${ticketInfo.emoji} ${ticketInfo.label}`)
                .setColor(ticketInfo.color)
                .addFields(
                    { name: '👤 Opened By', value: `<@${interaction.user.id}>`, inline: true },
                    { name: '🎮 Player Code / ID', value: `\`${playerCode}\``, inline: true },
                    { name: '📝 Description', value: description },
                    { name: 'ℹ️ Additional Info', value: additional }
                )
                .setTimestamp()
                .setFooter({ text: 'Use the dropdown below to manage this ticket' });

            const actionRow = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`ticket_action_${ticketChannel.id}`)
                    .setPlaceholder('Ticket actions...')
                    .addOptions([
                        { label: 'Close Ticket', value: 'close', emoji: '🔒', description: 'Close and remove access to this ticket' },
                        { label: 'Save Transcript', value: 'transcript', emoji: '📄', description: 'Save a transcript of this ticket' }
                    ])
            );

            await ticketChannel.send({ content: `${adminPings} | <@${interaction.user.id}>`, embeds: [ticketEmbed], components: [actionRow] });
            await interaction.editReply(`✅ Your ticket has been created! Head to <#${ticketChannel.id}>`);
        } catch (err) { console.error(err); await interaction.editReply('❌ Failed to create ticket. Please contact an administrator.'); }
    }

    // Ticket action
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket_action_')) {
        const action = interaction.values[0];
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));

        if (action === 'close') {
            if (!hasRole) {
                await interaction.channel.permissionOverwrites.edit(interaction.user.id, { ViewChannel: false });
                await interaction.reply({ content: '🔒 You have been removed from this ticket. An admin will close it shortly.', flags: 64 });
            } else {
                const confirmRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`confirm_close_${interaction.channel.id}`)
                        .setPlaceholder('Confirm closure...')
                        .addOptions([
                            { label: 'Yes, close ticket', value: 'confirm', emoji: '✅' },
                            { label: 'Cancel', value: 'cancel', emoji: '❌' }
                        ])
                );
                await interaction.reply({ content: '⚠️ Are you sure you want to close this ticket?', components: [confirmRow], flags: 64 });
            }
        }

        if (action === 'transcript') {
            await interaction.deferUpdate();
            await saveTranscript(interaction.channel, client);
            await interaction.channel.send('✅ Transcript saved!');
        }
    }

    // Confirm close
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('confirm_close_')) {
        const action = interaction.values[0];
        if (action === 'confirm') {
            await interaction.deferUpdate();
            const embed = new EmbedBuilder()
                .setTitle('🔒 Ticket Closed')
                .setColor(0xFF0000)
                .setDescription(`Closed by <@${interaction.user.id}>`)
                .setTimestamp();
            await interaction.channel.send({ embeds: [embed] });
            await interaction.channel.permissionOverwrites.set([{ id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] }]);
        } else {
            await interaction.deferUpdate();
        }
    }

    // /close
    if (interaction.isChatInputCommand() && interaction.commandName === 'close') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) {
            await interaction.channel.permissionOverwrites.edit(interaction.user.id, { ViewChannel: false });
            await interaction.reply({ content: '🔒 You have been removed from this ticket.', flags: 64 });
        } else {
            const embed = new EmbedBuilder().setTitle('🔒 Ticket Closed').setColor(0xFF0000).setDescription(`Closed by <@${interaction.user.id}>`).setTimestamp();
            await interaction.reply({ embeds: [embed] });
            await interaction.channel.permissionOverwrites.set([{ id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] }]);
        }
    }

    // /transcript
    if (interaction.isChatInputCommand() && interaction.commandName === 'transcript') {
        await interaction.deferReply();
        await saveTranscript(interaction.channel, client);
        await interaction.editReply('✅ Transcript saved!');
    }

    // /add
    if (interaction.isChatInputCommand() && interaction.commandName === 'add') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ Only admins can add users to tickets!', flags: 64 }); return; }
        const user = interaction.options.getUser('user');
        await interaction.deferReply();
        try {
            await interaction.channel.permissionOverwrites.create(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
            const embed = new EmbedBuilder().setTitle('👤 User Added').setColor(0x00FF00)
                .addFields({ name: '👤 Added', value: `<@${user.id}>`, inline: true }, { name: '🛡️ By', value: `<@${interaction.user.id}>`, inline: true }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Failed to add user.'); }
    }

    // /remove
    if (interaction.isChatInputCommand() && interaction.commandName === 'remove') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ Only admins can remove users from tickets!', flags: 64 }); return; }
        const user = interaction.options.getUser('user');
        await interaction.deferReply();
        try {
            await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: false });
            const embed = new EmbedBuilder().setTitle('👤 User Removed').setColor(0xFF0000)
                .addFields({ name: '👤 Removed', value: `<@${user.id}>`, inline: true }, { name: '🛡️ By', value: `<@${interaction.user.id}>`, inline: true }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        } catch (err) { console.error(err); await interaction.editReply('❌ Failed to remove user.'); }
    }

    // /rename
    if (interaction.isChatInputCommand() && interaction.commandName === 'rename') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ Only admins can rename ticket channels!', flags: 64 }); return; }
        const name = interaction.options.getString('name').toLowerCase().replace(/[^a-z0-9-]/g, '-');
        await interaction.deferReply();
        try {
            await interaction.channel.setName(name);
            await interaction.editReply(`✅ Channel renamed to **${name}**`);
        } catch (err) { console.error(err); await interaction.editReply('❌ Failed to rename channel.'); }
    }

    // /claim
    if (interaction.isChatInputCommand() && interaction.commandName === 'claim') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ Only admins can claim tickets!', flags: 64 }); return; }
        await interaction.reply({
            embeds: [new EmbedBuilder().setTitle('✋ Ticket Claimed').setColor(0x00FF00)
                .setDescription(`This ticket has been claimed by <@${interaction.user.id}>`).setTimestamp()]
        });
    }

    // /unclaim
    if (interaction.isChatInputCommand() && interaction.commandName === 'unclaim') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(r => interaction.member.roles.cache.has(r));
        if (!hasRole) { await interaction.reply({ content: '❌ Only admins can unclaim tickets!', flags: 64 }); return; }
        await interaction.reply({
            embeds: [new EmbedBuilder().setTitle('✋ Ticket Unclaimed').setColor(0xFFAA00)
                .setDescription(`<@${interaction.user.id}> has unclaimed this ticket. It is now open for any staff member.`).setTimestamp()]
        });
    }
});

client.login(process.env.DISCORD_TOKEN);