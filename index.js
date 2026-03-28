require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fetch = require('node-fetch');

const TITLE_ID = process.env.PLAYFAB_TITLE_ID;
const SECRET_KEY = process.env.PLAYFAB_SECRET_KEY;
const CLICKER_ROLE_ID = '1485379012019748997';
const CLICK_CHANNEL_ID = '1474902393844924434';
const REPORT_CHANNEL_ID = '1474902394310754333';
const BAN_ALLOWED_ROLES = ['1474902392825712797', '1474902392825712796', '1474902392825712795'];

const cooldowns = new Map();

const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
]});

async function callCloudScript(playFabId, functionName, params) {
    const response = await fetch(
        `https://${TITLE_ID}.playfabapi.com/Server/ExecuteCloudScript`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-SecretKey': SECRET_KEY
            },
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

client.once('ready', async () => {
    const commands = [
        new SlashCommandBuilder()
            .setName('user')
            .setDescription('Look up a player by their short code')
            .addStringOption(opt =>
                opt.setName('code')
                    .setDescription('The 6 character player code')
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('link')
            .setDescription('Link your PlayFab account to Discord')
            .addStringOption(opt =>
                opt.setName('playfabid')
                    .setDescription('Your PlayFab ID')
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('unlink')
            .setDescription('Unlink your PlayFab account from Discord'),
        new SlashCommandBuilder()
            .setName('click')
            .setDescription('Check your click count and progress to 100,000!'),
        new SlashCommandBuilder()
            .setName('motd')
            .setDescription('Set the in-game Message of the Day')
            .addStringOption(opt =>
                opt.setName('message')
                    .setDescription('The message to display in game')
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('report')
            .setDescription('Report a player'),
        new SlashCommandBuilder()
            .setName('ban')
            .setDescription('Ban a player from the game')
            .addStringOption(opt =>
                opt.setName('shortcode')
                    .setDescription('The 6 digit code shown under the players name in game')
                    .setRequired(true))
            .addStringOption(opt =>
                opt.setName('reason')
                    .setDescription('Reason for the ban')
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('unban')
            .setDescription('Unban a player from the game')
            .addStringOption(opt =>
                opt.setName('shortcode')
                    .setDescription('The 6 digit code shown under the players name in game')
                    .setRequired(true))
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

    console.log(`Bot ready! Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {

    // /user
    if (interaction.isChatInputCommand() && interaction.commandName === 'user') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(roleId => interaction.member.roles.cache.has(roleId));
        if (!hasRole) {
            await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
            return;
        }
        const code = interaction.options.getString('code').toUpperCase();
        await interaction.deferReply();
        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode: code });
            if (result.found) {
                await interaction.editReply(
                    `✅ **Player Found**\n` +
                    `**Short Code:** \`${code}\`\n` +
                    `**Display Name:** ${result.displayName || 'None set'}\n` +
                    `**PlayFab ID:** \`${result.playFabId}\``
                );
            } else {
                await interaction.editReply(`❌ No player found with code \`${code}\``);
            }
        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ Something went wrong.');
        }
    }

    // /link
    if (interaction.isChatInputCommand() && interaction.commandName === 'link') {
        const playFabId = interaction.options.getString('playfabid').trim();
        await interaction.deferReply({ ephemeral: true });
        try {
            const validate = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'ValidatePlayFabId', { playFabId });
            if (!validate.valid) {
                await interaction.editReply('❌ That PlayFab ID does not exist. Please check and try again.');
                return;
            }
            await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LinkDiscord', { discordId: interaction.user.id, playFabId });
            await interaction.editReply(`✅ Linked as **${validate.displayName || playFabId}**! Use **/click** to check your count!`);
        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ Something went wrong.');
        }
    }

    // /unlink
    if (interaction.isChatInputCommand() && interaction.commandName === 'unlink') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'UnlinkDiscord', { discordId: interaction.user.id });
            if (result.success) {
                await interaction.editReply('✅ Your PlayFab account has been unlinked!');
            } else {
                await interaction.editReply('❌ You don\'t have a linked account to unlink!');
            }
        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ Something went wrong.');
        }
    }

    // /click
    if (interaction.isChatInputCommand() && interaction.commandName === 'click') {
        if (interaction.channelId !== CLICK_CHANNEL_ID) {
            await interaction.reply({ content: `❌ This command can only be used in <#${CLICK_CHANNEL_ID}>!`, ephemeral: true });
            return;
        }
        const now = Date.now();
        const cooldownAmount = 10 * 1000;
        if (cooldowns.has(interaction.user.id)) {
            const expiresAt = cooldowns.get(interaction.user.id);
            if (now < expiresAt) {
                const secondsLeft = ((expiresAt - now) / 1000).toFixed(1);
                await interaction.reply({ content: `⏳ Please wait **${secondsLeft}s** before using /click again!`, ephemeral: true });
                return;
            }
        }
        cooldowns.set(interaction.user.id, now + cooldownAmount);
        await interaction.deferReply();
        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetClickCount', { discordId: interaction.user.id });
            if (!result.found) {
                await interaction.editReply('❌ You have not linked your PlayFab account yet! Use **/link <your PlayFab ID>** first.');
                return;
            }
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
        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ Something went wrong.');
        }
    }

    // /motd
    if (interaction.isChatInputCommand() && interaction.commandName === 'motd') {
        const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
        const hasRole = adminRoleIds.some(roleId => interaction.member.roles.cache.has(roleId));
        if (!hasRole) {
            await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
            return;
        }
        const message = interaction.options.getString('message');
        await interaction.deferReply();
        try {
            const response = await fetch(
                `https://${TITLE_ID}.playfabapi.com/Server/SetTitleData`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-SecretKey': SECRET_KEY },
                    body: JSON.stringify({ Key: 'MOTD', Value: message })
                }
            );
            const data = await response.json();
            if (data.code === 200) {
                await interaction.editReply(`✅ **MOTD Updated!**\n> ${message}`);
            } else {
                await interaction.editReply('❌ Failed to update MOTD.');
            }
        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ Something went wrong.');
        }
    }

    // /report - show dropdown
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
        await interaction.reply({ content: '📋 **What are you reporting this player for?**', components: [row], ephemeral: true });
    }

    // Report dropdown selected
    if (interaction.isStringSelectMenu() && interaction.customId === 'report_type') {
        const selectedReason = interaction.values[0];
        const modal = new ModalBuilder()
            .setCustomId(`report_modal_${selectedReason}`)
            .setTitle(`Report: ${selectedReason}`);

        const shortCodeInput = new TextInputBuilder()
            .setCustomId('short_code')
            .setLabel('Player\'s 6 digit ID (shown under their name)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. 8E4036')
            .setMinLength(6)
            .setMaxLength(6)
            .setRequired(true);

        const detailsInput = new TextInputBuilder()
            .setCustomId('details')
            .setLabel('Describe what happened')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Please describe the situation in detail...')
            .setRequired(true);

        const additionalInput = new TextInputBuilder()
            .setCustomId('additional')
            .setLabel('Additional Info (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Any extra info, timestamps, witnesses etc...')
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(shortCodeInput),
            new ActionRowBuilder().addComponents(detailsInput),
            new ActionRowBuilder().addComponents(additionalInput)
        );
        await interaction.showModal(modal);
    }

    // Report modal submitted
    if (interaction.isModalSubmit() && interaction.customId.startsWith('report_modal_')) {
        const reason = interaction.customId.replace('report_modal_', '');
        const shortCode = interaction.fields.getTextInputValue('short_code').trim().toUpperCase();
        const details = interaction.fields.getTextInputValue('details');
        const additional = interaction.fields.getTextInputValue('additional') || 'None provided';

        await interaction.deferReply({ ephemeral: true });

        try {
            // Validate short code
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });

            if (!result.found) {
                await interaction.editReply('❌ That ID code is invalid. Make sure you copied the 6 digit yellow code shown under their name!');
                return;
            }

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
        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ Something went wrong while submitting your report.');
        }
    }

    // /ban - show duration dropdown
    if (interaction.isChatInputCommand() && interaction.commandName === 'ban') {
        const hasBanRole = BAN_ALLOWED_ROLES.some(roleId => interaction.member.roles.cache.has(roleId));
        if (!hasBanRole) {
            await interaction.reply({ content: '❌ You do not have permission to ban players.', ephemeral: true });
            return;
        }

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

        await interaction.reply({ content: `⏱️ **Select ban duration for \`${shortCode}\`:**`, components: [row], ephemeral: true });
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

            if (!result.found) {
                await interaction.editReply({ content: '❌ That short code does not exist.', components: [] });
                return;
            }

            await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'BanPlayer', {
                playFabId: result.playFabId,
                reason,
                durationInHours: duration.hours
            });

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
        } catch (err) {
            console.error(err);
            await interaction.editReply({ content: '❌ Something went wrong while banning the player.', components: [] });
        }
    }

    // /unban
    if (interaction.isChatInputCommand() && interaction.commandName === 'unban') {
        const hasBanRole = BAN_ALLOWED_ROLES.some(roleId => interaction.member.roles.cache.has(roleId));
        if (!hasBanRole) {
            await interaction.reply({ content: '❌ You do not have permission to unban players.', ephemeral: true });
            return;
        }

        const shortCode = interaction.options.getString('shortcode').trim().toUpperCase();
        await interaction.deferReply();

        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LookupByShortCode', { shortCode });

            if (!result.found) {
                await interaction.editReply('❌ That short code does not exist.');
                return;
            }

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
        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ Something went wrong while unbanning the player.');
        }
    }
});

function generateProgressBar(current, goal) {
    const filled = Math.round((current / goal) * 20);
    const empty = 20 - filled;
    return '🟦'.repeat(filled) + '⬜'.repeat(empty);
}

client.login(process.env.DISCORD_TOKEN);