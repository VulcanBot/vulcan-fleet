import * as Eris from "eris";
import {worker} from "cluster";
import {BaseClusterWorker} from "./BaseClusterWorker";
import {inspect} from "util";
import * as Admiral from "../sharding/Admiral";
import { CentralRequestHandler } from "../util/CentralRequestHandler";
import { IPC } from "../util/IPC";

interface ClusterInput {
	erisClient: typeof Eris.Client;
}

export class Cluster {
	private erisClient: typeof Eris.Client;
	firstShardID!: number;
	lastShardID!: number;
	path!: string;
	clusterID!: number;
	clusterCount!: number;
	shardCount!: number;
	shards!: number;
	clientOptions!: Eris.ClientOptions;
	whatToLog!: string[];
	useCentralRequestHandler!: boolean;
	bot!: Eris.Client;
	private token!: string;
	app?: BaseClusterWorker;
	App!: any;
	ipc: IPC;
	shutdown?: boolean;
	private startingStatus?: Admiral.StartingStatus;

	constructor(input: ClusterInput) {
		this.erisClient = input.erisClient;
		// add ipc
		this.ipc = new IPC();

		console.log = (str: unknown) => {this.ipc.log(str);};
		console.debug = (str: unknown) => {this.ipc.debug(str);};
		console.error = (str: unknown) => {this.ipc.error(str);};
		console.warn = (str: unknown) => {this.ipc.warn(str);};

		//Spawns
		process.on("uncaughtException", (err: Error) => {
			this.ipc.error(err);
		});

		process.on("unhandledRejection", (reason, promise) => {
			this.ipc.error("Unhandled Rejection at: " + inspect(promise) + " reason: " + reason);
		});

		if (process.send) process.send({op: "launched"});
		
		process.on("message", async message => {
			if (message.op) {
				switch (message.op) {
				case "connect": {
					this.firstShardID = message.firstShardID;
					this.lastShardID = message.lastShardID;
					this.path = message.path;
					this.clusterID = message.clusterID;
					this.clusterCount = message.clusterCount;
					this.shardCount = message.shardCount;
					this.shards = (this.lastShardID - this.firstShardID) + 1;
					this.clientOptions = message.clientOptions;
					this.token = message.token;
					this.whatToLog = message.whatToLog;
					this.useCentralRequestHandler = message.useCentralRequestHandler;
					if (message.startingStatus) this.startingStatus = message.startingStatus;

					if (this.shards < 0) return;
					this.connect();

					break;
				}
				case "fetchUser": {
					if (!this.bot) return;
					const user = this.bot.users.get(message.id);
					if (user) {
						if (process.send) process.send({op: "return", value: user, UUID: message.UUID});
					} else {
						if (process.send) process.send({op: "return", value: {id: message.id, noValue: true}, UUID: message.UUID});
					}
						
					break;
				}
				case "fetchChannel": {
					if (!this.bot) return;
					const channel = this.bot.getChannel(message.id);
					if (channel) {
						if (process.send) process.send({op: "return", value: channel, UUID: message.UUID});
					} else {
						if (process.send) process.send({op: "return", value: {id: message.id, noValue: true}, UUID: message.UUID});
					}

					break;
				}
				case "fetchGuild": {
					if (!this.bot) return;
					const guild = this.bot.guilds.get(message.id);
					if (guild) {
						if (process.send) process.send({op: "return", value: guild, UUID: message.UUID});
					} else {
						if (process.send) process.send({op: "return", value: {id: message.id, noValue: true}, UUID: message.UUID});
					}

					break;
				}
				case "fetchMember": {
					if (!this.bot) return;
					const messageParsed = JSON.parse(message.id);
					const guild = this.bot.guilds.get(messageParsed.guildID);
					if (guild) {
						const member = (await guild.fetchMembers({userIDs: [messageParsed.memberID], presences: true}))[0];
						if (member) {
							const clean = member.toJSON();
							clean.id = message.id;
							if (process.send) process.send({op: "return", value: clean, UUID: message.UUID});
						} else {
							if (process.send) process.send({op: "return", value: {id: message.id, noValue: true}, UUID: message.UUID});
						}
					} else {
						if (process.send) process.send({op: "return", value: {id: message.id, noValue: true}, UUID: message.UUID});
					}

					break;
				}
				case "command": {
					const noHandle = () => {
						const res = {err: `Cluster ${this.clusterID} cannot handle commands!`};
						if (process.send) process.send({op: "return", value: {
							id: message.command.UUID,
							value: res
						}, UUID: message.UUID});
						console.error("I can't handle commands!");
					};
					if (this.app) {
						if (this.app.handleCommand) {
							const res = await this.app.handleCommand(message.command.msg);
							if (message.command.receptive) {
								if (process.send) process.send({op: "return", value: {
									id: message.command.UUID,
									value: res
								}, UUID: message.UUID});
							}
						} else {
							noHandle();
						}
					} else {
						noHandle();
					}

					break;
				}
				case "eval": {
					const errorEncountered = (err: unknown) => {
						if (message.request.receptive) {
							if (process.send) process.send({op: "return", value: {
								id: message.request.UUID,
								value: {err}
							}, UUID: message.UUID});
						}
					};
					if (this.app) {
						this.app.runEval(message.request.stringToEvaluate)
							.then((res: unknown) => {
								if (message.request.receptive) {
									if (process.send) process.send({op: "return", value: {
										id: message.request.UUID,
										value: res
									}, UUID: message.UUID});
								}
							}).catch((error: unknown) => {
								errorEncountered(error);
							});
					} else {
						errorEncountered("Cluster is not ready!");
					}

					break;
				}
				case "return": {
					if (this.app) this.app.ipc.emit(message.id, message.value);
					break;
				}
				case "collectStats": {
					if (!this.bot) return;
					const shardStats: { id: number; ready: boolean; latency: number; status: string; guilds: number; users: number;}[] = [];
					const getShardUsers = (id: number) => {
						let users = 0;
						for(const [key, value] of Object.entries(this.bot.guildShardMap)) {
							const guild = this.bot.guilds.get(key);
							if (Number(value) == id && guild) users += guild.memberCount;
						}
						return users;
					};
					this.bot.shards.forEach(shard => {
						shardStats.push({
							id: shard.id,
							ready: shard.ready,
							latency: shard.latency,
							status: shard.status,
							guilds: Object.values(this.bot.guildShardMap).filter(e => e == shard.id).length,
							users: getShardUsers(shard.id)
						});
					});
					if (process.send) process.send({op: "collectStats", stats: {
						guilds: this.bot.guilds.size,
						users: this.bot.users.size,
						uptime: this.bot.uptime,
						voice: this.bot.voiceConnections.size,
						largeGuilds: this.bot.guilds.filter(g => g.large).length,
						shardStats: shardStats,
						shards: shardStats,
						ram: process.memoryUsage().rss / 1e6
					}});

					break;
				}
				case "shutdown": {
					this.shutdown = true;
					if (this.app) {
						if (this.app.shutdown) {
							// Ask app to shutdown
							this.app.shutdown(() => {
								this.bot.disconnect({reconnect: false});
								if (process.send) process.send({op: "shutdown"});
							});
						} else {
							this.bot.disconnect({reconnect: false});
							if (process.send) process.send({op: "shutdown"});
						}
					} else {
						if (this.bot) this.bot.disconnect({reconnect: false});
						if (process.send) process.send({op: "shutdown"});
					}

					break;
				}
				case "loadCode": {
					this.loadCode();

					break;
				}
				}
			}
		});
	}

