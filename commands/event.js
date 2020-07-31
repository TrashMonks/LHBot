// TODO:
// * join events by reacts
// * choose which channel to use
// * recurring events

const Discord = require('discord.js');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const configPath = path.resolve('./config.json');
const config = require(configPath);
const moment = require('moment-timezone');
const tz = require('../extras/timezones');
const eventDataPath = path.resolve('./events.json');

let eventInfoChannel = null;

const DEFAULT_EVENT_DATA = {
  guildDefaultTimeZones: {},
  events: {},
  userTimeZones: {},
  finishedRoles: [],
  eventInfoMessage: {},
};

// Events that finished more than this time ago will have their roles deleted
const EVENT_CLEANUP_PERIOD = moment.duration(7, 'days');

// See https://momentjs.com/docs/#/displaying/format/ for format info
const DATE_OUTPUT_FORMAT = 'dddd, MMMM Do YYYY, h:mm A';

// Edit this to alter the text of the upcoming events message in the
// event info channel.
const EVENT_MESSAGE_TEMPLATE = ({ events, serverName, timeZone, prefix }) => `\
The upcoming events for ${serverName} are listed below, with the next upcoming event listed first. \
All times are listed in ${timeZone}, the default timezone for this server. \
Use \`${prefix}event info event name\` to view the event time in your local timezone, and \
\`${prefix}event join event name\` to be reminded about the event.

${events}
`;

// Edit this to alter how individual events in the above message
// are displayed.
const EVENT_INFO_TEMPLATE = ({ name, owner, channel, due }) => `\
${name} - created by <@${owner}> in <#${channel}>, starts at ${due.format(DATE_OUTPUT_FORMAT)}\
`;

if (global.eventData == null) {
  if (!fs.existsSync(eventDataPath)) {
    fs.writeFileSync(eventDataPath, JSON.stringify(DEFAULT_EVENT_DATA));
  }
  global.eventData = require(eventDataPath);
}

// We make writing state async because I found in testing
// that it was fairly common when events were removed that the
// JSON would get clobbered by multiple asynchronous writeFile commands,
// especially when completing events
async function writeEventState() {
  return fsp.writeFile(
    eventDataPath,
    JSON.stringify(global.eventData, null, 2),
  );
}

const dateInputFormats = ['YYYY-MM-DD', 'YYYY/MM/DD', 'MM-DD', 'MM/DD'];
const timeInputFormat = 'HH:mm';

function getTimeZoneFromUserInput(timeZone) {
  timeZone = timeZone && timeZone.replace(' ', '_');
  return timeZone && (tz.TIMEZONE_CODES[timeZone.toUpperCase()] || timeZone);
}

function formatDateCalendar(date, timeZone) {
  return date.tz(getTimeZoneFromUserInput(timeZone)).format('llll');
}

function isValidTimeZone(timeZone) {
  return moment.tz(timeZone).tz() !== undefined;
}

function getGuildTimeZone(guild) {
  const guildZone = guild && global.eventData.guildDefaultTimeZones[guild.id];

  // Return a default if none specified (the system time zone)
  return getTimeZoneFromUserInput(guildZone) || moment.tz.guess();
}

function getAuthorTimeZone(message) {
  const userZone = global.eventData.userTimeZones[message.author.id];
  return getTimeZoneFromUserInput(userZone) || getGuildTimeZone(message.guild);
}

function getUserTimeZone(user, guild) {
  const userZone = global.eventData.userTimeZones[user.id];
  return getTimeZoneFromUserInput(userZone) || getGuildTimeZone(guild);
}

async function setGuildTimeZone(guild, timeZone) {
  global.eventData.guildDefaultTimeZones[guild.id] = timeZone;
  return writeEventState();
}

async function setUserTimeZone(user, timeZone) {
  global.eventData.userTimeZones[user.id] = timeZone;
  return writeEventState();
}

// Used to make the timezone into the 'canonical' format vs whatever user provided
function getTimeZoneCanonicalDisplayName(timeZone) {
  return moment.tz(getTimeZoneFromUserInput(timeZone)).zoneAbbr();
}

class EventManager {
  /**
   * Create a new EventManager instance.
   *
   * @param client Discord client instance
   */
  constructor(client) {
    this.client = client;
    this.timer = null;
    this.upcomingEvents = {};
    this.rolesPendingPrune = [];
    this.eventInfoMessage = {};
  }

  /**
   * Load the state of the EventManager from the global JSON data.
   */
  async loadState() {
    if (global.eventData.events) {
      // Convert saved date strings back into Moment datetime objects
      Object.entries(global.eventData.events).forEach(([guild, events]) => {
        this.upcomingEvents[guild] = events.map(event => ({
          ...event,
          due: moment.utc(event.due, moment.ISO_8601, true),
        }));
      });
    }
    if (global.eventData.finishedRoles) {
      this.rolesPendingPrune = global.eventData.finishedRoles.map(role => ({
        ...role,
        startedAt: moment.utc(role.startedAt, moment.ISO_8601, true),
      }));
    }
    if (global.eventData.eventInfoMessage) {
      await Promise.all(
        Object.entries(global.eventData.eventInfoMessage).map(
          async ([guild, messageId]) => {
            if (eventInfoChannel) {
              const message = await eventInfoChannel.messages
                .fetch(messageId)
                .catch(e =>
                  console.error('Failed to load event info message', e),
                );

              if (message) {
                this.eventInfoMessage[guild] = message;
                console.log('Loaded event message', message.id);
              }
              else {
                console.log(
                  `Event info message ${messageId} could not be found for guild ${guild}`,
                );
              }
            }
          },
        ),
      );
    }
  }

