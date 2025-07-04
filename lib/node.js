'use strict';

require('./utils/logger.js');

var os = require('os');
var Web3 = require('web3');
var web3;
var async = require('async');
var _ = require('lodash');
var debounce = require('debounce');
var pjson = require('./../package.json');
var chalk = require('chalk');

var Primus = require('primus'),
	Emitter = require('primus-emit'),
	Latency = require('primus-spark-latency'),
	Socket, socket;

var ETH_VERSION,
	NET_VERSION,
	PROTOCOL_VERSION,
	API_VERSION,
	COINBASE;

var INSTANCE_NAME = process.env.INSTANCE_NAME;
var PEER_ID = process.env.PEER_ID ? process.env.PEER_ID.toLowerCase() : undefined;
var PREFETCHED_LEADERS = 10;
var WS_SECRET = process.env.WS_SECRET || "eth-net-stats-has-a-secret";

var PENDING_WORKS = true;
var MAX_BLOCKS_HISTORY = 40;
var UPDATE_INTERVAL = process.env.UPDATE_INTERVAL || 1000;
var PING_INTERVAL = 3000;
var MINERS_LIMIT = 5;
var MAX_HISTORY_UPDATE = 50;
var MAX_CONNECTION_ATTEMPTS = 50;
var CONNECTION_ATTEMPTS_TIMEOUT = 1000;

// RPC call protection
var RPC_LOCKED = false;
var RPC_LOCK_TIMEOUT = 10000; // 10 seconds lock
var RPC_SLOW_THRESHOLD = process.env.RPC_SLOW_THRESHOLD || 2000; // 2 seconds threshold
var lastRpcLockTime = 0;

// Soft start protection
var SOFT_START_DURATION = 5000; // 5 seconds of soft start
var SOFT_START_MAX_CALLS = 3; // Maximum calls during soft start
var softStartActive = false;
var softStartCalls = 0;
var softStartTime = 0;

// Queue for blocks that arrive during lock
var pendingBlocksQueue = [];
var MAX_PENDING_BLOCKS = 50;

Socket = Primus.createSocket({
	transformer: 'websockets',
	pathname: '/api',
	strategy: 'disconnect,online,timeout',
	reconnect: {
		retries: 30
	},
	plugin: {emitter: Emitter, sparkLatency: Latency}
});

if(process.env.NODE_ENV === 'production' && INSTANCE_NAME === "")
{
	console.error("No instance name specified!");
	process.exit(1);
}

console.info('   ');
console.info('   ', 'NET STATS CLIENT');
console.success('   ', 'v' + pjson.version);
console.info('   ');
console.info('   ');

function Node ()
{
	this.info = {
		name: INSTANCE_NAME || (process.env.EC2_INSTANCE_ID || os.hostname()),
		contact: (process.env.CONTACT_DETAILS || ""),
		coinbase: null,
		node: null,
		net: null,
		protocol: null,
		api: null,
		port: (process.env.LISTENING_PORT || 3333),
		os: os.platform(),
		os_v: os.release(),
		client: PEER_ID || "non-validator", //pjson.version,
		canUpdateHistory: true,
	};

	this.id = _.camelCase(this.info.name);

	this.stats = {
		active: false,
		mining: false,
		peers: 0,
		currentView: 0,
		nextViewChange: 0,
		highQcView: 0,
		pending: 0,
		queued: 0,
		gasPrice: 0,
		block: {
			number: 0,
			hash: '?',
			difficulty: 0,
			totalDifficulty: 0,
			transactions: [],
			uncles: []
		},
		syncing: false,
		uptime: 0
	};

	this._lastBlock = 0;
	this._lastStats = JSON.stringify(this.stats);
	this._lastFetch = 0;
	this._lastPending = 0;
	this._lastQueued = 0;

	this._tries = 0;
	this._down = 0;
	this._lastSent = 0;
	this._latency = 0;

	this._web3 = false;
	this._socket = false;

	this._latestQueue = null;
	this.pendingFilter = false;
	this.chainFilter = false;
	this.updateInterval = false;
	this.pingInterval = false;
	this.connectionInterval = false;

	this._lastBlockSentAt = 0;
	this._lastChainLog = 0;
	this._lastPendingLog = 0;
	this._chainDebouncer = 0;
	this._chan_min_time = 50;
	this._max_chain_debouncer = 20;
	this._chain_debouncer_cnt = 0;
	this._connection_attempts = 0;
	this._timeOffset = null;

	this.leaders = [];

	this.startWeb3Connection();

	return this;
}