	private async connect() {
		if (this.whatToLog.includes("cluster_start")) console.log(`Connecting with ${this.shards} shard(s)`);

		const options = Object.assign(this.clientOptions, {autoreconnect: true, firstShardID: this.firstShardID, lastShardID: this.lastShardID, maxShards: this.shardCount});

		let App = (await import(this.path));

		let bot;
		if (App.Eris) {
			bot = new App.Eris.Client(this.token, options);
			App = App.BotWorker;
		} else {
			bot = new this.erisClient(this.token, options);
			if (App.BotWorker) {
				App = App.BotWorker;
			} else {
				App = App.default ? App.default : App;
			}
		}

		// central request handler
		if (this.useCentralRequestHandler) {
			bot.requestHandler = new CentralRequestHandler(App.ipc, {
				timeout: bot.options.requestTimeout
			});
		}

		this.bot = bot;

		const setStatus = () => {
			if (this.startingStatus) {
				if (this.startingStatus.game) {
					this.bot.editStatus(this.startingStatus.status, this.startingStatus.game);
				} else {
					this.bot.editStatus(this.startingStatus.status);
				}
			}
		};

		bot.on("connect", (id: number) => {
			if (this.whatToLog.includes("shard_connect")) console.log(`Shard ${id} connected!`);
		});

		bot.on("shardDisconnect", (err: Error, id: number) => {
			if (!this.shutdown) if (this.whatToLog.includes("shard_disconnect")) console.log(`Shard ${id} disconnected with error: ${inspect(err)}`);
		});

		bot.once("shardReady", () => {
			setStatus();
		});

		bot.on("shardReady", (id: number) => {
			if (this.whatToLog.includes("shard_ready")) console.log(`Shard ${id} is ready!`);
		});

		bot.on("shardResume", (id: number) => {
			if (this.whatToLog.includes("shard_resume")) console.log(`Shard ${id} has resumed!`);
		});

		bot.on("warn", (message: string, id?: number) => {
			this.ipc.warn(message, `Cluster ${this.clusterID}, Shard ${id}`);
		});

		bot.on("error", (error: Error, id?: number) => {
			this.ipc.error(error, `Cluster ${this.clusterID}, Shard ${id}`);
		});

		bot.on("ready", () => {
			if (this.whatToLog.includes("cluster_ready")) console.log(`Shards ${this.firstShardID} - ${this.lastShardID} are ready!`);
		});

		bot.once("ready", () => {
			this.App = App;
			if (process.send) process.send({op: "connected"});
		});

		// Connects the bot
		bot.connect();
	}

	
	private async loadCode() {
		//let App = (await import(this.path)).default;
		//App = App.default ? App.default : App;
		this.app = new this.App({bot: this.bot, clusterID: this.clusterID, workerID: worker.id, ipc: this.ipc});
	}
}