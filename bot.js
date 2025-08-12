// ============================================================================
// BOT.JS — DISCORD BOT WITH ONBOARDING ROLES, NICKNAME BADGES, LEVELING (TEXT+VOICE)
// CHANNEL ROUTING + ERROR-ONLY LOGGING + SEPARATE TOPS (TEXT / VOICE)
// + AUTO CHAMPION BADGES (TOP 3 TOTAL) ON NICKNAMES
// REQUIREMENTS: Node 18+, discord.js v14, dotenv, ms, express
// SETUP:
//   npm init -y
//   npm i discord.js dotenv ms express
//   .env => TOKEN=your_bot_token  CLIENT_ID=your_app_id  GUILD_ID=your_dev_guild_id
//   In the Developer Portal: ENABLE "SERVER MEMBERS INTENT". Give the bot: MANAGE ROLES, MANAGE NICKNAMES.
// RUN: node bot.js
// ============================================================================

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import ms from 'ms';
import fs from 'fs';
import express from 'express';

// ============================================================================
// CONFIG & CONSTANTS
// ============================================================================
const NEWBIE_ROLE_NAME = '🐣 Newbie.exe';
const NPC_ROLE_NAME = '🤖 NPC';
const NEWBIE_BADGE = '🐣';
const NPC_BADGE = '🤖';
const NEWBIE_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 14 DAYS

// CHAMPION BADGES (TOTAL TOP 3)
const CHAMP_BADGES = ['🥇', '🥈', '🥉']; // index 0->#1, 1->#2, 2->#3

// CHANNEL ROUTING (EXACT NAMES)
const LOG_CHANNEL_NAME = 'ℹ️᲼𝕃ogs';
const LEVELUP_CHANNEL_NAME = '⬆️᲼𝕃evel⋅up';
const ARRIVAL_CHANNEL_NAME = '✈️᲼𝔸rrival⋅zone';

// LEVELING CONFIG
const MESSAGE_XP = 15; // PER MESSAGE (WITH COOLDOWN)
const VOICE_XP_PER_MIN = 5; // PER MINUTE IN VOICE
const MESSAGE_COOLDOWN_MS = 60 * 1000; // 1 MIN PER USER

// ============================================================================
// PERSISTENCE (JSON FILE DB)
// ============================================================================
const DATA_FILE = './data.json';
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { members: {}, xp: {} }; }
}
let DB = loadData();
// DB SHAPE:
// DB.members: { [guildId:userId]: { joinedAt, newbieSince, originalNick|null, champRank?: 0|1|2|null } }
// DB.xp: { [guildId:userId]: { xp:number, text?:number, voice?:number } }
let saveTimer;
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(DB, null, 2), () => {});
  }, 500);
}

// HELPER: KEY BUILDER
const mkey = (guildId, userId) => `${guildId}:${userId}`;

// ============================================================================
// RUNTIME MAPS
// ============================================================================
const welcomeConfig = new Map(); // GUILDID -> {CHANNELID, MESSAGE} (FALLBACK IF ARRIVAL CHANNEL MISSING)
const goodbyeConfig = new Map(); // GUILDID -> {MESSAGE} (TEMPLATE FOR LOGS)
const tempRoleTimers = new Map(); // USED BY /TEMPROLE
const messageCooldown = new Map(); // KEY -> TIMESTAMP
const voiceActive = new Map(); // GUILDID -> SET(USERID) CURRENTLY IN VC GAINING XP

// ============================================================================
// CHANNEL LOOKUP HELPERS
// ============================================================================
function getTextChannelByName(guild, name) {
  if (!guild) return null;
  const lower = name.toLowerCase();
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name.toLowerCase() === lower
  ) || null;
}
function getLogChannel(guild) { return getTextChannelByName(guild, LOG_CHANNEL_NAME); }
function getLevelUpChannel(guild) { return getTextChannelByName(guild, LEVELUP_CHANNEL_NAME); }
function getArrivalChannel(guild) { return getTextChannelByName(guild, ARRIVAL_CHANNEL_NAME); }