function checkRpcLock() {
	const now = _.now();
	
	if (RPC_LOCKED) {
		const lockAge = now - lastRpcLockTime;
		console.debug("Lock age:", lockAge, "ms, timeout:", RPC_LOCK_TIMEOUT, "ms");
		
		if (lockAge >= RPC_LOCK_TIMEOUT) {
			RPC_LOCKED = false;
			softStartActive = true;
			softStartTime = now;
			softStartCalls = 0;
			
			// Reset chain filter state
			self._chainDebouncer = 0;
			self._chain_debouncer_cnt = 0;
			self._chan_min_time = 50;  // Reset to initial value
			self._max_chain_debouncer = 20;  // Reset to initial value
			self._lastChainLog = 0;  // Reset chain log time
			
			console.warn("RPC lock released - entering soft start mode with reset parameters");
			return false;
		}
		return true;
	}

	if (softStartActive) {
		const softStartAge = now - softStartTime;
		console.debug("Soft start age:", softStartAge, "ms, calls:", softStartCalls);
		
		if (softStartAge < SOFT_START_DURATION) {
			if (softStartCalls >= SOFT_START_MAX_CALLS) {
				console.warn("Too many calls during soft start - re-engaging lock");
				RPC_LOCKED = true;
				lastRpcLockTime = now;
				softStartActive = false;
				softStartCalls = 0;
				return true;
			}
			softStartCalls++;
			return false;
		} else {
			console.info("Soft start completed successfully");
			softStartActive = false;
			softStartCalls = 0;
			return false;
		}
	}

	return false;
}

function handleRpcTiming(startTime) {
	const callDuration = _.now() - startTime;
	if (callDuration > RPC_SLOW_THRESHOLD) {
		// Reset all state when engaging lock
		RPC_LOCKED = true;
		lastRpcLockTime = _.now();
		softStartActive = false;
		softStartCalls = 0;
		softStartTime = 0;
		console.warn("RPC call took", callDuration, "ms - Locking for", RPC_LOCK_TIMEOUT, "ms");
		return true;
	}
	return false;
}

Node.prototype.startWeb3Connection = function()
{
	console.info('Starting web3 connection');

	web3 = new Web3();
	web3.setProvider(new web3.providers.HttpProvider('http://' + (process.env.RPC_HOST || 'localhost') + ':' + (process.env.RPC_PORT || '4202')));

	this.checkWeb3Connection();
}

Node.prototype.checkWeb3Connection = function()
{
	var self = this;

	if (!this._web3)
	{
		if(web3.isConnected()) {
			console.success('Web3 connection established');

			this._web3 = true;
			this.init();

			return true;
		}
		else
		{
			if(this._connection_attempts < MAX_CONNECTION_ATTEMPTS)
			{
				console.error('Web3 connection attempt', chalk.cyan('#' + this._connection_attempts++), 'failed');
				console.error('Trying again in', chalk.cyan(500 * this._connection_attempts + ' ms'));

				setTimeout(function ()
				{
					self.checkWeb3Connection();
				}, CONNECTION_ATTEMPTS_TIMEOUT * this._connection_attempts);
			}
			else
			{
				console.error('Web3 connection failed', chalk.cyan(MAX_CONNECTION_ATTEMPTS), 'times. Aborting...');
			}
		}
	}
}

Node.prototype.reconnectWeb3 = function()
{
	console.warn("Uninstalling filters and update interval");

	this._web3 = false;
	this._connection_attempts = 0;

	if(this.updateInterval)
		clearInterval(this.updateInterval);

	try
	{
		web3.reset(true);
	}
	catch (err)
	{
		console.error("Web3 reset error:", err);
	}

	console.info("Web3 reconnect attempts started");

	this.checkWeb3Connection();
}