  /**
   * Save the state of the EventManager to the global JSON data.
   *
   * @returns {Promise<*>} Resolves when the data file has been written out.
   */
  async saveState() {
    // Serialize moment datetimes as ISO8601 strings
    Object.entries(this.upcomingEvents).forEach(([guild, events]) => {
      if (events.length !== undefined) {
        global.eventData.events[guild] = events.map(event => ({
          ...event,
          due: event.due.toISOString(),
        }));
      }
    });
    global.eventData.finishedRoles = this.rolesPendingPrune.map(role => ({
      ...role,
      startedAt: role.startedAt.toISOString(),
    }));

    if (global.eventData.eventInfoMessage === undefined) {
      global.eventData.eventInfoMessage = {};
    }
    Object.entries(this.eventInfoMessage).forEach(([guild, message]) => {
      global.eventData.eventInfoMessage[guild] = message.id;
    });

    return writeEventState();
  }

  /**
   * Start running the timer for recurring EventManager tasks.
   */
  start() {
    // Tick immediately at start to do cleanup
    this.tick().then(() => {
      // Ensure we're always at (or close to) the 'top' of a minute when we run our tick
      const topOfMinute = 60000 - (Date.now() % 60000);
      this.timer = this.client.setTimeout(() => {
        this.timer = this.client.setInterval(() => this.tick(), 60000);
        this.tick();
      }, topOfMinute);
    });
  }

  /**
   * Perform a single run of the checks for pending scheduled tasks.
   *
   * @returns {Promise<void>} Resolves when the work for this tick is finished.
   */
  async tick() {
    const now = moment.utc();
    const eventsByGuild = Object.entries(this.upcomingEvents);

    for (const [guild, events] of eventsByGuild) {
      const dueEvents = events.filter(event => event.due.isSameOrBefore(now));
      this.upcomingEvents[guild] = events.filter(event =>
        event.due.isAfter(now),
      );
      this.rolesPendingPrune = [
        ...this.rolesPendingPrune,
        ...dueEvents.map(event => ({
          startedAt: event.due,
          guild: event.guild,
          role: event.role,
        })),
      ];
      await this.saveState();

      if (dueEvents.length > 0) {
        for (const event of dueEvents) {
          const guild = this.client.guilds.cache.get(event.guild);
          const eventAge = moment.duration(now.diff(event.due));
          // Discard events we missed for more than 5 minutes
          if (eventAge.asMinutes() >= 5) {
            break;
          }
          const destChannel = await this.client.channels.fetch(event.channel);
          if (!destChannel) {
            console.log('Got event for unknown channel', event.channel);
            break;
          }

          await destChannel.send(
            `The event **'${event.name}'** is starting now! <@&${event.role}>`,
            embedEvent(event, guild, {
              title: event.name,
              description: 'This event is starting now.',
            }),
          );
        }
      }

      // Post/update the event info message if necessary
      if (
        dueEvents.length > 0 ||
        (eventInfoChannel && !this.eventInfoMessage[guild])
      ) {
        await this.updateUpcomingEventsPost(guild);
      }
    }

    const rolesToPrune = this.rolesPendingPrune.filter(
      role => now.diff(role.startedAt) > EVENT_CLEANUP_PERIOD,
    );
    this.rolesPendingPrune = this.rolesPendingPrune.filter(
      role => now.diff(role.startedAt) <= EVENT_CLEANUP_PERIOD,
    );
    await this.saveState();

    for (const roleInfo of rolesToPrune) {
      const guild = this.client.guilds.cache.get(roleInfo.guild);
      const role = guild.roles.cache.get(roleInfo.role);
      if (role) {
        await role.delete(
          `Role removed as event happened ${EVENT_CLEANUP_PERIOD.humanize()} ago`,
        );
      }
      else {
        console.log(
          `Skipping removal of role ${roleInfo.role} from guild ${roleInfo.guild} as it no longer exists`,
        );
      }
    }
  }