// ============================================================================
// SLASH COMMAND DEFINITIONS
// ============================================================================
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check if the bot is awake.'),

  new SlashCommandBuilder()
    .setName('setwelcome')
    .setDescription('Configure a fallback welcome (used only if the arrival channel is missing).')
    .addChannelOption(opt => opt.setName('channel').setDescription('Welcome channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(opt => opt.setName('message').setDescription('Message (use {user} to mention)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('temprole')
    .setDescription('Give a role to a user for a limited time (e.g., 10m, 2h, 3d).')
    .addUserOption(o => o.setName('user').setDescription('Target member').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role to give').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration like 15m, 2h, 1d').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  new SlashCommandBuilder()
    .setName('goodbye')
    .setDescription('Set/clear the goodbye message template (posted in the logs channel).')
    .addStringOption(o => o.setName('message').setDescription('Leave empty to reset; use {user}').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('See your level and XP (text + voice).')
    .addUserOption(o => o.setName('user').setDescription("See someone else's rank")), 

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top 10 by total XP on this server.'),

  // PUBLIC LEADERBOARDS (TEXT / VOICE)
  new SlashCommandBuilder().setName('toptext').setDescription('Top 10 by text XP on this server.'),
  new SlashCommandBuilder().setName('topvoice').setDescription('Top 10 by voice XP on this server.'),

  // ADMIN: FORCE UPDATE OF CHAMPION BADGES
  new SlashCommandBuilder()
    .setName('refreshtopbadges')
    .setDescription('Recompute and apply nickname badges for Top 3 (total).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

// ============================================================================
// COMMAND REGISTRATION (GUILD-SCOPED FOR DEV)
// ============================================================================
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✔ Slash commands registered');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// ============================================================================
// DISCORD CLIENT
// ============================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  // STARTUP TASKS
  startVoiceTicker();
  startNewbieSweep();
  startChampionSweep();
});

// ============================================================================
// UTILS — ROLE ENSURE + LEVEL MATH
// ============================================================================
async function ensureRole(guild, name) {
  let role = guild.roles.cache.find(r => r.name === name);
  if (!role) {
    role = await guild.roles.create({ name, reason: 'Auto-created by bot' }).catch(() => null);
  }
  return role;
}

function calcLevel(xp) {
  // PROGRESSIVE CURVE: LEVEL N WHEN XP >= 100 * N^1.5
  let n = 0;
  while (100 * Math.pow(n + 1, 1.5) <= xp) n++;
  return n;
}

function xpForNext(level) {
  return Math.ceil(100 * Math.pow(level + 1, 1.5));
}

function ensureXpEntry(key) {
  const e = DB.xp[key] || { xp: 0, text: 0, voice: 0 };
  if (typeof e.text !== 'number') e.text = 0; // MIGRATION SUPPORT
  if (typeof e.voice !== 'number') e.voice = 0; // MIGRATION SUPPORT
  if (typeof e.xp !== 'number') e.xp = (e.text || 0) + (e.voice || 0);
  DB.xp[key] = e;
  return e;
}

// SOURCE: 'text' | 'voice' | undefined
function addXP(guildId, userId, amount, source) {
  const key = mkey(guildId, userId);
  const entry = ensureXpEntry(key);
  const before = entry.xp;
  entry.xp = Math.max(0, before + amount);
  if (source === 'text') entry.text = Math.max(0, (entry.text || 0) + amount);
  else if (source === 'voice') entry.voice = Math.max(0, (entry.voice || 0) + amount);
  DB.xp[key] = entry;
  saveData();
  const lvlBefore = calcLevel(before);
  const lvlAfter = calcLevel(entry.xp);
  return { before: before, after: entry.xp, levelUp: lvlAfter > lvlBefore, newLevel: lvlAfter };
}

// BADGE HELPERS (CHAMP + ROLE)
function stripKnownBadges(name) {
  if (!name) return name;
  let n = name.trim();
  // remove leading badges like "🥇 " or "🤖 "
  n = n.replace(/^((🐣|🤖|🥇|🥈|🥉) )+/u, '');
  // remove trailing badges like " 🥇"
  n = n.replace(/( (🐣|🤖|🥇|🥈|🥉))+$/u, '');
  return n.trim();
}
function getRoleBadge(member) {
  if (member.roles.cache.find(r => r.name === NEWBIE_ROLE_NAME)) return NEWBIE_BADGE;
  if (member.roles.cache.find(r => r.name === NPC_ROLE_NAME)) return NPC_BADGE;
  return null;
}
async function setNickWithBadges(member, champRank /* 0|1|2|null */) {
  // PLACE ROLE BADGE AT START, MEDAL AT END (e.g., "🤖 Username 🥇")
  try {
    const current = member.nickname ?? member.user.globalName ?? member.user.username;
    const base = stripKnownBadges(current);
    const roleBadge = getRoleBadge(member);
    const champBadge = (champRank !== null && champRank !== undefined && champRank >= 0 && champRank <= 2)
      ? CHAMP_BADGES[champRank]
      : null;

    const prefix = roleBadge ? roleBadge + ' ' : '';
    const suffix = champBadge ? ' ' + champBadge : '';
    const finalNick = (prefix + base + suffix).slice(0, 32);
    if (finalNick !== current) await member.setNickname(finalNick).catch(() => {});
  } catch { /* ignore perms/hierarchy issues */ }
}

// ============================================================================
// FEATURE: ONBOARDING (ASSIGN NEWBIE ROLE + BADGE, SEND ARRIVAL MESSAGE)
// ============================================================================
client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;
  const newbieRole = await ensureRole(guild, NEWBIE_ROLE_NAME);
  await ensureRole(guild, NPC_ROLE_NAME); // ENSURE NPC EXISTS FOR LATER

  if (newbieRole) {
    try { await member.roles.add(newbieRole, 'Onboarding Newbie'); } catch {}
  }

  // STORE ORIGINAL NICK + APPLY BADGE
  const key = mkey(guild.id, member.id);
  const originalNick = member.nickname ?? null;
  DB.members[key] = { ...(DB.members[key] || {}), joinedAt: Date.now(), newbieSince: Date.now(), originalNick };
  saveData();

  // PREFIX NICKNAME WITH BADGE (IF POSSIBLE)
  await setNickWithBadges(member, DB.members[key]?.champRank ?? null);

  // ARRIVAL MESSAGE → ARRIVAL CHANNEL; FALLBACK TO /SETWELCOME CONFIG
  const arrival = getArrivalChannel(guild);
  const arrivalMsg = `Welcome to the darkness, {user} — may your stay be pleasantly weird. No unsolicited pings; enjoy the chaos. 🖤`;
  if (arrival) {
    arrival.send({ content: arrivalMsg.replace('{user}', `<@${member.id}>`) }).catch(() => {});
  } else {
    const conf = welcomeConfig.get(guild.id);
    if (conf) {
      const ch = guild.channels.cache.get(conf.channelId);
      if (ch && ch.type === ChannelType.GuildText) {
        const msg = (conf.message || arrivalMsg).replace('{user}', `<@${member.id}>`);
        ch.send({ content: msg }).catch(() => {});
      }
    }
  }
});

