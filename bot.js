// ============================================================================
// BOT.JS — DISCORD BOT WITH ONBOARDING ROLES, NICKNAME BADGES, LEVELING (TEXT+VOICE)
// CHANNEL ROUTING + ERROR-ONLY LOGGING + SEPARATE TOPS (TEXT / VOICE)
// 
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

// (champion medals removed)

// CHANNEL ROUTING (EXACT NAMES)
const LOG_CHANNEL_NAME = 'ℹ️᲼𝕃ogs';
const LEVELUP_CHANNEL_NAME = '⬆️᲼𝕃evel⋅up';
const ARRIVAL_CHANNEL_NAME = '✈️᲼𝔸rrival⋅zone';

// LEVELING CONFIG
const MESSAGE_XP = 15; // PER MESSAGE (WITH COOLDOWN)
const VOICE_XP_PER_MIN = 5; // PER MINUTE IN VOICE
const MESSAGE_COOLDOWN_MS = 60 * 1000; // 1 MIN PER USER

// XP CURVE (EXPONENTIAL): XP needed per level grows by a multiplier
// Level 1 requires XP_BASE; each next level requires previous * XP_GROWTH
// Cumulative XP to reach level N is geometric sum
const XP_BASE = 100;    // XP required for level 1
const XP_GROWTH = 1.25; // multiplier per level (e.g., 1.25 = +25% per level)


// CROWN ROLES FOR TOP TEXT/VOICE
const TEXT_CHAMP_ROLE_NAME = '⌨ Spam Lord';
const VOICE_CHAMP_ROLE_NAME = '🎙 Yap Lord';

// ============================================================================
// PERSISTENCE (JSON FILE DB)
// ============================================================================
const DATA_FILE = './data.json';
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { members: {}, xp: {} }; }
}
let DB = loadData();
// DB SHAPE:
// DB.members: { [guildId:userId]: { joinedAt, newbieSince, originalNick|null } }
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