Node.prototype.startSocketConnection = function()
{
	if( !this._socket )
	{
		console.info('wsc', 'Starting socket connection');

		socket = new Socket( process.env.WS_SERVER || 'ws://localhost:3000' );

		const connectionTimeout = setTimeout(() => {
			console.error('Connection timed out');
			socket.end();
		}, 120000);

		socket.on('open', () => {
			clearTimeout(connectionTimeout);
		});

		this.setupSockets();
	}
}

Node.prototype.setupSockets = function()
{
	var self = this;

	// Setup events
	socket.on('open', function open()
	{
		console.info('wsc', 'The socket connection has been opened.');
		console.info('   ', 'Trying to login');

		socket.emit('hello', {
			id: self.id,
			info: self.info,
			secret: WS_SECRET
		});
	})
	.on('ready', function()
	{
		self._socket = true;
		console.success('wsc', 'The socket connection has been established.');

		self.getLatestBlock();
		self.getPending();
		self.getStats(true);
	})
	.on('data', function incoming(data)
	{
		console.stats('Socket received some data', data);
	})
	.on('history', function (data)
	{
		console.stats('his', 'Got history request');

		self.getHistory( data );
	})
	.on('node-pong', function(data)
	{
		var now = _.now();
		var latency = Math.ceil( (now - data.clientTime) / 2 );

		socket.emit('latency', {
			id: self.id,
			latency: latency
		});
	})
	.on('end', function end()
	{
		self._socket = false;
		console.error('wsc', 'Socket connection end received');
	})
	.on('error', function error(err)
	{
		console.error('wsc', 'Socket error:', err);
	})
	.on('timeout', function ()
	{
		self._socket = false;
		console.error('wsc', 'Socket connection timeout');
	})
	.on('close', function ()
	{
		self._socket = false;
		console.error('wsc', 'Socket connection has been closed');
	})
	.on('offline', function ()
	{
		self._socket = false;
		console.error('wsc', 'Network connection is offline');
	})
	.on('online', function ()
	{
		self._socket = true;
		console.info('wsc', 'Network connection is online');
	})
	.on('reconnect', function ()
	{
		console.info('wsc', 'Socket reconnect attempt started');
	})
	.on('reconnect scheduled', function (opts)
	{
		self._socket = false;
		console.warn('wsc', 'Reconnecting in', opts.scheduled, 'ms');
		console.warn('wsc', 'This is attempt', opts.attempt, 'out of', opts.retries);
	})
	.on('reconnected', function (opts)
	{
		self._socket = true;
		console.success('wsc', 'Socket reconnected successfully after', opts.duration, 'ms');

		self.getLatestBlock();
		self.getPending();
		self.getStats(true);
	})
	.on('reconnect timeout', function (err, opts)
	{
		self._socket = false;
		console.error('wsc', 'Socket reconnect atempt took too long:', err.message);
	})
	.on('reconnect failed', function (err, opts)
	{
		self._socket = false;
		console.error('wsc', 'Socket reconnect failed:', err.message);
	});
}

Node.prototype.emit = function(message, payload)
{
	if(this._socket)
	{
		try {
			socket.emit(message, payload);
			console.sstats('wsc', 'Socket emited message:', chalk.reset.cyan(message));
			// console.success('wsc', payload);
		}
		catch (err) {
			console.error('wsc', 'Socket emit error:', err);
		}
	}
}

Node.prototype.getInfo = function()
{
	console.info('==>', 'Getting info');
	console.time('Got info');

	try {
		try {
			this.info.coinbase = web3.eth.coinbase;
		}
		catch (err) {
			this.info.coinbase = "";
		}
		this.info.node = web3.version.node;
		this.info.net = web3.version.network;
		this.info.protocol = web3.toDecimal(web3.version.ethereum);
		this.info.api = web3.version.api;

		console.timeEnd('Got info');
		console.info(this.info);

		return true;
	}
	catch (err) {
		console.error("Couldn't get version");
	}

	return false;
}

