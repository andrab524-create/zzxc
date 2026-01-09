require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    WebhookClient,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    SlashCommandBuilder,
    PermissionFlagsBits,
    Collection
} = require('discord.js');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp({
    credential: admin.credential.cert(require('./serviceAccount.json'))
});
const db = admin.firestore();

// Cache sederhana untuk user keys (expire tiap 2 menit)
const userKeyCache = new Collection();
const cooldowns = new Collection();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ],
    partials: ['CHANNEL']
});

const PREFIX = "!";
const WEBHOOK_URL = process.env.WEBHOOK;
const webhook = WEBHOOK_URL ? new WebhookClient({ url: WEBHOOK_URL }) : null;
const KEY_PREFIX = "VORAHUB";
const SCRIPT_URL = "https://raw.githubusercontent.com/Zxcp98/zx/refs/heads/main/loader.lua";
const PREMIUM_ROLE_ID = "1434842978932752405";
const STAFF_ROLE_ID = "1452500424551567360";
const WHITELIST_SCRIPT_LINK = "https://discord.com/channels/1434540370284384338/1434755316808941718/1452153375260020888";

let latestPanelMessageId = null;
let latestPanelChannelId = null;

// Optimasi generate key (fast + top-level crypto)
function generateKey() {
    const bytes = crypto.randomBytes(9); // 9 bytes → 18 hex chars → 3 grup 6 chars
    return `${KEY_PREFIX}-${bytes.toString('hex').toUpperCase().match(/.{1,6}/g).join('-')}`;
}

// Helper: dapatkan key aktif user dari cache atau Firestore
// Helper: dapatkan key aktif user dari cache atau Firestore
async function getUserActiveKeys(userId, discordTag) {
    const cached = userKeyCache.get(userId);
    if (cached && cached.expires > Date.now()) {
        return cached.keys;
    }

    const [snapshotId, snapshotTag] = await Promise.all([
        db.collection('keys').where('userId', '==', userId).get(),
        db.collection('keys').where('usedByDiscord', '==', discordTag).get()
    ]);

    const keys = new Set();
    const batch = db.batch();
    let batchCount = 0;

    snapshotId.forEach(doc => keys.add(doc.id));

    snapshotTag.forEach(doc => {
        keys.add(doc.id);
        const data = doc.data();
        // Auto-migration: If key found by tag but missing userId, add userId.
        if (!data.userId) {
            batch.update(doc.ref, { userId: userId });
            batchCount++;
        }
    });

    if (batchCount > 0) {
        // Run migration in background without blocking return
        batch.commit().catch(e => console.error("Auto-migration failed:", e));
    }

    const result = Array.from(keys);

    userKeyCache.set(userId, {
        keys: result,
        expires: Date.now() + 120000 // 2 menit
    });

    return result;
}

// Log action (tetap sama, tapi lebih ringkas)
async function logAction(title, executorTag, target, action, extra = "") {
    if (!webhook) return;
    const embed = new EmbedBuilder()
        .setTitle(title)
        .addFields(
            { name: "Executor", value: executorTag, inline: true },
            { name: "Target", value: target || "-", inline: true },
            { name: "Action", value: action, inline: true },
            { name: "Extra", value: extra || "-", inline: true },
            { name: "Time", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
        )
        .setColor(
            /Redeem/i.test(action) ? "#00ffff" :
                /Reset/i.test(action) ? "#ffa500" :
                    /Script/i.test(action) ? "#ff00ff" :
                        /Role/i.test(action) ? "#ffff00" :
                            /Add/i.test(action) ? "#00ff00" :
                                "#ff0000"
        )
        .setTimestamp();

    try {
        await webhook.send({ embeds: [embed] });
    } catch (err) {
        console.error("Webhook error:", err);
    }
}

// Safe reply helper to avoid "already replied" errors
async function safeReply(interaction, opts) {
    try {
        const options = typeof opts === 'string' ? { content: opts, ephemeral: true } : opts;
        if (!interaction.deferred && !interaction.replied) return await interaction.reply(options);
        if (interaction.deferred && !interaction.replied) return await interaction.editReply(options);
        return await interaction.followUp(Object.assign({ ephemeral: true }, options));
    } catch (err) {
        console.error('Reply error:', err);
        try { await interaction.followUp({ content: 'Terjadi error saat mengirim pesan.', ephemeral: true }); } catch (e) { }
    }
}

// Global error handlers
process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
    if (webhook) webhook.send({ content: `Unhandled Rejection: ${String(reason)}` }).catch(() => { });
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    if (webhook) webhook.send({ content: `Uncaught Exception: ${err.message}` }).catch(() => { });
});