  /**
   * Stop running the EventManager timer.
   */
  stop() {
    this.client.clearTimeout(this.timer);
    this.client.clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Add a new event to the EventManager.
   *
   * @param event The data for the event.
   * @returns {Promise<*>} Resolves once the event has been saved persistently.
   */
  async add(event) {
    const guild = event.guild;
    if (!this.upcomingEvents[guild]) {
      this.upcomingEvents[guild] = [];
    }
    this.upcomingEvents[guild].push(event);
    this.upcomingEvents[guild].sort((a, b) => a.due.diff(b.due));
    await this.updateUpcomingEventsPost(guild);
    return this.saveState();
  }

  _indexByName(guild, eventName) {
    const lowerEventName = eventName.toLowerCase();
    if (!this.upcomingEvents[guild]) {
      return undefined;
    }

    const index = this.upcomingEvents[guild].findIndex(
      event => event.name.toLowerCase() === lowerEventName,
    );

    return index !== -1 ? index : undefined;
  }

  /**
   * Get the event with this name on a specific guild.
   *
   * @param guildId The Snowflake corresponding to the event's guild
   * @param eventName The name of the event to retrieve
   * @returns Event data or undefined
   */
  getByName(guildId, eventName) {
    const index = this._indexByName(guildId, eventName);
    return index !== undefined ? this.upcomingEvents[guildId][index] : index;
  }

  /**
   * Update the event data for a named event on a specific guild
   *
   * @param guildId The Snowflake corresponding to the event's guild
   * @param eventName The name of the event to retrieve
   * @param event The new event data
   * @returns {Promise<boolean>} Resolves with whether the event was updated
   */
  async updateByName(guildId, eventName, event) {
    const index = this._indexByName(guildId, eventName);
    if (index === undefined) {
      return false;
    }

    this.upcomingEvents[guildId][index] = event;
    await this.saveState();
    return true;
  }

  /**
   * Delete a named event on a specific guild
   *
   * @param guildId The Snowflake corresponding to the event's guild
   * @param eventName The name of the event to retrieve
   * @returns {Promise<boolean>} Resolves with whether the event was delete
   */
  async deleteByName(guildId, eventName) {
    const index = this._indexByName(guildId, eventName);
    if (index === undefined) {
      return false;
    }

    this.upcomingEvents[guildId].splice(index);
    await this.updateUpcomingEventsPost(guild);
    await this.saveState();
    return true;
  }

  /**
   * Get the active events for a specified guild.
   *
   * @param guild Snowflake of the Guild to scope events to.
   * @returns Array of events for guild.
   */
  guildEvents(guild) {
    return this.upcomingEvents[guild] || [];
  }

  /**
   * Adds a participant to an event.
   *
   * @param guildId Snowflake of the Guild to scope events to.
   * @param userId Snowflake of the User to be added to the event.
   * @param eventName Name of the event to be updated.
   * @returns {boolean} Whether the user was added to the event (false if already added).
   */
  async addParticipant(guildId, userId, eventName) {
    const event = this.getByName(guildId, eventName);
    if (!event) {
      return false;
    }

    const guild = this.client.guilds.cache.get(guildId);
    const member = guild.members.cache.get(userId);
    await member.roles.add(event.role, 'Requested to be added to this event');

    return true;
  }

  /**
   * Removes a participant from an event.
   *
   * @param guildId Snowflake of the Guild to scope events to.
   * @param userId Snowflake of the User to be removed to the event.
   * @param eventName Name of the event to be updated.
   * @returns {boolean} Whether the user was removed from the event (false if not already added).
   */
  async removeParticipant(guildId, userId, eventName) {
    const event = this.getByName(guildId, eventName);
    if (!event) {
      return false;
    }

    const guild = this.client.guilds.cache.get(guildId);
    const member = guild.members.cache.get(userId);
    await member.roles.remove(
      event.role,
      'Requested to be removed from this event',
    );

    return true;
  }

  /**
   * Updates the guild's post for upcoming event if applicable.
   *
   * @param guildId Snowflake of the Guild to update the event post for
   * @returns {Promise<void>} Resolves when post update complete.
   */
  async updateUpcomingEventsPost(guildId) {
    const guild = this.client.guilds.cache.get(guildId);
    const events = this.guildEvents(guildId);
    const message = this.eventInfoMessage[guildId];
    const defaultTimeZone = getGuildTimeZone(guild);

    const upcomingEventsInfoText = events.map(event =>
      EVENT_INFO_TEMPLATE({ ...event, due: event.due.tz(defaultTimeZone) }),
    );

    const templateParams = {
      serverName: guild.name,
      events:
        upcomingEventsInfoText.length > 0
          ? upcomingEventsInfoText.join('\n')
          : 'No upcoming events.',
      timeZone: getTimeZoneCanonicalDisplayName(defaultTimeZone),
      prefix: config.prefix,
    };

    if (eventInfoChannel) {
      // We only support one eventinfochannel for now
      if (!guild.channels.cache.has(eventInfoChannel.id)) {
        console.log(`No event info channel for guild ${guildId}, skip.`);
        return;
      }

      if (message) {
        console.log('found message', message.id);
        await message.edit(EVENT_MESSAGE_TEMPLATE(templateParams));
      }
      else {
        console.log(
          `No event info message found for guild ${guildId}, send a new one.`,
        );
        const newMessage = await eventInfoChannel.send(
          EVENT_MESSAGE_TEMPLATE(templateParams),
        );
        this.eventInfoMessage[guildId] = newMessage;
        await this.saveState();
      }
    }
  }
}

let eventManager;

/**
 * Creates a message embed for an event.
 *
 * @param event {object} The event data in question
 * @param guild {module:"discord.js".Guild} The guild object for the guild this event belongs to
 * @param options {object} The options for this embed
 * @returns {module:"discord.js".MessageEmbed} A MessageEmbed with structured info on this event
 */
function embedEvent(event, guild, options = {}) {
  const { title, description, forUser } = options;

  const role = guild && guild.roles.cache.get(event.role);

  const eventEmbed = new Discord.MessageEmbed()
    .setTitle(title)
    .setDescription(
      description ||
        `A message will be posted in <#${event.channel}> when this event starts. ` +
          `You can join this event with '${config.prefix}event join ${event.name}'.`,
    )
    .addField('Event name', event.name)
    .addField('Creator', `<@${event.owner}>`)
    .addField('Channel', `<#${event.channel}>`)
    .addField('Event role', `<@&${event.role}>`)
    .setTimestamp(event.due);
  if (event.description) {
    eventEmbed.addField('Description', event.description);
  }

  if (role) {
    eventEmbed.addField('Participants', `${role.members.keyArray().length}`);
    if (forUser) {
      const member = guild.members.cache.get(forUser);
      eventEmbed.addField(
        'Participating?',
        forUser === event.owner || member.roles.cache.has(event.role)
          ? 'Yes'
          : 'No',
      );
    }
  }

  return eventEmbed;
}

// version of embedEvent modified for the DM session during event creation.
function DMembedEvent(event, guild, options = {}) {
  // formatDateCalendar(moment(event.due), timeZone)
  const { title, description, forUser } = options;
  // const owner = ;
  const timeZone = getUserTimeZone(forUser, guild);
  const eventEmbed = new Discord.MessageEmbed()
    .setTitle(title)
    .setDescription(
      description ||
        `A message will be posted in <#${event.channel}> when this event starts. ` +
          `Users can join this event with '${config.prefix}event join ${event.name}'.`,
    )
    .addField('Event name', event.name)
    .addField('Event time', `${formatDateCalendar(moment(event.due), timeZone)} ${getTimeZoneCanonicalDisplayName(timeZone)}`)
    .addField('Creator', `<@${event.owner}>`)
    .addField('Channel', `<#${event.channel}>`)
    .setFooter('Event')
    .setTimestamp(event.due.toISOString());
  if (event.description) {
    eventEmbed.addField('Description', event.description);
  }
  eventEmbed.addField('Event role', `@Event - ${event.name}`);
  return eventEmbed;
}

async function createCommand(message, args, client) {
  const [date, time, ...nameParts] = args;
  const name = nameParts.join(' ');
  // 1 minute from now
  const timeZone = getAuthorTimeZone(message);
  const minimumDate = moment.tz(timeZone).add('1', 'minutes');

  if (eventManager.getByName(message.guild.id, name)) {
    return message.channel.send(`An event called '${name}' already exists.`);
  }

  if (!date) {
    return message.channel.send('You must specify a date for the event.');
  }

  if (!time) {
    return message.channel.send('You must specify a time for the event.');
  }

  if (!name) {
    return message.channel.send('You must specify a name for the event.');
  }

  // Process date and time separately for better error handling

  // Handle 'special' date values
  let datePart;
  switch (date.toLowerCase()) {
  case 'today':
    datePart = moment.tz(moment(), dateInputFormats, true, timeZone);
    break;
  case 'tomorrow':
    datePart = moment.tz(
      moment().add(1, 'd'),
      dateInputFormats,
      true,
      timeZone,
    );
    break;
  default:
    datePart = moment.tz(date, dateInputFormats, true, timeZone);
  }

  if (!datePart.isValid()) {
    return message.channel.send(
      `The date format used wasn't recognized, or you entered an invalid date. Supported date formats are: ${dateInputFormats
        .map(date => `\`${date}\``)
        .join(', ')}.`,
    );
  }

  const timePart = moment.tz(time, timeInputFormat, true, timeZone);

  if (!timePart.isValid()) {
    return message.channel.send(
      `The time format used wasn't recognized. The supported format is \`${timeInputFormat}\`.`,
    );
  }

  const resolvedDate = datePart.set({
    hour: timePart.hour(),
    minute: timePart.minute(),
    second: 0,
    millisecond: 0,
  });

  // Ensure the event is in the future.
  if (resolvedDate.diff(minimumDate) < 0) {
    return message.channel.send('The event must start in the future.');
  }

  // Create a new role for this event
  let role;
  try {
    role = await message.guild.roles.create({
      data: {
        name: `Event - ${name}`,
        // Event roles shouldn't grant any inherent permissions
        permissions: 0,
        // Event roles should definitely be mentionable
        mentionable: true,
      },
      reason: `Event role created on behalf of <@${message.author.id}>`,
    });

    // Add the role to the owner.
    const sendingMember = message.guild.members.cache.get(message.author.id);
    await sendingMember.roles.add(role.id, 'Created the event for this role');
  }
  catch (e) {
    console.log('Error creating event role:', e);
    return message.channel.send(
      'There was an error creating the role for this event, contact the bot owner.',
    );
  }

  const newEvent = {
    due: resolvedDate.utc(),
    name,
    channel: message.channel.id,
    owner: message.author.id,
    guild: message.guild.id,
    role: role.id,
  };

  await eventManager.add(newEvent);

  return message.channel.send(
    'Your event has been created.',
    embedEvent(newEvent, null, {
      title: `New event: ${name}`,
      forUser: message.author.id,
    }),
  );
}