// Safe sender for Level-Up messages: try #LevelUp, else fallback channel or logs
function safeSendLevelUp(guild, payload, fallbackChannel = null) {
  const ch = getLevelUpChannel(guild) || fallbackChannel || getLogChannel(guild);
  if (ch) ch.send(payload).catch(() => {});
}
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
  new SlashCommandBuilder().setName('topvoice').setDescription('Top 10 by voice XP on this server.'),  // ADMIN: grant XP for testing
  new SlashCommandBuilder()
    .setName('givexp')
    .setDescription('Grant XP to a user (admin only) for testing level-ups).')
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('XP amount').setRequired(true))
    .addStringOption(o => o.setName('source').setDescription('XP source').addChoices(
      { name: 'text', value: 'text' },
      { name: 'voice', value: 'voice' }
    ))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ADMIN: reset all XP for this server (irreversible)
  new SlashCommandBuilder()
    .setName('resetxp')
    .setDescription('Reset ALL XP (text+voice) on this server to 0. Irreversible.')
    .addBooleanOption(o => o.setName('confirm').setDescription('Must be true to confirm').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ADMIN: recompute & assign crown roles (top text/voice)
  new SlashCommandBuilder()
    .setName('refreshcrowns')
    .setDescription('Recompute and assign ⌨ Spam Lord (text) & 🎙 Yap Lord (voice).')
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

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  // STARTUP TASKS
  startVoiceTicker();
  startNewbieSweep();
  // initial crowns for all guilds
  for (const [, guild] of client.guilds.cache) {
    await updateCrownRoles(guild).catch(() => {});
  }
  startCrownSweep();
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

function totalXpForLevel(level) {
  // Cumulative XP required to reach `level` (level 0 = 0)
  if (level <= 0) return 0;
  if (XP_GROWTH === 1) return Math.ceil(XP_BASE * level); // fallback linear
  return Math.ceil(XP_BASE * (Math.pow(XP_GROWTH, level) - 1) / (XP_GROWTH - 1));
}

function xpNeededForLevel(level) {
  // XP needed to go from level-1 to `level`
  if (level <= 0) return 0;
  return Math.ceil(XP_BASE * Math.pow(XP_GROWTH, level - 1));
}

function calcLevel(xp) {
  // Find the highest level where totalXpForLevel(level) <= xp
  let n = 0;
  // Fast path: exponential growth allows logarithmic estimate
  if (xp > 0 && XP_GROWTH !== 1) {
    const est = Math.floor(Math.log((xp * (XP_GROWTH - 1)) / XP_BASE + 1) / Math.log(XP_GROWTH));
    n = Math.max(0, est);
  }
  while (totalXpForLevel(n + 1) <= xp) n++;
  while (n > 0 && totalXpForLevel(n) > xp) n--; // safety
  return n;
}

function xpForNext(level) {
  // Return the cumulative XP threshold for the *next* level
  return totalXpForLevel(level + 1);
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

// BADGE HELPERS (ROLE ONLY)
function stripKnownBadges(name) {
  if (!name) return name;
  let n = name.trim();
  // remove leading known badges (role + crowns)
  n = n.replace(/^((🐣|🤖|🥇|🥈|🥉|⌨|🎙) )+/u, '');
  // remove trailing known badges
  n = n.replace(/( (🐣|🤖|🥇|🥈|🥉|⌨|🎙))+$/u, '');
  return n.trim();
}
function getRoleBadge(member) {
  if (member.roles.cache.find(r => r.name === NEWBIE_ROLE_NAME)) return NEWBIE_BADGE;
  if (member.roles.cache.find(r => r.name === NPC_ROLE_NAME)) return NPC_BADGE;
  return null;
}
async function setNickRoleBadge(member) {
  // PREFIX ORDER: role badge first (🐣/🤖), then crowns (⌨, 🎙), then name
  try {
    const current = member.nickname ?? member.user.globalName ?? member.user.username;
    const base = stripKnownBadges(current);
    const roleBadge = getRoleBadge(member);
    const hasTextCrown = member.roles.cache.some(r => r.name === TEXT_CHAMP_ROLE_NAME);
    const hasVoiceCrown = member.roles.cache.some(r => r.name === VOICE_CHAMP_ROLE_NAME);
    const icons = [];
    if (roleBadge) icons.push(roleBadge);
    if (hasTextCrown) icons.push('⌨');
    if (hasVoiceCrown) icons.push('🎙');
    const prefix = icons.length ? icons.join(' ') + ' ' : '';
    const finalNick = (prefix + base).slice(0, 32);
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
  await setNickRoleBadge(member);

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
      await setNickRoleBadge(member);
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
// CROWN ROLES — TOP TEXT / TOP VOICE
//  - Assign ⌨ Spam Lord to highest text XP
//  - Assign 🎙 Yap Lord to highest voice XP
//  - Ensures roles exist and tries to position them high (just below Admin and
//    within the bot's control). Remove from previous holders.
// ============================================================================
async function ensureCrownRoles(guild) {
  let textRole = guild.roles.cache.find(r => r.name === TEXT_CHAMP_ROLE_NAME);
  if (!textRole) textRole = await guild.roles.create({ name: TEXT_CHAMP_ROLE_NAME, hoist: true, reason: 'Top text crown' }).catch(() => null);
  else { try { await textRole.setHoist?.(true); } catch {} }
  let voiceRole = guild.roles.cache.find(r => r.name === VOICE_CHAMP_ROLE_NAME);
  if (!voiceRole) voiceRole = await guild.roles.create({ name: VOICE_CHAMP_ROLE_NAME, hoist: true, reason: 'Top voice crown' }).catch(() => null);
  else { try { await voiceRole.setHoist?.(true); } catch {} }
  if (!textRole || !voiceRole) return { textRole, voiceRole };

  // Try to set Unicode emoji icons on the roles (server must support role icons)
  try { await textRole.setUnicodeEmoji?.('⌨'); } catch {}
  try { await voiceRole.setUnicodeEmoji?.('🎙'); } catch {}
// Try to push them high in the stack: just below the top Admin role but not above the bot's highest
  try {
    const botMember = await guild.members.fetchMe();
    const botTop = botMember.roles.highest;
    const adminTop = guild.roles.cache
      .filter(r => r.permissions.has(PermissionFlagsBits.Administrator))
      .sort((a, b) => b.position - a.position)
      .first();
    let target = Math.min(botTop.position - 1, adminTop ? (adminTop.position - 1) : (botTop.position - 1));
    target = Math.max(target, 1);
    await textRole.setPosition(target).catch(() => {});
    await voiceRole.setPosition(target).catch(() => {});
  } catch {}
  return { textRole, voiceRole };
}

function topBy(guildId, key) {
  // key: 'text' | 'voice'
  const arr = Object.entries(DB.xp)
    .filter(([k]) => k.startsWith(guildId + ':'))
    .map(([k, v]) => ({ userId: k.split(':')[1], xp: (v?.[key] ?? 0) }))
    .sort((a, b) => b.xp - a.xp);
  return arr[0] || null;
}

async function updateCrownRoles(guild) {
  const { textRole, voiceRole } = await ensureCrownRoles(guild);
  if (!textRole || !voiceRole) return;

  const prevTextId = textRole.members.first()?.id || null;
  const prevVoiceId = voiceRole.members.first()?.id || null;

  const topText = topBy(guild.id, 'text');
  const topVoice = topBy(guild.id, 'voice');

  const newTextId = topText && (topText.xp || 0) > 0 ? topText.userId : null;
  const newVoiceId = topVoice && (topVoice.xp || 0) > 0 ? topVoice.userId : null;

  async function assign(role, winnerId) {
    const members = await guild.members.fetch();
    // If we don't have a winner (e.g., scoreboard empty after a reboot), KEEP current holder to avoid wiping crowns
    if (!winnerId) {
      // still ensure nick format for current holder(s)
      for (const m of members.values()) {
        if (m.roles.cache.has(role.id)) await setNickRoleBadge(m);
      }
      return;
    }
    // Remove from all who aren't the current winner
    for (const m of members.values()) {
      if (m.roles.cache.has(role.id) && m.id !== winnerId) {
        await m.roles.remove(role).catch(() => {});
        await setNickRoleBadge(m);
      }
    }
    // Grant to winner
    const wm = await guild.members.fetch(winnerId).catch(() => null);
    if (wm && !wm.roles.cache.has(role.id)) {
      await wm.roles.add(role, 'Crown role assignment').catch(() => {});
    }
    if (wm) await setNickRoleBadge(wm);
  }

  await assign(textRole, newTextId);
  await assign(voiceRole, newVoiceId);

  // Announcements (only when we have a concrete new winner)
  // Double-crown announcement if both changed and go to same user
  const bothChanged = newTextId && newVoiceId && newTextId !== prevTextId && newVoiceId !== prevVoiceId && newTextId === newVoiceId;
  if (bothChanged) {
    const member = await guild.members.fetch(newTextId).catch(() => null);
    if (member) safeSendLevelUp(guild, { content: `👑 Double crown: ${member} now rules **chat** ⌨ and **voice** 🎙. Bow or cope.` });
    return;
  }

  if (newTextId && newTextId !== prevTextId) {
    const winner = await guild.members.fetch(newTextId).catch(() => null);
    if (winner) safeSendLevelUp(guild, { content: `⌨ New **Spam Lord**: ${winner} just snatched #1 in chat.` });
  }

  if (newVoiceId && newVoiceId !== prevVoiceId) {
    const winner = await guild.members.fetch(newVoiceId).catch(() => null);
    if (winner) safeSendLevelUp(guild, { content: `🎙 New **Yap Lord**: ${winner} just took #1 in voice.` });
  }
}

function startCrownSweep() {
  setInterval(async () => {
    for (const [, guild] of client.guilds.cache) {
      await updateCrownRoles(guild).catch(() => {});
    }
  }, 60 * 60 * 1000); // hourly
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
    safeSendLevelUp(message.guild, { embeds: [embed] }, message.channel);
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
          safeSendLevelUp(guild, { content: `🎙️ Level Up: ${member} is now **level ${lvl}**.` });
        }
      }
    }
  }, 60 * 1000);
}