client.on('error', (err) => console.error('Client error:', err));
client.on('shardError', (err) => console.error('Shard error:', err));

client.once('ready', async () => {
    console.log(`Bot ${client.user.tag} online & optimized!`);
    client.user.setActivity('Vorahub On Top', { type: 4 });

    const commands = [
        new SlashCommandBuilder()
            .setName('whitelist')
            .setDescription('Kelola whitelist + auto generate key')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommand(sub => sub
                .setName('add')
                .setDescription('Tambah user ke whitelist')
                .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('remove')
                .setDescription('Hapus user dari whitelist')
                .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('bulkremove')
                .setDescription('Hapus beberapa user sekaligus dari whitelist')
                .addStringOption(opt => opt.setName('userids').setDescription('User IDs dipisah koma (contoh: 123,456,789)').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('clear')
                .setDescription('Hapus SEMUA whitelist (HATI-HATI!)')
            )
            .addSubcommand(sub => sub
                .setName('list')
                .setDescription('Lihat daftar whitelist')
            )
            .addSubcommand(sub => sub
                .setName('search')
                .setDescription('Cari user di whitelist')
                .addStringOption(opt => opt.setName('query').setDescription('Username atau User ID').setRequired(true))
            )
    ];

    await client.application.commands.set(commands);
    console.log("Slash commands registered!");
});

// =============== SATU INTERACTION HANDLER SAJA (lebih cepat) ===============
client.on('interactionCreate', async (interaction) => {
    try {
        // Slash Command: /whitelist
        if (interaction.isChatInputCommand() && interaction.commandName === 'whitelist') {
            if (!interaction.member.roles.cache.has(STAFF_ROLE_ID)) {
                return interaction.reply({ content: "Hanya staff dengan role khusus!", ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });
            const sub = interaction.options.getSubcommand();

            if (sub === 'add') {
                const targetUser = interaction.options.getUser('user');
                const targetTag = targetUser.tag;
                const whitelistRef = db.collection('whitelist').doc(targetUser.id);

                if ((await whitelistRef.get()).exists) {
                    return interaction.editReply({ content: `${targetTag} sudah di whitelist!` });
                }

                const newKey = generateKey();
                const batch = db.batch();

                batch.set(db.collection('keys').doc(newKey), {
                    used: false,
                    alreadyRedeem: true,
                    userId: targetUser.id,
                    hwid: "",
                    usedAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt: null,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    whitelisted: true
                });

                batch.set(whitelistRef, {
                    userId: targetUser.id,
                    discordTag: targetTag,
                    key: newKey,
                    addedBy: interaction.user.tag,
                    addedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                await batch.commit();

                await logAction("WHITELIST + KEY", interaction.user.tag, targetTag, "Whitelist Add", `Key: ${newKey}`);

                // Auto role
                if (interaction.guild) {
                    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
                    if (member && !member.roles.cache.has(PREMIUM_ROLE_ID)) {
                        await member.roles.add(PREMIUM_ROLE_ID);
                        await logAction("ROLE DIBERIKAN", interaction.user.tag, targetTag, "Auto Role (Whitelist)");
                    }
                }

                await interaction.channel.send(`<@${targetUser.id}> You have been whitelisted! You can access the script via this message -->${WHITELIST_SCRIPT_LINK}`);
                return interaction.editReply({ content: `Sukses whitelist ${targetTag} + role otomatis jika ada di server.` });
            }

            if (sub === 'remove') {
                const targetUser = interaction.options.getUser('user');
                const targetTag = targetUser.tag;
                const userId = targetUser.id;

                // Check by User ID first
                let doc = await db.collection('whitelist').doc(userId).get();

                // If not found by User ID, search by discordTag (for legacy entries)
                if (!doc.exists) {
                    const snapshot = await db.collection('whitelist')
                        .where('discordTag', '==', targetTag)
                        .limit(1)
                        .get();

                    if (!snapshot.empty) {
                        doc = snapshot.docs[0];
                        // Found by tag, now delete it
                        await doc.ref.delete();
                        await logAction("WHITELIST REMOVE", interaction.user.tag, targetTag, "Remove (by tag)", `Old ID: ${doc.id}`);
                        return interaction.editReply({ content: `✅ Berhasil hapus ${targetTag} dari whitelist (ditemukan via username).` });
                    }

                    // Still not found, search by userId field
                    const snapshotById = await db.collection('whitelist')
                        .where('userId', '==', userId)
                        .limit(1)
                        .get();

                    if (!snapshotById.empty) {
                        doc = snapshotById.docs[0];
                        await doc.ref.delete();
                        await logAction("WHITELIST REMOVE", interaction.user.tag, targetTag, "Remove (by userId field)");
                        return interaction.editReply({ content: `✅ Berhasil hapus ${targetTag} dari whitelist.` });
                    }

                    // Truly not found
                    return interaction.editReply({
                        content: `❌ ${targetTag} (ID: ${userId}) tidak ditemukan di whitelist!\n\nGunakan \`/whitelist search ${targetTag}\` untuk mencari atau \`/whitelist list\` untuk melihat semua.`
                    });
                }

                // Found by User ID, delete normally
                await doc.ref.delete();
                await logAction("WHITELIST REMOVE", interaction.user.tag, targetTag, "Remove");
                return interaction.editReply({ content: `✅ Berhasil hapus ${targetTag} dari whitelist.` });
            }

            if (sub === 'bulkremove') {
                const userIdsInput = interaction.options.getString('userids');
                const userIds = userIdsInput.split(',').map(id => id.trim()).filter(id => id.length > 0);

                if (userIds.length === 0) {
                    return interaction.editReply({ content: "Format salah! Masukkan User IDs dipisah koma." });
                }

                const batch = db.batch();
                const removed = [];
                const notFound = [];

                for (const userId of userIds) {
                    const doc = await db.collection('whitelist').doc(userId).get();
                    if (doc.exists) {
                        batch.delete(doc.ref);
                        removed.push(`${doc.data().discordTag || userId}`);
                    } else {
                        notFound.push(userId);
                    }
                }

                if (removed.length > 0) {
                    await batch.commit();
                    await logAction("BULK WHITELIST REMOVE", interaction.user.tag, removed.join(', '), "Bulk Remove", `Total: ${removed.length}`);
                }

                let response = '';
                if (removed.length > 0) response += `✅ Berhasil hapus ${removed.length} user:\n${removed.join(', ')}\n\n`;
                if (notFound.length > 0) response += `❌ Tidak ditemukan (${notFound.length}): ${notFound.join(', ')}`;

                return interaction.editReply({ content: response || "Tidak ada yang dihapus." });
            }

            if (sub === 'clear') {
                const snapshot = await db.collection('whitelist').get();
                if (snapshot.empty) return interaction.editReply({ content: "Whitelist sudah kosong!" });

                const confirmEmbed = new EmbedBuilder()
                    .setTitle("⚠️ KONFIRMASI HAPUS SEMUA WHITELIST")
                    .setDescription(`Kamu akan menghapus **${snapshot.size}** user dari whitelist!\n\nKetik \`CONFIRM DELETE ALL\` untuk melanjutkan atau tunggu 30 detik untuk batal.`)
                    .setColor("#ff0000")
                    .setTimestamp();

                await interaction.editReply({ embeds: [confirmEmbed] });

                const filter = m => m.author.id === interaction.user.id && m.content === 'CONFIRM DELETE ALL';
                const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] }).catch(() => null);

                if (!collected) {
                    return interaction.followUp({ content: "❌ Waktu habis. Pembatalan clear whitelist.", ephemeral: true });
                }

                const batch = db.batch();
                snapshot.docs.forEach(doc => batch.delete(doc.ref));
                await batch.commit();

                await logAction("CLEAR ALL WHITELIST", interaction.user.tag, "ALL USERS", "Clear Whitelist", `Total: ${snapshot.size}`);
                await collected.first().delete().catch(() => { });
                return interaction.followUp({ content: `✅ Berhasil menghapus ${snapshot.size} user dari whitelist.`, ephemeral: true });
            }

            if (sub === 'search') {
                const query = interaction.options.getString('query').toLowerCase();
                const snapshot = await db.collection('whitelist').get();

                if (snapshot.empty) return interaction.editReply({ content: "Whitelist kosong!" });

                const results = snapshot.docs.filter(doc => {
                    const data = doc.data();
                    return doc.id.toLowerCase().includes(query) ||
                        (data.discordTag && data.discordTag.toLowerCase().includes(query)) ||
                        (data.key && data.key.toLowerCase().includes(query));
                });

                if (results.length === 0) {
                    return interaction.editReply({ content: `Tidak ditemukan user dengan query: "${query}"` });
                }

                const list = results.map(doc => {
                    const d = doc.data();
                    return `• **${d.discordTag}** (ID: ${doc.id})\n  Key: \`${d.key || "No Key"}\`\n  Added by: ${d.addedBy || "Unknown"}`;
                }).join('\n\n');

                const embed = new EmbedBuilder()
                    .setTitle(`🔍 Hasil Pencarian: "${query}"`)
                    .setDescription(list)
                    .setColor("#00ff00")
                    .setFooter({ text: `Ditemukan: ${results.length} user` })
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            }

            if (sub === 'list') {
                const snapshot = await db.collection('whitelist').get();
                if (snapshot.empty) return interaction.editReply({ content: "Whitelist kosong!" });

                const list = snapshot.docs.map(doc => {
                    const d = doc.data();
                    return `• **${d.discordTag}** → \`${d.key || "No Key"}\``;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setTitle("WHITELIST LIST")
                    .setDescription(list || "Kosong")
                    .setColor("#7289da")
                    .setFooter({ text: `Total: ${snapshot.size}` })
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            }
        }

        // Button / Modal / Select Menu
        if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
            const userId = interaction.user.id;
            const discordTag = interaction.user.tag;

            // Cooldown 5 detik per user
            const now = Date.now();
            const userCooldown = cooldowns.get(userId);
            if (userCooldown && now < userCooldown) {
                return interaction.reply({ content: `Tunggu ${Math.ceil((userCooldown - now) / 1000)} detik sebelum pakai lagi!`, ephemeral: true });
            }
            cooldowns.set(userId, now + 5000);


            // Redeem Modal Show
            if (interaction.customId === "redeem_modal") {
                const modal = new ModalBuilder()
                    .setCustomId("redeem_submit")
                    .setTitle("Redeem Key");

                const input = new TextInputBuilder()
                    .setCustomId("key_input")
                    .setLabel("Masukkan Key")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("VORAHUB-ABCDEF-123456")
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            // Redeem Submit
            if (interaction.customId === "redeem_submit") {
                await interaction.deferReply({ ephemeral: true });
                const inputKey = interaction.fields.getTextInputValue('key_input').trim().toUpperCase();
                if (!inputKey.startsWith(KEY_PREFIX + "-")) {
                    return interaction.editReply({ content: "Format key salah! Harus VORAHUB-XXXXXX-XXXXXX-XXXXXX" });
                }

                const activeDoc = await db.collection('keys').doc(inputKey).get();
                if (activeDoc.exists) {
                    return interaction.editReply({ content: `Key sudah dipakai oleh **${activeDoc.data().userId || "Unknown"}**!` });
                }

                const pendingDoc = await db.collection('generated_keys').doc(inputKey).get();
                if (!pendingDoc.exists) {
                    return interaction.editReply({ content: "Key tidak valid atau sudah kadaluarsa!" });
                }

                const pendingData = pendingDoc.data();
                const isPermanent = pendingData.expiresInDays == null;

                const batch = db.batch();
                batch.set(db.collection('keys').doc(inputKey), {
                    used: false,
                    alreadyRedeem: true,
                    userId: userId,
                    hwid: "",
                    usedAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresAt: isPermanent ? null : admin.firestore.Timestamp.fromMillis(Date.now() + (pendingData.expiresInDays * 86400000)),
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                batch.delete(pendingDoc.ref);
                await batch.commit();

                await logAction("KEY REDEEMED", discordTag, inputKey, "Redeem", `Permanent: ${isPermanent}`);

                // Auto role
                if (interaction.guild) {
                    const member = await interaction.guild.members.fetch(userId).catch(() => null);
                    if (member && !member.roles.cache.has(PREMIUM_ROLE_ID)) {
                        await member.roles.add(PREMIUM_ROLE_ID);
                        await logAction("ROLE DIBERIKAN", discordTag, "Premium", "Auto Redeem");
                    }
                }

                userKeyCache.delete(userId); // invalidate cache
                return interaction.editReply({
                    content: `Key \`${inputKey}\` berhasil diredeem!\nKamu sekarang bisa pakai semua fitur panel.\nRole Premium otomatis diberikan jika kamu di server.`
                });
            }

            // Get Role
            if (interaction.customId === "getrole_start") {
                await interaction.deferReply({ ephemeral: true });
                if (!interaction.guild) return interaction.editReply({ content: "Fitur ini hanya bisa dipakai di server." });
                const keys = await getUserActiveKeys(userId, discordTag);
                if (keys.length === 0) return interaction.editReply({ content: "Kamu belum punya key aktif!" });

                const member = await interaction.guild.members.fetch(userId).catch(() => null);
                if (!member) return interaction.editReply({ content: "Gagal menemukan member di server." });
                if (member.roles.cache.has(PREMIUM_ROLE_ID)) {
                    return interaction.editReply({ content: "Kamu sudah punya role Premium!" });
                }

                await member.roles.add(PREMIUM_ROLE_ID);
                await logAction("ROLE DIBERIKAN", discordTag, "Premium", "Manual Get Role");
                return interaction.editReply({ content: "Role Premium berhasil diberikan!" });
            }

            // Get Script
            if (interaction.customId === "getscript_start") {
                await interaction.deferReply({ ephemeral: true });
                const keys = await getUserActiveKeys(userId, discordTag);
                if (keys.length === 0) return interaction.editReply({ content: "Kamu belum punya key aktif!" });

                if (keys.length === 1) {
                    const script = `_G.script_key = "${keys[0]}"\nloadstring(game:HttpGet("${SCRIPT_URL}"))()`;
                    await logAction("SCRIPT DIAMBIL", discordTag, keys[0], "Get Script");
                    return interaction.editReply({ content: "**Script:**\n```lua\n" + script + "\n```" });
                }

                const select = new StringSelectMenuBuilder()
                    .setCustomId("getscript_select")
                    .setPlaceholder("Pilih key")
                    .addOptions(keys.map(k => ({ label: k.substring(0, 25), value: k })));

                return interaction.editReply({
                    content: "Kamu punya beberapa key. Pilih satu untuk script:",
                    components: [new ActionRowBuilder().addComponents(select)]
                });
            }

            if (interaction.customId === "getscript_select") {
                await interaction.deferReply({ ephemeral: true });
                const key = interaction.values[0];
                const script = `_G.script_key = "${key}"\nloadstring(game:HttpGet("${SCRIPT_URL}"))()`;
                await logAction("SCRIPT DIAMBIL", discordTag, key, "Get Script (Select)");
                return interaction.editReply({
                    content: "**Script:**\n```lua\n" + script + "\n```",
                    components: []
                });
            }

            // Reset HWID
            if (interaction.customId === "reset_start") {
                await interaction.deferReply({ ephemeral: true });
                const keys = await getUserActiveKeys(userId, discordTag);
                if (keys.length === 0) return interaction.editReply({ content: "Kamu belum punya key aktif!" });

                if (keys.length === 1) {
                    await db.collection('keys').doc(keys[0]).update({ hwid: "", used: false });
                    await logAction("HWID RESET", discordTag, keys[0], "Reset HWID");
                    return interaction.editReply({ content: `HWID untuk key \`${keys[0]}\` telah direset.` });
                }

                const select = new StringSelectMenuBuilder()
                    .setCustomId("reset_select_key")
                    .setPlaceholder("Pilih key untuk reset")
                    .addOptions(keys.map(k => ({ label: k.substring(0, 25), value: k })));

                return interaction.editReply({
                    content: "Pilih key yang ingin direset HWID-nya:",
                    components: [new ActionRowBuilder().addComponents(select)]
                });
            }

            if (interaction.customId === "reset_select_key") {
                await interaction.deferReply({ ephemeral: true });
                const key = interaction.values[0];
                await db.collection('keys').doc(key).update({ hwid: "", used: false });
                await logAction("HWID RESET", discordTag, key, "Reset HWID (Select)");
                return interaction.editReply({ content: `HWID untuk key \`${key}\` telah direset.`, components: [] });
            }
        }
    } catch (error) {
        console.error("Interaction error:", error);
        await safeReply(interaction, { content: "Terjadi error internal.", ephemeral: true });
    }
});

// =============== MESSAGE COMMANDS (tetap cepat) ===============
client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.content.startsWith(PREFIX)) return;

    try {
        const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
        const cmd = args.shift()?.toLowerCase();

        if (!msg.member?.roles.cache.has(STAFF_ROLE_ID)) {
            return msg.reply("Hanya staff dengan role khusus!");
        }

        if (cmd === "panel") {
            const embed = new EmbedBuilder()
                .setTitle("Vorahub Premium Panel")
                .setDescription("This panel is for the project: Vorahub \n\nIf you're a buyer, click on the buttons below to redeem your key, get the script or get your role")
                .setColor("#7289da")
                .setThumbnail(client.user.displayAvatarURL())
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("redeem_modal").setLabel("Redeem Key").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("reset_start").setLabel("Reset HWID").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId("getscript_start").setLabel("Get Script").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("getrole_start").setLabel("Get Role").setStyle(ButtonStyle.Danger)
            );

            const panelMsg = await msg.channel.send({ embeds: [embed], components: [row] });
            latestPanelMessageId = panelMsg.id;
            latestPanelChannelId = msg.channel.id;

            const confirm = await msg.reply("Panel berhasil dibuat!");
            setTimeout(() => confirm.delete().catch(() => { }), 5000);
            return;
        }

        if (cmd === "gen" || cmd === "generate") {
            let jumlah = 1;
            let hari = null;
            let targetUser = msg.mentions.users.first();

            if (args[0]) jumlah = Math.min(parseInt(args[0]) || 1, 100);
            if (args[1] && !isNaN(args[1])) hari = parseInt(args[1]);

            const isPermanent = hari === null || hari <= 0;

            const batch = db.batch();
            const keys = [];

            for (let i = 0; i < jumlah; i++) {
                const key = generateKey();
                keys.push(key);
                batch.set(db.collection('generated_keys').doc(key), {
                    createdBy: msg.author.tag,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    expiresInDays: isPermanent ? null : hari,
                    status: 'pending'
                });
            }

            await batch.commit();

            const embed = new EmbedBuilder()
                .setTitle("KEYS GENERATED (Pending Redeem)")
                .setDescription(`\`\`\`${keys.join("\n")}\`\`\``)
                .addFields(
                    { name: "Total", value: `${keys.length}`, inline: true },
                    { name: "Tipe", value: isPermanent ? "PERMANENT" : `${hari} Hari`, inline: true },
                    { name: "Status", value: "Menunggu redeem", inline: true }
                )
                .setColor("#00ff00")
                .setTimestamp();

            await msg.reply({ embeds: [embed] });

            if (targetUser) {
                targetUser.send({ embeds: [embed] }).then(() => {
                    msg.reply(`Key dikirim ke DM ${targetUser.tag}`);
                }).catch(() => {
                    msg.reply(`Gagal kirim DM ke ${targetUser.tag} (DM ditutup?)`);
                });
            }

            await logAction("KEYS GENERATED", msg.author.tag, targetUser?.tag || "Channel", "Generate", `Jumlah: ${jumlah}, Permanent: ${isPermanent}`);
            return;
        }

        if (cmd === "listpending") {
            const snapshot = await db.collection('generated_keys').get();
            if (snapshot.empty) return msg.reply("Tidak ada key pending.");

            const list = snapshot.docs.map(doc => {
                const d = doc.data();
                const type = d.expiresInDays == null ? "Permanent" : `${d.expiresInDays} hari`;
                return `${doc.id} - oleh ${d.createdBy} (${type})`;
            }).join("\n");

            return msg.reply({ content: "**Pending Keys:**\n```" + list + "```" });
        }
    } catch (err) {
        console.error('Message handler error:', err);
        msg.reply('Terjadi error internal.').catch(() => { });
    }
});

if (!process.env.TOKEN) {
    console.error('Missing TOKEN in environment. Bot will not login.');
} else {
    client.login(process.env.TOKEN).catch(err => console.error('Login error:', err));

}
