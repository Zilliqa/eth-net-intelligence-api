// ABOUTME: Regression test for the RPC lock in lib/node.js: releasing it must reset the node's chain filter state.
// ABOUTME: Loads lib/node.js in a vm context with stubbed dependencies and a fake clock; run: node --test test/

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = path.join(__dirname, '..', 'lib', 'node.js');

function loadNodeModule() {
	const clock = { now: 1_000_000 };
	const quiet = () => {};
	const stubs = {
		lodash: { now: () => clock.now },
		primus: { createSocket: () => function Socket() {} },
		chalk: new Proxy({}, { get: () => new Proxy((s) => s, { get: (t) => t }) }),
	};
	const context = {
		module: { exports: {} },
		process: { env: {} },
		// lib/utils/logger.js adds console.success, console.stats...: answer every method quietly
		console: new Proxy({}, { get: () => quiet }),
		require: (name) => stubs[name] || {},
	};
	vm.createContext(context);
	vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), context, { filename: SOURCE });
	return { context, clock };
}

test('a timed-out RPC lock is released and resets the node chain filter state', () => {
	const { context, clock } = loadNodeModule();
	const node = {
		_chainDebouncer: 7,
		_chain_debouncer_cnt: 3,
		_chan_min_time: 900,
		_max_chain_debouncer: 99,
		_lastChainLog: 123,
	};

	// An RPC call slower than RPC_SLOW_THRESHOLD engages the lock...
	const start = clock.now;
	clock.now += 15_000;
	assert.strictEqual(context.handleRpcTiming(start), true);
	assert.strictEqual(context.checkRpcLock(node), true, 'the lock holds before RPC_LOCK_TIMEOUT');

	// ...and once RPC_LOCK_TIMEOUT has passed it is released instead of crashing the agent.
	clock.now += 10_000;
	assert.strictEqual(context.checkRpcLock(node), false);
	assert.deepStrictEqual(node, {
		_chainDebouncer: 0,
		_chain_debouncer_cnt: 0,
		_chan_min_time: 50,
		_max_chain_debouncer: 20,
		_lastChainLog: 0,
	});
});
