'use strict';

require('./utils/logger.js');

var os = require('os');
const { Web3 } = require('web3');
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
var WS_SECRET = process.env.WS_SECRET || "eth-net-stats-has-a-secret";

var PENDING_WORKS = true;
var MAX_BLOCKS_HISTORY = 4;
var UPDATE_INTERVAL = 2000;
var PING_INTERVAL = 3000;
var MINERS_LIMIT = 5;
var MAX_HISTORY_UPDATE = 5;
var MAX_CONNECTION_ATTEMPTS = 50;
var CONNECTION_ATTEMPTS_TIMEOUT = 1000;

Socket = Primus.createSocket({
	transformer: 'websockets',
	pathname: '/api',
	strategy: 'disconnect,online,timeout',
	reconnect: {
		retries: 30
	},
	plugin: {emitter: Emitter, sparkLatency: Latency},
	// Add custom encoder to handle BigInt
	encoder: function(data, fn) {
		try {
			const serializedData = JSON.stringify(replaceBigInts(data));
			fn(null, serializedData);
		} catch (err) {
			fn(err);
		}
	}
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

// Add this helper function at the top level
function replaceBigInts(obj) {
	if (obj === null || obj === undefined) {
		return obj;
	}
	if (typeof obj === 'bigint') {
		return obj.toString();
	}
	if (Array.isArray(obj)) {
		return obj.map(replaceBigInts);
	}
	if (typeof obj === 'object') {
		const newObj = {};
		for (const key in obj) {
			newObj[key] = replaceBigInts(obj[key]);
		}
		return newObj;
	}
	return obj;
}

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
		client: pjson.version,
		canUpdateHistory: true,
	};

	this.id = _.camelCase(this.info.name);

	// Add cache for values that don't change frequently
	this._cache = {
		mining: {
			timestamp: 0,
			value: false,
			ttl: 10000 // Cache mining status for 10 seconds
		},
		gasPrice: {
			timestamp: 0,
			value: '0',
			ttl: 5000 // Cache gas price for 5 seconds
		},
		// Add block cache
		block: {
			timestamp: 0,
			value: null,
			ttl: 500, // Cache blocks for 500ms to prevent duplicate fetches
			pending: new Set() // Track pending block numbers to prevent duplicate requests
		}
	};

	this.stats = {
		active: false,
		mining: false,
		peers: 0,
        currentView: 0,
        nextViewChange: 0,
        highQcView: 0,
		pending: 0,
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

	this.startWeb3Connection();

	return this;
}

Node.prototype.startWeb3Connection = async function()
{
	console.info('Starting web3 connection');

	const wsUrl = 'ws://' + (process.env.RPC_HOST || 'localhost') + ':' + (process.env.WS_PORT || '4201');
	const httpUrl = 'http://' + (process.env.RPC_HOST || 'localhost') + ':' + (process.env.RPC_PORT || '4202');

	try {
		// Try WebSocket first for subscriptions
		web3 = new Web3(wsUrl);
		console.info('Connected via WebSocket');
	} catch (e) {
		console.warn('WebSocket connection failed, falling back to HTTP');
		// Fallback to HTTP if WebSocket fails
		web3 = new Web3(httpUrl);
	}

	this.checkWeb3Connection();
}

Node.prototype.checkWeb3Connection = async function()
{
	var self = this;

	if (!this._web3)
	{
		try {
			const isConnected = await web3.eth.net.isListening();
			if(isConnected) {
				console.success('Web3 connection established');

				this._web3 = true;
				this.init();

				return true;
			}
		} catch (err) {
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
			info: replaceBigInts(self.info),
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
			socket.emit(message, replaceBigInts(payload));
			console.sstats('wsc', 'Socket emited message:', chalk.reset.cyan(message));
		}
		catch (err) {
			console.error('wsc', 'Socket emit error:', err);
		}
	}
}

Node.prototype.getInfo = async function()
{
	console.info('==>', 'Getting info');
	console.time('Got info');

	try {
		try {
			const accounts = await web3.eth.getAccounts();
			this.info.coinbase = accounts[0] || "";
		}
		catch (err) {
			this.info.coinbase = "";
		}

		const clientVersion = await web3.eth.getNodeInfo();
		this.info.node = clientVersion;
		
		const networkId = await web3.eth.net.getId();
		this.info.net = networkId.toString();
		
		const chainId = await web3.eth.getChainId();
		this.info.protocol = chainId.toString();
		
		this.info.api = web3.version;

		console.timeEnd('Got info');
		console.info(this.info);

		return true;
	}
	catch (err) {
		console.error("Couldn't get version");
		console.error(err);
	}

	return false;
}

Node.prototype.setInactive = function()
{
	this.stats.active = false;
	this.stats.peers = 0;
    this.currentView = 0;
    this.nextViewChange = 0;
    this.highQcView = 0;
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
		// Convert all numeric fields to strings to avoid BigInt mixing issues
		block = replaceBigInts(block);
		
		if( !_.isUndefined(block.logsBloom) )
		{
			delete block.logsBloom;
		}

		return block;
	}

	return false;
}