// ============================================================================
// FEATURE: SCHEDULED PROMOTION SWEEP (NEWBIE → NPC AFTER 14 DAYS)
// ============================================================================
async function promoteIfDue(guild) {
  const newbieRole = guild.roles.cache.find(r => r.name === NEWBIE_ROLE_NAME);
  const npcRole = guild.roles.cache.find(r => r.name === NPC_ROLE_NAME);
  if (!newbieRole || !npcRole) return;

  const now = Date.now();
  for (const member of (await guild.members.fetch()).values()) {
    const key = mkey(guild.id, member.id);
    const meta = DB.members[key];
    if (!meta || !meta.newbieSince) continue;
    const hasNewbie = member.roles.cache.has(newbieRole.id);
    if (!hasNewbie) continue;

    if (now - meta.newbieSince >= NEWBIE_DURATION_MS) {
      // ROLE SWAP
      try { await member.roles.remove(newbieRole, 'Newbie period ended'); } catch {}
      try { await member.roles.add(npcRole, 'Promoted to NPC'); } catch {}
      // BADGE SWAP (KEEPS CHAMP BADGE IF ANY)
      await setNickWithBadges(member, meta.champRank ?? null);
      // MARK AS PROCESSED
      meta.newbieSince = null;
      DB.members[key] = meta; saveData();

      // ANNOUNCE PROMOTION IN LEVEL-UP CHANNEL (KEEP LOGS CLEAN)
      const lvlCh = getLevelUpChannel(guild);
      lvlCh?.send({ content: `🛡️ Promotion: ${member} → **${NPC_ROLE_NAME}** (Newbie period complete).` }).catch(() => {});
    }
  }
}