Node.prototype.setInactive = function()
{
	this.stats.active = false;
	this.stats.peers = 0;
	this.stats.currentView = 0;
	this.stats.nextViewChange = 0;
	this.stats.highQcView = 0;
	this.stats.mining = false;
	this._down++;

	this.setUptime();

	this.sendStatsUpdate(true);

	// Schedule web3 reconnect
	this.reconnectWeb3();

	return this;
}

Node.prototype.setUptime = function()
{
	this.stats.uptime = ((this._tries - this._down) / this._tries) * 100;
}

Node.prototype.formatBlock = function (block)
{
	if( !_.isNull(block) && !_.isUndefined(block) && !_.isUndefined(block.number) && block.number >= 0 && !_.isUndefined(block.difficulty) && !_.isUndefined(block.totalDifficulty) )
	{
		block.difficulty = block.difficulty.toString(10);
		block.totalDifficulty = block.totalDifficulty.toString(10);
		block.view = parseInt(block.view, 16);

		if( !_.isUndefined(block.logsBloom) )
		{
			delete block.logsBloom;
		}

		return block;
	}

	return false;
}

Node.prototype.getLatestBlock = function ()
{
	var self = this;

	if(this._web3)
	{
		if (checkRpcLock()) {
			console.warn("Skipping getLatestBlock due to RPC lock");
			return;
		}

		var timeString = 'Got block in' + chalk.reset.red('');
		console.time('==>', timeString);
		
		const startTime = _.now();
		web3.eth.getBlock('latest', false, function(error, result) {
			handleRpcTiming(startTime);
			self.validateLatestBlock(error, result, timeString);
		});
	}
}

Node.prototype.validateLatestBlock = function (error, result, timeString)
{
	console.timeEnd('==>', timeString);

	if( error )
	{
		console.error("xx>", "getLatestBlock couldn't fetch block...");
		console.error("xx>", error);

		return false;
	}

	var block = this.formatBlock(result);

	if(block === false)
	{
		console.error("xx>", "Got bad block:", chalk.reset.cyan(result));

		return false;
	}

	if( this.stats.block.number === block.number )
	{
		console.warn("==>", "Got same block:", chalk.reset.cyan(block.number));

		if( _.isEqual(JSON.stringify(this.stats.block), JSON.stringify(block)) )
			return false;

		console.stats(this.stats.block);
		console.stats(block);
		console.warn("Blocks are different... updating block");
	}

	console.sstats("==>", "Got block:", chalk.reset.red(block.number));

	this.stats.block = block;
	this.sendBlockUpdate();

	if(this.stats.block.number - this._lastBlock > 1)
	{
		var range = _.range( Math.max(this.stats.block.number - MAX_BLOCKS_HISTORY, this._lastBlock + 1), Math.max(this.stats.block.number, 0), 1 );

		if( this._latestQueue.idle() )
			this.getHistory({ list: range });
	}

	if(this.stats.block.number > this._lastBlock)
	{
		this._lastBlock = this.stats.block.number;
	}
}