Node.prototype.getCachedBlock = function(numberOrHash) {
	const cache = this._cache.block;
	const now = _.now();

	// If we have a cached block and it's still valid
	if (cache.value && now - cache.timestamp < cache.ttl) {
		const cachedBlock = cache.value;
		// If the request matches our cached block
		if (numberOrHash === 'latest' || 
			numberOrHash === cachedBlock.hash ||
			numberOrHash === cachedBlock.number) {
			return cachedBlock;
		}
	}
	return null;
}

Node.prototype.setCachedBlock = function(block) {
	if (!block) return;
	this._cache.block.value = block;
	this._cache.block.timestamp = _.now();
	// Remove this block number from pending set
	this._cache.block.pending.delete(block.number);
}

Node.prototype.isBlockRequestPending = function(numberOrHash) {
	const cache = this._cache.block;
	// Convert hash to number if possible
	let blockNum = numberOrHash;
	if (typeof numberOrHash === 'string' && numberOrHash.startsWith('0x')) {
		// For now we can't track hashes, so return false
		return false;
	}
	return cache.pending.has(blockNum);
}

Node.prototype.setBlockRequestPending = function(numberOrHash) {
	const cache = this._cache.block;
	// Convert hash to number if possible
	let blockNum = numberOrHash;
	if (typeof numberOrHash === 'string' && numberOrHash.startsWith('0x')) {
		// For hashes we can't track pending state
		return;
	}
	cache.pending.add(blockNum);
}