async function deleteCommand(message, client, name) {
  const guildmember = message.guild.member(message.author);
  if (!name) {
    return message.channel.send(
      'You must specify which event you want to delete.',
    );
  }

  const event = eventManager.getByName(message.guild.id, name);
  if (event) {
    if (
      event.owner !== message.author.id &&
      !guildmember.roles.cache.has(config.roleStaff)
    ) {
      return message.channel.send(
        'Only staff and the event creator can delete an event.',
      );
    }

    try {
      const role = await message.guild.roles.fetch(event.role);
      await role.delete(
        `The event for this role was deleted by <@${message.author.id}>.`,
      );
    }
    catch (e) {
      console.log('Error deleting event role:', e);
      return message.channel.send(
        'There was an error deleting the role for this event, contact the bot owner.',
      );
    }

    await eventManager.deleteByName(message.guild.id, name);
    return message.channel.send(
      'The event was deleted.',
      embedEvent(event, message.guild, {
        title: `Deleted event: ${event.name}`,
      }),
    );
  }
  else {
    return message.channel.send(`The event '${name}' does not exist.`);
  }
}

async function infoCommand(message, client, name) {
  if (!name) {
    return message.channel.send(
      'You must specify which event you want info on.',
    );
  }

  const event = eventManager.getByName(message.guild.id, name);
  if (event) {
    return message.channel.send(
      '',
      embedEvent(event, message.guild, {
        title: event.name,
        forUser: message.author.id,
      }),
    );
  }
  else {
    return message.channel.send(`The event '${name}' does not exist.`);
  }
}