Node.prototype.getStats = function(forced)
{
	var self = this;
	var now = _.now();
	var lastFetchAgo = now - this._lastFetch;
	this._lastFetch = now;

	if (this._socket)
		this._lastStats = JSON.stringify(this.stats);

	if (this._web3 && (lastFetchAgo >= UPDATE_INTERVAL || forced === true))
	{
		console.stats('==>', 'Getting stats')
		console.stats('   ', 'last update:', chalk.reset.cyan(lastFetchAgo));
		console.stats('   ', 'forced:', chalk.reset.cyan(forced === true));

		async.parallel({
			peers: function (callback)
			{
				web3.net.getPeerCount(callback);
			},
			mining: function (callback)
			{
				web3.eth.getMining(callback);
			},
			gasPrice: function (callback)
			{
				web3.eth.getGasPrice(callback);
			},
			syncing: function (callback)
			{
				web3.eth.getSyncing(callback);
			},
			consensusInfo: function (callback) {
				const payload = {
					jsonrpc: "2.0",
					method: "admin_consensusInfo",
					params: [],
					id: 1
				};

				web3.currentProvider.sendAsync(payload, function (err, response) {
					if (err) return callback(err);

					try {
						const result = response.result;
						const consensusData = {
							currentView: result.view,
							highQcView: result.high_qc && result.high_qc.view,
							nextViewChange: result.milliseconds_until_next_view_change
						};
						callback(null, consensusData);
					} catch (parseErr) {
						callback(parseErr);
					}
				});
			},
			leaders: function (callback) {
				if (self.stats.currentView % PREFETCHED_LEADERS === 0) {
					const payload = {
						jsonrpc: "2.0",
						method: "admin_getLeaders",
						params: [self.stats.currentView, PREFETCHED_LEADERS - 1],
						id: 1
					};
					web3.currentProvider.sendAsync(payload, function (err, response) {
						if (err) return callback(err);
						try {
							const result = response.result;
							callback(null, result.map(item => item[1].peer_id.toLowerCase()));
						} catch (parseErr) {
							callback(parseErr);
						}
					});
				} else 
					callback(null, []);
			}
		},
		function (err, results)
		{
			self._tries++;

			if (err) {
				console.error('xx>', 'getStats error: ', err);

				self.setInactive();

				return false;
			}

			results.end = _.now();
			results.diff = results.end - self._lastFetch;

			console.sstats('==>', 'Got getStats results in', chalk.reset.cyan(results.diff, 'ms'));

			if (results.leaders.length === PREFETCHED_LEADERS) {
				self.leaders = results.leaders;
				console.log('Prefetched leaders:', self.leaders);
			}

			if(results.peers !== null)
			{
				self.stats.active = true;
				self.stats.peers = results.peers;
				self.stats.currentView = results.consensusInfo?.currentView;
				self.stats.nextViewChange = results.consensusInfo?.nextViewChange;
				self.stats.highQcView = results.consensusInfo?.highQcView;
				self.stats.mining = self.leaders[self.stats.currentView % PREFETCHED_LEADERS] === PEER_ID; //results.mining;
				self.stats.gasPrice = results.gasPrice.toString(10);

				if(results.syncing !== false) {
					var sync = results.syncing;

					var progress = sync.currentBlock - sync.startingBlock;
					var total = sync.highestBlock - sync.startingBlock;

					sync.progress = progress/total;

					self.stats.syncing = sync;
				} else {
					self.stats.syncing = false;
				}
			}
			else {
				self.setInactive();
			}

			self.setUptime();

			self.sendStatsUpdate(forced);
		});
	}
}

Node.prototype.getPending = function()
{
	var self = this;
	var now = _.now();

	if (this._web3)
	{
		console.stats('==>', 'Getting Pending and Queued')

		const payload = {
			jsonrpc: "2.0",
			method: "txpool_status",
			params: [],
			id: 1
		};

		web3.currentProvider.sendAsync(payload, function (err, response) {
			if (err) {
				console.error('xx>', 'getPending error: ', err);
				return false;
			}

			var results = {};
			results.end = _.now();
			results.diff = results.end - now;

			try {
				// Values are already in decimal format
				const pending = parseInt(response.result.pending);
				const queued = parseInt(response.result.queued);

				console.sstats('==>', 'Got', chalk.reset.red(pending), chalk.reset.bold.green('pending tx' + (pending === 1 ? '' : 's')), 'and', chalk.reset.red(queued), chalk.reset.bold.green('queued tx' + (queued === 1 ? '' : 's')), 'in', chalk.reset.cyan(results.diff, 'ms'));

				self.stats.pending = pending;
				self.stats.queued = queued;

				if(self._lastPending !== pending || self._lastQueued !== queued)
					self.sendPendingUpdate();

				self._lastPending = pending;
				self._lastQueued = queued;
			} catch (e) {
				console.error('xx>', 'Error parsing txpool_status response:', e);
				console.error('xx>', 'Response was:', response);
			}
		});
	}
}