function startNewbieSweep() {
  // CHECK EVERY HOUR
  setInterval(async () => {
    for (const [, guild] of client.guilds.cache) {
      await promoteIfDue(guild).catch(() => {});
    }
  }, 60 * 60 * 1000);
}

// ============================================================================
// FEATURE: CHAMPION BADGES — COMPUTE TOP 3 TOTAL & APPLY NICK BADGES
// ============================================================================
function computeTop3Map(guildId) {
  const entries = Object.entries(DB.xp)
    .filter(([k]) => k.startsWith(guildId + ':'))
    .map(([k, v]) => ({ userId: k.split(':')[1], xp: (v?.xp ?? 0) }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 3);
  const map = new Map(); // userId -> champRank (0,1,2)
  entries.forEach((e, i) => map.set(e.userId, i));
  return map;
}

async function updateTopBadges(guild) {
  const champMap = computeTop3Map(guild.id);
  const processed = new Set();

  // APPLY TO CURRENT TOP3
  for (const [userId, rank] of champMap.entries()) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    const key = mkey(guild.id, userId);
    const meta = DB.members[key] || {};
    meta.champRank = rank;
    DB.members[key] = meta; saveData();
    await setNickWithBadges(member, rank);
    processed.add(userId);
  }

  // REMOVE BADGE FROM PREVIOUS CHAMPS WHO DROPPED OUT
  for (const [key, meta] of Object.entries(DB.members)) {
    const [gId, uId] = key.split(':');
    if (gId !== guild.id) continue;
    if (meta && (meta.champRank === 0 || meta.champRank === 1 || meta.champRank === 2) && !processed.has(uId)) {
      // now out of top3
      meta.champRank = null;
      DB.members[key] = meta; saveData();
      const member = await guild.members.fetch(uId).catch(() => null);
      if (member) await setNickWithBadges(member, null);
    }
  }
}

function startChampionSweep() {
  // UPDATE TOP BADGES HOURLY
  setInterval(async () => {
    for (const [, guild] of client.guilds.cache) {
      await updateTopBadges(guild).catch(() => {});
    }
  }, 60 * 60 * 1000);
}

// ============================================================================
// FEATURE: LEVELING — TEXT (MESSAGECREATE WITH COOLDOWN)
// ============================================================================
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const key = mkey(message.guild.id, message.author.id);
  const cdKey = `msg:${key}`;
  const last = messageCooldown.get(cdKey) || 0;
  if (Date.now() - last < MESSAGE_COOLDOWN_MS) return; // COOLDOWN PER USER
  messageCooldown.set(cdKey, Date.now());

  const res = addXP(message.guild.id, message.author.id, MESSAGE_XP, 'text');
  if (res.levelUp) {
    const lvl = res.newLevel;
    const embed = new EmbedBuilder()
      .setTitle('✨ Level Up!')
      .setDescription(`${message.author} just hit **level ${lvl}** — keep it weird.`)
      .setTimestamp(new Date());
    const lvlCh = getLevelUpChannel(message.guild);
    if (lvlCh) lvlCh.send({ embeds: [embed] }).catch(() => {});
  }
});

// ============================================================================
// FEATURE: LEVELING — VOICE (PER-MINUTE TICKER + BASIC AFK FILTER)
// ============================================================================
client.on('voiceStateUpdate', (oldS, newS) => {
  const gid = (newS.guild || oldS.guild).id;
  if (!voiceActive.has(gid)) voiceActive.set(gid, new Set());
  const set = voiceActive.get(gid);

  // LEFT ALL VOICE
  if (!newS.channelId) {
    set.delete(newS.id);
    return;
  }
  // JOINED/MOVED VOICE
  set.add(newS.id);
});

