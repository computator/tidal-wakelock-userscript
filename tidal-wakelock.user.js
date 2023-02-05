'use strict;'
// ==UserScript==
// @name Tidal Playback Wakelock
// @description Sets a wakelock while Tidal is playing to keep the screen unlocked
// @match https://listen.tidal.com/*
// @version 0.1
// ==/UserScript==

class TidalPlaybackWatcher extends EventTarget {
	player;
	watching = false;
	state;
	observer;

	static state_map = {
			"PLAYING": 'playing',
			"STALLED": 'playing',

			"NOT_PLAYING": 'paused',
			"IDLE": 'paused',
		};

	constructor(player) {
		super();
		this.player = player;
		try {
			this.checkAttachable()
		}
		catch (e) {
			throw new Error(`Unable to watch playback state: ${e}`, {cause: e});
		}
		this.observer = new MutationObserver(this.attr_change_handler);
	}

	checkAttachable() {
		if(!this.player.dataset)
			throw new Error("player is missing 'dataset'");
		if(this.player.dataset.testPlaybackState === undefined)
			throw new Error("player is missing 'testPlaybackState' dataset value");
		if(!this.player.dataset.testPlaybackState)
			throw new Error("player 'testPlaybackState' is empty");
		if(!['PLAYING', 'NOT_PLAYING'].includes(this.player.dataset.testPlaybackState))
			throw new Error(`player 'testPlaybackState' has unrecognized state '${this.player.dataset.testPlaybackState}'`);
	}

	player_state() {
		const state = this.player.dataset.testPlaybackState;
		console.debug(`${this.constructor.name}: read state from tidal: ${state}`);
		return state;
	}

	update_state() {
		const old_state = this.state,
			tidal_state = this.player_state();
		if(tidal_state in this.constructor.state_map)
			this.state = this.constructor.state_map[tidal_state];
		else {
			console.warn(`${this.constructor.name}: unrecognized tidal state '${tidal_state}'`);
			this.state = 'paused';
		}

		if(this.state == old_state)
			return;
		console.info(`${this.constructor.name}: Detected playstate change: ${this.state}`);
		if(!this.watching)
			return;
		if(this.state == 'playing')
			this.dispatchEvent(new CustomEvent('play'));
		else if(this.state == 'paused')
			this.dispatchEvent(new CustomEvent('pause'));
	}

	attr_change_handler = mutList => {
		this.update_state();
	}

	watch() {
		if(this.watching)
			return;
		this.observer.observe(this.player, {attributes: true, attributeFilter: ['data-test-playback-state']});
		this.update_state();
		this.watching = true;
	}
}

class TidalWakelock {
	watcher;
	wlock = null;
	wlock_tgt_state = false;
	update_promise = Promise.resolve();

	constructor(player) {
		this.watcher = new TidalPlaybackWatcher(player);
		this.watcher.addEventListener('play', this.get_lock);
		this.watcher.addEventListener('pause', this.release_lock);
		this.watcher.watch();
		if(this.watcher.state == 'playing')
			this.get_lock();
	}

	get_lock = () => {
		console.debug(`${this.constructor.name}: wlock_tgt_state: true`)
		this.wlock_tgt_state = true;
		this.update_promise.then(this.update_wlock);
	}

	release_lock = () => {
		console.debug(`${this.constructor.name}: wlock_tgt_state: false`)
		this.wlock_tgt_state = false;
		this.update_promise.then(this.update_wlock);
	}

	update_wlock = async () => {
		if(Boolean(this.wlock) == this.wlock_tgt_state)
			return;

		if(this.wlock_tgt_state) {
			console.info(`${this.constructor.name}: Requesting wakelock`);
			this.wlock = await navigator.wakeLock.request('screen');
			console.debug(`${this.constructor.name}: wakelock acquired`);
			this.wlock.addEventListener('release', this.lock_released);
		}
		else {
			console.info(`${this.constructor.name}: Releasing wakelock`);
			await this.wlock.release();
			console.debug(`${this.constructor.name}: Release request complete`);
		}

		if(Boolean(this.wlock) != this.wlock_tgt_state)
			this.update_promise.then(this.update_wlock);
	}

	lock_released = e => {
		this.wlock = null;
		console.debug(`${this.constructor.name}: wakelock released`);
		// relock if released by browser
		if(this.wlock_tgt_state) {
			console.debug(`${this.constructor.name}: Queueing relock`);
			setTimeout(this.update_wlock, 1000);
		}
	}
}

let tries = 30,  // try for up to 60 seconds
	attach_handle;
attach_handle = setInterval(() => {
		if(--tries <= 0)
			clearTimeout(attach_handle);
		try {
			console.debug("Searching for player element '#footerPlayer'");
			let player = document.getElementById('footerPlayer');
			if(!player) {
				if(tries)
					return;  // wait for next try
				console.error("Failed to find player '#footerPlayer'");
				throw new Error("'#footerPlayer' element not found");
			}
			console.debug("Player found: %o", player);
			clearTimeout(attach_handle);
			new TidalWakelock(player);
			console.info("TidalWakelock attached to player");
		}
		catch (e) {
			console.error(e);
			alert(`Error connecting to Tidal: ${e}`);
		}
	}, 2000);