async function listCommand(message, client, timeZone) {
  timeZone = getTimeZoneFromUserInput(timeZone) || getAuthorTimeZone(message);

  if (!isValidTimeZone(timeZone)) {
    return message.channel.send(
      `'${timeZone}' is an invalid or unknown time zone.`,
    );
  }

  const guildUpcomingEvents = eventManager.guildEvents(message.guild.id);

  if (guildUpcomingEvents.length === 0) {
    return message.channel.send('There are no events coming up.');
  }

  const displayLimit = 10;
  const displayAmount = Math.min(guildUpcomingEvents.length, displayLimit);
  const eventList = guildUpcomingEvents
    .slice(0, displayLimit)
    .map(
      (event, i) =>
        `${i + 1}. **${event.name}** (${formatDateCalendar(
          moment(event.due),
          timeZone,
        )}) - in <#${event.channel}>`,
    )
    .join('\n');

  const embed = new Discord.MessageEmbed()
    .setTitle(`Upcoming events in ${message.guild.name}`)
    .setDescription(
      `
        ${
  displayAmount === 1
    ? 'There\'s only one upcoming event.'
    : `Next ${displayAmount} events, ordered soonest-first.`
}
        
        ${eventList}`,
    )
    .setFooter(
      `All event times are in ${getTimeZoneCanonicalDisplayName(timeZone)}.` +
        (timeZone
          ? ''
          : ' Use !event list [timezone] to show in your time zone.'),
    );
  return message.channel.send('Here are the upcoming events:', embed);
}

async function servertzCommand(message, client, timeZone) {
  const member = message.guild.member(message.author);
  if (!timeZone) {
    const defaultTimeZone = getGuildTimeZone(message.guild);
    return message.channel.send(
      `The server's default time zone is **${getTimeZoneCanonicalDisplayName(
        defaultTimeZone,
      )}** (UTC${moment()
        .tz(defaultTimeZone)
        .format('Z')}).`,
    );
  }

  if (!member.roles.cache.has(config.roleStaff)) {
    return message.channel.send(
      'Only staff can set the server\'s default timezone.',
    );
  }

  timeZone = getTimeZoneFromUserInput(timeZone);

  if (!isValidTimeZone(timeZone)) {
    return message.channel.send(
      `'${timeZone}' is an invalid or unknown time zone.`,
    );
  }

  await setGuildTimeZone(message.guild.id, timeZone);

  return message.channel.send(
    `The server's default time zone is now set to **${getTimeZoneCanonicalDisplayName(
      timeZone,
    )}** (UTC${moment()
      .tz(timeZone)
      .format('Z')}).`,
  );
}

async function tzCommand(message, client, timeZone) {
  if (!timeZone) {
    const defaultTimeZone = getAuthorTimeZone(message);
    return message.channel.send(
      `<@${
        message.author.id
      }>, your default time zone is **${getTimeZoneCanonicalDisplayName(
        defaultTimeZone,
      )}** (UTC${moment()
        .tz(defaultTimeZone)
        .format('Z')}).`,
    );
  }

  timeZone = getTimeZoneFromUserInput(timeZone);

  if (!isValidTimeZone(timeZone)) {
    return message.channel.send(
      `'${timeZone}' is an invalid or unknown time zone.`,
    );
  }

  await setUserTimeZone(message.author, timeZone);

  return message.channel.send(
    `<@${
      message.author.id
    }>, your default time zone is now set to **${getTimeZoneCanonicalDisplayName(
      timeZone,
    )}** (UTC${moment()
      .tz(timeZone)
      .format('Z')}).`,
  );
}

async function joinCommand(message, client, eventName) {
  if (!eventName) {
    return message.channel.send(
      `<@${message.author.id}>, you must specify which event you want to join.`,
    );
  }

  const event = eventManager.getByName(message.guild.id, eventName);

  if (!event) {
    return message.channel.send(
      `<@${message.author.id}>, the event '${eventName}' does not exist.`,
    );
  }

  const success = await eventManager.addParticipant(
    message.guild.id,
    message.author.id,
    eventName,
  );

  if (success) {
    return message.channel.send(
      `<@${message.author.id}> was successfully added to the event '${eventName}'.`,
    );
  }
  else {
    return message.channel.send(
      `<@${message.author.id}>, you've already joined the event '${eventName}'.`,
    );
  }
}