Node.prototype.getHistory = function (range)
{
	var self = this;

	var history = [];
	var interv = [];

	console.time('=H=', 'his', 'Got history in');

	if ( _.isUndefined(range) || range === null)
		interv = _.range(this.stats.block.number - 1, this.stats.block.number - MAX_HISTORY_UPDATE);

	if (!_.isUndefined(range.list))
		interv = range.list;

	console.stats('his', 'Getting history from', chalk.reset.cyan(interv[0]), 'to', chalk.reset.cyan(interv[interv.length - 1]));

	async.mapSeries(interv, function (number, callback)
	{
		web3.eth.getBlock(number, false, callback);
	},
	function (err, results)
	{
		if (err) {
			console.error('his', 'history fetch failed:', err);

			results = [];
		}
		else
		{
			for(var i=0; i < results.length; i++)
			{
				results[i] = self.formatBlock(results[i]);
			}
		}

		self.emit('history', {
			id: self.id,
			history: results.reverse()
		});

		console.timeEnd('=H=', 'his', 'Got history in');
	});
}

Node.prototype.changed = function ()
{
	var changed = ! _.isEqual( this._lastStats, JSON.stringify(this.stats) );

	return changed;
}

Node.prototype.prepareBlock = function ()
{
	return {
		id: this.id,
		block: this.stats.block
	};
}

Node.prototype.preparePending = function ()
{
	return {
		id: this.id,
		stats: {
			pending: this.stats.pending,
			queued: this.stats.queued
		}
	};
}

Node.prototype.prepareStats = function ()
{
	return {
		id: this.id,
		stats: {
			active: this.stats.active,
			syncing: this.stats.syncing,
			mining: this.stats.mining,
			peers: this.stats.peers,
			currentView: this.stats.currentView,
			nextViewChange: this.stats.nextViewChange,
			highQcView: this.stats.highQcView,
			gasPrice: this.stats.gasPrice,
			uptime: this.stats.uptime,
			pending: this.stats.pending,
			queued: this.stats.queued
		}
	};
}

Node.prototype.sendBlockUpdate = function()
{
	this._lastBlockSentAt = _.now();
	console.stats("wsc", "Sending", chalk.reset.red("block"), chalk.bold.white("update"));
	this.emit('block', this.prepareBlock());
}

Node.prototype.sendPendingUpdate = function()
{
	console.stats("wsc", "Sending pending update");
	this.emit('pending', this.preparePending());
}

Node.prototype.sendStatsUpdate = function (force)
{
	if( this.changed() || force ) {
		console.stats("wsc", "Sending", chalk.reset.blue((force ? "forced" : "changed")), chalk.bold.white("update"));
		var stats = this.prepareStats();
		console.info(stats);
		this.emit('stats', stats);
		// this.emit('stats', this.prepareStats());
	}
}

Node.prototype.ping = function()
{
	this._latency = _.now();
	socket.emit('node-ping', {
		id: this.id,
		clientTime: _.now()
	});
};

Node.prototype.setWatches = function()
{
	var self = this;

	this.setFilters();

	this.updateInterval = setInterval( function(){

		self.getLatestBlock();
		self.getPending();
		self.getStats();
	}, UPDATE_INTERVAL);

	if( !this.pingInterval )
	{
		this.pingInterval = setInterval( function(){
			self.ping();
		}, PING_INTERVAL);
	}

	web3.eth.isSyncing(function(error, sync) {
		if(!error) {
			if(sync === true) {
				web3.reset(true);
				console.info("SYNC STARTED:", sync);
			} else if(sync) {
				var synced = sync.currentBlock - sync.startingBlock;
				var total = sync.highestBlock - sync.startingBlock;
				sync.progress = synced/total;
				self.stats.syncing = sync;

				if(self._lastBlock !== sync.currentBlock) {
					self._latestQueue.push(sync.currentBlock);
				}
				console.info("SYNC UPDATE:", sync);
			} else {
				console.info("SYNC STOPPED:", sync);
				self.stats.syncing = false;
				self.setFilters();
			}
		} else {
			self.stats.syncing = false;
			self.setFilters();
			console.error("SYNC ERROR", error);
		}
	});
}

