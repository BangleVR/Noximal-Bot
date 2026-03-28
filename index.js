require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fetch = require('node-fetch');

const TITLE_ID = process.env.PLAYFAB_TITLE_ID;
const SECRET_KEY = process.env.PLAYFAB_SECRET_KEY;

const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
]});

client.once('ready', async () => {
    const commands = [
        new SlashCommandBuilder()
            .setName('user')
            .setDescription('Look up a player by their short code')
            .addStringOption(opt =>
                opt.setName('code')
                    .setDescription('The 5 character player code e.g. AB992')
                    .setRequired(true))
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

    console.log(`Bot ready! Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'user') return;

    // Check admin role
    const adminRoleIds = process.env.ADMIN_ROLE_IDS.split(',');
    const hasRole = adminRoleIds.some(roleId => interaction.member.roles.cache.has(roleId));
    if (!hasRole) {
        await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
        return;
    }

    const code = interaction.options.getString('code').toUpperCase();
    await interaction.deferReply();

    try {
        const response = await fetch(
            `https://${TITLE_ID}.playfabapi.com/Server/ExecuteCloudScript`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-SecretKey': SECRET_KEY
                },
                body: JSON.stringify({
                    PlayFabId: process.env.PLAYFAB_ADMIN_ID,
                    FunctionName: 'LookupByShortCode',
                    FunctionParameter: { shortCode: code },
                    GeneratePlayStreamEvent: false
                })
            }
        );

        const data = await response.json();
        const result = data.data.FunctionResult;

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
        await interaction.editReply('❌ Something went wrong while looking up that player.');
    }
});

client.login(process.env.DISCORD_TOKEN);