async function leaveCommand(message, client, eventName) {
  if (!eventName) {
    return message.channel.send(
      `<@${message.author.id}>, you must specify which event you want to join.`,
    );
  }

  const event = eventManager.getByName(message.guild.id, eventName);

  if (!event) {
    return message.channel.send(
      `<@${message.author.id}>, the event '${eventName}' does not exist.`,
    );
  }

  const success = await eventManager.removeParticipant(
    message.guild.id,
    message.author.id,
    eventName,
  );

  if (success) {
    if (event.owner === message.author.id) {
      return message.channel.send(
        `<@${message.author.id}>, you've been removed from the event '${eventName}'. As the event creator, ` +
          'you can still delete this event event though you have been removed.',
      );
    }
    else {
      return message.channel.send(
        `<@${message.author.id}>, you've been removed from the event '${eventName}'.`,
      );
    }
  }
  else {
    return message.channel.send(
      `<@${message.author.id}>, you aren't participating in '${eventName}'.`,
    );
  }
}

async function updateInfoPostCommand(message, client, retry = false) {
  const member = message.guild.member(message.author);
  if (!member.roles.cache.has(config.roleStaff)) {
    return message.channel.send(
      'Only staff can force the event info to be updated.',
    );
  }

  try {
    await eventManager.updateUpcomingEventsPost(message.guild.id);
    return message.channel.send(
      `<@${message.author.id}>, the post has been updated.`,
    );
  }
  catch (e) {
    console.log('Unable to update upcoming events post:', e);
    return message.channel.send(
      `<@${message.author.id}>, there was an error updating the post, check the logs.`,
    );
  }
}

// function to create a message collector after recieving a message.
async function msgCollector(message) {
  // let responses = 0;
  let reply = false;
  // create a filter to ensure output is only accepted from the author who initiated the command.
  const filter = input => (input.author.id === message.author.id);
  await message.channel.awaitMessages(filter, { max: 1, time: 30000, errors: ['time'] })
    // this method creates a collection; since there is only one entry we get the data from collected.first
    .then(collected => reply = collected.first())
    .catch(collected => message.channel.send('Sorry, I waited 30 seconds with no response, please run the command again.'));
  // console.log('Reply processed...');
  return reply;
}

async function DMCollector(DMChannel) {
  // let responses = 0;
  let reply = false;
  // awaitmessages needs a filter but we're just going to accept the first reply it gets.
  const filter = m => (m.author.id === DMChannel.recipient.id);
  await DMChannel.awaitMessages(filter, { max: 1, time: 60000, errors: ['time'] })
    // this method creates a collection; since there is only one entry we get the data from collected.first
    .then(collected => reply = collected.first())
    .catch(collected => DMChannel.send('Sorry, I waited 60 seconds with no response. You will need to start over.'));
  // console.log('Reply processed...');
  return reply;
}