Node.prototype.setFilters = function()
{
	var self = this;

	this._latestQueue = async.queue(function (hash, callback)
	{
		if (checkRpcLock()) {
			console.warn("Dropping block due to RPC lock:", hash);
			callback();
			return;
		}

		var timeString = 'Got block ' + chalk.reset.red(hash) + chalk.reset.bold.white(' in') + chalk.reset.green('');

		console.time('==>', timeString);

		const startTime = _.now();
		web3.eth.getBlock(hash || 'latest', false, function (error, result)
		{
			handleRpcTiming(startTime);
			self.validateLatestBlock(error, result, timeString);
			callback();
		});
	}, 1);

	this._latestQueue.drain(() => {
		console.sstats("Finished processing", 'latest', 'queue');
		self.getPending();
	});

	this._debouncedChain = debounce(function(hash) {
		console.stats('>>>', 'Debounced');
		self._latestQueue.push(hash);
	}, 120);

	this._debouncedPending = debounce(function() {
		if (!checkRpcLock()) {
			self.getPending();
		} else {
			console.warn("Skipping pending update due to RPC lock");
		}
	}, 5);

	try {
		this.chainFilter = web3.eth.filter('latest');
		this.chainFilter.watch( function (err, hash)
		{
			var now = _.now();
			var time = now - self._lastChainLog;
			self._lastChainLog = now;

			if(hash === null)
			{
				hash = web3.eth.blockNumber;
			}

			console.stats('>>>', 'Chain Filter triggered: ', chalk.reset.red(hash), '- last trigger:', chalk.reset.cyan(time));

			if(time < self._chan_min_time)
			{
				self._chainDebouncer++;
				self._chain_debouncer_cnt++;

				if(self._chain_debouncer_cnt > 100)
				{
					self._chan_min_time = Math.max(self._chan_min_time + 1, 200);
					self._max_chain_debouncer = Math.max(self._max_chain_debouncer - 1, 5);
				}
			}
			else
			{
				if(time > 5000)
				{
					self._chan_min_time = 50;
					self._max_chain_debouncer = 20;
					self._chain_debouncer_cnt = 0;
				}
				// reset local chain debouncer
				self._chainDebouncer = 0;
			}

			if(self._chainDebouncer < self._max_chain_debouncer || now - self._lastBlockSentAt > 5000)
			{
				if(now - self._lastBlockSentAt > 5000)
				{
					self._lastBlockSentAt = now;
				}

				self._latestQueue.push(hash);
			}
			else
			{
				self._debouncedChain(hash);
			}
		});

		console.success("Installed chain filter");
	}
	catch (err)
	{
		this.chainFilter = false;

		console.error("Couldn't set up chain filter");
		console.error(err);
	}

	try {
		this.pendingFilter = web3.eth.filter('pending');
		this.pendingFilter.watch( function (err, hash)
		{
			var now = _.now();
			var time = now - self._lastPendingLog;
			self._lastPendingLog = now;

			console.stats('>>>', 'Pending Filter triggered:', chalk.reset.red(hash), '- last trigger:', chalk.reset.cyan(time));

			if(time > 50)
			{
				if (!checkRpcLock()) {
					self.getPending();
				}
			}
			else
			{
				self._debouncedPending();
			}
		});

		console.success("Installed pending filter");
	}
	catch (err)
	{
		this.pendingFilter = false;

		console.error("Couldn't set up pending filter");
		console.error(err);
	}
}

Node.prototype.init = function()
{
	// Fetch node info
	this.getInfo();

	// Start socket connection
	this.startSocketConnection();

	// Set filters
	this.setWatches();
}

Node.prototype.stop = function()
{
	if(this._socket)
		socket.end();

	if(this.updateInterval)
		clearInterval(this.updateInterval);

	if(this.pingInterval)
		clearInterval(this.pingInterval);

	web3.reset(false);
}

module.exports = Node;