Node.prototype.getLatestBlock = async function ()
{
	var self = this;

	if(this._web3)
	{
		var timeString = 'Got block in' + chalk.reset.red('');
		console.time('==>', timeString);

		try {
			// Check cache first
			const cachedBlock = this.getCachedBlock('latest');
			if (cachedBlock) {
				console.sstats('==>', 'Using cached block:', chalk.reset.cyan(cachedBlock.number));
				self.validateLatestBlock(null, cachedBlock, timeString);
				return;
			}

			// If a request for this block is already pending, skip
			if (this.isBlockRequestPending('latest')) {
				console.sstats('==>', 'Block request already pending, skipping');
				return;
			}

			// Mark request as pending
			this.setBlockRequestPending('latest');

			const result = await web3.eth.getBlock('latest', false);
			// Cache the result
			this.setCachedBlock(result);
			self.validateLatestBlock(null, result, timeString);
		} catch (error) {
			self.validateLatestBlock(error, null, timeString);
		}
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

	// Convert both numbers to strings for comparison
	const currentBlockNum = String(this.stats.block.number || '0');
	const newBlockNum = String(block.number);

	if(currentBlockNum === newBlockNum)
	{
		console.warn("==>", "Got same block:", chalk.reset.cyan(newBlockNum));

		if(_.isEqual(JSON.stringify(replaceBigInts(this.stats.block)), JSON.stringify(block)))
			return false;

		console.stats(this.stats.block);
		console.stats(block);
		console.warn("Blocks are different... updating block");
	}

	console.sstats("==>", "Got block:", chalk.reset.red(newBlockNum));

	this.stats.block = block;
	this.sendBlockUpdate();

	const lastBlockNum = parseInt(this._lastBlock) || 0;
	const newBlockNumInt = parseInt(newBlockNum);

	// Always update last block number if new block is higher
	if(newBlockNumInt > lastBlockNum)
	{
		this._lastBlock = newBlockNumInt;
		
		// Clear block cache when moving to new block
		this._cache.block.value = null;
		this._cache.block.timestamp = 0;
		this._cache.block.pending.clear();
	}

	// Request history if we missed blocks
	if(newBlockNumInt - lastBlockNum > 1)
	{
		var range = _.range(Math.max(newBlockNumInt - MAX_BLOCKS_HISTORY, lastBlockNum + 1), Math.max(newBlockNumInt, 0), 1);

		if(this._latestQueue.idle())
			this.getHistory({ list: range });
	}
}

Node.prototype.getCachedValue = function(key) {
	const cache = this._cache[key];
	if (!cache) return null;

	const now = _.now();
	if (now - cache.timestamp < cache.ttl) {
		return cache.value;
	}
	return null;
}

Node.prototype.setCachedValue = function(key, value) {
	if (!this._cache[key]) return;
	this._cache[key].value = value;
	this._cache[key].timestamp = _.now();
}

Node.prototype.getStats = async function(forced)
{
	var self = this;
	var now = _.now();
	var lastFetchAgo = now - this._lastFetch;
	this._lastFetch = now;

	if (this._socket)
		this._lastStats = JSON.stringify(replaceBigInts(this.stats));

	if (this._web3 && (lastFetchAgo >= UPDATE_INTERVAL || forced === true))
	{
		console.stats('==>', 'Getting stats')
		console.stats('   ', 'last update:', chalk.reset.cyan(lastFetchAgo));
		console.stats('   ', 'forced:', chalk.reset.cyan(forced === true));

		try {
			// Always fetch peers and syncing status
			const [peers, syncing] = await Promise.all([
				web3.eth.net.getPeerCount(),
				web3.eth.isSyncing()
			]);

			// Check cache for mining status
			let mining = this.getCachedValue('mining');
			if (mining === null) {
				mining = await web3.eth.isMining();
				this.setCachedValue('mining', mining);
			}

			// Check cache for gas price
			let gasPrice = this.getCachedValue('gasPrice');
			if (gasPrice === null) {
				gasPrice = await web3.eth.getGasPrice();
				this.setCachedValue('gasPrice', gasPrice);
			}

			// Always get fresh consensus info
			let consensusInfo = {
				currentView: this.stats.currentView,
				highQcView: this.stats.highQcView,
				nextViewChange: this.stats.nextViewChange
			};

			try {
				const payload = {
					jsonrpc: "2.0",
					method: "admin_consensusInfo",
					params: [],
					id: 1
				};

				const response = await new Promise((resolve, reject) => {
					web3.currentProvider.send(payload, (err, response) => {
						if (err) reject(err);
						else resolve(response);
					});
				});

				if (response && response.result) {
					consensusInfo = {
						currentView: response.result.view,
						highQcView: response.result.high_qc && response.result.high_qc.view,
						nextViewChange: response.result.milliseconds_until_next_view_change
					};
				}
			} catch (err) {
				console.error('Consensus info error:', err);
			}

			self._tries++;

			const results = {
				peers: String(peers),
				mining,
				gasPrice: gasPrice.toString(),
				syncing,
				consensusInfo: replaceBigInts(consensusInfo),
				end: _.now(),
				diff: _.now() - self._lastFetch
			};

			console.sstats('==>', 'Got getStats results in', chalk.reset.cyan(results.diff, 'ms'));

			if(results.peers !== null)
			{
				self.stats.active = true;
				self.stats.peers = results.peers;
				self.stats.currentView = results.consensusInfo.currentView;
				self.stats.nextViewChange = results.consensusInfo.nextViewChange;
				self.stats.highQcView = results.consensusInfo.highQcView;
				self.stats.mining = results.mining;
				self.stats.gasPrice = results.gasPrice;

				if(results.syncing !== false) {
					var sync = replaceBigInts(results.syncing);
					var progress = Number(sync.currentBlock) - Number(sync.startingBlock);
					var total = Number(sync.highestBlock) - Number(sync.startingBlock);
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

		} catch (err) {
			console.error('xx>', 'getStats error: ', err);
			self.setInactive();
			return false;
		}
	}
}

Node.prototype.getPending = async function()
{
	var self = this;
	var now = _.now();

	if (this._web3)
	{
		console.stats('==>', 'Getting Pending')

		try {
			const pending = await web3.eth.getBlockTransactionCount('pending');
			
			var results = {};
			results.end = _.now();
			results.diff = results.end - now;

			console.sstats('==>', 'Got', chalk.reset.red(pending) , chalk.reset.bold.green('pending tx'+ (pending === 1 ? '' : 's') + ' in'), chalk.reset.cyan(results.diff, 'ms'));

			self.stats.pending = pending;

			if(self._lastPending !== pending)
				self.sendPendingUpdate();

			self._lastPending = pending;
		} catch (err) {
			console.error('xx>', 'getPending error: ', err);
			return false;
		}
	}
}

Node.prototype.getHistory = async function (range)
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

	try {
		const results = await Promise.all(
			interv.map(number => web3.eth.getBlock(number, false))
		);

		const formattedResults = results.map(block => self.formatBlock(block));

		self.emit('history', {
			id: self.id,
			history: formattedResults.reverse()
		});

		console.timeEnd('=H=', 'his', 'Got history in');
	} catch (err) {
		console.error('his', 'history fetch failed:', err);
		self.emit('history', {
			id: self.id,
			history: []
		});
	}
}

Node.prototype.changed = function ()
{
	const currentStats = JSON.stringify(replaceBigInts(this.stats));
	var changed = this._lastStats !== currentStats;
	return changed;
}

Node.prototype.prepareBlock = function ()
{
	return {
		id: this.id,
		block: replaceBigInts(this.stats.block)
	};
}

Node.prototype.preparePending = function ()
{
	return {
		id: this.id,
		stats: {
			pending: this.stats.pending
		}
	};
}

Node.prototype.prepareStats = function ()
{
	return {
		id: this.id,
		stats: replaceBigInts(this.stats)
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

	this._latestQueue = async.queue(async function (hash, callback)
	{
		var timeString = 'Got block ' + chalk.reset.red(hash) + chalk.reset.bold.white(' in') + chalk.reset.green('');

		console.time('==>', timeString);

		try {
			// Check cache first
			const cachedBlock = self.getCachedBlock(hash);
			if (cachedBlock) {
				console.sstats('==>', 'Using cached block:', chalk.reset.cyan(cachedBlock.number));
				self.validateLatestBlock(null, cachedBlock, timeString);
				callback();
				return;
			}

			// If a request for this block is already pending, skip
			if (self.isBlockRequestPending(hash)) {
				console.sstats('==>', 'Block request already pending, skipping');
				callback();
				return;
			}

			// Mark request as pending
			self.setBlockRequestPending(hash);

			const result = await web3.eth.getBlock(hash || 'latest', false);
			// Cache the result
			self.setCachedBlock(result);
			self.validateLatestBlock(null, result, timeString);
		} catch (error) {
			self.validateLatestBlock(error, null, timeString);
		}

		callback();
	}, 1);

	this._latestQueue.drain(() => {
		console.sstats("Finished processing", 'latest', 'queue');
		self.getPending();
	});

	// Increase debounce time for block subscription
	this._debouncedChain = debounce(function(hash) {
		console.stats('>>>', 'Debounced');
		self._latestQueue.push(hash);
	}, 250); // Increased from 120ms to 250ms

	this._debouncedPending = debounce(function() {
		self.getPending();
	}, 5);

	try {
		// Subscribe to new blocks with optimized handling
		const subscription = web3.eth.subscribe('newBlockHeaders', function(error, result) {
			if (!error) {
				const hash = result.hash;
				var now = _.now();
				var time = now - self._lastChainLog;
				self._lastChainLog = now;

				if(hash === null) {
					hash = result.number;
				}

				console.stats('>>>', 'New block received: ', chalk.reset.red(hash), '- last trigger:', chalk.reset.cyan(time));

				// More aggressive debouncing for frequent updates
				if(time < self._chan_min_time)
				{
					self._chainDebouncer++;
					self._chain_debouncer_cnt++;

					if(self._chain_debouncer_cnt > 50) // Reduced from 100 to 50
					{
						self._chan_min_time = Math.max(self._chan_min_time + 2, 250); // More aggressive time increase
						self._max_chain_debouncer = Math.max(self._max_chain_debouncer - 1, 3); // Reduced minimum from 5 to 3
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
					self._chainDebouncer = 0;
				}

				// Check if we already have this block cached
				if (self.getCachedBlock(hash)) {
					console.sstats('==>', 'Block already cached, skipping');
					return;
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
			}
		});

		// Subscribe to pending transactions
		const pendingSubscription = web3.eth.subscribe('pendingTransactions', function(error, result) {
			if (!error) {
				var now = _.now();
				var time = now - self._lastPendingLog;
				self._lastPendingLog = now;

				console.stats('>>>', 'Pending transaction received:', chalk.reset.red(result), '- last trigger:', chalk.reset.cyan(time));

				if(time > 50)
				{
					self.getPending();
				}
				else
				{
					self._debouncedPending();
				}
			}
		});

		this.chainFilter = subscription;
		this.pendingFilter = pendingSubscription;

		console.success("Installed filters");
	}
	catch (err)
	{
		this.chainFilter = false;
		this.pendingFilter = false;

		console.error("Couldn't set up filters");
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