async function createWizard(message) {
  let eventData = {};
  let reply;
  const DMChannel = await message.author.createDM();
  const timeZone = getAuthorTimeZone(message);
  const minimumDate = moment.tz(timeZone).add('1', 'minutes');
  DMChannel.send(`Before we get started, all times and dates will be set for the **${timeZone}** locale.  This is either set by you, or is the server's time zone. If you would like to set or change your time zone, you may do so by cancelling this command and typing ${config.prefix}event tz [timezone].\n**PLEASE NOTE** that using that command will store your userID and timezone in the bot. If you are not comfortable with this, you will need to convert the date and time by hand to match the server time zone.`);
  DMChannel.send('First, I\'ll need a name for the event. What would you like to call it?\n *You can reply \'cancel\' without quotes at any time to end this wizard without creating an event.');
  let awaitingAnswer = true;
  while (awaitingAnswer) {
    reply = await DMCollector(DMChannel);
    if (!reply) {
      awaitingAnswer = false;
      return false;
    }
    if (reply.content.toLowerCase() == 'cancel') {
      awaitingAnswer = false;
      DMChannel.send(`Event creation cancelled. Please run ${config.prefix}event again to initiate event creation again.`);
      return false;
    }
    eventData.name = reply.content;
    if (eventManager.getByName(message.guild.id, eventData.name)) {
      DMChannel.send(`An event called '${eventData.name}' already exists. Please enter a different name.`);
    }
    else {awaitingAnswer = false;}
  }
  DMChannel.send(`ok, an event called **${eventData.name}**.\nNext, I need a date and time for the event, like so: [Date] [HH:mm] [AM/PM] (AM/PM are optional).\nValid date formats are: YYYY/MM/DD, MM/DD, today, or tomorrow.`);
  awaitingAnswer = true;
  let resolvedDate;
  let datePart;
  let timePart;
  while (awaitingAnswer) {
    reply = await DMCollector(DMChannel);
    if (!reply) {
      awaitingAnswer = false;
      return false;
    }
    if (reply.content.toLowerCase() == 'cancel') {
      awaitingAnswer = false;
      DMChannel.send(`Event creation cancelled. Please run ${config.prefix}event again to initiate event creation again.`);
      return false;
    }
    let [date, time, ampm] = reply.content.split(' ');
    // handle special date formats.
    if (!time) {
      DMChannel.send('Please include a time, separated by a space from the date.  You can enter the time in 24 hour format, or with AM/PM separated by a space.\nPlease try again or type cancel to end event creation.');
    }
    else {
      switch (date.toLowerCase()) {
      case 'today':
        datePart = moment.tz(moment(), dateInputFormats, true, timeZone);
        break;
      case 'tomorrow':
        datePart = moment.tz(
          moment().add(1, 'd'),
          dateInputFormats,
          true,
          timeZone,
        );
        break;
      default:
        datePart = moment.tz(date, dateInputFormats, true, timeZone);
      }
      let [hours, minutes] = time.split(':');
      if (parseInt(hours) < 10) {
        hours = '0' + parseInt(hours);
      }
      time = hours + ':' + minutes;
      timePart = moment.tz(time, timeInputFormat, true, timeZone);

      if (!datePart.isValid()) {
        DMChannel.send(
          `The date format used wasn't recognized, or you entered an invalid date. Supported date formats are: ${dateInputFormats
            .map(d => `\`${d}\``)
            .join(', ')}.\n Please try again or type cancel to end event creation.`,
        );
      }
      else if (!timePart.isValid()) {
        DMChannel.send(
          'The time format used wasn\'t recognized. Examples of properly formatted time:\n1:00\n01:00\n13:00\n1:00 AM\n1:00 PM\n Please try enter the date and time again or type cancel to end event creation.',
        );
      }
      else if (ampm && !['am', 'pm'].includes(ampm.toLowerCase())) {
        DMChannel.send('Please either use 24 hour time or include AM/PM after the time. Please try again or type cancel to end event creation.');
      }
      else if (ampm) {
        if (hours != 12 && ampm.toLowerCase() == 'pm') {
          timePart.add(12, 'h');
        }
        if (hours == 12 && ampm.toLowerCase() == 'am') {
          timePart.subtract(12, 'h');
        }
      }

      if (datePart.isValid() && timePart.isValid()) {
        resolvedDate = datePart.set({
          hour: timePart.hour(),
          minute: timePart.minute(),
          second: 0,
          millisecond: 0,
        });
      }
      // Ensure the event is in the future.
      if (resolvedDate && resolvedDate.diff(minimumDate) < 0) {
        DMChannel.send('The event must start in the future. Please try again or type cancel to end event creation.');
      }
      else {
        eventData.due = resolvedDate.utc();
        const d = new Date(resolvedDate);
        const options = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', timeZone: timeZone, timeZoneName: 'short' };
        DMChannel.send(`Great, **${eventData.name}** will happen on ${d.toLocaleString('en-US', options)}. Is this ok? **Y/N**`);
        let awaitYN = true;
        while (awaitYN == true) {
          reply = await DMCollector(DMChannel);
          switch (reply.content.toLowerCase()) {
          case 'n':
          case 'no':
            DMChannel.send('OK, please type a new date and time for the event.');
            awaitingAnswer = true;
            awaitYN = false;
            break;
          case 'y':
          case 'yes':
            DMChannel.send('OK! Would you like to set a description for this event? **Y/N**');
            awaitingAnswer = false;
            awaitYN = false;
            break;
          case 'cancel':
            DMChannel.send(`Event creation cancelled. Please run ${config.prefix}event again to initiate event creation again.`);
            return;
          case false:
            return;
          default:
            DMChannel.send('Reply not recognized! Please answer Y or N. Would you like to set a description for this event? **Y/N**');
            break;
          }
        }
        awaitingAnswer = false;
      }
    }
  }
  eventData.due = resolvedDate.utc();
  let needsDesc = false;
  awaitingAnswer = true;
  while (awaitingAnswer) {
    reply = await DMCollector(DMChannel);
    switch (reply.content.toLowerCase()) {
    case 'n':
    case 'no':
      DMChannel.send('OK, no description. Does this all look ok? **Y/N**');
      awaitingAnswer = false;
      break;
    case 'y':
    case 'yes':
      DMChannel.send('Great! Please enter a description for the event.  It\'s best to keep this short, 2-3 sentences max. You can type \'none\' if you decide you do no want a description after all');
      awaitingAnswer = false;
      needsDesc = true;
      break;
    case 'cancel':
      DMChannel.send(`Event creation cancelled. Please run ${config.prefix}event again to initiate event creation again.`);
      return;
    case false:
      return;
    default:
      DMChannel.send('Reply not recognized! Please answer Y or N. Would you like to set a description for this event? **Y/N**');
      break;
    }
  }
  let description;
  while(needsDesc == true) {
    reply = await DMCollector(DMChannel);
    description = reply.content.toLowerCase();
    switch (description) {
    case 'cancel':
      DMChannel.send(`Event creation cancelled. Please run ${config.prefix}event again to initiate event creation again.`);
      return;
    case 'none':
      DMChannel.send('OK, no description. Does this all look ok? **Y/N**');
      needsDesc = false;
      break;
    case false:
      return;
    default:
      DMChannel.send(`Great,\n> *${description}* will be the description of your event. Is this OK? **Y/N**`);
      awaitingAnswer = true;
      while (awaitingAnswer) {
        reply = await DMCollector(DMChannel);
        switch (reply.content.toLowerCase()) {
        case 'n':
        case 'no':
          DMChannel.send('OK, please type a new description, or \'none\' for no description.');
          awaitingAnswer = false;
          break;
        case 'y':
        case 'yes':
          eventData.description = description;
          awaitingAnswer = false;
          needsDesc = false;
          break;
        case 'cancel':
          DMChannel.send(`Event creation cancelled. Please run ${config.prefix}event again to initiate event creation again.`);
          return;
        case false:
          return;
        default:
          DMChannel.send(`Reply not recognized! Please answer Y or N. Would you like to change the description for this event from *${description}*? **Y/N**`);
          break;
        }
      }
    }
  }
  eventData.channel = message.channel.id;
  eventData.owner = message.author.id;
  eventData.guild = message.guild.id;

  DMChannel.send(
    DMembedEvent(eventData, message.guild, {
      title: `New event: ${eventData.name}`,
      forUser: message.author.id,
    }),
  );
  DMChannel.send('Great! Does this look ok? **Y/N**');
  let awaitYN = true;
  while (awaitYN == true) {
    reply = await DMCollector(DMChannel);
    switch (reply.content.toLowerCase()) {
    case 'n':
    case 'no':
      DMChannel.send('OK. For now you will have to re-run the command in the server to re-create the event.');
      awaitYN = false;
      return;
    case 'y':
    case 'yes':
      DMChannel.send(`Perfect. I'll notify <#${eventData.channel}> now`);
      awaitYN = false;
      break;
    case 'cancel':
      DMChannel.send(`Event creation cancelled. Please run ${config.prefix}event again to initiate event creation again.`);
      return;
    case false:
      return;
    default:
      DMChannel.send('Reply not recognized! Please answer Y or N. Is the event data I posted above acceptable? **Y/N**');
      break;
    }
  }
  let role;
  try {
    role = await message.guild.roles.create({
      data: {
        name: `Event - ${eventData.name}`,
        // Event roles shouldn't grant any inherent permissions
        permissions: 0,
        // Event roles should definitely be mentionable
        mentionable: true,
      },
      reason: `Event role created on behalf of ${message.author.tag}`,
    });

    // Add the role to the owner.
    const sendingMember = message.guild.members.cache.get(message.author.id);
    await sendingMember.roles.add(role.id, 'Created the event for this role');
  }
  catch (e) {
    console.log('Error creating event role:', e);
    return message.channel.send(
      'There was an error creating the role for this event, contact the bot owner.',
    );
  }

  eventData.role = role.id;

  await eventManager.add(eventData);

  return message.channel.send(
    'Your event has been created.',
    embedEvent(eventData, null, {
      title: `New event: ${eventData.name}`,
      forUser: message.author.id,
    }),
  );
}