function startVoiceTicker() {
  setInterval(() => {
    for (const [gid, set] of voiceActive.entries()) {
      for (const uid of set) {
        // REQUIRE IN VOICE + NOT SELF-MUTED/DEAFENED
        const guild = client.guilds.cache.get(gid);
        const member = guild?.members.cache.get(uid);
        const vs = member?.voice;
        if (!vs?.channel || vs.selfMute || vs.selfDeaf) continue;
        const res = addXP(gid, uid, VOICE_XP_PER_MIN, 'voice');
        if (res.levelUp) {
          const lvl = res.newLevel;
          const lvlCh = getLevelUpChannel(guild);
          lvlCh?.send({ content: `🎙️ Level Up: ${member} is now **level ${lvl}**.` }).catch(() => {});
        }
      }
    }
  }, 60 * 1000);
}

// ============================================================================
// FEATURE: SLASH COMMAND HANDLER (PING / SETWELCOME / TEMPROLE / GOODBYE / RANK / LEADERBOARD / TOPTEXT / TOPVOICE / REFRESHTOPBADGES)
// ============================================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // COMMAND: /PING
  if (interaction.commandName === 'ping') {
    return void interaction.reply({ content: 'Pong!', ephemeral: true });
  }

  // COMMAND: /SETWELCOME (FALLBACK ONLY)
  if (interaction.commandName === 'setwelcome') {
    const channel = interaction.options.getChannel('channel', true);
    const message = interaction.options.getString('message', true);

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void interaction.reply({ content: 'You need **Manage Server** to do that.', ephemeral: true });
    }

    welcomeConfig.set(interaction.guildId, { channelId: channel.id, message });
    return void interaction.reply({ content: `✅ Fallback welcome set in <#${channel.id}>. (Arrival channel takes priority)`, ephemeral: true });
  }

  // COMMAND: /TEMPROLE
  if (interaction.commandName === 'temprole') {
    const user = interaction.options.getUser('user', true);
    const role = interaction.options.getRole('role', true);
    const durationStr = interaction.options.getString('duration', true);

    const durationMs = ms(durationStr);
    if (!durationMs || durationMs < 10000) {
      return void interaction.reply({ content: 'Invalid duration. Try 15m, 2h, 1d (min ~10s).', ephemeral: true });
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
      return void interaction.reply({ content: 'You need **Manage Roles** to do that.', ephemeral: true });
    }

    const guild = interaction.guild;
    if (!guild) return;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      return void interaction.reply({ content: "I can't find that member.", ephemeral: true });
    }

    const botMember = await guild.members.fetchMe();
    if (botMember.roles.highest.comparePositionTo(role) <= 0) {
      return void interaction.reply({ content: 'My highest role must be **above** the target role.', ephemeral: true });
    }

    await member.roles.add(role).catch(() => {});

    const key = `${guild.id}:${member.id}:${role.id}`;
    if (tempRoleTimers.has(key)) clearTimeout(tempRoleTimers.get(key));
    const timeoutId = setTimeout(async () => {
      try { await member.roles.remove(role); } catch {}
      tempRoleTimers.delete(key);
    }, durationMs);
    tempRoleTimers.set(key, timeoutId);

    return void interaction.reply({ content: `✅ Gave **${role.name}** to ${user} for **${durationStr}**.`, ephemeral: true });
  }

  // COMMAND: /GOODBYE (TEMPLATE FOR LOGS)
  if (interaction.commandName === 'goodbye') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void interaction.reply({ content: 'You need **Manage Server** to do that.', ephemeral: true });
    }

    const message = interaction.options.getString('message');
    if (!message) {
      goodbyeConfig.delete(interaction.guildId);
      return void interaction.reply({ content: '👋 Goodbye template reset to default. (Posted in logs channel)', ephemeral: true });
    }

    goodbyeConfig.set(interaction.guildId, { message });
    return void interaction.reply({ content: '✅ Goodbye template set. (Posted in logs channel)', ephemeral: true });
  }

  // COMMAND: /RANK
  if (interaction.commandName === 'rank') {
    const user = interaction.options.getUser('user') || interaction.user;
    const key = mkey(interaction.guildId, user.id);
    const entry = ensureXpEntry(key);
    const total = entry.xp || 0;
    const txt = entry.text || 0;
    const voc = entry.voice || 0;
    const lvl = calcLevel(total);
    const next = xpForNext(lvl);
    const need = Math.max(0, next - total);
    const embed = new EmbedBuilder()
      .setTitle(`📈 Rank — ${user.username}`)
      .addFields(
        { name: 'Level', value: String(lvl), inline: true },
        { name: 'Total XP', value: `${total} / ${next}`, inline: true },
        { name: 'To next', value: `${need} XP`, inline: true },
        { name: 'Text XP', value: String(txt), inline: true },
        { name: 'Voice XP', value: String(voc), inline: true },
      )
      .setFooter({ text: 'No drama. No cringe. No unsolicited pings.' })
      .setTimestamp(new Date());
    return void interaction.reply({ embeds: [embed] });
  }

  // COMMAND: /LEADERBOARD (TOTAL) — EMBED + MEDALS
  if (interaction.commandName === 'leaderboard') {
    const entries = Object.entries(DB.xp)
      .filter(([k]) => k.startsWith(interaction.guildId + ':'))
      .map(([k, v]) => ({ userId: k.split(':')[1], xp: (v?.xp ?? 0) }))
      .sort((a, b) => b.xp - a.xp)
      .slice(0, 10);

    if (!entries.length) {
      const embed = new EmbedBuilder()
        .setTitle('🏆 Total Leaderboard')
        .setDescription('No leaderboard yet.')
        .setTimestamp(new Date());
      return void interaction.reply({ embeds: [embed] });
    }

    const lines = await Promise.all(entries.map(async (e, i) => {
      const user = await interaction.client.users.fetch(e.userId).catch(() => null);
      const name = user?.tag ?? e.userId;
      const badge = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
      return `**${badge}** — <@${e.userId}> (${name}) — **${e.xp} XP** (lv ${calcLevel(e.xp)})`;
    }));

    const embed = new EmbedBuilder()
      .setTitle('🏆 Total Leaderboard — Top 10')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Grind smart. No spam.' })
      .setTimestamp(new Date());

    return void interaction.reply({ embeds: [embed] });
  }

  // COMMAND: /TOPTEXT (TEXT-ONLY) — EMBED + MEDALS
  if (interaction.commandName === 'toptext') {
    const entries = Object.entries(DB.xp)
      .filter(([k]) => k.startsWith(interaction.guildId + ':'))
      .map(([k, v]) => ({ userId: k.split(':')[1], xp: (v?.text ?? 0) }))
      .sort((a, b) => b.xp - a.xp)
      .slice(0, 10);

    if (!entries.length) {
      const embed = new EmbedBuilder()
        .setTitle('📊 Text Leaderboard')
        .setDescription('No text activity yet.')
        .setTimestamp(new Date());
      return void interaction.reply({ embeds: [embed] });
    }

    const lines = await Promise.all(entries.map(async (e, i) => {
      const user = await interaction.client.users.fetch(e.userId).catch(() => null);
      const name = user?.tag ?? e.userId;
      const badge = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
      return `**${badge}** — <@${e.userId}> (${name}) — **${e.xp} text XP**`;
    }));

    const embed = new EmbedBuilder()
      .setTitle('📊 Text Leaderboard — Top 10')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Chat to climb. No spam.' })
      .setTimestamp(new Date());

    return void interaction.reply({ embeds: [embed] });
  }

  // COMMAND: /TOPVOICE (VOICE-ONLY) — EMBED + MEDALS
  if (interaction.commandName === 'topvoice') {
    const entries = Object.entries(DB.xp)
      .filter(([k]) => k.startsWith(interaction.guildId + ':'))
      .map(([k, v]) => ({ userId: k.split(':')[1], xp: (v?.voice ?? 0) }))
      .sort((a, b) => b.xp - a.xp)
      .slice(0, 10);

    if (!entries.length) {
      const embed = new EmbedBuilder()
        .setTitle('🎙️ Voice Leaderboard')
        .setDescription('No voice activity yet.')
        .setTimestamp(new Date());
      return void interaction.reply({ embeds: [embed] });
    }

    const lines = await Promise.all(entries.map(async (e, i) => {
      const user = await interaction.client.users.fetch(e.userId).catch(() => null);
      const name = user?.tag ?? e.userId;
      const badge = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
      return `**${badge}** — <@${e.userId}> (${name}) — **${e.xp} voice XP**`;
    }));

    const embed = new EmbedBuilder()
      .setTitle('🎙️ Voice Leaderboard — Top 10')
      .setDescription(lines.join('\n'))
      .setFooter({ text: "Hop in VC. Don't idle." })
      .setTimestamp(new Date());

    return void interaction.reply({ embeds: [embed] });
  }

  // COMMAND: /REFRESHTOPBADGES (ADMIN)
  if (interaction.commandName === 'refreshtopbadges') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void interaction.reply({ content: 'You need **Manage Server** to do that.', ephemeral: true });
    }
    await updateTopBadges(interaction.guild);
    return void interaction.reply({ content: '✅ Top badges refreshed.', ephemeral: true });
  }
});