// ============================================================================
// FEATURE: SLASH COMMAND HANDLER (PING / SETWELCOME / TEMPROLE / GOODBYE / RANK / LEADERBOARD / TOPTEXT / TOPVOICE)
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

    // COMMAND: /GIVEXP (ADMIN)
  if (interaction.commandName === 'givexp') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void interaction.reply({ content: 'You need **Manage Server**.', ephemeral: true });
    }
    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    const source = interaction.options.getString('source') || 'text';
    const res = addXP(interaction.guildId, user.id, amount, source);

    const payload = { content: `⚙️ Granted **${amount} ${source} XP** to <@${user.id}>${res.levelUp ? ` — **Level ${res.newLevel}!**` : ''}` };
    safeSendLevelUp(interaction.guild, payload);
    return void interaction.reply({ content: 'Done.', ephemeral: true });
  }
  // COMMAND: /RESETXP (ADMIN)
  if (interaction.commandName === 'resetxp') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void interaction.reply({ content: 'You need **Manage Server** to do that.', ephemeral: true });
    }
    const ok = interaction.options.getBoolean('confirm', true);
    if (!ok) {
      return void interaction.reply({ content: 'Reset aborted (confirm=false).', ephemeral: true });
    }

    const gid = interaction.guildId;
    let affected = 0;
    for (const [k, v] of Object.entries(DB.xp)) {
      if (k.startsWith(gid + ':')) {
        v.xp = 0; v.text = 0; v.voice = 0; DB.xp[k] = v; affected++;
      }
    }
    saveData();

    // Remove crowns from everyone for a clean restart
    const guild = interaction.guild;
    const { textRole, voiceRole } = await ensureCrownRoles(guild);
    const members = await guild.members.fetch();
    for (const m of members.values()) {
      if (textRole && m.roles.cache.has(textRole.id)) { try { await m.roles.remove(textRole, 'XP reset'); } catch {} }
      if (voiceRole && m.roles.cache.has(voiceRole.id)) { try { await m.roles.remove(voiceRole, 'XP reset'); } catch {} }
      await setNickRoleBadge(m);
    }

    safeSendLevelUp(guild, { content: `🧹 XP reset complete — all members set to **0** (text + voice). Crowns cleared. Good luck, have fun.` });
    return void interaction.reply({ content: `✅ Reset done. ${affected} entries zeroed.`, ephemeral: true });
  }
  // COMMAND: /REFRESHCROWNS (ADMIN)
  if (interaction.commandName === 'refreshcrowns') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return void interaction.reply({ content: 'You need **Manage Server** to do that.', ephemeral: true });
    }
    await updateCrownRoles(interaction.guild);
    return void interaction.reply({ content: '✅ Crowns updated: ⌨ Spam Lord & 🎙 Yap Lord assigned.', ephemeral: true });
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

// Catch truly uncaught exceptions so the process doesn't die silently
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception', err);
  for (const [, guild] of client.guilds.cache) {
    getLogChannel(guild)?.send({ content: `💥 Uncaught exception: ${String(err)}` }).catch(() => {});
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
    const ua = req.get('user-agent') || 'unknown';
    const now = new Date().toISOString();
    console.log(`💓 /health ping @ ${now} — ua=${ua}`);
    res.json({ ok: true, ts: now, uptime: process.uptime(), guilds: client.guilds.cache.size || 0 });
  });

  app.listen(PORT, () => console.log(`🌐 HTTP server listening on :${PORT}`));

  const SELF_PING_URL = process.env.SELF_PING_URL;
  if (SELF_PING_URL) {
    setInterval(() => {
      fetch(SELF_PING_URL).catch(() => {}); // keep-alive ping
    }, 4 * 60 * 1000);
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