module.exports = {
  name: 'event',
  description: 'Allows people on a server to participate in events',
  usage: `create to start a DM session to create a new event
${config.prefix}event join [name] to join an event
${config.prefix}event leave [name] to leave an event
${config.prefix}event list [timezone] to list events (optionally in a chosen timezone)
${config.prefix}event info [name] for info on an event
${config.prefix}event delete [name] to delete an event
${config.prefix}event servertz [name] to get/set the server's default timezone (staff only)
${config.prefix}event tz [name] to get/set your default timezone*
*This data is stored in the bot. If you exit the server it is wiped. If you'd like to wipe it yourself please use [time zone wipe command not yet implemented]`,
  cooldown: 3,
  guildOnly: true,
  staffOnly: false,
  args: true,
  async execute(message, args, client) {
    // this is the segment that is being replaced by a wizard.
    let [subcommand, ...cmdArgs] = args;
    subcommand = subcommand.toLowerCase();
    switch (subcommand) {
    case 'add':
    case 'create':
      message.channel.send('I\'ve opened a DM with you for event management.');
      return await createWizard(message);
    case 'delete':
    case 'remove':
      return deleteCommand(message, client, cmdArgs.join(' ') || undefined);
    case 'join':
      return joinCommand(message, client, cmdArgs.join(' ') || undefined);
    case 'leave':
      return leaveCommand(message, client, cmdArgs.join(' ') || undefined);
    case 'info':
      return infoCommand(message, client, cmdArgs.join(' '));
    case 'list':
      return listCommand(message, client, cmdArgs.join(' ') || undefined);
    case 'servertz':
      return servertzCommand(message, client, cmdArgs.join(' '));
    case 'tz':
      await tzCommand(message, client, cmdArgs.join(' '));
      return;
    case 'updateinfopost':
      await updateInfoPostCommand(message);
      return;
    case '':
      return message.channel.send(
        'You must specify a subcommand. See help for usage.',
      );
    default:
      return message.channel.send(
        `Unknown subcommand '${subcommand}'. See help for usage.`,
      );
    }
  },
  init(client) {
    // Ensure the client is ready so that event catch-up doesn't fail
    // due to not knowing about the channel.
    const onReady = () => {
      if (eventInfoChannel !== null) return eventInfoChannel;

      if (!config.eventInfoChannelId) {
        console.log('No event info channel set, skipping.');
      }
      else {
        console.log(
          `Retrieving event info channel: ${config.eventInfoChannelId}`,
        );
        eventInfoChannel =
          client.channels.cache.get(config.eventInfoChannelId) || null;

        if (eventInfoChannel) {console.log('Event info channel set.');}
        else {
          console.log(
            `Event info channel ${config.eventInfoChannelId} could not be found.`,
          );
        }
      }

      eventManager = new EventManager(client);
      eventManager.loadState().then(() => {
        eventManager.start();
        console.log('Event manager ready.');
      });
    };

    if (client.status !== Discord.Constants.Status.READY) {
      client.on('ready', onReady);
    }
    else {
      onReady();
    }
  },
};
