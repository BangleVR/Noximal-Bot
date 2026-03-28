require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

const TITLE_ID = process.env.PLAYFAB_TITLE_ID;
const SECRET_KEY = process.env.PLAYFAB_SECRET_KEY;
const CLICKER_ROLE_ID = '1485379012019748997';

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

client.once('ready', async () => {
    const commands = [
        new SlashCommandBuilder()
            .setName('user')
            .setDescription('Look up a player by their short code')
            .addStringOption(opt =>
                opt.setName('code')
                    .setDescription('The 5 character player code e.g. AB992')
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('link')
            .setDescription('Link your PlayFab account to Discord')
            .addStringOption(opt =>
                opt.setName('playfabid')
                    .setDescription('Your PlayFab ID')
                    .setRequired(true)),
        new SlashCommandBuilder()
            .setName('click')
            .setDescription('Check your click count and progress to 100,000!')
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

    console.log(`Bot ready! Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // /user command
    if (interaction.commandName === 'user') {
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

    // /link command
    if (interaction.commandName === 'link') {
        const playFabId = interaction.options.getString('playfabid').trim();
        await interaction.deferReply({ ephemeral: true });

        try {
            await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'LinkDiscord', {
                discordId: interaction.user.id,
                playFabId: playFabId
            });

            await interaction.editReply('✅ Your PlayFab account has been linked! Use **/click** to check your count!');
        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ Something went wrong while linking your account.');
        }
    }

    // /click command
    if (interaction.commandName === 'click') {
        await interaction.deferReply();

        try {
            const result = await callCloudScript(process.env.PLAYFAB_ADMIN_ID, 'GetClickCount', {
                discordId: interaction.user.id
            });

            if (!result.found) {
                await interaction.editReply('❌ You have not linked your PlayFab account yet! Use **/link <your PlayFab ID>** first.');
                return;
            }

            const count = result.clickCount;
            const goal = 100000;
            const progress = Math.min(count / goal * 100, 100).toFixed(1);
            const progressBar = generateProgressBar(count, goal);

            // Give role if they hit 100k
            if (count >= goal) {
                const member = interaction.member;
                if (!member.roles.cache.has(CLICKER_ROLE_ID)) {
                    await member.roles.add(CLICKER_ROLE_ID);
                }
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
});

function generateProgressBar(current, goal) {
    const filled = Math.round((current / goal) * 20);
    const empty = 20 - filled;
    return '🟦'.repeat(filled) + '⬜'.repeat(empty);
}

client.login(process.env.DISCORD_TOKEN);