// ============================================================================
// FEATURE: GOODBYE — POST TO LOGS ONLY
// ============================================================================
client.on('guildMemberRemove', async (member) => {
  const guild = member.guild;
  const log = getLogChannel(guild);
  if (!log) return;
  const tpl = goodbyeConfig.get(guild.id)?.message || 'Goodbye {user} — behave out there.';
  const msg = tpl.replace('{user}', member.user?.tag ?? 'someone');
  log.send({ content: `📤 ${msg} (${member.id})` }).catch(() => {});
});

// ============================================================================
// FEATURE: ERROR REPORTING — SEND ONLY ERRORS TO LOGS
// ============================================================================
process.on('unhandledRejection', (err) => {
  for (const [, guild] of client.guilds.cache) {
    getLogChannel(guild)?.send({ content: `⚠️ Unhandled rejection: ${String(err)}` }).catch(() => {});
  }
});
client.on('error', (err) => {
  for (const [, guild] of client.guilds.cache) {
    getLogChannel(guild)?.send({ content: `⚠️ Client error: ${String(err)}` }).catch(() => {});
  }
});
client.on('shardError', (err) => {
  for (const [, guild] of client.guilds.cache) {
    getLogChannel(guild)?.send({ content: `⚠️ Shard error: ${String(err)}` }).catch(() => {});
  }
});

// ============================================================================
// FEATURE: KEEP-ALIVE WEB SERVER (RENDER FREE)
// - Exposes / and /health endpoints so Render Free treats this as a Web Service
// - Optional SELF_PING_URL env var to ping itself (or use UptimeRobot every 5 min)
// ============================================================================
function startWebServer() {
  const app = express();
  const PORT = process.env.PORT || 10000; // Render provides PORT

  app.get('/', (req, res) => {
    res.type('text').send('ok ' + new Date().toISOString());
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime(), guilds: client.guilds.cache.size || 0 });
  });

  app.listen(PORT, () => console.log(`🌐 HTTP server listening on :${PORT}`));

  const SELF_PING_URL = process.env.SELF_PING_URL;
  if (SELF_PING_URL) {
    setInterval(() => {
      fetch(SELF_PING_URL).catch(() => {}); // keep-alive ping
    }, 4 * 60 * 1000); // every 4 minutes
  }
}

// ============================================================================
// BOOTSTRAP
// ============================================================================
startWebServer();
registerCommands().then(() => client.login(process.env.TOKEN));

// ============================================================================
// RENDER DEPLOYMENT NOTES (FREE WEB SERVICE + PING)
// ----------------------------------------------------------------------------
// 1) Ensure package.json contains:
//    {
//      "type": "module",
//      "scripts": { "start": "node bot.js" },
//      "dependencies": {
//        "discord.js": "^14",
//        "dotenv": "^16",
//        "express": "^4",
//        "ms": "^2"
//      }
//    }
// 2) On Render, create a Web Service (plan: Free):
//    - Build Command:   npm ci
//    - Start Command:   node bot.js
//    - Health Check:    /health
//    - Environment:     TOKEN, CLIENT_ID, GUILD_ID (from Discord),
//                       SELF_PING_URL = https://<your-service>.onrender.com/health (optional)
// 3) (Optional) render.yaml you can commit:
// --- render.yaml ---
// services:
//   - type: web
//     name: discord-bot
//     env: node
//     plan: free
//     buildCommand: "npm ci"
//     startCommand: "node bot.js"
//     healthCheckPath: "/health"
//     autoDeploy: true
//     envVars:
//       - key: TOKEN
//         sync: false
//       - key: CLIENT_ID
//         sync: false
//       - key: GUILD_ID
//         sync: false
//       - key: SELF_PING_URL
//         value: "https://<your-service>.onrender.com/health"
// ============================================================================
